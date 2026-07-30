"""Run orchestration: fan out work, stream progress, persist review decisions.

A 64-question submission form is ~190 model calls and several minutes, so a run
is a background job that streams results as they land rather than a request that
blocks. Alex's accept/flag/edit decisions are persisted alongside the results —
in a regulated workflow the audit trail *is* the deliverable.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from . import guide as guide_mod
from . import llm
from .config import get_settings
from .db import session
from .questionnaire import parse_questions
from .retrieval import retrieve
from .verify import assess_evidence, contradiction_sweep

RunKind = Literal["questionnaire", "guide"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Run:
    id: str
    kind: RunKind
    title: str
    source_name: str
    status: str = "running"          # running | done | error
    total: int = 0
    completed: int = 0
    error: str = ""
    created_at: str = field(default_factory=_now)
    items: list[dict] = field(default_factory=list)

    def summary(self) -> dict:
        counts: dict[str, int] = {}
        reviewed = {"accepted": 0, "flagged": 0, "edited": 0, "open": 0}
        contradictions = 0
        for item in self.items:
            result = item.get("result") or {}
            key = result.get("coverage_status") or result.get("status") or "pending"
            counts[key] = counts.get(key, 0) + 1
            reviewed[item.get("review", {}).get("state", "open")] = (
                reviewed.get(item.get("review", {}).get("state", "open"), 0) + 1
            )
            if result.get("contradictions"):
                contradictions += 1
        return {
            "id": self.id, "kind": self.kind, "title": self.title,
            "source_name": self.source_name, "status": self.status,
            "total": self.total, "completed": self.completed,
            "error": self.error, "created_at": self.created_at,
            "counts": counts, "review": reviewed,
            "contradiction_items": contradictions,
        }

    def to_dict(self) -> dict:
        return {**self.summary(), "items": self.items}


# --------------------------------------------------------------------------
# Store — SQLite for durability, in-memory for live subscribers
# --------------------------------------------------------------------------

class RunStore:
    def __init__(self) -> None:
        self._runs: dict[str, Run] = {}
        self._queues: dict[str, list[asyncio.Queue]] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    # -- persistence ------------------------------------------------------
    def save(self, run: Run) -> None:
        with session() as conn:
            conn.execute(
                """INSERT INTO runs (id, kind, title, source_name, status, created_at,
                                     total, completed, error, payload)
                   VALUES (?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     status=excluded.status, total=excluded.total,
                     completed=excluded.completed, error=excluded.error,
                     payload=excluded.payload, title=excluded.title""",
                (run.id, run.kind, run.title, run.source_name, run.status,
                 run.created_at, run.total, run.completed, run.error,
                 json.dumps(run.items)),
            )

    def load(self, run_id: str) -> Run | None:
        if run_id in self._runs:
            return self._runs[run_id]
        with session() as conn:
            row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not row:
            return None
        run = Run(
            id=row["id"], kind=row["kind"], title=row["title"],
            source_name=row["source_name"], status=row["status"],
            total=row["total"], completed=row["completed"],
            error=row["error"] or "", created_at=row["created_at"],
            items=json.loads(row["payload"] or "[]"),
        )
        # A run interrupted by a restart is not still running.
        if run.status == "running":
            run.status = "error"
            run.error = "Interrupted by a server restart."
        self._runs[run_id] = run
        return run

    def list_runs(self, limit: int = 50) -> list[dict]:
        with session() as conn:
            rows = conn.execute(
                """SELECT id, kind, title, source_name, status, created_at,
                          total, completed
                   FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def delete(self, run_id: str) -> None:
        self.cancel(run_id)
        self._runs.pop(run_id, None)
        with session() as conn:
            conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))

    # -- live updates -----------------------------------------------------
    def subscribe(self, run_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        self._queues.setdefault(run_id, []).append(q)
        return q

    def unsubscribe(self, run_id: str, q: asyncio.Queue) -> None:
        listeners = self._queues.get(run_id)
        if listeners and q in listeners:
            listeners.remove(q)

    def publish(self, run_id: str, event: dict) -> None:
        for q in list(self._queues.get(run_id, [])):
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(event)

    def cancel(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        if task and not task.done():
            task.cancel()
            return True
        return False

    def register_task(self, run_id: str, task: asyncio.Task) -> None:
        self._tasks[run_id] = task
        task.add_done_callback(lambda _: self._tasks.pop(run_id, None))


STORE = RunStore()


# --------------------------------------------------------------------------
# Questionnaire run
# --------------------------------------------------------------------------

async def _answer_question(q: dict) -> dict:
    """Retrieve, assess, then sweep for contradictions. One question's packet."""
    expansion, passages = await retrieve(q["text"])
    assessment = await assess_evidence(q["text"], expansion.obligation, passages)

    if assessment.citations:
        assessment.contradictions = await contradiction_sweep(
            expansion.obligation, assessment.citations
        )

    result = assessment.to_dict()
    result["obligation"] = expansion.obligation
    result["plan_synonyms"] = expansion.plan_synonyms
    result["regulator_terms"] = expansion.regulator_terms
    # Keep the runners-up so a rejected answer still gives her somewhere to look.
    result["candidates"] = [
        {
            "cite": p.cite(), "policy_code": p.policy_code, "title": p.title,
            "doc_id": p.doc_id, "chunk_id": p.chunk_id, "page_start": p.page_start,
            "page_end": p.page_end, "heading": p.heading, "score": p.score,
            "excerpt": p.text[:600],
        }
        for p in passages[:6]
    ]
    return result


def _blank_item(q: dict) -> dict:
    return {
        "number": q["number"], "question": q["text"], "reference": q["reference"],
        "form_page": q["form_page"], "result": None,
        "review": {"state": "open", "note": "", "updated_at": ""},
    }


async def _run_questionnaire(run: Run, questions: list[dict]) -> None:
    sem = asyncio.Semaphore(get_settings().llm_max_concurrency)

    async def one(index: int, q: dict) -> None:
        async with sem:
            try:
                result = await _answer_question(q)
            except llm.LLMNotConfigured as exc:
                raise
            except Exception as exc:  # keep the other questions alive
                result = {
                    "status": "error", "confidence": 0, "citations": [],
                    "gap": "", "reasoning": "", "reviewer_note": "",
                    "contradictions": [], "discarded_quotes": [],
                    "error": f"{type(exc).__name__}: {exc}",
                }
            run.items[index]["result"] = result
            run.completed += 1
            STORE.publish(run.id, {"type": "item", "item": run.items[index],
                                   "completed": run.completed, "total": run.total})
            if run.completed % 5 == 0:
                STORE.save(run)

    await asyncio.gather(*(one(i, q) for i, q in enumerate(questions)))


# --------------------------------------------------------------------------
# Guide run
# --------------------------------------------------------------------------

async def _run_guide(run: Run, pdf_path: Path) -> None:
    STORE.publish(run.id, {"type": "phase", "phase": "extracting",
                           "message": "Reading the guide and pulling out obligations"})
    title, obligations = await guide_mod.extract_obligations(pdf_path)
    run.title = title if title and len(title) > 8 else run.title
    run.total = len(obligations)
    run.items = [
        {**ob.to_dict(), "result": None,
         "review": {"state": "open", "note": "", "updated_at": ""}}
        for ob in obligations
    ]
    STORE.save(run)
    STORE.publish(run.id, {
        "type": "extracted", "total": run.total,
        "items": run.items,
        "message": f"Found {run.total} obligations — now checking each against the P&Ps",
    })

    sem = asyncio.Semaphore(get_settings().llm_max_concurrency)

    async def one(index: int, ob: guide_mod.Obligation) -> None:
        async with sem:
            try:
                result = await guide_mod.assess_coverage(ob)
            except llm.LLMNotConfigured:
                raise
            except Exception as exc:
                result = {"coverage_status": "error", "status": "error",
                          "confidence": 0, "citations": [], "gap": "",
                          "reasoning": "", "reviewer_note": "",
                          "contradictions": [], "discarded_quotes": [],
                          "error": f"{type(exc).__name__}: {exc}"}
            run.items[index]["result"] = result
            run.completed += 1
            STORE.publish(run.id, {"type": "item", "item": run.items[index],
                                   "completed": run.completed, "total": run.total})
            if run.completed % 5 == 0:
                STORE.save(run)

    await asyncio.gather(*(one(i, ob) for i, ob in enumerate(obligations)))


# --------------------------------------------------------------------------
# Entry points
# --------------------------------------------------------------------------

async def _drive(run: Run, coro) -> None:
    try:
        await coro
        run.status = "done"
    except asyncio.CancelledError:
        run.status = "error"
        run.error = "Cancelled."
        raise
    except llm.LLMNotConfigured as exc:
        run.status = "error"
        run.error = str(exc)
    except Exception as exc:
        run.status = "error"
        run.error = f"{type(exc).__name__}: {exc}"
    finally:
        STORE.save(run)
        STORE.publish(run.id, {"type": "done", "run": run.summary()})


async def start_questionnaire_run(
    pdf_path: Path, source_name: str, limit: int | None = None
) -> Run:
    """Parse the form, then schedule the answering work on the event loop.

    Async because `asyncio.create_task` below needs a running loop — a sync
    handler would run in FastAPI's threadpool where there is none. The PDF parse
    is pushed to a thread so it does not block the loop.
    """
    title, questions = await asyncio.to_thread(parse_questions, pdf_path)
    items = [
        {"number": q.number, "text": q.text, "reference": q.reference,
         "form_page": q.form_page}
        for q in questions
    ]
    if limit:
        items = items[:limit]

    run = Run(
        id=f"q_{uuid.uuid4().hex[:10]}", kind="questionnaire",
        title=title, source_name=source_name, total=len(items),
        items=[_blank_item(q) for q in items],
    )
    STORE._runs[run.id] = run
    STORE.save(run)
    task = asyncio.create_task(_drive(run, _run_questionnaire(run, items)))
    STORE.register_task(run.id, task)
    return run


def start_guide_run(pdf_path: Path, source_name: str) -> Run:
    run = Run(
        id=f"g_{uuid.uuid4().hex[:10]}", kind="guide",
        title=source_name, source_name=source_name,
    )
    STORE._runs[run.id] = run
    STORE.save(run)
    task = asyncio.create_task(_drive(run, _run_guide(run, pdf_path)))
    STORE.register_task(run.id, task)
    return run


# --------------------------------------------------------------------------
# Review actions
# --------------------------------------------------------------------------

def set_review(
    run_id: str, key: Any, state: str, note: str = "",
    citation_override: dict | None = None,
) -> dict | None:
    """Record an accept / flag / edit decision against one item."""
    run = STORE.load(run_id)
    if not run:
        return None
    for item in run.items:
        ident = item.get("number", item.get("id"))
        if str(ident) != str(key):
            continue
        item["review"] = {
            "state": state, "note": note, "updated_at": _now(),
            **({"citation_override": citation_override} if citation_override else {}),
        }
        STORE.save(run)
        STORE.publish(run_id, {"type": "review", "item": item})
        return item
    return None
