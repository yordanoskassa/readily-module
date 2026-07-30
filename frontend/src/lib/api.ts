export type Status = "supported" | "partial" | "not_found" | "error";
export type Coverage = "covered" | "partial" | "gap" | "error";
export type ReviewState = "open" | "accepted" | "flagged" | "edited";

export interface QuoteCheck {
  verified: boolean;
  method: "exact" | "fuzzy" | "not_found";
  similarity: number;
  start: number;
  end: number;
  matched_text: string;
}

export interface Citation {
  passage_id: number;
  quote: string;
  covers: string;
  policy_code: string;
  title: string;
  page_start: number;
  page_end: number;
  doc_id: number;
  chunk_id: number;
  quote_check: QuoteCheck;
  cite: string;
}

export interface Contradiction {
  kind: "contradiction" | "exception" | "narrower_scope" | "different_timeframe";
  severity: "high" | "medium" | "low";
  quote: string;
  explanation: string;
  policy_code: string;
  page_start: number;
  page_end: number;
  doc_id: number;
  chunk_id: number;
  cite: string;
}

export interface Candidate {
  cite: string;
  policy_code?: string;
  title: string;
  doc_id?: number;
  chunk_id?: number;
  page_start?: number;
  page_end?: number;
  heading?: string;
  score: number;
  excerpt?: string;
}

export interface Result {
  status: Status;
  coverage_status?: Coverage;
  confidence: number;
  citations: Citation[];
  gap: string;
  reasoning: string;
  reviewer_note: string;
  suggested_language?: string;
  contradictions: Contradiction[];
  discarded_quotes: { quote: string; reason: string; similarity?: number; cite?: string }[];
  error?: string;
  obligation?: string;
  plan_synonyms?: string[];
  regulator_terms?: string[];
  candidates?: Candidate[];
}

export interface Review {
  state: ReviewState;
  note: string;
  updated_at: string;
  citation_override?: { quote?: string; cite?: string };
}

/** One row. Questionnaire rows carry `number`/`question`; guide rows carry `id`/`obligation`. */
export interface Item {
  number?: number;
  question?: string;
  reference?: string;
  form_page?: number;
  id?: string;
  obligation?: string;
  quote?: string;
  page?: number;
  actor?: string;
  strength?: "must" | "should" | "may";
  deadline?: string;
  topic?: string;
  quote_verified?: boolean;
  result: Result | null;
  review: Review;
}

export interface RunSummary {
  id: string;
  kind: "questionnaire" | "guide";
  title: string;
  source_name: string;
  status: "running" | "done" | "error";
  total: number;
  completed: number;
  /** Guide runs extract more obligations than they coverage-check. */
  extracted?: number;
  error: string;
  created_at: string;
  counts: Record<string, number>;
  review: Record<string, number>;
  contradiction_items: number;
}

export interface Run extends RunSummary {
  items: Item[];
}

export interface Health {
  ok: boolean;
  llm_configured: boolean;
  models: { reasoning: string; fast: string };
  corpus: { documents: number; chunks: number; version: string | null };
}

export interface DocRow {
  id: number;
  policy_code: string;
  title: string;
  program: string;
  department: string;
  section: string;
  applicable_to: string;
  effective_date: string;
  revised_date: string;
  n_pages: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<Health>("/api/health"),
  samples: () => req<{ samples: { name: string; kind: string; size_kb: number }[] }>(
    "/api/samples",
  ),
  previewQuestionnaire: (sample: string) =>
    req<{ title: string; count: number }>(
      `/api/questionnaire/preview?sample=${encodeURIComponent(sample)}`,
    ),

  corpus: (params: { program?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.program) qs.set("program", params.program);
    if (params.q) qs.set("q", params.q);
    return req<{ documents: DocRow[]; programs: { program: string; n: number }[] }>(
      `/api/corpus?${qs}`,
    );
  },
  search: (q: string) =>
    req<{ results: Candidate[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=25`),
  context: (docId: number, pageStart: number, pageEnd: number) =>
    req<{ document: Partial<DocRow>; pages: { page: number; text: string }[] }>(
      `/api/document/${docId}/context?page_start=${pageStart}&page_end=${pageEnd}`,
    ),

  runs: () => req<{ runs: RunSummary[] }>("/api/runs"),
  run: (id: string) => req<Run>(`/api/runs/${id}`),
  deleteRun: (id: string) => req<{ ok: boolean }>(`/api/runs/${id}`, { method: "DELETE" }),
  cancelRun: (id: string) =>
    req<{ cancelled: boolean }>(`/api/runs/${id}/cancel`, { method: "POST" }),

  startQuestionnaire: (sample: string, limit?: number) =>
    req<Run>("/api/runs/questionnaire", {
      method: "POST",
      body: JSON.stringify({ sample, limit }),
    }),
  startGuide: (sample: string) =>
    req<Run>("/api/runs/guide", { method: "POST", body: JSON.stringify({ sample }) }),

  upload: async (kind: "questionnaire" | "guide", file: File, limit?: number) => {
    const form = new FormData();
    form.append("file", file);
    const qs = limit ? `?limit=${limit}` : "";
    const res = await fetch(`/api/upload/${kind}${qs}`, { method: "POST", body: form });
    if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);
    return (await res.json()) as Run;
  },

  review: (runId: string, key: string | number, body: { state: ReviewState; note?: string }) =>
    req<Item>(`/api/runs/${runId}/items/${key}/review`, {
      method: "POST",
      body: JSON.stringify({ note: "", ...body }),
    }),
};

/** SSE subscription for a live run. Returns an unsubscribe function. */
export function streamRun(runId: string, onEvent: (e: any) => void): () => void {
  const source = new EventSource(`/api/runs/${runId}/stream`);
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data));
    } catch {
      /* keepalive comment lines are not JSON */
    }
  };
  source.onerror = () => {
    // The server closes the stream once the run is done; that surfaces here as
    // an error. The caller already has the final state from the `done` event.
    source.close();
  };
  return () => source.close();
}

/* ------------------------------------------------------------------ labels */

export const STATUS_LABEL: Record<Status, string> = {
  supported: "Supported",
  partial: "Partial",
  not_found: "Not found",
  error: "Error",
};

export const ANSWER_LABEL: Record<Status, string> = {
  supported: "Yes",
  partial: "Partial",
  not_found: "No",
  error: "—",
};

export const COVERAGE_LABEL: Record<Coverage, string> = {
  covered: "Covered",
  partial: "Partial",
  gap: "Gap",
  error: "Error",
};

export function statusTone(s?: Status | Coverage): "ok" | "warn" | "none" | "alert" {
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
