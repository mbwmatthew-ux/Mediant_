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
re-run this date through the correct shared validation venv -- see that
section. Sections 1, 3, 4 were never run against real inputs as of this
date; see each section for exactly what is blocking it.)

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

Status: REAL RUN COMPLETED. First re-run this session used a bare
`python3` interpreter that lacked `torch`/`transformers` and surfaced a
spurious model-load failure -- caught, root-caused, and corrected before
this report was finalized (see note below). The authoritative run below
used the project's real shared validation venv, exactly as Task 3's
original run did:

  $ cd modal_worker && source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate && python3 evaluate_smt_zero_shot.py

Real printed output, verbatim (calibration set, all 12 pieces; held-out
set, all 13 pieces; every instrument row in both; model loaded
successfully for all 25 pieces, no load errors):

```
calibration set (12 pieces): ['2191', '2202', '2218', '2219', '2241', '2243', '2289', '2294', '2295', '2296', '2297', '2298']
held-out set (13 pieces): ['2186', '2203', '2204', '2217', '2220', '2221', '2222', '2242', '2244', '2288', '2293', '2659', 'piano_synthetic']
  transcribing 2191 (Violin, 2 page(s))...
    -> 0/74 measures correct
  transcribing 2202 (Flute, 2 page(s))...
    -> 0/65 measures correct
  transcribing 2218 (Cello, 2 page(s))...
    -> 0/49 measures correct
  transcribing 2219 (Cello, 3 page(s))...
    -> 0/169 measures correct
  transcribing 2241 (Violin, 2 page(s))...
    -> 0/23 measures correct
  transcribing 2243 (Violin, 1 page(s))...
    -> 0/20 measures correct
  transcribing 2289 (Violin, 3 page(s))...
    -> 0/162 measures correct
  transcribing 2294 (Cello, 3 page(s))...
    -> 0/81 measures correct
  transcribing 2295 (Cello, 2 page(s))...
    -> 0/129 measures correct
  transcribing 2296 (Cello, 1 page(s))...
    -> 0/64 measures correct
  transcribing 2297 (Cello, 4 page(s))...
    -> 0/169 measures correct
  transcribing 2298 (Cello, 3 page(s))...
    -> 0/85 measures correct

=== calibration set ===
  Cello: 0.0% (0/746), 95% CI [0.0%, 0.51%]
  Flute: 0.0% (0/65), 95% CI [0.0%, 5.58%]
  Violin: 0.0% (0/279), 95% CI [0.0%, 1.36%]
  AGGREGATE: 0.0% (0/1090), 95% CI [0.0%, 0.35%]
  transcribing 2186 (Violin, 3 page(s))...
    -> 0/139 measures correct
  transcribing 2203 (Flute, 2 page(s))...
    -> 0/85 measures correct
  transcribing 2204 (Flute, 1 page(s))...
    -> 0/46 measures correct
  transcribing 2217 (Cello, 2 page(s))...
    -> 0/88 measures correct
  transcribing 2220 (Cello, 1 page(s))...
    -> 0/48 measures correct
  transcribing 2221 (Cello, 3 page(s))...
    -> 0/133 measures correct
  transcribing 2222 (Cello, 2 page(s))...
    -> 0/217 measures correct
  transcribing 2242 (Violin, 3 page(s))...
    -> 0/95 measures correct
  transcribing 2244 (Violin, 3 page(s))...
    -> 0/274 measures correct
  transcribing 2288 (Violin, 2 page(s))...
    -> 0/50 measures correct
  transcribing 2293 (Cello, 2 page(s))...
    -> 0/91 measures correct
  transcribing 2659 (Violin, 2 page(s))...
    -> 0/65 measures correct
  transcribing piano_synthetic (Piano, 1 page(s))...
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
`_prepare_score_rows`.** Also run with generation capped at 150 of the
checkpoint's native 1281 tokens, for CPU feasibility; no run in this
corpus ever emitted a single note token, so the note-decoding path
itself was never exercised end to end.

**Root-cause note on how this run was produced:** an earlier pass at this
section ran `evaluate_smt_zero_shot.py` with a bare `python3` interpreter
that had no `torch`/`transformers` installed, producing an identical
`ModuleNotFoundError` on all 25 pieces -- a complete model-load failure,
not a measurement of SMT's accuracy. That was caught before this report
was finalized: `/Users/matthewwu/.cache/mediant_validation/venv` is the
real shared validation venv Task 3 originally used (confirmed:
`torch==2.14.1`, `transformers==4.46.3`, matching Task 3's pinned
versions exactly), it was simply not activated. Re-running through that
venv (the command shown above) completed cleanly with no load errors and
reproduced Task 3's original result exactly, number for number. The
output above is from that corrected, venv-activated run.

## 2a. SMT cropped-input follow-up (Phase 3 scope, mentor-recommended priority)

Status: REAL RUN COMPLETED (2026-10-29, after this report's initial version).
An outside mentor reviewing Section 2's 0% result flagged, correctly, that
0% on whole-page input establishes only that configuration failed, not that
SMT is unsuitable -- recommended testing row-cropped input (the shape the
checkpoint was actually trained on) before investing further or abandoning
it. Built `evaluate_smt_cropped_input.py` + `transcribe_row_with_smt`,
reusing `worker._prepare_score_rows`' existing per-system row crops (the
same crops Claude's own reading path already receives) on a bounded
4-piece subset (piano_synthetic + the smallest single-page Violin/Cello/
Flute pieces). Metric was deliberately binary -- did each row decode >=1
real note/rest token -- not a measure-accuracy percentage, since trusting
the row segmentation's own visual measure-count estimate to assign
absolute ground-truth measure numbers would risk conflating real model
failure with crop-segmentation error.

Real result: **Piano (true grand-staff training shape): 4/4 rows (100%)
decoded real notes. Non-piano (single-staff, still a partial shape
mismatch vs. the grand-staff checkpoint): 27/29 rows (93.1%).** Compare:
0/25 whole-page runs in Section 2 ever decoded a single note. Spot-checked
4 rows' actual decoded pitches directly to rule out a degenerate fixed-
output artifact -- confirmed real variation in pitch, rhythm, and note
count across different rows, not an echoed constant.

**This reopens, rather than settles, the question Section 2's "not viable
as it stands" verdict addressed.** That verdict was specifically about
whole-page input and remains true. But the decoder itself is not broken --
the earlier total failure was an input-shape problem, exactly as the
mentor predicted. The real next question -- is the decoded CONTENT
accurate, not just present -- is unanswered by this binary test and needs
the harder row-to-ground-truth alignment work this result now justifies
attempting. One accuracy red flag noticed in passing, not chased further:
a violin row decoded a note at E-flat3, below the violin's actual lowest
open string (G3) -- a sign the content is not yet validated as correct.

## 3. Gemini cross-check extension (Task 4)

Status: REAL RUN COMPLETED (2026-10-29). Real key supplied; script run to
completion with its $2.00 BudgetGuard cap active throughout. Three real
bugs were found and fixed while getting a usable run (each independently
root-caused against real response data, not guessed):
  1. `httpx.Client(timeout=60)` was too short for real multi-page-image +
     full-score JSON generation -- 4 of 5 pieces hit ReadTimeout on the
     first real attempt. Raised to 180s (commit 9912037).
  2. `gemini-2.5-flash` runs thinking by default, and thinking tokens draw
     from the SAME `maxOutputTokens` budget as the visible answer -- on
     the second attempt all 5 pieces hit MAX_TOKENS after only ~1400-1900
     characters of visible JSON (confirmed via the response's own
     `finishReason` field, added as a diagnostic). Disabled thinking
     entirely via `thinkingConfig.thinkingBudget=0` (commit 2e6b984) --
     this is deterministic extraction, not creative reasoning, so thinking
     has no value here.
  3. Even with thinking disabled, 2 of 5 pieces still hit MAX_TOKENS at
     16384 -- the per-note-per-measure JSON schema is verbose enough that
     a dense piece needs more room. Raised to 32768 (commit c28e3fd).

Final clean run, all 5 `FAST_ITERATION_SUBSET` pieces, real printed
output:

```
  [2204] 0/46 measures correct (0.0%), cost=$0.0288, running total=$0.0288
  [2220] 0/48 measures correct (0.0%), cost=$0.0239, running total=$0.0527
  [2243] 0/20 measures correct (0.0%), cost=$0.0141, running total=$0.0668
  [2296] 0/64 measures correct (0.0%), cost=$0.0365, running total=$0.1032
  [2191] 0/74 measures correct (0.0%), cost=$0.0466, running total=$0.1498

