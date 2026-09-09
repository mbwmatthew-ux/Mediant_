# Declared BPM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every recording submission requires the student to declare the tempo they
intend to play at; the analysis worker uses it to seed the beat tracker (fixing a
real class of octave-tempo error) and to tell the student how their actual tempo
compared to what they declared.

**Architecture:** A new required numeric field on the upload form flows, unmodified,
through `analyze-performance`'s existing "form beats vision-read" pattern (the same
one `time_sig` already uses) into the Modal worker's payload, where it seeds
`run_beat_tracking` and powers a new `check_tempo_vs_declared` comparison — a sibling
of the existing `check_tempo_vs_marking`.

**Tech Stack:** React (`NewRecordingModal.jsx`), Deno/TypeScript Supabase edge
function (`analyze-performance/index.ts`), Python Modal worker (`worker.py`), plain
`ALTER TABLE` SQL migration.

**Spec:** `docs/superpowers/specs/2026-09-08-declared-bpm-design.md`

## Global Constraints

- Valid BPM range is **20–300** everywhere it's validated (matches the range
  `parse_marked_bpm` already validates on the worker side — there is exactly one
  "valid BPM" definition in the worker, not two).
- The new comparison tolerance is **±15%** (`_TEMPO_DECLARED_PCT = 15.0`), matching
  the existing `_TEMPO_MARK_PCT` the marked-tempo check already uses.
- `declared_bpm` is stored **per take**, not per song/piece — the same piece may be
  practiced at different declared tempos across sessions.
