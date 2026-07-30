"""Checks on the two deterministic layers: form parsing and the index.

These guard the assumptions the rest of the product rests on. The LLM layers
are exercised separately in test_verify.py, which needs no API key.
"""

from __future__ import annotations

import sqlite3

import pytest

from app.config import get_settings
from app.db import build_match, fts_query, fts_tokens, session
from app.questionnaire import parse_questions

SETTINGS = get_settings()
FORM = SETTINGS.data_dir / "samples" / "Regulatory Questionnaire.pdf"
HAS_INDEX = SETTINGS.index_path.exists()


# --------------------------------------------------------------------------
# Submission Review Form parsing
# --------------------------------------------------------------------------

@pytest.mark.skipif(not FORM.exists(), reason="sample form not present")
class TestQuestionnaire:
    @staticmethod
    @pytest.fixture(scope="class")
    def parsed():
        return parse_questions(FORM)

    def test_finds_every_question(self, parsed):
        _, questions = parsed
        assert len(questions) == 64

    def test_numbers_are_sequential_and_gapless(self, parsed):
        _, questions = parsed
        assert [q.number for q in questions] == list(range(1, 65))

    def test_recovers_numbering_pypdf_mangled(self, parsed):
        """Two-digit labels get split by extraction; order is the fallback.

        Sequential numbering must disagree with the printed label on exactly
        the items whose leading digit was orphaned — if it agreed everywhere,
        the renumbering would be untested.
        """
        _, questions = parsed
        mismatched = [q.number for q in questions if q.number != q.printed_number]
        assert mismatched, "expected some printed labels to be mis-extracted"
        # Every mismatch should be a two-digit number that lost its first digit.
        for q in questions:
            if q.number != q.printed_number:
                assert q.printed_number == q.number % 10, (q.number, q.printed_number)

    def test_every_question_has_text_and_reference(self, parsed):
        _, questions = parsed
        for q in questions:
            assert q.text.lower().startswith("do"), q.text[:60]
            assert len(q.text) > 40, q.text
            assert "APL" in q.reference, (q.number, q.reference)

    def test_answer_boilerplate_stripped(self, parsed):
        _, questions = parsed
        for q in questions:
            assert "Citation:" not in q.text
            assert "Rev. 08/2023" not in q.text
            assert "\f" not in q.text

    def test_form_pages_are_monotonic(self, parsed):
        _, questions = parsed
        pages = [q.form_page for q in questions]
        assert pages == sorted(pages)
        assert pages[0] == 1

    def test_title_identifies_the_apl(self, parsed):
        title, _ = parsed
        assert "25-008" in title, title      # kerning artifact repaired
        assert "Hospice" in title


# --------------------------------------------------------------------------
# FTS query construction — untrusted text becomes a MATCH expression
# --------------------------------------------------------------------------

class TestFtsQueryBuilding:
    def test_drops_ubiquitous_terms(self):
        toks = fts_tokens("Does the P&P state that the plan shall ensure")
        assert "does" not in toks and "shall" not in toks and "the" not in toks
        assert "plan" in toks

    def test_falls_back_when_all_terms_are_stopwords(self):
        # Must not produce an empty MATCH, which would raise at query time.
        assert build_match("does the P&P state that")

    @pytest.mark.parametrize(
        "hostile",
        [
            'foo" OR chunks_fts MATCH "bar',   # quote break-out
            "NEAR(a b) AND (c OR d)",          # injected operators
            "a* b^2 -c +d",                    # prefix / column / boost syntax
            "'; DROP TABLE documents; --",     # SQL, for good measure
            "((((",                            # unbalanced parens
        ],
    )
    def test_hostile_input_never_reaches_sqlite_malformed(self, hostile):
        """Punctuation is FTS5 syntax, so every term must be re-quoted.

        `fts_query` is the contract under test: given arbitrary text it either
        runs a well-formed query or returns no rows. A malformed expression
        would raise sqlite3.OperationalError, so executing is the assertion.
        """
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("CREATE VIRTUAL TABLE t USING fts5(text, tokenize='porter unicode61')")
        conn.execute("INSERT INTO t(text) VALUES ('harmless content')")

        rows = fts_query(
            conn, "SELECT rowid FROM t WHERE t MATCH ?", build_match(hostile)
        )
        assert isinstance(rows, list)

    def test_text_with_no_searchable_term_yields_no_results(self):
        """Pure punctuation has nothing to search for; that must not be a query."""
        assert build_match("((((") == ""
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("CREATE VIRTUAL TABLE t USING fts5(text)")
        conn.execute("INSERT INTO t(text) VALUES ('anything')")
        assert fts_query(conn, "SELECT rowid FROM t WHERE t MATCH ?", "") == []

    def test_phrase_mode_tolerates_pdf_line_wrapping(self):
        expr = build_match("retrospective review request", phrase=True)
        assert expr.startswith("NEAR(")


