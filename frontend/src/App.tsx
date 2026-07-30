import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Health } from "@/lib/api";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Corpus } from "./components/Corpus";
import { Launcher } from "./components/Launcher";
import { RunView } from "./components/RunView";

type Tab = "questionnaire" | "guide" | "corpus";

const TABS: [Tab, string][] = [
  ["questionnaire", "Submission forms"],
  ["guide", "Policy guides"],
  ["corpus", "Policy library"],
];

export default function App() {
  const [tab, setTab] = useState<Tab>("questionnaire");
  const [health, setHealth] = useState<Health | null>(null);
  // One open run per module, so switching tabs does not lose your place.
  const [openRun, setOpenRun] = useState<Record<string, string | null>>({
    questionnaire: null,
    guide: null,
  });

  useEffect(() => {
    let live = true;
    api
      .health()
      .then((h) => live && setHealth(h))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const openInTab = useCallback(
    (id: string) => setOpenRun((prev) => ({ ...prev, [tab]: id })),
    [tab],
  );
  const closeInTab = useCallback(
    () => setOpenRun((prev) => ({ ...prev, [tab]: null })),
    [tab],
  );

  const runId = tab === "corpus" ? null : (openRun[tab] ?? null);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-50 flex h-12 items-stretch justify-between border-b bg-card">
          <div className="flex items-center gap-3 px-5">
            <img src="/logo-readily.svg" alt="Readily" className="block h-[15px]" />
            <span className="h-[18px] w-px bg-border" />
            <span className="label-1">Regulatory Evidence</span>
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="justify-center">
            <TabsList className="h-auto self-stretch rounded-none border-0 bg-transparent p-0">
              {TABS.map(([key, label]) => (
                <TabsTrigger
                  key={key}
                  value={key}
                  className="h-12 rounded-none border-0 border-l px-5 text-[11px] uppercase tracking-[0.06em] text-muted-foreground data-[state=active]:bg-obsidian data-[state=active]:text-cloud data-[state=active]:shadow-none"
                >
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </header>

        <main className="mx-auto w-full max-w-[1440px] flex-1 px-5 pb-16 pt-7">
          {tab === "corpus" ? (
            <Corpus />
          ) : runId ? (
            <RunView runId={runId} onExit={closeInTab} />
          ) : (
            <Launcher
              kind={tab}
              health={health}
              onStarted={openInTab}
              onOpen={openInTab}
            />
          )}
        </main>

        <footer className="border-t bg-card px-5 py-3.5 text-xs text-muted-foreground">
          {health ? (
            <>
              {health.corpus.documents} policies · {health.corpus.chunks} indexed passages ·{" "}
              {health.llm_configured
                ? `${health.models.reasoning} for judgement, ${health.models.fast} for retrieval`
                : "no API key configured"}
            </>
          ) : (
            "…"
          )}
        </footer>
      </div>
    </TooltipProvider>
  );
}
