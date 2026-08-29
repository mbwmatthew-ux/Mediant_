# Launch Accuracy — Plan A: Precision and Honesty

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the analyzer presenting incomplete or misaligned analysis as complete — read every uploaded score file, declare repeats, and tell the student what was actually examined.

**Architecture:** Three independent gaps feeding one shared output. The score reader takes a list of files instead of one and numbers measures continuously across them; the MusicXML parser records where the first repeat sits; and both feed a new `coverage` object on `analysis_quality` that the existing gold banner on the Analysis page renders. Nothing here changes a threshold or a detector — it changes what the analyzer *sees* and what it *admits*.

**Tech Stack:** Python 3.11 (Modal worker), Deno/TypeScript (Supabase edge functions), React 19 + CSS Modules.

**Spec:** `docs/superpowers/specs/2026-08-29-launch-accuracy-design.md` — Parts 1, 2 and 6.

## Global Constraints

- Python 3.11. No new dependencies. The Modal image pins `numpy>=1.24,<2.0`, `music21==9.1.0`, `librosa==0.10.2`, `torch<3.0`.
- `modal_worker/test_analysis.py`, `diagnose_coverage.py` and `test_evidence.py` must run with **no network, no API keys, no audio**. Heavy imports (`music21`, `torch`, `librosa`, `anthropic`, `httpx`) are stubbed with `MagicMock`.
- Tests use the plain-assert `check(name, ok, detail="")` harness. **Do not introduce pytest.**
- Verified starting tallies: `test_analysis.py` **182/182**, `diagnose_coverage.py` **28/28**, `test_evidence.py` **61/61**. The last must stay unchanged; the first two grow. Run `rm -rf modal_worker/__pycache__` before any run you report.
- `npm run build` must pass. `npm run lint` must not exceed its pre-existing **100 errors / 13 warnings**. Do not fix pre-existing lint errors.
- **A single multi-page PDF already works** — Claude `document` blocks read every page. Do not change the PDF branch of `read_score_notes_claude`.
- No flag may be shown without a measure and a timestamp range (PD-005).
- `npx` is broken in this checkout (`node_modules/.bin` shims corrupted). Use the npm scripts.
- Do not run the `supabase` CLI, do not apply migrations, do not query any database.
- Read `agent_workspace/DESIGN_RULES.md` before touching any UI file.

---

## File Structure

**Modified:**
- `supabase/functions/analyze-performance/index.ts` — sign every score file; rekey the score cache
- `supabase/functions/analysis-webhook/index.ts` — cache write uses the same key
- `modal_worker/worker.py` — multi-file score read, `first_repeat_measure`, `coverage` in `assess_quality`
- `modal_worker/test_analysis.py` — new tests
- `modal_worker/diagnose_coverage.py` — new coverage rows
- `src/pages/Analysis.jsx`, `src/pages/Analysis.module.css` — `Partial` banner case
- `agent_workspace/AGENT_TASKS.md`, `CHANGELOG.md` — boards

No new files. Every change lands in a module that already owns that responsibility.

---

## Task 1: Sign and forward every uploaded score file

The edge function signs only page 0. Until it signs all of them the worker cannot read them, so this comes first.

**Files:**
- Modify: `supabase/functions/analyze-performance/index.ts`
- Modify: `supabase/functions/analysis-webhook/index.ts`

**Interfaces:**
- Produces: `score_urls: string[] | null` on the Modal payload — ordered, page 0 first, same order as `score_paths`. `score_url` (singular) keeps its current meaning and value so nothing else breaks.
- Produces: cache key = `scorePaths.join('|')` when there is more than one file, else `scorePath` unchanged.
- Consumed by: Task 2.

- [ ] **Step 1: Sign every score path**

In the `inlineTask` block, beside the existing single `createSignedUrl` for `scorePath`, add:

```ts
        // Sign EVERY uploaded page, not just the first. The worker reads them as one
        // ordered set so measure numbering can run continuously across a page break.
        // score_url (singular) is left exactly as it was — other consumers still use it.
        let scoreSignedUrls: string[] = []
        if (safeScorePaths.length) {
          const signed = await Promise.all(
            safeScorePaths.map(p =>
              admin.storage.from('sheet-music').createSignedUrl(p, 7200)
                .then(r => r.data?.signedUrl ?? null)
                .catch(() => null)
            )
          )
          // A missing page must not silently shift the order — drop the whole set
          // rather than hand the reader pages 1 and 3 labelled 1 and 2.
          scoreSignedUrls = signed.every(Boolean) ? (signed as string[]) : []
          if (!scoreSignedUrls.length && safeScorePaths.length > 1) {
            console.warn('[analyze-performance] could not sign all score pages — falling back to page 1 only')
          }
        }
```

