"""Per-question interaction on top of a completed batch run.

The batch pass gives coverage — Alex knows all 64 questions were attempted. But
a verdict she disagrees with was previously a dead end: the reviewer note would
raise a judgement call ("this passage may be OneCare rather than Medi-Cal") and
then give her no way to resolve it without opening the PDF herself.

These three actions make the batch result the opening move rather than the final
word:

  ask      a scoped follow-up about the passages already retrieved (one call,
           no re-retrieval, cheap)
  rerun    redo one question with her steer — free-text hint and/or specific
           policies to look in
  cite     swap in a different passage as the citation, verified the same way

Everything still passes through `verify_quote`, so an answer she steered toward
is held to exactly the same verbatim standard as one the batch produced.
"""

from __future__ import annotations

from . import llm
from .config import get_settings
from .db import session
from .retrieval import (
    Passage,
    document_candidates,
    load_documents,
    passage_candidates,
    retrieve,
    retrieve_documents,
)
from .verify import (
    Citation,
    assess_evidence,
    assess_evidence_documents,
    contradiction_sweep,
    locate_quote,
    verify_quote,
)

# --------------------------------------------------------------------------
# ask — scoped follow-up
# --------------------------------------------------------------------------

ASK_SCHEMA = llm.obj(
    {
        "answer": {
            "type": "string",
            "description": "Direct answer, two to four sentences. Say plainly when "
                           "the passages do not settle the question.",
        },
        "quotes": llm.arr(
            llm.obj({
                "passage_id": {"type": "integer"},
                "quote": {"type": "string",
                          "description": "Verbatim text from that passage."},
            }),
            3,
        ),
        "changes_verdict": {
            "type": "boolean",
            "description": "True only if the answer means the recorded verdict for "
                           "this question is wrong.",
        },
    }
)

ASK_SYSTEM = """\
You are answering a follow-up question from a compliance analyst reviewing one \
item of a DHCS submission. She is looking at a recorded verdict and its cited \
evidence and wants something clarified.

Answer only from the evidence provided. That evidence is what was retrieved for \
this item — either numbered passages or complete numbered policy documents — \
plus the current verdict. Refer to it by its number either way. If it does not \
settle her question, say so directly and name what document or section would — \
do not speculate, and do not pad the answer to seem helpful.

Common questions and how to treat them:
  - "Is this Medi-Cal or OneCare?" — check each passage's policy code and the
    department/applicability shown in its header. Line-of-business mismatches
    are a real source of audit findings, so be precise rather than reassuring.
  - "Why didn't you cite X?" — if X is among the passages, explain what it does
    and does not establish. If it is not, say it was not retrieved.
  - "Does this cover <sub-case>?" — quote the operative sentence or state that
    the passages are silent on it.

quotes: only verbatim text copied character for character from the passages. \
Quotes are checked against the source automatically and dropped if altered. \
Leave the array empty if no quote is needed.

changes_verdict: true only when your answer means the recorded verdict is \
actually wrong — not merely that it deserves a caveat."""


def _render(passages: list[Passage]) -> str:
    return "\n\n---\n\n".join(
        f"[{i}] {p.policy_code} — {p.title} "
        f"(pages {p.page_start}-{p.page_end}, revised {p.revised_date})"
        f"{' · department: ' + p.department if p.department else ''}\n"
        f"{'Section: ' + p.heading if p.heading else ''}\n{p.text}"
        for i, p in enumerate(passages, start=1)
    )


def _passages_from_chunk_ids(chunk_ids: list[int]) -> list[Passage]:
    if not chunk_ids:
        return []
    marks = ",".join("?" * len(chunk_ids))
    with session() as conn:
        rows = conn.execute(
            f"""SELECT ch.id, ch.doc_id, ch.page_start, ch.page_end, ch.heading, ch.text,
                       d.policy_code, d.title, d.program, d.department,
                       d.revised_date, d.n_pages
                FROM chunks ch JOIN documents d ON d.id = ch.doc_id
                WHERE ch.id IN ({marks})""",
            chunk_ids,
        ).fetchall()
    by_id = {r["id"]: r for r in rows}
    out = []
    for cid in chunk_ids:
        r = by_id.get(cid)
        if r:
            out.append(Passage(
                chunk_id=r["id"], doc_id=r["doc_id"], policy_code=r["policy_code"],
                title=r["title"], program=r["program"], department=r["department"],
                revised_date=r["revised_date"], page_start=r["page_start"],
                page_end=r["page_end"], heading=r["heading"] or "", text=r["text"],
                n_pages=r["n_pages"],
            ))
    return out


