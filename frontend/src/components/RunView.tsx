import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, Loader2, Square } from "lucide-react";
import { ANSWER_LABEL, COVERAGE_LABEL, STATUS_LABEL, api, streamRun } from "@/lib/api";
import type { Item, ReviewState, Run } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Chip, Confidence, Empty, Spinner, StatusChip } from "./bits";
import { EvidencePanel } from "./EvidencePanel";

type Filter = "all" | "supported" | "partial" | "not_found" | "error" | "flagged" | "conflicts";

/** Guide coverage verdicts map onto the questionnaire's three, so filters,
 *  tallies and chips stay one code path. */
const COVERAGE_AS_STATUS: Record<string, string> = {
  covered: "supported",
  partial: "partial",
  gap: "not_found",
  error: "error",
};

function itemKey(item: Item, kind: string) {
  return kind === "guide" ? item.id! : String(item.number);
}

function normalisedStatus(item: Item, isGuide: boolean): string | undefined {
  if (!item.result) return undefined;
  return isGuide
    ? COVERAGE_AS_STATUS[item.result.coverage_status ?? "error"]
    : item.result.status;
}

export function RunView({ runId, onExit }: { runId: string; onExit: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [phase, setPhase] = useState("");

  // Every SSE merge goes through the functional form of setState, so the handler
  // never reads `run` out of its closure. That lets this effect depend only on
  // `runId` — no ref mirroring state, and no stale snapshots.
  useEffect(() => {
    let live = true;
    setRun(null);
    setError("");
    setPhase("");

    api
      .run(runId)
      .then((r) => live && setRun(r))
      .catch((e) => live && setError(String(e.message ?? e)));

    const stop = streamRun(runId, (event) => {
      if (!live) return;

      switch (event.type) {
        case "snapshot":
          setRun(event.run);
          break;

        case "phase":
          setPhase(event.message ?? "");
          break;

        case "extracted":
          setPhase(event.message ?? "");
          setRun((prev) =>
            prev
              ? { ...prev, total: event.total, extracted: event.extracted, items: event.items }
              : prev,
          );
          break;

        case "item":
        case "review":
          setRun((prev) => {
            if (!prev) return prev;
            const key = itemKey(event.item, prev.kind);
            return {
              ...prev,
              items: prev.items.map((it) =>
                itemKey(it, prev.kind) === key ? event.item : it,
              ),
              completed: event.completed ?? prev.completed,
              total: event.total ?? prev.total,
            };
          });
          break;

        case "done":
          setPhase("");
          setRun((prev) => (prev ? { ...prev, ...event.run } : prev));
          // Refetch so tallies come from the server rather than being accumulated.
          api.run(runId).then((r) => live && setRun(r));
          break;
      }
    });

    return () => {
      live = false;
      stop();
    };
  }, [runId]);

  const isGuide = run?.kind === "guide";

  /** One pass over the items for every tally the header shows. */
  const tally = useMemo(() => {
    const counts = { supported: 0, partial: 0, not_found: 0, error: 0 };
    let conflicts = 0;
    let flagged = 0;
    let accepted = 0;
    let answered = 0;
    for (const it of run?.items ?? []) {
      const s = normalisedStatus(it, !!isGuide);
      if (s) {
        counts[s as keyof typeof counts]++;
        answered++;
      }
      if ((it.result?.contradictions?.length ?? 0) > 0) conflicts++;
      if (it.review?.state === "flagged") flagged++;
      if (it.review?.state === "accepted") accepted++;
    }
    return { counts, conflicts, flagged, accepted, answered };
  }, [run?.items, isGuide]);

  const filtered = useMemo(() => {
    if (!run) return [];
    if (filter === "all") return run.items;
    if (filter === "flagged") return run.items.filter((it) => it.review?.state === "flagged");
    if (filter === "conflicts")
      return run.items.filter((it) => (it.result?.contradictions?.length ?? 0) > 0);
    return run.items.filter((it) => normalisedStatus(it, !!isGuide) === filter);
  }, [run, filter, isGuide]);

  const selectedItem = useMemo(
    () => run?.items.find((it) => itemKey(it, run.kind) === selected) ?? null,
    [run, selected],
  );

  /** Replace one item after an interaction. Functional form again, so this stays
   *  referentially stable and is safe to pass down. */
  const applyItem = useCallback((updated: Item) => {
    setRun((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((it) =>
              itemKey(it, prev.kind) === itemKey(updated, prev.kind) ? updated : it,
            ),
          }
        : prev,
    );
  }, []);

  const handleReview = useCallback(
    async (state: ReviewState, note: string) => {
      if (!selectedItem || !run) return;
      applyItem(await api.review(run.id, itemKey(selectedItem, run.kind), { state, note }));
    },
    [run, selectedItem, applyItem],
  );

  if (error) {
    return (
      <Empty title="Could not load this run">
        <p className="mb-4">{error}</p>
        <Button variant="secondary" onClick={onExit}>
          Back
        </Button>
      </Empty>
    );
  }
  if (!run) {
    return (
      <Card className="p-5">
        <Spinner label="Loading run…" />
      </Card>
    );
  }

  const { counts, conflicts, flagged, accepted, answered } = tally;
  const pct = run.total ? Math.round((answered / run.total) * 100) : 0;

  const filters: [Filter, string][] = [
    ["all", `All ${run.items.length}`],
    ["supported", `${isGuide ? "Covered" : "Supported"} ${counts.supported}`],
    ["partial", `Partial ${counts.partial}`],
    ["not_found", `${isGuide ? "Gaps" : "Not found"} ${counts.not_found}`],
  ];
  if (counts.error) filters.push(["error", `Errors ${counts.error}`]);
  if (conflicts) filters.push(["conflicts", `Conflicts ${conflicts}`]);
  if (flagged) filters.push(["flagged", `Flagged ${flagged}`]);

  const stats: [string, number, string][] = [
    [
      isGuide ? "Obligations found" : "Questions",
      isGuide ? (run.extracted ?? run.total) : run.total,
      "",
    ],
    ...((isGuide && (run.extracted ?? 0) > run.total
      ? [["Coverage checked", run.total, ""]]
      : []) as [string, number, string][]),
    [isGuide ? "Covered" : "Supported", counts.supported, "text-score-pass"],
    ["Partial", counts.partial, "text-score-warn"],
    [isGuide ? "Gaps" : "Not found", counts.not_found, ""],
    ["Conflicts", conflicts, ""],
    ["Accepted", accepted, ""],
    ["Flagged", flagged, ""],
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* ------------------------------------------------ header */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="label-1">
              {isGuide ? "Policy Guide review" : "Submission Review Form"}
            </span>
            <h1 className="max-w-3xl text-[26px] leading-tight">{run.title}</h1>
            <p className="text-xs text-muted-foreground">
              {run.source_name} · started {run.created_at.replace("T", " ").slice(0, 16)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="secondary" size="sm">
              <a href={`/api/runs/${run.id}/export.csv`}>
                <Download className="size-3.5" /> Export CSV
              </a>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href={`/api/runs/${run.id}/export.json`} target="_blank" rel="noreferrer">
                JSON
              </a>
            </Button>
            {run.status === "running" && (
              <Button variant="ghost" size="sm" onClick={() => api.cancelRun(run.id)}>
                <Square className="size-3.5" /> Stop
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onExit}>
              All runs
            </Button>
          </div>
        </div>

        {run.status === "running" && (
          <div className="flex flex-col gap-1.5">
            <Progress
              value={pct}
              className="h-1 bg-warm-500 [&>[data-slot=progress-indicator]]:bg-obsidian"
            />
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {phase ||
                `${answered} of ${run.total} ${isGuide ? "obligations" : "questions"} checked`}
            </span>
          </div>
        )}
        {run.status === "error" && run.error && (
          <div className="banner banner-danger">
            {run.error}
          </div>
        )}
      </div>

      {/* ------------------------------------------------ tallies */}
      <div className="flex flex-wrap divide-x divide-border overflow-hidden rounded-lg border bg-card">
        {stats.map(([k, v, tone]) => (
          <div key={k} className="min-w-[104px] flex-1 px-4 py-3">
            <div className={`font-serif text-2xl font-light leading-none ${tone}`}>{v}</div>
            <div className="label-1 mt-1.5">{k}</div>
          </div>
        ))}
      </div>

      {/* ------------------------------------------------ filters */}
      <div className="flex flex-wrap gap-2">
        {filters.map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={filter === key ? "default" : "outline"}
            className="h-7 rounded-full text-xs"
            onClick={() => setFilter(key)}
          >
            {label}
          </Button>
        ))}
      </div>

      {/* ------------------------------------------------ table + panel */}
      <Card
        className={`overflow-hidden p-0 ${
 selectedItem ? "grid grid-cols-1 items-start lg:grid-cols-[minmax(0,1fr)_460px]" : ""
        }`}
      >
        <div className="min-w-0">
          <Table>
            {/* Header is deliberately not sticky. shadcn wraps Table in an
                overflow-x-auto container, which becomes the containing block for
                sticky children — so a `top` offset is measured against that box
                rather than the viewport and the header lands on top of row 1. */}
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10">#</TableHead>
                <TableHead>{isGuide ? "Obligation" : "Question"}</TableHead>
                <TableHead className="w-[116px]">
                  {isGuide ? "Coverage" : "Answer"}
                </TableHead>
                <TableHead className="w-[150px]">Citation</TableHead>
                <TableHead className="w-[90px]">Conf.</TableHead>
                <TableHead className="w-[92px]">Review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((it) => {
                const key = itemKey(it, run.kind);
                const r = it.result;
                const s = isGuide ? r?.coverage_status : r?.status;
                const label = isGuide
                  ? COVERAGE_LABEL[r?.coverage_status ?? "error"]
                  : STATUS_LABEL[r?.status ?? "error"];
                const first = r?.citations?.[0];
                const isSelected = selected === key;

                return (
                  <TableRow
                    key={key}
                    data-state={isSelected ? "selected" : undefined}
                    className="cursor-pointer align-top"
                    onClick={() => setSelected(isSelected ? null : key)}
                  >
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {isGuide ? it.id?.replace("ob", "") : it.number}
                    </TableCell>
                    <TableCell>
                      <p className="max-w-[560px] whitespace-normal">
                        {isGuide ? it.obligation : it.question}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {isGuide && it.strength === "must" && <Chip tone="not-met">must</Chip>}
                        {isGuide && it.page ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            guide p. {it.page}
                          </span>
                        ) : null}
                        {(r?.contradictions?.length ?? 0) > 0 && (
                          <Chip
                            tone="partial"
                            title="Conflicting language elsewhere in the same policy"
                          >
                            <AlertTriangle className="size-3" />
                            {r!.contradictions.length} conflict
                            {r!.contradictions.length > 1 ? "s" : ""}
                          </Chip>
                        )}
                        {(r?.discarded_quotes?.length ?? 0) > 0 && (
                          <Chip title="A proposed quote could not be found in the source">
                            {r!.discarded_quotes.length} withheld
                          </Chip>
                        )}
                        {(it.thread?.length ?? 0) > 0 && (
                          <Chip tone="info">
                            {it.thread!.length} follow-up
                            {it.thread!.length > 1 ? "s" : ""}
                          </Chip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {r ? (
                        <div className="flex items-center gap-1.5">
                          {!isGuide && r.status !== "error" && (
                            <strong className="text-sm">{ANSWER_LABEL[r.status]}</strong>
                          )}
                          <StatusChip status={s} label={label} />
                        </div>
                      ) : run.status === "running" ? (
                        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                      ) : (
                        <span className="text-xs text-muted-foreground">not checked</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {first ? (
                        <div className="flex flex-col gap-1">
                          <span className="font-mono text-[11px]">{first.cite}</span>
                          {!first.quote_check.verified && <Chip tone="not-met">unverified</Chip>}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>{r ? <Confidence value={r.confidence} /> : null}</TableCell>
                    <TableCell>
                      {it.review?.state !== "open" ? (
                        <Chip
                          tone={
                            it.review.state === "accepted"
                              ? "met"
                              : it.review.state === "flagged"
                                ? "partial"
                                : "info"
                          }
                        >
                          {it.review.state}
                        </Chip>
                      ) : (
                        <span className="text-xs text-muted-foreground">open</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {filtered.length === 0 && (
            <p className="px-6 py-12 text-center text-sm text-muted-foreground">
              Nothing matches this filter.
            </p>
          )}
        </div>

        {selectedItem && (
          // `key` remounts the panel when the row changes, which resets its local
          // form state without an effect that watches the item.
          <EvidencePanel
            key={itemKey(selectedItem, run.kind)}
            run={run}
            item={selectedItem}
            onClose={() => setSelected(null)}
            onReview={handleReview}
            onItemChanged={applyItem}
          />
        )}
      </Card>

      <p className="max-w-3xl text-xs text-muted-foreground">
        Every quote shown has been checked character-for-character against the source policy
        document. Verdicts on borderline questions are judgements, not facts — the confidence
        score and the “check this yourself” note tell you where to spend your attention.
      </p>
    </div>
  );
}