- [ ] **Step 2: Put it on the Modal payload**

Beside `score_url: scoreSignedUrl,` add:

```ts
              score_urls:           scoreSignedUrls.length ? scoreSignedUrls : null,
```

- [ ] **Step 3: Rekey the score cache**

The cache is keyed on a single `score_path`, so a three-page score would collide with its own page 1 and be served a one-page parse. Replace the cache lookup's key:

```ts
        // Opaque cache key, NOT a storage path: a multi-file score must not collide
        // with its own first page. Joined with "|" so it stays a single TEXT key and
        // needs no migration.
        const scoreCacheKey = safeScorePaths.length > 1
          ? safeScorePaths.join('|')
          : scorePath
```

Use `scoreCacheKey` in the `.eq('score_path', ...)` lookup, and pass it to Modal as `score_path` (the worker echoes it back to the webhook for the cache write, so both sides must agree).

- [ ] **Step 4: Verify the webhook needs no change**

Read `supabase/functions/analysis-webhook/index.ts`. It writes `score_cache` keyed on the `scorePath` the worker echoes back. Since Step 3 sends the joined key as `score_path`, the write already matches. **Confirm this by reading and say so in your report** — if it does not match, fix it there rather than in the worker.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: `✓ built in <n>s`

There is no Deno typecheck in this repo, so verify the TypeScript by careful reading. State in your report that you did.

- [ ] **Step 6: Confirm no Python changed**

Run: `rm -rf modal_worker/__pycache__ && python3 modal_worker/test_analysis.py && python3 modal_worker/diagnose_coverage.py && python3 modal_worker/test_evidence.py`
Expected: `182/182`, `28/28`, `61/61` — all unchanged.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/analyze-performance/index.ts supabase/functions/analysis-webhook/index.ts
git commit -m "feat(analysis): sign and forward every uploaded score page

The worker could only ever see page 1: the edge function signed one URL and
forwarded score_paths, which the worker ignores. Also rekeys the score cache so a
multi-page score cannot collide with its own first page.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Read every score file in one vision call

**Files:**
- Modify: `modal_worker/worker.py` — `read_score_notes_claude` and `_score_pipeline`
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `score_urls` from Task 1.
- Produces: `read_score_notes_claude(pages, start_measure, instrument, time_sig, anthropic_api_key)` where `pages: list[tuple[bytes, str]]` is `(file_bytes, mime)` in page order. Returns the same dict as before, with each measure additionally carrying `"page": int` (1-based).
- Produces: `_score_pipeline` returns a third value, `pages_read: int`, consumed by Task 4.

- [ ] **Step 1: Write the failing test**

`read_score_notes_claude` calls `client.messages.stream(...)` as a **context manager** and then `stream.get_final_message()` — not `.create()`. The suite's existing `_FakeAnthropic` only implements `.create()`, so this test defines its own fake. Add to `modal_worker/test_analysis.py`, registered in `main()`:

