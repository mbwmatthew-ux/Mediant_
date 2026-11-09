# Final staging readiness, 2026-11-08: harness completeness, alignment status, coaching boundary

BASE commit: `f65953fcb95dc38a96a6ce0e85a4b62244afa7b5`
Code commit: `df784fc` (`modal_worker/local_e2e_integration_harness.py`, new `modal_worker/test_score_completeness.py`)
Scope: `local_e2e_integration_harness.py` and one new test file only. `worker.py`, `page_omr_adapter.py`, `build_visual_validation_corpus.py`, and `src/` are untouched. No network calls, no installs, no downloads.

## Task 1: score completeness check

`assess_score_completeness(midi_path, label_csv_path=None)` runs against the original multi-track MIDI, independent of page-omr and the corpus builder. It compares every note in the unselected tracks against the selected part (`bvc.select_real_part`, reused). A note is a genuine omission only if its (offset, pitch) is absent from the selected part at that offset. Otherwise it counts as a duplicate.

Coverage is numeric only when a label CSV exists. With no reference, `coverage_fraction` is `None` and `coverage_source` starts with `"unavailable"`. Completeness then falls back to the binary omitted-voices flag. No ground-truth count is ever invented.

**Deviation from the brief's literal code (deliberate, please review):** the brief's status rule included `not full_midi_matches_reference`, an exact equality test between the all-parts MIDI note total and the label row count. Piece 2289 has 953 MIDI notes against 952 labels, and the brief says that 1-note gap is immaterial and the positive case must still report `complete`. The exact-equality gate made it report `incomplete`. The fix applies the same 2% tolerance already used for coverage: `full_midi_within_2pct_of_reference`. The exact `full_midi_matches_reference` field is still reported, but it no longer gates status.

### Measured fixture numbers (from the function, not estimated)

| Fixture | selected (chosen part) | other tracks | genuine omissions | duplicates | all parts | labels | coverage | status |
|---|---|---|---|---|---|---|---|---|
| 2289 Violin Partita 1 Sarabande | 953 | 0 | 0 | 0 | 953 | 952 | 1.0011 | `complete` |
| 2220 Cello Suite 3 Sarabande | 196 | 238 | 238 | 0 | 434 | 434 | 0.4516 | `incomplete - unsuitable for complete-performance grading` |

The 2220 result matches the dispatch's measurements. All 238 extra-track notes are genuine voices, none are doublings, and the four tracks together match the label count exactly.

### Tests (`modal_worker/test_score_completeness.py`)

Each assessment runs in a fresh interpreter. `test_analysis.py` replaces `music21` with a `MagicMock` in `sys.modules` at import time (`setdefault`). When the full suite runs, `test_analysis.py` is collected first, and in-process `music21` returned empty parts (`ValueError: max() iterable argument is empty` in `build_visual_validation_corpus.py:46`). The subprocess keeps this file independent of import order.

```
test_score_completeness.py::test_positive_complete_fixture PASSED
test_score_completeness.py::test_negative_incomplete_fixture PASSED
test_score_completeness.py::test_no_reference_never_fabricates_coverage PASSED
3 passed in 5.83s
```

## Task 2: alignment and meter statuses

Values from the main harness run on 2220:

- `alignment_status`: **accepted**. Run B is not degenerate (192 distinct times, span 0.54 to 301.96 s). Basic Pitch onset support is aligned 81.1% against a shuffled null of 19.4%, which passes the `>= 0.30` gap and `>= 0.50` absolute rule.
- `time_signature_known`: **False** (page-omr `time_signature=None`).
- `meter_dependent_claims_available`: **False**.
- Every entry carries `timing_precision_claim = "unavailable - per-note localization error not independently validated"`. `check_no_precise_timing_claims` returns PASS with exactly that one distinct value.

`accepted` means the rule passed, not that timing is accurate. The harness's own label cross-check still shows median |err| 0.304 s, p90 4.124 s, 18.8% of notes more than 1 s off, and 46.4% within 0.25 s. That is why the per-note timing claim stays marked unavailable.

## Task 3: downstream coaching boundary

`step_coaching_boundary` calls the real `worker.compare_and_coach_claude`. Only the Anthropic client is stubbed, using the `_FakeMessages`/`_FakeAnthropic` pattern from `test_analysis.py`. `modal` is real here because the venv has it installed, so it is not stubbed.

