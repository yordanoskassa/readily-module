"""Tests for whole-document evidence: page attribution and context budgeting.

Passage retrieval fails silently — if FTS5 never surfaces the right chunk there
is no quote to verify and no contradiction to sweep, and the run reports a
confident "not found". Whole-document mode removes that failure by putting
complete policies in front of the model, which moves two things into scope here:

1. **The page cite is now derived, not claimed.** The model is told not to report
   page numbers; the page comes from where the quote is physically located. So
   locating has to be right, and has to stay right for a sentence broken across
   a page break.
2. **The context budget is now load-bearing.** The corpus is skewed — median
   policy ~4.9k tokens, largest ~66k — so without a per-document cap one
   oversized reference document crowds out several real policies.

No API key needed: `locate_quote` is `verify_quote` plus arithmetic, and the
budget is pure selection logic.
"""

from __future__ import annotations

import pytest

from app.retrieval import DocumentBundle, search_documents
from app.verify import locate_quote

# Real GG.1503 text, keeping the PDF artifacts ("certif ies", the parenthetical
# numerals) that the verification layer has to tolerate.
PAGE_2 = (
    "B. Medicare Hospice Benefit Eligibility Requirements: 1. Medicare Part A "
    "(Hospital Insurance) coverage; 2. A hospice physician (and attending "
    "physician, if any) certif ies the Member's illness is terminal (life "
    "expectancy is six (6) months or less if the disease runs its normal course)."
)
PAGE_3 = (
    "C. The hospice provider shall file the Notice of Election with CalOptima "
    "Health no later than thirty (30) calendar days after the effective date of "
    "the Member's hospice election."
)
PAGE_4 = (
    "D. Revocation. A Member may revoke the election of hospice care at any "
    "time. Revocation must be submitted in writing."
)


def bundle(pages: list[tuple[int, str]], **kw) -> DocumentBundle:
    return DocumentBundle(
        doc_id=kw.get("doc_id", 1),
        policy_code=kw.get("policy_code", "GG.1503"),
        title="CalOptima Health Hospice Coverage",
        program="GG", department="Medical Management",
        applicable_to="Medi-Cal, OneCare", revised_date="2025-02-01",
        n_pages=len(pages), pages=pages,
    )


DOC = bundle([(2, PAGE_2), (3, PAGE_3), (4, PAGE_4)])


class TestPageAttributionIsDerived:
    """The citation's page comes from the text, not from the model."""

    @pytest.mark.parametrize(
        "quote,expected_page",
        [
            ("Medicare Part A (Hospital Insurance) coverage", 2),
            ("no later than thirty (30) calendar days", 3),
            ("A Member may revoke the election of hospice care at any time.", 4),
        ],
    )
    def test_quote_resolves_to_its_own_page(self, quote, expected_page):
        loc = locate_quote(quote, DOC)
        assert loc.check.verified is True
        assert loc.check.method == "exact"
        assert (loc.page_start, loc.page_end) == (expected_page, expected_page)

    def test_page_numbers_are_the_documents_own_not_positional(self):
        """A document starting at page 2 must not report its first page as 1."""
        loc = locate_quote("Medicare Part A (Hospital Insurance) coverage", DOC)
        assert loc.page_start == 2

    def test_an_exact_match_late_in_the_document_beats_a_fuzzy_one_early(self):
        """Otherwise the first near-miss page would win and mis-cite the page.

        Page 2 is deliberately a close-but-not-equal variant of the page 9 text,
        so scanning in page order would stop on the wrong page.
        """
        doc = bundle([
            (2, "The provider shall submit the report within thirty (30) days of "
                "the end of the reporting period, excluding weekends."),
            (9, "The provider shall submit the report within thirty (30) days of "
                "the end of the reporting period."),
        ])
        quote = ("The provider shall submit the report within thirty (30) days of "
                 "the end of the reporting period.")
        loc = locate_quote(quote, doc)
        assert loc.check.method == "exact"
        assert loc.page_start == 9