Total spent: $0.1498 of $2.00 cap
```

**0% exact-measure-match on all 5 real pieces, with the real total cost of
this run being $0.1498.** Total real spend across the full debugging
arc (two failed attempts plus this clean run) was approximately $0.58 of
the $2.00 cap.

**Independently verified this is real inaccuracy, not a scoring-code
artifact** (the same discipline applied to Section 2's SMT result):
fetched piece 2296's raw Gemini output directly and compared both against
ground truth AND against the actual corpus page image. Ground truth
measure 1 is a single sustained note (E-flat3, 3 beats); the real page
image shows exactly that, one dotted-half-note. Gemini's real measure 1
reported six eighth notes (G2, C3, F2, B2, E3, A2) -- structurally
different content, not a near-miss or a units/spelling mismatch. Gemini's
total measure count for this piece (72) also did not match ground truth's
real count (64). This was a single spot-check on one piece, not exhaustive
verification of all 5, but it rules out the most likely innocent
explanation (a scoring bug) for the uniform 0%.

**Conclusion for this deliverable:** this specific cross-check design --
one unconditional, whole-score-at-once prompt asking gemini-2.5-flash to
transcribe every measure across all pages in a single call -- does not
currently produce accurate-enough output to serve as a reconciliation
signal for the score-reading cascade. This does not rule out a
differently-scoped use of Gemini (e.g., smaller per-page or per-row calls,
closer to how Claude's own reading path is already structured), which
was not tested here.

## 4. Coaching comparison (Task 5)

Status: REAL RUN COMPLETED (2026-10-29). Real key supplied; script run to
completion with its $3.00 BudgetGuard cap active throughout. No errors, no
parse failures, real printed output for all 3 sample issues x 2 models:

```
--- issue: F#4 sharp, m.12, 34 cents ---
  [claude-sonnet-5]  cost=$0.00391  title='Sharp approaching the F#4'
  [claude-haiku-5-5] cost=$0.00047  title='Sharp on the F#4 note'

