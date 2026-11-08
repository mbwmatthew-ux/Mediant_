# HARPSET Benchmark Integrity Fix — 2026-11-08

**Status: fixed, re-run, and asserted. No detector, threshold, model, or
classifier changed. `worker.py` and `src/` untouched (diff vs BASE
`be41ba1`: 0 lines).**

---

## The bug

`modal_worker/harpset_evaluation.py` decided which performances exist by
looking them up in `metadata.csv`. That file is unreliable for HARPSET:

- It has **no row for (13, N)**, although `scores/13_N_Score.xml` and
  `audio/13_N_Recording.wav` both exist and are valid.
- It **does list (12, N)**, although neither file exists on disk.

Part 2 (pitch-error recall on N performances) did `meta.get((pid, "N"))`
and `continue`d on `None`. So piece 13's 4 real pitch deviations were
silently dropped. The file's own docstring said this gap had been "caught
and fixed"; the code was never changed to match.

Part 1 (false positives on O performances) happened to be right, because
`metadata.csv` has correct O rows for all 13 pieces.

## The fix

- Added `score_file()`, `audio_file()`, and `performance_exists()`. These
  follow the HARPSET naming convention and check the disk. They are the same
  resolution `score_conditioned_error_classifier.py` already uses
  (its `score_path()` / `audio_path()`, lines 192-197).
- Part 1 and Part 2 both resolve through these helpers. `metadata.csv` is no
  longer read at all, so `load_metadata()` was removed. The memory-profile
  duration now comes from `soundfile.info`.
- Added `build_manifest()` and `print_manifest_and_assert()`, run at the top
  of `main()`. The manifest covers 13 pieces x {O, N, R, RN}. It raises
  `AssertionError` (not a silent skip) unless: all 13 O performances exist,
  the N-variant pitch deviations total exactly 26, and they fall in exactly
  pieces 01, 02, 03, 04, 05, 06, 09, 13.

The 26/8 assertion **held** on the first run. No mismatch was found, so
there was nothing to stop on.

### Task 1 manifest (printed by the corrected script)

| Piece | N (deviations) | RN | Notes |
|---|---|---|---|
| 01 | yes (2) | excluded: length mismatch (45 vs 44 notes) | |
| 02 | yes (3) | yes (3) | |
| 03 | yes (3) | yes (3) | |
| 04 | yes (4) | no | R, RN absent |
| 05 | yes (3) | yes (3) | |
| 06 | yes (3) | no | R, RN absent |
| 07 | no | no | |
| 08 | no | no | |
| 09 | yes (4) | no | R, RN absent |
| 10 | no | yes (3) | |
| 11 | no | yes (3) | |
| 12 | **no** (phantom metadata row, files absent) | no | R present, not used |
| 13 | **yes (4)** | yes (4) | Missing from metadata.csv |

**N-variant total: 26 across 8 pieces** `[01, 02, 03, 04, 05, 06, 09, 13]`.
All 13 O performances present.

---

## Pre-fix run, for reference

The pre-fix HEAD script was run from a scratch copy, unmodified, on the same
data. Its Part 2 covered **22 deviations across 8 pieces**. The brief
described this as "21/22"; the measured figure is **17/22**.

The corrected run adds exactly four cases, all piece 13:

```
13_N idx=2  measure=1:  A=False B_nogate=True  B_gate=False
13_N idx=7  measure=3:  A=False B_nogate=True  B_gate=False
13_N idx=15 measure=6:  A=False B_nogate=True  B_gate=False
13_N idx=29 measure=10: A=False B_nogate=True  B_gate=False
```

Every other case is identical between the two runs. So B-no-gate goes
17/22 -> 21/26 (17 + 4). The "21 of 26" figure in the old docstring
matches the corrected run, not the HEAD code.

---

## Task 2 — consistent comparison, corrected run (2026-11-08)

Run: `harpset_evaluation.py` (corrected), local audio only, CPU only. Same
run for Parts 0, 1, and 2.

**Denominators:** pitch-error recall uses **26 verified N-variant
deviations across 8 pieces**. False-positive note denominator is **874**
O-variant notes (13 pieces). False-positive piece denominator is **13**.

| Candidate | Positive denominator | Recall (detected) | Note FP (O, /874) | Piece FP (O, /13) | Correct-measure localization among own TPs |
|---|---|---|---|---|---|
| **A** production (`run_candidate_A`) | 26 across 8 pieces | **0/26** (0%) | **0/874** (0.00%) | 0/13 | 0/0 (no detections) |
| **B** ungated (`use_gate=False`) | 26 across 8 pieces | **21/26** (80.8%) | **93/874** (10.64%) | 13/13 | 21/21 (100%) |
| **C** cross-model gate (`use_gate=True`) | 26 across 8 pieces | **0/26** (0%) | **0/874** (0.00%) | 0/13 | 0/0 (no detections) |
| **D** score-conditioned logistic classifier (cited, not re-run) | 26 across 8 pieces | **12/26** (46.2%) | **5/874** (0.57%) | 3/13 | not in its committed numbers |

