import type { ReactNode } from "react";
import { statusTone } from "../lib/api";
import type { Coverage, Status } from "../lib/api";

export function Chip({
  tone = "plain",
  children,
  title,
}: {
  tone?: "ok" | "warn" | "none" | "alert" | "info" | "plain";
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip ${tone}`} title={title}>
      {children}
    </span>
  );
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

/** Confidence as a small bar. A number alone reads as more precise than it is. */
export function Confidence({ value }: { value: number }) {
  const tone = value >= 70 ? "ok" : value >= 40 ? "warn" : "";
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className={`meter ${tone}`}>
        <span style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </span>
      <span className="tiny muted mono">{value}</span>
    </span>
  );
}

/** Renders a quote with the verified span highlighted inside its page context. */
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
      <mark>{text.slice(start, end)}</mark>
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
  if (verified) {
    return (
      <Chip
        tone="ok"
        title={
          method === "exact"
            ? "This text was found character-for-character in the source document."
            : `Matched the source at ${(similarity * 100).toFixed(0)}% after ` +
              `normalising whitespace and punctuation. Numbers, negations and ` +
              `must/may wording were checked for exact agreement.`
        }
      >
        ✓ Verified in source{method === "fuzzy" ? " (normalised)" : ""}
      </Chip>
    );
  }
  return (
    <Chip tone="alert" title="This text was not found in the cited document, so it was discarded.">
      ✕ Not in source
    </Chip>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" style={{ gap: 8 }}>
      <span className="spinner" />
      {label && <span className="small muted">{label}</span>}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="stack" style={{ gap: 5 }}>
      <div className="label">{label}</div>
      <div className="small">{children}</div>
    </div>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
