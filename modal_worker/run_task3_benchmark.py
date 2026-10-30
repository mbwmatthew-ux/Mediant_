"""
Task 3 real-data aggregation/reporting layer for docs/superpowers/plans/
2026-10-30-audio-pipeline-benchmark.md.

benchmark_full_pipeline.run_free_legs (committed separately) defines the
per-case free-leg (CREPE + DTW) chain against ONE injected mistake. This
script is the layer the brief's Step 6 only sketched: it loads the real
MusicNet cache, splits pieces into a dev set (mechanical sanity-check
only, never scored) and a held-out set, runs FOUR conditions per
held-out piece (wrong_pitch / deleted_note / duplicated_note injections,
plus an uninjected "control"), and prints detection / localization /
false-positive metrics overall, per mistake type, and per instrument.

Real data location note: the brief and the project's own earlier session
note (Sessions/2026-10-11 (2) -- MusicNet score-alignment validation.md)
both say the cache lives at /tmp/musicnet_data/. That path does not exist
on this machine right now (likely wiped by a reboot -- /tmp is not
persistent on macOS). The SAME 24-piece cache (midis/, audio/, labels/,
musicnet_metadata.csv, same ids, same file layout
validate_alignment_against_musicnet.py expects) was found instead at
/Users/matthewwu/.cache/mediant_validation/data -- a persistent cache
directory from the same earlier validation session. This is real,
previously-downloaded MusicNet data, not a substitute or re-download;
see task-3-report.md for the full account.

Does NOT modify worker.py and does NOT touch CREPE/DTW tuning --
w.run_pitch_tracking / w.dtw_align_to_score are called completely
unmodified, purely to measure them.
"""
import csv
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402
from validate_alignment_against_musicnet import (  # noqa: E402
    midi_score_to_dict, load_ground_truth, load_rows, calibrate_assumptions)
from inject_audio_mistakes import inject_mistake  # noqa: E402

DATA_DIR = Path("/Users/matthewwu/.cache/mediant_validation/data")

# Mechanical sanity-check pieces only -- picked before any scoring, NEVER
# included in the reported held-out numbers. 2186 (Solo Violin) is the
# piece the brief's own unit test already references; 2219 (Solo Cello)
# is one of the "clean" 83-95%-correct pieces from the earlier alignment
# validation session, useful for confirming the runner's plumbing works
# on a piece that isn't already a known pathological case.
DEV_IDS = {"2186", "2219"}

MISTAKE_TYPES = ["wrong_pitch", "deleted_note", "duplicated_note"]

# Same proximity window run_free_legs uses to decide whether DTW's
# aligned output has "something" near a given onset time.
DETECT_WINDOW_SEC = 0.3

MUSICNET_SR = 44100


