from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_DIR / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- LLM ---
    anthropic_api_key: str = ""
    # Fast model for high-fan-out work (query expansion, obligation extraction).
    model_fast: str = "claude-sonnet-5"
    # Strong model for the judgement calls Alex is accountable for.
    model_reasoning: str = "claude-opus-5"
    llm_max_concurrency: int = 10

    # --- storage ---
    data_dir: Path = REPO_DIR / "data"
    corpus_dir: Path = REPO_DIR / "data" / "corpus"
    index_path: Path = REPO_DIR / "data" / "index.db"
    uploads_dir: Path = REPO_DIR / "data" / "uploads"

    # --- retrieval tuning ---
    doc_candidates: int = 10
    chunk_candidates: int = 30
    verify_passages: int = 10

    # --- evidence mode ---
    # "documents" sends whole shortlisted policies to the reasoning model;
    # "passages" sends the top chunks. The corpus averages 9.7 pages (~6.2k
    # tokens) per policy, so a document shortlist fits in context comfortably
    # and a passage that lexical search ranked poorly can no longer be missed.
    # Recall failures are silent — nothing downstream can flag a policy that
    # retrieval never surfaced — so the passage-level recall risk is the one
    # error the trust layer cannot cover.
    evidence_mode: str = "documents"
    # Whole policies to send, and the ceiling on their combined size. The
    # budget matters because the corpus is skewed: the median policy is ~4.9k
    # tokens but AA.1000 is ~66k, so a fixed document count has a 10x spread.
    doc_context_max: int = 8
    doc_context_token_budget: int = 150_000
    # No single document below the top rank may take more than this share of the
    # budget. Without it one outsized document (AA.1000, the 66k-token Medi-Cal
    # Glossary, ranks well on any query because it contains every term in the
    # corpus) crowds out several real policies while being unable to state an
    # obligation itself. Expressed as a share rather than a title rule so it
    # generalises to any oversized reference document.
    doc_context_max_share: float = 0.35

    @property
    def whole_document_mode(self) -> bool:
        return self.evidence_mode.strip().lower() == "documents"

    @property
    def llm_enabled(self) -> bool:
        return bool(self.anthropic_api_key.strip())


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    s = Settings()
    for d in (s.data_dir, s.corpus_dir, s.uploads_dir):
        d.mkdir(parents=True, exist_ok=True)
    return s