```python
def test_score_reader_sends_every_page():
    print("\n[43] the score reader receives every uploaded page")
    import types, json as _json

    captured = {}

    class _FakeStream:
        def __init__(self, payload): self._payload = payload
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get_final_message(self):
            return types.SimpleNamespace(
                content=[types.SimpleNamespace(text=self._payload)],
                stop_reason="end_turn")

    class _FakeMessages:
        def stream(self, **kw):
            captured["content"] = kw["messages"][0]["content"]
            return _FakeStream(_json.dumps({
                "key_signature": "C major", "time_signature": "4/4",
                "tempo_marking": None,
                "measures": [
                    {"number": 1, "pg": 1, "notes": [{"p": "C4", "b": 1.0, "d": 1.0}]},
                    {"number": 9, "pg": 2, "notes": [{"p": "G4", "b": 1.0, "d": 1.0}]},
                ]}))

    class _FakeClient:
        def __init__(self, **kw): self.messages = _FakeMessages()

    _real = w.__dict__.get("_anthropic_client_factory")
    pages = [(b"\x89PNG-page-one", "image/png"), (b"\x89PNG-page-two", "image/png")]
    import anthropic as _ac
    _orig = _ac.Anthropic
    _ac.Anthropic = _FakeClient
    try:
        res = w.read_score_notes_claude(pages, 1, "clarinet", "4/4", "k")
    finally:
        _ac.Anthropic = _orig

    blocks = captured.get("content") or []
    n_media = sum(1 for b in blocks if isinstance(b, dict) and b.get("type") in ("image", "document"))
    check("both pages reach the model", n_media == 2, f"{n_media} media block(s)")
    check("prompt still present", any(b.get("type") == "text" for b in blocks))
    nums = [m["number"] for m in res.get("measures", [])]
    check("printed numbering preserved across pages", nums == [1, 9], str(nums))
    pgs = [m.get("page") for m in res.get("measures", [])]
    check("each measure records its page", pgs == [1, 2], str(pgs))
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `rm -rf modal_worker/__pycache__ && python3 modal_worker/test_analysis.py`
Expected: FAIL — `read_score_notes_claude` takes `(score_bytes, score_mime, ...)` and will raise a `TypeError`, or return measures with no `page`.

- [ ] **Step 3: Change the signature to take pages**

In `read_score_notes_claude`, replace the single-file preamble. The existing PDF/image branch logic is kept per file — **do not change how a PDF is wrapped**, only apply it once per page:

```python
def read_score_notes_claude(
    pages: list[tuple[bytes, str]],
    start_measure: int, instrument: str, time_sig: str,
    anthropic_api_key: str,
) -> dict:
    import base64, anthropic as ac
    CLAUDE_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

    # One media block per uploaded file, in page order. A single multi-page PDF
    # still arrives as ONE document block and Claude reads all of its pages — that
    # path already worked and is unchanged. What was broken is several separate
    # files (the usual case: phone photos of each page), where only the first was
    # ever sent.
    vision_parts: list = []
    for pg_bytes, pg_mime in pages:
        b64 = base64.b64encode(pg_bytes).decode()
        if pg_mime == "application/pdf":
            vision_parts.append({"type": "document", "source": {
                "type": "base64", "media_type": "application/pdf", "data": b64}})
        elif pg_mime in CLAUDE_IMAGE_TYPES:
            vision_parts.append({"type": "image", "source": {
                "type": "base64", "media_type": pg_mime, "data": b64}})
        else:
            print(f"[read_score_notes_claude] skipping unsupported mime: {pg_mime}")
    if not vision_parts:
        return {"key_signature": None, "time_signature": None,
                "tempo_marking": None, "measures": []}
```

- [ ] **Step 4: Tell the model the pages are one continuous score**

Add to the prompt, immediately after the MEASURE NUMBERING block:

```
MULTIPLE PAGES: You may be given several images. They are consecutive pages of ONE part, in order. Measure numbering runs continuously ACROSS them — the first measure of page 2 is NOT measure 1, it continues from where page 1 ended. Do not restart numbering on a new page. For every measure, also return "pg": the 1-based number of the page you read it from (the first image is page 1).
```

Add `"pg"` to the field list and to the JSON example alongside the existing compact fields.

- [ ] **Step 5: Carry `page` through normalisation**

In the measure-building comprehension, preserve the page:

```python
        measures = [
            {**m, "page": int(m.get("pg") or m.get("page") or 1), "notes": [
                _norm_note(n) for n in m.get("notes", [])
                if str(n.get("pitch") or n.get("p", "")).lower() != "rest"
            ]}
            for m in (parsed.get("measures") or [])
            if isinstance(m.get("notes"), list)
        ]
