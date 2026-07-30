"""Find the passages that could answer a regulator's question.

The hard part is not ranking, it is vocabulary. The regulator writes
"retrospective request"; the plan's P&P says "post-service review". A literal
search finds nothing, and Alex bridges that gap by hand for every question.

So the model is asked to translate the question into the plan's likely
vocabulary first, and each phrasing is searched separately. Results are fused
by reciprocal rank, which needs no score calibration and tolerates one bad
expansion without derailing the set.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field

from . import llm
from .config import get_settings
from .db import build_match, fts_query, session

# --------------------------------------------------------------------------
# Query expansion
# --------------------------------------------------------------------------

EXPANSION_SCHEMA = llm.obj(
    {
        "obligation": {
            "type": "string",
            "description": "The concrete requirement in one sentence, stripped of "
                           "questionnaire phrasing.",
        },
        "regulator_terms": llm.arr({"type": "string"}, 8),
        "plan_synonyms": llm.arr({"type": "string"}, 12),
        "queries": llm.arr({"type": "string"}, 6),
        "likely_topics": llm.arr({"type": "string"}, 5),
    }
)

EXPANSION_SYSTEM = """\
You translate California DHCS regulatory questions into the vocabulary a \
Medi-Cal managed care plan actually uses in its policies and procedures.

A compliance analyst is trying to find the passage in her plan's P&P library \
that proves compliance with a regulator's question. Her core difficulty is that \
the regulator and the plan use different words for the same obligation:

  regulator "retrospective request"      -> plan "post-service review"
  regulator "six months"                 -> plan "six (6) months"
  regulator "authorized representative"  -> plan "Member's representative"
  regulator "timely access"              -> plan "access standards"

Given a question, return:

- obligation: the concrete requirement in one sentence. Drop "Does the P&P \
state that..." and keep only the substance.
- regulator_terms: distinctive noun phrases as the regulator wrote them. Skip \
generic words that appear in every health-plan policy (member, provider, \
service, plan, health) unless part of a longer specific phrase.
- plan_synonyms: how a plan's own P&P would more likely phrase those terms. \
Include operational and clinical vocabulary, common abbreviations, and \
statutory or form names. This is the most important field.
- queries: 4-6 alternative search phrasings, each a handful of content words. \
Vary the vocabulary between them — one close to the regulator's wording, \
others using the plan's likely wording. Do not repeat the same words in every \
query.
- likely_topics: the P&P subject areas that would carry this obligation (e.g. \
"Utilization Management", "Grievances and Appeals", "Long Term Services and \
Supports").

Write numbers both ways when a number appears (e.g. both "14" and "fourteen"), \
because the plan's PDFs write "fourteen (14) calendar days"."""


@dataclass
class Expansion:
    obligation: str
    regulator_terms: list[str] = field(default_factory=list)
    plan_synonyms: list[str] = field(default_factory=list)
    queries: list[str] = field(default_factory=list)
    likely_topics: list[str] = field(default_factory=list)

    def search_phrasings(self, question: str) -> list[str]:
        """Every string worth issuing as its own query, de-duplicated."""
        candidates = [
            self.obligation,
            *self.queries,
            " ".join(self.regulator_terms),
            " ".join(self.plan_synonyms),
            question,  # always keep the literal question as a baseline
        ]
        seen: set[str] = set()
        out: list[str] = []
        for c in candidates:
            c = re.sub(r"\s+", " ", (c or "")).strip()
            key = c.lower()
            if c and key not in seen:
                seen.add(key)
                out.append(c)
        return out


