"""
P0 Audio Detector Reliability Sprint -- Phase A (repaired benchmark) and
Phase B (one decisive diagnostic experiment: CREPE-extracted vs.
independently-annotated reference events through the unmodified
dtw_align_to_score).

Does NOT modify find_wrong_note_candidates, dtw_align_to_score, or any
other detector/alignment logic in worker.py -- those are called
completely unmodified, purely to measure them. The only new code is the
verification gate in inject_audio_mistakes.py (which benchmark cases
count as valid) and this script's measurement/reporting.

Zero paid API calls. CPU-only. Reuses the same real MusicNet cache every
prior validation round in this project used
(/Users/matthewwu/.cache/mediant_validation/data) and the same 18-piece
held-out set (2202,2203,2204,2217,2218,2220,2221,2222,2241,2242,2244,
2288,2289,2293,2294,2295,2296,2297) every prior round scored.

Usage:
    python run_p0_benchmark.py --phase a     # Phase A only
    python run_p0_benchmark.py --phase b     # Phase B only
    python run_p0_benchmark.py --phase all   # both (default)
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402
from validate_alignment_against_musicnet import (  # noqa: E402
    load_rows, midi_score_to_dict, classify_alignment)
from benchmark_full_pipeline import load_ground_truth_with_end_sec  # noqa: E402
from inject_audio_mistakes import inject_mistake_verified  # noqa: E402

DATA_DIR = Path("/Users/matthewwu/.cache/mediant_validation/data")

HELD_OUT_18 = ["2202", "2203", "2204", "2217", "2218", "2220", "2221", "2222",
               "2241", "2242", "2244", "2288", "2289", "2293", "2294", "2295",
               "2296", "2297"]

# Frozen manifest: ~1/3 of the 18, stratified by instrument (Flute 3, Cello
# 10, Violin 5 -> Flute 1, Cello 3, Violin 2 frozen), picked BEFORE any of
# this script's iterative Phase A/B development/debugging happened on the
# remaining 12. Never touched, inspected, or used while building the
# verification gate or running Phase B below -- reserved for a later,
# separate Phase D fork.
FROZEN_IDS = ["2204", "2218", "2222", "2297", "2244", "2289"]
DEV_IDS = [pid for pid in HELD_OUT_18 if pid not in FROZEN_IDS]

_MATCH_WINDOW_SEC = 0.25


def write_frozen_manifest():
    rows = {r["id"]: r for r in load_rows(DATA_DIR / "musicnet_metadata.csv")}
    manifest = {
        "description": (
            "P0 Audio Detector Reliability Sprint -- frozen evaluation subset. "
            "NOT used during Phase A/B development on this same sprint. Reserved "
            "for Phase D (final validation of any correction against the repaired "
            "benchmark). Do not use for tuning."
        ),
        "held_out_18": HELD_OUT_18,
        "frozen_ids": FROZEN_IDS,
        "dev_ids": DEV_IDS,
        "instruments": {pid: rows[pid]["instrument"] for pid in HELD_OUT_18},
    }
    out_path = Path(__file__).parent / "p0_sprint_frozen_eval_manifest.json"
    out_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"[manifest] wrote {out_path}")
    return out_path


def load_piece(piece_id: str):
    score = midi_score_to_dict(DATA_DIR / "midis" / f"{piece_id}.mid")
    ground_truth = load_ground_truth_with_end_sec(DATA_DIR / "labels" / f"{piece_id}.csv")
    wav_bytes = (DATA_DIR / "audio" / f"{piece_id}.wav").read_bytes()
    time_sig = score.get("time_signature") or "4/4"
    bpm = w.beats_per_measure_from_time_sig(time_sig)
    return score, ground_truth, wav_bytes, bpm


def flag_measures(flags: list[str]) -> set[int]:
    import re
    out = set()
    for f in flags:
        m = re.search(r"measure (\d+)", f)
        if m:
            out.add(int(m.group(1)))
    return out


# ---------------------------------------------------------------------------
# Phase A
# ---------------------------------------------------------------------------

def run_phase_a(rows: dict):
    print("\n" + "=" * 78)
    print("PHASE A -- repaired benchmark, dev pieces only (frozen set untouched)")
    print("=" * 78)

    all_attempts_log = []
    scored = []   # one entry per piece with a VALID verified injection
    unrecoverable = []  # pieces where no attempt validated within max_attempts

    for pid in DEV_IDS:
        instrument = rows[pid]["instrument"]
        score, ground_truth, wav_bytes, bpm = load_piece(pid)

        v = inject_mistake_verified(wav_bytes, ground_truth, score, bpm, instrument,
                                     base_seed=int(pid), max_attempts=8)
        all_attempts_log.append({"piece_id": pid, "instrument": instrument,
                                  "attempts": v["attempts"], "valid": v["valid"]})

        if not v["valid"]:
            unrecoverable.append(pid)
            print(f"  {pid} ({instrument}): NO valid injection found in "
                  f"{len(v['attempts'])} attempts -- excluded, not silently dropped")
            for a in v["attempts"]:
                print(f"      seed={a['seed']} measure={a['measure']} "
                      f"recognizable={a['recognizable']} unambiguous={a['unambiguous']} "
                      f"reason={a['reason']}")
            continue

        valid_attempt = next(a for a in v["attempts"] if a["valid"])
        measure_num = valid_attempt["measure"]
        aligned = valid_attempt["aligned"]  # reuse -- already computed inside verify_injection
        flags = w.find_wrong_note_candidates(aligned, score, instrument=instrument)
        detected = measure_num in flag_measures(flags)

        # Control: same piece, unmodified audio, same comparator.
        control_events = w.run_pitch_tracking(wav_bytes, instrument=instrument)
        control_aligned = w.dtw_align_to_score(control_events, score, start_measure=1, beats_per_measure=bpm)
        control_flags = w.find_wrong_note_candidates(control_aligned, score, instrument=instrument)

        n_attempts_used = len(v["attempts"])
        scored.append({
            "piece_id": pid, "instrument": instrument,
            "attempts_to_validate": n_attempts_used,
            "measure": measure_num, "detected": detected,
            "flags": flags, "control_flags": control_flags,
        })
        print(f"  {pid} ({instrument}): valid after {n_attempts_used} attempt(s), "
              f"measure={measure_num}, detected={detected}, "
              f"n_flags={len(flags)}, n_control_flags={len(control_flags)}")

    n_scored = len(scored)
    n_detected = sum(r["detected"] for r in scored)
    n_control_fp_pieces = sum(1 for r in scored if r["control_flags"])
    n_control_fp_flags = sum(len(r["control_flags"]) for r in scored)

    print("\n" + "-" * 78)
    print(f"PHASE A RESULT (dev set, n={len(DEV_IDS)} candidate pieces)")
    print(f"  Pieces with NO valid injection after 8 attempts each "
          f"(explicitly tracked, not scored): {len(unrecoverable)}/{len(DEV_IDS)} "
          f"= {unrecoverable}")
    print(f"  Pieces scored (valid injection found): {n_scored}/{len(DEV_IDS)}")
    print(f"  REPAIRED RECALL (valid injections only): {n_detected}/{n_scored} = "
          f"{100.0 * n_detected / n_scored if n_scored else float('nan'):.1f}%")
    print(f"  False-positive rate on these same pieces' unmodified controls: "
          f"{n_control_fp_pieces}/{n_scored} pieces flagged, "
          f"{n_control_fp_flags} total flags")
    by_inst = {}
    for r in scored:
        by_inst.setdefault(r["instrument"], []).append(r)
    for inst, rs in sorted(by_inst.items()):
        d = sum(r["detected"] for r in rs)
        print(f"    {inst}: {d}/{len(rs)} recall")
    print("-" * 78)

    return {
        "unrecoverable": unrecoverable, "scored": scored,
        "n_scored": n_scored, "n_detected": n_detected,
        "attempts_log": all_attempts_log,
    }


# ---------------------------------------------------------------------------
# Phase B
# ---------------------------------------------------------------------------

def midi_to_name_safe(midi: int) -> str:
    return w.midi_to_scientific(midi)


def build_ground_truth_events(ground_truth: list[dict]) -> list[dict]:
    """
    One clean, 'perfect' synthetic CREPE-shaped event per ground-truth
    MusicNet note: confident, pitch-stable, non-probe (so
    _cluster_sustained_events never collapses any of them), in the exact
    event-dict shape dtw_align_to_score/_cluster_sustained_events reads
    (worker.py run_pitch_tracking's own event construction). Bypasses
    CREPE pitch/onset extraction entirely -- this is Condition B.
    """
    events = []
    for g in sorted(ground_truth, key=lambda r: r["onset_sec"]):
        dur = max(0.05, g["end_sec"] - g["onset_sec"])
        events.append({
            "from_probe": False,
            "time_sec": g["onset_sec"],
            "end_sec": g["end_sec"],
            "sound_end": g["end_sec"],
            "held_sec": round(dur, 3),
            "stable_sec": round(dur, 3),
            "pitches": [midi_to_name_safe(g["note"])],
            "midi": g["note"],
            "midi_raw": g["note"],
            "pitch_hz": 440.0 * (2 ** ((g["note"] - 69) / 12)),
            "cents_offset": 0,
            "cents_spread": 0,
            "confidence": 100,
            "loudness": -20.0,
            "db": -20.0,
            "centroid_hz": None,
            "flatness": 0.01,
            "centroid_ratio": None,
            "source": "ground_truth",
        })
    return events


def localization_accuracy(aligned: list[dict], ground_truth: list[dict], bpm: int) -> dict:
    counts = {"correct": 0, "off_by_one": 0, "wrong": 0, "unmatched": 0}
    for ev in aligned:
        t = ev.get("time_sec")
        if t is None:
            counts["unmatched"] += 1
            continue
        best = min(ground_truth, key=lambda g: abs(g["onset_sec"] - t))
        true_measure = (int(best["start_beat"] // bpm) + 1
                         if abs(best["onset_sec"] - t) <= _MATCH_WINDOW_SEC else None)
        counts[classify_alignment(ev.get("measure"), true_measure)] += 1
    return counts


def pct(counts: dict, key: str) -> float:
    total = sum(counts.values())
    return 100.0 * counts.get(key, 0) / total if total else float("nan")


def run_phase_b(rows: dict):
    print("\n" + "=" * 78)
    print("PHASE B -- CREPE-extracted (Condition A) vs. ground-truth events "
          "(Condition B) through the SAME unmodified dtw_align_to_score")
    print("=" * 78)

    cond_a_total = {"correct": 0, "off_by_one": 0, "wrong": 0, "unmatched": 0}
    cond_b_total = {"correct": 0, "off_by_one": 0, "wrong": 0, "unmatched": 0}
    per_piece = []

    for pid in DEV_IDS:
        instrument = rows[pid]["instrument"]
        score, ground_truth, wav_bytes, bpm = load_piece(pid)

        # Condition A: real pipeline, exactly as production uses it.
        events_a = w.run_pitch_tracking(wav_bytes, instrument=instrument)
        aligned_a = w.dtw_align_to_score(events_a, score, start_measure=1, beats_per_measure=bpm)
        counts_a = localization_accuracy(aligned_a, ground_truth, bpm) if aligned_a else \
            {"correct": 0, "off_by_one": 0, "wrong": 0, "unmatched": 1}

        # Condition B: independently-annotated reference note events,
        # same score, same dtw_align_to_score call, nothing else changed.
        events_b = build_ground_truth_events(ground_truth)
        aligned_b = w.dtw_align_to_score(events_b, score, start_measure=1, beats_per_measure=bpm)
        counts_b = localization_accuracy(aligned_b, ground_truth, bpm) if aligned_b else \
            {"correct": 0, "off_by_one": 0, "wrong": 0, "unmatched": 1}

        for k in cond_a_total:
            cond_a_total[k] += counts_a[k]
            cond_b_total[k] += counts_b[k]

        per_piece.append({"piece_id": pid, "instrument": instrument,
                           "cond_a": counts_a, "cond_b": counts_b})
        print(f"  {pid} ({instrument}): "
              f"A correct={pct(counts_a,'correct'):5.1f}% (n={sum(counts_a.values())})  "
              f"B correct={pct(counts_b,'correct'):5.1f}% (n={sum(counts_b.values())})")

    print("\n" + "-" * 78)
    print(f"PHASE B RESULT (dev set, n={len(DEV_IDS)} pieces)")
    print(f"  Condition A (CREPE-extracted) correct: {cond_a_total['correct']}/"
          f"{sum(cond_a_total.values())} = {pct(cond_a_total,'correct'):.1f}%")
    print(f"  Condition B (ground-truth events) correct: {cond_b_total['correct']}/"
          f"{sum(cond_b_total.values())} = {pct(cond_b_total,'correct'):.1f}%")
    gap = pct(cond_b_total, "correct") - pct(cond_a_total, "correct")
    print(f"  Gap (B - A): {gap:+.1f} points")
    if pct(cond_b_total, "correct") >= 90.0 and gap >= 15.0:
        verdict = ("DOMINANT FAILURE: CREPE pitch/onset extraction / event "
                   "consolidation quality. DTW handles near-perfect observations well.")
    elif pct(cond_b_total, "correct") < 90.0:
        verdict = ("DOMINANT FAILURE: the DTW alignment algorithm itself has a "
                   "defect independent of input noise -- even near-perfect "
                   "observations don't localize well.")
    else:
        verdict = ("Both conditions localize well; a persistent wrong-note recall "
                   "problem would point downstream, to the comparator/filtering stage.")
    print(f"  VERDICT: {verdict}")
    print("-" * 78)

    return {"cond_a_total": cond_a_total, "cond_b_total": cond_b_total,
            "per_piece": per_piece, "verdict": verdict}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", choices=["a", "b", "all"], default="all")
    args = ap.parse_args()

    write_frozen_manifest()
    rows = {r["id"]: r for r in load_rows(DATA_DIR / "musicnet_metadata.csv")}

    if args.phase in ("a", "all"):
        run_phase_a(rows)
    if args.phase in ("b", "all"):
        run_phase_b(rows)


if __name__ == "__main__":
    main()
