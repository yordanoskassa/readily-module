import { useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  FileText,
  RefreshCcw,
  Search,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Logo, LogoMark } from "./Logo";

/** The sections this module implements. */
export type Section = "audit" | "change" | "policies";

/** A breadcrumb. Give it an `onClick` and it renders as a control — people try
 *  to click the trail to get back, so an inert one is a dead end. */
export type Crumb = string | { label: string; onClick: () => void };

/** Shown wherever Readily's mark appears. This is a take-home exercise built
 *  against Readily's public brand — it is not their product, and nothing here
 *  should be readable as an official build. */
const DISCLAIMER =
  "Independent take-home project. Not affiliated with, endorsed by, or an " +
  "official product of Readily.";

function DemoBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="shrink-0 rounded-full border px-1.5 py-px
                     text-[9.5px] font-medium uppercase tracking-[0.08em]
                     text-muted-foreground"
        >
          Demo
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
        {DISCLAIMER}
      </TooltipContent>
    </Tooltip>
  );
}

/** One flat list — only surfaces this build actually implements. */
const NAV: { key: Section; label: string; icon: LucideIcon; hint: string }[] = [
  {
    key: "audit",
    label: "Audit Review",
    icon: ClipboardCheck,
    hint: "Answer a DHCS Submission Review Form",
  },
  {
    key: "change",
    label: "Regulatory Change",
    icon: RefreshCcw,
    hint: "Pull obligations out of a Policy Guide",
  },
  {
    key: "policies",
    label: "Policies",
    icon: FileText,
    hint: "The 373 P&Ps this module searches",
  },
];

