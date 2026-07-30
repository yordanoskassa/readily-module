import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { Health, RunSummary } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Corpus } from "./components/Corpus";
import { Launcher } from "./components/Launcher";
import { RunView } from "./components/RunView";
import { Shell } from "./components/Shell";
import type { Section } from "./components/Shell";

/** Section → the module kind it drives. `policies` has no runs of its own. */
const KIND: Record<Section, "questionnaire" | "guide" | null> = {
  audit: "questionnaire",
  change: "guide",
  policies: null,
};

const CRUMB: Record<Section, string[]> = {
  audit: ["Work", "Audit Review"],
  change: ["Work", "Regulatory Change"],
  policies: ["Library", "Policies"],
};

export default function App() {
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

  const crumbs = useMemo(() => {
    const base = CRUMB[section];
    if (!runId) return base;
    return [...base, runTitle[runId] ?? "Run"];
  }, [section, runId, runTitle]);

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
