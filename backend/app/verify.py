"""Turn candidate passages into a citation Alex can defend.

Two independent mechanisms, because they fail differently:

1. `verify_quote` is pure text matching. It proves a quote physically exists in
   the source document. No model output is trusted here — this is what makes a
   fabricated citation impossible to pass off as real evidence.
2. `assess_evidence` is a model judgement about whether the passage actually
   satisfies the obligation, plus a contradiction sweep for the failure mode
   Alex named: "I find something that looks right but then there's a sentence
   two pages later that contradicts it."

A quote that fails (1) is reported as unverified regardless of what (2) said.
"""

from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import asdict, dataclass, field

from . import llm
from .config import get_settings
from .db import build_match, fts_query, session
from .retrieval import DocumentBundle, Passage, chunks_in_range

# Below this ratio a near-match is treated as not found rather than "close
# enough". 0.85 tolerates PDF line-wrap and punctuation drift while still
# rejecting a paraphrase.
FUZZY_THRESHOLD = 0.85


# --------------------------------------------------------------------------
# 1. Verbatim quote verification (no model involved)
# --------------------------------------------------------------------------

_DASHES = dict.fromkeys(map(ord, "‐‑‒–—―−"), "-")
_QUOTES = {
    ord("‘"): "'", ord("’"): "'", ord("‚"): "'",
    ord("“"): '"', ord("”"): '"', ord("„"): '"',
    ord(" "): " ",
}


# Tokens whose presence, absence, or value changes what a passage *requires*.
# Character-level similarity is blind to these: "twelve (12) months" scores 0.88
# against "six (6) months", and inserting "does not" scores 0.91 -- both would
# sail past a ratio threshold while citing the opposite of what the policy says.
# So a fuzzy match must agree on all of them exactly, not merely approximately.
_NUMBER_WORDS = {
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty",
    "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred",
    "first", "second", "third", "fourth", "fifth", "half",
}
_CRITICAL_WORDS = {
    # negation and exclusion
    "not", "no", "never", "cannot", "without", "except", "unless", "none",
    "neither", "nor", "excluding", "excluded", "exclude", "prohibited",
    "denied", "deny", "waive", "waived", "exempt",
    # obligation strength -- "must" vs "may" is the difference between
    # compliance and a finding
    "shall", "must", "may", "should", "required", "require", "requires",
    "optional", "permitted", "entitled", "obligated",
    # quantifiers and scope
    "all", "any", "only", "solely", "every", "each", "least", "most",
    "more", "less", "fewer", "greater", "minimum", "maximum",
    # temporal direction and units
    "before", "after", "within", "prior", "following", "during", "until",
    "calendar", "business", "consecutive",
}