async def expand_question(question: str) -> Expansion:
    """Ask the fast model for the plan's vocabulary. Degrades to literal search."""
    s = get_settings()
    try:
        data = await llm.structured(
            system=EXPANSION_SYSTEM,
            user=f"Regulatory question:\n{question}",
            schema=EXPANSION_SCHEMA,
            model=s.model_fast,
            max_tokens=2500,
            effort="low",
            cache_key="expansion",
        )
    except llm.LLMError:
        # Retrieval still works on the literal question; recall is just lower.
        return Expansion(obligation=question, queries=[question])
    return Expansion(
        obligation=data.get("obligation") or question,
        regulator_terms=data.get("regulator_terms") or [],
        plan_synonyms=data.get("plan_synonyms") or [],
        queries=data.get("queries") or [],
        likely_topics=data.get("likely_topics") or [],
    )


# --------------------------------------------------------------------------
# Fusion
# --------------------------------------------------------------------------

RRF_K = 60  # standard damping constant; rank 1 scores 1/61, rank 10 scores 1/70


def reciprocal_rank_fuse(ranked_lists: list[list[int]], k: int = RRF_K) -> dict[int, float]:
    """Combine several ranked ID lists into one score map.

    Reciprocal rank fusion deliberately ignores the underlying scores: bm25
    values are not comparable between queries of different lengths, so using
    only positions avoids having to normalise them. An item ranked modestly by
    several phrasings outranks one ranked highly by a single phrasing, which is
    the behaviour we want when the expansions disagree.
    """
    scores: dict[int, float] = {}
    for ranked in ranked_lists:
        for position, item_id in enumerate(ranked, start=1):
            scores[item_id] = scores.get(item_id, 0.0) + 1.0 / (k + position)
    return scores


# --------------------------------------------------------------------------
# Search
# --------------------------------------------------------------------------

# FTS5 auxiliary functions like bm25() are only valid in a simple query
# context, so the per-chunk score is computed in a subquery and aggregated
# outside it. The inner LIMIT bounds the work: a document whose best passage is
# not in the top few hundred is not a serious candidate anyway.
_DOC_SQL = """
SELECT doc_id, MIN(score) AS best FROM (
    SELECT ch.doc_id AS doc_id, bm25(chunks_fts) AS score
    FROM chunks_fts
    JOIN chunks ch ON ch.id = chunks_fts.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY score
    LIMIT 400
)
GROUP BY doc_id
ORDER BY best
LIMIT ?
"""

_CHUNK_SQL = """
SELECT chunks_fts.rowid AS chunk_id, bm25(chunks_fts) AS score
FROM chunks_fts
WHERE chunks_fts MATCH ?
ORDER BY score
LIMIT ?
"""

# Document ranking by *density* rather than best single passage: the mean of a
# document's three best chunks.
#
# Best-passage ranking (_DOC_SQL) is right when the unit sent to the model is a
# passage — one strong chunk is exactly what gets sent. It is wrong when the unit
# is the whole document, because a glossary contains one matching line for every
# term in the corpus and so ranks near the top of every query. Measured on a
# hospice question, AA.1000 (Medi-Cal Glossary, 66k tokens) and MA.1001 (OneCare
# Glossary, 41k) took 72% of the context budget and crowded out real policies.
#
# Requiring three good chunks demotes a document that merely mentions the topic
# in favour of one that is about it. bm25 is negative, so lower is better.
_DOC_DENSITY_SQL = """
SELECT doc_id, AVG(score) AS best FROM (
    SELECT doc_id, score,
           ROW_NUMBER() OVER (PARTITION BY doc_id ORDER BY score) AS rn
    FROM (
        SELECT ch.doc_id AS doc_id, bm25(chunks_fts) AS score
        FROM chunks_fts
        JOIN chunks ch ON ch.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY score
        LIMIT 400
    )
)
WHERE rn <= 3
GROUP BY doc_id
ORDER BY best
LIMIT ?
"""


@dataclass
class Passage:
    chunk_id: int
    doc_id: int
    policy_code: str
    title: str
    program: str
    department: str
    revised_date: str
    page_start: int
    page_end: int
    heading: str
    text: str
    score: float = 0.0
    n_pages: int = 0

    def cite(self) -> str:
        page = (
            f"p. {self.page_start}"
            if self.page_start == self.page_end
            else f"pp. {self.page_start}-{self.page_end}"
        )
        return f"{self.policy_code} {page}"


