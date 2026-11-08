# Score-Conditioned Error Classifier on HARPSET — 2026-11-08

**Decision: STOP.** The classifier fails two of four pre-stated criteria.
Recall under leave-one-piece-out CV is **12/26**, below the required 13/26
(C1 FAIL). **3/13** original pieces were falsely flagged, above the allowed
1/13 (C2 FAIL). Leakage (C3) and latency (C4) pass. Coverage (Task 2) passed,
so training ran.

Script: `modal_worker/score_conditioned_error_classifier.py` (the full
measured report is its own docstring). `worker.py` and `src/` are untouched.
No production code, paid calls, or GPU use.

---

## What was built

Seven fixed features per expected note, from the original (O) score plus
the performance audio only:

| # | Feature | What it measures |
|---|---|---|
| 1 | `expected_pitch_activation` | Basic Pitch "note" activation at the expected pitch, max over the note's window |
| 2 | `strongest_alt_pitch_activation` | Strongest "note" activation at any other MIDI bin in the window (88-bin axis, so octave alternatives count) |
| 3 | `onset_evidence` | Basic Pitch "onset" activation at the expected pitch, +/-100 ms around the aligned onset |
| 4 | `temporal_consistency` | Min "note" activation at the expected pitch over the central 50% of the note |
| 5 | `contour_support` | Max "contour" activation within +/-1/3 semitone of the expected frequency |
| 6 | `neighbor_context` | Max activation at the previous/next note's pitch, when that pitch differs |
| 7 | `alignment_uncertainty` | Local tempo irregularity from Parangonar's onset alignment (deviation of the log tempo ratio from its +/-3-note median) |

Exact formulas are in the code comment on `note_features`. Basic Pitch
raw arrays come from `venv_basic_pitch` with default `predict` settings,
cached outside the repo. Alignment is Parangonar `AudioToScoreMatcher`
(timing only, pitch-blind).

Model: `LogisticRegression` with the default L2 penalty, `C=1.0`, not tuned.
Features are standardised with a scaler fit on the training fold. The
threshold per fold is the training-fold precision-recall point with maximum
F1, set before any run.

---

## Deviation count (reconciled, not overridden)

The brief said 26 deviations across N/R/RN. Direct recount:

- **N variants: 26 pitch deviations across 8 pieces** (01, 02, 03, 04, 05,
  06, 09, 13). This matches `errors.csv` (26 N rows). The 26 is used as the
  headline denominator, so results compare directly with earlier rounds.
- **RN variants: 19 diff-based pitch deviations** in 7 pieces, plus 01_RN
  excluded for a 45-vs-44 note mismatch. For 02, 03, 05 and 13 these are the
  same notes as in N. Pieces 10 and 11 have 3 + 3 RN-only deviations, with
  no N variant. Reported as supplementary recall only.
- **R variants: no pitch labels.** The 03_R score contains the same three
  pitch changes as 03_N, which the dataset README does not describe. R is
  never used for training or scoring.

## Harness discrepancy (reported, not fixed)

`modal_worker/harpset_evaluation.py` Part 2 filters pieces through
`metadata.csv`. That file has no piece-13 N row and does list `12_N`, which
is absent on disk. As committed, Part 2 therefore covers 22 of the 26
N-variant deviations (pieces 01-06 and 09), not 26. The file's docstring
says the piece-13 gap was fixed, but the committed code does not do that.
Not re-run and not modified here. This script resolves paths by naming
convention and reuses only `ground_truth_pitch_errors` and `score_note_array`.

---

## Task 2 — coverage check (passed)

26 N-variant deviations vs all 874 O-variant notes, single-feature AUC.
Pre-registered pass rule: some feature with |AUC - 0.5| >= 0.10.

| Feature | AUC | Median (deviation) | Median (correct) |
|---|---|---|---|
| expected_pitch_activation | 0.1034 | 0.1221 | 0.8241 |
| strongest_alt_pitch_activation | 0.8671 | 0.8447 | 0.6958 |
| onset_evidence | 0.1425 | 0.2203 | 0.8941 |
| temporal_consistency | 0.0841 | 0.1040 | 0.6725 |
| contour_support | 0.1040 | 0.1478 | 0.8120 |
| neighbor_context | 0.6384 | 0.7164 | 0.6802 |
| alignment_uncertainty | 0.5181 | 0.0408 | 0.0394 |

PASS. Several features separate the classes in principle.

## Task 4 — leave-one-base-piece-out CV