def _content_tokens(normalized: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", normalized)


def _semantic_mismatch(quote_norm: str, span_norm: str) -> str:
    """Return a reason if the two texts differ in meaning, else an empty string.

    Applied only to fuzzy matches -- an exact match cannot disagree. This is the
    gate that stops a near-miss from becoming a citation that says the opposite
    of the policy.
    """
    from collections import Counter

    q_tokens = _content_tokens(quote_norm)
    s_tokens = _content_tokens(span_norm)

    # Numerals must be identical and in order: blocks a changed timeframe,
    # threshold, or benefit period.
    q_digits = [t for t in q_tokens if t.isdigit()]
    s_digits = [t for t in s_tokens if t.isdigit()]
    if q_digits != s_digits:
        return f"numbers differ ({q_digits or 'none'} vs {s_digits or 'none'})"

    q_num = [t for t in q_tokens if t in _NUMBER_WORDS]
    s_num = [t for t in s_tokens if t in _NUMBER_WORDS]
    if q_num != s_num:
        return f"quantities differ ({q_num or 'none'} vs {s_num or 'none'})"

    # Negations, modals and quantifiers must occur the same number of times.
    q_crit = Counter(t for t in q_tokens if t in _CRITICAL_WORDS)
    s_crit = Counter(t for t in s_tokens if t in _CRITICAL_WORDS)
    if q_crit != s_crit:
        added = sorted((q_crit - s_crit).elements())
        dropped = sorted((s_crit - q_crit).elements())
        detail = "; ".join(
            p for p in (f"adds {added}" if added else "",
                        f"omits {dropped}" if dropped else "") if p
        )
        return f"qualifying terms differ: {detail}"

    return ""



@dataclass
class QuoteCheck:
    verified: bool
    method: str            # "exact" | "fuzzy" | "not_found"
    similarity: float      # 1.0 for exact
    start: int = -1        # char offsets into the ORIGINAL source text
    end: int = -1
    matched_text: str = ""  # what is actually written in the document

    def as_dict(self) -> dict:
        return asdict(self)


def _normalize(text: str) -> tuple[str, list[int]]:
    """Casefold and collapse whitespace, tracking each output char's origin.

    The offset map is what lets the UI highlight the real span in the original
    page text after matching against the normalized form.
    """
    text = unicodedata.normalize("NFKC", text).translate({**_DASHES, **_QUOTES})
    out: list[str] = []
    origin: list[int] = []
    prev_space = True  # suppress leading whitespace
    for i, ch in enumerate(text):
        if ch.isspace():
            if prev_space:
                continue
            out.append(" ")
            origin.append(i)
            prev_space = True
        else:
            out.append(ch.lower())
            origin.append(i)
            prev_space = False
    while out and out[-1] == " ":
        out.pop()
        origin.pop()
    return "".join(out), origin


def verify_quote(quote: str, source: str) -> QuoteCheck:
    """Confirm `quote` appears in `source`, allowing only formatting drift.

    Exact match is tried first on the normalized forms. The fuzzy pass exists
    because these PDFs hyphenate and wrap unpredictably, not to permit
    paraphrase — anything below FUZZY_THRESHOLD is reported as not found.
    """
    quote = (quote or "").strip().strip('"“”')
    if not quote or not source:
        return QuoteCheck(verified=False, method="not_found", similarity=0.0)

    norm_q, _ = _normalize(quote)
    norm_s, origin = _normalize(source)
    if not norm_q or not norm_s:
        return QuoteCheck(verified=False, method="not_found", similarity=0.0)

    pos = norm_s.find(norm_q)
    if pos != -1:
        start, end = origin[pos], origin[pos + len(norm_q) - 1] + 1
        return QuoteCheck(True, "exact", 1.0, start, end, source[start:end])

    # Sliding window at the quote's own length; step is a fraction of that so a
    # match straddling a window boundary is still seen.
    window = len(norm_q)
    if window > len(norm_s):
        ratio = difflib.SequenceMatcher(None, norm_q, norm_s).ratio()
        return QuoteCheck(False, "not_found", round(ratio, 4))

    step = max(1, window // 8)
    best_ratio, best_at = 0.0, -1
    matcher = difflib.SequenceMatcher(None)
    matcher.set_seq2(norm_q)
    for at in range(0, len(norm_s) - window + 1, step):
        matcher.set_seq1(norm_s[at : at + window])
        # real_quick_ratio/quick_ratio are cheap upper bounds — skip windows
        # that cannot beat the current best before doing the real comparison.
        if matcher.real_quick_ratio() <= best_ratio or matcher.quick_ratio() <= best_ratio:
            continue
        ratio = matcher.ratio()
        if ratio > best_ratio:
            best_ratio, best_at = ratio, at

    if best_ratio >= FUZZY_THRESHOLD and best_at >= 0:
        # Trim the window back to the aligned region so the highlight is tight.
        matcher.set_seq1(norm_s[best_at : best_at + window])
        blocks = [b for b in matcher.get_matching_blocks() if b.size]
        lo = best_at + (blocks[0].a if blocks else 0)
        hi = best_at + ((blocks[-1].a + blocks[-1].size) if blocks else window)

        # Snap outward to word boundaries. The window is a fixed length and
        # usually lands mid-word, which would otherwise present the gate below
        # with a truncated token ("cour" for "course") and reject a good match.
        while lo > 0 and norm_s[lo - 1] != " ":
            lo -= 1
        while hi < len(norm_s) and norm_s[hi] != " ":
            hi += 1

        span_norm = norm_s[lo:hi]
        mismatch = _semantic_mismatch(norm_q, span_norm)
        if mismatch:
            # Close on characters but different in meaning — a changed number,
            # an inserted negation, "may" swapped for "must". Not a citation.
            return QuoteCheck(False, "not_found", round(best_ratio, 4))

        start, end = origin[lo], origin[min(hi, len(origin)) - 1] + 1
        return QuoteCheck(True, "fuzzy", round(best_ratio, 4), start, end, source[start:end])

    return QuoteCheck(False, "not_found", round(best_ratio, 4))


# --------------------------------------------------------------------------
# 2. Evidence assessment (model judgement, then verified against the source)
# --------------------------------------------------------------------------

CITATION_SCHEMA = llm.obj(
    {
        "passage_id": {"type": "integer",
                       "description": "The [id] of the passage this quote comes from."},
        "quote": {"type": "string",
                  "description": "Verbatim sentence(s) copied exactly from that passage."},
        "covers": {"type": "string",
                   "description": "Which part of the obligation this quote establishes."},
    }
)

ASSESSMENT_SCHEMA = llm.obj(
    {
        "status": llm.enum("supported", "partial", "not_found"),
        # Structured outputs reject numeric `minimum`/`maximum`, so the range
        # lives in the description and is clamped when the response is read.
        "confidence": {"type": "integer",
                       "description": "0-100: how likely a DHCS reviewer would "
                                      "accept this citation."},
        "citations": llm.arr(CITATION_SCHEMA, 4),
        "gap": {"type": "string",
                "description": "What the P&Ps do not say. Empty when status is supported."},
        "reasoning": {"type": "string",
                      "description": "Two or three sentences on how the passages map to "
                                     "the obligation, including vocabulary differences."},
        "reviewer_note": {"type": "string",
                          "description": "The specific judgement call a human should "
                                         "double-check, or empty if there is none."},
        "suggested_language": {"type": "string",
                               "description": "For partial/not_found: draft P&P wording "
                                              "that would satisfy the obligation. Else empty."},
    }
)

ASSESSMENT_SYSTEM = """\
You are assisting a compliance analyst at a California Medi-Cal managed care \
plan. She must answer a DHCS Submission Review Form question by citing the \
exact passage in her plan's Policies and Procedures that proves compliance.

The stakes are asymmetric. A missed citation costs her time. A wrong citation \
becomes a state finding that goes to DHCS and her board. **Never assert \
compliance you cannot point to.** "not_found" is a correct, useful answer.

You will get the question and a numbered list of candidate passages retrieved \
from the plan's P&P library. Decide:

status
  supported  - the passages state the obligation. Every element of it.
  partial    - they address the topic but omit, weaken, or narrow part of the
               obligation (a missing timeframe, a narrower population, a
               "should" where the regulator says "must").
  not_found  - the passages do not establish the obligation. Choose this
               rather than stretching a loosely related passage.

confidence
  0-100, about whether a DHCS reviewer would accept the citation. Be honest;
  a well-calibrated 55 is more useful than a reflexive 90.

citations
  Only when status is supported or partial. Each quote must be copied
  **character for character** from the passage text — do not clean up spacing,
  fix typos, join hyphenated line breaks, or paraphrase. Quotes are checked
  against the source document automatically and a quote that does not appear
  verbatim is discarded. Prefer one or two decisive sentences over a long
  excerpt. Leave the array empty for not_found.

gap
  For partial/not_found, name precisely what is missing, in the regulator's
  terms. This is what she will use to scope a policy revision.

reasoning
  How the passages map onto the obligation. Call out vocabulary differences
  explicitly when they matter — e.g. the question says "retrospective request"
  and the policy says "post-service review", or the question says "six months"
  and the policy writes "six (6) months". That translation is the judgement she
  is paying you for.

reviewer_note
  The one thing most likely to be wrong in your assessment: an inference you
  made, an ambiguous term, a passage that applies to a different line of
  business (Medi-Cal vs OneCare vs PACE) than the question targets. Empty only
  if the citation is genuinely unambiguous.

suggested_language
  For partial/not_found only: one or two sentences of P&P wording, in the
  plan's register, that would satisfy the obligation. Empty when supported.

Beware of line-of-business mismatches: a passage from a OneCare (Medicare) or \
PACE policy does not prove compliance with a Medi-Cal APL. Note it in \
reviewer_note if you rely on one."""


@dataclass
class Citation:
    passage_id: int
    quote: str
    covers: str
    policy_code: str
    title: str
    page_start: int
    page_end: int
    doc_id: int
    chunk_id: int
    quote_check: dict = field(default_factory=dict)

    def cite(self) -> str:
        page = (
            f"p. {self.page_start}"
            if self.page_start == self.page_end
            else f"pp. {self.page_start}-{self.page_end}"
        )
        return f"{self.policy_code} {page}"


@dataclass
class Assessment:
    status: str
    confidence: int
    citations: list[Citation] = field(default_factory=list)
    gap: str = ""
    reasoning: str = ""
    reviewer_note: str = ""
    suggested_language: str = ""
    contradictions: list[dict] = field(default_factory=list)
    discarded_quotes: list[dict] = field(default_factory=list)
    error: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["citations"] = [
            {**asdict(c), "cite": c.cite()} for c in self.citations
        ]
        return d


def _render_passages(passages: list[Passage]) -> str:
    blocks = []
    for i, p in enumerate(passages, start=1):
        pages = (
            f"page {p.page_start}"
            if p.page_start == p.page_end
            else f"pages {p.page_start}-{p.page_end}"
        )
        scope = f" · applies to: {p.department}" if p.department else ""
        blocks.append(
            f"[{i}] {p.policy_code} — {p.title} ({pages}, revised {p.revised_date})"
            f"{scope}\n"
            f"{'Section: ' + p.heading if p.heading else ''}\n"
            f"{p.text}"
        )
    return "\n\n---\n\n".join(blocks)


async def assess_evidence(
    question: str, obligation: str, passages: list[Passage]
) -> Assessment:
    """Ask the reasoning model for a verdict, then verify every quote it gives."""
    if not passages:
        return Assessment(
            status="not_found",
            confidence=0,
            gap="No passage in the P&P library matched this obligation.",
            reasoning="Retrieval returned no candidate passages.",
        )

    s = get_settings()
    # Only the strongest passages go to the model; the rest are kept by the
    # caller as runners-up for the UI. Sending all 30 costs more and dilutes
    # attention without improving the verdict.
    considered = passages[: s.verify_passages]
    user = (
        f"QUESTION FROM THE REGULATOR\n{question}\n\n"
        f"THE OBLIGATION, RESTATED\n{obligation}\n\n"
        f"CANDIDATE PASSAGES FROM THE PLAN'S P&P LIBRARY\n\n"
        f"{_render_passages(considered)}"
    )

    try:
        data = await llm.structured(
            system=ASSESSMENT_SYSTEM,
            user=user,
            schema=ASSESSMENT_SCHEMA,
            model=s.model_reasoning,
            # Thinking is on by default on Opus 5 and counts against this cap,
            # so it needs real headroom. Too low and the response truncates into
            # an error that would otherwise read as "no evidence found".
            max_tokens=12000,
            effort="high",
            cache_key="assessment",
        )
    except llm.LLMError as exc:
        # Deliberately NOT not_found. A failed call must never be presented to
        # the analyst as an absence of evidence — that is a false compliance gap
        # and would send her to rewrite a policy that is already fine.
        return Assessment(
            status="error", confidence=0,
            reasoning="The assessment did not complete, so this question is "
                      "unanswered. Re-run it.",
            error=str(exc),
        )

    by_id = {i: p for i, p in enumerate(considered, start=1)}
    citations: list[Citation] = []
    discarded: list[dict] = []

    for raw in data.get("citations") or []:
        pid = raw.get("passage_id")
        passage = by_id.get(pid)
        quote = (raw.get("quote") or "").strip()
        if not passage or not quote:
            discarded.append({"quote": quote, "reason": "unknown passage id",
                              "passage_id": pid})
            continue

        check = verify_quote(quote, passage.text)
        if not check.verified:
            # The model produced text that is not in the document. Drop it —
            # this is the guard that makes a hallucinated citation unusable.
            discarded.append({
                "quote": quote,
                "reason": "not found verbatim in the cited passage",
                "similarity": check.similarity,
                "cite": passage.cite(),
            })
            continue

        citations.append(
            Citation(
                passage_id=pid,
                quote=check.matched_text or quote,
                covers=raw.get("covers") or "",
                policy_code=passage.policy_code,
                title=passage.title,
                page_start=passage.page_start,
                page_end=passage.page_end,
                doc_id=passage.doc_id,
                chunk_id=passage.chunk_id,
                quote_check=check.as_dict(),
            )
        )

    status = data.get("status") or "not_found"
    confidence = max(0, min(100, int(data.get("confidence") or 0)))

    # A claim of support with no surviving verifiable quote is downgraded, not
    # reported. Otherwise the discard guard above would be cosmetic.
    if status in ("supported", "partial") and not citations:
        status = "not_found"
        confidence = min(confidence, 20)

    return Assessment(
        status=status,
        confidence=confidence,
        citations=citations,
        gap=data.get("gap") or "",
        reasoning=data.get("reasoning") or "",
        reviewer_note=data.get("reviewer_note") or "",
        suggested_language=data.get("suggested_language") or "",
        discarded_quotes=discarded,
    )


# --------------------------------------------------------------------------
# 2b. Whole-document assessment
# --------------------------------------------------------------------------
#
# Same trust layer, different evidence unit. The model reads complete policies
# instead of chunks, which removes the one failure the guards above cannot see:
# a passage that lexical retrieval ranked too low to send. It also lets page
# numbers be *derived* rather than claimed — the quote is located in the page
# text, so the citation's page comes from where the text actually is.

DOC_CITATION_SCHEMA = llm.obj(
    {
        "document_id": {"type": "integer",
                        "description": "The [id] of the policy document this quote "
                                       "comes from."},
        "quote": {"type": "string",
                  "description": "Verbatim sentence(s) copied exactly from that "
                                 "document's text."},
        "covers": {"type": "string",
                   "description": "Which part of the obligation this quote establishes."},
    }
)

DOC_ASSESSMENT_SCHEMA = llm.obj(
    {
        "status": llm.enum("supported", "partial", "not_found"),
        "confidence": {"type": "integer",
                       "description": "0-100: how likely a DHCS reviewer would "
                                      "accept this citation."},
        "citations": llm.arr(DOC_CITATION_SCHEMA, 4),
        "gap": {"type": "string",
                "description": "What the P&Ps do not say. Empty when status is supported."},
        "reasoning": {"type": "string",
                      "description": "Two or three sentences on how the documents map to "
                                     "the obligation, including vocabulary differences."},
        "reviewer_note": {"type": "string",
                          "description": "The specific judgement call a human should "
                                         "double-check, or empty if there is none."},
        "suggested_language": {"type": "string",
                               "description": "For partial/not_found: draft P&P wording "
                                              "that would satisfy the obligation. Else empty."},
    }
)

DOC_ASSESSMENT_SYSTEM = """\
You are assisting a compliance analyst at a California Medi-Cal managed care \
plan. She must answer a DHCS Submission Review Form question by citing the \
exact passage in her plan's Policies and Procedures that proves compliance.

The stakes are asymmetric. A missed citation costs her time. A wrong citation \
becomes a state finding that goes to DHCS and her board. **Never assert \
compliance you cannot point to.** "not_found" is a correct, useful answer.

You will get the question and a small set of **complete policy documents** \
shortlisted from the plan's library, each with page markers. Read them in full. \
The obligation may be stated anywhere in a document, in the plan's own \
vocabulary rather than the regulator's — a keyword search would have missed it, \
which is why you are given whole documents.

Because you can see each policy end to end, you are also responsible for \
qualifying language: if a document states the obligation in one section and \
then narrows it, carves out an exception, or gives a different deadline \
elsewhere, that makes the answer `partial`, not `supported`. Say so in the gap.

Decide:

status
  supported  - the documents state the obligation. Every element of it, with no
               exception elsewhere in the document that undercuts it.
  partial    - they address the topic but omit, weaken, or narrow part of the
               obligation (a missing timeframe, a narrower population, a
               "should" where the regulator says "must").
  not_found  - the documents do not establish the obligation. Choose this
               rather than stretching a loosely related passage.

confidence
  0-100, about whether a DHCS reviewer would accept the citation. Be honest;
  a well-calibrated 55 is more useful than a reflexive 90.

citations
  Only when status is supported or partial. Each quote must be copied
  **character for character** from the document text — do not clean up spacing,
  fix typos, join hyphenated line breaks, or paraphrase. Do not include the
  `[page N]` markers inside a quote. Quotes are checked against the source
  automatically and a quote that does not appear verbatim is discarded. Prefer
  one or two decisive sentences over a long excerpt. You do not need to report
  page numbers — the page is determined from where the quote is found.

gap
  For partial/not_found, name precisely what is missing, in the regulator's
  terms. This is what she will use to scope a policy revision.

reasoning
  How the documents map onto the obligation. Call out vocabulary differences
  explicitly when they matter — e.g. the question says "retrospective request"
  and the policy says "post-service review", or the question says "six months"
  and the policy writes "six (6) months". That translation is the judgement she
  is paying you for.

reviewer_note
  The one thing most likely to be wrong in your assessment: an inference you
  made, an ambiguous term, a document that applies to a different line of
  business (Medi-Cal vs OneCare vs PACE) than the question targets. Empty only
  if the citation is genuinely unambiguous.

suggested_language
  For partial/not_found only: one or two sentences of P&P wording, in the
  plan's register, that would satisfy the obligation. Empty when supported.

Beware of line-of-business mismatches: a document from a OneCare (Medicare) or \
PACE policy does not prove compliance with a Medi-Cal APL. Note it in \
reviewer_note if you rely on one."""


@dataclass
class QuoteLocation:
    """Where a verified quote physically sits in a document."""

    check: QuoteCheck
    page_start: int
    page_end: int
    chunk_id: int
    heading: str = ""


def locate_quote(quote: str, doc: DocumentBundle) -> QuoteLocation:
    """Find `quote` in a whole document and report the page it is actually on.

    Single pages are tried before consecutive pairs so attribution stays as
    narrow as the evidence allows; the pairs exist only so a sentence broken
    across a page boundary still verifies. Exact matches are preferred over
    fuzzy ones across the whole document rather than accepting the first fuzzy
    hit, because a fuzzy match on page 2 must not beat an exact one on page 9.
    """
    best: QuoteLocation | None = None
    for page_start, page_end, text in doc.page_spans():
        check = verify_quote(quote, text)
        if not check.verified:
            continue
        loc = QuoteLocation(check=check, page_start=page_start, page_end=page_end,
                            chunk_id=-1)
        if check.method == "exact":
            return _attach_chunk(loc, doc)
        if best is None or check.similarity > best.check.similarity:
            best = loc

    if best is None:
        return QuoteLocation(
            check=QuoteCheck(False, "not_found", 0.0), page_start=0, page_end=0,
            chunk_id=-1,
        )
    return _attach_chunk(best, doc)


def _attach_chunk(loc: QuoteLocation, doc: DocumentBundle) -> QuoteLocation:
    """Map a located quote onto a chunk id, which the UI keys citations on."""
    candidates = chunks_in_range(doc.doc_id, loc.page_start, loc.page_end)
    for ch in candidates:
        if verify_quote(loc.check.matched_text, ch["text"]).verified:
            loc.chunk_id = ch["id"]
            loc.heading = ch["heading"] or ""
            return loc
    if candidates:  # quote straddles a chunk boundary; the first overlap is closest
        loc.chunk_id = candidates[0]["id"]
        loc.heading = candidates[0]["heading"] or ""
    return loc


def _render_documents(docs: list[DocumentBundle]) -> str:
    return "\n\n".join(
        f"===== DOCUMENT [{i}] =====\n{d.render()}"
        for i, d in enumerate(docs, start=1)
    )


async def assess_evidence_documents(
    question: str, obligation: str, docs: list[DocumentBundle]
) -> Assessment:
    """Whole-document verdict. Every quote is still verified against the source."""
    if not docs:
        return Assessment(
            status="not_found",
            confidence=0,
            gap="No policy in the P&P library matched this obligation.",
            reasoning="Document retrieval returned no candidates.",
        )

    s = get_settings()
    user = (
        f"QUESTION FROM THE REGULATOR\n{question}\n\n"
        f"THE OBLIGATION, RESTATED\n{obligation}\n\n"
        f"COMPLETE POLICY DOCUMENTS FROM THE PLAN'S P&P LIBRARY\n\n"
        f"{_render_documents(docs)}"
    )

    try:
        data = await llm.structured(
            system=DOC_ASSESSMENT_SYSTEM,
            user=user,
            schema=DOC_ASSESSMENT_SCHEMA,
            model=s.model_reasoning,
            max_tokens=12000,
            effort="high",
            cache_key="assessment_documents",
        )
    except llm.LLMError as exc:
        # Same reasoning as the passage path: a failed call must never look like
        # an absence of evidence.
        return Assessment(
            status="error", confidence=0,
            reasoning="The assessment did not complete, so this question is "
                      "unanswered. Re-run it.",
            error=str(exc),
        )

    by_id = {i: d for i, d in enumerate(docs, start=1)}
    citations: list[Citation] = []
    discarded: list[dict] = []

    for raw in data.get("citations") or []:
        did = raw.get("document_id")
        doc = by_id.get(did)
        quote = (raw.get("quote") or "").strip()
        if not doc or not quote:
            discarded.append({"quote": quote, "reason": "unknown document id",
                              "passage_id": did})
            continue

        loc = locate_quote(quote, doc)
        if not loc.check.verified:
            discarded.append({
                "quote": quote,
                "reason": "not found verbatim in the cited document",
                "similarity": loc.check.similarity,
                "cite": doc.policy_code,
            })
            continue

        citations.append(
            Citation(
                passage_id=did,
                quote=loc.check.matched_text or quote,
                covers=raw.get("covers") or "",
                policy_code=doc.policy_code,
                title=doc.title,
                page_start=loc.page_start,
                page_end=loc.page_end,
                doc_id=doc.doc_id,
                chunk_id=loc.chunk_id,
                quote_check=loc.check.as_dict(),
            )
        )

    status = data.get("status") or "not_found"
    confidence = max(0, min(100, int(data.get("confidence") or 0)))

    # A claim of support with no surviving verifiable quote is downgraded, not
    # reported — identical to the passage path.
    if status in ("supported", "partial") and not citations:
        status = "not_found"
        confidence = min(confidence, 20)

    return Assessment(
        status=status,
        confidence=confidence,
        citations=citations,
        gap=data.get("gap") or "",
        reasoning=data.get("reasoning") or "",
        reviewer_note=data.get("reviewer_note") or "",
        suggested_language=data.get("suggested_language") or "",
        discarded_quotes=discarded,
    )


# --------------------------------------------------------------------------
# 3. Contradiction sweep
# --------------------------------------------------------------------------

CONTRADICTION_SCHEMA = llm.obj(
    {
        "findings": llm.arr(
            llm.obj({
                "passage_id": {"type": "integer"},
                "kind": llm.enum("contradiction", "exception", "narrower_scope",
                                 "different_timeframe"),
                "quote": {"type": "string",
                          "description": "Verbatim text from that passage."},
                "explanation": {"type": "string",
                                "description": "How it qualifies or conflicts with "
                                               "the cited quote."},
                "severity": llm.enum("high", "medium", "low"),
            }),
            4,
        )
    }
)

CONTRADICTION_SYSTEM = """\
A compliance analyst has cited a passage from her plan's P&P as proof of \
compliance with a regulatory obligation. Your job is to find anything \
elsewhere in the same policy document that would undermine that citation if a \
DHCS reviewer read the whole document.

You are looking for:
  contradiction       - text stating the opposite of the cited quote
  exception           - a carve-out that removes cases the obligation covers
  narrower_scope      - the obligation is limited to fewer members, services,
                        or lines of business than the regulator requires
  different_timeframe - a different deadline or duration for the same process

Report only genuine conflicts. Do not report:
  - text that merely adds detail, procedure, or elaboration
  - a different topic that happens to share vocabulary
  - normal cross-references to other policies
  - a restatement of the same rule in different words

Every quote must be copied verbatim from the passage text; quotes are checked \
against the source automatically. Return an empty findings array when the \
citation stands, which is the common case — a false alarm costs her real time."""


async def contradiction_sweep(
    obligation: str, citations: list[Citation], max_passages: int = 8
) -> list[dict]:
    """Re-read the cited documents looking for text that undercuts the quote."""
    if not citations:
        return []

    s = get_settings()
    doc_ids = list(dict.fromkeys(c.doc_id for c in citations))
    cited_chunks = {c.chunk_id for c in citations}

    # Pull passages from the same documents that use qualifying language.
    qualifier_query = build_match(
        "except unless however notwithstanding excluded does not apply limited "
        "only if provided that exception shall not"
    )
    marks = ",".join("?" * len(doc_ids))
    with session() as conn:
        rows = fts_query(
            conn,
            f"""SELECT ch.id, ch.doc_id, ch.page_start, ch.page_end, ch.heading, ch.text,
                       d.policy_code, d.title, bm25(chunks_fts) AS score
                FROM chunks_fts
                JOIN chunks ch ON ch.id = chunks_fts.rowid
                JOIN documents d ON d.id = ch.doc_id
                WHERE chunks_fts MATCH ? AND ch.doc_id IN ({marks})
                ORDER BY score LIMIT ?""",
            qualifier_query,
            (*doc_ids, max_passages * 2),
        )
        # Also include the obligation's own terms — a contradiction usually
        # discusses the same subject as the rule it contradicts.
        rows += fts_query(
            conn,
            f"""SELECT ch.id, ch.doc_id, ch.page_start, ch.page_end, ch.heading, ch.text,
                       d.policy_code, d.title, bm25(chunks_fts) AS score
                FROM chunks_fts
                JOIN chunks ch ON ch.id = chunks_fts.rowid
                JOIN documents d ON d.id = ch.doc_id
                WHERE chunks_fts MATCH ? AND ch.doc_id IN ({marks})
                ORDER BY score LIMIT ?""",
            build_match(obligation),
            (*doc_ids, max_passages),
        )

    seen: set[int] = set()
    candidates = []
    for r in rows:
        if r["id"] in cited_chunks or r["id"] in seen:
            continue  # never flag the cited passage against itself
        seen.add(r["id"])
        candidates.append(r)
        if len(candidates) >= max_passages:
            break

    if not candidates:
        return []

    cited_block = "\n\n".join(
        f"CITED AS PROOF — {c.cite()}\n{c.quote}" for c in citations
    )
    others = "\n\n---\n\n".join(
        f"[{i}] {r['policy_code']} pages {r['page_start']}-{r['page_end']}"
        f"{' · ' + r['heading'] if r['heading'] else ''}\n{r['text']}"
        for i, r in enumerate(candidates, start=1)
    )

    try:
        data = await llm.structured(
            system=CONTRADICTION_SYSTEM,
            user=(
                f"THE OBLIGATION\n{obligation}\n\n{cited_block}\n\n"
                f"OTHER PASSAGES FROM THE SAME POLICY DOCUMENT(S)\n\n{others}"
            ),
            schema=CONTRADICTION_SCHEMA,
            model=s.model_reasoning,
            # Thinking counts toward the cap on Opus 5; leave headroom.
            max_tokens=6000,
            effort="medium",
            cache_key="contradiction",
        )
    except llm.LLMError:
        return []  # advisory check; never fail the whole question over it

    by_id = {i: r for i, r in enumerate(candidates, start=1)}
    findings: list[dict] = []
    for f in data.get("findings") or []:
        row = by_id.get(f.get("passage_id"))
        if not row:
            continue
        check = verify_quote(f.get("quote") or "", row["text"])
        if not check.verified:
            continue  # same verbatim standard as the primary citation
        findings.append({
            "kind": f.get("kind") or "contradiction",
            "severity": f.get("severity") or "medium",
            "quote": check.matched_text,
            "explanation": f.get("explanation") or "",
            "policy_code": row["policy_code"],
            "page_start": row["page_start"],
            "page_end": row["page_end"],
            "doc_id": row["doc_id"],
            "chunk_id": row["id"],
            "cite": f"{row['policy_code']} pp. {row['page_start']}-{row['page_end']}",
        })
    return findings
