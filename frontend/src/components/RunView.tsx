import { useEffect, useMemo, useRef, useState } from "react";
import {
  ANSWER_LABEL,
  COVERAGE_LABEL,
  STATUS_LABEL,
  api,
  streamRun,
} from "../lib/api";
import type { Item, ReviewState, Run } from "../lib/api";
import { Chip, Confidence, Empty, Spinner, StatusChip } from "./bits";
import { EvidencePanel } from "./EvidencePanel";

type Filter = "all" | "supported" | "partial" | "not_found" | "error" | "flagged" | "conflicts";

function itemKey(item: Item, kind: string) {
  return kind === "guide" ? item.id! : String(item.number);
}

export function RunView({
  runId,
  onExit,
}: {
  runId: string;
  onExit: () => void;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [phase, setPhase] = useState("");
  const runRef = useRef<Run | null>(null);

  // Keep a ref alongside state so SSE handlers merge into the latest snapshot
  // without needing the effect to re-subscribe on every update.
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    let live = true;
    setRun(null);
    setError("");
    api
      .run(runId)
      .then((r) => {
        if (!live) return;
        setRun(r);
        runRef.current = r;
      })
      .catch((e) => live && setError(String(e.message ?? e)));

    const stop = streamRun(runId, (event) => {
      const current = runRef.current;
      if (event.type === "snapshot") {
        setRun(event.run);
        runRef.current = event.run;
        return;
      }
      if (!current) return;

      if (event.type === "phase") {
        setPhase(event.message || "");
      } else if (event.type === "extracted") {
        const next = {
          ...current,
          total: event.total,
          items: event.items,
        };
        setPhase(event.message || "");
        setRun(next);
        runRef.current = next;
      } else if (event.type === "item" || event.type === "review") {
        const kind = current.kind;
        const key = itemKey(event.item, kind);
        const items = current.items.map((it) =>
          itemKey(it, kind) === key ? event.item : it,
        );
        const next = {
          ...current,
          items,
          completed: event.completed ?? current.completed,
          total: event.total ?? current.total,
        };
        setRun(next);
        runRef.current = next;
      } else if (event.type === "done") {
        const next = { ...current, ...event.run };
        setPhase("");
        setRun(next);
        runRef.current = next;
        // Refetch so counts and review tallies come from the server.
        api.run(runId).then((r) => {
          setRun(r);
          runRef.current = r;
        });
      }
    });
    return () => {
      live = false;
      stop();
    };
  }, [runId]);

  const isGuide = run?.kind === "guide";

  const filtered = useMemo(() => {
    if (!run) return [];
    return run.items.filter((it) => {
      if (filter === "all") return true;
      if (filter === "flagged") return it.review?.state === "flagged";
      if (filter === "conflicts") return (it.result?.contradictions?.length ?? 0) > 0;
      const s = isGuide
        ? { covered: "supported", partial: "partial", gap: "not_found", error: "error" }[
            it.result?.coverage_status ?? "error"
          ]
        : it.result?.status;
      return s === filter;
    });
  }, [run, filter, isGuide]);

  const selectedItem = useMemo(
    () => run?.items.find((it) => itemKey(it, run.kind) === selected) ?? null,
    [run, selected],
  );

  async function handleReview(state: ReviewState, note: string) {
    if (!run || !selectedItem) return;
    const key = itemKey(selectedItem, run.kind);
    const updated = await api.review(run.id, key, { state, note });
    const items = run.items.map((it) => (itemKey(it, run.kind) === key ? updated : it));
    const next = { ...run, items };
    setRun(next);
    runRef.current = next;
  }

  if (error) {
    return (
      <Empty title="Could not load this run">
        <p>{error}</p>
        <button className="btn secondary" onClick={onExit}>
          Back
        </button>
      </Empty>
    );
  }
  if (!run) {
    return (
      <div className="card card-pad">
        <Spinner label="Loading run…" />
      </div>
    );
  }

  const answered = run.items.filter((i) => i.result).length;
  const pct = run.total ? Math.round((answered / run.total) * 100) : 0;

  const counts = { supported: 0, partial: 0, not_found: 0, error: 0 };
  let conflicts = 0;
  let flagged = 0;
  let accepted = 0;
  for (const it of run.items) {
    const s = isGuide
      ? { covered: "supported", partial: "partial", gap: "not_found", error: "error" }[
          it.result?.coverage_status ?? "error"
        ]
      : it.result?.status;
    if (it.result && s) counts[s as keyof typeof counts]++;
    if ((it.result?.contradictions?.length ?? 0) > 0) conflicts++;
    if (it.review?.state === "flagged") flagged++;
    if (it.review?.state === "accepted") accepted++;
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* ------------------------------------------------ run header */}
      <div className="stack" style={{ gap: 10 }}>
        <div className="spread">
          <div className="stack" style={{ gap: 4 }}>
            <div className="label">
              {isGuide ? "Policy Guide review" : "Submission Review Form"}
            </div>
            <h1 style={{ fontSize: 26, maxWidth: 900 }}>{run.title}</h1>
            <div className="tiny muted">
              {run.source_name} · started {run.created_at.replace("T", " ").slice(0, 16)}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <a className="btn secondary small" href={`/api/runs/${run.id}/export.csv`}>
              Export CSV
            </a>
            <a
              className="btn ghost small"
              href={`/api/runs/${run.id}/export.json`}
              target="_blank"
              rel="noreferrer"
            >
              JSON
            </a>
            {run.status === "running" && (
              <button
                className="btn ghost small"
                onClick={() => api.cancelRun(run.id)}
              >
                Stop
              </button>
            )}
            <button className="btn ghost small" onClick={onExit}>
              All runs
            </button>
          </div>
        </div>

        {run.status === "running" && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="progress">
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="row" style={{ gap: 10 }}>
              <Spinner />
              <span className="small muted">
                {phase ||
                  `${answered} of ${run.total} ${isGuide ? "obligations" : "questions"} checked`}
              </span>
            </div>
          </div>
        )}
        {run.status === "error" && run.error && (
          <div className="banner alert">{run.error}</div>
        )}
      </div>

      {/* ------------------------------------------------ tallies */}
      <div className="stats">
        <div className="stat">
          <div className="v">{run.total}</div>
          <div className="k">{isGuide ? "Obligations" : "Questions"}</div>
        </div>
        <div className="stat">
          <div className="v" style={{ color: "var(--meadow-600)" }}>
            {counts.supported}
          </div>
          <div className="k">{isGuide ? "Covered" : "Supported"}</div>
        </div>
        <div className="stat">
          <div className="v" style={{ color: "var(--pollen-500)" }}>
            {counts.partial}
          </div>
          <div className="k">Partial</div>
        </div>
        <div className="stat">
          <div className="v">{counts.not_found}</div>
          <div className="k">{isGuide ? "Gaps" : "Not found"}</div>
        </div>
        <div className="stat">
          <div className="v">{conflicts}</div>
          <div className="k">Conflicts</div>
        </div>
        <div className="stat">
          <div className="v">{accepted}</div>
          <div className="k">Accepted</div>
        </div>
        <div className="stat">
          <div className="v">{flagged}</div>
          <div className="k">Flagged</div>
        </div>
      </div>

      {/* ------------------------------------------------ filters */}
      <div className="row wrap" style={{ gap: 6 }}>
        {(
          [
            ["all", `All ${run.total}`],
            ["supported", `${isGuide ? "Covered" : "Supported"} ${counts.supported}`],
            ["partial", `Partial ${counts.partial}`],
            ["not_found", `${isGuide ? "Gaps" : "Not found"} ${counts.not_found}`],
            ...(counts.error ? ([["error", `Errors ${counts.error}`]] as const) : []),
            ...(conflicts ? ([["conflicts", `Conflicts ${conflicts}`]] as const) : []),
            ...(flagged ? ([["flagged", `Flagged ${flagged}`]] as const) : []),
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className={`btn ${filter === key ? "" : "ghost"} small`}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ------------------------------------------------ table + panel */}
      <div className={selectedItem ? "split card" : "card"}>
        <div style={{ overflowX: "auto" }}>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>{isGuide ? "Obligation" : "Question"}</th>
                <th style={{ width: 118 }}>{isGuide ? "Coverage" : "Answer"}</th>
                <th style={{ width: 150 }}>Citation</th>
                <th style={{ width: 92 }}>Conf.</th>
                <th style={{ width: 96 }}>Review</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => {
                const key = itemKey(it, run.kind);
                const r = it.result;
                const s = isGuide ? r?.coverage_status : r?.status;
                const label = isGuide
                  ? COVERAGE_LABEL[r?.coverage_status ?? "error"]
                  : STATUS_LABEL[r?.status ?? "error"];
                const first = r?.citations?.[0];
                return (
                  <tr
                    key={key}
                    aria-selected={selected === key}
                    onClick={() => setSelected(selected === key ? null : key)}
                  >
                    <td className="num">{isGuide ? it.id?.replace("ob", "") : it.number}</td>
                    <td>
                      <div style={{ maxWidth: 620 }}>
                        {isGuide ? it.obligation : it.question}
                      </div>
                      <div className="row wrap" style={{ gap: 5, marginTop: 5 }}>
                        {isGuide && it.strength === "must" && (
                          <Chip tone="alert">must</Chip>
                        )}
                        {isGuide && it.page ? (
                          <span className="tiny muted mono">guide p. {it.page}</span>
                        ) : null}
                        {(r?.contradictions?.length ?? 0) > 0 && (
                          <Chip tone="warn" title="Conflicting language found elsewhere in the same policy">
                            ⚠ {r!.contradictions.length} conflict
                            {r!.contradictions.length > 1 ? "s" : ""}
                          </Chip>
                        )}
                        {(r?.discarded_quotes?.length ?? 0) > 0 && (
                          <Chip tone="plain" title="A proposed quote was withheld because it could not be found in the source">
                            {r!.discarded_quotes.length} withheld
                          </Chip>
                        )}
                      </div>
                    </td>
                    <td>
                      {r ? (
                        <div className="row" style={{ gap: 6 }}>
                          {!isGuide && r.status !== "error" && (
                            <strong className="small">{ANSWER_LABEL[r.status]}</strong>
                          )}
                          <StatusChip status={s} label={label} />
                        </div>
                      ) : (
                        <span className="row" style={{ gap: 6 }}>
                          <span className="spinner" />
                        </span>
                      )}
                    </td>
                    <td>
                      {first ? (
                        <div className="stack" style={{ gap: 3 }}>
                          <span className="mono tiny">{first.cite}</span>
                          {!first.quote_check.verified && (
                            <Chip tone="alert">unverified</Chip>
                          )}
                        </div>
                      ) : (
                        <span className="tiny muted">—</span>
                      )}
                    </td>
                    <td>{r ? <Confidence value={r.confidence} /> : null}</td>
                    <td>
                      {it.review?.state !== "open" ? (
                        <Chip
                          tone={
                            it.review.state === "accepted"
                              ? "ok"
                              : it.review.state === "flagged"
                                ? "warn"
                                : "info"
                          }
                        >
                          {it.review.state}
                        </Chip>
                      ) : (
                        <span className="tiny muted">open</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="empty">
              <p className="muted">Nothing matches this filter.</p>
            </div>
          )}
        </div>

        {selectedItem && (
          <EvidencePanel
            run={run}
            item={selectedItem}
            onClose={() => setSelected(null)}
            onReview={handleReview}
          />
        )}
      </div>

      <div className="tiny muted" style={{ maxWidth: 760 }}>
        Every quote shown has been checked character-for-character against the source
        policy document. Verdicts on borderline questions are judgements, not facts —
        the confidence score and the “check this yourself” note are there to tell you
        where to spend your attention.
      </div>
    </div>
  );
}
