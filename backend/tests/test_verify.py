"""Adversarial tests for verbatim quote verification.

This is the product's core safety claim: a citation is only shown to the
analyst if the quoted text provably exists in the source document. These tests
try to get a fabricated or paraphrased quote past the check. No API key needed
— `verify_quote` is pure text matching by design.
"""

from __future__ import annotations

import pytest

from app.verify import FUZZY_THRESHOLD, verify_quote

# Real text from GG.1503 p.2, including its actual PDF artifacts: the doubled
# space in "certif ies" and the parenthetical numeral the regulator writes as
# plain prose.
SOURCE = (
    "B. Medicare Hospice Benefit Eligibility Requirements: 1. Medicare Part A "
    "(Hospital Insurance) coverage; 2. A hospice physician (and attending "
    "physician, if any) certif ies the Member's illness is terminal (life "
    "expectancy is six (6) months or less if the disease runs its normal "
    "course); 3. The Member or Authorized Representative understands and "
    "accepts care primarily for comfort (palliative) instead of care to cure "
    "the illness (curative)."
)


class TestFabricatedQuotesAreRejected:
    """The failure mode that would produce a state finding."""

    @pytest.mark.parametrize(
        "fabricated",
        [
            # Plausible, policy-sounding, and entirely absent from the source.
            "The MCP shall respond to all retrospective requests within 14 calendar days.",
            "Members may elect hospice care at any time without prior authorization.",
            "CalOptima Health ensures hospice providers hold a National Provider Identifier.",
        ],
    )
    def test_invented_sentence_is_not_verified(self, fabricated):
        check = verify_quote(fabricated, SOURCE)
        assert check.verified is False
        assert check.method == "not_found"
        assert check.start == -1

    def test_paraphrase_of_real_content_is_rejected(self):
        """Same meaning, different words — still not a citable quote."""
        check = verify_quote(
            "A hospice doctor confirms the member has a terminal illness with "
            "a life expectancy of six months or less.",
            SOURCE,
        )
        assert check.verified is False
        assert check.similarity < FUZZY_THRESHOLD

    def test_real_quote_with_a_changed_number_is_rejected(self):
        """The most dangerous edit: correct-looking text, wrong timeframe."""
        check = verify_quote(
            "life expectancy is twelve (12) months or less if the disease runs "
            "its normal course",
            SOURCE,
        )
        assert check.verified is False, (
            f"altered timeframe accepted at similarity {check.similarity}"
        )

    def test_real_quote_with_a_negation_inserted_is_rejected(self):
        check = verify_quote(
            "The Member or Authorized Representative does not understand and "
            "accepts care primarily for comfort",
            SOURCE,
        )
        assert check.verified is False

    def test_two_real_fragments_stitched_together_is_rejected(self):
        """Splicing distant true fragments produces a sentence the doc never says."""
        check = verify_quote(
            "Medicare Part A (Hospital Insurance) coverage instead of care to "
            "cure the illness (curative).",
            SOURCE,
        )
        assert check.verified is False

    def test_empty_and_whitespace_quotes_are_rejected(self):
        for junk in ("", "   ", "\n\t", '""'):
            assert verify_quote(junk, SOURCE).verified is False

    def test_quote_from_a_different_document_is_rejected(self):
        assert verify_quote(SOURCE, "An unrelated policy about claims processing.").verified is False


class TestGenuineQuotesAreAccepted:
    """The check must not be so strict that real citations get discarded."""

    def test_exact_substring_is_verified_with_offsets(self):
        quote = "Medicare Part A (Hospital Insurance) coverage"
        check = verify_quote(quote, SOURCE)
        assert check.verified and check.method == "exact"
        assert check.similarity == 1.0
        # Offsets must index the ORIGINAL text so the UI can highlight it.
        assert SOURCE[check.start : check.end] == quote

    def test_tolerates_whitespace_and_line_wrap_drift(self):
        """PDF extraction wraps lines; the same sentence is still the same quote."""
        check = verify_quote(
            "The Member or Authorized Representative\n   understands and accepts\ncare "
            "primarily for comfort (palliative)",
            SOURCE,
        )
        assert check.verified, check
        assert "understands and accepts" in check.matched_text

    def test_tolerates_typographic_punctuation_substitution(self):
        """Word processors turn ' into ’ and - into –; that is not a paraphrase."""
        check = verify_quote(
            "certif ies the Member’s illness is terminal", SOURCE
        )
        assert check.verified, check

    def test_matches_across_the_pdf_kerning_artifact(self):
        """The source literally contains 'certif ies' with a stray space."""
        check = verify_quote("certif ies the Member's illness is terminal", SOURCE)
        assert check.verified and check.method == "exact"

    def test_case_differences_are_tolerated(self):
        check = verify_quote("MEDICARE PART A (HOSPITAL INSURANCE) COVERAGE", SOURCE)
        assert check.verified

    def test_returns_what_the_document_actually_says(self):
        """matched_text is the source's wording, not the model's rendering."""
        check = verify_quote("medicare part a (hospital insurance) coverage", SOURCE)
        assert check.matched_text == "Medicare Part A (Hospital Insurance) coverage"

    def test_offsets_are_valid_for_every_verified_match(self):
        for quote in (
            "Medicare Hospice Benefit Eligibility Requirements",
            "six (6) months or less",
            "instead of care to cure the illness (curative)",
        ):
            check = verify_quote(quote, SOURCE)
            assert check.verified, quote
            assert 0 <= check.start < check.end <= len(SOURCE)
            assert check.matched_text == SOURCE[check.start : check.end]