class TestQuotesSpanningAPageBreak:
    """Real evidence that would otherwise be discarded as unverifiable."""

    def test_sentence_split_across_two_pages_still_verifies(self):
        doc = bundle([
            (5, "The Plan shall notify the Member in writing within five (5)"),
            (6, "calendar days of the determination."),
        ])
        loc = locate_quote(
            "within five (5)\ncalendar days of the determination.", doc
        )
        assert loc.check.verified is True
        assert (loc.page_start, loc.page_end) == (5, 6)

    def test_single_page_attribution_is_preferred_over_a_pair(self):
        """A quote wholly inside one page must not be cited as a page range."""
        loc = locate_quote("Revocation must be submitted in writing.", DOC)
        assert (loc.page_start, loc.page_end) == (4, 4)

    def test_page_spans_are_pages_plus_consecutive_pairs(self):
        spans = DOC.page_spans()
        assert len(spans) == 3 + 2
        assert [(a, b) for a, b, _ in spans] == [
            (2, 2), (3, 3), (4, 4), (2, 3), (3, 4)
        ]


class TestTheTrustLayerStillHolds:
    """Whole-document mode must not weaken any guarantee of passage mode."""

    @pytest.mark.parametrize(
        "fabricated",
        [
            "The hospice provider shall file the Notice of Election within five "
            "(5) calendar days.",
            "CalOptima Health ensures hospice providers hold a National Provider "
            "Identifier.",
        ],
    )
    def test_fabricated_quote_is_not_located(self, fabricated):
        loc = locate_quote(fabricated, DOC)
        assert loc.check.verified is False
        assert (loc.page_start, loc.page_end) == (0, 0)

    def test_changed_timeframe_is_rejected_across_the_whole_document(self):
        """The semantic gate has to apply per span, not just per passage.

        "twelve (12)" for "thirty (30)" scores highly on characters and is the
        exact edit that becomes a state finding.
        """
        loc = locate_quote("no later than twelve (12) calendar days", DOC)
        assert loc.check.verified is False

    def test_inserted_negation_is_rejected(self):
        loc = locate_quote(
            "A Member may not revoke the election of hospice care at any time.", DOC
        )
        assert loc.check.verified is False

    def test_page_markers_cannot_end_up_inside_a_verified_quote(self):
        """`render()` adds "[page N]" markers for the model's benefit only.

        Verification runs against raw page text, so a quote containing a marker
        must fail — otherwise prompt scaffolding could be passed off as policy
        language.
        """
        assert "[page 3]" in DOC.render()
        loc = locate_quote(
            "[page 3]\nC. The hospice provider shall file the Notice of Election",
            DOC,
        )
        assert loc.check.verified is False


class TestContextBudget:
    """Selection logic — no database, no model."""

    def _docs(self, sizes: list[int]) -> list[DocumentBundle]:
        # ~4 chars per token, so a page of `n` tokens is 4n characters.
        return [
            bundle([(1, "x" * (tok * 4))], doc_id=i, policy_code=f"P.{i}")
            for i, tok in enumerate(sizes, start=1)
        ]

    def test_est_tokens_tracks_page_text(self):
        d = self._docs([5000])[0]
        assert d.est_tokens == pytest.approx(5000, rel=0.01)

    def test_oversized_document_is_skipped_but_the_top_rank_is_always_sent(
        self, monkeypatch
    ):
        """A 66k-token glossary must not evict several real policies.

        The cap deliberately exempts rank 1: if retrieval is confident enough to
        put a document first, its size is not a reason to withhold the likely
        answer.
        """
        from app import retrieval

        docs = self._docs([66_000, 5_000, 5_000, 60_000, 5_000])
        monkeypatch.setattr(retrieval, "load_documents", lambda ids: docs)
        monkeypatch.setattr(
            retrieval, "_rank_documents",
            lambda conn, phr, top=None, density=False: {
                d.doc_id: 1.0 / i for i, d in enumerate(docs, start=1)
            },
        )
        chosen = search_documents(["anything"], max_docs=5, token_budget=150_000)
        codes = [d.policy_code for d in chosen]
        assert codes[0] == "P.1"          # oversized, but ranked first -> sent
        assert "P.4" not in codes         # oversized and not ranked first -> cut
        assert codes == ["P.1", "P.2", "P.3", "P.5"]

    def test_budget_is_never_exceeded_by_the_documents_after_the_first(
        self, monkeypatch
    ):
        from app import retrieval

        docs = self._docs([20_000] * 10)
        monkeypatch.setattr(retrieval, "load_documents", lambda ids: docs)
        monkeypatch.setattr(
            retrieval, "_rank_documents",
            lambda conn, phr, top=None, density=False: {
                d.doc_id: 1.0 / i for i, d in enumerate(docs, start=1)
            },
        )
        chosen = search_documents(["anything"], max_docs=10, token_budget=70_000)
        assert sum(d.est_tokens for d in chosen) <= 70_000
        assert len(chosen) == 3