**Coverage failures (carried from prior rounds, not re-investigated):**
CREPE produced **0 events on all 13 O pieces** in this run
(`CREPE event counts: [0, 0, ..., 0]`). Candidate A and Candidate C both
depend on CREPE, so both detect nothing. Their 0 FP is the signature of a
detector that never fires, not evidence of precision.

**Prior-round count change:** the N-variant denominator changed from **22
(8 pieces, pre-fix HEAD)** to **26 (8 pieces, corrected)**. The change is
piece 13's four deviations, which the buggy code skipped. Per-candidate
pre-fix figures: A 0/22, B-no-gate 17/22, C 0/22. Candidate B's FP figures
are unchanged by this fix (Part 1 was already correct).

**D's numbers are unaffected by this fix.** `score_conditioned_error_classifier.py`
never used `metadata.csv`. It resolves files directly (lines 192-197, 405-406)
and covered all 26 deviations across the same 8 pieces. Its committed
numbers (`be41ba1`, `SCORE_CONDITIONED_ERROR_CLASSIFIER_2026-11-08.md`) stand
exactly as recorded: recall 12/26, 3/13 O pieces falsely flagged, 5/874 O
note FPs. It was not re-run, and no model was retrained. It is still NO-GO.

---

## Task 3 — classifier evaluation integrity audit (read-only)

File inspected, not modified: `modal_worker/score_conditioned_error_classifier.py`.
Every claim below is traced to code.

1. **All 26 positives included.** `load_all_pieces()` loops over ALL_PIECES
   and variants `("O", "N", "RN")` (line 405). It skips a performance only
   if `audio_path(...)` or `score_path(...)` is missing (line 406). Those
   helpers are the direct-disk paths at lines 192-197. The N-variant set it
   builds is therefore the same 8 pieces the corrected manifest finds. Labels
   come from `ground_truth_pitch_errors` (lines 362-372), which gives the same
   26 deviations. The committed doc reports the 26 denominator (lines 71, 107).
2. **Variants of one composition stay in one fold.**
   `train_keys = [k for k in data if k[0] != held and k[1] in ("O", "N")]`
   (line 463) excludes by base piece id `k[0]`. So O, N, and RN of the held
   composition are all excluded from training together. The assert on line
   464 checks this.
3. **StandardScaler fit on training fold only.** `scaler = StandardScaler().fit(X_tr)`
   (line 469), where `X_tr` is built from `train_keys` only. Held-out data is
   transformed afterwards, at lines 476, 491, and 505.
4. **Threshold uses training-fold data only.** `p_tr` (line 472) is computed
   from `X_tr` and `y_tr`. `thr = best_f1_threshold(y_tr, p_tr)` (line 473)
   runs before any held-out data is touched. The first held-out access is
   `held_o = data.get((held, "O"))` at line 475.
5. **No identifiers in feature vectors.** `note_features(na_o, perf_times, bp)`
   (line 275) takes only the O note array, Parangonar onset times, and frozen
   Basic Pitch arrays. No piece, variant, or label argument. Features are built
   inside `build_piece` (line 410), under the `recording_loader` guard
   (lines 399-412). The guard records every `pt.load_musicxml` call. Line 420
   computes `leaked` as any opened score not ending `_O_Score.xml`, and
   `main()` asserts `not leaked` (line 523).

**Threshold procedure, in plain language.** For each held-out composition, fit
the scaler and logistic regression on the other 12 compositions' O and N
notes. Compute predicted probabilities on that training data only. Pick the
threshold at the point of maximum F1 on the training precision-recall curve.
Apply that single threshold to the held-out piece's O and N notes.

**Two analyst judgment calls, not specified in the original brief:**

1. The threshold rule: maximum F1 on training data, rather than some other
   rule.
2. The Task-2 coverage pass bar: `|AUC - 0.5| >= 0.10` (line 185).

Both were fixed before the results were produced, as the committed doc
records. They are reasonable choices and not post-hoc tuning to the result,
but they were analyst judgment, not requirements from the brief. Neither was
changed here.

---

## Task 4 — regression results

**New test file:** `modal_worker/test_harpset_file_resolution.py`, 10 tests,
**10 passed** in about 3 seconds. It covers the 8-piece set, the 26 total,
piece 12's N treated as absent despite its metadata row, piece 13's N
included with 4 deviations, and all 13 O performances present.

**Full suite** (`cd modal_worker && pytest --continue-on-collection-errors -q`,
validation venv):

| Run | Passed | Failed | Errors |
|---|---|---|---|
| Known baseline | 286 | 5 | 1 |
| This run | **296** | **5** | **1** |

The 296 is 286 + 10 new. The 5 failures and 1 error are the same pre-existing
ones: 5 in `test_visual_validation.py`, and a collection error in
`test_generate_timing_accurate_reference_audio.py`. **No new failures.**

---

## Files

- `modal_worker/harpset_evaluation.py` — resolution helpers, manifest, assertion,
  Part 1/2 changes, superseded note on the old RESULTS block.
- `modal_worker/test_harpset_file_resolution.py` — new regression tests.
- `agent_workspace/HARPSET_BENCHMARK_INTEGRITY_FIX_2026-11-08.md` — this doc.
- `agent_workspace/AGENT_TASKS.md`, `agent_workspace/AUDIO_PIPELINE_AUDIT.md`
  — log entries.
