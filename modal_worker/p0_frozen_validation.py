"""
Task 3/4 frozen-set validation ("MEDIANT -- Audio Recovery: Measurement
Fix + New Architecture Feasibility", 2026-10-31).

Runs the frozen 6-piece set (2204, 2218, 2222, 2297, 2244, 2289 --
modal_worker/p0_sprint_frozen_eval_manifest.json) through:

  (A) the current production pipeline: run_pitch_tracking +
      dtw_align_to_score (discrete pitch-event DTW).
  (B) the chroma/CQT continuous-feature DTW from
      chroma_alignment_experiment.py.
  (C) a minimal hybrid: CREPE's real detected events (same as A) with
      ONLY the measure-assignment step replaced by (B)'s warping path --
      everything else about find_wrong_note_candidates is untouched.

Measures, for each: note/measure localization (classify_alignment),
missing/extra/wrong_pitch/octave/correct counts via the validated
note_sequence_evaluator (A only -- see module docstring note on why a
direct comparison doesn't apply the same way to B/C's continuous
output), wrong-pitch precision/recall on verified injected mistakes
(A vs C -- the actual product-relevant test), false positives on
unmodified audio (A vs C), CPU time, broken out by instrument.

NOT wired into production. Standalone validation script, same category
as the other modal_worker/*.py validation tools. No worker.py edits.
"""
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import librosa
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402
from validate_alignment_against_musicnet import (  # noqa: E402
    midi_score_to_dict, load_ground_truth, calibrate_assumptions,
    classify_alignment, nearest_ground_truth_measure, pct,
)
from note_sequence_evaluator import align_note_sequences  # noqa: E402
from inject_audio_mistakes import inject_mistake_verified  # noqa: E402
from benchmark_full_pipeline import load_ground_truth_with_end_sec  # noqa: E402
import chroma_alignment_experiment as chroma  # noqa: E402

DATA_DIR = Path("/Users/matthewwu/.cache/mediant_validation/data")

with open(Path(__file__).parent / "p0_sprint_frozen_eval_manifest.json") as f:
    MANIFEST = json.load(f)
FROZEN = MANIFEST["frozen_ids"]
INSTR = MANIFEST["instruments"]


def build_chroma_alignment(piece_id, instrument, score, beats_per_measure, y, sr):
    """Same template/DTW/warping-path construction as
    chroma_alignment_experiment.run_one_piece, factored out so it can be
    reused to re-align arbitrary (CREPE) event times, not just
    ground-truth onsets."""
    transpose = w.transpose_for_instrument(instrument) or 0
    score_events = chroma.build_score_events(score, beats_per_measure, transpose)
    audio_duration_sec = len(y) / sr
    last_onset_beat, last_dur, _, _ = score_events[-1]
    total_beats = last_onset_beat + last_dur
    sec_per_beat = audio_duration_sec / total_beats
    template, measure_per_frame = chroma.render_template(score_events, total_beats, sec_per_beat)

    hop_length = int(round(sr * chroma.FRAME_HOP_SEC))
    audio_chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
    audio_n_frames = audio_chroma.shape[1]

    t0 = time.time()
    D, wp = librosa.sequence.dtw(X=template, Y=audio_chroma, metric="euclidean")
    dtw_elapsed = time.time() - t0

    wp_sorted = wp[::-1]
    audio_to_template = {}
    for t_idx, a_idx in wp_sorted:
        audio_to_template.setdefault(a_idx, t_idx)

    def time_to_measure(time_sec: float):
        a_idx = max(0, min(int(time_sec / chroma.FRAME_HOP_SEC), audio_n_frames - 1))
        t_idx = audio_to_template.get(a_idx)
        if t_idx is None:
            nearest = min(audio_to_template.keys(), key=lambda k: abs(k - a_idx))
            t_idx = audio_to_template[nearest]
        return measure_per_frame[min(t_idx, len(measure_per_frame) - 1)]

    return time_to_measure, dtw_elapsed


def events_to_ns_eval_format(events):
    out = []
    for ev in events:
        midi = ev.get("midi_raw", ev.get("midi"))
        t = ev.get("time_sec")
        if midi is None or t is None:
            continue
        out.append({"time_sec": float(t), "midi": int(round(midi))})
    return out


def gt_to_ns_eval_format(ground_truth):
    return [{"time_sec": g["onset_sec"], "midi": g["note"]} for g in ground_truth]


