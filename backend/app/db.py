"""SQLite storage + FTS5 lexical index for the P&P corpus.

FTS5 ships with CPython's sqlite3, so the whole search layer has zero
external dependencies and the index is a single file we can bake into the
Docker image. That keeps deploys boring, which is the point.
"""

from __future__ import annotations

import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import get_settings

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS documents (
    id            INTEGER PRIMARY KEY,
    path          TEXT UNIQUE NOT NULL,
    program       TEXT,              -- corpus subfolder (MA, GG, PA, ...)
    policy_code   TEXT,              -- e.g. "GG.1503"
    title         TEXT,
    department    TEXT,
    section       TEXT,
    applicable_to TEXT,              -- "Medi-Cal, OneCare"
    effective_date TEXT,
    revised_date  TEXT,
    n_pages       INTEGER
);

CREATE TABLE IF NOT EXISTS pages (
    doc_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_no INTEGER NOT NULL,
    text    TEXT NOT NULL,
    PRIMARY KEY (doc_id, page_no)
);

CREATE TABLE IF NOT EXISTS chunks (
    id       INTEGER PRIMARY KEY,
    doc_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ord      INTEGER NOT NULL,
    page_start INTEGER NOT NULL,
    page_end   INTEGER NOT NULL,
    heading  TEXT,
    text     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id, ord);

-- External-content FTS index over chunks. `title` is duplicated into every
-- row so a query can match on document title as well as body text.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text, heading, title, policy_code,
    content='',
    tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Persisted review work. Alex's accept/flag decisions have to survive a
-- refresh; an audit trail is the whole product for a regulated user.
CREATE TABLE IF NOT EXISTS runs (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,        -- 'questionnaire' | 'guide'
    title      TEXT,
    source_name TEXT,
    status     TEXT NOT NULL,        -- 'parsing'|'running'|'done'|'error'
    created_at TEXT NOT NULL,
    total      INTEGER DEFAULT 0,
    completed  INTEGER DEFAULT 0,
    error      TEXT,
    payload    TEXT                  -- JSON blob of items + results
);
"""


def connect(path: Path | None = None) -> sqlite3.Connection:
    s = get_settings()
    p = Path(path or s.index_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def session(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    conn = connect(path)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(path: Path | None = None) -> None:
    with session(path) as conn:
        conn.executescript(SCHEMA)


# --------------------------------------------------------------------------
# FTS query building
# --------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"[A-Za-z0-9]+(?:'[A-Za-z]+)?")

# Words that are ubiquitous in this corpus and so carry no discriminating
# power. Dropping them stops "does the p&p state that the plan shall..."
# from matching all 373 documents equally.
STOPWORDS = {
    "a", "an", "and", "any", "are", "as", "at", "be", "by", "does", "for",
    "from", "has", "have", "how", "in", "is", "it", "its", "may", "must",
    "of", "on", "or", "shall", "should", "state", "states", "such", "that",
    "the", "their", "there", "these", "they", "this", "to", "was", "were",
    "what", "when", "which", "will", "with", "within", "would", "pp", "p",
    "policy", "policies", "procedure", "procedures", "include", "includes",
    "including", "ensure", "ensures", "required", "require", "requires",
}


def fts_tokens(text: str, drop_stopwords: bool = True) -> list[str]:
    toks = [t.lower() for t in _TOKEN_RE.findall(text or "")]
    if drop_stopwords:
        toks = [t for t in toks if t not in STOPWORDS and len(t) > 1]
    return toks


def build_match(text: str, phrase: bool = False) -> str:
    """Turn free text into a safe FTS5 MATCH expression.

    FTS5's query language treats plenty of punctuation as syntax, so we
    tokenise ourselves and re-quote every term. `phrase=True` produces a
    NEAR-ish exact phrase; otherwise terms are OR'd and bm25 does the
    ranking.
    """
    toks = fts_tokens(text)
    if not toks:
        toks = fts_tokens(text, drop_stopwords=False)
    if not toks:
        return ""
    quoted = [f'"{t}"' for t in toks]
    if phrase and len(quoted) > 1:
        # Keep phrases tolerant of the line-wrap noise in PDF text.
        return f"NEAR({' '.join(quoted)}, 12)"
    return " OR ".join(quoted)
