import type { ReactNode } from "react";
import {
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Chip } from "./bits";
import { Logo, LogoMark } from "./Logo";

/** The three modules this build actually implements. */
export type Section = "audit" | "change" | "policies";

/* Readily's platform surface, taken from their own product copy: "Policies ·
 * Legislation · Regulations · Contracts · Reports · Case Files — all connected
 * on a single platform", under the pillars Audit Review, Regulatory Change
 * Management and Monitoring.
 *
 * Rendering the whole surface — with everything outside this module visibly
 * present but inert — is the honest way to show where the module docks. Nothing
 * here pretends to work: the inactive entries say so on hover. */
type NavEntry = {
  key: Section | string;
  label: string;
  icon: LucideIcon;
  live: boolean;
  note?: string;
};

const WORK: NavEntry[] = [
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
    note: "Delegate universes and data scrubbing. Part of the platform, out of scope for this module.",
  },
];

const LIBRARY: NavEntry[] = [
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
];

const OUT_OF_SCOPE =
  "Part of the Readily platform. Not implemented in this module.";

function NavRow({
  entry,
  active,
  onSelect,
}: {
  entry: NavEntry;
  active: boolean;
  onSelect: (s: Section) => void;
}) {
  const button = (
    <SidebarMenuButton
      isActive={active}
      aria-disabled={!entry.live}
      onClick={() => entry.live && onSelect(entry.key as Section)}
      className={
        entry.live
          ? "data-[active=true]:bg-obsidian data-[active=true]:text-cloud data-[active=true]:font-normal"
          : "cursor-default text-muted-foreground/55 hover:bg-transparent hover:text-muted-foreground/55"
      }
    >
      <entry.icon className={entry.live ? "" : "opacity-50"} />
      <span>{entry.label}</span>
      {!entry.live && (
        <span
          aria-hidden
          className="ml-auto size-1.5 rounded-full bg-muted-foreground/25"
        />
      )}
    </SidebarMenuButton>
  );

  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right" className="max-w-64">
          {entry.note ?? OUT_OF_SCOPE}
        </TooltipContent>
      </Tooltip>
    </SidebarMenuItem>
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
    <SidebarProvider>
      <Sidebar collapsible="icon" className="border-r">
        <SidebarHeader className="gap-3 border-b px-4 py-3.5">
          {/* Full lockup when expanded, glyph alone on the collapsed rail. */}
          <Logo className="h-[15px] self-start text-obsidian group-data-[collapsible=icon]:hidden" />
          <LogoMark className="hidden size-5 text-obsidian group-data-[collapsible=icon]:block" />
          {/* Stands in for the org switcher a real deployment would have. */}
          <div className="flex items-center gap-2 group-data-[collapsible=icon]:hidden">
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-meadow text-[10px] font-medium text-cloud">
              CO
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] leading-tight">CalOptima Health</p>
              <p className="text-[10.5px] leading-tight text-muted-foreground">
                Orange County · Medi-Cal
              </p>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Work</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {WORK.map((e) => (
                  <NavRow
                    key={e.key}
                    entry={e}
                    active={section === e.key}
                    onSelect={onSection}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel>Library</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {LIBRARY.map((e) => (
                  <NavRow
                    key={e.key}
                    entry={e}
                    active={section === e.key}
                    onSelect={onSection}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="border-t group-data-[collapsible=icon]:hidden">
          <p className="px-2 py-1 text-[10.5px] leading-snug text-muted-foreground">
            Regulatory Evidence module. Dimmed items are platform surfaces this
            build does not implement.
          </p>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="min-w-0 bg-background">
        <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-2 border-b bg-card px-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 !h-4" />
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap">
              {crumbs.map((c, i) => {
                const last = i === crumbs.length - 1;
                return (
                  <BreadcrumbItem key={`${c}-${i}`} className="min-w-0">
                    {last ? (
                      <BreadcrumbPage className="truncate">{c}</BreadcrumbPage>
                    ) : (
                      <>
                        <BreadcrumbLink className="cursor-default whitespace-nowrap">
                          {c}
                        </BreadcrumbLink>
                        <BreadcrumbSeparator />
                      </>
                    )}
                  </BreadcrumbItem>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>

          <div className="ml-auto flex items-center gap-2">
            {/* Inert on purpose — platform chrome, not something this build owns. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="hidden items-center gap-2 rounded-md border bg-background px-2.5 py-1 text-xs text-muted-foreground/70 sm:flex">
                  <Search className="size-3.5" />
                  Search everything
                  <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">⌘K</kbd>
                </span>
              </TooltipTrigger>
              <TooltipContent>{OUT_OF_SCOPE}</TooltipContent>
            </Tooltip>
            <Chip tone="info">Module</Chip>
            <span className="grid size-7 place-items-center rounded-full bg-dust text-[11px] font-medium text-stone-700">
              AJ
            </span>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1440px] flex-1 px-5 pb-16 pt-6">
          {children}
        </main>

        <footer className="border-t bg-card px-5 py-3.5 text-xs text-muted-foreground">
          {footer}
        </footer>
      </SidebarInset>
    </SidebarProvider>
  );
}
