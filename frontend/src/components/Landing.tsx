import { ArrowRight, Code2, ShieldCheck } from "lucide-react";
import { Logo } from "./Logo";

/* The front door.
 *
 * Two things have to land before anyone clicks into the module: what this is,
 * and what it is not. The disclaimer is not fine print here — the whole page is
 * built against Readily's brand, so the "independent take-home" line sits above
 * the fold rather than tucked in a tooltip like it is inside the app.
 *
 * Dismissal is remembered, because a reviewer who opens the app twice should
 * not have to walk past the trailer again. `?intro` forces it back for a demo. */

const REPO = "https://github.com/yordanoskassa/readily-module";

/* Swap for the walkthrough. `youtube-nocookie` avoids setting tracking cookies
 * on a page the reviewer never opted into. */
const VIDEO_ID = "aqz-KE-bpKQ";

const FACTS = [
  ["373", "policy PDFs indexed"],
  ["3,632", "pages of source text"],
  ["168", "citations, all verified"],
];

export function Landing({ onEnter }: { onEnter: () => void }) {
  return (
    <div className="min-h-screen overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-10">
        <header className="flex items-center justify-between">
          <Logo className="h-6 text-obsidian" />
          <a
            href={REPO}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-muted"
          >
            <Code2 className="size-4" />
            View the code
          </a>
        </header>

        <div className="flex items-center gap-2 pt-8 text-[12px] text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0" />
          Independent take-home project. Not affiliated with, endorsed by, or an
          official product of Readily.
        </div>

        <main className="pt-6">
          <h1 className="max-w-3xl text-[34px] font-semibold leading-[1.15] tracking-tight">
            Answer a DHCS Submission Review Form with evidence you can defend.
          </h1>
          <p className="max-w-2xl pt-4 text-[15px] leading-relaxed text-muted-foreground">
            Alex spends three days per submission proving compliance against 300
            policy PDFs, because a wrong citation becomes a state finding. This
            module does the finding and the cross-checking — then verifies every
            quote character-for-character against the source document, so a
            citation the model invented is discarded rather than shown.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-7">
            <button
              onClick={onEnter}
              className="inline-flex items-center gap-2 rounded-md bg-meadow px-4 py-2.5 text-[14px] font-medium text-white transition-opacity hover:opacity-90"
            >
              Open the module
              <ArrowRight className="size-4" />
            </button>
            <span className="text-[12px] text-muted-foreground">
              Two completed runs are already loaded — no API key needed to look
              around.
            </span>
          </div>

          <div className="mt-9 overflow-hidden rounded-xl border border-border bg-muted">
            <div className="aspect-video">
              <iframe
                className="size-full"
                src={`https://www.youtube-nocookie.com/embed/${VIDEO_ID}`}
                title="Walkthrough"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          </div>

          <dl className="grid grid-cols-3 gap-4 pt-8">
            {FACTS.map(([n, label]) => (
              <div key={label} className="rounded-lg border border-border p-4">
                <dt className="text-[22px] font-semibold tracking-tight">{n}</dt>
                <dd className="pt-0.5 text-[12px] text-muted-foreground">
                  {label}
                </dd>
              </div>
            ))}
          </dl>
        </main>

        <footer className="pt-10 text-[12px] text-muted-foreground">
          Built against a real corpus of public CalOptima Health policies.
        </footer>
      </div>
    </div>
  );
}
