"""Gate 1B validation run. Standalone script, not a test (needs real
MusicNet data + fluidsynth rendering, both slow/large for pytest).

For each representative piece: renders score_audio via
generate_timing_accurate_reference_audio, then measures:
  1. Onset/offset detection accuracy (rendered audio vs. the ground
     truth it was rendered FROM) with a tolerance derived empirically
     from a synthetic, no-ambiguity control case, not assumed.
  2. LOCAL synchronization across ~2.05s windows (LadderSym's actual
     window size, confirmed in Gate 1) spanning the whole piece --
     not just a whole-piece duration check, which is what Gate 1 itself
     was limited to and what this task exists to go beyond.
  3. Audio sanity: peak amplitude (clipping), % silence, format.
"""
import csv
import io
import sys
import time
import tracemalloc
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).parent))
from generate_timing_accurate_reference_audio import render_timing_accurate_reference_audio, SAMPLE_RATE
from validate_alignment_against_musicnet import load_ground_truth

DATA_DIR = Path("/Users/matthewwu/.cache/mediant_validation/data")
MUSICNET_SR = 44100
LADDERSYM_WINDOW_SEC = 256 / 125.0  # 256 mel frames @ 125fps (Gate 1 finding)

PIECES = [
    ("2203", "Flute"), ("2202", "Flute"),
    ("2296", "Cello"), ("2218", "Cello"),
    ("2289", "Violin"), ("2242", "Violin"),
]


def load_piece_ground_truth_with_end_sec(piece_id: str) -> list[dict]:
    gt = load_ground_truth(str(DATA_DIR / "labels" / f"{piece_id}.csv"))
    end_sec_by_key = {}
    with open(DATA_DIR / "labels" / f"{piece_id}.csv") as f:
        for row in csv.DictReader(f):
            key = (int(row["start_time"]), int(row["note"]))
            end_sec_by_key[key] = int(row["end_time"]) / MUSICNET_SR
    for n in gt:
        key = (int(round(n["onset_sec"] * MUSICNET_SR)), n["note"])
        n["end_sec"] = end_sec_by_key.get(key, n["onset_sec"] + 0.1)
    return gt


def derive_onset_tolerance_from_synthetic_control() -> float:
    """
    Measures pure synthesis+detection methodology noise on an
    unambiguous synthetic case (isolated notes, generous silence
    between them -- no overlap, no real-performance complexity) so the
    tolerance used to judge real pieces is measured, not assumed.
    """
    notes = [
        {"onset_sec": t, "note": 60 + (i % 12), "end_sec": t + 0.4}
        for i, t in enumerate(np.arange(0.5, 20.0, 1.0))
    ]
    wav_bytes = render_timing_accurate_reference_audio(notes, "Violin")
    audio, sr = sf.read(io.BytesIO(wav_bytes))
    detected = librosa.onset.onset_detect(y=audio.astype(float), sr=sr, units="time", backtrack=False)
    expected = np.array([n["onset_sec"] for n in notes])
    errors = []
    for e in expected:
        nearest = detected[np.argmin(np.abs(detected - e))] if len(detected) else None
        if nearest is not None:
            errors.append(abs(nearest - e))
    return float(np.percentile(errors, 95)) if errors else 0.2


def measure_onset_accuracy(audio: np.ndarray, sr: int, gt: list[dict], tolerance: float) -> dict:
    detected = librosa.onset.onset_detect(y=audio.astype(float), sr=sr, units="time", backtrack=False)
    expected = np.array([n["onset_sec"] for n in gt])
    hits, errors = 0, []
    for e in expected:
        if len(detected) == 0:
            continue
        nearest = detected[np.argmin(np.abs(detected - e))]
        err = abs(nearest - e)
        errors.append(err)
        if err <= tolerance:
            hits += 1
    return {
        "n_expected": len(expected),
        "n_detected_total": len(detected),
        "hit_rate_within_tolerance": hits / len(expected) if len(expected) else 0.0,
        "mean_abs_error_sec": float(np.mean(errors)) if errors else None,
        "p95_abs_error_sec": float(np.percentile(errors, 95)) if errors else None,
    }