--- issue: dotted rhythm, m.25-27 ---
  [claude-sonnet-5]  cost=$0.00318  title='Uneven Dotted Rhythm in Measures 25-27'
  [claude-haiku-5-5] cost=$0.00057  title='Dotted rhythm proportions blurred in m.25-27'

--- issue: sustained high A flat, m.8, 22 cents ---
  [claude-sonnet-5]  cost=$0.00279  title='Flat on the sustained high A'
  [claude-haiku-5-5] cost=$0.00057  title='Flat on the sustained high A'

Total spent: $0.0115 of $3.00 cap (Sonnet 5: $0.00988, Haiku 5.5: $0.00161)
```

**Cost:** Haiku 5.5 was ~6.1x cheaper than Sonnet 5 per call on this
sample (list-price ratio is ~20x on input, ~20x on output; the smaller
realized ratio reflects this prompt's short, fixed-length input
dominating cost less than token-count differences in the two models' own
output). **Quality, read directly (n=3, not a statistically powered
sample):** both models' bodies stayed within the 40-word/2-sentence limit,
used only the facts given in `observed`, and read as comparably specific
and actionable -- Haiku's text was not noticeably thinner or more generic
than Sonnet's on these 3 issues.

**Real, concrete finding neither arm was expected to have:** for the F#4
intonation issue, BOTH `claude-sonnet-5` (production's current model) and
`claude-haiku-5-5` violated the exact same prompt's own explicit rule --
"NEVER put a number... in an intonation title" -- by writing "F#4" (with
the octave digit) instead of stripping it to "F#". The zero-cost
deterministic template correctly stripped the digit
(`deterministic_coaching_template`'s explicit `isdigit()` filter). Because
this is the real, verbatim production prompt text (not a modified
experimental version), this same violation is plausible in production
output today, independent of which model Mediant ultimately uses for
coaching -- worth a prompt fix (e.g., an explicit worked example showing
the digit stripped) regardless of the Sonnet-vs-Haiku decision.

**Conclusion for this deliverable:** on this small sample, Haiku 5.5
preserved comparable coaching quality at a real, substantial cost
reduction -- consistent with (not yet a confirmation of) the swap
hypothesis. 3 issues is too small a sample to generalize the quality
comparison with confidence; a larger run (more issues, more instruments,
ideally blind-rated) is the natural next step if this direction is
pursued further.

## 5. Recommendation

A final go/no-go call on building out Phases 3-4 still CANNOT be made with
full confidence, but three of the four required measurements are now real
(Sections 2/2a, 3, 4). Only Section 1 (real production cost/cache/latency
baseline) remains genuinely blocked -- it requires deploying the
instrumented worker to live production traffic, a decision outside this
report's authority. Per-section conclusions:

  - **SMT (Sections 2, 2a):** NOT viable as a direct whole-page
    replacement (0% across 25 pieces, both splits) -- but the decoder
    itself works once given correctly-shaped input (100% piano / 93.1%
    non-piano rows decoded real notes on a 4-piece follow-up). This is a
    genuine reopening, not a reversal: whether that decoded content is
    ACCURATE remains unmeasured and is the natural next step, not yet a
    reason to promote or discard SMT.
  - **Gemini cross-check (Section 3):** the specific design tested here
    (one unconditional whole-score prompt per piece) does NOT currently
    produce accurate output -- 0% exact-measure-match on all 5 real
    pieces, independently confirmed as real inaccuracy (not a scoring bug)
    by comparing one piece's output directly against its real page image.
    This result is specific to this prompt/call shape, not a verdict on
    Gemini generally.
  - **Coaching comparison (Section 4):** Haiku 5.5 looks promising --
    comparable quality to Sonnet 5 on a small (n=3) real sample, at
    roughly 1/6th the real cost. Not yet a confirmed result (sample too
    small), but directionally supports the swap. Separately surfaced a
    real prompt-compliance bug (the digit-in-title rule) present in BOTH
    models against the actual production prompt -- worth fixing
    regardless of which model is ultimately used.

**Net picture:** nothing tested so far supports keeping either SMT or this
Gemini cross-check design as-is in the cascade. The Haiku coaching swap is
the one result that looks ready for a larger confirmatory run. The
SMT row-cropped accuracy question and the production baseline deploy are
the two largest remaining unknowns before a confident Phases 3-4 decision.

What unblocks what remains, concretely:
  1. Section 1 (baseline): deploy the instrumented worker (commits
     1830151, 2532dd1) to the live `mediant-worker` Modal app, let a real
     sample of production analyses run, then grep and paste the real
     `[cost]` lines and `[analyze-performance]` cache hit/miss lines.
  2. SMT row-cropped accuracy: build the row-to-ground-truth alignment
     Section 2a deliberately deferred, to turn the binary "decoded a real
     note" signal into an actual accuracy measurement.
  3. Gemini: if pursued further, test a differently-scoped call shape
     (smaller per-page/per-row calls) rather than concluding Gemini
     cross-checking is unworkable outright from this one design.
  4. Coaching comparison: a larger, ideally blind-rated run across more
     issues/instruments to confirm the n=3 quality-parity signal, and a
     prompt fix for the digit-in-title compliance gap found in both
     models.
"""

if __name__ == "__main__":
    print(REPORT)
