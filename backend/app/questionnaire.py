"""Parse a DHCS Submission Review Form into structured questions.

These forms are a numbered list of "Does the P&P state that ...?" items, each
followed by a `(Reference: APL 25-008, page N)` citation and Yes/No +
Citation blanks for the plan to fill in.

pypdf's text extraction mangles the numbering: a leading digit is frequently
emitted on its own line ("3\n. Does"), and two-digit numbers get split across
the boundary so "35." arrives as a stray "3" plus "5.". The extracted labels
are therefore unreliable — but the *order* of the items is not, so we anchor
on the question text and renumber sequentially.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from pathlib import Path

from pypdf import PdfReader

# Sentinel marking which form page we are on, so each question can report the
# page of the form it came from (distinct from the P&P page we later cite).
_PAGE_MARK = "\f{%d}"
_PAGE_MARK_RE = re.compile(r"\f\{(\d+)\}")

# Boilerplate that repeats on every page and would otherwise land inside a
# question's text.
_BOILERPLATE = [
    re.compile(r"Rev\.\s*\d{2}/\d{4}", re.I),
    re.compile(r"^\s*Yes\s+No\s*$", re.M),
    re.compile(r"Citation:\s*", re.I),
]

# The question stem. Real forms also use "Do the P&Ps state", "Does the
# P&P describe", etc., so key on the verb + P&P rather than an exact phrase.
_ANCHOR_RE = re.compile(
    r"(?:^|\n|\}|\s)(\d{1,3})\.\s*(Do(?:es)?\s+(?:the|your)\s+P&P)", re.I
)
_REFERENCE_RE = re.compile(r"\(\s*Reference:\s*([^)]*)\)", re.S | re.I)


@dataclass
class Question:
    number: int          # sequential position in the form (authoritative)
    printed_number: int  # as extracted from the PDF; may be wrong
    text: str
    reference: str       # e.g. "APL 25-008, pages 2-3"
    form_page: int


def _normalize(raw: str) -> str:
    """Undo pypdf's line-splitting artifacts without disturbing real text."""
    # "3\n. Does" -> "3. Does"
    s = re.sub(r"(\d)\s*\n\s*\.", r"\1.", raw)
    # "D\noes the P&P" -> "Does the P&P" (capital orphaned from its word)
    s = re.sub(r"\b([A-Z])\s*\n\s*([a-z]{2,})", r"\1\2", s)
    for pattern in _BOILERPLATE:
        s = pattern.sub(" ", s)
    return re.sub(r"[ \t]+", " ", s)


def extract_title(page1: str) -> str:
    """Pull the submission item line, which names the APL under review."""
    m = re.search(
        r"SUBMISSION ITEM:\s*(.+?)(?=\n\s*(?:☐|APPROVED|ADDITIONAL|DENIED)|\Z)",
        page1, re.S | re.I,
    )
    if not m:
        m = re.search(r"Citations:\s*(.+)", page1)
    if not m:
        return "Submission Review Form"
    return _fix_kerning(re.sub(r"\s+", " ", m.group(1)).strip())


def _fix_kerning(text: str) -> str:
    """Repair the two kerning artifacts that show up in headings.

    PDF text extraction inserts stray spaces around hyphens ("APL 25 -008")
    and before some suffixes ("regard ing"). Only the hyphen case can be fixed
    without a dictionary, so that is all we touch — measured across the corpus,
    true intra-word splits are ~0.007% of tokens and not worth the risk of a
    heuristic that corrupts real text.
    """
    text = re.sub(r"(\w)\s+-\s*(\d)", r"\1-\2", text)   # "25 -008" -> "25-008"
    return re.sub(r"(\w)\s+-\s+(\w)", r"\1-\2", text)   # "Non - Medical" -> "Non-Medical"


def parse_questions(pdf_path: str | Path) -> tuple[str, list[Question]]:
    reader = PdfReader(str(pdf_path))
    pages = [(n + 1, (p.extract_text() or "")) for n, p in enumerate(reader.pages)]
    title = extract_title(pages[0][1])

    marked = "".join(_PAGE_MARK % n + text for n, text in pages)
    doc = _normalize(marked)

    anchors = list(_ANCHOR_RE.finditer(doc))
    questions: list[Question] = []

    for idx, m in enumerate(anchors):
        end = anchors[idx + 1].start() if idx + 1 < len(anchors) else len(doc)
        body = doc[m.start(2):end]

        ref_match = _REFERENCE_RE.search(body)
        # The question is everything before its (Reference: ...) citation.
        q_text = body[: ref_match.start()] if ref_match else body
        reference = (
            re.sub(r"\s+", " ", ref_match.group(1)).strip() if ref_match else ""
        )

        marks = _PAGE_MARK_RE.findall(doc[: m.start(1)])
        form_page = int(marks[-1]) if marks else 1

        questions.append(
            Question(
                number=idx + 1,
                printed_number=int(m.group(1)),
                text=_tidy(q_text),
                reference=reference,
                form_page=form_page,
            )
        )

    return title, questions


def _tidy(text: str) -> str:
    text = _PAGE_MARK_RE.sub(" ", text)
    text = re.sub(r"\s+", " ", text)
    # Drop a trailing fragment of the answer block if it survived.
    text = re.sub(r"\s*(?:Yes|No|Citation)\s*:?\s*$", "", text, flags=re.I)
    return text.strip(" ☐☒-")


def to_dicts(questions: list[Question]) -> list[dict]:
    return [asdict(q) for q in questions]


if __name__ == "__main__":
    import sys

    from .config import get_settings

    path = (
        sys.argv[1]
        if len(sys.argv) > 1
        else get_settings().data_dir / "samples" / "Regulatory Questionnaire.pdf"
    )
    title, qs = parse_questions(path)
    print(f"{title}\n{len(qs)} questions\n")
    for q in qs[:3] + qs[-2:]:
        flag = "" if q.number == q.printed_number else f"  (printed as {q.printed_number})"
        print(f"[{q.number}] form p{q.form_page} · {q.reference}{flag}\n    {q.text[:150]}\n")
