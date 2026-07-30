import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Health, RunSummary } from "../lib/api";
import { Chip, Spinner } from "./bits";

/** Start screen for one module: pick the bundled sample or upload a PDF. */
export function Launcher({
  kind,
  health,
  onStarted,
  onOpen,
}: {
  kind: "questionnaire" | "guide";
  health: Health | null;
  onStarted: (runId: string) => void;
  onOpen: (runId: string) => void;
}) {
  const [samples, setSamples] = useState<{ name: string; kind: string; size_kb: number }[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [preview, setPreview] = useState<{ count: number; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState<number | "">("");
  const fileRef = useRef<HTMLInputElement>(null);

  const isQ = kind === "questionnaire";

  useEffect(() => {
    api.samples().then((r) => {
      const mine = r.samples.filter((s) => s.kind === kind);
      setSamples(mine);
      if (isQ && mine[0]) {
        api.previewQuestionnaire(mine[0].name).then(setPreview).catch(() => {});
      }
    });
    api.runs().then((r) => setRuns(r.runs.filter((x) => x.kind === kind)));
  }, [kind, isQ]);

  async function start(sample: string) {
    setBusy(true);
    setError("");
    try {
      const run = isQ
        ? await api.startQuestionnaire(sample, limit === "" ? undefined : Number(limit))
        : await api.startGuide(sample);
      onStarted(run.id);
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      const run = await api.upload(kind, file, limit === "" ? undefined : Number(limit));
      onStarted(run.id);
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 22, maxWidth: 900 }}>
      <div className="stack" style={{ gap: 8 }}>
        <div className="label">{isQ ? "Module 1" : "Module 2"}</div>
        <h1>
          {isQ
            ? "Answer a Submission Review Form"
            : "Pull the obligations out of a Policy Guide"}
        </h1>
        <p className="muted" style={{ maxWidth: 660 }}>
          {isQ ? (
            <>
              Every question gets an answer, a quote from your own P&amp;Ps, and a page
              number — each quote checked character-for-character against the source
              document before you see it. Nothing is submitted for you.
            </>
          ) : (
            <>
              The guide is read end to end and every concrete obligation is pulled out
              with the sentence that creates it and its page. Each one is then checked
              against your P&amp;P library, so you see what is already covered and what
              needs writing before a questionnaire ever arrives.
            </>
          )}
        </p>
      </div>

      {health && !health.llm_configured && (
        <div className="banner alert">
          <strong>No API key configured.</strong> Set <code>ANTHROPIC_API_KEY</code> in{" "}
          <code>.env</code> and restart the server. The corpus browser works without it.
        </div>
      )}

      {error && <div className="banner alert">{error}</div>}

      <div className="card">
        <div className="card-pad stack" style={{ gap: 14 }}>
          <div className="label">Start from a bundled document</div>
          {samples.length === 0 ? (
            <Spinner label="Looking for samples…" />
          ) : (
            samples.map((s) => (
              <div key={s.name} className="spread">
                <div className="stack" style={{ gap: 3 }}>
                  <strong className="small">{s.name}</strong>
                  <span className="tiny muted">
                    {s.size_kb} KB
                    {isQ && preview ? ` · ${preview.count} questions parsed` : ""}
                  </span>
                </div>
                <button
                  className="btn"
                  disabled={busy || (health ? !health.llm_configured : false)}
                  onClick={() => start(s.name)}
                >
                  {busy ? "Starting…" : isQ ? "Answer all questions" : "Extract obligations"}
                </button>
              </div>
            ))
          )}

          {isQ && (
            <div className="hairline row wrap" style={{ paddingTop: 12, gap: 10 }}>
              <span className="tiny muted">
                A full 64-question pass takes a few minutes and costs a few dollars in
                model calls. To try it quickly, cap the number of questions:
              </span>
              <input
                className="input"
                style={{ width: 92 }}
                type="number"
                min={1}
                max={200}
                placeholder="all"
                value={limit}
                onChange={(e) =>
                  setLimit(e.target.value === "" ? "" : Number(e.target.value))
                }
              />
            </div>
          )}
        </div>

        <div className="card-pad hairline spread">
          <div className="stack" style={{ gap: 3 }}>
            <strong className="small">Or upload your own PDF</strong>
            <span className="tiny muted">
              {isQ
                ? "Any DHCS Submission Review Form."
                : "Any DHCS Policy Guide or All Plan Letter."}
            </span>
          </div>
          <div>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
              }}
            />
            <button
              className="btn secondary"
              disabled={busy || (health ? !health.llm_configured : false)}
              onClick={() => fileRef.current?.click()}
            >
              Choose PDF
            </button>
          </div>
        </div>
      </div>

      {runs.length > 0 && (
        <div className="card">
          <div className="card-pad" style={{ paddingBottom: 8 }}>
            <div className="label">Earlier runs</div>
          </div>
          <table className="grid">
            <tbody>
              {runs.slice(0, 8).map((r) => (
                <tr key={r.id} onClick={() => onOpen(r.id)}>
                  <td>
                    <div className="small truncate" style={{ maxWidth: 520 }}>
                      {r.title}
                    </div>
                    <div className="tiny muted">
                      {r.created_at.replace("T", " ").slice(0, 16)} · {r.source_name}
                    </div>
                  </td>
                  <td style={{ width: 150 }}>
                    <Chip
                      tone={
                        r.status === "done" ? "ok" : r.status === "error" ? "alert" : "info"
                      }
                    >
                      {r.status === "running"
                        ? `${r.completed}/${r.total}`
                        : r.status}
                    </Chip>
                  </td>
                  <td style={{ width: 60 }}>
                    <button
                      className="btn ghost small"
                      onClick={(e) => {
                        e.stopPropagation();
                        api.deleteRun(r.id).then(() =>
                          setRuns((prev) => prev.filter((x) => x.id !== r.id)),
                        );
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
