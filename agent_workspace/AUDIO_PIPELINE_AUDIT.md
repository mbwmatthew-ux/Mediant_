# Audio Pipeline Audit — Baseline (2026-10-30)

Read-only audit for docs/superpowers/plans/2026-10-30-audio-pipeline-benchmark.md.
Compiles already-measured results; nothing here was re-run.

---

## CRITICAL (2026-10-31): the real wrong-note detector has ~0% true recall and ~50% false-positive rate — prior "96.3% detection" number was measuring a different, degenerate thing

Found during Phase 2 of "MEDIANT — Continue Pipeline Validation and
Prepare Coaching Evaluation." This revises what every prior round
believed about the project's actual mistake-detection capability and
should be read before trusting any earlier "detection" percentage in
this file or in AGENT_TASKS.md's Track B entry.

**What the prior "96.3% detection / 57.7% localization / 100% control
false-positive" numbers (Track B, `agent_workspace/AGENT_TASKS.md`)
actually measured:** whether `dtw_align_to_score` aligns *something*
within 0.3s of a reference timestamp on the injected-mistake condition
vs. the untouched control. DTW aligns continuously across an entire
piece by construction, so this is true on nearly every piece regardless
of whether a mistake was injected — it is not, and never was, a measure
of mistake-detection. Confirmed by re-running it fresh this round:
identical 100%/100%/100% degenerate pattern on every piece, including
controls.

**What the ACTUAL production detector does, measured for the first time
this round:** called `find_wrong_note_candidates` — the real function
`run_full_analysis` uses to generate wrong-note flags — on the same 18
held-out MusicNet pieces' `wrong_pitch` and `control` conditions (real
audio, synthetic pitch-substitution injection via the existing
`inject_audio_mistakes.py`, zero paid API calls).

- **True wrong-pitch recall: 0/18 = 0.0%.** The detector never once
  located the actual injected wrong note, on any of the 18 pieces.
- **True false-positive rate on unmodified, correct audio: 9/18 = 50.0%.**
  Half the time, the real detector flags something as a wrong note on a
  performance that has no mistake in it at all.
- In nearly every piece, the flag set produced for `wrong_pitch` and for
  `control` is almost identical — strong evidence the detector is firing
  on fixed, pre-existing CREPE/alignment artifacts specific to that
  recording, not responding to the actual injected mistake at all.
- Two pieces (2220, 2296, both Cello) tripped the detector's own
  "more than 25% of notes look wrong" sanity gate and got fully
  suppressed (51-54% of notes flagged) — a separate, piece-specific
  breakdown.
- **Plausible but UNVERIFIED hypothesis, not confirmed, flagged for
  follow-up only:** hundreds of events per piece (374-769) may be
  getting classified as "squeak-shaped" and routed away from the
  wrong-note comparator before it ever sees them — which could be
  silently swallowing the injected note. This has not been traced to a
  confirmed root cause.

**Also confirmed this round: there is no missing-note or extra-note
detector in production at all.** The only three detectors are
`find_wrong_note_candidates`, `find_crack_candidates`, and
`find_rest_violations`; the last only fires for notes played during a
*written* rest, which none of the injected test cases are. No
precision/recall number exists for missing/extra notes because the
capability itself doesn't exist yet to measure.

**What this is NOT (yet) known to be:** whether this is a fixable
software bug (e.g. the "squeak-shaped" routing hypothesis, an
off-by-something in which audio/score window gets compared, a threshold
set wrong) or a genuine, harder accuracy limitation of CREPE+DTW's
precision. 0% recall across 18 pieces (not just "low," literally zero)
is suspicious enough to suggest a systematic bug rather than pure
imprecision, but this has NOT been root-caused — only the symptom has
been measured, rigorously, for the first time.

**Status: this finding is more launch-critical than anything else in
this file.** It directly contradicts the product's core promise
("measure-level feedback on pitch, rhythm, dynamics, articulation") and
was previously masked by a measurement that looked like a strong real
number (96.3%) but wasn't measuring the right thing. Root-caused below —
read that section before treating "0% recall" as the final word on
real-world performance.

### Root cause of the 0% recall / 50% FP (2026-10-31, same day, confirmed via direct instrumentation on 4 real pieces — 2293, 2217, 2242, 2220)

**Not one mechanism — three, two of which are measurement artifacts and
one of which is a real, confirmed detector design issue.**

