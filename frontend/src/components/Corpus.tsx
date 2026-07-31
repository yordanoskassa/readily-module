import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { api } from "@/lib/api";
import type { Candidate, DocRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip, Empty, Spinner } from "./bits";

const ALL = "__all__";

/* A search hit opens into the page it came from.
 *
 * The excerpt is a truncated chunk, which is enough to judge relevance and not
 * enough to judge meaning — the sentence that changes the answer is usually the
 * one just outside it. Clicking pulls the surrounding page text from the same
 * endpoint the evidence panel uses, so "read it in context" behaves the same
 * way wherever she is in the app. */
function SearchHit({ hit }: { hit: Candidate }) {
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<{ page: number; text: string }[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || pages || !hit.doc_id) return;
    let live = true;
    api
      .context(hit.doc_id, hit.page_start ?? 1, hit.page_end ?? hit.page_start ?? 1)
      .then((r) => live && setPages(r.pages))
      .catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [open, pages, hit.doc_id, hit.page_start, hit.page_end]);

  return (
    <Card className="gap-1.5 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 text-left"
      >
        {open ? (
          <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <strong className="font-mono text-[13px]">{hit.cite}</strong>
          <span className="truncate text-xs text-muted-foreground">{hit.title}</span>
          {hit.heading && <Chip>{hit.heading}</Chip>}
        </span>
      </button>

      {!open && (
        <p className="pl-5 text-xs leading-relaxed text-muted-foreground">
          {hit.excerpt?.slice(0, 420)}…
        </p>
      )}

      {open && (
        <div className="pl-5">
          {error ? (
            <p className="text-xs text-muted-foreground">Could not load the page: {error}</p>
          ) : !pages ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-md border bg-muted/40 px-3.5 py-3 font-mono text-[11.5px] leading-relaxed">
              {pages.map((pg) => (
                <div key={pg.page} className="mb-3.5 whitespace-pre-wrap break-words">
                  <div className="label-1 mb-1">Page {pg.page}</div>
                  {pg.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** The P&P library, plus a raw search box.
 *
 *  The search box runs the same lexical layer the answer engine uses, with no
 *  model in the loop — so retrieval is inspectable rather than a black box, and
 *  the Ctrl-F comparison is easy to demonstrate. */
export function Corpus() {
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [programs, setPrograms] = useState<{ program: string; n: number }[]>([]);
  const [program, setProgram] = useState(ALL);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let live = true;
    // Debounced so typing in the filter does not fire a request per keystroke.
    const t = setTimeout(() => {
      api
        .corpus({
          program: program === ALL ? undefined : program,
          q: filter || undefined,
        })
        .then((r) => {
          if (!live) return;
          setDocs(r.documents);
          if (r.programs.length) setPrograms(r.programs);
        });
    }, 220);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [program, filter]);

  const runSearch = useCallback(
    async (e: React.FormEvent) => {
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
    },
    [query],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="label-1">Policy library</span>
        <h1 className="text-[34px] leading-tight">The plan&apos;s P&amp;Ps</h1>
        <p className="max-w-2xl text-muted-foreground">
          Everything the answer engine searches. The search box below runs the same lexical layer
          with no model involved, so you can see exactly which passages retrieval surfaces before
          any judgement is applied.
        </p>
      </div>

      {/* ---------------------------------------------- passage search */}
      <Card className="p-5">
        <form onSubmit={runSearch} className="flex flex-wrap gap-2">
          <Input
            className="min-w-64 flex-1"
            placeholder="Search full text — e.g. hospice election notice five calendar days"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button type="submit" disabled={searching}>
            <Search className="size-3.5" />
            {searching ? "Searching…" : "Search"}
          </Button>
          {results && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setResults(null);
                setQuery("");
              }}
            >
              <X className="size-3.5" /> Clear
            </Button>
          )}
        </form>

        {results && (
          <div className="mt-4 flex flex-col gap-2.5">
            <span className="label-1">{results.length} passages</span>
            {results.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No passage matched. Try the plan&apos;s own vocabulary — the answer engine does
                that translation for you automatically.
              </p>
            )}
            {results.map((r, i) => (
              <SearchHit key={i} hit={r} />
            ))}
          </div>
        )}
      </Card>

      {/* ---------------------------------------------- document list */}
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-3 p-4">
          <Input
            className="max-w-80"
            placeholder="Filter by title, code or department"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <Select value={program} onValueChange={setProgram}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All programmes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All programmes</SelectItem>
              {programs.map((p) => (
                <SelectItem key={p.program} value={p.program}>
                  {p.program} ({p.n})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {docs ? `${docs.length} documents` : ""}
          </span>
        </div>

        {!docs ? (
          <div className="p-5">
            <Spinner label="Loading library…" />
          </div>
        ) : docs.length === 0 ? (
          <Empty title="No documents match" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[92px]">Policy</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="w-[165px]">Department</TableHead>
                <TableHead className="w-[150px]">Applies to</TableHead>
                <TableHead className="w-[92px]">Revised</TableHead>
                <TableHead className="w-14">Pages</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((d) => (
                <TableRow key={d.id} className="align-top hover:bg-muted/40">
                  <TableCell className="font-mono text-[11px]">{d.policy_code}</TableCell>
                  <TableCell>
                    <p className="whitespace-normal text-sm">{d.title}</p>
                    {d.section && d.section !== "Not Applicable" && (
                      <p className="text-xs text-muted-foreground">{d.section}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{d.department}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(d.applicable_to || "")
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .map((s) => (
                          <Chip key={s}>{s}</Chip>
                        ))}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {d.revised_date}
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {d.n_pages}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