function NavItem({
  entry,
  active,
  collapsed,
  onSelect,
}: {
  entry: (typeof NAV)[number];
  active: boolean;
  collapsed: boolean;
  onSelect: (s: Section) => void;
}) {
  const row = (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(entry.key)}
      className={cn(
        "flex w-full items-center rounded-md text-[13px]",
        "duration-[var(--motion-fast)] ease-[var(--ease-standard)]",
        "transition-[background-color,color]",
        collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-2 py-2",
        active
          ? "bg-obsidian font-medium text-white"
          : "text-slate-700 hover:bg-white",
      )}
    >
      <entry.icon className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{entry.label}</span>}
    </button>
  );

  return (
    <li>
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="right">
          {collapsed ? entry.label : entry.hint}
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
  crumbs: Crumb[];
  footer: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ---------------------------------------------------------- sidebar
          #faf8f5 is --ds-sidebar, verbatim from Readily's product stylesheet.
          The collapse control lives at the foot of the rail rather than in the
          main header, so it belongs to the thing it operates on. */}
      <aside
        className={cn(
          "hidden h-full shrink-0 flex-col border-r bg-[#faf8f5] md:flex",
          "duration-[var(--motion-base)] ease-[var(--ease-standard)] transition-[width]",
          collapsed ? "w-[60px]" : "w-[232px]",
        )}
      >
        <div className={cn("border-b", collapsed ? "px-2" : "px-3")}>
          {/* Rule between the two identities: Readily is the product, the block
              below is the tenant. Stacked without it they read as one lockup. */}
          <div
            className={cn(
              "flex items-center border-b py-3",
              collapsed ? "justify-center" : "gap-2",
            )}
          >
            {/* The logo is Readily's, this project is not. The badge rides with
                the mark everywhere it appears so no screenshot of this tool can
                be mistaken for Readily's actual product. Collapsed there is no
                room for it, so the disclaimer moves into the tooltip. */}
            {collapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <LogoMark className="size-6 text-obsidian" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right">{DISCLAIMER}</TooltipContent>
              </Tooltip>
            ) : (
              <>
                <Logo className="h-6 shrink-0 text-obsidian" />
                <DemoBadge />
              </>
            )}
          </div>

          {/* Stands in for the org switcher a real deployment provides. */}
          <div className={cn("py-3", collapsed && "flex justify-center")}>
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="grid size-7 place-items-center rounded-md bg-meadow text-[11px] font-medium text-white">
                  CO
                </span>
              </TooltipTrigger>
              <TooltipContent side="right">CalOptima Health</TooltipContent>
            </Tooltip>
          ) : (
            <div className="flex items-center gap-2.5">
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-meadow text-[11px] font-medium text-white">
                CO
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium leading-tight">
                  CalOptima Health
                </p>
                <p className="truncate text-[11px] leading-tight text-muted-foreground">
                  Orange County &middot; Medi-Cal
                </p>
              </div>
            </div>
          )}
          </div>
        </div>

        <nav className={cn("flex-1 overflow-y-auto py-3", collapsed ? "px-2" : "px-3")}>
          <ul className="flex flex-col gap-1">
            {NAV.map((e) => (
              <NavItem
                key={e.key}
                entry={e}
                active={section === e.key}
                collapsed={collapsed}
                onSelect={onSection}
              />
            ))}
          </ul>
        </nav>


        {/* Signed-in user sits at the foot of the rail, where the account
            belongs in a product shell. */}
        <div className={cn("shrink-0 border-t py-3", collapsed ? "px-2" : "px-3")}>
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="grid w-full place-items-center rounded-md py-1"
                  aria-label="Alex Jordan, Compliance Analyst"
                >
                  <span className="grid size-7 place-items-center rounded-full bg-obsidian text-[11px] font-medium text-white">
                    AJ
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                Alex Jordan &middot; Compliance Analyst
              </TooltipContent>
            </Tooltip>
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-obsidian text-[11px] font-medium text-white">
                AJ
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium leading-tight">
                  Alex Jordan
                </span>
                <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                  Compliance Analyst
                </span>
              </span>
            </button>
          )}
        </div>
        <div className={cn("shrink-0 border-t py-2", collapsed ? "px-2" : "px-3")}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setCollapsed((v) => !v)}
                aria-expanded={!collapsed}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                className={cn(
                  "flex w-full items-center rounded-md text-[12.5px] text-muted-foreground",
                  "transition-colors hover:bg-white hover:text-foreground",
                  collapsed ? "justify-center py-2" : "gap-2 px-2 py-1.5",
                )}
              >
                {collapsed ? (
                  <ChevronRight className="size-4" />
                ) : (
                  <>
                    <ChevronLeft className="size-4 shrink-0" />
                    <span>Collapse</span>
                  </>
                )}
              </button>
            </TooltipTrigger>
            {collapsed && <TooltipContent side="right">Expand sidebar</TooltipContent>}
          </Tooltip>
        </div>
      </aside>

      {/* ------------------------------------------------------------- main */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="z-40 shrink-0 bg-card">
          <div className="flex h-[52px] items-center gap-4 border-b px-5">
            {/* Small screens drop the sidebar, so the mark — and its badge —
                return here. */}
            <span className="flex shrink-0 items-center gap-2 md:hidden">
              <Logo className="h-6 shrink-0 text-obsidian" />
              <DemoBadge />
            </span>

            <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
              <ol className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
                {crumbs.map((c, i) => {
                  const last = i === crumbs.length - 1;
                  const label = typeof c === "string" ? c : c.label;
                  const onClick = typeof c === "string" ? undefined : c.onClick;
                  return (
                    <li key={`${label}-${i}`} className="flex min-w-0 items-center gap-1.5">
                      {onClick ? (
                        <button
                          onClick={onClick}
                          className="truncate rounded-sm text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                        >
                          {label}
                        </button>
                      ) : (
                        <span
                          aria-current={last ? "page" : undefined}
                          className={cn(
                            "truncate",
                            last ? "font-medium text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {label}
                        </span>
                      )}
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
                <TooltipContent>
                  Part of the Readily platform. Not implemented in this module.
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Help"
                    className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <CircleHelp className="size-[18px]" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  Part of the Readily platform. Not implemented in this module.
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-5 pb-12 pt-6">
          <div className="mx-auto w-full max-w-[1320px]">{children}</div>
        </main>

        <footer className="shrink-0 border-t bg-card px-5 py-3 text-xs text-muted-foreground">
          {footer}
          {/* Stated outright, not just on hover — the badge catches the eye,
              this is the sentence someone can actually read and quote. */}
          <span className="mt-1 block text-[11px] text-slate-500">{DISCLAIMER}</span>
        </footer>
      </div>
    </div>
  );
}