```

- [ ] **Step 6: Update the call site and download every page**

In `_score_pipeline`, download all of `score_urls` (falling back to `[score_url]`), and pass the list. Return `pages_read` as a third value. Update the `crepe_fut`/`score_fut` unpacking at the `ThreadPoolExecutor` block to accept three values.

Keep the `cached_score_notes` short-circuit ahead of the download — a cache hit must still skip the vision call entirely.

For `get_measure_positions_gemini`, call it **per page** and merge, attaching that page's index; a measure's `x_pct`/`y_pct` are only meaningful together with its `page`.

- [ ] **Step 7: Run the test**

Run: `rm -rf modal_worker/__pycache__ && python3 modal_worker/test_analysis.py`
Expected: `186/186 checks passed` (182 + 4).

- [ ] **Step 8: Confirm the other suites are untouched**

Run: `python3 modal_worker/diagnose_coverage.py && python3 modal_worker/test_evidence.py`
Expected: `28/28`, `61/61`.

- [ ] **Step 9: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(analysis): read every uploaded score page, not just the first

Several separate image files (phone photos of each page) had only file 0 read,
silently. A single multi-page PDF already worked and is unchanged. Measures now
carry the page they were read from.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Record where the first repeat sits

**Files:**
- Modify: `modal_worker/worker.py` — `parse_musicxml`
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Produces: `first_repeat_measure: int | None` on the score dict returned by `parse_musicxml`, beside the existing `has_repeats`.
- Consumed by: Task 4.

**Testing note, read before writing the test.** `music21` is stubbed with `MagicMock` in the suite, so `parse_musicxml` itself cannot be exercised. The parser change is therefore verified by reading, and the **test covers the consumer** — that a score dict carrying `has_repeats`/`first_repeat_measure` produces the right caveat. That is a real limit; state it in your report rather than implying the parser is tested.

- [ ] **Step 1: Record the measure alongside the flag**

In `parse_musicxml`, the repeat scan currently sets a boolean and breaks. Extend it to capture the measure number, walking measures rather than the flattened part so a number is available:

```python
        has_repeats = False
        first_repeat_measure = None
        try:
            for _m in source_part.getElementsByClass(m21.stream.Measure):
                for _el in _m.recurse():
                    if isinstance(_el, m21.bar.Repeat) or isinstance(
                            _el, getattr(m21.repeat, "RepeatExpression", ())):
                        has_repeats = True
                        if _m.number is not None:
                            first_repeat_measure = int(_m.number)
                        break
                if has_repeats:
                    break
        except Exception:
            has_repeats = False
            first_repeat_measure = None
```

- [ ] **Step 2: Return it**

Add `"first_repeat_measure": first_repeat_measure,` beside the existing `"has_repeats": has_repeats,` in the returned dict, with a comment noting it is the measure a coverage caveat names.

- [ ] **Step 3: Confirm nothing regressed**

Run: `rm -rf modal_worker/__pycache__ && python3 modal_worker/test_analysis.py && python3 modal_worker/diagnose_coverage.py`
Expected: `186/186`, `28/28`.

- [ ] **Step 4: Commit**

```bash
git add modal_worker/worker.py
git commit -m "feat(analysis): record which measure the first repeat sits in

has_repeats was computed and read by nothing. The measure number is what a
student needs to judge whether their take is affected.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Build the coverage declaration

**Files:**
- Modify: `modal_worker/worker.py` — `assess_quality` and its call site
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `pages_read` (Task 2), `has_repeats` / `first_repeat_measure` (Task 3).
- Produces: `analysis_quality.coverage = {measures_analysed, pages_analysed, pages_total, caveats}`. `caveats` is a list of student-facing strings; empty when the analysis covered everything.

- [ ] **Step 1: Write the failing test**

