# Staging End-to-End Integration Check — 2026-11-08

Verification-only round. Local, offline, CPU-only. $0 spend: no Modal remote
call, no Anthropic or Gemini call, no Supabase access, no `src/` change, no
`worker.py` change. BASE `e0d25fc`.

## Summary

- Core components re-run today: page-omr score reading, Basic Pitch note
  extraction, Parangonar score alignment. All three pass the smoke checks.
- Regression: full `modal_worker/` pytest suite matches the recorded baseline
  (296 passed, 5 failed, 1 collection error). No new failures.
- Integration gap: the experimental Basic-Pitch wrong-note detector's output
  is NOT directly compatible with production's wrong-note interface (see
  Task 1 item 5). This is expected, since nothing is wired, and it is not a
  defect in production code.
- No integration defects found. No code changed.
- Recommendation: GO for continued staging acceptance of the core pipeline.
  This is not a recommendation to deploy the experimental wrong-note detector
  or page-omr to production users.

## Task 1: component checks

| # | Item | Evidence | Result |
|---|------|----------|--------|
| 1 | page-omr + deskew reads sheet music | `test_page_omr_adapter.py` run as a script: **16/16 checks passed**. Live offline call on `visual_corpus/clean/2220_page1.png` via `score_pages_with_page_omr([(bytes,"image/png")], start_measure=1)`: source `page_omr`, no error, **48 measures returned, 48 in reference**, **196/196 pitched notes match the reference MusicXML by position**, 6.4s elapsed including model load, peak RSS about 1.76 GB. Model loaded offline from the existing HF cache (`tobiashornbogen/page-omr-a1-kern`). | PASS |
| 2 | Canonical score preserves pitch, measure, timing | `test_analysis.py` run as a script: **727/727 checks passed** (matches Phase 1). `test_page_omr_adapter.py`: 16/16 (matches). Byte-identical Phase 1 finding not re-derived. | PASS, no change from baseline |
| 3 | Basic Pitch processes solo audio | HARPSET `audio/01_O_Recording.wav` (solo harp, 44.1 kHz stereo, 25.5 s). Basic Pitch `predict` in `venv_basic_pitch`: **74 note events**, MIDI 49–67, onsets 0.94–24.9 s. predict call 0.53 s. | PASS |
| 4 | Parangonar score localization | Same clip, `pa.AudioToScoreMatcher` with `HARPSET/scores/01_O_Score.xml`: **45 score notes → 45 alignment entries, all with `performance_time`**, range 0.04–25.48 s. Matcher call 4.84 s including construction and warm-up. | PASS |
| 5 | Downstream coaching interfaces compatible | See the field comparison below. | **GAP (expected, not wired)** |

### Task 1 item 5: interface comparison (direct code reading)

**Production** `find_wrong_note_candidates` (`modal_worker/worker.py:7412`)
returns `list[str]`. Each element is the f-string at `worker.py:7663-7669`:

```
wrong_note | measure {measure} | CREPE detected {played_name} ({hz} Hz, conf={conf}%, {dur}s), score has {expected_name} ({dist} semitones away) at t={time}s
```

The consumer is `compare_and_coach_claude`, which parses the string with
regex, `measure (\d+)` and `(\d+) semitones away` (`worker.py:~9503-9512`).
It then creates a confirmed issue with `rule="wrong_note"` and passes the
string through as the observed text into the coaching prompt.

**Experimental** `basic_pitch_score_adapter.detect_wrong_notes` (not imported
by production) returns a dict `{"notes": [...], "insertions": [...]}`.
Each `notes` entry has these keys: `score_idx`, `verdict`
(`correct` | `substitution` | `deletion`), `expected_midi`, `played_midi`,
`window`, `reason`, `played_perf_idx`, `played_amplitude`,
`played_duration_sec`, `played_onset_sec`, `pitch_distance_semitones`.

| Concept | Production (`list[str]`) | Experimental (dict) | Gap |
|---|---|---|---|
| Measure | `measure N` in string | **absent**; only `score_idx` | Needs score_idx→measure mapping. The experimental module has no `measure` key. |
| Pitch wrong | `wrong_note` line | `verdict == "substitution"` | Name differs; semantics roughly match. |
| Expected pitch | `expected_name` (note name) | `expected_midi` (int) | Needs midi→name formatting (`midi_to_scientific` exists in worker). |
| Played pitch | `played_name` | `played_midi` (int) | Same. |
| Time | `at t={time}s` | `played_onset_sec` (not formatted) | Units match; no string. |
| Confidence | `conf=N%` (CREPE) | `played_amplitude` (Basic Pitch, not a confidence) | No equivalent. |
| Duration | `{dur}s` | `played_duration_sec` | Name differs. |
| Deletion (missed note) | none | `verdict == "deletion"` | Production has no missed-note output at all. |
| Insertion (extra note) | none | separate `insertions` list | Production has no insertion output at all. |
| Output type | `list[str]` | dict | Needs a formatter, not a direct substitution. |

Also not compatible: `cross_model_agreement_gate.crepe_cross_check` returns
`{"confirmed", "reason"}`, and `score_conditioned_error_classifier` returns
fold rows. Neither is a coaching-facing shape.

**Conclusion:** the experimental output could be adapted into the production
string format, with a score_idx→measure lookup, midi→name formatting, and a
policy for deletions and insertions. Production has no insertion or deletion
path. Nothing was built. The adapter would be a new, separately approved
step.

