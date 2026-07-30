"""FastAPI app: API routes plus the built React bundle."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import shutil
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import runs as runs_mod
from .config import get_settings
from .db import init_db, session
from .questionnaire import parse_questions
from .retrieval import keyword_search, page_context

app = FastAPI(title="Readily Module", version="1.0")

# The frontend dev server runs on a different port; the built bundle is served
# same-origin so this only matters in development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SETTINGS = get_settings()
FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


@app.on_event("startup")
def _startup() -> None:
    init_db()


# --------------------------------------------------------------------------
# Meta
# --------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict:
    with session() as conn:
        docs = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        version = conn.execute(
            "SELECT value FROM meta WHERE key = 'corpus_version'"
        ).fetchone()
    return {
        "ok": True,
        "llm_configured": SETTINGS.llm_enabled,
        "models": {"reasoning": SETTINGS.model_reasoning, "fast": SETTINGS.model_fast},
        "corpus": {
            "documents": docs,
            "chunks": chunks,
            "version": version[0] if version else None,
        },
    }


@app.get("/api/samples")
def samples() -> dict:
    """Bundled source documents, so the app is usable without uploading."""
    folder = SETTINGS.data_dir / "samples"
    out = []
    for pdf in sorted(folder.glob("*.pdf")):
        kind = "questionnaire" if "questionnaire" in pdf.stem.lower() else "guide"
        out.append({
            "name": pdf.name,
            "kind": kind,
            "size_kb": round(pdf.stat().st_size / 1024),
        })
    return {"samples": out}


# --------------------------------------------------------------------------
# Corpus
# --------------------------------------------------------------------------

@app.get("/api/corpus")
def corpus(program: str | None = None, q: str | None = None, limit: int = 400) -> dict:
    clauses, params = [], []
    if program:
        clauses.append("program = ?")
        params.append(program)
    if q:
        clauses.append("(title LIKE ? OR policy_code LIKE ? OR department LIKE ?)")
        params += [f"%{q}%"] * 3
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    with session() as conn:
        rows = conn.execute(
            f"""SELECT id, policy_code, title, program, department, section,
                       applicable_to, effective_date, revised_date, n_pages
                FROM documents {where}
                ORDER BY policy_code LIMIT ?""",
            (*params, limit),
        ).fetchall()
        programs = conn.execute(
            "SELECT program, COUNT(*) n FROM documents GROUP BY program ORDER BY program"
        ).fetchall()
    return {
        "documents": [dict(r) for r in rows],
        "programs": [dict(r) for r in programs],
    }


@app.get("/api/search")
def search(q: str, limit: int = 25) -> dict:
    """Raw keyword search — shows what retrieval returns before any model runs."""
    if not q.strip():
        return {"results": []}
    passages = keyword_search(q, limit=limit)
    return {
        "results": [
            {
                "cite": p.cite(), "policy_code": p.policy_code, "title": p.title,
                "program": p.program, "doc_id": p.doc_id, "chunk_id": p.chunk_id,
                "page_start": p.page_start, "page_end": p.page_end,
                "heading": p.heading, "score": p.score, "excerpt": p.text[:700],
            }
            for p in passages
        ]
    }


@app.get("/api/document/{doc_id}/context")
def document_context(doc_id: int, page_start: int, page_end: int, pad: int = 1) -> dict:
    with session() as conn:
        doc = conn.execute(
            """SELECT policy_code, title, program, department, applicable_to,
                      effective_date, revised_date, n_pages
               FROM documents WHERE id = ?""",
            (doc_id,),
        ).fetchone()
    if not doc:
        raise HTTPException(404, "document not found")
    return {
        "document": dict(doc),
        "pages": page_context(doc_id, page_start, page_end, pad),
    }


# --------------------------------------------------------------------------
# Runs
# --------------------------------------------------------------------------

class StartRun(BaseModel):
    sample: str | None = None
    limit: int | None = None


def _resolve_source(sample: str | None) -> Path:
    if not sample:
        raise HTTPException(400, "provide a sample name or upload a file")
    path = (SETTINGS.data_dir / "samples" / sample).resolve()
    samples_dir = (SETTINGS.data_dir / "samples").resolve()
    # Reject traversal: the resolved path must stay inside the samples folder.
    if not path.is_file() or samples_dir not in path.parents:
        raise HTTPException(404, f"sample not found: {sample}")
    return path


# These must be `async def`. A sync handler runs in FastAPI's threadpool, where
# there is no running event loop for the background task to be scheduled on.
@app.post("/api/runs/questionnaire")
async def start_questionnaire(body: StartRun) -> dict:
    path = _resolve_source(body.sample)
    run = await runs_mod.start_questionnaire_run(path, path.name, body.limit)
    return run.to_dict()


@app.post("/api/runs/guide")
async def start_guide(body: StartRun) -> dict:
    path = _resolve_source(body.sample)
    run = runs_mod.start_guide_run(path, path.name, body.limit)
    return run.to_dict()


@app.post("/api/upload/{kind}")
async def upload(kind: str, file: UploadFile, limit: int | None = None) -> dict:
    if kind not in ("questionnaire", "guide"):
        raise HTTPException(400, "kind must be 'questionnaire' or 'guide'")
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "only PDF files are supported")

    SETTINGS.uploads_dir.mkdir(parents=True, exist_ok=True)
    # Keep only the basename so an uploaded name cannot escape the directory.
    target = SETTINGS.uploads_dir / Path(file.filename).name
    with target.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)

    if kind == "questionnaire":
        run = await runs_mod.start_questionnaire_run(target, target.name, limit)
    else:
        run = runs_mod.start_guide_run(target, target.name, limit)
    return run.to_dict()


@app.get("/api/runs")
def list_runs() -> dict:
    return {"runs": runs_mod.STORE.list_runs()}


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict:
    run = runs_mod.STORE.load(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    return run.to_dict()


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: str) -> dict:
    runs_mod.STORE.delete(run_id)
    return {"ok": True}


@app.post("/api/runs/{run_id}/cancel")
def cancel_run(run_id: str) -> dict:
    return {"cancelled": runs_mod.STORE.cancel(run_id)}


@app.get("/api/runs/{run_id}/stream")
async def stream_run(run_id: str) -> StreamingResponse:
    """Server-sent events so the table fills in as answers land."""
    run = runs_mod.STORE.load(run_id)
    if not run:
        raise HTTPException(404, "run not found")

    async def events():
        queue = runs_mod.STORE.subscribe(run_id)
        try:
            # Send current state first so a late subscriber is not behind.
            yield f"data: {json.dumps({'type': 'snapshot', 'run': run.to_dict()})}\n\n"
            if run.status != "running":
                yield f"data: {json.dumps({'type': 'done', 'run': run.summary()})}\n\n"
                return
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"   # hold the connection open
                    continue
                yield f"data: {json.dumps(event)}\n\n"
                if event.get("type") == "done":
                    return
        finally:
            runs_mod.STORE.unsubscribe(run_id, queue)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "Connection": "keep-alive"},
    )


class ReviewBody(BaseModel):
    state: str          # accepted | flagged | edited | open
    note: str = ""
    citation_override: dict | None = None


@app.post("/api/runs/{run_id}/items/{key}/review")
def review_item(run_id: str, key: str, body: ReviewBody) -> dict:
    if body.state not in ("accepted", "flagged", "edited", "open"):
        raise HTTPException(400, "invalid review state")
    item = runs_mod.set_review(
        run_id, key, body.state, body.note, body.citation_override
    )
    if item is None:
        raise HTTPException(404, "run or item not found")
    return item


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

@app.get("/api/runs/{run_id}/export.csv")
def export_csv(run_id: str) -> StreamingResponse:
    run = runs_mod.STORE.load(run_id)
    if not run:
        raise HTTPException(404, "run not found")

    buf = io.StringIO()
    writer = csv.writer(buf)

    if run.kind == "questionnaire":
        writer.writerow([
            "#", "Question", "APL reference", "Answer", "Confidence",
            "Policy", "Pages", "Citation (verbatim)", "Quote verified",
            "Gap", "Reviewer note", "Contradictions", "Review state", "Analyst note",
        ])
        for item in run.items:
            r = item.get("result") or {}
            cites = r.get("citations") or []
            first = cites[0] if cites else {}
            answer = {"supported": "Yes", "partial": "Partial",
                      "not_found": "No"}.get(r.get("status"), r.get("status") or "")
            writer.writerow([
                item["number"], item["question"], item["reference"], answer,
                r.get("confidence", ""),
                first.get("policy_code", ""),
                first.get("cite", "").replace(first.get("policy_code", ""), "").strip(),
                " / ".join(c.get("quote", "") for c in cites),
                "yes" if first.get("quote_check", {}).get("verified") else "",
                r.get("gap", ""), r.get("reviewer_note", ""),
                "; ".join(
                    f"{c.get('kind')} @ {c.get('cite')}"
                    for c in (r.get("contradictions") or [])
                ),
                item.get("review", {}).get("state", "open"),
                item.get("review", {}).get("note", ""),
            ])
    else:
        writer.writerow([
            "ID", "Obligation", "Actor", "Strength", "Deadline", "Topic",
            "Guide page", "Guide quote", "Coverage", "Confidence",
            "Covering policy", "Citation (verbatim)", "Gap",
            "Suggested language", "Review state", "Analyst note",
        ])
        for item in run.items:
            r = item.get("result") or {}
            cites = r.get("citations") or []
            first = cites[0] if cites else {}
            writer.writerow([
                item.get("id", ""), item.get("obligation", ""), item.get("actor", ""),
                item.get("strength", ""), item.get("deadline", ""),
                item.get("topic", ""), item.get("page", ""), item.get("quote", ""),
                r.get("coverage_status", ""), r.get("confidence", ""),
                first.get("cite", ""),
                " / ".join(c.get("quote", "") for c in cites),
                r.get("gap", ""), r.get("suggested_language", ""),
                item.get("review", {}).get("state", "open"),
                item.get("review", {}).get("note", ""),
            ])

    buf.seek(0)
    stem = run.source_name.rsplit(".", 1)[0].replace(" ", "_")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{stem}_{run.id}.csv"'},
    )


@app.get("/api/runs/{run_id}/export.json")
def export_json(run_id: str) -> dict:
    run = runs_mod.STORE.load(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    return run.to_dict()


@app.get("/api/questionnaire/preview")
def preview_questionnaire(sample: str) -> dict:
    """Parse a form without running it, so the count is visible up front."""
    path = _resolve_source(sample)
    title, questions = parse_questions(path)
    return {
        "title": title,
        "count": len(questions),
        "questions": [
            {"number": q.number, "text": q.text, "reference": q.reference,
             "form_page": q.form_page}
            for q in questions
        ],
    }


# --------------------------------------------------------------------------
# Static frontend (mounted last so /api/* wins)
# --------------------------------------------------------------------------

if FRONTEND_DIST.is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIST / "assets"),
        name="assets",
    )

    @app.get("/{full_path:path}")
    def spa(full_path: str) -> FileResponse:
        candidate = (FRONTEND_DIST / full_path).resolve()
        if (
            full_path
            and candidate.is_file()
            and FRONTEND_DIST.resolve() in candidate.parents
        ):
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
