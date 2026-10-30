# Audio Pipeline Audit — Baseline (2026-10-30)

Read-only audit for docs/superpowers/plans/2026-10-30-audio-pipeline-benchmark.md.
Compiles already-measured results; nothing here was re-run.

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