## Task 2: regression and error handling

### Full `modal_worker/` pytest suite

`cd modal_worker && pytest --continue-on-collection-errors -q` with
`/Users/matthewwu/.cache/mediant_validation/venv`:

| Run | Passed | Failed | Errors |
|---|---|---|---|
| Coordinator baseline (earlier today) | 296 | 5 | 1 collection |
| This round, at BASE `e0d25fc` | **296** | **5** | **1 collection** |

Failures are the same five in `test_visual_validation.py`. The collection
error is the `AttributeError` in `test_generate_timing_accurate_reference_audio.py`.
These are pre-existing, not regressions.

The audit doc's 286 figure (`AUDIO_PIPELINE_AUDIT.md`, 2026-11-08 HARPSET
entry) was recorded at `6258920`. The +10 difference is
`test_harpset_file_resolution.py`, added in `e0d25fc` (verified: 10 passed).

### Error-handling coverage (read, not written)

Score-read failure and degrade paths are already covered:

- `test_page_omr_adapter.py::test_score_pages_with_page_omr_all_pages_fail_returns_structured_error`
- `test_page_omr_adapter.py::test_score_pages_with_page_omr_partial_failure_keeps_good_pages_and_flags_bad_ones`
- `test_page_omr_adapter.py` `kern_to_measures` unparseable-input test (`test_kern_to_measures_reports_unparseable_output_as_an_error_not_a_crash`)
- `test_analysis.py::test_zero_pages_read_is_still_declared` (total score-read failure produces a coverage caveat; this is the synthesized-skeleton path)
- `test_analysis.py::test_read_score_notes_claude_multipage_pdf_refuses_whole_page_fallback`
- `test_analysis.py::test_pathological_alignment_rejected` (even-spacing fallback timeline)

Gap, unchanged: `assess_quality` can still report `trust: "high"` on a
skeleton fallback (Backlog). The existing test asserts the caveat, not the
trust value.

### Attribution check

`grep` of `modal_worker/worker.py` for `basic_pitch_score_adapter`,
`cross_model_agreement_gate`, `sequence_error_matcher`,
`score_conditioned_error_classifier`, and `harpset_evaluation`: **zero
matches** (no import and no mention). Production `run_full_analysis` cannot
surface an experimental-detector claim to a user today.

### Backlog items checked, not fixed

- page-omr notes have no `articulation`/`dynamic` keys. Checked: the code
  reads them with `.get()` (`worker.py:2099, 5159, 5326-5327`), so this
  fails silently and does not crash. Stays in Backlog.
- `assess_quality` `trust: "high"` on skeleton fallback. Not re-tested this
  round. Stays in Backlog.

## Processing latency and resources

| Stage | Figure | Source |
|---|---|---|
| page-omr + deskew, local CPU | ~9–13 s/page | `PAGE_OMR_STAGING_DEPLOYED.md` |
| page-omr, fresh local (today, 1 page, includes model load) | 6.4 s, 1.76 GB peak RSS | measured today |
| page-omr, real Modal | 23–41 s/page, 2.3 GB RSS, about $0.001/page | `PAGE_OMR_STAGING_DEPLOYED.md` |
| Basic Pitch predict, 25 s clip | 0.53 s (measured today) | measured today |
| Parangonar, 25 s clip incl. construction | 4.84 s (measured today) | measured today |
| Parangonar, after warm-up | 0.32–0.87 s/piece | `SCORE_CONDITIONED_ERROR_CLASSIFIER_2026-11-08.md` |
| Score-conditioned feature stage | 0.001–0.006 s/piece | `SCORE_CONDITIONED_ERROR_CLASSIFIER_2026-11-08.md` |

## Instrument coverage this round (narrow, honest)

- **Solo cello**: MusicNet 2220 clean render, page-omr score reading (1 page, 48 measures, 196 notes). Part name confirmed as "Solo Cello".
- **Harp**: HARPSET 01 original recording, Basic Pitch and Parangonar (one recording, 45 score notes).
- **Violin, Flute, Clarinet, Guitar**: no new run this round. Clarinet and guitar have no ground-truth audio in this project (pre-existing gap, not new). Violin and flute are covered only by the existing pytest suites.
- `run_full_analysis` was NOT re-run end-to-end this round. The Phase 1 end-to-end result (2026-10-31) is the source for the byte-identical finding. The GO below rests on Phase 1 plus today's component checks and the full suite, not on a fresh end-to-end run.

## Remaining integration failures

None found in the core path.

Known interface gap (expected, not wired): the experimental wrong-note detector does not match production's `list[str]` coaching interface (Task 1 item 5).

## Files and commits

- Code changed: none. `worker.py` untouched. `src/` untouched.
- Docs added: this file. Log entries in `agent_workspace/AGENT_TASKS.md` and `agent_workspace/AUDIO_PIPELINE_AUDIT.md`.
- Scratch scripts and outputs live in the session scratchpad, not the repo.

## Recommendation

**GO** for continued staging acceptance of the core pipeline (page-omr score reading plus the existing audio pipeline). Conditions: no regressions this round, component smoke checks pass, and the full suite is at baseline.

**Not a recommendation to:**
- deploy the experimental Basic-Pitch wrong-note detector to production users (NO-GO, prior rounds; not wired and not approved);
- deploy page-omr to production users (separate NO-GO from prior rounds, `bb52d45`);
- treat this as an end-to-end production acceptance (no fresh `run_full_analysis` run this round).
