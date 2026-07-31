# Readily Module — Regulatory Evidence

> **Not a Readily product.** This is an independent take-home exercise, built against
> Readily's publicly available brand to show what the module would look like inside their
> product. It is not affiliated with, endorsed by, or an official build of Readily, and
> the logo and colours belong to them. The UI carries the same notice so no screenshot of
> it can be mistaken for the real thing.

A module for Alex, a compliance analyst at a Medi-Cal managed care plan, covering the two
jobs she described:

1. **Answer a DHCS Submission Review Form.** 60–200 questions of the form *"Does your P&P
   state that…"*, each needing the exact passage in the plan's own policies that proves
   compliance, quoted and page-cited. She said this takes three full days.
2. **Read a DHCS Policy Guide.** 100+ pages of narrative, updated yearly, from which every
   concrete obligation must be extracted and checked against existing P&Ps *before* a
   questionnaire arrives. *"A single paragraph might contain one obligation or six, and I
   won't know until I've worked through it. I miss things. Everyone misses things."*

Both run against a real corpus: 373 CalOptima Health policy PDFs, 3,632 pages, indexed
into 7,289 page-anchored passages.

---

## What problem this actually solves

The bottleneck is not search speed. It is **verification cost** — Alex's three days go on
convincing herself an answer is right, because a wrong citation becomes a state finding
that reaches DHCS and her board. She said she would rather take the three days than be
fast and wrong.

So the module does not try to be a search box that returns links. Each question produces a
**reviewable evidence packet** where every claim is cheap to falsify, and nothing is
submitted on her behalf.

### The vocabulary problem is real and measurable

Her example: the regulator says "retrospective request", the policy says "post-service
review". I measured the same effect in this corpus before writing any model code, probing
`GG.1503` (the hospice policy) with the questionnaire's own phrasing:

| The regulator's words | Literal Ctrl-F | Tokenized search |
| --- | --- | --- |
| "six months" | **0 hits** — the policy writes "six **(6)** months" | ✅ pages 2, 18, 9 |
| "90-day" | **0 hits** — the policy writes "90) calendar day" | ✅ pages 3, 2, 5 |
| "out-of-Network" | 0 hits | absent **from `GG.1503`** |
| "Medicare certification" / "NPI" | 0 hits | absent **from `GG.1503`** |

