import type { ReactNode } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Coverage, Status } from "@/lib/api";

type Tone = "ok" | "warn" | "none" | "alert" | "info" | "plain";

/** Status colours come from Readily's palette rather than generic red/green:
 *  meadow = supported, pollen = needs a look, stone = absent, brick = error. */
const TONE: Record<Tone, string> = {
  ok: "bg-meadow-100 text-meadow-700 border-meadow-300",
  warn: "bg-pollen-100 text-pollen-700 border-pollen-200",
  none: "bg-stone-200 text-stone-800 border-stone-300",
  alert: "bg-brick-100 text-brick-700 border-[#e0b39f]",
  info: "bg-sky-100 text-sky-700 border-sky-400",
  plain: "bg-card text-stone-700 border-border",
};

export function Chip({
  tone = "plain",
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn(
        "rounded-full px-2 py-0 text-[10.5px] font-normal uppercase tracking-[0.04em]",
        TONE[tone],
        className,
      )}
    >
      {children}
    </Badge>
  );
}

export function statusTone(s?: Status | Coverage): Tone {
  switch (s) {
    case "supported":
    case "covered":
      return "ok";
    case "partial":
      return "warn";
    case "error":
      return "alert";
    default:
      return "none";
  }
}

export function StatusChip({
  status,
  label,
}: {
  status?: Status | Coverage;
  label: string;
}) {
  return <Chip tone={statusTone(status)}>{label}</Chip>;
}

/** Confidence as a bar plus the number. A bare number reads as more precise
 *  than the underlying judgement actually is. */
export function Confidence({ value }: { value: number }) {
  const tone =
    value >= 70
      ? "[&>[data-slot=progress-indicator]]:bg-meadow"
      : value >= 40
        ? "[&>[data-slot=progress-indicator]]:bg-pollen-500"
        : "[&>[data-slot=progress-indicator]]:bg-stone-500";
  return (
    <span className="flex items-center gap-2">
      <Progress value={value} className={cn("h-1 w-11 bg-dust", tone)} />
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
      <mark className="rounded-sm bg-pollen-200 px-0.5 text-foreground">
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
          <Chip tone={verified ? "ok" : "alert"} className="gap-1">
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

/** Quoted policy text. Monospaced so the reader sees it exactly as written —
 *  these strings are checked character-for-character. */
export function Quote({
  children,
  tone = "ok",
  className,
}: {
  children: ReactNode;
  tone?: "ok" | "warn" | "alert" | "info";
  className?: string;
}) {
  const border = {
    ok: "border-l-meadow",
    warn: "border-l-pollen-500",
    alert: "border-l-brick",
    info: "border-l-sky-600",
  }[tone];
  return <div className={cn("quote-block", border, className)}>{children}</div>;
}