def load_ground_truth_with_end_sec(label_csv_path: Path) -> list[dict]:
    """
    validate_alignment_against_musicnet.load_ground_truth gives onset_sec/
    note/start_beat but deliberately not end_sec (it never needed it).
    inject_mistake requires end_sec to know each note's audio window.
    Reads MusicNet's own end_time column directly (same sample-index-at-
    44100Hz convention start_time already uses) rather than modifying the
    existing, already-validated loader.
    """
    rows = []
    with open(label_csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rows.append({
                "onset_sec": int(row["start_time"]) / MUSICNET_SR,
                "end_sec": int(row["end_time"]) / MUSICNET_SR,
                "note": int(row["note"]),
                "start_beat": float(row["start_beat"]),
            })
    rows.sort(key=lambda r: r["onset_sec"])
    return rows


def true_measure_for_onset(onset_sec: float, ground_truth: list[dict], beats_per_measure: int) -> int:
    nearest = min(ground_truth, key=lambda r: abs(r["onset_sec"] - onset_sec))
    return int(nearest["start_beat"] // beats_per_measure) + 1


def run_one_condition(piece_id: str, instrument: str, score: dict, ground_truth: list[dict],
                       beats_per_measure: int, wav_bytes: bytes, condition: str,
                       rng_seed: int = 0) -> dict:
    """
    One of the 4 conditions for one piece: condition is "wrong_pitch",
    "deleted_note", "duplicated_note", or "control" (no injection at
    all -- the original audio run through the identical chain).

    For the 3 injected conditions, inject_mistake's target-note draw
    (rng.integers(0, len(ground_truth))) happens BEFORE its mistake_type
    branch, so for the same rng_seed it picks the SAME target note
    regardless of mistake_type -- confirmed by reading
    inject_audio_mistakes.inject_mistake. That means, per piece, all 3
    injected conditions probe the same timestamp; "control" reuses that
    same timestamp as the location to check for a false alarm, without
    ever calling inject_mistake (so the control audio is byte-identical
    to the original).
    """
    if condition == "control":
        rng = np.random.default_rng(rng_seed)
        target = ground_truth[int(rng.integers(0, len(ground_truth)))]
        probe_onset = target["onset_sec"]
        run_wav_bytes = wav_bytes
        injected = {"mistake_type": "control", "onset_sec": probe_onset,
                    "offset_sec": target["end_sec"], "original_note": target["note"],
                    "new_note": None}
    else:
        result = inject_mistake(wav_bytes, ground_truth, condition, rng_seed)
        run_wav_bytes = result["wav_bytes"]
        injected = result["injected"]
        probe_onset = injected["onset_sec"]

    true_measure = true_measure_for_onset(probe_onset, ground_truth, beats_per_measure)

    events = w.run_pitch_tracking(run_wav_bytes, instrument=instrument)
    aligned = w.dtw_align_to_score(events, score, start_measure=1,
                                    beats_per_measure=beats_per_measure)

    detected_at_measure = None
    for ev in aligned:
        if abs(ev["time_sec"] - probe_onset) < DETECT_WINDOW_SEC:
            detected_at_measure = ev.get("measure")
            break

    return {
        "piece_id": piece_id, "instrument": instrument, "condition": condition,
        "injected": injected, "probe_onset": probe_onset,
        "detected_at_measure": detected_at_measure, "true_measure": true_measure,
        "detected": detected_at_measure is not None,
        "localization_correct": detected_at_measure == true_measure,
        "cost_dollars": 0.0,
    }


def load_piece(piece_id: str) -> tuple[dict, list[dict], bytes, int]:
    score = midi_score_to_dict(DATA_DIR / "midis" / f"{piece_id}.mid")
    ground_truth = load_ground_truth_with_end_sec(DATA_DIR / "labels" / f"{piece_id}.csv")
    wav_bytes = (DATA_DIR / "audio" / f"{piece_id}.wav").read_bytes()
    beats_per_measure = w.beats_per_measure_from_time_sig(score.get("time_signature") or "4/4")
    return score, ground_truth, wav_bytes, beats_per_measure


def main():
    rows = {r["id"]: r for r in load_rows(DATA_DIR / "musicnet_metadata.csv")}
    available_ids = sorted(
        pid for pid in rows
        if (DATA_DIR / "midis" / f"{pid}.mid").exists()
        and (DATA_DIR / "audio" / f"{pid}.wav").exists()
        and (DATA_DIR / "labels" / f"{pid}.csv").exists()
    )
    print(f"[task3] {len(available_ids)} solo pieces available in {DATA_DIR}")

    dev_ids = [pid for pid in available_ids if pid in DEV_IDS]
    candidate_ids = [pid for pid in available_ids if pid not in DEV_IDS]
    print(f"[task3] dev (never scored): {dev_ids}")
    print(f"[task3] candidate held-out pool: {candidate_ids}")

    # ---- Dev pass: mechanical sanity check only, not scored ----
    print("\n[task3] === DEV SANITY CHECK (not scored) ===")
    for pid in dev_ids:
        score, ground_truth, wav_bytes, bpm = load_piece(pid)
        label = f"{pid} ({rows[pid]['instrument']})"
        if not calibrate_assumptions(score, ground_truth, bpm, label):
            print(f"  [dev] {label}: calibrate_assumptions failed (informational only, dev piece)")
            continue
        for condition in MISTAKE_TYPES + ["control"]:
            r = run_one_condition(pid, rows[pid]["instrument"], score, ground_truth, bpm,
                                   wav_bytes, condition)
            print(f"  [dev] {label} {condition:15s} detected={r['detected']!s:5s} "
                  f"true_measure={r['true_measure']} detected_at={r['detected_at_measure']} "
                  f"localization_correct={r['localization_correct']}")

    # ---- calibrate_assumptions exclusion, same check the earlier
    # validation session used, applied identically here ----
    held_out_ids = []
    excluded = []
    print("\n[task3] === CALIBRATION CHECK ON CANDIDATE HELD-OUT POOL ===")
    piece_cache = {}
    for pid in candidate_ids:
        score, ground_truth, wav_bytes, bpm = load_piece(pid)
        label = f"{pid} ({rows[pid]['instrument']})"
        if calibrate_assumptions(score, ground_truth, bpm, label):
            held_out_ids.append(pid)
            piece_cache[pid] = (score, ground_truth, wav_bytes, bpm)
        else:
            excluded.append(pid)

    print(f"\n[task3] held-out scored set ({len(held_out_ids)}): {held_out_ids}")
    print(f"[task3] excluded by calibrate_assumptions ({len(excluded)}): {excluded}")

    # ---- Real scored run: 4 conditions x each held-out piece ----
    print("\n[task3] === HELD-OUT SCORED RUN ===")
    results = []
    for i, pid in enumerate(held_out_ids):
        score, ground_truth, wav_bytes, bpm = piece_cache[pid]
        instrument = rows[pid]["instrument"]
        for condition in MISTAKE_TYPES + ["control"]:
            r = run_one_condition(pid, instrument, score, ground_truth, bpm, wav_bytes, condition)
            results.append(r)
            print(f"  [{i+1}/{len(held_out_ids)}] {pid} ({instrument}) {condition:15s} "
                  f"detected={r['detected']!s:5s} true_measure={r['true_measure']} "
                  f"detected_at={r['detected_at_measure']} "
                  f"localization_correct={r['localization_correct']}")

    # ---- Aggregation ----
    injected_results = [r for r in results if r["condition"] != "control"]
    control_results = [r for r in results if r["condition"] == "control"]

    def pct(n, d):
        return 100.0 * n / d if d else float("nan")

    print("\n" + "=" * 78)
    print(f"OVERALL (held-out set, n={len(held_out_ids)} pieces)")
    n_det = sum(r["detected"] for r in injected_results)
    print(f"  Detection accuracy   (injected, n={len(injected_results)}): "
          f"{n_det}/{len(injected_results)} = {pct(n_det, len(injected_results)):.1f}%")
    detected_injected = [r for r in injected_results if r["detected"]]
    n_loc = sum(r["localization_correct"] for r in detected_injected)
    print(f"  Localization accuracy (of detected, n={len(detected_injected)}): "
          f"{n_loc}/{len(detected_injected)} = {pct(n_loc, len(detected_injected)):.1f}%")
    n_fp = sum(r["detected"] for r in control_results)
    print(f"  False-positive rate  (control, n={len(control_results)}): "
          f"{n_fp}/{len(control_results)} = {pct(n_fp, len(control_results)):.1f}%")
    fp_detected = [r for r in control_results if r["detected"]]
    n_fp_wrong = sum(not r["localization_correct"] for r in fp_detected)
    print(f"  Of control false-positive detections, mislocalized vs ground truth: "
          f"{n_fp_wrong}/{len(fp_detected)} = {pct(n_fp_wrong, len(fp_detected)):.1f}%")

    print("\nBY MISTAKE TYPE")
    for mt in MISTAKE_TYPES:
        mt_injected = [r for r in injected_results if r["condition"] == mt]
        mt_det = sum(r["detected"] for r in mt_injected)
        mt_detected = [r for r in mt_injected if r["detected"]]
        mt_loc = sum(r["localization_correct"] for r in mt_detected)
        # Control is run once per piece (no mistake_type-specific audio), so
        # its false-positive rate is identical across the 3 mistake types at
        # a given piece by construction -- reuse control_results as-is.
        n_fp_mt = sum(r["detected"] for r in control_results)
        print(f"  {mt:16s} detection={mt_det}/{len(mt_injected)} ({pct(mt_det, len(mt_injected)):.1f}%)  "
              f"localization(of detected)={mt_loc}/{len(mt_detected)} ({pct(mt_loc, len(mt_detected)):.1f}%)  "
              f"FP(shared control)={n_fp_mt}/{len(control_results)} ({pct(n_fp_mt, len(control_results)):.1f}%)")
    print("  NOTE: control condition is run once per piece (no injection to vary across\n"
          "  mistake types, since inject_mistake's target-note draw is identical for all\n"
          "  3 types at rng_seed=0), so the false-positive rate above is identical for\n"
          "  all 3 mistake types -- see report for why.")

    print("\nBY INSTRUMENT")
    instruments = sorted(set(r["instrument"] for r in injected_results))
    for inst in instruments:
        inst_injected = [r for r in injected_results if r["instrument"] == inst]
        inst_control = [r for r in control_results if r["instrument"] == inst]
        inst_det = sum(r["detected"] for r in inst_injected)
        inst_detected = [r for r in inst_injected if r["detected"]]
        inst_loc = sum(r["localization_correct"] for r in inst_detected)
        inst_fp = sum(r["detected"] for r in inst_control)
        n_pieces_inst = len(set(r["piece_id"] for r in inst_injected))
        print(f"  {inst:10s} n_pieces={n_pieces_inst}  "
              f"detection={inst_det}/{len(inst_injected)} ({pct(inst_det, len(inst_injected)):.1f}%)  "
              f"localization(of detected)={inst_loc}/{len(inst_detected)} ({pct(inst_loc, len(inst_detected)):.1f}%)  "
              f"FP={inst_fp}/{len(inst_control)} ({pct(inst_fp, len(inst_control)):.1f}%)")

    print("\nPER-PIECE DETAIL")
    for pid in held_out_ids:
        piece_results = [r for r in results if r["piece_id"] == pid]
        parts = []
        for r in piece_results:
            label = r["condition"]
            parts.append(f"{label}:det={r['detected']},loc_ok={r['localization_correct']}")
        print(f"  {pid} ({rows[pid]['instrument']}): " + "  ".join(parts))

    print("=" * 78)


if __name__ == "__main__":
    main()