async def ask(item: dict, question: str) -> dict:
    """Answer a follow-up using the evidence already on the item.

    Whichever unit the verdict was formed from is the unit her follow-up is
    answered against — whole documents when the batch ran in document mode,
    passages otherwise. Answering "why didn't you cite X" from a narrower slice
    of evidence than the verdict used would make the answer misleading.
    """
    s = get_settings()
    result = item.get("result") or {}
    asked_about = item.get("question") or item.get("obligation") or ""
    verdict = result.get("coverage_status") or result.get("status") or "unknown"

    docs = load_documents(result.get("context_docs") or [])
    if docs:
        evidence_label = "COMPLETE POLICY DOCUMENTS"
        rendered = "\n\n".join(
            f"===== DOCUMENT [{i}] =====\n{d.render()}"
            for i, d in enumerate(docs, start=1)
        )
        passages = []
    else:
        # Reuse what the batch retrieved — cited passages first, then the
        # runners-up already shown in the panel. No new search, one call.
        chunk_ids: list[int] = []
        for c in result.get("citations") or []:
            if c.get("chunk_id"):
                chunk_ids.append(c["chunk_id"])
        for c in result.get("candidates") or []:
            if c.get("chunk_id") and c["chunk_id"] not in chunk_ids:
                chunk_ids.append(c["chunk_id"])
        passages = _passages_from_chunk_ids(chunk_ids[:10])
        evidence_label = "PASSAGES"
        rendered = _render(passages)

    if not docs and not passages:
        return {
            "answer": "There is no retrieved evidence on this item to reason "
                      "about. Re-run it first.",
            "quotes": [], "changes_verdict": False,
        }

    try:
        data = await llm.structured(
            system=ASK_SYSTEM,
            user=(
                f"THE ITEM UNDER REVIEW\n{asked_about}\n\n"
                f"RECORDED VERDICT: {verdict} (confidence {result.get('confidence', 0)})\n"
                f"RECORDED REASONING: {result.get('reasoning', '') or '—'}\n\n"
                f"HER QUESTION\n{question}\n\n"
                f"{evidence_label}\n\n{rendered}"
            ),
            schema=ASK_SCHEMA,
            model=s.model_reasoning,
            max_tokens=8000,
            effort="medium",
            cache_key="ask",
        )
    except llm.LLMError as exc:
        # `error` marks this as a failed call rather than a real answer, so the
        # caller can refuse to write it into the item's audit trail.
        return {"answer": f"Could not answer: {exc}", "quotes": [],
                "changes_verdict": False, "error": str(exc)}

    quotes = []
    if docs:
        by_doc = {i: d for i, d in enumerate(docs, start=1)}
        for raw in data.get("quotes") or []:
            d = by_doc.get(raw.get("passage_id"))
            if not d:
                continue
            loc = locate_quote(raw.get("quote") or "", d)
            if loc.check.verified:
                quotes.append({
                    "quote": loc.check.matched_text,
                    "cite": f"{d.policy_code} p. {loc.page_start}",
                    "policy_code": d.policy_code, "doc_id": d.doc_id,
                    "page_start": loc.page_start, "page_end": loc.page_end,
                })
    else:
        by_id = {i: p for i, p in enumerate(passages, start=1)}
        for raw in data.get("quotes") or []:
            p = by_id.get(raw.get("passage_id"))
            if not p:
                continue
            check = verify_quote(raw.get("quote") or "", p.text)
            if check.verified:
                quotes.append({
                    "quote": check.matched_text, "cite": p.cite(),
                    "policy_code": p.policy_code, "doc_id": p.doc_id,
                    "page_start": p.page_start, "page_end": p.page_end,
                })

    return {
        "answer": data.get("answer") or "",
        "quotes": quotes,
        "changes_verdict": bool(data.get("changes_verdict")),
    }


# --------------------------------------------------------------------------
# rerun — redo one item with the analyst's steer
# --------------------------------------------------------------------------