# --------------------------------------------------------------------------
# Index integrity
# --------------------------------------------------------------------------

@pytest.mark.skipif(not HAS_INDEX, reason="index not built")
class TestIndex:
    @staticmethod
    @pytest.fixture(scope="class")
    def conn():
        with session() as c:
            yield c

    def test_whole_corpus_indexed(self, conn):
        n = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        assert n == 373

    def test_every_document_has_metadata(self, conn):
        row = conn.execute(
            """SELECT COUNT(*) FROM documents
               WHERE policy_code = '' OR title = '' OR n_pages < 1"""
        ).fetchone()[0]
        assert row == 0

    def test_header_parsing_did_not_capture_labels_as_values(self, conn):
        """Guards the column-layout header path and the field lookaheads."""
        bad = conn.execute(
            """SELECT COUNT(*) FROM documents
               WHERE title IN ('Department', 'Section', 'Title')
                  OR department LIKE 'Section:%'
                  OR section LIKE '%CEO App%'
                  OR department LIKE '%CEO App%'"""
        ).fetchone()[0]
        assert bad == 0

    def test_chunk_pages_are_within_their_document(self, conn):
        bad = conn.execute(
            """SELECT COUNT(*) FROM chunks ch JOIN documents d ON d.id = ch.doc_id
               WHERE ch.page_start < 1
                  OR ch.page_end < ch.page_start
                  OR ch.page_end > d.n_pages"""
        ).fetchone()[0]
        assert bad == 0

    def test_fts_row_count_matches_chunks(self, conn):
        chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        indexed = conn.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0]
        assert chunks == indexed

    def test_running_header_stripped_from_chunk_text(self, conn):
        """Otherwise every page matches its own policy code and swamps bm25."""
        leaked = conn.execute(
            "SELECT COUNT(*) FROM chunks WHERE text LIKE 'Page % of %'"
        ).fetchone()[0]
        assert leaked == 0

    def test_tokenized_search_beats_ctrl_f_on_parenthetical_numerals(self, conn):
        """The corpus writes "six (6) months"; the regulator writes "six months".

        This is Alex's vocabulary-mismatch problem in its most literal form and
        the reason the search layer tokenizes instead of substring-matching.
        """
        page = conn.execute(
            """SELECT p.text FROM pages p JOIN documents d ON d.id = p.doc_id
               WHERE d.policy_code = 'GG.1503' AND p.page_no = 2"""
        ).fetchone()[0]
        assert "six months" not in page.lower()      # Ctrl-F finds nothing
        assert "six (6) months" in page.lower()      # what is actually written

        hits = conn.execute(
            """SELECT d.policy_code FROM chunks_fts
               JOIN chunks ch ON ch.id = chunks_fts.rowid
               JOIN documents d ON d.id = ch.doc_id
               WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 5""",
            (build_match("terminal illness six months life expectancy hospice"),),
        ).fetchall()
        assert "GG.1503" in {r[0] for r in hits}