def run_piece(piece_id):
    instrument = INSTR[piece_id]
    midi_path = DATA_DIR / "midis" / f"{piece_id}.mid"
    wav_path = DATA_DIR / "audio" / f"{piece_id}.wav"
    label_path = DATA_DIR / "labels" / f"{piece_id}.csv"

    score = midi_score_to_dict(midi_path)
    beats_per_measure = w.beats_per_measure_from_time_sig(score["time_signature"])
    ground_truth = load_ground_truth(label_path)
    if not calibrate_assumptions(score, ground_truth, beats_per_measure, piece_id):
        return {"piece": piece_id, "error": "calibration failed"}

    wav_bytes = wav_path.read_bytes()
    y, sr = librosa.load(str(wav_path), sr=chroma.MUSICNET_SR, mono=True)

    # ---- (A) current pipeline ----
    t0 = time.time()
    events = w.run_pitch_tracking(wav_bytes, instrument=instrument)
    aligned_a = w.dtw_align_to_score(events, score, start_measure=1,
                                      beats_per_measure=beats_per_measure, end_measure=None)
    a_elapsed = time.time() - t0
    if not aligned_a:
        return {"piece": piece_id, "error": "dtw_align_to_score declined (A)"}

    outcomes_a = []
    for ev in aligned_a:
        true_measure = nearest_ground_truth_measure(ev["time_sec"], ground_truth, beats_per_measure)
        outcomes_a.append(classify_alignment(ev.get("measure"), true_measure))
    counts_a = {k: outcomes_a.count(k) for k in ("correct", "off_by_one", "wrong", "unmatched")}

    ns_eval_a = align_note_sequences(gt_to_ns_eval_format(ground_truth),
                                      events_to_ns_eval_format(aligned_a))
    ns_summary_a = ns_eval_a.summary(gt_to_ns_eval_format(ground_truth),
                                      events_to_ns_eval_format(aligned_a))

    # ---- (B) chroma-DTW (ground-truth-onset localization, matches prior report) ----
    time_to_measure, b_elapsed = build_chroma_alignment(piece_id, instrument, score,
                                                          beats_per_measure, y, sr)
    outcomes_b = []
    for g in ground_truth:
        true_measure = int(g["start_beat"] // beats_per_measure) + 1
        predicted_measure = time_to_measure(g["onset_sec"])
        outcomes_b.append(classify_alignment(predicted_measure, true_measure))
    counts_b = {k: outcomes_b.count(k) for k in ("correct", "off_by_one", "wrong", "unmatched")}

    # ---- (C) hybrid: real CREPE events (same `events` as A), measure via chroma warping path ----
    aligned_c = []
    for ev in events:
        pitches = ev.get("pitches", [])
        if not pitches:
            continue
        measure = time_to_measure(ev.get("time_sec", 0.0))
        ev_c = dict(ev)
        ev_c["measure"] = measure
        aligned_c.append(ev_c)

    outcomes_c = []
    for ev in aligned_c:
        true_measure = nearest_ground_truth_measure(ev["time_sec"], ground_truth, beats_per_measure)
        outcomes_c.append(classify_alignment(ev.get("measure"), true_measure))
    counts_c = {k: outcomes_c.count(k) for k in ("correct", "off_by_one", "wrong", "unmatched")}

    # ---- wrong-note detection: A (production aligned_a) vs C (hybrid aligned_c) ----
    fp_a = w.find_wrong_note_candidates(aligned_a, score, instrument=instrument)
    fp_c = w.find_wrong_note_candidates(aligned_c, score, instrument=instrument)

    # ---- verified injected wrong_pitch mistake: recall on A vs C ----
    ground_truth_with_end = load_ground_truth_with_end_sec(label_path)
    inj = inject_mistake_verified(wav_bytes, ground_truth_with_end, score, beats_per_measure,
                                   instrument, base_seed=int(piece_id))
    recall_a = recall_c = None
    if inj["valid"]:
        inj_wav = inj["result"]["wav_bytes"]
        inj_measure = inj["result"]["injected"]["measure"]
        inj_events = w.run_pitch_tracking(inj_wav, instrument=instrument)
        inj_aligned_a = w.dtw_align_to_score(inj_events, score, start_measure=1,
                                              beats_per_measure=beats_per_measure, end_measure=None)
        flags_a = w.find_wrong_note_candidates(inj_aligned_a, score, instrument=instrument) if inj_aligned_a else []
        recall_a = any(f"measure {inj_measure}" in fl for fl in flags_a)

        inj_aligned_c = []
        for ev in inj_events:
            if not ev.get("pitches"):
                continue
            ev_c = dict(ev)
            ev_c["measure"] = time_to_measure(ev.get("time_sec", 0.0))
            inj_aligned_c.append(ev_c)
        flags_c = w.find_wrong_note_candidates(inj_aligned_c, score, instrument=instrument)
        recall_c = any(f"measure {inj_measure}" in fl for fl in flags_c)

    return {
        "piece": piece_id, "instrument": instrument,
        "counts_a": counts_a, "counts_b": counts_b, "counts_c": counts_c,
        "correct_pct_a": pct(counts_a, "correct"), "correct_pct_b": pct(counts_b, "correct"),
        "correct_pct_c": pct(counts_c, "correct"),
        "ns_eval_a": ns_summary_a,
        "fp_count_a": len(fp_a), "fp_count_c": len(fp_c),
        "fp_flags_a": fp_a, "fp_flags_c": fp_c,
        "injection_valid": inj["valid"], "injection_attempts": len(inj["attempts"]),
        "recall_a": recall_a, "recall_c": recall_c,
        "a_elapsed_sec": a_elapsed, "b_elapsed_sec": b_elapsed,
    }


if __name__ == "__main__":
    results = []
    for piece_id in FROZEN:
        t0 = time.time()
        try:
            r = run_piece(piece_id)
        except Exception as e:
            import traceback
            traceback.print_exc()
            r = {"piece": piece_id, "error": f"{type(e).__name__}: {e}"}
        r["wall_sec"] = time.time() - t0
        print(json.dumps(r, default=str))
        results.append(r)

    print("\n" + "=" * 70)
    for r in results:
        print(r.get("piece"), r.get("instrument"), "A=", r.get("correct_pct_a"),
              "B=", r.get("correct_pct_b"), "C=", r.get("correct_pct_c"),
              "FP_A=", r.get("fp_count_a"), "FP_C=", r.get("fp_count_c"),
              "inj_valid=", r.get("injection_valid"),
              "recall_A=", r.get("recall_a"), "recall_C=", r.get("recall_c"))
    print("=" * 70)