```python
def test_coverage_declares_what_was_not_analysed():
    print("\n[44] coverage declares partial analysis instead of implying completeness")
    score_two_pages = {"measures": [{"number": n, "notes": [{"pitch": "C4"}]}
                                     for n in range(1, 9)]}
    evs = [{"time_sec": i * 0.5} for i in range(12)]
    aligned = [{"measure": 1 + i // 3, "time_sec": i * 0.5} for i in range(12)]
    ranges = [{"measure": m, "start": 0.0, "end": 1.0} for m in range(1, 5)]

    # Every page read, no repeat → nothing to declare.
    q = w.assess_quality(score_two_pages, evs, aligned, ranges,
                         pages_read=3, pages_total=3,
                         has_repeats=False, first_repeat_measure=None)
    check("clean take declares no caveats", q["coverage"]["caveats"] == [],
          str(q["coverage"]["caveats"]))
    check("pages recorded", q["coverage"]["pages_analysed"] == 3)

    # One page of three unread → must say so.
    q2 = w.assess_quality(score_two_pages, evs, aligned, ranges,
                          pages_read=1, pages_total=3,
                          has_repeats=False, first_repeat_measure=None)
    txt = " ".join(q2["coverage"]["caveats"]).lower()
    check("unread pages are declared", len(q2["coverage"]["caveats"]) >= 1, txt[:90])
    check("the caveat names how many pages", "1" in txt and "3" in txt, txt[:90])

    # A repeat → must name the measure, and must NOT claim pages are missing.
    q3 = w.assess_quality(score_two_pages, evs, aligned, ranges,
                          pages_read=1, pages_total=1,
                          has_repeats=True, first_repeat_measure=17)
    rtxt = " ".join(q3["coverage"]["caveats"]).lower()
    check("repeat is declared", "repeat" in rtxt, rtxt[:90])
    check("repeat caveat names the measure", "17" in rtxt, rtxt[:90])
    check("no page caveat when all pages read",
          "page" not in rtxt, rtxt[:90])

    # Measure range comes from what was actually aligned.
    check("measure range reported", q["coverage"]["measures_analysed"] == [1, 4],
          str(q["coverage"]["measures_analysed"]))
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `rm -rf modal_worker/__pycache__ && python3 modal_worker/test_analysis.py`
Expected: FAIL — `assess_quality() got an unexpected keyword argument 'pages_read'`.

- [ ] **Step 3: Extend `assess_quality`**

```python
def assess_quality(
    score: dict, events: list[dict], aligned: list[dict],
    alignment_ranges: list[dict],
    pages_read: int | None = None, pages_total: int | None = None,
    has_repeats: bool = False, first_repeat_measure: int | None = None,
) -> dict:
    """
    Trust plus an explicit statement of what was NOT analysed.

    `reasons` already described why confidence might be low. `coverage` answers a
    different and blunter question the student actually needs: which measures and
    pages were examined at all. Presenting a page-1 analysis of a three-page piece
    as if it were the whole thing is the failure this exists to prevent.
    """
    reasons: list[str] = []
    if len(score.get("measures", [])) < 2:
        reasons.append("Score could not be parsed — measure timestamps are approximate.")
    if len(events) < 8:
        reasons.append("Few audio events detected — recording may be very short or quiet.")
    if len(aligned) < 4:
        reasons.append("Few events aligned to score measures — timestamp accuracy limited.")

    measures = sorted({int(r["measure"]) for r in (alignment_ranges or [])
                       if r.get("measure") is not None})
    caveats: list[str] = []
    if pages_total and pages_read and pages_read < pages_total:
        caveats.append(
            f"This analysis covers {pages_read} of {pages_total} uploaded score "
            f"pages. Anything on the remaining pages was not examined.")
    if has_repeats:
        where = f"measure {first_repeat_measure}" if first_repeat_measure else "a repeat"
        caveats.append(
            f"This score contains a repeat at {where}. Repeats are not expanded yet, "
            f"so if you played it, measure numbers after that point may be offset.")

    quality = {
        "trust": "high" if not reasons else "medium",
        "canProceed": True,
        "reasons": reasons,
        "coverage": {
            "measures_analysed": [measures[0], measures[-1]] if measures else None,
            "pages_analysed": pages_read,
            "pages_total": pages_total,
            "caveats": caveats,
        },
    }
    return quality
```

- [ ] **Step 4: Pass the real values at the call site**

In `run_full_analysis`, the `assess_quality(...)` call gains the four arguments. `pages_total` is `len(score_urls or [score_url])`; `pages_read` comes from `_score_pipeline`'s third return value; `has_repeats` and `first_repeat_measure` come off the score dict with `.get`.

- [ ] **Step 5: Run every suite**

Run: `rm -rf modal_worker/__pycache__ && python3 modal_worker/test_analysis.py && python3 modal_worker/diagnose_coverage.py && python3 modal_worker/test_evidence.py`
Expected: `193/193` (186 + 7), `28/28`, `61/61`.

- [ ] **Step 6: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(analysis): declare what the analysis did not cover

analysis_quality gains a coverage object naming the measure range, the pages read
versus uploaded, and student-facing caveats for unread pages and repeats.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Show the coverage caveats to the student

**Files:**
- Modify: `src/pages/Analysis.jsx`, `src/pages/Analysis.module.css`

**Interfaces:**
- Consumes: `take.analysis_quality.coverage.caveats` (Task 4).

**Read `agent_workspace/DESIGN_RULES.md` first.** Relevant rules: warm palette only, no cool grays or blue; gold is structural, red is semantic for errors; cards use `1px solid var(--border)`.

- [ ] **Step 1: Extend the existing notice**

`Analysis.jsx` already computes `evidenceNotice` (a `{label, text}` used by a gold banner) from `analysis_backend` and `analysis_quality`. Add a `Partial` case **before** the reduced/video-only cases, since a coverage gap is a stronger statement than a backend downgrade:

```jsx
    const caveats = analysisQuality?.coverage?.caveats
    if (Array.isArray(caveats) && caveats.length) {
      return { label: 'Partial', text: caveats.join(' ') }
    }
