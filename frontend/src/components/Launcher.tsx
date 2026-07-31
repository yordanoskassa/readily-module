import { useCallback, useEffect, useRef, useState } from "react";
import { FileUp, Play, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { Health, RunSummary } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Chip, Spinner } from "./bits";

type Sample = { name: string; kind: string; size_kb: number };

/** Start screen for one module: run a bundled document or upload a PDF. */
export function Launcher({
  kind,
  health,
  onStarted,
  onOpen,
}: {
  kind: "questionnaire" | "guide";
  health: Health | null;
  onStarted: (runId: string, summary?: RunSummary) => void;
  onOpen: (runId: string, summary?: RunSummary) => void;
}) {
  const [samples, setSamples] = useState<Sample[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState<string>(kind === "guide" ? "30" : "");
  const fileRef = useRef<HTMLInputElement>(null);

  const isQ = kind === "questionnaire";
  const disabled = busy || health?.llm_configured === false;

  useEffect(() => {
    let live = true;
    api.samples().then(({ samples: all }) => {
      if (!live) return;
      const mine = all.filter((s) => s.kind === kind);
      setSamples(mine);
      if (isQ && mine[0]) {
        api
          .previewQuestionnaire(mine[0].name)
          .then((p) => live && setCount(p.count))
          .catch(() => {});
      }
    });
    api.runs().then((r) => live && setRuns(r.runs.filter((x) => x.kind === kind)));
    return () => {
      live = false;
    };
  }, [kind, isQ]);

  const parsedLimit = limit === "" ? undefined : Number(limit);

  const start = useCallback(
    async (sample: string) => {
      setBusy(true);
      setError("");
      try {
        const run = isQ
          ? await api.startQuestionnaire(sample, parsedLimit)
          : await api.startGuideLimited(sample, parsedLimit);
        onStarted(run.id, run);
      } catch (e: any) {
        setError(String(e.message ?? e));
      } finally {
        setBusy(false);
      }
    },
    [isQ, parsedLimit, onStarted],
  );

  const upload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError("");
      try {
        const run = await api.upload(kind, file, parsedLimit);
        onStarted(run.id, run);
      } catch (e: any) {
        setError(String(e.message ?? e));
      } finally {
        setBusy(false);
      }
    },
    [kind, parsedLimit, onStarted],
  );

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span className="label-1">{isQ ? "Audit Review" : "Regulatory Change"}</span>
        <h1 className="text-[34px] leading-tight">
          {isQ ? "Answer a Submission Review Form" : "Pull the obligations out of a Policy Guide"}
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          {isQ ? (
            <>
              Every question gets an answer, a quote from your own P&amp;Ps, and a page number —
              each quote checked character-for-character against the source document before you
              see it. Nothing is submitted for you.
            </>
          ) : (
            <>
              The guide is read end to end and every concrete obligation is pulled out with the
              sentence that creates it and its page. Each one is then checked against your P&amp;P
              library, so you see what is already covered and what needs writing before a
              questionnaire ever arrives.
            </>
          )}
        </p>
      </div>

      {health?.llm_configured === false && (
        <div className="banner banner-danger flex flex-col gap-1">
          <strong>No API key configured.</strong>
          <span>
            Set <code className="font-mono">ANTHROPIC_API_KEY</code> in{" "}
            <code className="font-mono">.env</code> and restart the server. Completed runs and
            the policy library still work without it.
          </span>
        </div>
      )}

      {error && (
        <div className="banner banner-danger">
          {error}
        </div>
      )}

      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-col gap-3.5 p-5">
          <span className="label-1">Start from a bundled document</span>
          {!samples ? (
            <Spinner label="Looking for samples…" />
          ) : samples.length === 0 ? (
            <p className="text-sm text-muted-foreground">No bundled document for this module.</p>
          ) : (
            samples.map((s) => (
              <div key={s.name} className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <strong className="text-sm">{s.name}</strong>
                  <span className="text-xs text-muted-foreground">
                    {s.size_kb} KB
                    {isQ && count !== null ? ` · ${count} questions parsed` : ""}
                  </span>
                </div>
                <Button disabled={disabled} onClick={() => start(s.name)}>
                  <Play className="size-3.5" />
                  {busy ? "Starting…" : isQ ? "Answer questions" : "Extract obligations"}
                </Button>
              </div>
            ))
          )}

          <Separator />
          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="number"
              min={1}
              max={500}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="all"
              className="h-9 w-24"
              aria-label={isQ ? "Question limit" : "Coverage-check limit"}
            />
            <p className="max-w-md text-xs text-muted-foreground">
              {isQ ? (
                <>Caps how many questions get answered. Leave blank to run them all.</>
              ) : (
                <>
                  Extraction always reads the whole guide. This caps how many obligations get
                  coverage-checked against your P&amp;Ps — mandatory ones first.
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t p-5">
          <div className="flex flex-col gap-0.5">
            <strong className="text-sm">Or upload your own PDF</strong>
            <span className="text-xs text-muted-foreground">
              {isQ
                ? "Any DHCS Submission Review Form."
                : "Any DHCS Policy Guide or All Plan Letter."}
            </span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = "";
            }}
          />
          <Button variant="secondary" disabled={disabled} onClick={() => fileRef.current?.click()}>
            <FileUp className="size-3.5" /> Choose PDF
          </Button>
        </div>
      </Card>

      {runs.length > 0 && (
        <Card className="gap-0 overflow-hidden p-0">
          <div className="px-5 pt-5">
            <span className="label-1">Earlier runs</span>
          </div>
          <div className="mt-2 divide-y">
            {runs.slice(0, 8).map((r) => (
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(r.id, r)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen(r.id, r)}
                className="flex cursor-pointer items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/60"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{r.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.created_at.replace("T", " ").slice(0, 16)} · {r.source_name}
                  </p>
                </div>
                <Chip
                  tone={r.status === "done" ? "met" : r.status === "error" ? "not-met" : "info"}
                >
                  {r.status === "running" ? `${r.completed}/${r.total}` : r.status}
                </Chip>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label="Delete run"
                  onClick={(e) => {
                    e.stopPropagation();
                    api
                      .deleteRun(r.id)
                      .then(() => setRuns((prev) => prev.filter((x) => x.id !== r.id)));
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