**Result: the call succeeded and did not crash, but it returned zero flags, so it exercised almost nothing downstream.**

```
{'time_signature_passed_through': None, 'crashed': False, 'flags_returned': 0,
 'all_flag_types_allowed': True, 'flag_types_seen': [],
 'input_forbidden_scan_hits': [], 'input_forbidden_scan_pass': True}
```

Production logged `no canonical issues from Gemini or CREPE`. The input was 196 real aligned notes, but the Gemini assessment was empty by design and CREPE supplied no issues. So:

- `all_flag_types_allowed: True` is vacuous, because there were no flags to check.
- Coaching text generation was never exercised, because there was nothing to coach.
- What this does prove: the real function accepts the harness's structured output shape, with `time_signature=None` and `beats_per_measure=None`, and returns cleanly.

The input-side forbidden scan (no `wrong_note*`/`missing_note*` claim other than the literal `unavailable...` status, and no numeric key matching precision/tolerance/`_ms` below 0.1) found no hits.

Task 3 is reported on its own summary line and is **not** folded into `OVERALL`, as the brief requested.

**Follow-up if the owner wants a real coaching-path check:** feed a non-empty Gemini or CREPE issue list into the same call. That would need a fixture with a known injected issue, which is outside this task.

## Task 4: acceptance points

Harness run: `HF_HUB_OFFLINE=1 .../venv/bin/python local_e2e_integration_harness.py`, exit 0, `OVERALL: PASS`. Total 44.6 s, peak RSS 1780.8 MB, no network calls.

1. **Complete paired fixture (2289) succeeds: PASS.** `test_positive_complete_fixture` passes, and the numbers are in the table above.
2. **Known incomplete case (2220) is flagged: PASS.** `test_negative_incomplete_fixture` passes. The main run prints `completeness: {... 'status': 'incomplete - unsuitable for complete-performance grading'}` and `results["completeness_status"]` is the same string.
3. **Silence, noise, and wrong-recording cases fail alignment acceptance: PASS.** `degenerate_cases_flagged: True`. Each case shows `flagged=True`:
   - silence: structural guard does not fire, Basic Pitch aligned 0.0% vs null 0.0%
   - white noise: structural guard does not fire, Basic Pitch aligned 80.6% vs null 69.3%
   - other piece 2186: structural guard does not fire, Basic Pitch aligned 6.6% vs null 2.9%

   All three are caught only by the Basic Pitch onset gate. The structural guard alone flags none of them. `degenerate_cases` was not modified.
4. **Missing time signature disables meter-dependent claims: PASS.** `meter_dependent_claims_available: False`. Page-omr returned `time_signature=None`, as the dispatch predicted.
5. **Coaching interface accepts the structured output: PASS, weakly.** `coaching_result` shows `crashed: False`, `flags_returned: 0`. See the Task 3 caveat above.
6. **No experimental detector imported into worker.py: PASS.** `grep -n "basic_pitch_score_adapter\|score_conditioned_error_classifier" modal_worker/worker.py` returned no matches (exit 1).
7. **Regression unchanged: PASS.** See the pytest table below.

Other checks from the same run: Task 2 checks 1 to 7 PASS, Task 3 schema PASS, wrong-note literal PASS, no-precise-timing-claims PASS, and the Step 3 kern consistency check True.

## Pytest, before and after

| Run | passed | failed | errors | failure list |
|---|---|---|---|---|
| BASE (`f65953f`) | 296 | 5 | 1 | baseline |
| After this change (`df784fc`) | **299** | 5 | 1 | identical to baseline |

The 5 failures are all in `test_visual_validation.py`, and the 1 error is `test_generate_timing_accurate_reference_audio.py`, both pre-existing. A diff of the `FAILED`/`ERROR` lines against the baseline is empty.

An intermediate run that used in-process imports showed 8 failed, 3 of them the new tests, from the `music21` pollution described above. That run is superseded by the subprocess version.

## Known gaps, not addressed here

- Harness Task 1 check (4) from the audit still holds: the corpus builder keeps one of four MIDI tracks for 2220, so the page covers about 45% of the notes. The completeness check now detects this condition, but it does not fix it.
- The 2220 Needs Review item in `AGENT_TASKS.md` is still open. That item is the owner's decision on whether to approve a limited canary, and it stays in Needs Review.
- The zero-flag coaching result (above) means the coaching text path has no end-to-end test with real issues from this harness.
