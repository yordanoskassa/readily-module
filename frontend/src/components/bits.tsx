import type { ReactNode } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Coverage, Status } from "@/lib/api";

/** Readily's product uses explicit audit-status tokens — met, partially met,
 *  not met, needs docs, n/a — so this module's verdicts map onto those rather
 *  than onto a generic red/amber/green of its own. */
export type Tone = "met" | "partial" | "not-met" | "needs-docs" | "na" | "info";

export function Chip({
  tone = "na",
  dot = false,
  children,
  className,
  title,
}: {
  tone?: Tone;
  /** Status pills carry the 6px dot; plain metadata chips do not. */
  dot?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={cn("pill", `pill-${tone}`, className)}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function statusTone(s?: Status | Coverage): Tone {
  switch (s) {
    case "supported":
    case "covered":
      return "met";
    case "partial":
      return "partial";
    case "not_found":
    case "gap":
      return "not-met";
    case "error":
      return "needs-docs";
    default:
      return "na";
  }
}

export function StatusChip({
  status,
  label,
}: {
  status?: Status | Coverage;
  label: string;
}) {
  return (
    <Chip tone={statusTone(status)} dot>
      {label}
    </Chip>
  );
}

/** Confidence as a bar plus the number. A bare number reads as more precise
 *  than the underlying judgement actually is. */
export function Confidence({ value }: { value: number }) {
  const fill =
    value >= 70
      ? "[&>[data-slot=progress-indicator]]:bg-score-pass"
      : value >= 40
        ? "[&>[data-slot=progress-indicator]]:bg-score-warn"
        : "[&>[data-slot=progress-indicator]]:bg-slate-400";
  return (
    <span className="flex items-center gap-2">
      <Progress value={value} className={cn("h-1 w-11 bg-warm-500", fill)} />
      <span className="font-mono text-[11px] text-muted-foreground">{value}</span>
    </span>
  );
}

export function HighlightedText({
  text,
  start,
  end,
}: {
  text: string;
  start: number;
  end: number;
}) {
  if (start < 0 || end <= start || end > text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-sm bg-pollen px-0.5 text-foreground">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

export function VerifiedBadge({
  verified,
  method,
  similarity,
}: {
  verified: boolean;
  method: string;
  similarity: number;
}) {
  const explanation = verified
    ? method === "exact"
      ? "Found character-for-character in the source document."
      : `Matched the source at ${(similarity * 100).toFixed(0)}% after normalising ` +
        `whitespace and punctuation. Numbers, negations and must/may wording were ` +
        `checked for exact agreement.`
    : "Not found in the cited document, so it was withheld.";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Chip tone={verified ? "met" : "not-met"}>
            {verified ? <Check className="size-3" /> : <X className="size-3" />}
            {verified
              ? `Verified${method === "fuzzy" ? " (normalised)" : ""}`
              : "Not in source"}
          </Chip>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{explanation}</TooltipContent>
    </Tooltip>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="flex items-center gap-2">
      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
      {label && <span className="text-sm text-muted-foreground">{label}</span>}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="label-1">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-16 text-center text-muted-foreground">
      <h2 className="mb-2 text-xl text-foreground">{title}</h2>
      {children}
    </div>
  );
}

/** Soft notice surface, sharing the status tokens with the pills. */
export function Banner({
  tone = "warn",
  children,
  className,
}: {
  tone?: "warn" | "danger" | "info";
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("banner", `banner-${tone}`, className)}>{children}</div>;
}

/** Quoted policy text. Monospaced so the reader sees it exactly as written —
 *  these strings are checked character-for-character. */
export function Quote({
  children,
  tone = "met",
  className,
}: {
  children: ReactNode;
  tone?: "met" | "partial" | "not-met" | "info";
  className?: string;
}) {
  const border = {
    met: "border-l-[var(--status-met-dot)]",
    partial: "border-l-[var(--status-partial-dot)]",
    "not-met": "border-l-[var(--status-not-met-dot)]",
    info: "border-l-[var(--status-info-dot)]",
  }[tone];
  return <div className={cn("quote-block", border, className)}>{children}</div>;
}
