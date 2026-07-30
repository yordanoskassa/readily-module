import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Candidate, DocRow } from "../lib/api";
import { Chip, Empty, Spinner } from "./bits";

/** The P&P library, plus a raw search box.
 *
 * The search box runs the same lexical layer the answer engine uses, with no
 * model in the loop. It is here so the retrieval step is inspectable rather
 * than a black box — and so the Ctrl-F comparison is easy to demonstrate. */
export function Corpus() {
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [programs, setPrograms] = useState<{ program: string; n: number }[]>([]);
  const [program, setProgram] = useState("");
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    api.corpus({ program: program || undefined, q: filter || undefined }).then((r) => {
      setDocs(r.documents);
      if (r.programs.length) setPrograms(r.programs);
    });
  }, [program, filter]);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      setResults((await api.search(query)).results);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="stack" style={{ gap: 8 }}>
        <div className="label">Policy library</div>
        <h1>The plan&apos;s P&amp;Ps</h1>
        <p className="muted" style={{ maxWidth: 660 }}>
          Everything the answer engine searches. The search box below runs the same
          lexical layer with no model involved, so you can see exactly which passages
          retrieval surfaces before any judgement is applied.
        </p>
      </div>

      {/* ---------------------------------------------- passage search */}
      <div className="card card-pad">
        <form onSubmit={runSearch} className="row" style={{ gap: 8 }}>
          <input
            className="input grow"
            placeholder="Search the full text — e.g. hospice election notice five calendar days"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn" type="submit" disabled={searching}>
            {searching ? "Searching…" : "Search"}
          </button>
          {results && (
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                setResults(null);
                setQuery("");
              }}
            >
              Clear
            </button>
          )}
        </form>

        {results && (
          <div className="stack" style={{ gap: 10, marginTop: 16 }}>
            <div className="label">{results.length} passages</div>
            {results.length === 0 && (
              <p className="small muted">
                No passage matched. Try the plan&apos;s own vocabulary — the answer
                engine does this translation for you automatically.
              </p>
            )}
            {results.map((r, i) => (
              <div key={i} className="card" style={{ padding: 12 }}>
                <div className="row wrap" style={{ gap: 8, marginBottom: 6 }}>
                  <strong className="mono small">{r.cite}</strong>
                  <span className="tiny muted truncate" style={{ maxWidth: 420 }}>
                    {r.title}
                  </span>
                  {r.heading && <Chip tone="plain">{r.heading}</Chip>}
                </div>
                <div className="tiny" style={{ lineHeight: 1.6 }}>
                  {r.excerpt?.slice(0, 420)}…
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------------------------------------------- document list */}
      <div className="card">
        <div className="card-pad row wrap" style={{ gap: 10 }}>
          <input
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="Filter by title, code or department"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            className="input"
            style={{ maxWidth: 190 }}
            value={program}
            onChange={(e) => setProgram(e.target.value)}
          >
            <option value="">All programmes</option>
            {programs.map((p) => (
              <option key={p.program} value={p.program}>
                {p.program} ({p.n})
              </option>
            ))}
          </select>
          <span className="tiny muted">
            {docs ? `${docs.length} documents` : ""}
          </span>
        </div>

        {!docs ? (
          <div className="card-pad">
            <Spinner label="Loading library…" />
          </div>
        ) : docs.length === 0 ? (
          <Empty title="No documents match" />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 92 }}>Policy</th>
                  <th>Title</th>
                  <th style={{ width: 165 }}>Department</th>
                  <th style={{ width: 145 }}>Applies to</th>
                  <th style={{ width: 90 }}>Revised</th>
                  <th style={{ width: 56 }}>Pages</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id} style={{ cursor: "default" }}>
                    <td className="mono tiny">{d.policy_code}</td>
                    <td>
                      <div className="small">{d.title}</div>
                      {d.section && d.section !== "Not Applicable" && (
                        <div className="tiny muted">{d.section}</div>
                      )}
                    </td>
                    <td className="tiny muted">{d.department}</td>
                    <td>
                      <div className="row wrap" style={{ gap: 4 }}>
                        {(d.applicable_to || "")
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean)
                          .map((s) => (
                            <Chip key={s} tone="plain">
                              {s}
                            </Chip>
                          ))}
                      </div>
                    </td>
                    <td className="tiny muted mono">{d.revised_date}</td>
                    <td className="tiny muted mono">{d.n_pages}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
