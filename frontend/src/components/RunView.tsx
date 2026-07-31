import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUpDown, ChevronLeft, Download, Loader2, Square } from "lucide-react";
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
import { Chip, Confidence, Empty, Spinner, StatusChip, statusTone } from "./bits";
import { EvidencePanel } from "./EvidencePanel";

type Filter = "all" | "supported" | "partial" | "not_found" | "error" | "flagged" | "conflicts";
type Order = "form" | "risk";


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

/** Lower sorts first: unresolved conflicts, then failures, then withheld
 *  quotes, then low confidence, then absences. */
function riskRank(item: Item, isGuide: boolean): number {
  const r = item.result;
  if (!r) return 6;
  if ((r.contradictions?.length ?? 0) > 0) return 0;
  if (r.status === "error") return 1;
  if ((r.discarded_quotes?.length ?? 0) > 0) return 2;
  if (r.confidence < 40) return 3;
  const s = normalisedStatus(item, isGuide);
  if (s === "not_found") return 4;
  if (s === "partial") return 5;
  return 7;
}

export function RunView({ runId, onExit }: { runId: string; onExit: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [order, setOrder] = useState<Order>("form");
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

  /** The visible, ordered list. next/prev and the keyboard all walk this, so
   *  navigation always agrees with what is on screen. */
  const rows = useMemo(() => {
    if (!run) return [];
    let list = run.items;
    if (filter === "flagged") list = list.filter((it) => it.review?.state === "flagged");
    else if (filter === "conflicts")
      list = list.filter((it) => (it.result?.contradictions?.length ?? 0) > 0);
    else if (filter !== "all")
      list = list.filter((it) => normalisedStatus(it, !!isGuide) === filter);

    if (order === "risk") {
      list = [...list].sort((a, b) => {
        const d = riskRank(a, !!isGuide) - riskRank(b, !!isGuide);
        return d !== 0 ? d : (a.result?.confidence ?? 0) - (b.result?.confidence ?? 0);
      });
    }
    return list;
  }, [run, filter, order, isGuide]);

  const index = useMemo(
    () => (run ? rows.findIndex((it) => itemKey(it, run.kind) === selected) : -1),
    [rows, selected, run],
  );
  const selectedItem = index >= 0 ? rows[index] : null;

  const go = useCallback(
    (delta: number) => {
      if (!run || rows.length === 0) return;
      const next = index < 0 ? 0 : index + delta;
      if (next < 0 || next >= rows.length) return;
      setSelected(itemKey(rows[next], run.kind));
    },
    [index, rows, run],
  );

  /** j/k and arrows walk the queue, Escape closes. Ignored while typing so the
   *  ask and hint fields keep working. */
  useEffect(() => {
    if (!selected) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); go(1); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); go(-1); }
      else if (e.key === "Escape") setSelected(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, go]);

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
  const open = selectedItem !== null;

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
      {open ? (
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setSelected(null)}>
            <ChevronLeft className="size-3.5" /> All {rows.length}
          </Button>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
            {run.title}
          </span>
          <span className="hidden shrink-0 items-center gap-3 text-[11px] text-muted-foreground sm:flex">
            <span><b className="font-medium text-score-pass">{counts.supported}</b> {isGuide ? "covered" : "supported"}</span>
            <span><b className="font-medium text-score-warn">{counts.partial}</b> partial</span>
            <span><b className="font-medium">{counts.not_found}</b> {isGuide ? "gaps" : "not found"}</span>
            {conflicts > 0 && <span><b className="font-medium">{conflicts}</b> conflicts</span>}
            <span><b className="font-medium">{accepted}</b> accepted</span>
          </span>
          <Button asChild variant="secondary" size="sm" className="h-7 shrink-0 text-xs">
            <a href={`/api/runs/${run.id}/export.csv`}>
              <Download className="size-3.5" /> CSV
            </a>
          </Button>
        </div>
      ) : (
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
            <Button variant="secondary" size="sm" onClick={onExit}>
              <ChevronLeft className="size-3.5" /> All runs
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
      )}

      {/* ------------------------------------------------ tallies */}
      {!open && (
        <div className="flex flex-wrap divide-x divide-border overflow-hidden rounded-lg border bg-card">
          {stats.map(([k, v, tone]) => (
            <div key={k} className="min-w-[92px] flex-1 px-3.5 py-2">
              <div className={`text-lg font-semibold leading-tight ${tone}`}>{v}</div>
              <div className="label-1">{k}</div>
            </div>
          ))}
        </div>
      )}

      {/* ------------------------------------------------ filters */}
      <div className="flex flex-wrap items-center gap-2">
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
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 text-xs"
          onClick={() => setOrder((o) => (o === "form" ? "risk" : "form"))}
          title="Needs-attention order puts conflicts, failures and low confidence first"
        >
          <ArrowUpDown className="size-3.5" />
          {order === "form"
            ? isGuide
              ? "Guide order"
              : "Form order"
            : "Needs attention first"}
        </Button>
      </div>

      {/* ------------------------------------------------ list + panel */}
      <Card
        className={`overflow-hidden p-0 ${
          open
            ? "grid grid-cols-1 lg:h-[calc(100vh-14rem)] lg:grid-cols-[minmax(250px,330px)_minmax(0,1fr)]"
            : ""
        }`}
      >
        <div className={open ? "min-w-0 lg:h-full lg:overflow-y-auto lg:border-r" : "min-w-0"}>
          {open ? (
            /* Summary column: number, snippet, citation, status dot. Keeping six
               columns and adding a panel left the question text ~220px of a
               560px need, which overflowed into a nested scrollbar. */
            <ul className="divide-y">
              {rows.map((it) => {
                const key = itemKey(it, run.kind);
                const r = it.result;
                const s = isGuide ? r?.coverage_status : r?.status;
                const isSel = selected === key;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => setSelected(key)}
                      className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${
                        isSel ? "bg-muted" : "hover:bg-muted/50"
                      }`}
                    >
                      <span className="mt-px w-5 shrink-0 font-mono text-[11px] text-muted-foreground">
                        {isGuide ? it.id?.replace("ob", "") : it.number}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 block text-[13px] leading-snug">
                          {isGuide ? it.obligation : it.question}
                        </span>
                        {r?.citations?.[0] && (
                          <span className="mt-1 block font-mono text-[10.5px] text-muted-foreground">
                            {r.citations[0].cite}
                          </span>
                        )}
                      </span>
                      <span className="mt-1 flex shrink-0 items-center gap-1">
                        {(r?.contradictions?.length ?? 0) > 0 && (
                          <AlertTriangle className="size-3 text-[var(--status-partial-dot)]" />
                        )}
                        <span
                          aria-label={String(s ?? "pending")}
                          className={`inline-block size-2 rounded-full pill-${statusTone(s)}`}
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
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
              {rows.map((it) => {
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
          )}
          {rows.length === 0 && (
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
            position={{ index: index + 1, total: rows.length }}
            onPrev={index > 0 ? () => go(-1) : undefined}
            onNext={index < rows.length - 1 ? () => go(1) : undefined}
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
