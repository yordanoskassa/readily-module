"""Turn a DHCS Policy Guide into a checklist of obligations, then check coverage.

The problem Alex described: "These Guides are written as narrative, not
checklists. A single paragraph might contain one obligation or six, and I won't
know until I've worked through it. I miss things."

So the guide is read in overlapping page windows and every concrete obligation
is pulled out with the verbatim sentence that creates it and the guide page it
sits on. Each obligation then runs through the same retrieval and assessment
path as a questionnaire question, producing covered / partial / gap.

The ECM Policy Guide sample is 145 pages and contains 231 modal-obligation cues
("MCPs must" x82, "may" x38, "should" x33), which is why extraction is windowed
rather than one giant call — page attribution stays precise and no single
response has to hold everything.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from pypdf import PdfReader

from . import llm
from .config import get_settings

# Pages per extraction window, with one page of overlap so an obligation that
# straddles a page break is seen whole at least once.
WINDOW_PAGES = 5
WINDOW_OVERLAP = 1

# Front matter carries no obligations and would produce noise.
_SKIP_HEADING_RE = re.compile(r"TABLE OF CONTENTS|^\s*APPENDIX [A-Z]:\s*$", re.I | re.M)

OBLIGATION_SCHEMA = llm.obj(
    {
        "obligations": llm.arr(
            llm.obj({
                "obligation": {
                    "type": "string",
                    "description": "The requirement as a single testable statement, "
                                   "starting with the actor (e.g. 'MCPs must ...').",
                },
                "quote": {
                    "type": "string",
                    "description": "Verbatim sentence(s) from the guide that create "
                                   "this obligation. Copied exactly.",
                },
                "page": {"type": "integer",
                         "description": "Guide page number the quote appears on."},
                "actor": llm.enum("MCP", "Provider", "DHCS", "Member", "Other"),
                "strength": llm.enum("must", "should", "may"),
                "deadline": {"type": "string",
                             "description": "Any timeframe stated (e.g. '30 calendar "
                                            "days'), else empty."},
                "topic": {"type": "string",
                          "description": "Short subject area, e.g. 'Care plan', "
                                         "'Provider network', 'Data sharing'."},
            }),
            25,
        )
    }
)

OBLIGATION_SYSTEM = """\
You extract concrete, checkable obligations from California DHCS policy guides \
so a managed care plan can verify its Policies and Procedures cover them.

You will get a numbered range of pages from the guide. Return every distinct \
obligation those pages create. A single paragraph often contains several — pull \
each out separately rather than merging them, and do not skip one because it is \
buried mid-sentence in narrative prose.

What counts as an obligation: a specific, verifiable requirement, permission, \
or prohibition placed on a named actor. It must be something a reviewer could \
check a P&P against.

What does not count, and must be omitted:
  - background, history, programme rationale, or definitions
  - restatements of an obligation you already returned for this page range
  - cross-references with no requirement of their own ("see Appendix B")
  - descriptions of what DHCS itself will do, unless the plan must respond
  - aspirational or explanatory language with no testable content

For each obligation:
  obligation - one self-contained testable statement beginning with the actor.
               Include the timeframe, threshold, or population inline so it can
               be checked without reading the quote.
  quote      - the verbatim sentence(s) creating it, copied character for
               character from the page text. Do not fix spacing, join
               hyphenated line breaks, or paraphrase. Quotes are verified
               against the source automatically and discarded if altered.
  page       - the page number the quote appears on. Each page's text is
               labelled; use that label, and be exact — this is what the
               analyst will cite.
  actor      - who is bound.
  strength   - "must" for mandatory (must/shall/is required to), "should" for
               recommended, "may" for permissive or optional.
  deadline   - the stated timeframe verbatim if there is one, else empty.
  topic      - a short subject area, reused consistently across obligations.

