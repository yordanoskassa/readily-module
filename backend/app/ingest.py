"""Build the searchable index from the P&P corpus.

The corpus is 373 CalOptima Health policy PDFs. They are machine-generated
(not scanned), share a rigid header block on page 1, and repeat a running
header on pages 2+. Both facts are exploited below: the header gives us clean
metadata for free, and stripping the running header stops every page from
matching its own policy code.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from pypdf import PdfReader

from .config import get_settings
from .db import init_db, session

# Target chunk size in characters. ~1400 chars is roughly 350 tokens — small
# enough that a cited quote is easy to locate on the page, large enough that a
# multi-sentence obligation stays intact.
CHUNK_CHARS = 1400
CHUNK_OVERLAP = 220
MIN_CHUNK_CHARS = 120

# Page-1 header fields, e.g. "Policy: GG.1503" / "Title: CalOptima Health ...".
_HEADER_FIELDS = {
    "policy_code": r"Policy:\s*([A-Z]{2,3}\.\d{3,4})",
    "department": r"Department:\s*(.+?)(?=\n\s*(?:Section|CEO\s+Approval|Effective|Revised|Applicable|Title)\s*:|\n\s*I\.|\Z)",
    "section": r"Section:\s*(.+?)(?=\n\s*(?:Department|CEO\s+Approval|Effective|Revised|Applicable|Title)\s*:|\n\s*I\.|\Z)",
    "effective_date": r"Effective Date:\s*([0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4})",
    "revised_date": r"Revised Date:\s*([0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4})",
}
# Title runs until the next known field label. It frequently wraps across
# several lines, so we collapse whitespace afterwards.
_TITLE_RE = re.compile(
    r"Title:\s*(.+?)(?=\n\s*(?:Department|Section|CEO\s+Approval|Effective|Revised|Applicable|Policy)\s*:)",
    re.S,
)
# "Applicable to: ☒ Medi-Cal ☐ OneCare" — keep only the checked programmes.
_APPLICABLE_RE = re.compile(r"Applicable to:(.{0,400})", re.S)
_CHECKED_RE = re.compile(r"☒\s*([A-Za-z][A-Za-z \-]{2,20})")

# Running header on pages 2+:
#   "Page 3 of 18   GG.1503: Title...   Revised Date: 09/01/2024"
_RUNNING_HEADER_RE = re.compile(
    r"^\s*Page\s+\d+\s+of\s+\d+.*?(?:\n|$)", re.I | re.M
)
_PAGE_FOOTER_RE = re.compile(r"^\s*Page\s+\d+\s+of\s+\d+\s*$", re.I | re.M)

# Top-level outline headings: "I. PURPOSE", "III. PROCEDURE", "V. ATTACHMENTS".
_HEADING_RE = re.compile(r"^\s*([IVX]{1,5})\.\s+([A-Z][A-Z /&\-]{3,60})\s*$", re.M)


@dataclass
class Chunk:
    ord: int
    page_start: int
    page_end: int
    heading: str
    text: str


@dataclass
class ParsedDoc:
    path: str
    program: str
    policy_code: str = ""
    title: str = ""
    department: str = ""
    section: str = ""
    applicable_to: str = ""
    effective_date: str = ""
    revised_date: str = ""
    pages: list[tuple[int, str]] = field(default_factory=list)
    chunks: list[Chunk] = field(default_factory=list)


def _clean(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip(" :;,-")


def _strip_running_header(text: str) -> str:
    text = _RUNNING_HEADER_RE.sub("", text, count=1)
    return _PAGE_FOOTER_RE.sub("", text)


# A few documents lay the header out as two columns, which pypdf flattens into
# a run of bare labels followed by a run of values:
#     Policy:  Title:  Department:  Section:
#     GG.1132  Medi-Cal Annual Wellness Visit  Medical Management  Quality Analytics
# Detected by two or more consecutive label-only lines.
_DETACHED_RE = re.compile(
    r"(?:^[ \t]*(?:Policy|Title|Department|Section)[ \t]*:[ \t]*$\n?){2,}", re.M
)
_LABEL_ONLY_RE = re.compile(r"^[ \t]*(Policy|Title|Department|Section)[ \t]*:[ \t]*$", re.M)


def _parse_detached_header(page1: str) -> dict[str, str]:
    """Recover column-layout headers by pairing the label run with the value run."""
    block = _DETACHED_RE.search(page1)
    if not block:
        return {}
    labels = _LABEL_ONLY_RE.findall(block.group(0))
    tail = page1[block.end():]
    values: list[str] = []
    for line in tail.splitlines():
        line = line.strip()
        if not line:
            continue
        # Stop at the next real field or the start of the policy body.
        if re.match(r"(?:CEO Approval|Effective Date|Revised Date|Applicable to)\s*:", line):
            break
        if re.match(r"[IVX]{1,5}\.\s", line):
            break
        values.append(line)
        if len(values) == len(labels):
            break
    if len(values) != len(labels):
        return {}
    key_for = {"Policy": "policy_code", "Title": "title",
               "Department": "department", "Section": "section"}
    return {key_for[lab]: _clean(val) for lab, val in zip(labels, values)}


def parse_header(page1: str, fallback_code: str) -> dict[str, str]:
    meta: dict[str, str] = dict(_parse_detached_header(page1))
    for key, pattern in _HEADER_FIELDS.items():
        if meta.get(key):
            continue  # already recovered from a detached-column header
        m = re.search(pattern, page1, re.S)
        if m:
            meta[key] = _clean(m.group(1))

    if not meta.get("title"):
        m = _TITLE_RE.search(page1)
        if m:
            meta["title"] = _clean(m.group(1))

    m = _APPLICABLE_RE.search(page1)
    if m:
        checked = [_clean(c) for c in _CHECKED_RE.findall(m.group(1))]
        meta["applicable_to"] = ", ".join(dict.fromkeys(c for c in checked if c))

    meta.setdefault("policy_code", fallback_code)
    # A handful of documents (glossaries, attachment-only files) have no Title:
    # line. Fall back to the policy code so the row is still identifiable.
    if not meta.get("title"):
        meta["title"] = meta["policy_code"]
    return meta


def _split_paragraphs(text: str) -> list[str]:
    """Split into paragraph-ish units, preferring outline boundaries.

    The corpus uses a I./A./1./a. outline. Breaking on lettered and numbered
    items keeps a chunk from starting mid-clause, which matters because the
    chunk text is what the model quotes from.
    """
    parts = re.split(r"\n\s*\n+", text)
    out: list[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        # Break long blocks at outline markers at line start.
        if len(part) > CHUNK_CHARS:
            pieces = re.split(r"\n(?=\s*(?:[A-Z]\.|\d{1,2}\.|[a-z]\.)\s)", part)
            out.extend(p.strip() for p in pieces if p.strip())
        else:
            out.append(part)
    return out


def build_chunks(pages: list[tuple[int, str]]) -> list[Chunk]:
    """Chunk a document while tracking which page each chunk spans.

    Page attribution is the whole point — a citation without a page number is
    useless to Alex — so every unit carries its source page from the start.
    """
    units: list[tuple[int, str]] = []  # (page_no, paragraph)
    heading_at: dict[int, str] = {}
    current_heading = ""

    for page_no, raw in pages:
        text = _strip_running_header(raw)
        for para in _split_paragraphs(text):
            m = _HEADING_RE.search(para)
            if m:
                current_heading = _clean(f"{m.group(1)}. {m.group(2)}")
            heading_at[len(units)] = current_heading
            units.append((page_no, para))

    chunks: list[Chunk] = []
    i = 0
    ordinal = 0
    while i < len(units):
        buf: list[str] = []
        size = 0
        start_i = i
        while i < len(units) and size < CHUNK_CHARS:
            _, para = units[i]
            buf.append(para)
            size += len(para) + 2
            i += 1
        text = "\n\n".join(buf).strip()
        if len(text) >= MIN_CHUNK_CHARS or not chunks:
            chunks.append(
                Chunk(
                    ord=ordinal,
                    page_start=units[start_i][0],
                    page_end=units[i - 1][0],
                    heading=heading_at.get(start_i, ""),
                    text=text,
                )
            )
            ordinal += 1
        elif chunks:
            # Tail fragment — fold it into the previous chunk rather than
            # emitting a chunk too small to carry meaning.
            chunks[-1].text += "\n\n" + text
            chunks[-1].page_end = units[i - 1][0]

        # Step back for overlap so an obligation split across the boundary is
        # still fully present in one chunk.
        if i < len(units) and CHUNK_OVERLAP:
            back = 0
            j = i
            while j > start_i + 1 and back < CHUNK_OVERLAP:
                j -= 1
                back += len(units[j][1])
            i = max(start_i + 1, j)
    return chunks


def parse_pdf(path: Path, corpus_root: Path) -> ParsedDoc | None:
    try:
        reader = PdfReader(str(path))
        pages = [(n + 1, (p.extract_text() or "")) for n, p in enumerate(reader.pages)]
    except Exception as exc:  # corrupt or encrypted file — skip, don't abort
        print(f"  !! {path.name}: {exc}", file=sys.stderr)
        return None

    if not any(t.strip() for _, t in pages):
        print(f"  !! {path.name}: no extractable text (scanned?)", file=sys.stderr)
        return None

    rel = path.relative_to(corpus_root).as_posix()
    program = rel.split("/")[0] if "/" in rel else ""
    fallback_code = re.split(r"[_ ]", path.stem)[0]

    meta = parse_header(pages[0][1], fallback_code)
    doc = ParsedDoc(path=rel, program=program, pages=pages, **meta)
    doc.chunks = build_chunks(pages)
    return doc


def index_corpus(corpus_dir: Path | None = None, verbose: bool = True) -> dict:
    s = get_settings()
    root = Path(corpus_dir or s.corpus_dir)
    pdfs = sorted(root.rglob("*.pdf"))
    if not pdfs:
        raise SystemExit(f"no PDFs under {root}")

    init_db()
    stats = {"documents": 0, "pages": 0, "chunks": 0, "skipped": 0}

    with session() as conn:
        conn.execute("DELETE FROM documents")
        conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('delete-all')")

        for n, pdf in enumerate(pdfs, 1):
            doc = parse_pdf(pdf, root)
            if doc is None:
                stats["skipped"] += 1
                continue

            cur = conn.execute(
                """INSERT INTO documents
                   (path, program, policy_code, title, department, section,
                    applicable_to, effective_date, revised_date, n_pages)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    doc.path, doc.program, doc.policy_code, doc.title,
                    doc.department, doc.section, doc.applicable_to,
                    doc.effective_date, doc.revised_date, len(doc.pages),
                ),
            )
            doc_id = cur.lastrowid

            conn.executemany(
                "INSERT INTO pages (doc_id, page_no, text) VALUES (?,?,?)",
                [(doc_id, pno, text) for pno, text in doc.pages],
            )

            for ch in doc.chunks:
                c = conn.execute(
                    """INSERT INTO chunks (doc_id, ord, page_start, page_end, heading, text)
                       VALUES (?,?,?,?,?,?)""",
                    (doc_id, ch.ord, ch.page_start, ch.page_end, ch.heading, ch.text),
                )
                conn.execute(
                    """INSERT INTO chunks_fts (rowid, text, heading, title, policy_code)
                       VALUES (?,?,?,?,?)""",
                    (c.lastrowid, ch.text, ch.heading, doc.title, doc.policy_code),
                )

            stats["documents"] += 1
            stats["pages"] += len(doc.pages)
            stats["chunks"] += len(doc.chunks)
            if verbose and n % 50 == 0:
                print(f"  {n}/{len(pdfs)} …")

        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('corpus_version', ?)",
            (f"{stats['documents']}d/{stats['chunks']}c",),
        )
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('corpus_root', ?)",
                     (str(root),))

    with session() as conn:
        conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')")

    if verbose:
        print(f"indexed {stats['documents']} docs, {stats['pages']} pages, "
              f"{stats['chunks']} chunks ({stats['skipped']} skipped)")
    return stats


if __name__ == "__main__":
    index_corpus()