1. **Confirmed real design issue (piece 2220, cleanest case): the squeak
   filter kills an exact-pitch-match injected event even though nothing
   about it is unstable.** Traced the actual injected event: `midi_raw`
   matches the injected wrong note exactly, confidence 70, **cents
   spread 0 (perfectly stable)**, duration 0.302s — passes every one of
   `find_wrong_note_candidates`'s own gates (conf≥65, dur≥0.08,
   spread≤40). It never reaches those gates: `looks_like_squeak`
   (worker.py:792) kills it upstream purely because
   `conf(70) <= _SQUEAK_CONF(70)` — one branch of an OR, with zero
   instability evidence (spread=0 directly contradicts the function's
   own stated definition, "pitch that will not hold still"). Same
   pattern confirmed on piece 2293. **Nothing about this mechanism is
   specific to synthetic injection — a real wrong note played with
   confidence exactly at this threshold and a stable pitch would be
   killed the same way.** Not fixed this round: `looks_like_squeak` has
   its own validated history protecting real clarinet squeak/crack
   detection (worker.py:7542-7551's own comment references a prior
   incident from narrowing this exact logic) — a blind tighten-the-OR
   fix validated on 4 pieces risks regressing that already-shipped
   behavior. Needs full-corpus validation against both this benchmark
   AND existing squeak/crack test coverage before any change — not a
   one-line fix to take on faith.
2. **Confirmed measurement artifact (piece 2242): `librosa.effects.pitch_shift`'s
   own phase-vocoder artifacts depress CREPE's confidence below the
   detector's bar.** The event matching the injected note measured
   confidence 60 — below `MIN_CONF=65` — independent of the squeak
   filter. This means the "0% recall" number **understates** real-world
   recall; it does not prove the detector would miss an authentically-played
   wrong note with clean, confident pitch tracking.
3. **Confirmed measurement artifact (piece 2217): a very short injected
   note (0.139s) produced no distinct CREPE event at the substituted
   pitch at all** — same category, a limitation of the injection
   methodology's short-window case, not the detector.

**Separate, still-unexplained finding: every traced piece has
pre-existing "wrong note" false-positive candidates at measures
unrelated to the injection** (2293: 1, 2217: 6, 2242: 6) — confirms the
"flag set is nearly identical between `wrong_pitch` and `control`"
observation directly. These are present regardless of injection, so
they are not synthetic-injection artifacts, but no root cause was traced
to a specific line this round — that is the real driver of the 50%
false-positive-on-correct-audio rate and remains open.

### Task 1 (2026-10-31, same day): benchmark validity repaired across the FULL 18-piece set — overturns the earlier 4-piece sample's headline conclusion

The earlier root-cause pass (4 sample pieces: 2293, 2217, 2242, 2220)
suggested roughly half the misses were synthetic-injection-methodology
artifacts (librosa pitch_shift confidence depression, short-note
non-events) rather than real detector failures. **That was correct as
far as it went, but underpowered — the full 18-piece set shows the
opposite balance.**

- **Recall across all 18 intended `wrong_pitch` injections: 0/18 = 0%.**
- **Recall conditional on independently-verified-observable injections
  (confirmed via direct inspection of real `run_pitch_tracking` output,
  not inferred): 0/15 = 0%.** 15 of the 18 injected mistakes produced a
  real CREPE event matching the intended wrong pitch within 1 semitone
  — genuinely clean, correctly-pitched, observable audio. The real
  production detector never flagged the correct measure on ANY of them.
- **Only 3/18 (17%) are non-observable** (methodology limitations): one
  (2204, Flute) landed 18 semitones off — a different measurement issue
  entirely — and two (2217, 2297, both Cello) landed exactly 2 semitones
  short of the intended shift, a specific, repeatable
  `librosa.effects.pitch_shift` under-shoot pattern on those two cases.
- **Per instrument: recall is 0% in Violin (5/5 observable), Cello (9/11
  observable), and Flute (2/3 observable) alike — the detector-logic
  miss is universal across instrument, not instrument-specific.**
- `deleted_note`/`duplicated_note` were also measured across all 18
  pieces for completeness, but `find_wrong_note_candidates` was never
  designed to catch either (a duplicated note is the CORRECT pitch
  played twice; a deleted note is an absence) — 0/18 on both is expected
  by design, not new evidence of failure, and there remains no
  missing/extra-note detector in production at all (confirmed
  separately, unchanged).

**Revised conclusion: the problem is overwhelmingly in the detector's
own logic, not the benchmark.** 15 of 18 real, clean, correctly-pitched
injected mistakes were never flagged. This makes the squeak-filter
mechanism found on the 4-piece sample (worker.py:792's
`conf <= _SQUEAK_CONF` branch with no instability requirement) far more
consequential than it looked on that smaller sample — it is plausibly
the dominant mechanism across most of these 15 misses, though that has
not yet been traced at this full scale (Task 3 does that next).

### Task 2 (2026-10-31, same day): false-positive root cause — resolved, and it's good news for the comparator specifically

Re-ran `find_wrong_note_candidates` against all 18 held-out pieces' real,
unmodified audio (no detector changes). Confirmed the recording-level
incidence exactly: **9/18 pieces, 36 total false-positive flags**
(2204:6, 2217:6, 2222:6, 2241:1, 2242:6, 2289:3, 2293:1, 2295:1, 2297:6).