def _hydrate(conn, chunk_ids: list[int], scores: dict[int, float]) -> list[Passage]:
    if not chunk_ids:
        return []
    marks = ",".join("?" * len(chunk_ids))
    rows = conn.execute(
        f"""SELECT ch.id, ch.doc_id, ch.page_start, ch.page_end, ch.heading, ch.text,
                   d.policy_code, d.title, d.program, d.department, d.revised_date, d.n_pages
            FROM chunks ch JOIN documents d ON d.id = ch.doc_id
            WHERE ch.id IN ({marks})""",
        chunk_ids,
    ).fetchall()
    by_id = {r["id"]: r for r in rows}
    out: list[Passage] = []
    for cid in chunk_ids:  # preserve fused order
        r = by_id.get(cid)
        if not r:
            continue
        out.append(
            Passage(
                chunk_id=r["id"], doc_id=r["doc_id"], policy_code=r["policy_code"],
                title=r["title"], program=r["program"], department=r["department"],
                revised_date=r["revised_date"], page_start=r["page_start"],
                page_end=r["page_end"], heading=r["heading"] or "", text=r["text"],
                score=round(scores.get(cid, 0.0), 6), n_pages=r["n_pages"],
            )
        )
    return out


def _rank_documents(
    conn,
    phrasings: list[str],
    topics: list[str] | None = None,
    density: bool = False,
) -> dict[int, float]:
    """Fused document-level ranking: which P&Ps could own this obligation.

    Both evidence modes need it — passage mode uses it to boost, document mode
    uses it as the whole answer. `density=True` selects the ranking suited to
    sending whole documents (see `_DOC_DENSITY_SQL`); passage mode keeps
    best-passage ranking so its measured behaviour is unchanged.
    """
    s = get_settings()
    sql = _DOC_DENSITY_SQL if density else _DOC_SQL
    rankings: list[list[int]] = []
    for phrasing in phrasings:
        rows = fts_query(conn, sql, build_match(phrasing), (s.doc_candidates,))
        rankings.append([r["doc_id"] for r in rows])
    # Topic hints search titles, which is how a human finds the right policy
    # when the body text does not use the regulator's words.
    for topic in (topics or [])[:5]:
        rows = fts_query(conn, sql, build_match(topic), (s.doc_candidates,))
        rankings.append([r["doc_id"] for r in rows])
    return reciprocal_rank_fuse(rankings)


def search_passages(
    phrasings: list[str],
    topics: list[str] | None = None,
    limit: int | None = None,
    only_policies: list[str] | None = None,
) -> list[Passage]:
    """Two-stage retrieval: shortlist documents, then rank passages.

    Ranking documents first reflects how Alex actually works — she decides
    which P&P should own an obligation, then reads it. It also stops a single
    keyword-dense page in an unrelated policy from crowding out the right
    document.
    """
    s = get_settings()
    limit = limit or s.chunk_candidates

    with session() as conn:
        chunk_rankings: list[list[int]] = []
        for phrasing in phrasings:
            chunk_rows = fts_query(conn, _CHUNK_SQL, build_match(phrasing), (limit,))
            chunk_rankings.append([r["chunk_id"] for r in chunk_rows])

        doc_scores = _rank_documents(conn, phrasings, topics)
        chunk_scores = reciprocal_rank_fuse(chunk_rankings)
        if not chunk_scores:
            return []

        shortlist = {
            doc_id for doc_id, _ in
            sorted(doc_scores.items(), key=lambda kv: -kv[1])[: s.doc_candidates]
        }

        # Boost passages that live in a shortlisted document. Additive on the
        # fused score so a strong passage in an unlisted document can still
        # surface — the questionnaire genuinely spans multiple policies.
        chunk_docs = dict(
            conn.execute(
                f"""SELECT id, doc_id FROM chunks
                    WHERE id IN ({','.join('?' * len(chunk_scores))})""",
                list(chunk_scores),
            ).fetchall()
        )
        for cid in chunk_scores:
            if chunk_docs.get(cid) in shortlist:
                chunk_scores[cid] += 0.35 / RRF_K

        ordered = [
            cid for cid, _ in sorted(chunk_scores.items(), key=lambda kv: -kv[1])
        ]

        # An analyst redirect ("look in GG.1550") is a hard filter, not a hint —
        # if she names the policy she means it, so drop everything else. Falls
        # back to the unfiltered ranking when the named policy has no match at
        # all, since an empty result would look like a bug rather than an answer.
        if only_policies:
            wanted = {c.strip().upper() for c in only_policies if c.strip()}
            rows = conn.execute(
                f"""SELECT ch.id FROM chunks ch JOIN documents d ON d.id = ch.doc_id
                    WHERE UPPER(d.policy_code) IN ({','.join('?' * len(wanted))})""",
                list(wanted),
            ).fetchall()
            allowed = {r[0] for r in rows}
            if allowed:
                narrowed = [cid for cid in ordered if cid in allowed]
                # Include unranked passages from the named policy so a redirect
                # surfaces it even when the query terms never matched there.
                narrowed += [cid for cid in allowed if cid not in chunk_scores][:limit]
                if narrowed:
                    ordered = narrowed

        ordered = ordered[:limit]
        return _hydrate(conn, ordered, chunk_scores)


