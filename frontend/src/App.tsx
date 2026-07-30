import { useEffect, useState } from "react";
import { api } from "./lib/api";
import type { Health } from "./lib/api";
import { Corpus } from "./components/Corpus";
import { Launcher } from "./components/Launcher";
import { RunView } from "./components/RunView";

type Tab = "questionnaire" | "guide" | "corpus";

export default function App() {
  const [tab, setTab] = useState<Tab>("questionnaire");
  const [health, setHealth] = useState<Health | null>(null);
  // One open run per module, so switching tabs does not lose your place.
  const [openRun, setOpenRun] = useState<Record<string, string | null>>({
    questionnaire: null,
    guide: null,
  });

  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
  }, []);

  const runId = tab === "corpus" ? null : (openRun[tab] ?? null);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img src="/logo-readily.svg" alt="Readily" />
          <span className="divider" />
          <span className="module">Regulatory Evidence</span>
        </div>
        <nav className="tabs" role="tablist">
          {(
            [
              ["questionnaire", "Submission forms"],
              ["guide", "Policy guides"],
              ["corpus", "Policy library"],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              className="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="main">
        {tab === "corpus" ? (
          <Corpus />
        ) : runId ? (
          <RunView
            runId={runId}
            onExit={() => setOpenRun((p) => ({ ...p, [tab]: null }))}
          />
        ) : (
          <Launcher
            kind={tab}
            health={health}
            onStarted={(id) => setOpenRun((p) => ({ ...p, [tab]: id }))}
            onOpen={(id) => setOpenRun((p) => ({ ...p, [tab]: id }))}
          />
        )}
      </main>

      <footer
        className="tiny muted"
        style={{
          borderTop: "1px solid var(--line)",
          padding: "14px 20px",
          background: "var(--cloud)",
        }}
      >
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
  );
}
