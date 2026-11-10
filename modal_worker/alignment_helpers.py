"""
max_bp_for_piece / bp_onset_support, extracted out of
local_e2e_integration_harness.py so they can be imported without that
file's module-level imports (build_visual_validation_corpus, page_omr_adapter,
and score_conditioned_error_classifier -- the last of which pulls in
harpset_evaluation, a local-validation-only dataset dependency not shipped to
any Modal container). Only numpy + bisect, both already in the main image.

local_e2e_integration_harness.py imports these FROM here (not redefined) so
there is exactly one definition. worker.py's _run_analysis_v2 imports from
here directly for the same reason BP_PY/BP_SCRIPT live in basic_pitch_runner.py.
"""
from __future__ import annotations

import bisect

import numpy as np

FRAME_RATE = 50          # Parangonar default spectrogram frame rate
DEFAULT_MAX_BP = 64.0    # Parangonar AudioToScoreMatcher default
ONSET_WIN_SEC = 0.10     # Basic Pitch onset-evidence window (+/- )
ONSET_THRESHOLD = 0.30   # pre-declared Basic Pitch onset activation threshold


def max_bp_for_piece(audio_sec: float, note_array: np.ndarray) -> float:
    """
    Parangonar's max_bp is a fixed cap on the tracked beat period in
    spectrogram frames (default 64 = 1.28 s/beat at 50 fps). Its own initial
    beat-period estimate is audio_frames / score_beat_span (matcher source,
    audio_matchers.py `bp_average`), which can exceed that cap for a slow
    performance. Bound: never below the default, and always above the
    initial estimate computed from this piece's own audio length and score
    span. Uses no ground-truth labels.
    """
    span = float(note_array["onset_beat"].max() - note_array["onset_beat"].min())
    initial_bp = audio_sec * FRAME_RATE / span
    return max(DEFAULT_MAX_BP, initial_bp)


def bp_onset_support(pitches, times, bp: dict) -> dict:
    """
    Fraction of aligned notes whose pitch has a Basic Pitch onset activation
    (>= ONSET_THRESHOLD) within +/- ONSET_WIN_SEC of the aligned time, versus
    the same measure after shuffling the times across notes (null).
    Independent of Parangonar: only uses Basic Pitch's onset matrix.
    """
    def rate(times_arr):
        hits = []
        for p, tt in zip(pitches, times_arr):
            b = int(p) - 21
            if b < 0 or b >= bp["onset"].shape[1]:
                continue
            lo = bisect.bisect_left(bp["times"], tt - ONSET_WIN_SEC)
            hi = bisect.bisect_right(bp["times"], tt + ONSET_WIN_SEC)
            if hi <= lo:
                hits.append(False)
                continue
            hits.append(float(bp["onset"][lo:hi, b].max()) >= ONSET_THRESHOLD)
        return float(np.mean(hits)) if hits else float("nan")
    aligned = rate(times)
    rng = np.random.default_rng(0)
    null = float(np.nanmean([rate(rng.permutation(times)) for _ in range(5)]))
    evidence = (aligned - null) >= 0.30 and aligned >= 0.50
    return {"aligned_rate": aligned, "null_rate": null, "has_audio_evidence": bool(evidence)}