async def retrieve(
    question: str,
    hint: str = "",
    only_policies: list[str] | None = None,
) -> tuple[Expansion, list[Passage]]:
    """Expand the question into the plan's vocabulary, then search.

    `hint` is free text from the analyst ("this is about post-service review").
    It is appended to the search phrasings rather than replacing them, so her
    steer adds recall without discarding what the expansion found.
    """
    expansion = await expand_question(question)
    phrasings = expansion.search_phrasings(question)
    if hint.strip():
        phrasings = [hint.strip(), *phrasings]
    passages = await asyncio.to_thread(
        search_passages, phrasings, expansion.likely_topics, None, only_policies
    )
    return expansion, passages


# --------------------------------------------------------------------------
# Whole-document retrieval
# --------------------------------------------------------------------------
#
# Passage retrieval can only fail silently: if FTS5 never surfaces the right
# chunk there is no quote to verify and no contradiction to sweep, and the run
# reports a confident "not found". The trust layer covers fabrication, not
# absence.
#
# These policies are small — 9.7 pages and ~6.2k tokens on average, ~10.6k at
# the 90th percentile. So the fix is not better passage ranking; it is to stop
# ranking passages. Shortlist documents (already the first stage) and put the
# complete policy text in front of the reasoning model. Retrieval then only has
# to get the *document* right, which is a much easier target than getting the
# right chunk of it.

CHARS_PER_TOKEN = 4  # rough, and only used to keep a prompt inside a budget


@dataclass
class DocumentBundle:
    """A whole policy, with its pages, ready to put in a prompt."""

    doc_id: int
    policy_code: str
    title: str
    program: str
    department: str
    applicable_to: str
    revised_date: str
    n_pages: int
    pages: list[tuple[int, str]] = field(default_factory=list)
    score: float = 0.0

    @property
    def est_tokens(self) -> int:
        return sum(len(t) for _, t in self.pages) // CHARS_PER_TOKEN

    def render(self) -> str:
        """The document as the model sees it, with page markers.

        The markers are for the model's benefit only. Quote verification never
        runs against this string — it runs against the raw page text — so an
        injected marker can never end up inside a verified quote.
        """
        head = (
            f"{self.policy_code} — {self.title}\n"
            f"Department: {self.department or 'n/a'} · "
            f"Applies to: {self.applicable_to or 'n/a'} · "
            f"Revised: {self.revised_date or 'n/a'} · {self.n_pages} pages"
        )
        body = "\n\n".join(f"[page {no}]\n{text}" for no, text in self.pages)
        return f"{head}\n\n{body}"

    def page_spans(self) -> list[tuple[int, int, str]]:
        """Text units a quote may legitimately live in, tightest first.

        Single pages come first so attribution is as narrow as possible. The
        consecutive pairs exist because a sentence split across a page break
        appears in neither page alone, and rejecting those quotes would discard
        real evidence.
        """
        spans = [(no, no, text) for no, text in self.pages]
        spans += [
            (a_no, b_no, f"{a_text}\n{b_text}")
            for (a_no, a_text), (b_no, b_text) in zip(self.pages, self.pages[1:])
        ]
        return spans