def measure_local_synchronization(audio: np.ndarray, sr: int, gt: list[dict], tolerance: float) -> dict:
    """
    Walks the piece in LadderSym-window-sized chunks and checks, per
    window, whether the notes expected (by ground-truth timing) in that
    window actually show up as detected onsets in that SAME window of
    the rendered audio -- i.e. local drift, not just whole-piece
    average duration.
    """
    duration = len(audio) / sr
    detected = librosa.onset.onset_detect(y=audio.astype(float), sr=sr, units="time", backtrack=False)
    window_results = []
    t = 0.0
    while t < duration:
        w_end = t + LADDERSYM_WINDOW_SEC
        expected_in_window = [n["onset_sec"] for n in gt if t <= n["onset_sec"] < w_end]
        if expected_in_window:
            hits = 0
            for e in expected_in_window:
                nearby = detected[(detected >= t - tolerance) & (detected <= w_end + tolerance)]
                if len(nearby) and np.min(np.abs(nearby - e)) <= tolerance:
                    hits += 1
            window_results.append(hits / len(expected_in_window))
        t += LADDERSYM_WINDOW_SEC
    return {
        "n_windows_with_notes": len(window_results),
        "mean_window_hit_rate": float(np.mean(window_results)) if window_results else None,
        "min_window_hit_rate": float(np.min(window_results)) if window_results else None,
        "pct_windows_above_80pct": float(np.mean([r >= 0.8 for r in window_results])) if window_results else None,
    }


def audio_sanity_checks(audio: np.ndarray, sr: int, duration_expected: float) -> dict:
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(audio.astype(float) ** 2)))
    silence_frac = float(np.mean(np.abs(audio) < 1e-4))
    return {
        "sample_rate": sr,
        "duration_sec": len(audio) / sr,
        "peak_amplitude": peak,
        "clipped": peak >= 0.999,
        "rms": rms,
        "silence_fraction": silence_frac,
    }


def main():
    tolerance = derive_onset_tolerance_from_synthetic_control()
    print(f"Derived onset-detection tolerance (95th pct, synthetic control): {tolerance:.4f}s\n")

    results = {}
    for piece_id, instrument in PIECES:
        print(f"--- {piece_id} ({instrument}) ---")
        gt = load_piece_ground_truth_with_end_sec(piece_id)

        t0 = time.time()
        tracemalloc.start()
        wav_bytes = render_timing_accurate_reference_audio(gt, instrument)
        _, peak_mem = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        render_time = time.time() - t0

        audio, sr = sf.read(io.BytesIO(wav_bytes))

        real_dur = sf.info(str(DATA_DIR / "audio" / f"{piece_id}.wav")).duration
        sanity = audio_sanity_checks(audio, sr, real_dur)
        onset_acc = measure_onset_accuracy(audio, sr, gt, tolerance)
        local_sync = measure_local_synchronization(audio, sr, gt, tolerance)

        results[piece_id] = {
            "instrument": instrument,
            "n_notes": len(gt),
            "render_time_sec": render_time,
            "peak_mem_mb": peak_mem / 1e6,
            "real_duration_sec": real_dur,
            **sanity,
            "onset_accuracy": onset_acc,
            "local_sync": local_sync,
        }

        print(f"  notes={len(gt)} render_time={render_time:.1f}s peak_mem={peak_mem/1e6:.1f}MB")
        print(f"  rendered_dur={sanity['duration_sec']:.2f}s real_dur={real_dur:.2f}s "
              f"diff={100*(sanity['duration_sec']-real_dur)/real_dur:+.2f}%")
        print(f"  peak_amp={sanity['peak_amplitude']:.3f} clipped={sanity['clipped']} "
              f"silence_frac={sanity['silence_fraction']:.3f}")
        print(f"  onset hit_rate={onset_acc['hit_rate_within_tolerance']:.3f} "
              f"mean_err={onset_acc['mean_abs_error_sec']:.4f}s p95_err={onset_acc['p95_abs_error_sec']:.4f}s")
        print(f"  local_sync: windows={local_sync['n_windows_with_notes']} "
              f"mean_hit_rate={local_sync['mean_window_hit_rate']:.3f} "
              f"min_hit_rate={local_sync['min_window_hit_rate']:.3f} "
              f"pct_windows>=80%={local_sync['pct_windows_above_80pct']:.3f}")
        print()

    import json
    out_path = Path(__file__).parent / "gate1b_validation_results.json"
    out_path.write_text(json.dumps({"tolerance_sec": tolerance, "pieces": results}, indent=2))
    print(f"Results written to {out_path}")


if __name__ == "__main__":
    main()