async def rerun(item: dict, hint: str = "", policies: list[str] | None = None) -> dict:
    """Re-answer one item, biased by a hint and/or restricted to named policies."""
    text = item.get("question") or item.get("obligation") or ""
    is_guide = "obligation" in item and "question" not in item

    # A steered re-run has to use the same evidence unit as the batch, or her
    # redirect would be evaluated against different material than the verdict
    # she is disagreeing with.
    if get_settings().whole_document_mode:
        expansion, docs = await retrieve_documents(
            text, hint=hint, only_policies=policies
        )
        assessment = await assess_evidence_documents(text, expansion.obligation, docs)
        candidates = _document_candidates(docs)
        context_docs = [d.doc_id for d in docs]
    else:
        expansion, passages = await retrieve(text, hint=hint, only_policies=policies)
        assessment = await assess_evidence(text, expansion.obligation, passages)
        candidates = _passage_candidates(passages)
        context_docs = []

    if assessment.citations:
        assessment.contradictions = await contradiction_sweep(
            expansion.obligation, assessment.citations
        )

    result = assessment.to_dict()
    result["obligation"] = expansion.obligation
    result["plan_synonyms"] = expansion.plan_synonyms
    result["regulator_terms"] = expansion.regulator_terms
    result["evidence_mode"] = "documents" if context_docs else "passages"
    result["candidates"] = candidates
    if context_docs:
        result["context_docs"] = context_docs
    # Record the steer so the audit trail shows this answer was directed.
    result["steered"] = {
        "hint": hint or "", "policies": policies or [],
    }
    if is_guide:
        result["coverage_status"] = {
            "supported": "covered", "partial": "partial",
            "not_found": "gap", "error": "error",
        }.get(assessment.status, "gap")
    return result


# --------------------------------------------------------------------------
# cite — swap the citation to a passage she chose
# --------------------------------------------------------------------------

PICK_SCHEMA = llm.obj({
    "quote": {"type": "string",
              "description": "The verbatim sentence(s) from the passage that best "
                             "establish the obligation."},
    "covers": {"type": "string",
               "description": "What this quote establishes."},
})

PICK_SYSTEM = """\
A compliance analyst has chosen a specific passage from her plan's P&P as the \
evidence for a regulatory requirement. Select the sentence or two within it that \
best establish that requirement.

Copy the text character for character — do not fix spacing, join hyphenated line \
breaks, or paraphrase. It is verified against the source automatically and \
rejected if altered. If nothing in the passage establishes the requirement, \
return the closest relevant sentence and say so in `covers`."""


class QuoteNotInSource(ValueError):
    """The analyst supplied a quote that is not in the passage she chose."""


async def set_citation(item: dict, chunk_id: int, quote: str = "") -> dict | None:
    """Replace the item's citation with one from a passage she picked.

    If she supplies a quote it is used verbatim or rejected — never quietly
    swapped for a different one. Substituting a passage's real text for what she
    typed would hand her a citation she never chose while reporting success,
    which is the same class of error the verification layer exists to prevent.

    With no quote supplied, the model picks the operative sentence, and that pick
    faces the identical verbatim check.
    """
    passages = _passages_from_chunk_ids([chunk_id])
    if not passages:
        return None
    p = passages[0]
    text = item.get("question") or item.get("obligation") or ""

    if quote.strip():
        check = verify_quote(quote, p.text)
        if not check.verified:
            raise QuoteNotInSource(
                f"That text does not appear in {p.cite()}. Closest match was "
                f"{check.similarity * 100:.0f}%. Leave the quote blank to have the "
                f"operative sentence selected from the passage instead."
            )
        covers = "Selected by the analyst."
    else:
        s = get_settings()
        covers = "Selected from the passage you chose."
        # Raised before the try below, whose `except llm.LLMError` would
        # otherwise swallow it: with no key the picker never ran, so reporting
        # "could not verify a quote" would tell her the passage failed the
        # verbatim check when the check never happened.
        if not s.llm_enabled:
            raise llm.LLMNotConfigured(
                "ANTHROPIC_API_KEY is not set, so no sentence could be "
                "selected from that passage. Type the quote you want instead — "
                "it is checked against the source without a model."
            )
        try:
            data = await llm.structured(
                system=PICK_SYSTEM,
                user=(
                    f"REQUIREMENT\n{text}\n\n"
                    f"PASSAGE — {p.policy_code} pages {p.page_start}-{p.page_end}\n"
                    f"{p.text}"
                ),
                schema=PICK_SCHEMA,
                model=s.model_fast,
                max_tokens=3000,
                effort="low",
                cache_key="pick",
            )
            check = verify_quote(data.get("quote") or "", p.text)
            covers = data.get("covers") or covers
        except llm.LLMError:
            check = None

    if check is None or not check.verified:
        return None

    citation = Citation(
        passage_id=0, quote=check.matched_text, covers=covers,
        policy_code=p.policy_code, title=p.title, page_start=p.page_start,
        page_end=p.page_end, doc_id=p.doc_id, chunk_id=p.chunk_id,
        quote_check=check.as_dict(),
    )
    return {**citation.__dict__, "cite": citation.cite()}