def load_documents(doc_ids: list[int]) -> list[DocumentBundle]:
    """Hydrate whole documents, page text included, in the order given."""
    if not doc_ids:
        return []
    marks = ",".join("?" * len(doc_ids))
    with session() as conn:
        rows = conn.execute(
            f"""SELECT id, policy_code, title, program, department, applicable_to,
                       revised_date, n_pages
                FROM documents WHERE id IN ({marks})""",
            doc_ids,
        ).fetchall()
        by_id = {r["id"]: r for r in rows}
        page_rows = conn.execute(
            f"""SELECT doc_id, page_no, text FROM pages
                WHERE doc_id IN ({marks}) ORDER BY doc_id, page_no""",
            doc_ids,
        ).fetchall()

    pages: dict[int, list[tuple[int, str]]] = {}
    for r in page_rows:
        pages.setdefault(r["doc_id"], []).append((r["page_no"], r["text"]))

    out: list[DocumentBundle] = []
    for did in doc_ids:  # preserve ranked order
        r = by_id.get(did)
        if not r:
            continue
        out.append(
            DocumentBundle(
                doc_id=did, policy_code=r["policy_code"], title=r["title"],
                program=r["program"], department=r["department"] or "",
                applicable_to=r["applicable_to"] or "",
                revised_date=r["revised_date"] or "", n_pages=r["n_pages"] or 0,
                pages=pages.get(did, []),
            )
        )
    return out


def search_documents(
    phrasings: list[str],
    topics: list[str] | None = None,
    only_policies: list[str] | None = None,
    max_docs: int | None = None,
    token_budget: int | None = None,
) -> list[DocumentBundle]:
    """Shortlist whole policies, filled greedily by rank up to a token budget.

    The budget is a real constraint rather than a formality: the median policy
    is ~4.9k tokens but the largest is ~66k, so a fixed document count varies
    more than tenfold in prompt size. Filling by rank means a giant policy
    cannot evict several better-ranked small ones.
    """
    s = get_settings()
    max_docs = max_docs or s.doc_context_max
    token_budget = token_budget or s.doc_context_token_budget

    with session() as conn:
        if only_policies:
            # An analyst redirect ("look in GG.1550") is a hard filter, matching
            # the passage path: if she names the policy she means it.
            wanted = {c.strip().upper() for c in only_policies if c.strip()}
            rows = conn.execute(
                f"""SELECT id FROM documents
                    WHERE UPPER(policy_code) IN ({','.join('?' * len(wanted))})""",
                list(wanted),
            ).fetchall()
            named = [r["id"] for r in rows]
            if named:
                ranked = named
            else:
                ranked = [
                    d for d, _ in sorted(
                        _rank_documents(conn, phrasings, topics, density=True).items(),
                        key=lambda kv: -kv[1],
                    )
                ]
        else:
            scores = _rank_documents(conn, phrasings, topics, density=True)
            ranked = [d for d, _ in sorted(scores.items(), key=lambda kv: -kv[1])]

    if not ranked:
        return []

    # Hydrate a little beyond max_docs so the budget can skip an oversized
    # policy and still fill the slot with the next one down.
    bundles = load_documents(ranked[: max_docs * 3])
    per_doc_cap = int(token_budget * s.doc_context_max_share)
    chosen: list[DocumentBundle] = []
    spent = 0
    for i, b in enumerate(bundles):
        if len(chosen) >= max_docs:
            break
        cost = b.est_tokens
        # The top-ranked document is always sent, however large — if retrieval is
        # that confident, size is not a reason to withhold the likely answer.
        if chosen and (cost > per_doc_cap or spent + cost > token_budget):
            continue
        b.score = round(1.0 / (RRF_K + i + 1), 6)
        chosen.append(b)
        spent += cost
    return chosen


