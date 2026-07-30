import type { ReactNode } from "react";
import { ChevronRight, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Logo } from "./Logo";

/** The sections this module implements. */
export type Section = "audit" | "change" | "policies";

/** Two primary tabs — the two pieces of work — plus the library they read from. */
const TABS: { key: Section; label: string; primary: boolean }[] = [
  { key: "audit", label: "Audit Review", primary: true },
  { key: "change", label: "Regulatory Change", primary: true },
  { key: "policies", label: "Policies", primary: false },
];

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
    <div className="flex min-h-screen flex-col">
      {/* -- top bar: logo, tabs, chrome ---------------------------------- */}
      <header className="sticky top-0 z-40 bg-card">
        <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center gap-6 px-5">
          {/* 20px tall lockup — the wordmark is legible at this size, unlike
              the 14px it was before. */}
          <Logo className="h-5 shrink-0 text-obsidian" />

          <nav className="flex items-stretch self-stretch" role="tablist">
            {TABS.map((t) => {
              const active = section === t.key;
              return (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => onSection(t.key)}
                  className={cn(
                    "relative -mb-px flex items-center px-4 text-[13px] transition-colors",
                    "border-b-2 duration-[var(--motion-fast)] ease-[var(--ease-standard)]",
                    active
                      ? "border-obsidian font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                    !t.primary && "text-[12.5px]",
                  )}
                >
                  {t.label}
                </button>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {/* Platform chrome, inert on purpose — labelled so it does not read
                as something this build owns. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="hidden items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-xs text-muted-foreground md:flex">
                  <Search className="size-3.5" />
                  Search
                  <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">⌘K</kbd>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Part of the Readily platform. Not implemented in this module.
              </TooltipContent>
            </Tooltip>

            <span className="hidden text-right leading-tight lg:block">
              <span className="block text-[12.5px] font-medium">CalOptima Health</span>
              <span className="block text-[11px] text-muted-foreground">
                Orange County · Medi-Cal
              </span>
            </span>
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-meadow text-[11px] font-medium text-white">
              AJ
            </span>
          </div>
        </div>

        {/* -- breadcrumb rail ------------------------------------------- */}
        <div className="border-t bg-warm-200">
          <div className="mx-auto flex h-9 w-full max-w-[1440px] items-center px-5">
            <nav aria-label="Breadcrumb" className="min-w-0">
              <ol className="flex min-w-0 items-center gap-1.5 text-[12px]">
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
                      {!last && (
                        <ChevronRight className="size-3 shrink-0 text-slate-400" />
                      )}
                    </li>
                  );
                })}
              </ol>
            </nav>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-5 pb-16 pt-6">
        {children}
      </main>

      <footer className="border-t bg-card px-5 py-3.5">
        <div className="mx-auto w-full max-w-[1440px] text-xs text-muted-foreground">
          {footer}
        </div>
      </footer>
    </div>
  );
}