Training fold = O and N of the other 12 pieces. Held-out piece = all its
variants.

| Held piece | Threshold | O flagged / O notes | N tp / deviations | N non-deviating flagged |
|---|---|---|---|---|
| 01 | 0.2479 | 1 / 45 | 1 / 2 | 1 |
| 02 | 0.4163 | 0 / 34 | 1 / 3 | 0 |
| 03 | 0.3612 | 0 / 34 | 2 / 3 | 0 |
| 04 | 0.5073 | 2 / 85 | 0 / 4 | 0 |
| 05 | 0.4744 | 0 / 56 | 2 / 3 | 1 |
| 06 | 0.3596 | 0 / 60 | 2 / 3 | 0 |
| 07 | 0.4554 | 0 / 42 | 0 / 0 | 0 |
| 08 | 0.2235 | 2 / 60 | 0 / 0 | 0 |
| 09 | 0.2501 | 0 / 100 | 2 / 4 | 1 |
| 10 | 0.4677 | 0 / 150 | 0 / 0 | 0 |
| 11 | 0.4870 | 0 / 121 | 0 / 0 | 0 |
| 12 | 0.4668 | 0 / 50 | 0 / 0 | 0 |
| 13 | 0.4403 | 0 / 37 | 2 / 4 | 0 |

- Recall (N variant): **12/26**
- Original (O) pieces falsely flagged: **3/13**
- O note-level false flags: **5/874** (0.57%)
- Non-deviating notes flagged on N variants: **3/425**
- Supplementary RN recall: **8/19**

**Control** (training labels randomly permuted, same CV): recall 4/26,
12/13 O pieces flagged, 33/874 O note false flags.

**Comparison with existing numbers (not re-run):**

| Candidate | Pieces flagged (O) | Note FP | Recall |
|---|---|---|---|
| Production detector (A) | 0/13 | 0.00% | 0/26 |
| Bare Basic Pitch + Parangonar adapter | 13/13 | 10.64% | 21/26 |
| This classifier (LOPO, max-F1 threshold) | 3/13 | 0.57% | 12/26 |

## Task 5 — GO/STOP

| Criterion | Result |
|---|---|
| C1: recall >= 13/26 | **FAIL** (12/26) |
| C2: <= 1/13 originals flagged | **FAIL** (3/13) |
| C3: no annotation leakage | PASS |
| C4: practical latency | PASS |

**STOP.**

**C3, how verified.** Feature construction takes no labels. A runtime guard
wraps `partitura.load_musicxml` while features are built for every
performance and asserts only O scores were opened (13 files, 0 non-O). Each
fold asserts the held-out piece is absent from training. The threshold uses
training-fold probabilities and labels only. R and RN are never used for
training.

**C4, measured wall clock per held-out O piece.** Feature construction,
scaling and prediction: 0.0010 to 0.0056 s per piece (max 0.0057 s, limit
5 s). Parangonar alignment: 0.32 to 0.87 s per piece after warm-up. The
first call took 7.02 s (matcher warm-up on piece 01), and the cached
first-run value is shown. Basic Pitch inference is run once and cached,
outside this timing.

---

## Interpretation (kept narrow)

- The features carry real signal. Strongest alternate-pitch activation
  alone reaches AUC 0.867. Expected-pitch activation alone reaches 0.897
  when inverted.
- The decision misses on two counts: one recall note short, and two
  pieces of excess false flags. These are measured results, not tuned.
  Any different threshold or feature set would be a new experiment and
  would need its own pre-registration. It is not a reason to re-run this
  one.
- Neighbour and timing features add little alone (`neighbor_context` AUC
  0.638, `alignment_uncertainty` AUC 0.518).
- 0.57% note-level false flags is far below the bare adapter's 10.64%, but
  the 13-piece bar is per-piece, and that gap is still large.

## Test suite

`pytest` from `modal_worker/` (main venv, Python 3.13), with
`--continue-on-collection-errors`, gives **286 passed, 5 failed, 1 collection
error**. The base commit `6258920`, run the same way in a temporary worktree,
gives the same result: 286 passed, 5 failed, 1 error. The 5 failures are all
in `test_visual_validation.py`, and the error is in
`test_generate_timing_accurate_reference_audio.py` (an `AttributeError`
from a `pretty_midi` mock). These are pre-existing and not caused by this
work. They differ from the "~10 failures in `test_inject_audio_mistakes.py` /
`test_visual_validation.py`" described in the brief. Without
`--continue-on-collection-errors`, pytest aborts at that collection error.