class TestSemanticGate:
    """Edits that keep character similarity high but invert the requirement.

    Every quote here scores 0.85-0.97 against the source, so a plain ratio
    threshold would accept all of them. Each would be a defensible-looking
    citation that misstates the policy.
    """

    RULE = (
        "The MCP must provide hospice services within fourteen (14) calendar "
        "days of the request, and shall ensure all Members receive written "
        "notice prior to the effective date."
    )

    @pytest.mark.parametrize(
        "label,quote",
        [
            ("obligation weakened",
             "The MCP may provide hospice services within fourteen (14) calendar "
             "days of the request"),
            ("shall downgraded to should",
             "and should ensure all Members receive written notice prior to the "
             "effective date"),
            ("timeframe changed",
             "The MCP must provide hospice services within thirty (30) calendar "
             "days of the request"),
            ("scope narrowed",
             "and shall ensure some Members receive written notice prior to the "
             "effective date"),
            ("temporal direction flipped",
             "and shall ensure all Members receive written notice after the "
             "effective date"),
            ("day-type qualifier dropped",
             "The MCP must provide hospice services within fourteen (14) days "
             "of the request"),
        ],
    )
    def test_meaning_changing_edit_is_rejected(self, label, quote):
        check = verify_quote(quote, self.RULE)
        assert check.verified is False, (
            f"{label}: accepted at character similarity {check.similarity}"
        )

    def test_genuine_typo_still_passes_the_gate(self):
        check = verify_quote(
            "The MCP must provide hospice services within fourteen (14) "
            "calendar days of the requst",
            self.RULE,
        )
        assert check.verified and check.method == "fuzzy"

    def test_genuine_line_wrapping_still_passes_the_gate(self):
        check = verify_quote(
            "The MCP must provide\n  hospice services within\nfourteen (14) "
            "calendar days of the request",
            self.RULE,
        )
        assert check.verified


class TestFuzzyBoundary:
    def test_threshold_is_strict_enough_to_exclude_paraphrase(self):
        assert FUZZY_THRESHOLD >= 0.85

    def test_single_typo_in_a_long_quote_still_verifies(self):
        """Real quotes sometimes pick up one bad character in transit."""
        check = verify_quote(
            "The Member or Authorized Representative understands and accepts "
            "care primarilv for comfort (palliative)",
            SOURCE,
        )
        assert check.verified and check.method == "fuzzy"

    def test_quote_longer_than_source_is_rejected_without_crashing(self):
        check = verify_quote(SOURCE * 3, SOURCE)
        assert check.verified is False
        assert check.start == -1


class TestAnalystSuppliedQuoteIsNeverSubstituted:
    """When she types a quote she gets that quote, or an error — never a swap.

    Silently replacing her wording with different real text from the passage
    would hand her a citation she never chose while reporting success. That is
    the same class of failure the verification layer exists to prevent, so it
    gets its own guard.
    """

    @staticmethod
    @pytest.fixture
    def passage(monkeypatch):
        """Stub the database lookup so this needs no index and no API key."""
        from app import interact
        from app.retrieval import Passage

        stub = Passage(
            chunk_id=1, doc_id=1, policy_code="GG.1503", title="Hospice Coverage",
            program="GG", department="Medical Management", revised_date="09/01/2024",
            page_start=2, page_end=2, heading="II. POLICY", text=SOURCE, n_pages=18,
        )
        monkeypatch.setattr(interact, "_passages_from_chunk_ids", lambda ids: [stub])
        return stub

    def test_fabricated_quote_raises_instead_of_substituting(self, passage):
        import asyncio

        from app.interact import QuoteNotInSource, set_citation

        with pytest.raises(QuoteNotInSource) as excinfo:
            asyncio.run(
                set_citation(
                    {"question": "Does the P&P state the terminal illness standard?"},
                    chunk_id=1,
                    quote="The MCP shall never disenroll any Member for any reason.",
                )
            )
        # The error has to name the document and the closeness, so she can tell
        # a typo apart from citing the wrong policy.
        message = str(excinfo.value)
        assert "GG.1503" in message
        assert "%" in message

    def test_genuine_quote_is_stored_exactly_as_supplied(self, passage):
        import asyncio

        from app.interact import set_citation

        citation = asyncio.run(
            set_citation(
                {"question": "Does the P&P state the terminal illness standard?"},
                chunk_id=1,
                quote="life expectancy is six (6) months or less",
            )
        )
        assert citation is not None
        assert citation["quote"] == "life expectancy is six (6) months or less"
        assert citation["quote_check"]["verified"] is True
        assert citation["cite"] == "GG.1503 p. 2"
