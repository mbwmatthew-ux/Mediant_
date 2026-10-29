"""
Phase 1-2 consolidated report.

This file is NOT an automated aggregator -- Tasks 1-5 each print real
results to stdout/Modal logs in a human-readable form, and pretending to
parse and recompute them here would risk silently restating a number
wrong. Instead this file holds the REAL printed output of each task's
real command, copied in verbatim, plus an honest "not available yet" for
any section whose real command has not actually been run against real
inputs. No number below was estimated, predicted, or back-filled from
what the design doc expected -- every number is either a direct
transcription of real output or explicitly marked as not yet collected.

Required deliverables (spec Section 12):
1. Baseline: real cost, latency, accuracy, cache effectiveness.
2. SMT zero-shot accuracy, per instrument.
3. Gemini cross-check controlled evaluation.
4. Sonnet 5 vs Haiku 5.5 vs template coaching comparison.
5. This report: does the cascade warrant Phases 3-4?
"""

REPORT = """
# Phase 1-2 Validation Report

Generated: 2026-10-29 (report assembled this date; Section 2's command was
re-run this date -- see that section for the exact timestamp of the run
transcribed below. Sections 1, 3, 4 were never run against real inputs as
of this date; see each section for exactly what is blocking it.)

## 1. Baseline (Task 1) -- NOT AVAILABLE

Status: BLOCKED. Not filled in because the real command has never been
run against real production traffic.

What exists: the cost/cache-hit instrumentation itself is written and
committed --

  commit 1830151  feat(instrumentation): log real token usage and
                   score-cache hit/miss for Phase 1 baseline
                   (modal_worker/worker.py,
                   supabase/functions/analyze-performance/index.ts)
  commit 2532dd1  feat(instrumentation): log token usage for
                   resolve_measure_disagreement Claude call
                   (modal_worker/worker.py)

What's missing: this instrumented code has NOT been deployed to the live
Modal app. Confirmed this session:

  $ modal app list
  App ID: ap-WF0r1JCmlQLkjPS0DT4xD8   Description: mediant-worker
  State: deployed   Tasks: 2   Created at: 2026-05-18 22:21 EDT

`mediant-worker` was created 2026-05-18, five months before the
instrumentation commits above (2026-10-28) -- i.e. the app currently
serving real traffic predates the `[cost]` logging and cache hit/miss
logging entirely. There are no real `[cost]` lines or cache hit/miss
lines to sample yet.

Deploying the instrumented worker to production is a side effect outside
this task's scope (it requires separate user authorization) and was not
done here.

To unblock this section:
  1. Deploy the instrumented worker to the live `mediant-worker` Modal
     app (`modal_worker/deploy.sh`, or the project's normal deploy path).
  2. Let a real sample of N production analyses run against it.
  3. Grep the Modal logs for the real `[cost]` lines and the
     `[analyze-performance]` cache hit/miss lines, and paste that real
     output into this section (hit count / (hit count + miss count) =
     percentage).

<no real [cost] lines or cache hit/miss lines available -- none sampled>

## 2. SMT zero-shot accuracy (Task 3)

Status: REAL RUN COMPLETED. Re-run this session:

  $ python3 modal_worker/evaluate_smt_zero_shot.py

Real printed output, verbatim (calibration set, all 12 pieces; held-out
set, all 13 pieces; every instrument row in both):

```
calibration set (12 pieces): ['2191', '2202', '2218', '2219', '2241', '2243', '2289', '2294', '2295', '2296', '2297', '2298']
held-out set (13 pieces): ['2186', '2203', '2204', '2217', '2220', '2221', '2222', '2242', '2244', '2288', '2293', '2659', 'piano_synthetic']
  transcribing 2191 (Violin, 2 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/74 measures correct
  transcribing 2202 (Flute, 2 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/65 measures correct
  transcribing 2218 (Cello, 2 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/49 measures correct
  transcribing 2219 (Cello, 3 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/169 measures correct
  transcribing 2241 (Violin, 2 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/23 measures correct
  transcribing 2243 (Violin, 1 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/20 measures correct
  transcribing 2289 (Violin, 3 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/162 measures correct
  transcribing 2294 (Cello, 3 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/81 measures correct
  transcribing 2295 (Cello, 2 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/129 measures correct
  transcribing 2296 (Cello, 1 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/64 measures correct
  transcribing 2297 (Cello, 4 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/169 measures correct
  transcribing 2298 (Cello, 3 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/85 measures correct

=== calibration set ===
  Cello: 0.0% (0/746), 95% CI [0.0%, 0.51%]
  Flute: 0.0% (0/65), 95% CI [0.0%, 5.58%]
  Violin: 0.0% (0/279), 95% CI [0.0%, 1.36%]
  AGGREGATE: 0.0% (0/1090), 95% CI [0.0%, 0.35%]
  transcribing 2186 (Violin, 3 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/139 measures correct
  transcribing 2203 (Flute, 2 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/85 measures correct
  transcribing 2204 (Flute, 1 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/46 measures correct
  transcribing 2217 (Cello, 2 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/88 measures correct
  transcribing 2220 (Cello, 1 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/48 measures correct
  transcribing 2221 (Cello, 3 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/133 measures correct
  transcribing 2222 (Cello, 2 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/217 measures correct
  transcribing 2242 (Violin, 3 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/95 measures correct
  transcribing 2244 (Violin, 3 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/274 measures correct
  transcribing 2288 (Violin, 2 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/50 measures correct
  transcribing 2293 (Cello, 2 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/91 measures correct
  transcribing 2659 (Violin, 2 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/65 measures correct
  transcribing piano_synthetic (Piano, 1 page(s))...
    -> error: SMT model load failed: ModuleNotFoundError: No module named 'transformers'
    -> 0/8 measures correct

=== held_out set ===
  Cello: 0.0% (0/577), 95% CI [0.0%, 0.66%]
  Flute: 0.0% (0/131), 95% CI [0.0%, 2.85%]
  Piano: 0.0% (0/8), 95% CI [0.0%, 32.44%]
  Violin: 0.0% (0/623), 95% CI [0.0%, 0.61%]
  AGGREGATE: 0.0% (0/1339), 95% CI [0.0%, 0.29%]
```

**Headline result, with its mandatory caveat attached (not a footnote):**
SMT zero-shot scored 0% measure-localization accuracy across every
instrument and both splits (calibration 0/1090, held-out 0/1339,
including Piano 0/8) on clean-tier whole-page input. **SMT scored 0% on
whole-page input; untested on the row-cropped input shape it was
actually trained for and that Audiveris already produces via
`_prepare_score_rows`.**

**Second, equally load-bearing caveat -- a data-integrity finding from
re-running this script in this environment, not from the plan:** every
single one of the 25 per-piece error lines above reads identically:
`SMT model load failed: ModuleNotFoundError: No module named
'transformers'`. Confirmed directly in this environment:

```
$ pip3 show transformers
WARNING: Package(s) not found: transformers
$ pip3 show torch torchvision
WARNING: Package(s) not found: torch, torchvision
```

This means the SMT model never loaded for any of the 25 pieces in this
run -- `transcribe_with_smt`'s `_load_model` raised before a single image
was ever fed to the model, and the 0/N figures above come entirely from
`evaluate_smt_zero_shot.py`'s fail-open scoring path (a load failure
scores identically to "transcribed everything wrong"), not from the
model reading real pages and misreading them. **The 0.0% aggregate
numbers in this run are therefore a measurement of "could this
environment load SMT," not a measurement of "how accurate is SMT's
zero-shot whole-page transcription."** `torch` and `transformers` are
required by `modal_worker/smt_inference.py` and are not installed here;
no venv or requirements file pinning them was found in this repo.

This is a materially different situation from a completed 25-piece
zero-shot run with a working model, and the one genuine real-inference
result this repository has on record is smaller and comes from a
different source: `modal_worker/smt_inference.py`'s own docstring
(points 7-8, written during Task 3 Step 1, presumably in an environment
where `transformers`/`torch` were installed at the time) documents that
the model DID load successfully there and was run against two real
corpus pages directly: piece 2204's page 1 decoded completely (reached
`<eos>`) and produced a correct grand-staff header (two `**ekern_1.0`
columns, bass/treble clefs, 3/4 time) followed immediately by
end-of-sequence -- i.e. zero actual note/measure tokens were ever
emitted, a genuine real zero-shot miss on that one page. A second page
(2191) was manually killed after running past 15 minutes without
reaching `<eos>` (no KV-cache in this checkpoint-compatible code path;
confirmed quadratic-in-tokens CPU cost). That docstring explicitly
records that no full run across the corpus with a working model ever
completed, and no number in that docstring claims a 25-piece aggregate.

Net effect: this report has two non-identical pieces of real evidence
about SMT zero-shot whole-page accuracy -- (a) this session's 25-piece,
0/1090 + 0/1339 run, which is actually a complete model-load failure in
this sandbox and should be read as "not measured here, environment
missing `torch`/`transformers`," and (b) the one real single-page
inference result recorded in `smt_inference.py`'s docstring, which is a
genuine (if very small, n=1 complete page) zero-shot miss. Both point the
same direction -- no evidence yet of SMT succeeding at whole-page
measure localization -- but neither is a clean, complete, 25-piece
real-inference accuracy measurement, and this report does not claim one
exists.

## 3. Gemini cross-check extension (Task 4) -- NOT AVAILABLE

Status: BLOCKED. `modal_worker/evaluate_gemini_crosscheck.py` exists and
is unit-tested (`modal_worker/test_gemini_crosscheck.py`, 8/8 tests pass,
no API call made by the test suite), but the real paid evaluation run
(its Step 5) has never executed, because `GOOGLE_AI_API_KEY` has never
been supplied in this environment. Confirmed this session:

  $ echo "${GOOGLE_AI_API_KEY:-UNSET}"
  UNSET

`evaluate_gemini_crosscheck.py`'s own `main()` checks for this and exits
immediately with "GOOGLE_AI_API_KEY not set -- export it and re-run"
before making any network call, so no partial or accidental spend
occurred.

The script enforces a hard $2.00 spend cap via its own `BudgetGuard`
class (`guard = BudgetGuard(cap_dollars=2.00)`, line 148), gated on
worst-case rather than average per-call cost (per commit d3aba89).

To unblock this section:
  1. Supply a real key: `GOOGLE_AI_API_KEY=... python3
     modal_worker/evaluate_gemini_crosscheck.py`
  2. Paste its real printed per-piece output here, including the real
     total dollar cost it reports.

<no real Gemini cross-check output available -- never run with a key>

## 4. Coaching comparison (Task 5) -- NOT AVAILABLE

Status: BLOCKED. `modal_worker/evaluate_coaching_models.py` exists and
is unit-tested (`modal_worker/test_coaching_models.py`), but the real
paid three-arm run (Sonnet 5 / Haiku 5.5 / deterministic template) has
never executed, because `ANTHROPIC_API_KEY` has never been supplied in
this environment. Confirmed this session:

  $ echo "${ANTHROPIC_API_KEY:-UNSET}"
  UNSET

`evaluate_coaching_models.py`'s own `main()` checks for this and exits
immediately with "ANTHROPIC_API_KEY not set -- export it and re-run"
before making any network call.

The script enforces a hard $3.00 spend cap via the same `BudgetGuard`
class it imports from `evaluate_gemini_crosscheck` (`guard =
BudgetGuard(cap_dollars=3.00)`, line 142).

To unblock this section:
  1. Supply a real key: `ANTHROPIC_API_KEY=... python3
     modal_worker/evaluate_coaching_models.py`
  2. Paste its real printed three-arm output here, including the real
     total dollar cost it reports.

<no real coaching comparison output available -- never run with a key>

## 5. Recommendation

A final go/no-go call on building out Phases 3-4 CANNOT be made yet. Of
the four measurements the spec requires for that call, three have not
been run at all: Section 1 (real production cost/cache baseline) is
blocked on deploying the instrumented worker and sampling real traffic;
Section 3 (Gemini cross-check accuracy/cost) is blocked on
`GOOGLE_AI_API_KEY`; Section 4 (coaching quality/cost comparison) is
blocked on `ANTHROPIC_API_KEY`. None of those three numbers were
estimated or guessed at here -- they are simply not yet collected.

The one real, completed measurement this report has is Section 2's SMT
zero-shot result, and even that comes with the two caveats above. Read
narrowly and honestly, it supports exactly one conclusion: **zero-shot
SMT, used as a direct whole-page replacement for the current
Claude-vision score-reading calls, is not viable as it stands** -- 0%
measure-localization accuracy across every instrument and both splits in
this session's run (0/1090 calibration, 0/1339 held-out, including Piano
0/8), and the one genuine single-page real-inference result on record
(piece 2204, in `smt_inference.py`'s docstring) also decoded zero actual
measures. This conclusion does NOT extend any further than that:

  - It does NOT show SMT is unviable under the row-cropped input shape
    it was actually trained for (untested here -- this session's 0%
    numbers are dominated by a `transformers`/`torch` load failure in
    this specific sandbox, not by a completed whole-page inference run,
    and the one real inference result on record tested whole-page input
    only).
  - It does NOT mean the overall cascade redesign should be abandoned.
    The Audiveris-cascade path and the Haiku-coaching-swap path are
    independent of SMT and remain completely untested by anything in
    this report.

What unblocks each missing piece, concretely:
  1. Section 1 (baseline): deploy the instrumented worker (commits
     1830151, 2532dd1) to the live `mediant-worker` Modal app, let a real
     sample of production analyses run, then grep and paste the real
     `[cost]` lines and `[analyze-performance]` cache hit/miss lines.
  2. Section 3 (Gemini cross-check): supply `GOOGLE_AI_API_KEY` and run
     `GOOGLE_AI_API_KEY=... python3
     modal_worker/evaluate_gemini_crosscheck.py` (hard $2.00 cap already
     enforced).
  3. Section 4 (coaching comparison): supply `ANTHROPIC_API_KEY` and run
     `ANTHROPIC_API_KEY=... python3
     modal_worker/evaluate_coaching_models.py` (hard $3.00 cap already
     enforced).
  4. Section 2, if a cleaner SMT signal is wanted before Phases 3-4: fix
     this environment's missing `torch`/`transformers` (or run on a
     machine that has them, e.g. the Modal worker's own container image)
     and re-run `evaluate_smt_zero_shot.py` so the 25-piece aggregate
     reflects a completed model load rather than a load failure; and/or
     feed SMT the row-cropped input shape `_prepare_score_rows` already
     produces, since that is the shape it was actually trained for and
     whole-page input was never its intended use.
"""

if __name__ == "__main__":
    print(REPORT)
