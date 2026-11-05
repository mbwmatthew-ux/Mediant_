"""
"MEDIANT — confidence/duration gate feasibility" (2026-11-05), Task 1.

Pulls apart the 6 true positives and 432 false positives from the
prior round's adapter evaluation (`basic_pitch_adapter_eval.py`) to
inspect, per event: Basic Pitch's own amplitude (verified directly
against its source, `note_creation.py` -- it is the MEAN of the
model's own per-frame note-activation probability over the note's
duration, 0-1, NOT loudness/velocity and NOT on CREPE's periodicity
scale -- never assumed to match CREPE's confidence semantics), note
duration, pitch distance from the expected score note, onset timing,
instrument, and measure. Also checks directly whether the 432 flags
are 432 DISTINCT underlying Basic Pitch events or contain duplicates
(multiple score notes independently nominating the same performed
event as their nearest-in-time candidate).

Read-only / inspection only -- no gate implemented here (that is
Task 3, contingent on this task's finding). `worker.py` untouched.

RESULTS (measured 2026-11-05):

**Duplicate check — answered cleanly.** All 432 false-positive flags
across the 8 control pieces correspond to 432 DISTINCT (piece, Basic
Pitch event) pairs -- zero duplicates, zero score notes independently
nominating the same underlying performed event. The 432 count is real,
not inflated by double-counting.

**Separation check — NO credible separation on either axis.**

    metric       TP (n=6) range      FP (n=432) 10th/50th/90th pct
    amplitude    [0.513, 0.674]      0.367 / 0.521 / 0.669
    duration(s)  [0.152, 0.534]      0.151 / 0.232 / 0.510

The TP range sits almost entirely INSIDE the FP distribution's middle
80% on both axes. TP amplitude's minimum (0.513) is just below the
FP's own median (0.521); TP duration's minimum (0.152s) sits right at
the FP's 10th percentile (0.151s) and its maximum (0.534s) exceeds the
FP's 90th percentile (0.510s). No single threshold on either field
could meaningfully reduce the 432 false positives without also cutting
several of the 6 true positives -- the two populations are not
separable by Basic Pitch's own amplitude or by note duration, at least
not with this small, synthetic TP set.

Per the directive: **STOP here.** Task 2 (feasibility) says no --
no gate implemented, Task 3/4 not executed.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import soundfile as sf
import partitura as pt
import parangonar as pa

import worker as w
from validate_alignment_against_musicnet import load_rows
from basic_pitch_score_adapter import detect_wrong_notes

HERE = Path(__file__).parent
DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORES = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")
DEV_PIECES = ["2202", "2203", "2217", "2221", "2288", "2293", "2294", "2295"]


def measure_of(na, score_dict, beats_per_measure, score_idx):
    onset_beat = float(na[score_idx]["onset_beat"])
    return int(onset_beat // beats_per_measure) + 1


def main():
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    matcher = pa.AudioToScoreMatcher()
    bp_data = json.loads((HERE / "basic_pitch_events.json").read_text())

    print("=== False positives: 8 unmodified control pieces ===")
    all_fp = []
    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        events = bp_data[pid]["events"]

        audio, sr = sf.read(str(DATA / "audio" / f"{pid}.wav"))
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
        result = detect_wrong_notes(na, alignment, events)

        for n in result["notes"]:
            if n["verdict"] != "substitution":
                continue
            n["piece"] = pid
            n["instrument"] = instrument
            n["measure"] = measure_of(na, score_dict, beats_per_measure, n["score_idx"])
            all_fp.append(n)

    print(f"Total FP flags: {len(all_fp)}")
    distinct_perf_events = set((fp["piece"], fp["played_perf_idx"]) for fp in all_fp)
    print(f"Distinct underlying (piece, Basic-Pitch-event) pairs claimed by an FP flag: "
          f"{len(distinct_perf_events)}")
    # duplicate check: same (piece, played_perf_idx) claimed by >1 score note
    from collections import Counter
    dup_counts = Counter((fp["piece"], fp["played_perf_idx"]) for fp in all_fp)
    dups = {k: v for k, v in dup_counts.items() if v > 1}
    print(f"(piece, event) pairs claimed by MORE THAN ONE flagged score note: {len(dups)}")
    if dups:
        print(f"  Extra flags from duplication: {sum(v - 1 for v in dups.values())}")

    amps = [fp["played_amplitude"] for fp in all_fp if fp["played_amplitude"] is not None]
    durs = [fp["played_duration_sec"] for fp in all_fp]
    dists = [fp["pitch_distance_semitones"] for fp in all_fp]
    print(f"\nFP amplitude: min={min(amps):.3f} max={max(amps):.3f} mean={np.mean(amps):.3f} "
          f"median={np.median(amps):.3f}")
    print(f"FP duration (s): min={min(durs):.3f} max={max(durs):.3f} mean={np.mean(durs):.3f} "
          f"median={np.median(durs):.3f}")
    print(f"FP pitch distance (semitones): min={min(dists)} max={max(dists)} mean={np.mean(dists):.1f}")

    by_instr = {}
    for fp in all_fp:
        by_instr.setdefault(fp["instrument"], []).append(fp)
    print("\nFP by instrument:")
    for instr, rows in by_instr.items():
        a = [r["played_amplitude"] for r in rows if r["played_amplitude"] is not None]
        d = [r["played_duration_sec"] for r in rows]
        print(f"  {instr}: n={len(rows)} amplitude mean={np.mean(a):.3f} duration mean={np.mean(d):.3f}")

    print("\n=== True positives: 6 verified wrong_pitch injections ===")
    manifest = json.loads((HERE / "injected_cases" / "manifest.json").read_text())
    injected_events = json.loads((HERE / "injected_cases" / "basic_pitch_events.json").read_text())
    all_tp = []
    for case in manifest:
        pid = case["piece"]
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        events = injected_events[str(case["case"])]

        audio, sr = sf.read(Path(case["wav_path"]))
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
        result = detect_wrong_notes(na, alignment, events)

        label = next(g for g in load_rows(DATA / "musicnet_metadata.csv") if g["id"] == pid)
        from benchmark_full_pipeline import load_ground_truth_with_end_sec
        ground_truth = load_ground_truth_with_end_sec(DATA / "labels" / f"{pid}.csv")
        nearest = min(ground_truth, key=lambda r: abs(r["onset_sec"] - case["onset_sec"]))
        target_idx = int(np.argmin(np.abs(na["onset_beat"] - nearest["start_beat"])))
        target_note = result["notes"][target_idx]
        target_note["piece"] = pid
        target_note["instrument"] = instrument
        target_note["measure"] = measure_of(na, score_dict, beats_per_measure, target_idx)
        target_note["case"] = case["case"]
        all_tp.append(target_note)
        print(f"case {case['case']} (piece {pid}, {instrument}, measure {target_note['measure']}): "
              f"verdict={target_note['verdict']} amplitude={target_note.get('played_amplitude')} "
              f"duration={target_note.get('played_duration_sec'):.3f}s "
              f"pitch_dist={target_note.get('pitch_distance_semitones')} "
              f"onset={target_note.get('played_onset_sec'):.2f}s")

    tp_amps = [t["played_amplitude"] for t in all_tp if t["played_amplitude"] is not None]
    tp_durs = [t["played_duration_sec"] for t in all_tp]
    print(f"\nTP amplitude: {sorted(tp_amps)}")
    print(f"TP duration (s): {sorted(tp_durs)}")

    print("\n=== Separation check (TP vs FP, development data) ===")
    print(f"TP amplitude range: [{min(tp_amps):.3f}, {max(tp_amps):.3f}], "
          f"FP amplitude 10th/50th/90th pct: "
          f"{np.percentile(amps, 10):.3f}/{np.percentile(amps, 50):.3f}/{np.percentile(amps, 90):.3f}")
    print(f"TP duration range: [{min(tp_durs):.3f}, {max(tp_durs):.3f}]s, "
          f"FP duration 10th/50th/90th pct: "
          f"{np.percentile(durs, 10):.3f}/{np.percentile(durs, 50):.3f}/{np.percentile(durs, 90):.3f}s")


if __name__ == "__main__":
    main()
