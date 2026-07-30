import { useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronRight,
  ClipboardCheck,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCcw,
  Search,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Logo } from "./Logo";

/** The sections this module implements. */
export type Section = "audit" | "change" | "policies";

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
        collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-2.5 py-2",
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
  crumbs: string[];
  footer: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex min-h-screen">
      {/* ---------------------------------------------------------- sidebar
          #faf8f5 is --ds-sidebar, verbatim from Readily's product stylesheet.
          The collapse control lives at the foot of the rail rather than in the
          main header, so it belongs to the thing it operates on. */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r bg-[#faf8f5] md:flex",
          "duration-[var(--motion-base)] ease-[var(--ease-standard)] transition-[width]",
          collapsed ? "w-[60px]" : "w-[232px]",
        )}
      >
        <div className={cn("border-b", collapsed ? "px-2" : "px-4")}>
          {/* Rule between the two identities: Readily is the product, the block
              below is the tenant. Stacked without it they read as one lockup. */}
          <div
            className={cn(
              "flex items-center border-b py-3",
              collapsed ? "justify-center" : "justify-between gap-2",
            )}
          >
            {!collapsed && <Logo className="h-6 shrink-0 text-obsidian" />}
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white hover:text-foreground"
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
            </button>
          </div>

          {/* Stands in for the org switcher a real deployment provides. */}
          <div className={cn("py-3.5", collapsed && "flex justify-center")}>
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

        <nav className={cn("flex-1 py-3", collapsed ? "px-2" : "px-2.5")}>
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
                <TooltipContent>
                  Part of the Readily platform. Not implemented in this module.
                </TooltipContent>
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
