# Readily Module — Regulatory Evidence

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
| "out-of-Network" | 0 hits | **a genuine gap** |
| "Medicare certification" / "NPI" | 0 hits | **a genuine gap** |

Two things follow. Tokenizing beats Ctrl-F on the parenthetical-numeral style that pervades
these documents. And some questions have no answer in the library at all — so the tool has
to be able to say **"not found"** confidently instead of stretching a loosely related
passage. That test is pinned in
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
  streamed to the UI as each answer lands → accept / flag / edit → CSV
```

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

And it held the line on absence: Q9 (out-of-network hospice providers needing Medicare
certification, CDPH licensure and an NPI) returned **not found at 72% confidence** — matching
the gap I had measured directly against the corpus before any model was involved.

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

### Deploying

Single container; the FastAPI app serves the built React bundle. `PORT` is honoured, so on
EasyPanel point a service at this repo, let it build the `Dockerfile`, and set
`ANTHROPIC_API_KEY` as an environment variable.

> **Note:** the `Dockerfile` has not been built and run — no container runtime was available
> on the machine where this was written. Each step it performs was verified individually
> (`npm ci`/`npm run build`, `pip install`, the `backend.app.main:app` import path from the
> repo root, `PORT` handling, and that `data/` is writable by the non-root user because runs
> persist into `index.db`). The first build is untested.

---

## Cost and timing, measured

Per question: 1 expansion call (Sonnet 5, low effort) + 1 assessment (Opus 5, high effort)
+ 1 contradiction sweep when there is something to check. The measured 64-question run took
**~13 minutes** at concurrency 10 for roughly 190 calls, in the **$5–7** range. Guide
extraction is ~30 Sonnet calls (~$1); coverage is ~$0.10 per obligation checked.

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
- **Text PDFs only.** No OCR, so a scanned policy is skipped at ingest (none in this
  corpus).
- **No auth or multi-tenancy.** One shared corpus, no user accounts.
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

1. **Self-consistency on borderline answers.** Sample the assessment three times where
   confidence lands mid-range and show her the disagreement explicitly. Turns the
   instability above from a weakness into the product's main signal about where to look.
2. **Answer-level caching keyed on `(question, policy revision)`.** Most P&Ps do not change
   between submissions, so re-running a form after editing three policies should cost three
   questions, not sixty-four.
3. **Guide diffing.** The Guides update annually and she only needs the delta. Extract
   obligations from both versions and show added, removed, and reworded ones — that is the
   actual yearly job.
4. **Close the loop into drafting.** A gap already produces draft language and names the
   policy that should own it; the next step is opening a redline against that document.