def chunks_in_range(doc_id: int, page_start: int, page_end: int) -> list[dict]:
    """Chunks overlapping a page range — used to map a verified quote back to a
    chunk id, which is what the UI's citation-swap and context views key on."""
    with session() as conn:
        rows = conn.execute(
            """SELECT id, page_start, page_end, heading, text FROM chunks
               WHERE doc_id = ? AND page_start <= ? AND page_end >= ?
               ORDER BY ord""",
            (doc_id, page_end, page_start),
        ).fetchall()
    return [dict(r) for r in rows]


async def retrieve_documents(
    question: str,
    hint: str = "",
    only_policies: list[str] | None = None,
) -> tuple[Expansion, list[DocumentBundle]]:
    """Expand the question, then shortlist whole policies instead of passages.

    The expansion still matters — document ranking is lexical too, and the
    regulator's vocabulary still has to be translated to find the right P&P.
    """
    expansion = await expand_question(question)
    phrasings = expansion.search_phrasings(question)
    if hint.strip():
        phrasings = [hint.strip(), *phrasings]
    docs = await asyncio.to_thread(
        search_documents, phrasings, expansion.likely_topics, only_policies
    )
    return expansion, docs


# --------------------------------------------------------------------------
# Candidate lists for the review panel
# --------------------------------------------------------------------------

def passage_candidates(passages: list[Passage]) -> list[dict]:
    """Runners-up, so a verdict she rejects still gives her somewhere to look."""
    return [
        {
            "cite": p.cite(), "policy_code": p.policy_code, "title": p.title,
            "doc_id": p.doc_id, "chunk_id": p.chunk_id, "page_start": p.page_start,
            "page_end": p.page_end, "heading": p.heading, "score": p.score,
            "excerpt": p.text[:600],
        }
        for p in passages[:6]
    ]


def document_candidates(docs: list[DocumentBundle]) -> list[dict]:
    """The shortlisted policies, as the panel's "other places to look" list.

    `chunk_id` points at the document's first chunk so the UI's citation-swap
    still has something to act on — she is choosing a *policy* here, and the
    swap then re-selects the operative sentence from it.
    """
    out: list[dict] = []
    for d in docs[:6]:
        first = chunks_in_range(d.doc_id, 1, d.n_pages or 1)
        out.append({
            "cite": f"{d.policy_code} pp. 1-{d.n_pages}",
            "policy_code": d.policy_code, "title": d.title,
            "doc_id": d.doc_id,
            "chunk_id": first[0]["id"] if first else 0,
            "page_start": 1, "page_end": d.n_pages,
            "heading": f"whole policy · {d.n_pages} pages · ~{d.est_tokens} tokens",
            "score": d.score,
            "excerpt": (d.pages[0][1] if d.pages else "")[:600],
        })
    return out


def keyword_search(query: str, limit: int = 25) -> list[Passage]:
    """Plain search for the corpus browser — no LLM, no expansion."""
    return search_passages([query], limit=limit)


def page_context(doc_id: int, page_start: int, page_end: int, pad: int = 1) -> list[dict]:
    """Surrounding pages for a citation, so a quote can be read in context."""
    with session() as conn:
        rows = conn.execute(
            """SELECT page_no, text FROM pages
               WHERE doc_id = ? AND page_no BETWEEN ? AND ? ORDER BY page_no""",
            (doc_id, max(1, page_start - pad), page_end + pad),
        ).fetchall()
        return [{"page": r["page_no"], "text": r["text"]} for r in rows]
