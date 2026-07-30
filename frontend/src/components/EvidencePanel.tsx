import { useEffect, useState } from "react";
import { api, ANSWER_LABEL, COVERAGE_LABEL, STATUS_LABEL } from "../lib/api";
import type { Citation, Item, ReviewState, Run } from "../lib/api";
import { Chip, Confidence, Field, HighlightedText, StatusChip, VerifiedBadge } from "./bits";

const KIND_LABEL: Record<string, string> = {
  contradiction: "Contradiction",
  exception: "Exception",
  narrower_scope: "Narrower scope",
  different_timeframe: "Different timeframe",
};

/** Loads the pages around a citation so the quote can be read in situ. */
function SourceContext({ citation }: { citation: Citation }) {
  const [pages, setPages] = useState<{ page: number; text: string }[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setPages(null);
    setError("");
    api
      .context(citation.doc_id, citation.page_start, citation.page_end)
      .then((r) => live && setPages(r.pages))
      .catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [citation.doc_id, citation.page_start, citation.page_end]);

  if (error) return <div className="tiny muted">Could not load page text: {error}</div>;
  if (!pages) return <div className="skeleton" style={{ height: 60 }} />;

  return (
    <div className="page-context">
      {pages.map((p) => {
        // Highlight the quote wherever it appears on the page. The offsets from
        // the checker are relative to the chunk, not the page, so locate it here.
        const at = p.text.indexOf(citation.quote_check.matched_text || citation.quote);
        return (
          <div key={p.page} style={{ marginBottom: 14 }}>
            <div className="label" style={{ marginBottom: 4 }}>
              Page {p.page}
            </div>
            {at >= 0 ? (
              <HighlightedText
                text={p.text}
                start={at}
                end={at + (citation.quote_check.matched_text || citation.quote).length}
              />
            ) : (
              p.text
            )}
          </div>
        );
      })}
    </div>
  );
}

