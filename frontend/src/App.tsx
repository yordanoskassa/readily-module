import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { Health, RunSummary } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Corpus } from "./components/Corpus";
import { Landing } from "./components/Landing";
import { Launcher } from "./components/Launcher";
import { RunView } from "./components/RunView";
import { Shell } from "./components/Shell";
import type { Crumb, Section } from "./components/Shell";

/** Section → the module kind it drives. `policies` has no runs of its own. */
const KIND: Record<Section, "questionnaire" | "guide" | null> = {
  audit: "questionnaire",
  change: "guide",
  policies: null,
};

/* Flat, matching the sidebar — there are no Work/Library groups to sit under. */
const CRUMB: Record<Section, string[]> = {
  audit: ["Audit Review"],
  change: ["Regulatory Change"],
  policies: ["Policies"],
};

/* The landing page is shown once and then remembered, so a reviewer who reloads
 * the app does not have to click past it every time. `?intro` forces it back. */
const SEEN_KEY = "readily.intro.seen";

function introWanted(): boolean {
  if (new URLSearchParams(window.location.search).has("intro")) return true;
  try {
    return localStorage.getItem(SEEN_KEY) !== "1";
  } catch {
    return true; // private mode: show it rather than crash
  }
}

export default function App() {
  const [intro, setIntro] = useState(introWanted);
  const [section, setSection] = useState<Section>("audit");
  const [health, setHealth] = useState<Health | null>(null);
  // One open run per module, so moving between sections keeps your place.
  const [openRun, setOpenRun] = useState<Record<string, string | null>>({
    audit: null,
    change: null,
  });
  const [runTitle, setRunTitle] = useState<Record<string, string>>({});

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

  const openInSection = useCallback(
    (id: string, summary?: RunSummary) => {
      setOpenRun((prev) => ({ ...prev, [section]: id }));
      if (summary?.source_name) {
        setRunTitle((prev) => ({ ...prev, [id]: summary.source_name }));
      }
    },
    [section],
  );
  const closeInSection = useCallback(
    () => setOpenRun((prev) => ({ ...prev, [section]: null })),
    [section],
  );

  const kind = KIND[section];
  const runId = kind ? (openRun[section] ?? null) : null;

  /* With a run open, the section crumb becomes the way back to its run list —
   * that trail is the first thing people click to leave a run. */
  const crumbs = useMemo<Crumb[]>(() => {
    const base = CRUMB[section];
    if (!runId) return base;
    return [
      ...base.map((label) => ({ label, onClick: closeInSection })),
      runTitle[runId] ?? "Run",
    ];
  }, [section, runId, runTitle, closeInSection]);

  const enter = useCallback(() => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* private mode — the gate just reappears next load */
    }
    setIntro(false);
  }, []);

  if (intro) return <Landing onEnter={enter} />;

  return (
    <TooltipProvider delayDuration={250}>
      <Shell
        section={section}
        onSection={setSection}
        crumbs={crumbs}
        footer={
          health ? (
            <>
              {health.corpus.documents} policies · {health.corpus.chunks} indexed
              passages ·{" "}
              {health.llm_configured
                ? `${health.models.reasoning} for judgement, ${health.models.fast} for retrieval`
                : "no API key configured"}
            </>
          ) : (
            "…"
          )
        }
      >
        {kind === null ? (
          <Corpus />
        ) : runId ? (
          <RunView runId={runId} onExit={closeInSection} />
        ) : (
          <Launcher
            kind={kind}
            health={health}
            onStarted={openInSection}
            onOpen={openInSection}
          />
        )}
      </Shell>
    </TooltipProvider>
  );
}