- New worker code must be additive: nothing on the existing path changes behavior
  when `declared_bpm` is absent (an old take reanalyzed, or a take that goes through
  the inline-fallback pipeline instead of Modal — out of scope for this plan; see
  spec's "Out of scope").
- Flag type for the new comparison is `"timing"` (reuses the existing type — no new
  entry in the Flag Data Structure's type list).

---

### Task 1: Migration — `declared_bpm` column on `takes`

**Files:**
- Create: `supabase/migrations/20260908_add_declared_bpm_to_takes.sql`

**Interfaces:**
- Produces: a nullable `declared_bpm numeric` column on `takes`, consumed by Task 4
  (edge function insert) and read by any future reporting/UI work (out of scope
  here).

- [ ] **Step 1: Write the migration**

```sql
-- Per-take declared practice tempo: the BPM the student says they intend to play
-- at for this specific recording. Distinct from the sheet music's own printed
-- tempo marking (score.tempo_bpm, worker-side) — the same piece can be
-- practiced at different declared tempos across different sessions.
ALTER TABLE takes ADD COLUMN IF NOT EXISTS declared_bpm NUMERIC;
```

- [ ] **Step 2: Verify the migration file matches the project's existing style**

Compare against `supabase/migrations/20260629_add_note_to_takes.sql` — same
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` shape, same header-comment convention.
No `pytest`/build step applies to a bare SQL file; this migration is applied the
same way every other file in `supabase/migrations/` is (Supabase CLI / dashboard —
whichever the project already uses; do not run `supabase db push` yourself unless
you have already confirmed with the user that's the intended deploy path for this
repo, since it is a shared-database, hard-to-reverse operation).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260908_add_declared_bpm_to_takes.sql
git commit -m "feat(db): add declared_bpm column to takes"
```

---

### Task 2: Worker — `check_tempo_vs_declared` + evidence registration

**Files:**
- Modify: `modal_worker/worker.py` (new function, placed directly after
  `check_tempo_vs_marking`, i.e. after line 4034 and before `_REST_ONSET_GRACE` at
  line 4036)
- Modify: `modal_worker/evidence.py:30-43` (`_DETECTOR_BY_TYPE` table)
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Produces: `check_tempo_vs_declared(fitted_bpm, declared_bpm) -> dict | None`,
  returning `{"pct": float, "direction": "faster"|"slower", "fitted": float,
  "declared": float}` or `None`. Consumed by Task 3.
- Consumes: nothing from other tasks — this is a pure, standalone function, exactly
  like its sibling `check_tempo_vs_marking`.

- [ ] **Step 1: Write the failing tests**

Insert this new test function immediately after `test_tempo_vs_marking_reports_fact_not_fault`
(which ends at line 2270, right before `def test_crescendo_that_never_arrives_is_flagged():`
at line 2273) in `modal_worker/test_analysis.py`:

```python
def test_tempo_vs_declared_reports_fact_not_fault():
    print("\n[58] played tempo is compared to what the student declared they'd play")
    check("15% faster is reported",
          (w.check_tempo_vs_declared(92.0, 80.0) or {}).get("direction") == "faster")
    check("the percentage is real",
          abs((w.check_tempo_vs_declared(92.0, 80.0) or {})["pct"] - 15.0) < 0.6,
          str(w.check_tempo_vs_declared(92.0, 80.0)))
    check("slower is reported too",
          (w.check_tempo_vs_declared(60.0, 80.0) or {}).get("direction") == "slower")
    # Inside tolerance is not a finding — musicians are not metronomes.
    check("a close tempo is silent", w.check_tempo_vs_declared(84.0, 80.0) is None,
          str(w.check_tempo_vs_declared(84.0, 80.0)))
    # No declared tempo means nothing to compare against.
    check("no declared tempo means no finding", w.check_tempo_vs_declared(84.0, None) is None)
    check("zero declared tempo is rejected", w.check_tempo_vs_declared(84.0, 0.0) is None)
    check("no fitted tempo means no finding", w.check_tempo_vs_declared(None, 80.0) is None)
    # declared_bpm arrives as a plain JSON number (int or float), not a marking
    # string — confirm parse_marked_bpm's numeric branch handles that shape, since
    # the worker reuses parse_marked_bpm to validate declared_bpm (see Task 3).
    check("parse_marked_bpm accepts a bare int", w.parse_marked_bpm(72) == 72.0,
          str(w.parse_marked_bpm(72)))
    check("parse_marked_bpm rejects an out-of-range bare int",
          w.parse_marked_bpm(400) is None, str(w.parse_marked_bpm(400)))
```

Register it in `main()`'s test tuple, immediately after
`test_tempo_vs_marking_reports_fact_not_fault,` (the tuple entry, not the `def`):

```python
              test_tempo_vs_marking_reports_fact_not_fault,
              test_tempo_vs_declared_reports_fact_not_fault,
              test_crescendo_that_never_arrives_is_flagged):
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -A3 "tempo_vs_declared"`
Expected: `AttributeError: module 'worker' has no attribute 'check_tempo_vs_declared'`
(or similar — the function doesn't exist yet).

- [ ] **Step 3: Implement `check_tempo_vs_declared`**

Add directly after `check_tempo_vs_marking` (worker.py:4018-4034), before the
`_REST_ONSET_GRACE` constant block:

```python
_TEMPO_DECLARED_PCT = 15.0   # same tolerance as the marked-tempo check


def check_tempo_vs_declared(fitted_bpm, declared_bpm) -> dict | None:
    """
    How the played tempo compares with what the student said they'd play.

    Same posture as check_tempo_vs_marking: reported as fact, not fault. A student
    who declared 80 and drifted to 95 made a tempo-stability observation available,
    not a mistake against the score. This is deliberately independent of
    check_tempo_vs_marking — both can fire on the same take (declared slower than
    marked, then played faster than declared, is two true, non-contradictory facts).
    """
    try:
        f = float(fitted_bpm or 0.0)
        d = float(declared_bpm or 0.0)
    except (TypeError, ValueError):
        return None
    if f <= 0 or d <= 0:
        return None
    pct = (f - d) / d * 100.0
    if abs(pct) < _TEMPO_DECLARED_PCT:
        return None
    return {"pct": round(abs(pct), 1),
            "direction": "faster" if pct > 0 else "slower",
            "fitted": round(f, 1), "declared": round(d, 1)}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -20`
Expected: the final line reads `NNN/NNN checks passed` with no `FAILED:` lines
naming `test_tempo_vs_declared_reports_fact_not_fault`.

- [ ] **Step 5: Register the new rule in the evidence table**

In `modal_worker/evidence.py`, add one line to `_DETECTOR_BY_TYPE` (line 30-43),
directly after the existing `"tempo_vs_marking"` entry:

```python
    "tempo_vs_marking":   ("check_tempo_vs_marking",     "measured"),
    "tempo_vs_declared":  ("check_tempo_vs_declared",    "measured"),
    "wedge":              ("analyze_wedges",             "measured"),
```

There is no dedicated test file for `evidence.py`'s table beyond
`modal_worker/test_evidence.py`; run it to confirm nothing broke:

Run: `python3 modal_worker/test_evidence.py`
Expected: all checks still pass (this change only adds a table entry, it can't
break an existing lookup).

- [ ] **Step 6: Commit**

```bash
git add modal_worker/worker.py modal_worker/evidence.py modal_worker/test_analysis.py
git commit -m "feat(worker): add check_tempo_vs_declared coaching comparison"
```

---

### Task 3: Worker — thread `declared_bpm` through the live pipeline

**Files:**
- Modify: `modal_worker/worker.py`:
  - `run_full_analysis` parameter extraction (around line 6008)
  - `_crepe_pipeline` closure (around line 6045)
  - `compare_and_coach_claude` signature (line 4317-4327) and its call site
    (line 6449-6461)
  - the `_tm` block inside `compare_and_coach_claude` (line 5468-5479)
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `check_tempo_vs_declared` and `parse_marked_bpm` from Task 2/existing
  code — both already exist by the time this task starts.
- Produces: `compare_and_coach_claude(..., declared_bpm: float | None = None)` — a
  new optional keyword parameter later tasks (none in this plan) could rely on.

- [ ] **Step 1: Extract `declared_bpm` from the payload**

In `run_full_analysis`, immediately after the existing `time_sig` line
(worker.py:6008):

```python
    time_sig            = payload.get("time_sig", "4/4")
    declared_bpm         = parse_marked_bpm(payload.get("declared_bpm"))
```

`parse_marked_bpm` already validates 20–300 and coerces `int`/`float` input to
`float` — reusing it here (rather than writing a second parser) is exactly what the
spec calls for: one valid-BPM definition in the worker.

- [ ] **Step 2: Seed the beat tracker**

In the `_crepe_pipeline` closure (worker.py:6045), change:

```python
        def _crepe_pipeline():
            wav_b, dur = extract_audio_from_video(video_bytes)
            bts = run_beat_tracking(wav_b)
```

to:

```python
        def _crepe_pipeline():
            wav_b, dur = extract_audio_from_video(video_bytes)
            bts = run_beat_tracking(wav_b, estimated_bpm=declared_bpm)
```

`declared_bpm` is a variable in `run_full_analysis`'s enclosing scope and is never
reassigned inside `_crepe_pipeline`, so it's captured by the closure with no
`nonlocal` needed — same as `instrument`, already used the same way two lines
below.

- [ ] **Step 3: Add the `declared_bpm` parameter to `compare_and_coach_claude`**

Change the signature (worker.py:4317-4327) from:

```python
def compare_and_coach_claude(
    score: dict, aligned: list[dict], alignment_ranges: list[dict],
    tempo: dict, piece_title: str, composer: str, instrument: str,
    gemini_assessment: dict, anthropic_api_key: str,
    user_note: str = "",
    video_duration: float = 0.0,
    start_measure: int = 1,
    beat_times: list | None = None,
    beats_per_measure: int | None = None,
    end_measure: int | None = None,
    dtw_verified: bool = False,
) -> list[dict]:
```

to:

```python
def compare_and_coach_claude(
    score: dict, aligned: list[dict], alignment_ranges: list[dict],
    tempo: dict, piece_title: str, composer: str, instrument: str,
    gemini_assessment: dict, anthropic_api_key: str,
    user_note: str = "",
    video_duration: float = 0.0,
    start_measure: int = 1,
    beat_times: list | None = None,
    beats_per_measure: int | None = None,
    end_measure: int | None = None,
    dtw_verified: bool = False,
    declared_bpm: float | None = None,
) -> list[dict]:
```

- [ ] **Step 4: Call the new comparison alongside the marked-tempo one**

In `compare_and_coach_claude`, change the `_tm` block (worker.py:5468-5479) from:

```python
        # Tempo against the marked tempo. Deliberately reported as fact, not
        # fault — see check_tempo_vs_marking's docstring.
        _marked = parse_marked_bpm(score.get("tempo_bpm") or score.get("tempo_marking"))
        _tm = check_tempo_vs_marking(timing_report.get("bpm"), _marked)
        if _tm:
            _add(measure_lo, "timing",
                 f"you played this at about {_tm['fitted']:.0f} BPM against a marked "
                 f"{_tm['marked']:.0f} BPM ({_tm['pct']}% {_tm['direction']}). If that "
                 f"was deliberate practice tempo, ignore this",
                 None, confirmed=True, is_global=True, priority=2,
                 measure_end=measure_hi if measure_hi > measure_lo else None,
                 rule="tempo_vs_marking", measured=_tm["pct"])
```

to:

```python
        # Tempo against the marked tempo. Deliberately reported as fact, not
        # fault — see check_tempo_vs_marking's docstring.
        _marked = parse_marked_bpm(score.get("tempo_bpm") or score.get("tempo_marking"))
        _tm = check_tempo_vs_marking(timing_report.get("bpm"), _marked)
        if _tm:
            _add(measure_lo, "timing",
                 f"you played this at about {_tm['fitted']:.0f} BPM against a marked "
                 f"{_tm['marked']:.0f} BPM ({_tm['pct']}% {_tm['direction']}). If that "
                 f"was deliberate practice tempo, ignore this",
                 None, confirmed=True, is_global=True, priority=2,
                 measure_end=measure_hi if measure_hi > measure_lo else None,
                 rule="tempo_vs_marking", measured=_tm["pct"])

        # Tempo against what the student declared they'd play. Independent of the
        # marked-tempo check above — see check_tempo_vs_declared's docstring for
        # why both can fire on the same take.
        _td = check_tempo_vs_declared(timing_report.get("bpm"), declared_bpm)
        if _td:
            _add(measure_lo, "timing",
                 f"you said you'd practice this at {_td['declared']:.0f} BPM but "
                 f"played it at about {_td['fitted']:.0f} BPM ({_td['pct']}% "
                 f"{_td['direction']}) — worth practicing with a metronome if you "
                 f"want to lock in your stated tempo",
                 None, confirmed=True, is_global=True, priority=2,
                 measure_end=measure_hi if measure_hi > measure_lo else None,
                 rule="tempo_vs_declared", measured=_td["pct"])
```

- [ ] **Step 5: Pass `declared_bpm` at the call site**

In `run_full_analysis`, change the `compare_and_coach_claude` call
(worker.py:6449-6461) from:

```python
            flags = compare_and_coach_claude(
                score=score, aligned=aligned, alignment_ranges=alignment_ranges,
                tempo={"bpm": beats["tempo_bpm"], "steadiness": "steady"},
                piece_title=piece_title, composer=composer, instrument=instrument,
                gemini_assessment=gemini_assessment, anthropic_api_key=anthropic_key,
                user_note=user_note,
                video_duration=beats.get("duration_sec") or video_duration,
                start_measure=start_measure,
                beat_times=beats.get("beat_times"),
                beats_per_measure=bpm_int,
                end_measure=end_measure,
                dtw_verified=(alignment_method_used in ("score_dtw", "reference_midi_dtw")),
            )
```

to:

```python
            flags = compare_and_coach_claude(
                score=score, aligned=aligned, alignment_ranges=alignment_ranges,
                tempo={"bpm": beats["tempo_bpm"], "steadiness": "steady"},
                piece_title=piece_title, composer=composer, instrument=instrument,
                gemini_assessment=gemini_assessment, anthropic_api_key=anthropic_key,
                user_note=user_note,
                video_duration=beats.get("duration_sec") or video_duration,
                start_measure=start_measure,
                beat_times=beats.get("beat_times"),
                beats_per_measure=bpm_int,
                end_measure=end_measure,
                dtw_verified=(alignment_method_used in ("score_dtw", "reference_midi_dtw")),
                declared_bpm=declared_bpm,
            )
```

- [ ] **Step 6: Verify the file still compiles**

Run: `python -m py_compile modal_worker/worker.py`
Expected: no output, exit code 0 (this is the same check
`.github/workflows/deploy-modal-worker.yml` runs before every deploy).

- [ ] **Step 7: Write a failing integration test**

`compare_and_coach_claude` is called directly with plain dict/list arguments
elsewhere in this test file (e.g. `test_rest_violation_outranks_a_placement_finding_in_dedup`),
so the new `declared_bpm` parameter is testable the same way, without touching
`run_full_analysis`'s untestable outer shell (network calls, webhook posts — nothing
in this suite runs that function end-to-end; see `test_form_time_signature_wins` for
the existing precedent of testing payload-driven behavior at the
`compare_and_coach_claude` / pure-function layer instead).

Add this test directly after `test_tempo_vs_declared_reports_fact_not_fault` (from
Task 2) in `modal_worker/test_analysis.py`. `compare_and_coach_claude` needs an
`alignment_ranges` list built from the aligned events — there is no shared helper
for this, so it's built inline exactly the way
`test_rest_violation_outranks_a_placement_finding_in_dedup` (lines ~2225-2242)
already does it:

```python
def test_declared_bpm_flows_into_compare_and_coach_claude():
    print("\n[59] declared_bpm reaches compare_and_coach_claude and produces a flag")
    score = make_score()
    played, evs = make_performance(score)
    al = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, instrument="clarinet")
    acc = {}
    for e in al:
        m, t = e["measure"], e["time_sec"]
        r = acc.setdefault(m, {"start": t, "end": t})
        r["start"], r["end"] = min(r["start"], t), max(r["end"], t)
    items = sorted(acc.items())
    spm = BEATS_PER_MEASURE * SEC_PER_BEAT
    ranges = []
    for i, (m, r) in enumerate(items):
        nxt = items[i + 1] if i + 1 < len(items) else None
        end = (nxt[1]["start"] if nxt[0] == m + 1 else min(nxt[1]["start"], r["start"] + spm)) \
            if nxt else max(r["end"] + spm / 4, r["start"] + spm)
        ranges.append({"measure": m, "start": r["start"], "end": max(end, r["start"] + 0.25)})

    real_bpm = 60.0 / SEC_PER_BEAT
    common_kwargs = dict(
        score=score, aligned=al, alignment_ranges=ranges,
        tempo={"bpm": real_bpm}, piece_title="Test", composer="X",
        instrument="clarinet", gemini_assessment=dict(EMPTY_GEMINI),
        anthropic_api_key="k", beats_per_measure=BEATS_PER_MEASURE,
        start_measure=START, end_measure=END, dtw_verified=True,
    )
    with_declared = w.compare_and_coach_claude(**common_kwargs, declared_bpm=real_bpm * 1.3)
    without_declared = w.compare_and_coach_claude(**common_kwargs)

    td_with = [f for f in with_declared if f.get("rule") == "tempo_vs_declared"]
    td_without = [f for f in without_declared if f.get("rule") == "tempo_vs_declared"]
    check("a tempo_vs_declared flag is produced when declared_bpm differs enough",
          len(td_with) == 1, str(len(with_declared)))
    check("no tempo_vs_declared flag when declared_bpm is not supplied",
          len(td_without) == 0, str(len(without_declared)))
    check("the flag names the measured percentage",
          bool(td_with) and td_with[0].get("measured") is not None, str(td_with))
```

Register it in `main()`'s test tuple, directly after
`test_tempo_vs_declared_reports_fact_not_fault,`:

```python
              test_tempo_vs_declared_reports_fact_not_fault,
              test_declared_bpm_flows_into_compare_and_coach_claude,
              test_crescendo_that_never_arrives_is_flagged):
```

- [ ] **Step 8: Run the test to verify it fails, then implement, then verify it passes**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "test_declared_bpm_flows"`
Expected first (before Steps 1-5 above are done): an error or a `FAILED` line, since
`compare_and_coach_claude` does not yet accept `declared_bpm`.
After Steps 1-5 are complete, re-run the same command.
Expected: no `FAILED:` line naming this test.

- [ ] **Step 9: Run the full worker test suite**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -5`
Expected: `NNN/NNN checks passed` with zero failures (confirms nothing else in the
5,900+ line file regressed).

- [ ] **Step 10: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): thread declared_bpm through run_full_analysis"
```

---

### Task 4: Edge function — accept, validate, persist, and dispatch `declaredBpm`

**Files:**
- Modify: `supabase/functions/analyze-performance/index.ts`

**Interfaces:**
- Consumes: nothing from Task 2/3 (edge function and worker are independently
  deployed; the worker already guards on `declared_bpm` being absent, so this task
  can ship before or after Task 2/3 land).
- Produces: `declared_bpm` (validated `number | null`) on the `takes` row, and
  `declared_bpm` in the Modal dispatch JSON body — the exact field name Task 3's
  `payload.get("declared_bpm")` reads.

- [ ] **Step 1: Destructure `declaredBpm` from the request body**

In the body-destructuring block (`supabase/functions/analyze-performance/index.ts:1173-1186`),
change:

```ts
    const body = await req.json()
    const {
      videoPath, videoMimeType,
      scorePath, scorePaths, scoreMimeType,
      pieceTitle, composer,
      timeSig, instrument, part, keySignature,
      startMeasure, endMeasure,
      videoFrames,
      tempo,
      songId,
      difficulty,
      scoreFacts,
      audioFeatures,
      notes,
    } = body
```

to:

```ts
    const body = await req.json()
    const {
      videoPath, videoMimeType,
      scorePath, scorePaths, scoreMimeType,
      pieceTitle, composer,
      timeSig, instrument, part, keySignature,
      startMeasure, endMeasure,
      videoFrames,
      tempo,
      declaredBpm,
      songId,
      difficulty,
      scoreFacts,
      audioFeatures,
      notes,
    } = body
```

- [ ] **Step 2: Validate it server-side, and reject the request if it's missing or out of range**

Directly after the existing `videoPath`/`videoMimeType` required-field check
(`supabase/functions/analyze-performance/index.ts:1195-1199`), which currently
reads:

```ts
    if (!videoPath || !videoMimeType) {
      return new Response(JSON.stringify({ error: 'videoPath and videoMimeType are required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }
```

add:

```ts
    // Never trust client validation alone — NewRecordingModal enforces 20–300
    // client-side, but the API boundary must reject a bad/missing value too.
    const safeDeclaredBpm = Number.isFinite(Number(declaredBpm))
      && Number(declaredBpm) >= 20 && Number(declaredBpm) <= 300
      ? Math.round(Number(declaredBpm))
      : null
    if (safeDeclaredBpm === null) {
      return new Response(JSON.stringify({ error: 'declaredBpm is required and must be between 20 and 300' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }
```

- [ ] **Step 3: Store it on the take row**

In the `takes` insert (`supabase/functions/analyze-performance/index.ts:1267-1284`),
change:

```ts
    const { data: take, error: insertError } = await admin
      .from('takes')
      .insert({
        user_id:         user.id,
        piece_title:     pieceTitle  ?? 'Untitled',
        piece_composer:  composer    ?? 'Unknown',
        instrument:      instrument  ?? null,
        video_path:      videoPath,
        video_mime_type: videoMimeType,
        score_path:      scorePath   ?? null,
        score_paths:     safeScorePaths.length ? safeScorePaths : null,
        note:            cleanNote,
        score:           null,
        flags:           [],
        job_status:      'processing',
        job_started_at:  new Date().toISOString(),
        ...(songId ? { song_id: songId } : {}),
      })
```

to:

```ts
    const { data: take, error: insertError } = await admin
      .from('takes')
      .insert({
        user_id:         user.id,
        piece_title:     pieceTitle  ?? 'Untitled',
        piece_composer:  composer    ?? 'Unknown',
        instrument:      instrument  ?? null,
        video_path:      videoPath,
        video_mime_type: videoMimeType,
        score_path:      scorePath   ?? null,
        score_paths:     safeScorePaths.length ? safeScorePaths : null,
        note:            cleanNote,
        declared_bpm:    safeDeclaredBpm,
        score:           null,
        flags:           [],
        job_status:      'processing',
        job_started_at:  new Date().toISOString(),
        ...(songId ? { song_id: songId } : {}),
      })
```

- [ ] **Step 4: Include it in the Modal dispatch payload**

In the Modal dispatch body (`supabase/functions/analyze-performance/index.ts:1364-1397`),
change:

```ts
              time_sig:             timeSig            ?? '4/4',
              key_signature:        keySignature       ?? '',
```

to:

```ts
              time_sig:             timeSig            ?? '4/4',
              declared_bpm:         safeDeclaredBpm,
              key_signature:        keySignature       ?? '',
```

- [ ] **Step 5: Verify the function compiles**

Run: `cd supabase/functions/analyze-performance && deno check index.ts`
Expected: no type errors. (If `deno` isn't on `PATH` in this environment, run
`npx --yes deno check index.ts` from the same directory instead — either confirms
the file parses and type-checks before it's ever deployed.)

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/analyze-performance/index.ts
git commit -m "feat(edge): require and forward declaredBpm to the Modal worker"
```

---

### Task 5: Frontend — required BPM field on `NewRecordingModal`

**Files:**
- Modify: `src/components/NewRecordingModal.jsx`

**Interfaces:**
- Consumes: nothing from other tasks (frontend, edge function, and worker deploy
  independently; this task can ship any time, though the field is inert until
  Task 4 is live).
- Produces: `declaredBpm` in the POST body to `analyze-performance` — the exact key
  Task 4's `const { ..., declaredBpm, ... } = body` reads.

- [ ] **Step 1: Add the field's state**

Directly after the existing `timeSig` state declaration
(`src/components/NewRecordingModal.jsx:80`):

```jsx
  const [timeSig, setTimeSig] = useState('4/4')
  const [declaredBpm, setDeclaredBpm] = useState('')
```

- [ ] **Step 2: Gate submission on a valid value**

Change `readyToAnalyze` (`src/components/NewRecordingModal.jsx:103`) from:

```jsx
  const readyToAnalyze = Boolean(performanceFile) && scoreFiles.length > 0 && Boolean(instrument.trim())
```

to:

```jsx
  const declaredBpmNum = parseInt(declaredBpm, 10)
  const declaredBpmValid = Number.isFinite(declaredBpmNum) && declaredBpmNum >= 20 && declaredBpmNum <= 300
  const readyToAnalyze = Boolean(performanceFile) && scoreFiles.length > 0
    && Boolean(instrument.trim()) && declaredBpmValid
```

- [ ] **Step 3: Send it in the submission body**

Change the `fetch` body (`src/components/NewRecordingModal.jsx:253-264`) from:

```jsx
          body: JSON.stringify({
            videoPath:     filePath,
            videoMimeType: media.type || (videoFile ? 'video/mp4' : 'audio/mpeg'),
            scorePath:     scorePath || undefined,
            scorePaths:    scorePaths.length ? scorePaths : undefined,
            scoreMimeType: scoreFiles[0]?.type || undefined,
            instrument:    instrument.trim(),
            pieceTitle:    pieceName.trim() || undefined,
            timeSig:       timeSig.trim() || '4/4',
            startMeasure:  startMeasure ? parseInt(startMeasure, 10) : 1,
            endMeasure:    endMeasure ? parseInt(endMeasure, 10) : undefined,
          }),
```

to:

```jsx
          body: JSON.stringify({
            videoPath:     filePath,
            videoMimeType: media.type || (videoFile ? 'video/mp4' : 'audio/mpeg'),
            scorePath:     scorePath || undefined,
            scorePaths:    scorePaths.length ? scorePaths : undefined,
            scoreMimeType: scoreFiles[0]?.type || undefined,
            instrument:    instrument.trim(),
            pieceTitle:    pieceName.trim() || undefined,
            timeSig:       timeSig.trim() || '4/4',
            declaredBpm:   declaredBpmNum,
            startMeasure:  startMeasure ? parseInt(startMeasure, 10) : 1,
            endMeasure:    endMeasure ? parseInt(endMeasure, 10) : undefined,
          }),
```

- [ ] **Step 4: Add the field's markup next to Time sig.**

The piece-name/start-measure/end-measure/time-sig flex row
(`src/components/NewRecordingModal.jsx:455-500`) is the field's natural home —
it's the exact row the spec means by "next to the existing time signature field."
That row currently reads:

```jsx
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label className={styles.fieldLabel}>Piece name</label>
                  <input
                    className={styles.textInput}
                    value={pieceName}
                    onChange={e => setPieceName(e.target.value)}
                    placeholder="e.g. Clair de lune"
                  />
                </div>
                <div style={{ width: 90 }}>
                  <label className={styles.fieldLabel}>Start measure</label>
                  <input
                    className={styles.textInput}
                    type="number"
                    min="1"
                    value={startMeasure}
                    onChange={e => setStartMeasure(e.target.value)}
                    placeholder="1"
                    style={{ textAlign: 'center' }}
                  />
                </div>
                <div style={{ width: 90 }}>
                  <label className={styles.fieldLabel}>End measure</label>
                  <input
                    className={styles.textInput}
                    type="number"
                    min="1"
                    value={endMeasure}
                    onChange={e => setEndMeasure(e.target.value)}
                    placeholder="last"
                    style={{ textAlign: 'center' }}
                  />
                </div>
                <div style={{ width: 90 }}>
                  <label className={styles.fieldLabel}>Time sig.</label>
                  <input
                    className={styles.textInput}
                    value={timeSig}
                    onChange={e => setTimeSig(e.target.value)}
                    placeholder="4/4"
                    style={{ textAlign: 'center' }}
                    title="Only needed if the sheet music's time signature isn't read correctly from the score image"
                  />
                </div>
              </div>
```

Add a fifth field, directly after the "Time sig." `<div>` and before the row's
closing `</div>`:

```jsx
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label className={styles.fieldLabel}>Piece name</label>
                  <input
                    className={styles.textInput}
                    value={pieceName}
                    onChange={e => setPieceName(e.target.value)}
                    placeholder="e.g. Clair de lune"
                  />
                </div>
                <div style={{ width: 90 }}>
                  <label className={styles.fieldLabel}>Start measure</label>
                  <input
                    className={styles.textInput}
                    type="number"
                    min="1"
                    value={startMeasure}
                    onChange={e => setStartMeasure(e.target.value)}
                    placeholder="1"
                    style={{ textAlign: 'center' }}
                  />
                </div>
                <div style={{ width: 90 }}>
                  <label className={styles.fieldLabel}>End measure</label>
                  <input
                    className={styles.textInput}
                    type="number"
                    min="1"
                    value={endMeasure}
                    onChange={e => setEndMeasure(e.target.value)}
                    placeholder="last"
                    style={{ textAlign: 'center' }}
                  />
                </div>
                <div style={{ width: 90 }}>
                  <label className={styles.fieldLabel}>Time sig.</label>
                  <input
                    className={styles.textInput}
                    value={timeSig}
                    onChange={e => setTimeSig(e.target.value)}
                    placeholder="4/4"
                    style={{ textAlign: 'center' }}
                    title="Only needed if the sheet music's time signature isn't read correctly from the score image"
                  />
                </div>
                <div style={{ width: 90 }}>
                  <label className={styles.fieldLabel}>Tempo (BPM)</label>
                  <input
                    className={styles.textInput}
                    type="number"
                    min="20"
                    max="300"
                    step="1"
                    inputMode="numeric"
                    value={declaredBpm}
                    onChange={e => setDeclaredBpm(e.target.value)}
                    placeholder="e.g. 96"
                    style={{ textAlign: 'center' }}
                    title="The tempo you intend to play this take at — used to seed timing analysis and compare against your actual tempo"
                  />
                </div>
              </div>
```

This reuses `styles.fieldLabel` and `styles.textInput` — both already used by
every other field in this exact row, so no new CSS is needed.

- [ ] **Step 5: Confirm the reused CSS classes still render correctly with a fifth field**

Run: `grep -n "fieldLabel\|textInput" src/components/NewRecordingModal.module.css`
Expected: both class names appear (they're already used by four sibling fields in
this same row, so this just confirms nothing about the module changed underneath
you). The five-field row now has `flex: 1` on the piece-name field only, with the
other four fixed at `width: 90` — at typical modal widths this fits on one line the
same way today's four-field row does; if the modal renders too cramped in Step 7's
manual check, wrap the row in a scrollable or two-line layout rather than shrinking
`width: 90` on the existing fields (that would touch fields outside this task's
scope).

- [ ] **Step 6: Verify the app builds and lints clean**

Run: `npm run build`
Expected: build succeeds with no errors.

Run: `npm run lint`
Expected: no new lint errors introduced by this file (pre-existing lint errors
elsewhere in the repo, e.g. the dead-code paths noted in `AGENT_TASKS.md`'s
Backlog, are not this task's responsibility).

- [ ] **Step 7: Manual verification in the browser**

There is no frontend test framework in this repo (`package.json` has no `test`
script; `grep -rn "vitest\|jest\|@testing-library" package.json` returns nothing),
so this step is manual, not a placeholder for an automated one:

1. Run `npm run dev`, open the app, open the New Recording modal.
2. Confirm the "Tempo you're practicing at (BPM)" field appears, required.
3. Confirm the submit path stays disabled (`readyToAnalyze` false) with the field
   empty, with a non-numeric value, and with a value outside 20–300 (test both 15
   and 350).
4. Confirm it enables once a valid value (e.g. 96) is entered alongside the other
   required fields.
5. Submit a real recording and confirm no client-side error occurs and the request
   reaches `analyze-performance` (watch the Network tab for the POST body
   containing `"declaredBpm":96`).

- [ ] **Step 8: Commit**

```bash
git add src/components/NewRecordingModal.jsx
git commit -m "feat(ui): add required declared-BPM field to NewRecordingModal"
```

---

## Spec coverage check

| Spec section | Task |
|---|---|
| Part 1 — frontend field, validation, `readyToAnalyze` gating | Task 5 |
| Part 1 — `declared_bpm` migration | Task 1 |
| Part 1 — dispatch payload | Task 4 |
| Part 2a — beat-tracker seed | Task 3 |
| Part 2b — `check_tempo_vs_declared` | Task 2 |
| Part 2b — wired into `compare_and_coach_claude` | Task 3 |
| Edge cases — missing `declared_bpm` guards | Task 2 (function itself), Task 3 (call sites default to `None`) |
| Edge cases — server-side range re-validation | Task 4 (edge function), Task 3 (`parse_marked_bpm` reuse in the worker) |
| Testing — worker unit tests | Task 2, Task 3 |
| Testing — frontend gating | Task 5 |
| Out of scope — backfill, `check_tempo_vs_marking` changes, reference-audio feature | Not touched by any task, as intended |