```

The existing `if (isDemoTake) return null` guard stays first, and the `backend.startsWith('modal')` early-return must move *below* this block — a full Modal analysis can still have unread pages, and returning early would hide the caveat exactly when it is true.

- [ ] **Step 2: Reuse the banner styling**

The existing `.evidenceBanner` / `.evidencePill` classes already carry the gold cautionary treatment. No new CSS unless the `Partial` label needs a width tweak; if it does not, add none and say so in your report.

- [ ] **Step 3: Build and lint**

Run: `npm run build` — expected `✓ built`.
Run: `npm run lint` — expected `113 problems (100 errors, 13 warnings)`, unchanged. Report both numbers.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Analysis.jsx src/pages/Analysis.module.css
git commit -m "feat(analysis): tell the student when the analysis was partial

A page-1 analysis of a three-page upload rendered identically to a complete one.
The coverage caveats now surface in the existing banner.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Coverage-matrix rows and board updates

**Files:**
- Modify: `modal_worker/diagnose_coverage.py`, `agent_workspace/AGENT_TASKS.md`, `agent_workspace/CHANGELOG.md`

- [ ] **Step 1: Add the behaviours**

`diagnose_coverage.py` asserts "if a student makes mistake X, does a flag about X come out — and if they play cleanly, does nothing". Add two rows in the same style as the existing ones:

- **"partial page coverage is declared"** — a take whose score reports fewer pages read than uploaded must produce a non-empty `coverage.caveats`.
- **"complete coverage declares nothing"** — the silent-on-clean half. A take with every page read and no repeat must produce `caveats == []`. This is the row that matters: a caveat builder that fires unconditionally would pass the first row alone.

- [ ] **Step 2: Run it**

Run: `rm -rf modal_worker/__pycache__ && python3 modal_worker/diagnose_coverage.py`
Expected: `30/30 behaviours present`.

- [ ] **Step 3: Update the boards**

Add a `Completed` entry to `AGENT_TASKS.md` and an entry to `CHANGELOG.md`. State plainly what shipped and what did not: repeats are **declared, not expanded**, and a single multi-page PDF was already working. Do not describe this as "multi-page support" without that distinction.

- [ ] **Step 4: Commit**

```bash
git add modal_worker/diagnose_coverage.py agent_workspace/AGENT_TASKS.md agent_workspace/CHANGELOG.md
git commit -m "test(analysis): coverage rows for partial-analysis declaration

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** Part 1 (multiple score files) → Tasks 1, 2. Part 2 (repeats declared) → Tasks 3, 4. Part 6 (coverage declaration + banner) → Tasks 4, 5. Verification → Task 6, plus per-task tests. Nothing in Parts 1/2/6 is unassigned.

**Placeholder scan.** No TBDs. Task 3 has no direct parser test and says so explicitly, with the reason (`music21` is `MagicMock`-stubbed) — that is a stated limitation, not a gap I hid.

**Type consistency.** `read_score_notes_claude(pages: list[tuple[bytes, str]], ...)` is defined in Task 2 Step 3 and called with that shape in Task 2 Step 6 and the Task 2 test. `pages_read` is produced by `_score_pipeline` (Task 2) and consumed by `assess_quality` (Task 4) under the same name. `first_repeat_measure` is produced in Task 3 and consumed in Task 4. `coverage.caveats` is produced in Task 4 and read in Task 5.

**Known risk, stated not hidden.** Task 2 changes a function signature with one call site. If any other caller exists, it breaks — the implementer must grep before editing. The test suite would catch it, which is why Task 2 runs all three suites.
