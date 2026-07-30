import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  Flag,
  MessageCircleQuestion,
  RotateCcw,
  X,
} from "lucide-react";
import { ANSWER_LABEL, COVERAGE_LABEL, STATUS_LABEL, api } from "@/lib/api";
import type { Candidate, Citation, Item, ReviewState, Run } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Chip, Confidence, Field, HighlightedText, Quote, StatusChip, VerifiedBadge } from "./bits";

const KIND_LABEL: Record<string, string> = {
  contradiction: "Contradiction",
  exception: "Exception",
  narrower_scope: "Narrower scope",
  different_timeframe: "Different timeframe",
};

/** Loads the pages around a citation so the quote can be read in place. */
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

  if (error)
    return <p className="text-xs text-muted-foreground">Could not load page text: {error}</p>;
  if (!pages) return <Skeleton className="h-16 w-full" />;

  const needle = citation.quote_check.matched_text || citation.quote;

  return (
    <div className="max-h-80 overflow-y-auto rounded-md border bg-muted/40 px-3.5 py-3 font-mono text-[11.5px] leading-relaxed">
      {pages.map((p) => {
        // Offsets from the checker are relative to the chunk, not the page, so
        // the span is located again here.
        const at = p.text.indexOf(needle);
        return (
          <div key={p.page} className="mb-3.5 whitespace-pre-wrap break-words">
            <div className="label-1 mb-1">Page {p.page}</div>
            {at >= 0 ? (
              <HighlightedText text={p.text} start={at} end={at + needle.length} />
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
    <div className="mb-3.5">
      <div className="mb-1.5 flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] font-medium">{citation.cite}</span>
          <VerifiedBadge verified={qc.verified} method={qc.method} similarity={qc.similarity} />
        </div>
        <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs"
          onClick={() => setOpen((v) => !v)}>
          {open ? "Hide page" : "Read in context"}
        </Button>
      </div>
      <p className="mb-1.5 text-xs text-muted-foreground">{citation.title}</p>
      <Quote tone={qc.verified ? "ok" : "alert"}>{citation.quote}</Quote>
      {citation.covers && (
        <p className="mt-1.5 text-xs text-muted-foreground">Establishes: {citation.covers}</p>
      )}
      {open && <div className="mt-2">
        <SourceContext citation={citation} />
      </div>}
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

export function EvidencePanel({
  run,
  item,
  onClose,
  onReview,
  onItemChanged,
}: {
  run: Run;
  item: Item;
  onClose: () => void;
  onReview: (state: ReviewState, note: string) => Promise<void>;
  onItemChanged: (item: Item) => void;
}) {
  const [note, setNote] = useState(item.review?.note ?? "");
  const [saving, setSaving] = useState<ReviewState | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [hint, setHint] = useState("");
  const [policies, setPolicies] = useState("");
  const [rerunning, setRerunning] = useState(false);
  const [swapping, setSwapping] = useState<number | null>(null);
  const [actionError, setActionError] = useState("");

  const isGuide = run.kind === "guide";
  const key = isGuide ? item.id! : item.number!;
  const result = item.result;

  // No effect resets this local form state when the row changes: RunView passes
  // a `key`, so selecting a different row remounts this component with fresh
  // state. That is React's own recommendation over syncing state in an effect.

  async function act(state: ReviewState) {
    setSaving(state);
    try {
      await onReview(state, note);
    } finally {
      setSaving(null);
    }
  }

  async function doAsk() {
    if (!question.trim()) return;
    setAsking(true);
    setActionError("");
    try {
      const { item: updated } = await api.ask(run.id, key, question.trim());
      onItemChanged(updated);
      setQuestion("");
    } catch (e: any) {
      setActionError(String(e.message ?? e));
    } finally {
      setAsking(false);
    }
  }

  async function doRerun() {
    setRerunning(true);
    setActionError("");
    try {
      const codes = policies
        .split(/[,\s]+/)
        .map((c) => c.trim())
        .filter(Boolean);
      onItemChanged(await api.rerun(run.id, key, hint.trim(), codes));
      setHint("");
      setPolicies("");
    } catch (e: any) {
      setActionError(String(e.message ?? e));
    } finally {
      setRerunning(false);
    }
  }

  async function useCandidate(c: Candidate) {
    if (!c.chunk_id) return;
    setSwapping(c.chunk_id);
    setActionError("");
    try {
      onItemChanged(await api.setCitation(run.id, key, c.chunk_id));
    } catch (e: any) {
      setActionError(String(e.message ?? e));
    } finally {
      setSwapping(null);
    }
  }

  const status = isGuide ? result?.coverage_status : result?.status;
  const statusLabel = isGuide
    ? COVERAGE_LABEL[result?.coverage_status ?? "error"]
    : STATUS_LABEL[result?.status ?? "error"];

  return (
    <aside className="lg:sticky lg:top-[52px] lg:max-h-[calc(100vh-72px)] lg:overflow-y-auto border-t lg:border-t-0 lg:border-l bg-card">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-card px-5 py-3">
        <span className="label-1">
          {isGuide ? `Obligation ${item.id}` : `Question ${item.number}`}
        </span>
        <Button variant="ghost" size="icon" className="size-7" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-5 px-5 py-5">
        {/* ---------------- the ask ---------------- */}
        <div className="flex flex-col gap-2">
          <p className="text-[14.5px] leading-relaxed">
            {isGuide ? item.obligation : item.question}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {item.reference && <Chip>{item.reference}</Chip>}
            {isGuide && item.strength && (
              <Chip tone={item.strength === "must" ? "alert" : "plain"}>{item.strength}</Chip>
            )}
            {isGuide && item.page ? <Chip>Guide p. {item.page}</Chip> : null}
            {item.deadline && <Chip tone="info">{item.deadline}</Chip>}
            {item.topic && <Chip>{item.topic}</Chip>}
          </div>
        </div>

        {isGuide && item.quote && (
          <Field label="Source text in the guide">
            <Quote tone={item.quote_verified ? "ok" : "alert"}>{item.quote}</Quote>
            {!item.quote_verified && (
              <p className="mt-1 text-xs text-muted-foreground">
                Could not confirm this sentence on the page it was attributed to.
              </p>
            )}
          </Field>
        )}

        {!result && (
          <Card className="border-pollen-200 bg-pollen-100 px-4 py-3 text-sm text-pollen-700">
            {run.status === "running" ? "Still working through this one." : "Not checked yet."}
          </Card>
        )}

        {result?.status === "error" && (
          <Card className="gap-1 border-[#e0b39f] bg-brick-100 px-4 py-3 text-sm text-brick-700">
            <strong>This question was not answered.</strong>
            <span>{result.error || result.reasoning}</span>
            <span className="text-xs">
              Treat it as unanswered, not as a compliance gap — re-run it below.
            </span>
          </Card>
        )}

        {result && result.status !== "error" && (
          <>
            <div className="flex flex-wrap items-start gap-6">
              <div className="flex flex-col gap-1.5">
                <span className="label-1">{isGuide ? "Coverage" : "Answer"}</span>
                <div className="flex items-center gap-2">
                  {!isGuide && (
                    <strong className="text-[15px]">{ANSWER_LABEL[result.status]}</strong>
                  )}
                  <StatusChip status={status} label={statusLabel} />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="label-1">Confidence</span>
                <Confidence value={result.confidence} />
              </div>
            </div>

            {result.steered && (result.steered.hint || result.steered.policies.length > 0) && (
              <p className="text-xs text-muted-foreground">
                Re-run with your steer
                {result.steered.hint && <> — “{result.steered.hint}”</>}
                {result.steered.policies.length > 0 && (
                  <> · restricted to {result.steered.policies.join(", ")}</>
                )}
              </p>
            )}

            {result.citations.length > 0 && (
              <Field label={`Evidence (${result.citations.length})`}>
                <div className="mt-1.5">
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
                <Card className="border-pollen-200 bg-pollen-100 px-3.5 py-2.5 text-sm text-pollen-700">
                  {result.gap}
                </Card>
              </Field>
            )}

            {result.reviewer_note && (
              <Field label="Check this yourself">
                <Card className="border-pollen-200 bg-pollen-100 px-3.5 py-2.5 text-sm text-pollen-700">
                  {result.reviewer_note}
                </Card>
              </Field>
            )}

            {result.contradictions.length > 0 && (
              <Field label={`Conflicting language found (${result.contradictions.length})`}>
                <div className="mt-1.5 flex flex-col gap-2.5">
                  {result.contradictions.map((c, i) => (
                    <Card key={i} className="gap-2 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Chip tone={c.severity === "high" ? "alert" : "warn"}>
                          <AlertTriangle className="size-3" />
                          {KIND_LABEL[c.kind] ?? c.kind}
                        </Chip>
                        <span className="font-mono text-[11px]">{c.cite}</span>
                      </div>
                      <Quote tone="warn">{c.quote}</Quote>
                      <p className="text-xs">{c.explanation}</p>
                    </Card>
                  ))}
                </div>
              </Field>
            )}

            {result.suggested_language && (
              <Field label="Draft language to close the gap">
                <Quote tone="info">{result.suggested_language}</Quote>
                <Button variant="ghost" size="sm" className="mt-1.5 h-7 px-2 text-xs"
                  onClick={() => navigator.clipboard?.writeText(result.suggested_language!)}>
                  <Copy className="size-3" /> Copy
                </Button>
              </Field>
            )}

            {result.discarded_quotes.length > 0 && (
              <Field label="Withheld — not found in the source">
                <div className="flex flex-col gap-1.5">
                  {result.discarded_quotes.map((d, i) => (
                    <p key={i} className="text-xs text-muted-foreground">
                      “{d.quote.slice(0, 140)}” — {d.reason}
                      {d.similarity !== undefined &&
                        ` (${(d.similarity * 100).toFixed(0)}% similar)`}
                    </p>
                  ))}
                </div>
              </Field>
            )}

            {result.plan_synonyms && result.plan_synonyms.length > 0 && (
              <Field label="Searched the plan's vocabulary for">
                <div className="flex flex-wrap gap-1.5">
                  {result.plan_synonyms.slice(0, 8).map((s) => (
                    <Chip key={s}>{s}</Chip>
                  ))}
                </div>
              </Field>
            )}
          </>
        )}

        {/* ---------------- follow-up thread ---------------- */}
        {(item.thread?.length ?? 0) > 0 && (
          <Field label={`Your follow-ups (${item.thread!.length})`}>
            <div className="mt-1.5 flex flex-col gap-2.5">
              {item.thread!.map((t, i) => (
                <Card key={i} className="gap-2 p-3">
                  <p className="text-xs font-medium">{t.question}</p>
                  <p className="text-sm">{t.answer}</p>
                  {t.quotes.map((q, j) => (
                    <div key={j}>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {q.cite}
                      </span>
                      <Quote tone="info" className="mt-1">
                        {q.quote}
                      </Quote>
                    </div>
                  ))}
                  {t.changes_verdict && (
                    <Chip tone="alert">
                      <AlertTriangle className="size-3" /> Suggests the verdict is wrong
                    </Chip>
                  )}
                </Card>
              ))}
            </div>
          </Field>
        )}

        {actionError && (
          <Card className="border-[#e0b39f] bg-brick-100 px-3.5 py-2.5 text-sm text-brick-700">
            {actionError}
          </Card>
        )}

        {/* ---------------- ask ---------------- */}
        <Separator />
        <Field label="Ask about this answer">
          <div className="flex gap-2">
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !asking && doAsk()}
              placeholder="Is this Medi-Cal or OneCare?"
              className="h-9 text-sm"
            />
            <Button size="sm" className="h-9 shrink-0" disabled={asking || !question.trim()}
              onClick={doAsk}>
              {asking ? "Asking…" : <MessageCircleQuestion className="size-4" />}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Answered only from the passages already retrieved, so it is fast and cheap.
          </p>
        </Field>

        {/* ---------------- redirect ---------------- */}
        <Field label="Disagree? Point it somewhere else">
          <div className="flex flex-col gap-2">
            <Input
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="Hint — e.g. this is about post-service review"
              className="h-9 text-sm"
            />
            <div className="flex gap-2">
              <Input
                value={policies}
                onChange={(e) => setPolicies(e.target.value)}
                placeholder="Only these policies — e.g. GG.1550, MA.6113"
                className="h-9 font-mono text-sm"
              />
              <Button variant="secondary" size="sm" className="h-9 shrink-0"
                disabled={rerunning} onClick={doRerun}>
                {rerunning ? "Re-running…" : <><RotateCcw className="size-3.5" /> Re-run</>}
              </Button>
            </div>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Re-searches and re-assesses just this one. Naming policies restricts the
            search to them.
          </p>
        </Field>

        {/* ---------------- swap citation ---------------- */}
        {result?.candidates && result.candidates.length > 0 && (
          <Field label={`Other passages considered (${result.candidates.length})`}>
            <div className="mt-1.5 flex flex-col gap-2">
              {result.candidates.map((c, i) => (
                <Card key={i} className="gap-1.5 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-mono text-[11px] font-medium">{c.cite}</span>
                      <p className="truncate text-xs text-muted-foreground">{c.title}</p>
                    </div>
                    <Button variant="ghost" size="sm"
                      className="h-6 shrink-0 px-2 text-xs"
                      disabled={swapping !== null || !c.chunk_id}
                      onClick={() => useCandidate(c)}>
                      {swapping === c.chunk_id ? "Verifying…" : <>Use this <ArrowRight className="size-3" /></>}
                    </Button>
                  </div>
                  {c.excerpt && (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {c.excerpt.slice(0, 220)}…
                    </p>
                  )}
                </Card>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              A passage you pick is held to the same verbatim check — if no quote in it
              can be verified, it is rejected rather than shown.
            </p>
          </Field>
        )}

        {/* ---------------- decision ---------------- */}
        <Separator />
        <div>
          <div className="label-1 mb-2">
            Your decision
            {item.review?.state !== "open" && (
              <span className="ml-1 normal-case tracking-normal">
                · {item.review.state} {item.review.updated_at?.slice(0, 16).replace("T", " ")}
              </span>
            )}
          </div>
          <Textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for the submission or for your own audit trail…"
            className="mb-2 resize-y text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={saving !== null} onClick={() => act("accepted")}>
              {saving === "accepted" ? "Saving…" : <><Check className="size-3.5" /> Accept citation</>}
            </Button>
            <Button variant="secondary" size="sm" disabled={saving !== null}
              onClick={() => act("flagged")}>
              {saving === "flagged" ? "Saving…" : <><Flag className="size-3.5" /> Flag</>}
            </Button>
            {item.review?.state !== "open" && (
              <Button variant="ghost" size="sm" disabled={saving !== null}
                onClick={() => act("open")}>
                Reopen
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Nothing here is submitted for you. Every answer stays a draft until you accept
            it, and your notes and follow-ups export alongside the citations.
          </p>
        </div>
      </div>
    </aside>
  );
}