function CitationBlock({ citation }: { citation: Citation }) {
  const [open, setOpen] = useState(false);
  const qc = citation.quote_check;
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="spread" style={{ marginBottom: 6 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <strong className="mono small">{citation.cite}</strong>
          <VerifiedBadge
            verified={qc.verified}
            method={qc.method}
            similarity={qc.similarity}
          />
        </div>
        <button className="btn ghost small" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide page" : "Read in context"}
        </button>
      </div>
      <div className="tiny muted" style={{ marginBottom: 6 }}>
        {citation.title}
      </div>
      <div className={`quote ${qc.verified ? "" : "unverified"}`}>{citation.quote}</div>
      {citation.covers && (
        <div className="tiny muted" style={{ marginTop: 5 }}>
          Establishes: {citation.covers}
        </div>
      )}
      {open && (
        <div style={{ marginTop: 8 }}>
          <SourceContext citation={citation} />
        </div>
      )}
    </div>
  );
}

export function EvidencePanel({
  run,
  item,
  onClose,
  onReview,
}: {
  run: Run;
  item: Item;
  onClose: () => void;
  onReview: (state: ReviewState, note: string) => void;
}) {
  const [note, setNote] = useState(item.review?.note ?? "");
  const [saving, setSaving] = useState<ReviewState | null>(null);

  useEffect(() => {
    setNote(item.review?.note ?? "");
  }, [item.number, item.id, item.review?.note]);

  const result = item.result;
  const isGuide = run.kind === "guide";

  async function act(state: ReviewState) {
    setSaving(state);
    try {
      await onReview(state, note);
    } finally {
      setSaving(null);
    }
  }

  const status = isGuide ? result?.coverage_status : result?.status;
  const statusLabel = isGuide
    ? COVERAGE_LABEL[result?.coverage_status ?? "error"]
    : STATUS_LABEL[result?.status ?? "error"];

  return (
    <aside className="detail">
      <div
        className="card-pad spread"
        style={{ borderBottom: "1px solid var(--line)", position: "sticky", top: 0, background: "var(--cloud)", zIndex: 2 }}
      >
        <div className="label">
          {isGuide ? `Obligation ${item.id}` : `Question ${item.number}`}
        </div>
        <button className="btn ghost small" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="card-pad stack" style={{ gap: 18 }}>
        {/* -------- the ask -------- */}
        <div className="stack" style={{ gap: 8 }}>
          <div style={{ fontSize: 14.5, lineHeight: 1.5 }}>
            {isGuide ? item.obligation : item.question}
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {item.reference && <Chip tone="plain">{item.reference}</Chip>}
            {isGuide && item.strength && (
              <Chip tone={item.strength === "must" ? "alert" : "plain"}>
                {item.strength}
              </Chip>
            )}
            {isGuide && item.page ? <Chip tone="plain">Guide p. {item.page}</Chip> : null}
            {item.deadline && <Chip tone="info">{item.deadline}</Chip>}
            {item.topic && <Chip tone="plain">{item.topic}</Chip>}
          </div>
        </div>

        {/* The guide's own words that created this obligation. */}
        {isGuide && item.quote && (
          <Field label="Source text in the guide">
            <div className={`quote ${item.quote_verified ? "" : "unverified"}`}>
              {item.quote}
            </div>
            {!item.quote_verified && (
              <div className="tiny muted" style={{ marginTop: 4 }}>
                Could not confirm this sentence on the page it was attributed to.
              </div>
            )}
          </Field>
        )}

        {!result && (
          <div className="banner">
            Still working through this one.
          </div>
        )}

        {result?.status === "error" && (
          <div className="banner alert">
            <strong>This question was not answered.</strong>
            <div style={{ marginTop: 4 }}>
              {result.error || result.reasoning}
            </div>
            <div className="tiny" style={{ marginTop: 6 }}>
              Treat this as unanswered, not as a compliance gap — re-run it.
            </div>
          </div>
        )}

        {result && result.status !== "error" && (
          <>
            <div className="row wrap" style={{ gap: 14 }}>
              <div className="stack" style={{ gap: 5 }}>
                <div className="label">
                  {isGuide ? "Coverage" : "Answer"}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {!isGuide && (
                    <strong style={{ fontSize: 15 }}>
                      {ANSWER_LABEL[result.status]}
                    </strong>
                  )}
                  <StatusChip status={status} label={statusLabel} />
                </div>
              </div>
              <div className="stack" style={{ gap: 5 }}>
                <div className="label">Confidence</div>
                <Confidence value={result.confidence} />
              </div>
            </div>

            {result.citations.length > 0 && (
              <Field label={`Evidence (${result.citations.length})`}>
                <div style={{ marginTop: 6 }}>
                  {result.citations.map((c, i) => (
                    <CitationBlock key={i} citation={c} />
                  ))}
                </div>
              </Field>
            )}

            {result.reasoning && (
              <Field label="How this maps to the obligation">{result.reasoning}</Field>
            )}

            {result.gap && (
              <Field label={isGuide ? "What is missing" : "Gap"}>
                <div className="banner">{result.gap}</div>
              </Field>
            )}

            {result.reviewer_note && (
              <Field label="Check this yourself">
                <div className="banner">{result.reviewer_note}</div>
              </Field>
            )}

            {result.contradictions.length > 0 && (
              <Field label={`Conflicting language found (${result.contradictions.length})`}>
                <div className="stack" style={{ gap: 10, marginTop: 6 }}>
                  {result.contradictions.map((c, i) => (
                    <div key={i} className="card" style={{ padding: 12 }}>
                      <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
                        <Chip tone={c.severity === "high" ? "alert" : "warn"}>
                          {KIND_LABEL[c.kind] ?? c.kind}
                        </Chip>
                        <span className="mono tiny">{c.cite}</span>
                      </div>
                      <div className="quote" style={{ borderLeftColor: "var(--pollen-500)" }}>
                        {c.quote}
                      </div>
                      <div className="tiny" style={{ marginTop: 6 }}>
                        {c.explanation}
                      </div>
                    </div>
                  ))}
                </div>
              </Field>
            )}

            {result.suggested_language && (
              <Field label="Draft language to close the gap">
                <div className="quote" style={{ borderLeftColor: "var(--sky-600)" }}>
                  {result.suggested_language}
                </div>
                <button
                  className="btn ghost small"
                  style={{ marginTop: 6 }}
                  onClick={() => navigator.clipboard?.writeText(result.suggested_language!)}
                >
                  Copy
                </button>
              </Field>
            )}

            {result.discarded_quotes.length > 0 && (
              <Field label="Discarded — not found in the source">
                <div className="stack" style={{ gap: 6 }}>
                  {result.discarded_quotes.map((d, i) => (
                    <div key={i} className="tiny muted">
                      “{d.quote.slice(0, 140)}” — {d.reason}
                      {d.similarity !== undefined && ` (${(d.similarity * 100).toFixed(0)}% similar)`}
                    </div>
                  ))}
                </div>
                <div className="tiny muted" style={{ marginTop: 6 }}>
                  These were proposed but could not be found verbatim in the cited
                  document, so they were withheld.
                </div>
              </Field>
            )}

            {result.plan_synonyms && result.plan_synonyms.length > 0 && (
              <Field label="Searched the plan's vocabulary for">
                <div className="row wrap" style={{ gap: 5 }}>
                  {result.plan_synonyms.slice(0, 8).map((s) => (
                    <Chip key={s} tone="plain">
                      {s}
                    </Chip>
                  ))}
                </div>
              </Field>
            )}

            {result.candidates && result.candidates.length > 0 && (
              <details>
                <summary className="label" style={{ cursor: "pointer" }}>
                  Other passages considered ({result.candidates.length})
                </summary>
                <div className="stack" style={{ gap: 8, marginTop: 10 }}>
                  {result.candidates.map((c, i) => (
                    <div key={i} className="card" style={{ padding: 10 }}>
                      <div className="row" style={{ gap: 8 }}>
                        <strong className="mono tiny">{c.cite}</strong>
                        <span className="tiny muted truncate">{c.title}</span>
                      </div>
                      {c.excerpt && (
                        <div className="tiny muted" style={{ marginTop: 5 }}>
                          {c.excerpt.slice(0, 240)}…
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}

        {/* -------- review actions -------- */}
        <div className="hairline" style={{ paddingTop: 16 }}>
          <div className="label" style={{ marginBottom: 8 }}>
            Your decision
            {item.review?.state !== "open" && (
              <>
                {" · "}
                <span style={{ textTransform: "none", letterSpacing: 0 }}>
                  {item.review.state} {item.review.updated_at?.slice(0, 16).replace("T", " ")}
                </span>
              </>
            )}
          </div>
          <textarea
            className="input"
            rows={3}
            placeholder="Note for the submission or for your own audit trail…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ marginBottom: 8, resize: "vertical" }}
          />
          <div className="row wrap" style={{ gap: 8 }}>
            <button
              className="btn small"
              disabled={saving !== null}
              onClick={() => act("accepted")}
            >
              {saving === "accepted" ? "Saving…" : "Accept citation"}
            </button>
            <button
              className="btn secondary small"
              disabled={saving !== null}
              onClick={() => act("flagged")}
            >
              {saving === "flagged" ? "Saving…" : "Flag for follow-up"}
            </button>
            <button
              className="btn ghost small"
              disabled={saving !== null}
              onClick={() => act("edited")}
            >
              Mark edited
            </button>
            {item.review?.state !== "open" && (
              <button
                className="btn ghost small"
                disabled={saving !== null}
                onClick={() => act("open")}
              >
                Reopen
              </button>
            )}
          </div>
          <div className="tiny muted" style={{ marginTop: 8 }}>
            Nothing here is submitted for you. Every answer stays a draft until you
            accept it, and your notes are exported alongside the citations.
          </div>
        </div>
      </div>
    </aside>
  );
}