Return an empty array for pages that are table of contents, appendix listings, \
or pure background."""


@dataclass
class Obligation:
    id: str
    obligation: str
    quote: str
    page: int
    actor: str
    strength: str
    deadline: str
    topic: str
    quote_verified: bool = False
    # Filled in by the coverage pass.
    coverage: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------

def read_pages(pdf_path: str | Path) -> list[tuple[int, str]]:
    reader = PdfReader(str(pdf_path))
    return [(n + 1, (p.extract_text() or "")) for n, p in enumerate(reader.pages)]


def guide_title(pages: list[tuple[int, str]]) -> str:
    head = re.sub(r"\s+", " ", pages[0][1] if pages else "").strip()
    return head[:120] or "Policy Guide"


def build_windows(pages: list[tuple[int, str]]) -> list[list[tuple[int, str]]]:
    """Overlapping page windows, skipping front matter."""
    usable = [
        (n, t) for n, t in pages
        if len(t.strip()) > 200 and not _SKIP_HEADING_RE.search(t)
    ]
    step = max(1, WINDOW_PAGES - WINDOW_OVERLAP)
    return [usable[i : i + WINDOW_PAGES] for i in range(0, len(usable), step)]


def _render_window(window: list[tuple[int, str]]) -> str:
    return "\n\n".join(f"=== PAGE {n} ===\n{text}" for n, text in window)


def _norm_key(text: str) -> str:
    """Loose key for de-duplicating obligations seen in overlapping windows."""
    words = re.findall(r"[a-z0-9]+", text.lower())
    stop = {"the", "a", "an", "of", "to", "and", "or", "in", "for", "that",
            "is", "are", "be", "with", "as", "by", "on", "must", "shall"}
    return " ".join(w for w in words if w not in stop)[:160]


async def extract_obligations(pdf_path: str | Path) -> tuple[str, list[Obligation]]:
    """Read the guide in windows and collect de-duplicated obligations."""
    s = get_settings()
    pages = read_pages(pdf_path)
    title = guide_title(pages)
    windows = build_windows(pages)
    page_text = dict(pages)

    from .verify import verify_quote

    results = await llm.gather_bounded([
        llm.structured(
            system=OBLIGATION_SYSTEM,
            user=f"Pages {w[0][0]}-{w[-1][0]} of the guide.\n\n{_render_window(w)}",
            schema=OBLIGATION_SCHEMA,
            model=s.model_fast,
            max_tokens=16000,
            effort="medium",
            cache_key="obligations",
        )
        for w in windows
    ])

    obligations: list[Obligation] = []
    seen: set[str] = set()

    for data in results:
        if isinstance(data, BaseException):
            continue  # one bad window must not lose the rest of the guide
        for raw in data.get("obligations") or []:
            statement = (raw.get("obligation") or "").strip()
            if not statement:
                continue
            key = _norm_key(statement)
            if key in seen:
                continue
            seen.add(key)

            page = int(raw.get("page") or 0)
            quote = (raw.get("quote") or "").strip()
            # Verify the quote against the page it was attributed to, and fall
            # back to neighbours — window boundaries make off-by-one common.
            verified = False
            resolved_page = page
            for candidate in (page, page - 1, page + 1):
                text = page_text.get(candidate)
                if text and verify_quote(quote, text).verified:
                    verified, resolved_page = True, candidate
                    break

            obligations.append(
                Obligation(
                    id=f"ob{len(obligations) + 1:03d}",
                    obligation=statement,
                    quote=quote,
                    page=resolved_page,
                    actor=raw.get("actor") or "MCP",
                    strength=raw.get("strength") or "must",
                    deadline=raw.get("deadline") or "",
                    topic=raw.get("topic") or "",
                    quote_verified=verified,
                )
            )

    obligations.sort(key=lambda o: (o.page, o.id))
    for i, ob in enumerate(obligations, start=1):
        ob.id = f"ob{i:03d}"
    return title, obligations


# --------------------------------------------------------------------------
# Coverage
# --------------------------------------------------------------------------

COVERAGE_SYSTEM_SUFFIX = """

You are checking a Policy Guide obligation rather than a questionnaire \
question, so read "supported" as "the plan's P&Ps already cover this \
obligation" and "not_found" as "this needs to be written". `suggested_language` \
matters more here than usual: it is the starting point for the policy revision, \
so write it in the plan's register and make it specific enough to satisfy a \
reviewer."""


async def assess_coverage(ob: Obligation) -> dict:
    """Run one obligation through retrieval + assessment against the P&Ps.

    Whole-document mode matters more here than on the questionnaire: the output
    of this pass is a *gap list*, and a gap is asserted from absence. If lexical
    retrieval misses the policy that already covers an obligation, the run tells
    her to draft language she does not need — a false gap costs her more than a
    missed citation.
    """
    question = (
        f"Do the plan's Policies and Procedures state the following obligation "
        f"from the Policy Guide? {ob.obligation}"
    )

    if get_settings().whole_document_mode:
        from .retrieval import retrieve_documents
        from .verify import assess_evidence_documents

        expansion, docs = await retrieve_documents(question)
        assessment = await assess_evidence_documents(question, ob.obligation, docs)
        candidates = [
            {"cite": f"{d.policy_code} pp. 1-{d.n_pages}", "title": d.title,
             "score": d.score}
            for d in docs[:5]
        ]
    else:
        from .retrieval import retrieve
        from .verify import assess_evidence

        expansion, passages = await retrieve(question)
        assessment = await assess_evidence(question, ob.obligation, passages)
        candidates = [
            {"cite": p.cite(), "title": p.title, "score": p.score}
            for p in passages[:5]
        ]

    status_map = {"supported": "covered", "partial": "partial", "not_found": "gap"}
    result = assessment.to_dict()
    result["coverage_status"] = status_map.get(assessment.status, "gap")
    result["candidates"] = candidates
    result["plan_synonyms"] = expansion.plan_synonyms
    return result