Note the scope of those last two rows: this probe covers one policy, not the library. I
originally read them as gaps in the corpus, and that was wrong — `GG.1651` and `GG.1800`
carry the NPI and CDPH language. The correction is worked through under
[Measured results](#measured-results), because getting that distinction wrong is the
failure mode the whole tool is built against.

Two things follow. Tokenizing beats Ctrl-F on the parenthetical-numeral style that pervades
these documents. And the obligation for a question is often spread across policies from
different departments — so the tool has to be able to say **"not found"** confidently when
the library really is silent, without mistaking "not in the policy I expected" for "not
anywhere". That test is pinned in
[`test_parsing.py`](backend/tests/test_parsing.py).

---

## How it works

```
Submission Review Form (PDF)
        │  parse → 64 questions
        ▼
  ┌─ per question ────────────────────────────────────────────────┐
  │ 1. expand   Sonnet 5 rewrites the question in the plan's      │
  │             vocabulary → obligation, synonyms, 4-6 queries    │
  │ 2. search   each phrasing queried separately over SQLite      │
  │             FTS5; fused by reciprocal rank; documents         │
  │             shortlisted before passages                       │
  │ 3. assess   Opus 5 returns supported / partial / not_found    │
  │             with quotes, confidence, the gap, and the         │
  │             judgement call to double-check                    │
  │ 4. VERIFY   every quote checked against the source document   │
  │             — no model output is trusted here                 │
  │ 5. sweep    re-read the cited policy for contradictions,      │
  │             exceptions, narrower scope, different timeframes  │
  └───────────────────────────────────────────────────────────────┘
        ▼
  streamed to the UI as each answer lands → review → CSV
```

Step 2 sends the top-ranked passages. Setting `EVIDENCE_MODE=documents` sends the complete
text of the shortlisted policies instead — measured, and off by default, for the reasons in
[Whole-document mode](#whole-document-mode-evidence_modedocuments--measured-not-the-default).

Once the batch finishes, each row is a starting point rather than a verdict.
`ask` answers a follow-up from the passages already retrieved (one cheap call —
it settles the Medi-Cal-vs-OneCare question the reviewer note keeps raising).
`redirect` re-runs one item with a free-text hint and/or a hard filter to named
policies. `swap` cites a different passage from the runners-up. All three are
held to the same verbatim check, and a quote you type that fails is **rejected
rather than quietly replaced** with different real text from the passage.

### The trust layer

Two mechanisms, deliberately independent because they fail differently.

**Quote verification is pure text matching** ([`verify.py`](backend/app/verify.py)). After
the model returns a quote, the quote is located in the source document. A quote that cannot
be found is **discarded and listed as withheld**, never shown as evidence — and an
assessment claiming support with no surviving quote is downgraded to `not_found`, so the
guard cannot be cosmetic.

Character similarity alone is not enough, and the adversarial tests proved it. Fuzzy
matching accepted `"twelve (12) months"` against a source reading `"six (6) months"` at
0.88 similarity, and accepted an inserted `"does not"` negation at 0.91. Both are exactly
the citations that become findings. So a fuzzy match must additionally agree **exactly** on:

- numerals and number words — blocks a changed timeframe or threshold
- negations — `not`, `never`, `without`, `except`, `unless`
- obligation strength — `must` vs `may`, `shall` vs `should`
- scope quantifiers — `all` vs `some`, `only`, `each`
- temporal direction and units — `before`/`after`, `prior`, `calendar`/`business`

Six meaning-inverting edits scoring 0.85–0.97 are blocked; genuine typos and PDF
line-wrapping still verify. See [`test_verify.py`](backend/tests/test_verify.py).

**Contradiction sweep** is the model judging the failure mode Alex named — *"I find
something that looks right but then there's a sentence two pages later that contradicts
it."* The cited policy is re-searched for qualifying language and adjudicated. Its quotes
face the same verbatim standard.

### Retrieval

SQLite FTS5, which ships inside CPython — so the whole search layer has no external
service, and the index is one file baked into the image. Deploys stay boring.

Documents are ranked before passages, mirroring how the work is actually done (decide which
P&P should own the obligation, then read it) and stopping a keyword-dense page in an
unrelated policy from crowding out the right document. Reciprocal rank fusion combines the
per-phrasing rankings without needing to normalise bm25 scores between queries of different
lengths.

### Whole-document mode (`EVIDENCE_MODE=documents`) — measured, not the default

Passage retrieval can fail silently: if FTS5 never surfaces the right chunk there is no
quote to verify and no contradiction to sweep, and the run reports a confident `not_found`.
The trust layer covers fabrication, not absence.

These policies are small — 9.7 pages and ~6.2k tokens on average — so the alternative is to
stop ranking passages and send the complete text of the shortlisted policies instead.
Retrieval then only has to get the *document* right. Setting `EVIDENCE_MODE=documents`
switches the questionnaire, the guide coverage pass, and the re-run/ask actions onto that
path; page numbers become derived from where the quote is physically located rather than
claimed by the model, and every other guarantee is unchanged.

I ran it against the 12 questions the 64-question run below returned `not_found` for. Eight
became `partial`, producing **26 citations, all 26 verified exact** — independently
re-checked against the raw page text, not via `verify.py`. The four that stayed `not_found`
did so after reading whole policies, and Q41's confidence rose 78 → 86.

But the mechanism is not what I first assumed. Reconstructing what passage mode had actually
retrieved for each of those eight:

| | count | |
| --- | --- | --- |
| Cited text was never retrieved (recall failure) | 1 | Q7 |
| Some cited text retrieved | 4 | Q9, Q13, Q21, Q49 |
| **All cited text was already in front of the model** | **3** | Q17, Q39, Q50 |

So whole-document context is mostly buying *judgement*, not recall. Q7 is the one clean
recall failure — `GG.1503` was absent from all 30 ranked passages, and passage mode answered
`not_found` at 82% confidence while `GG.1503` p. 3 says *"CalOptima Health shall not require
prior authorization for Hospice Care services under Routine Home Care, Continuous Home Care,
and Respite Care lev[els]"*.

Two supporting changes the measurements forced. Document ranking in this mode uses the mean
of a document's three best chunks rather than its single best, because a glossary contains
one matching line for every term in the corpus — `AA.1000` (Medi-Cal Glossary, 66k tokens)
and `MA.1001` (OneCare Glossary, 41k) were taking 72% of the context budget on a hospice
question. And a per-document share cap keeps one outsized policy from crowding out several
smaller ones, since the corpus runs from ~4.9k tokens at the median to ~66k at the top.

**Why it is not the default.** It costs ~103k input tokens per question against ~3.2k for
passages — roughly **$42 per 64-question run against the $5–7 measured below** — and it has
only been run on 12 of the 64 questions, so I cannot claim the other 52 are unaffected.
Shipping it as the default would mean shipping numbers I have not measured. The honest
next step is an ablation isolating the two changes: the density ranking is what recovered
Q7, and it is available at passage-mode cost.

---

## Measured results

Both runs below ship inside `data/index.db`, so the deployed app shows real output
immediately — no API key and no waiting.

**Submission Review Form — APL 25-008 (Hospice), all 64 questions**

| | |
| --- | --- |
| Completed | 64 / 64, zero errors |
| Verdicts | 11 supported · 41 partial · 12 not found |
| Citations | **168 produced, 168 verified — every one an exact character-for-character match** |
| Withheld | 0 quotes failed verification |
| Conflicts | 9 questions where the sweep found contradicting or narrowing language |

The high `partial` count is the system being careful rather than generous: it cites what the
P&Ps do say and then names the element of the obligation they leave out. Two examples it
caught unprompted:

- The APL requires the hospice provider to file the election notice **within five calendar
  days**; `GG.1503` says **"no later than thirty (30) calendar days"**. Surfaced as a gap
  with the discrepancy named.
- For Q6 it stitched together `EE.1141` (Contracting) and `GG.1503` (Medical Management),
  then flagged in the reviewer note that the two come from different departments and that
  `GG.1503` covers both Medi-Cal and OneCare — a line-of-business mismatch is exactly what
  produces a finding.

It also returns `not_found` rather than stretching a passage — 12 times across the 64.
**One of those twelve I initially reported as a confirmed gap, and it is not.** The
correction is worth stating plainly, because it is the exact error class this tool exists
to prevent.

Q9 asks whether out-of-network hospice providers must hold Medicare certification, CDPH
licensure and an NPI. The run returned **not found at 72% confidence**, and I described that
as matching a gap I had measured against the corpus. My Ctrl-F probe had measured `GG.1503`.
The conclusion I drew covered the whole library. Those are not the same claim, and the
library does carry the language: `GG.1800` p. 2 reads *"Is licensed by the California
Department of Public Health (CDPH);"* and `GG.1651` p. 12 reads *"A valid Type 2 National
Provider Identifier (NPI) number"*. `GG.1651` pp. 11-12 was ranked **second** by that
question's own retrieval, so the model had it and judged `not_found` anyway.

The defensible answer is `partial`: those checks exist, but `GG.1651` imposes them on
Organizational Providers generally rather than on out-of-network hospice specifically —
which is a narrower finding, and a more useful one, than "absent". A policy-scoped probe
generalised to a corpus-scoped claim is precisely the move that produces a state finding.

**ECM Policy Guide — 145 pages**

422 obligations extracted, each with the verbatim sentence that creates it, its page, and
must/should/may. Coverage was then checked on the 30 highest-priority ones → 4 covered,
10 partial, **16 gaps**, each with draft P&P language and the policy that should own it.

Extraction is cheap and exhaustive; the coverage pass is the expensive half (one retrieval
plus one reasoning call per obligation). Checking all 422 would be ~$25 and ~40 minutes, and
422 items is more than anyone reviews in one sitting — so coverage runs **mandatory
obligations first**, then recommended, then permissive. If only part of a run completes, it
is the part that creates findings. The UI reports "422 found / 30 checked" so the unchecked
ones are never mistaken for absent.

---

## Where it sits

The UI is framed as one module inside Readily's platform rather than a standalone
app, using their own information architecture — Policies, Legislation,
Regulations, Contracts, Reports and Case Files under the Audit Review,
Regulatory Change and Monitoring pillars. The two pillars this build implements
map onto the two modules; everything else is rendered but visibly inert, dimmed
and labelled as not implemented here. Showing the whole surface is what makes
the module's place legible — faking the rest would not.

Built on shadcn/ui with Readily's palette mapped onto its token system. `primary`
is obsidian rather than the meadow green on purpose: meadow already means
"supported citation" here, and reusing it for every button would blur the status
system.

## Running it

```bash
git clone https://github.com/yordanoskassa/readily-module
cd readily-module
cp .env.example .env          # add ANTHROPIC_API_KEY

# backend
python3.12 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
backend/.venv/bin/python -m uvicorn backend.app.main:app --reload

# frontend (separate terminal; proxies /api to :8000)
cd frontend && npm install && npm run dev
```

The repo ships the built index (`data/index.db`), so it runs immediately. The corpus PDFs
are gitignored — `index.db` already holds the page text the app reads. To rebuild from
source PDFs, drop them under `data/corpus/<PROGRAM>/` and run:

```bash
backend/.venv/bin/python -m backend.app.ingest
```

Tests (no API key needed — the verification layer is pure text matching):

```bash
cd backend && .venv/bin/python -m pytest      # 50 tests
```

### Deploying to EasyPanel

One container. FastAPI serves the built React bundle, so there is no separate
frontend service and no proxy to configure.

1. **Create an App** and point it at `github.com/yordanoskassa/readily-module`,
   branch `main`, build method **Dockerfile**.
2. **Environment** — set one variable:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   Everything else has a working default. `PORT` is injected by EasyPanel and
   honoured by the entrypoint.
3. **Port** — `8000` (or leave EasyPanel's `PORT` to override it).
4. **Health check** — `GET /api/health`. The image also declares its own
   `HEALTHCHECK`.
5. **Volume (optional)** — mount at `/app/data` if runs should survive a
   redeploy. The image seeds that directory on first start, so mounting a volume
   is safe and mounting nothing is safe too.

**Why the seed step exists.** The searchable index is baked in at `/app/seed`,
not `/app/data`. A volume mounted at `/app/data` shadows whatever the image had
there — so shipping the index at the mount point would mean that attaching a
volume, the one thing you would attach it for, silently leaves the app with an
empty corpus and zero policies. `docker-entrypoint.sh` copies the seed across
only when `index.db` is absent, so:

| | first start | later starts |
|---|---|---|
| no volume | seeded from image | seeded again; runs are ephemeral |
| volume at `/app/data` | seeded once | untouched; runs persist |

**What is in the image.** `index.db` (~34MB) carries all 373 policies as text
plus the two completed demo runs, so the deployed app shows real results on
first load with no API key and no waiting. The source corpus PDFs are not
shipped — nothing at runtime reads them.

Locally the same image runs with:

```bash
docker build -t readily-module .
docker run --rm -p 8000:8000 -e ANTHROPIC_API_KEY=sk-ant-... readily-module
```

> **Not yet built.** No container runtime was available on the machine this was
> written on, so `docker build` has never run. Every step it performs was
> replayed by hand against a clean `git archive HEAD` checkout — `npm ci` from
> the committed lockfile (reproducing byte-identical bundle hashes), `pip
> install`, the `backend.app.main:app` import from the repo root, serving the
> built bundle with all API routes returning 200, the healthcheck command
> verbatim, `.dockerignore` against every `COPY`, and the entrypoint's three
> seeding cases. The lockfile was also checked for the Linux musl binaries
> (`@rollup/rollup-linux-x64-musl`, `@esbuild/linux-x64`) that are the usual
> cause of `npm ci` failing on Alpine. What remains untested is only what needs
> a daemon: the base images pulling, `useradd` on the slim image, and the
> cross-stage `COPY --from=web`.

---

## Cost and timing, measured

Per question: 1 expansion call (Sonnet 5, low effort) + 1 assessment (Opus 5, high effort)
+ 1 contradiction sweep when there is something to check. The measured 64-question run took
**~13 minutes** at concurrency 10 for roughly 190 calls, in the **$5–7** range. Guide
extraction is ~30 Sonnet calls (~$1); coverage is ~$0.10 per obligation checked.

`EVIDENCE_MODE=documents` changes that materially: ~103k input tokens per question instead
of ~3.2k, which projects to roughly **$42** for the same 64 questions. The input figure is
measured from the shortlisted documents; the output side is estimated, since the token
counters were added after that run. Almost all of it is the assessment call, so there is no
cheaper model to route around — the expansion is already Sonnet and the sweep is ~5k tokens.
The lever that would actually help is prompt-caching a fixed document set across all 64
questions, since cache reads bill at a tenth of input; that is not built.

The launcher caps the question count so you can try it cheaply, and both completed runs ship
in the repo so the deployed app shows real results with no key and no wait.

`claude-opus-5` does the judgement Alex is accountable for; `claude-sonnet-5` does the
high-fan-out expansion and obligation extraction. Every call is schema-constrained via
`output_config.format`, so nothing is parsed out of prose. The stable system prompt is
cached, and the first call of a batch runs alone to populate that cache before the rest fan
out — concurrent identical prefixes cannot read a cache entry that is still being written.

---

## Honest limitations

- **Borderline verdicts are not stable run to run.** On genuinely ambiguous questions the
  verdict can move between `supported` and `partial` across runs. That instability is
  itself signal — those are the questions worth her attention — but the tool currently
  surfaces it through the confidence score and the reviewer note rather than measuring it.
  Self-consistency voting is the obvious fix and is not built.
- **Lexical retrieval only.** No embeddings. LLM query expansion plus rank fusion covers
  most of the vocabulary gap, but a question whose wording shares no tokens with the policy
  can still be missed. This was a deliberate trade for a deployable single-file index.
  Whole-document mode reduces the exposure — retrieval only has to pick the right policy,
  not the right chunk of it — but it is off by default for the cost and coverage reasons
  given above.
- **Whole-document mode is measured on 12 of 64 questions.** Those 12 were chosen because
  they were the `not_found` set, which is the population it was expected to help. I have not
  run the other 52 in that mode, so I cannot rule out a regression on a question the default
  mode currently answers well. That is the reason it is not the default, and the first thing
  I would run next.
- **Text PDFs only.** No OCR, so a scanned policy is skipped at ingest (none in this
  corpus).
- **No auth or multi-tenancy.** One shared corpus, no user accounts. The org
  switcher and platform search in the shell are chrome, not features.
- **Guide coverage is partial by design, and over-extracts.** 422 obligations from 145 pages
  is more than the ~231 modal-verb cues I counted in the source, so adjacent windows are
  producing some near-duplicates that the loose text key does not catch. Coverage is checked
  mandatory-first rather than exhaustively (see above). Tighter de-duplication — probably
  clustering on the quote rather than the restatement — is the fix.

## Deliberately not built

Automatic P&P redlining (gaps get draft language to copy, not committed edits) · DOCX/PDF
submission export (CSV and JSON only) · guide version-diffing to show what changed in an
annual update · scheduled background re-checks when a policy is revised · a vector index.

## What I'd do next

1. **Finish measuring whole-document mode, and ablate it.** Run all 64 questions in that
   mode to find regressions, then separate the two changes it bundles: density document
   ranking is what recovered Q7 and costs nothing, while whole-document context is what
   drives the judgement flips and costs ~32x the input tokens. If the density ranking alone
   carries most of the benefit, the expensive half never ships. Pair that with prompt-caching
   a fixed document set so the context cost falls to cache-read rates.
2. **Self-consistency on borderline answers.** Sample the assessment three times where
   confidence lands mid-range and show her the disagreement explicitly. Turns the
   instability above from a weakness into the product's main signal about where to look.
   The 12-question comparison makes this concrete: three of the eight flips happened on
   evidence the model had already seen, which is verdict instability rather than retrieval.
3. **Answer-level caching keyed on `(question, policy revision)`.** Most P&Ps do not change
   between submissions, so re-running a form after editing three policies should cost three
   questions, not sixty-four.
4. **Guide diffing.** The Guides update annually and she only needs the delta. Extract
   obligations from both versions and show added, removed, and reworded ones — that is the
   actual yearly job.
5. **Close the loop into drafting.** A gap already produces draft language and names the
   policy that should own it; the next step is opening a redline against that document.
