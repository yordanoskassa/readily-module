import type { ReactNode } from "react";
import {
  ChevronRight,
  ClipboardCheck,
  FileStack,
  FileText,
  FolderOpen,
  Gavel,
  Landmark,
  RefreshCcw,
  ScrollText,
  Search,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Logo } from "./Logo";

/** The sections this module implements. */
export type Section = "audit" | "change" | "policies";

/* Readily's platform surface, taken from their own product copy — "Policies ·
 * Legislation · Regulations · Contracts · Reports · Case Files, all connected on
 * a single platform" — under the Audit Review / Regulatory Change Management /
 * Monitoring pillars.
 *
 * Rendering the whole surface, with everything outside this module visibly inert,
 * is what makes the module's place in the platform legible. Nothing here pretends
 * to work: the dimmed entries say so on hover. */
type NavEntry = {
  key: Section | string;
  label: string;
  icon: LucideIcon;
  live: boolean;
  note?: string;
};

const OUT_OF_SCOPE = "Part of the Readily platform. Not implemented in this module.";

const GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: "Work",
    items: [
      {
        key: "audit",
        label: "Audit Review",
        icon: ClipboardCheck,
        live: true,
        note: "Submission Review Forms — implemented in this module.",
      },
      {
        key: "change",
        label: "Regulatory Change",
        icon: RefreshCcw,
        live: true,
        note: "Policy Guides and APLs — implemented in this module.",
      },
      {
        key: "monitoring",
        label: "Monitoring",
        icon: ShieldCheck,
        live: false,
        note: "Delegate universes and data scrubbing. Part of the platform, out of scope here.",
      },
    ],
  },
  {
    label: "Library",
    items: [
      {
        key: "policies",
        label: "Policies",
        icon: FileText,
        live: true,
        note: "373 P&Ps indexed — the corpus this module searches.",
      },
      { key: "legislation", label: "Legislation", icon: Landmark, live: false },
      { key: "regulations", label: "Regulations", icon: Gavel, live: false },
      { key: "contracts", label: "Contracts", icon: ScrollText, live: false },
      { key: "reports", label: "Reports", icon: FileStack, live: false },
      { key: "casefiles", label: "Case Files", icon: FolderOpen, live: false },
    ],
  },
];

function NavItem({
  entry,
  active,
  onSelect,
}: {
  entry: NavEntry;
  active: boolean;
  onSelect: (s: Section) => void;
}) {
  const row = (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      aria-disabled={!entry.live}
      onClick={() => entry.live && onSelect(entry.key as Section)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px]",
        "duration-[var(--motion-fast)] ease-[var(--ease-standard)]",
        "transition-[background-color,color]",
        entry.live
          ? active
            ? "bg-obsidian font-medium text-white"
            : "text-slate-700 hover:bg-white"
          : "cursor-default text-slate-400",
      )}
    >
      <entry.icon className={cn("size-4 shrink-0", !entry.live && "opacity-60")} />
      <span className="truncate">{entry.label}</span>
      {!entry.live && (
        <span aria-hidden className="ml-auto size-1.5 shrink-0 rounded-full bg-slate-300" />
      )}
    </button>
  );

  return (
    <li>
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="right" className="max-w-64">
          {entry.note ?? OUT_OF_SCOPE}
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

export function Shell({
  section,
  onSection,
  crumbs,
  footer,
  children,
}: {
  section: Section;
  onSection: (s: Section) => void;
  crumbs: string[];
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      {/* ---------------------------------------------------------- sidebar
          #faf8f5 is --ds-sidebar, verbatim from Readily's product stylesheet.
          Fixed width with no collapse control — the toggle was a fiddly
          affordance for no real gain at this width. */}
      <aside className="hidden w-[236px] shrink-0 flex-col border-r bg-[#faf8f5] md:flex">
        <div className="flex flex-col gap-3.5 border-b px-4 py-4">
          <Logo className="h-7 self-start text-obsidian" />
          {/* Stands in for the org switcher a real deployment provides. */}
          <div className="flex items-center gap-2.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-meadow text-[11px] font-medium text-white">
              CO
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium leading-tight">
                CalOptima Health
              </p>
              <p className="truncate text-[11px] leading-tight text-muted-foreground">
                Orange County · Medi-Cal
              </p>
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 py-4">
          {GROUPS.map((g) => (
            <div key={g.label} className="mb-5">
              <p className="label-1 px-2.5 pb-1.5">{g.label}</p>
              <ul className="flex flex-col gap-0.5">
                {g.items.map((e) => (
                  <NavItem
                    key={e.key}
                    entry={e}
                    active={section === e.key}
                    onSelect={onSection}
                  />
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <p className="border-t px-4 py-3 text-[11px] leading-snug text-muted-foreground">
          Regulatory Evidence module. Dimmed items are platform surfaces this build
          does not implement.
        </p>
      </aside>

      {/* ------------------------------------------------------------- main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 bg-card">
          <div className="flex h-[52px] items-center gap-4 border-b px-5">
            {/* Small screens drop the sidebar, so the mark returns here. */}
            <Logo className="h-6 shrink-0 text-obsidian md:hidden" />

            <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
              <ol className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
                {crumbs.map((c, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <li key={`${c}-${i}`} className="flex min-w-0 items-center gap-1.5">
                      <span
                        aria-current={last ? "page" : undefined}
                        className={cn(
                          "truncate",
                          last ? "font-medium text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {c}
                      </span>
                      {!last && <ChevronRight className="size-3 shrink-0 text-slate-400" />}
                    </li>
                  );
                })}
              </ol>
            </nav>

            <div className="flex shrink-0 items-center gap-3">
              {/* Platform chrome, inert on purpose and labelled as such. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="hidden items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-xs text-muted-foreground lg:flex">
                    <Search className="size-3.5" />
                    Search
                    <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
                      &#8984;K
                    </kbd>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{OUT_OF_SCOPE}</TooltipContent>
              </Tooltip>
              <span className="grid size-8 place-items-center rounded-full bg-meadow text-[11px] font-medium text-white">
                AJ
              </span>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-5 pb-16 pt-6">
          {children}
        </main>

        <footer className="border-t bg-card px-5 py-3.5 text-xs text-muted-foreground">
          {footer}
        </footer>
      </div>
    </div>
  );
}
