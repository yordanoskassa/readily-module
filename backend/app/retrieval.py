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
        doc_rankings: list[list[int]] = []
        chunk_rankings: list[list[int]] = []

        for phrasing in phrasings:
            match = build_match(phrasing)
            doc_rows = fts_query(conn, _DOC_SQL, match, (s.doc_candidates,))
            doc_rankings.append([r["doc_id"] for r in doc_rows])
            chunk_rows = fts_query(conn, _CHUNK_SQL, match, (limit,))
            chunk_rankings.append([r["chunk_id"] for r in chunk_rows])

        # Topic hints search titles, which is how a human finds the right
        # policy when the body text does not use the regulator's words.
        for topic in (topics or [])[:5]:
            match = build_match(topic)
            rows = fts_query(conn, _DOC_SQL, match, (s.doc_candidates,))
            doc_rankings.append([r["doc_id"] for r in rows])

        doc_scores = reciprocal_rank_fuse(doc_rankings)
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