Classified every one of the 36 flags against MusicNet's own ground truth:
- **Alignment/measure-mismatch: 15/36 (41.7%)** — CREPE's pitch is
  exactly right; `dtw_align_to_score` put the event in the wrong
  measure, so the comparator checked it against the wrong measure's
  expected notes. This is the single largest cause.
- **CREPE misread: 14/36 (38.9%)** — the detected pitch genuinely
  doesn't match ground truth at that timestamp.
- **Unclear: 7/36 (19.4%)** — ground-truth onset too far (>0.15s) from
  the flagged timestamp to attribute confidently without manual review.
- **Filter gap, comparator logic, genuine performance/notation
  difference: 0/36 each.**

**None of the 36 false positives trace to `find_wrong_note_candidates`'s
own logic** (squeak filter, semitone-distance gates, transposition
guard). The comparator is faithfully reporting what upstream DTW
alignment and CREPE pitch tracking hand it. The 50% false-positive rate
is driven almost entirely by two already-known, already-documented
limitation classes in this project (the standing ~65% DTW measure-
localization accuracy, and CREPE's own pitch-tracking error rate) — not
a new comparator defect. This reframes the FP problem: it isn't
"the wrong-note detector has a bug," it's "the wrong-note detector
correctly amplifies pre-existing alignment/pitch-tracking error into a
confident, student-facing false accusation." Fixing it for real means
improving alignment/pitch-tracking accuracy (the already-"stop tuning"
DTW mechanism and the CREPE pipeline), not a comparator-logic patch.

**Bottom line, updated after Task 1's full 18-piece measurement:**
recall is genuinely ~0% on real, cleanly-observable, correctly-pitched
injected mistakes (0/15 conditional recall) — this is NOT mostly a
measurement artifact; only 3/18 (17%) of injections were non-observable.
The detector-logic failure (most plausibly the squeak filter, per the
4-piece trace, now needing full-scale confirmation) is real and
dominant. The 50% false-positive rate on correct playing is separately
resolved (Task 2): 80.6% of it (41.7% alignment + 38.9% CREPE) traces to
two already-known upstream limitation classes, not to the comparator's
own logic (0/36). No fix was implemented this round for the recall
side — per the systematic-debugging skill's Iron Law, none of the three
recall mechanisms had a fix that could be safely validated within this
turn's scope; that validation is exactly what Task 3 does next.

---

### The four failure categories, and what already has a real number

**1. Score-reading failures (Claude vision transcribing a photographed/PDF score into notes)**
Real, measured this session on piece 2243 (12/8 Violin): 0/20 exact-measure accuracy, but 30.7% pitch accuracy / 21.6% rhythm accuracy at note level (`modal_worker/score_detailed_metrics.py`, scored from `modal_worker/probe_result_2243.json`). A real bug (compound-meter beat convention) was found and fixed (commit `0b7889d`, deployed). Separate, ongoing investigation — out of scope for THIS plan, which is audio-side only. See `agent_workspace/AGENT_TASKS.md`'s "Track A" entry.

**2. Audio-transcription failures (CREPE pitch detection, in isolation from any score)**
Already measured and fixed. `modal_worker/validate_pitch_against_tinysol.py` ran the real `run_pitch_tracking` against TinySOL (Cella et al. 2020, CC-BY 4.0) — 2,224 real isolated, individually-labeled notes across 13 orchestral instruments. Round 1 (before fix): 60.7% correct, 37.0% missed, concentrated in quiet (pp) dynamics and specifically Violin/Viola. Root cause: the breath-noise gate used an absolute amplitude threshold instead of a per-take-relative one (see Obsidian `Fixes/Fix — Breath-noise gate was an absolute amplitude threshold.md`). After the fix: **95.6% correct overall, pp 96.2%, Violin 94.7%, Viola 96.8%, precision-when-detected 96.4% (unchanged — this was always a recall problem, never a wrong-pitch problem).**
Real, open gap this corpus explicitly cannot cover: TinySOL's notes are isolated, not played against a score — it validates pitch detection, not alignment (next section), and it has no corpus for the false-positive side of the breath-noise gate (admitting real noise as a note).

**3. Alignment failures (DTW matching a detected audio event to the right score measure)**
Already measured and substantially improved, with a documented, explicit "stop tuning" decision on what's left. `modal_worker/validate_alignment_against_musicnet.py` runs the real `run_pitch_tracking` + `dtw_align_to_score` against MusicNet (Zenodo doi:10.5281/zenodo.5120004) — 20 scored solo Violin/Cello/Flute Bach pieces (4 of 24 excluded by `calibrate_assumptions()`'s own sanity check), 22,095 note-events. Original baseline: 46.7% correct, sharply bimodal (83-95% on 8 pieces, 0-3% on 9 pieces). Root cause, confirmed via detected/true event-count ratio: catastrophic failures are slow/legato passages where CREPE's onset detector fires spurious extra onsets within one sustained note (vibrato, bow noise), breaking the pitch-only DTW cost function's warping path. Three shipped fixes since (rest-anchored segmentation, within-segment pitch-jump detection, local-outlier rejection) moved the real 20-piece number **46.7% → 55.7% → 63.7% → 65.4%** (current, as of 2026-10-22). Five further tuning attempts on the remaining over-counting pieces (2220, 2241, 2296, 2204, parts of 2242) were each tried and reverted — a 2026-10-15 decision in `agent_workspace/AGENT_TASKS.md` explicitly says **stop tuning this mechanism; the remaining gap needs either a new idea or a real VAD/onset model, not another threshold variant.** Owner's target is 80%+ on most/all pieces — not yet reached, and not this plan's job to chase further (see Task 3's scope note).

**4. Final feedback-generation failures (Gemini's `evaluate_with_gemini` authoring flags from audio+video+score; Claude's `compare_and_coach_claude` fusing those with CREPE/DTW evidence into the student-facing flags)**
**No existing harness measures this against ground truth at all.** `modal_worker/score_against_annotations.py` computes precision/recall from real teacher annotations, but `agent_workspace/ACCURACY_BASELINE.md` confirms zero teacher annotations exist on any of 199 real production takes, and this environment has no service-role DB access to harvest them even if they existed — that path is fully blocked, independent of this plan. This is the real, unaddressed gap, and the one new thing this plan builds toward.

---

### Execution-path diagram (score → audio → flags)

```
photo/PDF score ──> read_score_notes_claude (3x Claude vision + Audiveris + resolution)
                     -> score {"measures": [...], "time_signature": ...}
                     (score-reading: see category 1 above, separate plan)
recording (wav) ──> run_pitch_tracking(wav_bytes, guide_times, instrument)
                     -> events: [{"pitches": [...], "time_sec": ..., ...}, ...]
                     (category 2 above)
events + score ───> dtw_align_to_score(events, score, start_measure, beats_per_measure, end_measure)
                     -> aligned: [{..., "measure": N, "time_sec": ...}, ...]
                     (category 3 above; flatten_score_notes supplies DTW's score_seq)
video/audio + score ─> evaluate_with_gemini(file_uri, mime_type, instrument, ..., score_pages=[...])
                     -> gemini_assessment: {"intonation_issues": [...], "rhythm_issues": [...], ...}
                     (category 4, Gemini half)
aligned + gemini_assessment + score ─> compare_and_coach_claude(score, aligned, alignment_ranges,
                     tempo, ..., gemini_assessment, anthropic_api_key, ...)
                     -> list[dict] flags (final, student-facing)
                     (category 4, Claude fusion half; unresolved score measures are suppressed
                     here via NON_SCORE_DEPENDENT_TYPES, not dropped from DTW's input)
```

Confirmed directly in `modal_worker/worker.py`: `run_pitch_tracking` (:884), `dtw_align_to_score` (:2289), `flatten_score_notes` (:1899), `evaluate_with_gemini` (:3669), `compare_and_coach_claude` (:8121, unresolved-measure suppression at :8143-8154).

---

### What this plan will NOT re-attempt

Per the "stop tuning" decision above, this plan does not propose a sixth variant of the rest-anchor/pitch-jump DTW tuning mechanism. If Task 3's new benchmark reproduces the same bimodal, event-count-ratio-correlated failure on its injected cases, that confirms the existing root cause rather than discovering a new one — report it as confirmation, not as license to start tuning thresholds again.

---

## Results — Task 3: free-leg (CREPE+DTW) chained benchmark against injected mistakes (2026-10-30)

Real run against real MusicNet data (not mocked, not synthetic beyond the
deliberate mistake injection itself). Full methodology, design notes, and the
corrected cross-validation discussion are in
`.superpowers/sdd/2026-10-30-audio-pipeline-benchmark/task-3-report.md`
(gitignored scratch location — this section is the durable, committed copy of
its headline numbers and key finding). Built by `modal_worker/benchmark_full_pipeline.py`
(`run_free_legs`) and `modal_worker/run_task3_benchmark.py` (real-data
aggregation layer). Zero paid API calls made — only the free CREPE+DTW half of
the pipeline was exercised.

**Held-out set:** 18 of the 24 real MusicNet solo pieces (3 Flute, 10 Cello,
5 Violin) — Bach, unaccompanied. Same 4 exclusions as the earlier
`validate_alignment_against_musicnet.py` session (`2191`, `2243`, `2298`,
`2659`, all excluded by that script's own `calibrate_assumptions()` sanity
check). 2 further pieces (`2186`, `2219`) were a mechanical dev/sanity set,
run but never included in these scored numbers.

**Headline numbers (72 total runs: 54 injected + 18 control):**

```
Detection accuracy    (injected, n=54): 52/54 = 96.3%
Localization accuracy (of detected, n=52): 30/52 = 57.7%
False-positive rate   (control, n=18): 18/18 = 100.0%
  Of those false-positive detections, mislocalized vs ground truth: 8/18 = 44.4%
```

**By mistake type:**

| mistake_type | detection | localization (of detected) |
|---|---|---|
| wrong_pitch | 18/18 (100.0%) | 10/18 (55.6%) |
| deleted_note | 16/18 (88.9%) | 10/16 (62.5%) |
| duplicated_note | 18/18 (100.0%) | 10/18 (55.6%) |

(False-positive rate is identical — 18/18, 100% — across all 3 mistake types
by construction: the control condition is run once per piece, since
`inject_mistake`'s target-note draw is the same for all 3 types at
`rng_seed=0`, so there's nothing to vary across mistake types.)

**By instrument:**

| instrument | n_pieces | detection | localization (of detected) | FP |
|---|---|---|---|---|
| Cello | 10 | 29/30 (96.7%) | 18/29 (62.1%) | 10/10 (100.0%) |
| Flute | 3 | 9/9 (100.0%) | 3/9 (33.3%) | 3/3 (100.0%) |
| Violin | 5 | 14/15 (93.3%) | 9/14 (64.3%) | 5/5 (100.0%) |

Flute's 33.3% localization rests on only 3 pieces (1 of 3 landed correctly) —
not enough n to call this an instrument-level trend on its own.

**Key methodological finding:** "detection," as defined here (any DTW-aligned
event lands within 0.3s of the probed timestamp), fires on **ordinary,
uninjected control audio just as readily as on injected audio** — the 100%
control false-positive rate is not the pipeline hallucinating mistakes; it's
that `run_pitch_tracking` emits dense enough event streams that something
almost always lands in the 0.3s window regardless of whether anything is
actually wrong there. Detection as defined mostly measures audio event
density, not mistake-specific anomaly detection. **Localization accuracy is
the metric with real discriminative signal** — it reflects whether DTW
landed on the correct measure, independent of whether a mistake occurred
there. This matters directly for Task 4 planning: a paid-leg gate built on
"did the free legs detect something" would gate out almost nothing (96-100%
detection regardless of condition); a gate should use localization instead.

**Sample-size caveat:** one probe (one injected/control location) per piece,
n=18 pieces — 18 independent sample points, not a dense per-piece sample.
Every held-out piece's `localization_correct` value is identical across all 4
of its conditions (confirms the already-known finding that alignment
correctness is a property of the piece/passage, not of what's injected
there) — but also means a different `rng_seed` landing on a different measure
within the same piece could flip that piece's result. Piece-level results
here should be read as noisy, not as settled per-piece verdicts.

**Corrected cross-validation against the earlier large MusicNet validation
session** (`Sessions/2026-10-11 (2) — MusicNet score-alignment validation.md`):
10 pieces localized correctly on all 4 of their conditions here
(`2203, 2218, 2221, 2244, 2288, 2289, 2293, 2294, 2295, 2297`). Checking that
session's own per-piece buckets directly: only **6** of those 10
(`2203, 2218, 2244, 2289, 2294, 2295`) are actually in that session's
83-95%-correct bucket — genuine agreement between the two runs. The other
**4** (`2221, 2293, 2288` — actually in that session's 0-3%-correct bucket,
i.e. near-total alignment failure across the whole piece; `2297` — actually
in the 46-68%-correct mixed bucket) are **not independent confirmation**: a
single lucky probe can land correctly inside an overall-bad or mixed piece
precisely because this benchmark samples only one location per piece. The
6-piece agreement is the real cross-validation signal; the other 4 are
"not contradicted by sample-size noise," not corroboration.

---

## Priority 3 category audit (2026-10-31): where rhythm/alignment errors
## actually come from, and why no new DTW change ships this round

Per "MEDIANT — Finish Visual Integration and Improve Audio Accuracy,"
Priority 3 asks whether the largest alignment errors are false onsets,
missed repeated notes, sustained/legato transitions, tempo variation, or
incorrect score-to-performance mapping — and explicitly says not to
resume open-ended DTW tuning without direct evidence, implementing at
most one targeted fix.

**No code was changed for this priority.** The evidence below is drawn
from `modal_worker/musicnet_alignment_misses.csv` (753KB, the real
per-event miss list from the validation run that produced the current
65.4% baseline) and `agent_workspace/AGENT_TASKS.md`'s Backlog entry
"Score-alignment residual gap" — both confirmed, not assumed, to still
describe the live code: `git log --oneline --since=2026-10-22
--until=2026-10-31 -- modal_worker/worker.py` shows every commit since
that CSV was generated touched either instrumentation/logging, the
score-reading *prompt* (compound-meter fix, visual-path only), or the
page-omr staging work — **zero commits touched `run_pitch_tracking` or
`dtw_align_to_score`**. The CSV is a valid frozen baseline for today's
code, not stale data.

**Fresh per-piece category breakdown** (counted directly from the CSV's
`outcome` column — `off_by_one` / `unmatched` / `wrong`, for the pieces
the Backlog already names as the remaining weak set):

| piece | off_by_one | unmatched | wrong | known mechanism (from prior sessions' real investigation) |
|---|---|---|---|---|
| 2186 | 106 | 14 | 294 | bariolage under-detection — real notes 40-80ms, shorter than every detector's sustain requirement |
| 2217 | 67 | 60 | 420 | DTW drift — zero rest-anchor checkpoints, one unbounded path for the whole piece |
| 2241 | 108 | 424 | 770 | over-counting — vibrato/pitch noise exceeds the 1-semitone merge tolerance |
| 2220 | 11 | 454 | 714 | over-counting, same mechanism as 2241 |
| 2296 | 25 | 478 | 626 | over-counting, same mechanism |
| 2204 | 63 | 105 | 263 | over-counting, same mechanism (smaller-scale) |
| 2242 | 365 | 39 | 446 | rest-anchor "no real silence" problem — distinct from the over-counting pieces, mostly one-measure-off drift |
| 2222 | 114 | 18 | 630 | accepted regression from the legato-step fix (fast scale run satisfies the "kept moving" check without a real hold) |
| 2297 | 112 | 56 | 416 | DTW drift, same mechanism as 2217 (3 rest-anchor checkpoints, still insufficient) |
| 2293 | 115 | 78 | 40 | resolved — genuine attack-transient misread, local-outlier fix already shipped; low "wrong" count confirms this is not a catastrophic piece |

**Mapping onto the five categories the directive asks about:**

1. **False onset detections** — the dominant driver on 2241/2220/2296/2204
   (`unmatched`+`wrong` far outweighing `off_by_one`): CREPE registers
   spurious extra onsets from vibrato/bow noise within what is really one
   sustained note. **Five independent fixes already tried and abandoned**
   specifically for this (3 frame-level heuristics, 1 global penalized-
   segmentation/changepoint detector, 2 finer-CREPE-hop variants) — each
   validated against the real 20-piece corpus, each traded one piece's
   gain for another's regression rather than converging. Explicit
   decision already on record (2026-10-15): "stop tuning
   `_find_rest_anchor_checkpoints` for the over-counting pieces."
2. **Missed repeated/rapid notes** — the dominant driver on 2186
   (bariolage: real notes shorter than every detector's frame-sustain
   floor). Same exhaustive-attempt history as above; the global
   changepoint detector that targeted this specifically regressed the
   corpus overall by -8.9pt and was reverted.
3. **Sustained/legato transitions** — **already fixed**, not an open
   gap: `_detect_within_segment_pitch_jumps` (shipped 2026-10-15/21) is
   exactly this fix, and moved the corpus 60.1%→65.3%. The one named,
   accepted side effect (2222, a fast scale run) was investigated with
   three separate discriminators, all of which found the "good" and
   "bad" candidate distributions genuinely overlap — no clean signal
   separates them with a per-candidate scalar.
4. **Tempo variation** — **investigated and ruled out as a driver**, not
   untested: a direct check of local-vs-global tempo ratio against real
   MusicNet ground truth (2026-10-15) found it stays within 0.89-1.13
   across all sampled windows on the specific weak pieces checked — global
   tempo estimation was never the problem.
5. **Incorrect score-to-performance mapping** — the dominant driver on
   2217/2297 (DTW drift: a steadily growing measure offset across the
   whole piece, not scattered independent mistakes). A time-anchor cost
   term was tried **twice**, at two different weights, across three
   variants each time (2026-10-13, re-tested 2026-10-21 after pitch
   detection got materially cleaner) — same failure both times: the
   mechanism reinforces pass-1's own drifted correspondence rather than
   correcting it. Explicitly closed: "do not re-attempt a global/path-
   derived linear tempo model for this... without a genuinely different
   algorithm."

**Conclusion: no new DTW change ships this round.** All five categories
the directive asks about already have a specific, real-data-backed
mechanism identified, and for every category except #3 (already fixed),
the directive's own instruction — "preserve the existing DTW mechanism
unless there is direct evidence supporting a specific replacement...
do not resume open-ended DTW tuning" — points the same direction the
2026-10-15 architecture-level stop-tuning decision already reached: **13
distinct mechanisms have been tried across these failure modes this
investigation; two shipped, eleven were reverted on real-corpus
evidence.** Nothing examined this round constitutes new evidence that
would justify a 14th attempt. This is the direct answer to "stop if the
evidence doesn't support the proposed corrections" — the evidence here
supports *not* touching the DTW mechanism again right now, not a new
fix.

---

## Priority 4 (2026-10-31): end-to-end coaching — confirmation, not new work

Priority 4 asks to verify corrected score/audio observations still
produce accurate measure-specific coaching, keep Claude's coaching
capability without unsupported assertions, and explicitly not restore
the already-rejected Gemini-only error-detection experiment or
LadderSym.

**Nothing in this round touches the coaching path, so this is a
confirmation, not an investigation.** The only code change made this
round (Priority 1's image-build reordering) is scoped entirely to the
`modal.Image` build chain (`worker.py` lines ~45-165) — a build-script
change, not a change to any function body `compare_and_coach_claude`,
`evaluate_with_gemini`, or the DTW/CREPE code paths call. Confirmed by
inspection of the diff (`git diff -- modal_worker/worker.py` touches only
the `image = (...)` assignment and the one `if _STAGING_BUILD_SCORE_ENGINE`
block) and by the full regression suite staying green across every test
file in `modal_worker/` (719/719 `test_analysis.py`, plus
`test_coaching_models.py` 8/8, `test_gemini_crosscheck.py` 8/8,
`test_smt_inference.py` 12/12, `test_smt_cropped_input.py` 12/12,
`test_visual_validation.py` 100/100, `test_page_omr_adapter.py` 16/16,
and `test_benchmark_full_pipeline.py` / `test_inject_audio_mistakes.py` /
`test_generate_timing_accurate_reference_audio.py` all exit 0 clean).

**No new DTW change (Priority 3) or pitch change (Priority 2, pending
its own evidence) landed either**, so there is nothing new flowing into
`compare_and_coach_claude`'s inputs this round to re-verify downstream.

**Explicitly not done, per the directive's own prohibition**: no attempt
was made to restore Gemini-only error detection (rejected per Task 4A/4B,
2026-10-30: "score image + short clips don't fix it") or LadderSym
(rejected per Gate 3, 2026-10-30: inconsistent in both directions across
instruments, 0% missing-note recall). Both remain exactly as rejected.

---

### Task 3 (2026-10-31, same day): squeak-filter correction — NO-SHIP, and here's exactly why

Before writing or validating any fix, built a full gate-by-gate trace of
all 15 of Task 1's real observable misses (not a sample) and ran a
"ceiling" check: even with the squeak filter's confidence-alone
over-triggering (confirmed real — it independently fires on 8/15
candidates, including the exact piece-2220 case found earlier,
confidence=70 and perfectly stable spread=0) completely removed, would
ANY of the 15 misses actually flip to a correct flag? **Answer: no, zero
of 15.** Every one of the 8 squeak-filtered candidates also has at
least one other, fully independent blocking reason:

- **6/15** fail the comparator's OWN quality gates for reasons unrelated
  to the squeak filter (`cents_spread` up to 1076, confidence as low as
  58, duration as short as 0.065s) — `librosa.effects.pitch_shift`
  splice artifacts producing audio that genuinely IS unstable/noisy/too
  brief. A synthetic-injection-methodology limitation.
- **5/15** get assigned to the wrong measure entirely by DTW alignment
  (off by 1-6 measures) — the same pre-existing, already-"stop tuning"
  alignment-accuracy limitation that drives 41.7% of Task 2's false
  positives. Same root problem, different symptom.
- **4/15** have a randomly-chosen substitute pitch that coincidentally
  equals a pitch already legitimately expected elsewhere in that same
  measure (dense/scalar passages) — the distance gate is correctly,
  conservatively declining to call it wrong. A real gap in
  `inject_audio_mistakes.py`'s own methodology (it never checks whether
  its random 2-7 semitone substitute happens to be contextually
  plausible), not a comparator defect.

**No correction was proposed, written, or validated** — the ceiling
check, done first and from real data, proved a squeak-filter fix could
not move measured recall at all on this benchmark, so running the full
4-way validation plan would have validated something with a provable
zero benefit. `looks_like_squeak`'s confidence-alone branch remains a
real, latent design issue worth fixing on its own merits someday, but
it is demonstrably NOT the bottleneck for this problem.

**This closes out the recall investigation with three identified,
independent root causes, none of them safely or usefully fixable within
this sprint's constraints:** (1) the synthetic mistake-injection
methodology itself produces audio artifacts that don't always survive
as clean "mistakes," (2) DTW alignment accuracy — already a known,
already-"stop tuning" limitation — misplaces notes into the wrong
measure, and (3) the injection methodology doesn't check whether its
random substitute pitch happens to already belong in that measure. Any
real improvement to wrong-note recall routes through fixing (1)/(3) in
the benchmark itself, or improving (2) DTW alignment — a materially
different, larger effort than "one minimal correction."

## Priority 2 (2026-10-31): octave errors are the dominant remaining
## pitch-extraction failure post-breath-noise-fix — no safe fix found

Re-ran the full real `validate_pitch_against_tinysol.py` corpus (2,224
real isolated notes, 13 instruments; TinySOL re-downloaded fresh — the
prior round's dataset and per-clip miss list weren't retained, both
noted as regenerable scratch at the time) with a per-clip CSV dump
(`octave_error_analysis.py`, scratch, not committed — reuses
`load_rows`/`classify`/`run_pitch_tracking` unchanged) to see which
error TYPE dominates now that the breath-noise fix closed most of the
"missed" bucket.

**Real result: 2,134/2,224 correct (95.9%, consistent with the prior
95.6%), but of the 90 non-correct clips, `octave_error` is now the
single largest category — 45 clips (2.0%), more than `wrong` (27, 1.2%)
and `missed` (18, 0.8%) combined.** This directly answers what Priority
2 asked to separate out: pitch-extraction octave confusion, not score
alignment (TinySOL has no score — alignment is Priority 3's separate
MusicNet-based data) and not a missed-detection problem (the breath-noise
fix already addressed that).

**Two real, distinct, fully-explained clusters — not one problem:**

1. **Register-floor "missing fundamental," Double Bass/Tuba (13 of 45,
   all "up" by exactly one octave).** Rate is dramatic right at the
   bottom of the instrument's own declared range: 12/33 (36%) of Double
   Bass clips at true octave 1 (F#1-B1, ~46-62 Hz) are detected a full
   octave high, across all three dynamics tested. This is the textbook
   missing-fundamental failure mode — at these frequencies the
   fundamental's energy is weak relative to the 2nd harmonic, and
   CREPE's own salience function favors the harmonic even though
   `_instrument_pitch_bounds` already restricts its search window to
   [41, 524] Hz for Double Bass (worker.py:625) — the wrongly-detected
   octave-up frequency (~92-123 Hz) is itself still inside that window,
   so the existing fmin/fmax constraint cannot prevent this specific
   error.
2. **CREPE ceiling, Violin/Viola/Flute (17 of 45, all "down" by exactly
   one octave), at true octave 7 — an already-disclosed, deliberate gap,
   not a new bug.** `_instrument_pitch_bounds`'s own comment
   (worker.py:616-617) already states "CREPE tops out around 1975 Hz
   internally; violin's high E (2637 Hz) is above that — Gemini's audio
   evaluation handles the high register for violin." The TinySOL octave-7
   notes that error here (C7=2093Hz through D#7=2489Hz) are at or above
   that documented ceiling; CREPE, constrained to search only up to its
   own working limit, has nowhere to put the true pitch except an octave
   down. This is CREPE's own architectural range limit, not a
   post-processing bug — "fixing" it would mean replacing or extending
   the pitch-tracking model itself, which the directive's own
   constraints rule out ("no new model search").
3. **A third, smaller cluster (Bassoon 6, Cello 3) that does NOT fit
   either pattern** — Bassoon's errors (A3/A#3/B3/D#4, all "up") sit in
   the *middle* of its declared range (58-698 Hz), nowhere near either
   edge; Cello's (D#2, ~78 Hz) sit near its floor like the Double Bass
   case. Checked directly, not assumed: this looks like a genuine,
   known acoustic quirk (certain notes on bassoon have an unusually weak
   fundamental relative to their 2nd harmonic for bore-geometry reasons
   around that part of its range) rather than a generic "distance from
   fmin" rule.

**No fix implemented — the evidence argues against one, not for one.**
Before writing any correction, checked directly whether a "prefer the
lower octave when halving the detected frequency stays within the
instrument's bounds and the note sits low in its range" heuristic could
work: it cannot be discriminated from a case that's already correct.
Concretely, a genuinely correct Double Bass detection at A2 (110 Hz)
looks, by final pitch value alone, identical to the wrongly-doubled
A1→A2 cases above — both are "110 Hz, low in Double Bass's range, halving
stays in-bounds." Applying the heuristic would silently convert some
currently-correct low notes into new octave errors while fixing others,
with no way to tell the two apart from the decoded pitch alone. This is
the same shape of failure this investigation has already hit repeatedly
on a different problem (DTW-context pitch-jump detection, Priority 3
above): "the real-note and glitch populations overlap," confirmed there
by three separate discriminators. A real fix would need the raw CREPE
per-frame activation/periodicity surface at the candidate octave below
the decoded pitch (not exposed by a single fmin/fmax-constrained
`predict()` call) to independently confirm which octave the audio
actually supports — a materially bigger, model-internals-level change
than "one low-risk correction," and the Bassoon cluster shows the
problem isn't even uniformly "near the floor" to begin with.

**Recommendation**: do not implement an octave-correction heuristic this
round. Record as a precisely-diagnosed backlog item (added to
`agent_workspace/AGENT_TASKS.md`) rather than attempt a fix that this
round's own evidence shows cannot be safely validated with the
information a standard CREPE call exposes.
