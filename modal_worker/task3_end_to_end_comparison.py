"""
"MEDIANT — Score-Conditioned Audio Verification Feasibility" sprint, Task 3.

End-to-end comparison of three conditions on the SAME 8 dev pieces used by
Task 1 (Parangonar alignment) and Task 2 (frame-level verifier), so every
number in this file is apples-to-apples on one sample — unlike this
session's older "0/18 recall, 9/18 FP" figures, which were measured on a
different (larger, 18-piece held-out) set and are only used here as
reference, not as the primary comparison baseline:

  A. PRODUCTION — the real `find_wrong_note_candidates`, fed by the real
     production chain (`run_pitch_tracking` -> `dtw_align_to_score`), run
     fresh on these same 8 pieces for a genuine same-sample baseline.
  B. NON-ORACLE (Task 2, reused not rerun) — Task 2's frame-level verifier,
     anchored by Task 1's real Parangonar alignment. Numbers below are
     copied from Task 2's own commit (`09b8039`), not recomputed — rerunning
     an already-validated, deterministic result would cost real CPU time for
     zero new information.
  C. ORACLE — the SAME frame-level verifier (`verify_note`/`note_window`,
     imported unchanged from Task 2's file), but anchored by MusicNet's own
     ground-truth note timing instead of Parangonar's predicted alignment.
     This isolates how much of Task 2's false-positive problem is the
     ALIGNMENT (replaced here by perfect timing) vs. the VERIFIER ITSELF
     (unchanged). If oracle FP is still high, the verifier's CREPE-transition-
     frame problem (identified in Task 2) is confirmed as the dominant cause,
     independent of alignment quality.

Score-note <-> ground-truth-note correspondence is NOT by list index — a
real check this task ran first found index counts differ on 7/8 pieces
(e.g. 2217: 928 score notes vs 1007 ground-truth notes; only 2202 matches
exactly), almost certainly ties/ornaments in the real performance that
the score's note_array doesn't represent 1:1. Matching is therefore done
by nearest `onset_beat` (score) to `start_beat` (ground truth) — the same
beat-timeline convention `inject_mistake_verified` already uses to find a
note's measure, not a new invention.

Held-out integrity: dev pieces only (2202/2203/2217/2221/2288/2293/2294/
2295), same set as Task 1/2. The frozen 6-piece set is NOT touched.

No production code touched. `worker.py` imported and called, never
modified.

RESULTS (measured 2026-11-01, real MusicNet audio, same 8 dev pieces,
7211-7387 notes depending on condition's own denominator):

**False positives, unmodified correct audio:**

    condition               pieces flagged    note-level FP
    production              3/8 (37.5%)       8 total flags / ~7211-7387 notes (~0.1%)
    non-oracle verifier     8/8 (100%)        2060/7211 (28.57%)
    oracle verifier         8/8 (100%)        4085/7387 (55.30%)

Production is dramatically cleaner than either verifier condition on
this same sample — not just better than the non-oracle condition
Task 2 already flagged as worse-than-production, but by a wide margin.

**The oracle condition is WORSE than non-oracle, not better — the key
finding of this task.** Giving the verifier PERFECT ground-truth timing
nearly doubled its note-level false-positive rate (28.57% -> 55.30%)
instead of fixing it. This rules out "Parangonar's alignment error" as
the cause of Task 2's false-positive problem and confirms Task 2's own
diagnosis: the issue is intrinsic to the frame-level verification
method, not the alignment anchoring it. Plausible mechanism (not
confirmed further here, per "no unbounded architecture search"):
MusicNet's ground-truth onset lands exactly at the note's nominal start
— right at the attack transient / legato overlap with the previous
note, precisely where CREPE's own pitch-tracking continuity is least
reliable (the mechanism Task 2 already identified). Parangonar's
alignment, imperfect as it is, is itself derived from fitting to
acoustic stability in the real audio, so its predicted times may
incidentally land closer to a note's stable sustain than the
mathematically "correct" onset instant does — accidentally dodging some
of the boundary noise that oracle timing walks straight into.

**Recall, same 2 verified wrong_pitch injections as Task 2 (2288, 2294):**

    production:            0/2
    non-oracle verifier:    2/2
    oracle verifier:        2/2

Production misses both cases the frame-level verifier (either
condition) catches — consistent with, not new evidence beyond, this
session's already-established 0/18 production recall finding. The
frame-level approach has a genuine, real detection-capability advantage
in principle. It comes at a false-positive cost between ~280x
(non-oracle) and ~550x (oracle) production's own false-positive rate on
this sample, measured on the exact same audio.

See Task 4 (AGENT_TASKS.md / AUDIO_PIPELINE_AUDIT.md) for the resulting
GO/STOP decision.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import soundfile as sf
import partitura as pt
import parangonar as pa

import worker as w
from validate_alignment_against_musicnet import load_rows
from benchmark_full_pipeline import load_ground_truth_with_end_sec
from inject_audio_mistakes import inject_mistake_verified
from score_conditioned_verification_prototype import (
    DEV_PIECES, DATA, SCORES, crepe_frames, verify_note, note_window,
)

# Task 2's own measured non-oracle results (commit 09b8039) — reused, not
# rerun. piece -> (false_positives_notewise, n_notes) from the
# neighbor-bounded run (the version actually shipped in Task 2);
# injection validity/detection from the same run.
TASK2_NON_ORACLE_FP = {
    "2202": (399, 1022), "2203": (302, 891), "2217": (341, 928),
    "2221": (254, 872), "2288": (153, 761), "2293": (212, 789),
    "2294": (211, 1046), "2295": (188, 902),
}
TASK2_NON_ORACLE_RECALL = {  # piece -> detected (None = no valid injection)
    "2202": None, "2203": None, "2217": None, "2221": None,
    "2288": True, "2293": None, "2294": True, "2295": None,
}


def production_fp(piece_id: str, instrument: str, score_dict: dict, beats_per_measure: int) -> list[str]:
    wav_bytes = (DATA / "audio" / f"{piece_id}.wav").read_bytes()
    events = w.run_pitch_tracking(wav_bytes, instrument=instrument)
    aligned = w.dtw_align_to_score(events, score_dict, start_measure=1, beats_per_measure=beats_per_measure)
    return w.find_wrong_note_candidates(aligned, score_dict, instrument=instrument)


def production_recall(injected_wav_bytes: bytes, instrument: str, score_dict: dict,
                       beats_per_measure: int, target_measure: int) -> tuple[list[str], bool]:
    events = w.run_pitch_tracking(injected_wav_bytes, instrument=instrument)
    aligned = w.dtw_align_to_score(events, score_dict, start_measure=1, beats_per_measure=beats_per_measure)
    flags = w.find_wrong_note_candidates(aligned, score_dict, instrument=instrument)
    # Flag format: "wrong_note | measure {N} | CREPE detected ... score has ..."
    detected = any(f"measure {target_measure} |" in fl for fl in flags)
    return flags, detected


def oracle_fp(wav_bytes: bytes, instrument: str, na, ground_truth: list[dict]) -> dict:
    frame_times, pitch_np, conf_np = crepe_frames(wav_bytes, instrument)
    n = len(ground_truth)
    onset_beats = na["onset_beat"]

    false_positives = 0
    unverifiable = 0
    correct = 0
    for i, g in enumerate(ground_truth):
        idx = int(np.argmin(np.abs(onset_beats - g["start_beat"])))
        expected_midi = float(na[idx]["pitch"])
        t = g["onset_sec"]
        prev_t = ground_truth[i - 1]["onset_sec"] if i > 0 else None
        next_t = ground_truth[i + 1]["onset_sec"] if i + 1 < n else None
        ws, we = note_window(t, prev_t, next_t)
        v = verify_note(frame_times, pitch_np, conf_np, expected_midi, ws, we)
        if v["verdict"] == "wrong_note":
            false_positives += 1
        elif v["verdict"] == "unverifiable":
            unverifiable += 1
        else:
            correct += 1
    return {"n_notes": n, "false_positives": false_positives,
            "unverifiable": unverifiable, "correct": correct}


def oracle_recall(injected_wav_bytes: bytes, instrument: str, ground_truth: list[dict],
                   injected: dict) -> dict:
    frame_times, pitch_np, conf_np = crepe_frames(injected_wav_bytes, instrument)
    idx = min(range(len(ground_truth)),
              key=lambda i: abs(ground_truth[i]["onset_sec"] - injected["onset_sec"]))
    t = ground_truth[idx]["onset_sec"]
    prev_t = ground_truth[idx - 1]["onset_sec"] if idx > 0 else None
    next_t = ground_truth[idx + 1]["onset_sec"] if idx + 1 < len(ground_truth) else None
    ws, we = note_window(t, prev_t, next_t)
    expected_midi = float(injected["original_note"])
    v = verify_note(frame_times, pitch_np, conf_np, expected_midi, ws, we)
    return {"detected": v["verdict"] == "wrong_note", "verdict": v["verdict"], "reason": v["reason"]}


def main():
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}

    print("=== Part A: production detector, false positives (unmodified audio) ===")
    prod_fp_pieces_flagged = 0
    prod_fp_total_flags = 0
    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        flags = production_fp(pid, instrument, score_dict, beats_per_measure)
        if flags:
            prod_fp_pieces_flagged += 1
        prod_fp_total_flags += len(flags)
        print(f"{pid} ({instrument}): {len(flags)} flag(s) -- {flags}")
    print(f"\nProduction FP summary: {prod_fp_pieces_flagged}/{len(DEV_PIECES)} pieces "
          f"had >=1 false flag, {prod_fp_total_flags} total flags")

    print("\n=== Part B: oracle-timing frame-level verifier, false positives ===")
    oracle_fp_pieces_flagged = 0
    oracle_fp_results = []
    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        label = DATA / "labels" / f"{pid}.csv"
        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        ground_truth = load_ground_truth_with_end_sec(label)
        wav_bytes = (DATA / "audio" / f"{pid}.wav").read_bytes()
        r = oracle_fp(wav_bytes, instrument, na, ground_truth)
        oracle_fp_results.append(r)
        if r["false_positives"] > 0:
            oracle_fp_pieces_flagged += 1
        print(f"{pid} ({instrument}): notes={r['n_notes']} "
              f"false_positives={r['false_positives']} "
              f"unverifiable={r['unverifiable']} correct={r['correct']}")
    total_notes = sum(r["n_notes"] for r in oracle_fp_results)
    total_fp = sum(r["false_positives"] for r in oracle_fp_results)
    print(f"\nOracle FP summary: {oracle_fp_pieces_flagged}/{len(DEV_PIECES)} pieces "
          f"had >=1 false flag; {total_fp}/{total_notes} notes false-flagged "
          f"({100.0 * total_fp / total_notes:.2f}%)")

    print("\n=== Part C: recall (production vs oracle verifier), same verified injections as Task 2 ===")
    recall_rows = []
    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        label = DATA / "labels" / f"{pid}.csv"
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        ground_truth = load_ground_truth_with_end_sec(label)
        wav_bytes_orig = (DATA / "audio" / f"{pid}.wav").read_bytes()

        inj = inject_mistake_verified(wav_bytes_orig, ground_truth, score_dict,
                                       beats_per_measure, instrument, base_seed=int(pid))
        if not inj["valid"]:
            print(f"{pid}: no valid injection (same as Task 2 -- skipped)")
            continue

        injected = inj["result"]["injected"]
        injected_wav_bytes = inj["result"]["wav_bytes"]
        target_measure = injected["measure"]

        prod_flags, prod_detected = production_recall(
            injected_wav_bytes, instrument, score_dict, beats_per_measure, target_measure)
        oracle_result = oracle_recall(injected_wav_bytes, instrument, ground_truth, injected)

        recall_rows.append({"piece": pid, "prod_detected": prod_detected,
                             "oracle_detected": oracle_result["detected"],
                             "non_oracle_detected": TASK2_NON_ORACLE_RECALL.get(pid)})
        print(f"{pid}: original={injected['original_note']} new={injected['new_note']} "
              f"measure={target_measure} | production_detected={prod_detected} "
              f"(flags={prod_flags}) | oracle_verifier_detected={oracle_result['detected']} "
              f"({oracle_result['reason']}) | non_oracle(Task2)_detected={TASK2_NON_ORACLE_RECALL.get(pid)}")

    n_cases = len(recall_rows)
    prod_hits = sum(1 for r in recall_rows if r["prod_detected"])
    oracle_hits = sum(1 for r in recall_rows if r["oracle_detected"])
    non_oracle_hits = sum(1 for r in recall_rows if r["non_oracle_detected"])
    print(f"\nRecall summary over {n_cases} verified injections: "
          f"production {prod_hits}/{n_cases}, "
          f"non-oracle verifier (Task 2) {non_oracle_hits}/{n_cases}, "
          f"oracle verifier {oracle_hits}/{n_cases}")

    print("\n=== Summary table (piece-level FP comparison) ===")
    non_oracle_pieces_flagged = sum(1 for pid in DEV_PIECES if TASK2_NON_ORACLE_FP[pid][0] > 0)
    non_oracle_total_fp = sum(v[0] for v in TASK2_NON_ORACLE_FP.values())
    non_oracle_total_notes = sum(v[1] for v in TASK2_NON_ORACLE_FP.values())
    print(f"Production:            {prod_fp_pieces_flagged}/{len(DEV_PIECES)} pieces flagged "
          f"(piece-level; note-level denominator not directly comparable -- see writeup)")
    print(f"Non-oracle (Task 2):   {non_oracle_pieces_flagged}/{len(DEV_PIECES)} pieces flagged, "
          f"{non_oracle_total_fp}/{non_oracle_total_notes} notes "
          f"({100.0*non_oracle_total_fp/non_oracle_total_notes:.2f}%)")
    print(f"Oracle:                {oracle_fp_pieces_flagged}/{len(DEV_PIECES)} pieces flagged, "
          f"{total_fp}/{total_notes} notes ({100.0*total_fp/total_notes:.2f}%)")


if __name__ == "__main__":
    main()
