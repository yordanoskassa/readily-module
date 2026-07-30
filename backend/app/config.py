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

    @property
    def llm_enabled(self) -> bool:
        return bool(self.anthropic_api_key.strip())


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    s = Settings()
    for d in (s.data_dir, s.corpus_dir, s.uploads_dir):
        d.mkdir(parents=True, exist_ok=True)
    return s
