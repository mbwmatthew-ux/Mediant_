"""
"MEDIANT -- score-conditioned error classifier" (2026-11-08).

**RESULT: STOP.** Task 2 (coverage) passed. Task 4 leave-one-piece-out CV
gave recall 12/26 (criterion C1 needs >= 13/26) and 3/13 original pieces
falsely flagged (criterion C2 needs <= 1/13). Criteria C3 (no leakage)
and C4 (latency) passed. Details and the full per-fold table are below.

Method (fixed in advance, implemented as specified):
  * Basic Pitch raw frame outputs (note / onset / contour), extracted in
    the isolated `venv_basic_pitch` (default `predict` settings, no tuning)
    and cached outside the repo at
    `/Users/matthewwu/.cache/mediant_validation/score_conditioned_cache`.
  * Parangonar `AudioToScoreMatcher` onset-level alignment (main venv),
    using ONLY the original (O) MusicXML as the score reference.
  * 7 fixed features per expected note, computed from the O score plus
    the performance audio only (see `note_features`).
  * Logistic regression, L2 penalty (the sklearn default), C=1.0, not
    tuned. Features standardised with a scaler fit on the training fold.
  * Leave-one-base-piece-out CV over the 13 HARPSET compositions.
  * Threshold per fold = the training-fold precision-recall point with the
    maximum F1 on training-fold notes only (chosen before any run).

Ground truth: pitch-deviation labels from direct MusicXML diffing of each
N/RN score against its O score (`harpset_evaluation.ground_truth_pitch_errors`),
not from `errors.csv`. Labels are only read after features are built.

**Deviation count, reconciled (not silently overridden).** The task brief
states 26 real deviations across N/R/RN. Direct recount:
  * N variants: 26 pitch deviations across 8 pieces (01, 02, 03, 04, 05,
    06, 09, 13). This matches `errors.csv` (26 N rows) and the prior
    round's 26. Piece 13 is included here; see the harness note below.
  * RN variants: 19 diff-based pitch deviations in 7 pieces (plus 01_RN
    excluded for a 45-vs-44 note length mismatch, which `errors.csv`
    lists as 2 rows). For pieces 02, 03, 05, 13 these are the same notes
    as in N. Pieces 10 and 11 have 3 + 3 RN-only deviations, with no N variant.
  * R variants: no pitch labels in `errors.csv`. The R score for piece 03
    nevertheless contains the same 3 pitch changes as 03_N, which the
    README does not describe. R is never used for training or scoring.
  So 26 is the N-variant count. It is kept as the headline denominator so
  results compare directly with the prior rounds. RN is reported as a
  supplementary recall, not part of the decision.

**Harness discrepancy, reported not fixed.** `harpset_evaluation.py`'s
Part 2 loop filters pieces with `metadata.csv` rows. That file has no
piece-13 N row and does list `12_N`, which is absent on disk. As committed,
the loop therefore evaluates 22 of the 26 N-variant deviations (pieces
01-06 and 09), not 26. Its docstring says the piece-13 gap was fixed, but
the committed code does not do that. Not re-run and not modified here.
This script resolves paths by naming convention and reuses only its
`ground_truth_pitch_errors` and `score_note_array` helpers, which take paths
directly.

RESULTS (measured 2026-11-08, real recorded harp audio, 13 O performances,
8 N performances with 26 pitch deviations, 7 RN supplementary):

Task 2, coverage (26 N deviations vs all 874 O-variant notes, single-feature
AUC; pre-registered pass rule: some feature with |AUC-0.5| >= 0.10):

    feature                          AUC     median_dev  median_ok
    expected_pitch_activation        0.1034  0.1221      0.8241
    strongest_alt_pitch_activation   0.8671  0.8447      0.6958
    onset_evidence                   0.1425  0.2203      0.8941
    temporal_consistency             0.0841  0.1040      0.6725
    contour_support                  0.1040  0.1478      0.8120
    neighbor_context                 0.6384  0.7164      0.6802
    alignment_uncertainty            0.5181  0.0408      0.0394
    -> PASS (several features separate the classes strongly in principle).

Task 4, leave-one-base-piece-out (training: O and N of the other 12 pieces):

    held   thr     O_flag  O_notes  N_tp/dev  N_nondev_flag
    01     0.2479  1       45       1/2       1
    02     0.4163  0       34       1/3       0
    03     0.3612  0       34       2/3       0
    04     0.5073  2       85       0/4       0
    05     0.4744  0       56       2/3       1
    06     0.3596  0       60       2/3       0
    07     0.4554  0       42       0/0       0
    08     0.2235  2       60       0/0       0
    09     0.2501  0       100      2/4       1
    10     0.4677  0       150      0/0       0
    11     0.4870  0       121      0/0       0
    12     0.4668  0       50       0/0       0
    13     0.4403  0       37       2/4       0

    recall (N variant, 26 deviations):                12/26
    original (O) pieces falsely flagged:              3/13
    O note-level false flags:                         5/874 (0.57%)
    non-deviating notes flagged on N variants:        3/425
    supplementary RN recall (19 diff-based labels):   8/19

Control (training labels randomly permuted, same CV): recall 4/26,
O pieces flagged 12/13, O note FP 33/874. The permuted run is worse than
the real one on recall, which is the expected direction for a real signal.

Comparison, using the existing numbers (not re-run):
    production detector (`A`):                 0/13 pieces, recall 0/26
    bare Basic Pitch + Parangonar adapter:     13/13 pieces, 10.64% note FP, recall 21/26
    this classifier (LOPO, max-F1 threshold):  3/13 pieces, 0.57% note FP, recall 12/26

Task 5 decision, against the four pre-stated criteria:
    C1 recall >= 13/26:                 FAIL (12/26)
    C2 <= 1/13 originals flagged:       FAIL (3/13)
    C3 no annotation leakage:           PASS (see below)
    C4 latency:                         PASS (see below)
    -> STOP

C3, how it was verified:
  * Feature construction is `note_features(na_o, perf_times, bp)`. It takes
    no labels. Labels are loaded only by `labels_for` after features exist.
  * A runtime guard wraps `partitura.load_musicxml` while features are built
    for every performance. The guard asserts that only O-variant scores
    were opened: 13 files, 0 non-O files (printed at run time).
  * Each fold asserts the held-out piece is absent from its training set,
    and the training matrix comes only from the other 12 pieces' O and N.
  * The threshold is computed only from training-fold probabilities and
    training labels. The held-out labels are used only for scoring.
  * R and RN variants are never used for training.

C4, measured wall clock per held-out O piece:
  * Basic Pitch inference is run once per performance and cached. Its
    timing is not part of the per-piece classify path.
  * Parangonar alignment: 0.32-0.87 s per piece after warm-up. First call
    7.02 s (matcher warm-up, piece 01); the values shown are the cached
    first-run measurements.
  * Features + scaling + predict: 0.0010-0.0056 s per piece (max 0.0057 s,
    limit 5 s).

Interpretation (kept narrow):
  * The features carry real signal. Single features alone separate the
    classes (strongest alternate-pitch activation AUC 0.867, expected-pitch
    activation AUC 0.897 when inverted).
  * The threshold rule is weak in one direction. Recall is 12/26 with 3/13
    pieces flagged, so a 1-note recall shortfall and a 2-piece FP excess
    both fail. This is measured, not tuned. Any different threshold or
    feature set would be a new experiment with its own pre-registration.
  * Neighbour and timing features add little on their own
    (neighbor_context AUC 0.638, alignment_uncertainty AUC 0.518).
  * The 0.57% note-level FP is far below the bare adapter's 10.64%, but
    the 13-piece bar is per-piece, so the gap is still large.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import partitura as pt
import parangonar as pa
import soundfile as sf
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import precision_recall_curve, roc_auc_score
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).parent))

from harpset_evaluation import ALL_PIECES, HARPSET, ground_truth_pitch_errors, score_note_array

from basic_pitch_runner import BP_PY, BP_SCRIPT  # noqa: E402 (see that file)
CACHE = Path("/Users/matthewwu/.cache/mediant_validation/score_conditioned_cache")

MIDI_OFFSET = 21            # Basic Pitch "note"/"onset" bin 0 = MIDI 21 (A0)
CONTOUR_BINS_PER_SEMITONE = 3
PRE_ONSET_SEC = 0.05        # note window starts 50 ms before aligned onset
ONSET_HALF_WIN_SEC = 0.10   # onset-evidence window is +/- 100 ms
MIN_DUR_SEC, MAX_DUR_SEC = 0.08, 2.0
TIMING_NEIGHBOR_RADIUS = 3  # notes on each side for local tempo median

FEATURE_NAMES = [
    "expected_pitch_activation",
    "strongest_alt_pitch_activation",
    "onset_evidence",
    "temporal_consistency",
    "contour_support",
    "neighbor_context",
    "alignment_uncertainty",
]

# Pre-registered before any run: Task 2 STOPs unless at least one feature
# alone separates deviations from correct notes with |AUC - 0.5| >= this.
COVERAGE_AUC_MARGIN = 0.10
LR_C = 1.0                  # fixed, not tuned
SUSTAIN_FRACTION = (0.25, 0.75)  # sustain window = central 50% of note duration
LATENCY_LIMIT_SEC = 5.0     # pre-registered: max per-piece classify time

# Dataset file naming (HARPSET naming convention). metadata.csv is NOT used:
# it has no piece-13 N row and lists 12_N, which does not exist on disk.
def score_path(pid: str, variant: str) -> Path:
    return HARPSET / "scores" / f"{pid}_{variant}_Score.xml"


def audio_path(pid: str, variant: str) -> Path:
    return HARPSET / "audio" / f"{pid}_{variant}_Recording.wav"


# ---------------------------------------------------------------------------
# Basic Pitch raw outputs (isolated venv, cached) — BP_PY/BP_SCRIPT imported
# from basic_pitch_runner above.
# ---------------------------------------------------------------------------


def bp_cache_path(pid: str, variant: str) -> Path:
    return CACHE / f"{pid}_{variant}_bp.npz"


def ensure_basic_pitch(pid: str, variant: str) -> dict:
    """Run Basic Pitch raw inference once per performance; cache the arrays."""
    CACHE.mkdir(parents=True, exist_ok=True)
    out = bp_cache_path(pid, variant)
    if not out.exists():
        result = subprocess.run(
            [BP_PY, "-c", BP_SCRIPT, str(audio_path(pid, variant)), str(out)],
            capture_output=True, text=True, timeout=600,
        )
        if "OK" not in result.stdout:
            raise RuntimeError(f"Basic Pitch failed on {pid}_{variant}: {result.stderr[-800:]}")
    d = np.load(out)
    return {"note": d["note"], "onset": d["onset"], "contour": d["contour"],
            "times": d["times"], "bp_seconds": float(d["bp_seconds"])}


# ---------------------------------------------------------------------------
# Parangonar timing alignment (main venv), cached per performance
# ---------------------------------------------------------------------------

_MATCHER = None


def align_performance(pid: str, variant: str, na_o) -> tuple[np.ndarray, float]:
    """Performance onset time per O-score note (Parangonar, pitch-blind)."""
    global _MATCHER
    cache = CACHE / f"{pid}_{variant}_align.npy"
    if cache.exists():
        return np.load(cache), float(np.load(cache.with_suffix(".sec.npy")))
    audio, sr = sf.read(str(audio_path(pid, variant)))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if _MATCHER is None:
        _MATCHER = pa.AudioToScoreMatcher()
    t0 = time.time()
    alignment = _MATCHER(audio.astype(np.float32), na_o, sample_rate=sr)
    elapsed = time.time() - t0
    times = np.array([float(a["performance_time"]) for a in alignment])
    assert len(times) == len(na_o), "alignment must give one time per O-score note"
    CACHE.mkdir(parents=True, exist_ok=True)
    np.save(cache, times)
    np.save(cache.with_suffix(".sec.npy"), np.array(elapsed))
    return times, elapsed


# ---------------------------------------------------------------------------
# Task 1: the feature vector
# ---------------------------------------------------------------------------

def note_features(na_o, perf_times: np.ndarray, bp: dict) -> np.ndarray:
    """Return an (n_notes, 7) matrix, one row per O-score note, one column per
    FEATURE_NAMES entry. Inputs: the O score note array, Parangonar's onset
    time per note, and the frozen Basic Pitch raw arrays. NO labels are
    accepted by this function (leakage guard, see main()).

    Notation: t_i = aligned onset of note i (s); dur_i = clip(t_{i+1} - t_i,
    0.08, 2.0) s (1.0 s for the last note); window W_i = frames with time in
    [t_i - 0.05, t_i + dur_i]; e_i = MIDI pitch_i - 21 (Basic Pitch bin).
      expected_pitch_activation        = max over W_i of note[:, e_i]
      strongest_alt_pitch_activation   = max over W_i and all bins p != e_i of note[:, p]
                                         (88-bin axis, NOT pitch class: octave alts count)
      onset_evidence                   = max over frames in [t_i-0.10, t_i+0.10] of onset[:, e_i]
      temporal_consistency             = min over frames in [t_i+0.25*dur_i, t_i+0.75*dur_i] of note[:, e_i]
      contour_support                  = max over W_i and contour bins {3e_i-1, 3e_i, 3e_i+1} (+/-1/3 semitone)
      neighbor_context                 = max over the prev/next note j with pitch_j != pitch_i of
                                         max over W_i of note[:, pitch_j - 21]; 0 if none
      alignment_uncertainty            = |r_i - median(r_{i-3..i+3})|, r_i = log((t_{i+1}-t_i)/(s_{i+1}-s_i))
                                         with s the score onset in beats; 0 where undefined
    Frames/bins with no samples in a window fall back to the nearest frame.
    """
    times = bp["times"]
    P, ON, C = bp["note"], bp["onset"], bp["contour"]
    pitches = np.asarray(na_o["pitch"], dtype=int)
    onset_beat = np.asarray(na_o["onset_beat"], dtype=float)
    t = np.asarray(perf_times, dtype=float)
    n = len(pitches)
    assert P.shape[1] == 88 and C.shape[1] == 264 and ON.shape[1] == 88
    e_all = pitches - MIDI_OFFSET
    assert e_all.min() >= 0 and e_all.max() <= 87, "pitch outside Basic Pitch range"

    nxt = np.append(t[1:], np.nan)
    dur = np.where(np.isnan(nxt), 1.0, np.clip(nxt - t, MIN_DUR_SEC, MAX_DUR_SEC))

    ds = np.diff(onset_beat)
    dt = np.diff(t)
    with np.errstate(divide="ignore", invalid="ignore"):
        logr = np.where(ds > 0, np.log(np.maximum(dt, 1e-6) / np.maximum(ds, 1e-9)), np.nan)

    out = np.zeros((n, len(FEATURE_NAMES)))
    for i in range(n):
        e = int(e_all[i])
        ti, di = t[i], dur[i]

        w = (times >= ti - PRE_ONSET_SEC) & (times <= ti + di)
        if not w.any():
            w = np.zeros(len(times), dtype=bool)
            w[np.argmin(np.abs(times - ti))] = True
        Pw = P[w]

        f_expected = Pw[:, e].max()
        mask_alt = np.ones(88, dtype=bool)
        mask_alt[e] = False
        f_alt = Pw[:, mask_alt].max()

        won = (times >= ti - ONSET_HALF_WIN_SEC) & (times <= ti + ONSET_HALF_WIN_SEC)
        if not won.any():
            won = np.zeros(len(times), dtype=bool)
            won[np.argmin(np.abs(times - ti))] = True
        f_onset = ON[won, e].max()

        ws = (times >= ti + SUSTAIN_FRACTION[0] * di) & (times <= ti + SUSTAIN_FRACTION[1] * di)
        f_consistency = P[ws, e].min() if ws.any() else Pw[:, e].min()

        k = CONTOUR_BINS_PER_SEMITONE * e
        f_contour = C[w][:, max(0, k - 1):min(C.shape[1] - 1, k + 1) + 1].max()

        f_neighbor = 0.0
        for j in (i - 1, i + 1):
            if 0 <= j < n and pitches[j] != pitches[i]:
                f_neighbor = max(f_neighbor, Pw[:, pitches[j] - MIDI_OFFSET].max())

        lo, hi = max(0, i - TIMING_NEIGHBOR_RADIUS), min(len(logr), i + TIMING_NEIGHBOR_RADIUS + 1)
        local = logr[lo:hi] if len(logr) else np.array([])
        if i < len(logr) and np.isfinite(logr[i]) and np.isfinite(local).any():
            f_timing = abs(logr[i] - np.nanmedian(local))
        else:
            f_timing = 0.0

        out[i] = [f_expected, f_alt, f_onset, f_consistency, f_contour, f_neighbor, f_timing]
    return out


# ---------------------------------------------------------------------------
# Ground truth (labels only; never passed into note_features)
# ---------------------------------------------------------------------------

def labels_for(pid: str, variant: str, n: int) -> np.ndarray | None:
    """Per-note deviation labels for a performance, from direct score diffing
    (reuses harpset_evaluation.ground_truth_pitch_errors). None = excluded."""
    if variant == "O":
        return np.zeros(n, dtype=int)
    idx = ground_truth_pitch_errors(pid, variant)
    if idx is None:
        return None
    y = np.zeros(n, dtype=int)
    y[idx] = 1
    return y


def build_piece(pid: str, variant: str, load_log: list | None = None):
    """Features for one performance, using the O score only.
    Returns (na_o, X, bp_seconds, align_seconds, feature_seconds)."""
    na_o = score_note_array(pid, "O")
    bp = ensure_basic_pitch(pid, variant)
    perf_times, align_sec = align_performance(pid, variant, na_o)
    t0 = time.time()
    X = note_features(na_o, perf_times, bp)
    feat_sec = time.time() - t0
    return na_o, X, bp["bp_seconds"], align_sec, feat_sec


# ---------------------------------------------------------------------------
# Experiment
# ---------------------------------------------------------------------------

def load_all_pieces():
    """data[(pid, variant)] = dict(X, y, pieces...) for O and N, plus RN
    (supplementary, never used for training). The leakage guard records every
    score file opened while features are built and asserts only O scores."""
    data = {}
    feature_loads: list[str] = []
    original_loader = pt.load_musicxml

    def recording_loader(path, *a, **k):
        feature_loads.append(str(path))
        return original_loader(path, *a, **k)

    timing = {}
    for pid in ALL_PIECES:
        for variant in ("O", "N", "RN"):
            if not audio_path(pid, variant).exists() or not score_path(pid, variant).exists():
                continue
            pt.load_musicxml = recording_loader
            try:
                na_o, X, bp_sec, align_sec, feat_sec = build_piece(pid, variant)
            finally:
                pt.load_musicxml = original_loader
            y = labels_for(pid, variant, len(na_o))  # labels loaded AFTER features
            if y is None:
                print(f"excluded {pid}_{variant}: parallel diffing invalid (length mismatch)")
                continue
            data[(pid, variant)] = {"X": X, "y": y, "bp_sec": bp_sec, "align_sec": align_sec,
                                    "feat_sec": feat_sec, "n": len(na_o)}
            timing[(pid, variant)] = (bp_sec, align_sec)
    leaked = [p for p in feature_loads if not p.endswith("_O_Score.xml")]
    return data, feature_loads, leaked


def coverage_check(data) -> bool:
    """Task 2: single-feature separability of the 26 N-variant deviations vs
    all O-variant (correct) notes. No model is fit here."""
    X_dev = np.vstack([v["X"][v["y"] == 1] for k, v in data.items() if k[1] == "N"])
    X_ok = np.vstack([v["X"] for k, v in data.items() if k[1] == "O"])
    print(f"\n=== Task 2: coverage check ===")
    print(f"deviations (N variant, pitch-diff labels): {len(X_dev)}")
    print(f"correct notes (all O variants): {len(X_ok)}")
    y_all = np.concatenate([np.ones(len(X_dev)), np.zeros(len(X_ok))])
    X_all = np.vstack([X_dev, X_ok])
    passed = False
    print(f"{'feature':34s} {'AUC':>7s} {'median_dev':>11s} {'median_ok':>11s}")
    for j, name in enumerate(FEATURE_NAMES):
        auc = roc_auc_score(y_all, X_all[:, j])
        if abs(auc - 0.5) >= COVERAGE_AUC_MARGIN:
            passed = True
        print(f"{name:34s} {auc:7.4f} {np.median(X_dev[:, j]):11.4f} {np.median(X_ok[:, j]):11.4f}")
    print(f"pre-registered rule: pass if any |AUC-0.5| >= {COVERAGE_AUC_MARGIN} -> {'PASS' if passed else 'FAIL'}")
    return passed


def best_f1_threshold(y: np.ndarray, p: np.ndarray) -> float:
    prec, rec, thr = precision_recall_curve(y, p)
    f1 = 2 * prec[:-1] * rec[:-1] / np.maximum(prec[:-1] + rec[:-1], 1e-12)
    return float(thr[int(np.argmax(f1))])


def leave_one_piece_out(data, shuffle_labels: bool = False, seed: int = 0):
    """Task 4. Training fold = O and N of the other 12 compositions only.
    Threshold = max training-fold F1 (training data only). Held-out piece's
    O variant gives false flags; its N variant gives recall."""
    rng = np.random.default_rng(seed)
    fold_rows = []
    total_tp = total_dev = 0
    o_pieces_flagged = o_notes_flagged = o_notes_total = 0
    n_nondev_flagged = n_nondev_total = 0
    rn_tp = rn_dev = 0
    latencies = {}
    for held in ALL_PIECES:
        train_keys = [k for k in data if k[0] != held and k[1] in ("O", "N")]
        assert all(k[0] != held for k in train_keys)
        X_tr = np.vstack([data[k]["X"] for k in train_keys])
        y_tr = np.concatenate([data[k]["y"] for k in train_keys])
        if shuffle_labels:
            y_tr = rng.permutation(y_tr)
        scaler = StandardScaler().fit(X_tr)
        clf = LogisticRegression(C=LR_C, max_iter=2000)  # default penalty is L2
        clf.fit(scaler.transform(X_tr), y_tr)
        p_tr = clf.predict_proba(scaler.transform(X_tr))[:, 1]
        thr = best_f1_threshold(y_tr, p_tr)

        held_o = data.get((held, "O"))
        if held_o is None:
            continue
        t0 = time.time()
        p_o = clf.predict_proba(scaler.transform(held_o["X"]))[:, 1]
        pred_o = p_o >= thr
        classify_sec = time.time() - t0  # scale + predict on all notes of one piece
        latencies[held] = {"align_sec": held_o["align_sec"], "feat_sec": held_o["feat_sec"],
                           "classify_sec": classify_sec}
        o_notes_total += len(pred_o)
        o_notes_flagged += int(pred_o.sum())
        o_pieces_flagged += int(pred_o.any())

        held_n = data.get((held, "N"))
        tp = dev = fp_nondev = nondev = 0
        if held_n is not None:
            p_n = clf.predict_proba(scaler.transform(held_n["X"]))[:, 1]
            pred_n = p_n >= thr
            y_n = held_n["y"] == 1
            tp = int((pred_n & y_n).sum())
            dev = int(y_n.sum())
            fp_nondev = int((pred_n & ~y_n).sum())
            nondev = int((~y_n).sum())
        total_tp += tp
        total_dev += dev
        n_nondev_flagged += fp_nondev
        n_nondev_total += nondev

        held_rn = data.get((held, "RN"))
        if held_rn is not None:
            p_rn = clf.predict_proba(scaler.transform(held_rn["X"]))[:, 1]
            y_rn = held_rn["y"] == 1
            rn_tp += int(((p_rn >= thr) & y_rn).sum())
            rn_dev += int(y_rn.sum())

        fold_rows.append({"held": held, "threshold": thr, "train_pos": int(y_tr.sum()),
                          "o_flagged": int(pred_o.sum()), "o_notes": len(pred_o),
                          "n_tp": tp, "n_dev": dev, "n_nondev_flagged": fp_nondev})
    return {"folds": fold_rows, "recall": (total_tp, total_dev),
            "o_pieces_flagged": (o_pieces_flagged, len(fold_rows)),
            "o_note_fp": (o_notes_flagged, o_notes_total),
            "nondev_fp_on_N": (n_nondev_flagged, n_nondev_total),
            "rn_recall": (rn_tp, rn_dev), "latencies": latencies}


def main() -> None:
    print("=== Stage 0: Basic Pitch raw outputs + Parangonar alignment (cached) ===")
    data, feature_loads, leaked = load_all_pieces()
    print(f"performances built: {sorted(data.keys())}")
    print(f"score files opened during feature construction: {sorted(set(feature_loads))}")
    print(f"leakage guard: non-O scores opened during features = {len(leaked)}")
    assert not leaked, f"LEAKAGE: features read non-O scores: {leaked}"

    if not coverage_check(data):
        print("\nSTOP at Task 2: coverage check failed; training not run.")
        return

    print("\n=== Task 4: leave-one-base-piece-out, C=1.0, max-train-F1 threshold ===")
    res = leave_one_piece_out(data)
    print(f"{'held':>5s} {'thr':>8s} {'O_flag':>7s} {'O_notes':>8s} {'N_tp/dev':>9s} {'N_nondev_flag':>14s}")
    for r in res["folds"]:
        print(f"{r['held']:>5s} {r['threshold']:8.4f} {r['o_flagged']:7d} {r['o_notes']:8d} "
              f"{r['n_tp']:>4d}/{r['n_dev']:<4d} {r['n_nondev_flagged']:14d}")
    tp, dev = res["recall"]
    print(f"\nrecall (N variant, 26 deviations): {tp}/{dev}")
    print(f"original (O) pieces falsely flagged: {res['o_pieces_flagged'][0]}/{res['o_pieces_flagged'][1]}")
    print(f"O note-level FP: {res['o_note_fp'][0]}/{res['o_note_fp'][1]}")
    print(f"non-deviating notes flagged on N variants: {res['nondev_fp_on_N'][0]}/{res['nondev_fp_on_N'][1]}")
    print(f"supplementary RN recall (pitch labels from diffs): {res['rn_recall'][0]}/{res['rn_recall'][1]}")

    print("\n=== Control: same CV with training labels permuted (chance check) ===")
    ctl = leave_one_piece_out(data, shuffle_labels=True)
    print(f"control recall: {ctl['recall'][0]}/{ctl['recall'][1]}; "
          f"O pieces flagged: {ctl['o_pieces_flagged'][0]}/{ctl['o_pieces_flagged'][1]}; "
          f"O note FP: {ctl['o_note_fp'][0]}/{ctl['o_note_fp'][1]}")

    print("\n=== Task 5: latency (per held-out O piece, wall clock) ===")
    for k, v in sorted(res["latencies"].items()):
        print(f"{k}: align={v['align_sec']:.2f}s features={v['feat_sec']:.4f}s "
              f"scale+predict={v['classify_sec']:.4f}s")
    max_classify = max(v["feat_sec"] + v["classify_sec"] for v in res["latencies"].values())
    print(f"max features+scale+predict per piece: {max_classify:.4f}s (limit {LATENCY_LIMIT_SEC}s)")

    c1 = tp >= 13
    c2 = res["o_pieces_flagged"][0] <= 1
    c3 = not leaked
    c4 = max_classify <= LATENCY_LIMIT_SEC
    print("\n=== Decision ===")
    print(f"C1 recall >= 13/26: {c1} ({tp}/{dev})")
    print(f"C2 <= 1/13 O pieces flagged: {c2} ({res['o_pieces_flagged'][0]}/13)")
    print(f"C3 no leakage: {c3}")
    print(f"C4 latency: {c4}")
    print("GO" if (c1 and c2 and c3 and c4) else "STOP")


if __name__ == "__main__":
    main()
