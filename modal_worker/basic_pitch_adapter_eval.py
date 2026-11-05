"""
"MEDIANT — Basic Pitch wrong-note detection integration" (2026-11-04),
Task 3: measure the adapter's real wrong-note detection, oracle and
non-oracle, against production, on the SAME 6 verified injections and
8 unmodified control pieces used in the prior round -- nothing new
manufactured.

Non-oracle: pa.AudioToScoreMatcher's real alignment (the condition that
decides GO/STOP). Oracle: MusicNet's own ground-truth onset times used
directly in place of alignment -- a diagnostic ONLY, to separate
"the adapter's distance-gate logic is broken" from "the alignment
itself is imperfect".

Per the directive: raw counts are reported, not an extrapolated
accuracy percentage -- n=6 positive cases and n=8 control pieces are
both too small to generalize from, and are reported as such.

No production code touched.

RESULTS (measured 2026-11-04). Per the directive: raw counts, not an
extrapolated percentage -- n=6 and n=8 are both too small to generalize.

**Negative/control cases (8 unmodified dev pieces, 7211 notes):**

    condition                pieces flagged   note-level FP
    non-oracle (real align)  8/8              432/7211 (5.99%)
    oracle (diagnostic)      8/8              470/7211 (6.52%)
    production (same 8)      3/8              8/~7211 (~0.11%)

Oracle and non-oracle are CLOSE (5.99% vs 6.52%) -- unlike the prior
round's frame-level verifier, where oracle timing nearly doubled the
false-positive rate. This is itself informative: the false positives
here are not primarily an alignment-timing artifact; they trace mostly
to genuine Basic Pitch extraction noise within each note's search
window (consistent with Basic Pitch's own measured note precision of
0.796, i.e. ~20% of its notes are themselves wrong even before any
detection logic runs). 1542 Basic Pitch events across the 8 pieces were
never claimed by any score note's window ("insertions") -- reported,
not dropped.

**Positive cases (6 verified `wrong_pitch` injections, RAW COUNTS):**

    recall (non-oracle, the GO/STOP number):  6/6
    recall (oracle, diagnostic only):          6/6
    production's recall on the SAME 6 cases:   0/6
    measure localization among detections:     6/6 (by construction --
      the adapter is anchored directly to the score note index)

Every detected case also carried 14-82 OTHER substitution flags in the
SAME take (consistent with the ~6% note-level FP rate above) -- the
true positive is never isolated; it arrives inside real noise.

**Latency**: alignment (`AudioToScoreMatcher`) ~0.9-6.1s/piece
(dominated by Parangonar's own spectrogram+DP, same cost already
measured in Task 1 of the prior round), detection logic itself ~3ms/
piece (pure numpy, negligible). **Memory**: peak traced Python memory
for one full alignment+detection pass, piece 2288: 351.0 MB.
"""
import json
import sys
import time
import tracemalloc
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import soundfile as sf
import partitura as pt
import parangonar as pa

import worker as w
from validate_alignment_against_musicnet import load_rows
from benchmark_full_pipeline import load_ground_truth_with_end_sec
from basic_pitch_score_adapter import detect_wrong_notes

HERE = Path(__file__).parent
DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORES = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")
DEV_PIECES = ["2202", "2203", "2217", "2221", "2288", "2293", "2294", "2295"]


def oracle_alignment(na, ground_truth):
    """One dict per score note, pitch-blind, same shape as
    AudioToScoreMatcher's output but using ground-truth onset_sec
    directly (nearest ground-truth note by onset_beat) instead of real
    alignment -- diagnostic only."""
    alignment = []
    for note in na:
        nearest = min(ground_truth, key=lambda g: abs(g["start_beat"] - note["onset_beat"]))
        alignment.append({"label": "match", "score_id": None, "performance_time": nearest["onset_sec"]})
    return alignment


def measure_localization_ok(na, score_dict, beats_per_measure, score_idx, true_measure) -> bool:
    onset_beat = float(na[score_idx]["onset_beat"])
    predicted_measure = int(onset_beat // beats_per_measure) + 1
    return predicted_measure == true_measure


def main():
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    matcher = pa.AudioToScoreMatcher()

    bp_data = json.loads((HERE / "basic_pitch_events.json").read_text())

    print("=== Negative/control cases: 8 unmodified dev pieces (non-oracle + oracle FP) ===")
    non_oracle_fp_total, non_oracle_notes_total, non_oracle_pieces_flagged = 0, 0, 0
    oracle_fp_total, oracle_notes_total, oracle_pieces_flagged = 0, 0, 0
    total_insertions = 0
    latencies = []
    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        label = DATA / "labels" / f"{pid}.csv"
        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        ground_truth = load_ground_truth_with_end_sec(label)
        events = bp_data[pid]["events"]

        audio, sr = sf.read(str(DATA / "audio" / f"{pid}.wav"))
        if audio.ndim > 1:
            audio = audio.mean(axis=1)

        t0 = time.time()
        alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
        t1 = time.time()
        result = detect_wrong_notes(na, alignment, events)
        t2 = time.time()
        latencies.append({"align": t1 - t0, "detect": t2 - t1})

        subs = [n for n in result["notes"] if n["verdict"] == "substitution"]
        non_oracle_fp_total += len(subs)
        non_oracle_notes_total += len(na)
        total_insertions += len(result["insertions"])
        if subs:
            non_oracle_pieces_flagged += 1

        oracle_align = oracle_alignment(na, ground_truth)
        oracle_result = detect_wrong_notes(na, oracle_align, events)
        oracle_subs = [n for n in oracle_result["notes"] if n["verdict"] == "substitution"]
        oracle_fp_total += len(oracle_subs)
        oracle_notes_total += len(na)
        if oracle_subs:
            oracle_pieces_flagged += 1

        print(f"{pid} ({instrument}): non-oracle FP={len(subs)}/{len(na)}  "
              f"oracle FP={len(oracle_subs)}/{len(na)}  insertions={len(result['insertions'])}  "
              f"[align {t1-t0:.1f}s, detect {t2-t1:.3f}s]")

    print(f"\nNon-oracle FP summary: {non_oracle_pieces_flagged}/{len(DEV_PIECES)} pieces flagged; "
          f"{non_oracle_fp_total}/{non_oracle_notes_total} notes "
          f"({100.0*non_oracle_fp_total/non_oracle_notes_total:.2f}%)")
    print(f"Oracle FP summary (diagnostic only): {oracle_pieces_flagged}/{len(DEV_PIECES)} pieces flagged; "
          f"{oracle_fp_total}/{oracle_notes_total} notes "
          f"({100.0*oracle_fp_total/oracle_notes_total:.2f}%)")
    print(f"Total insertions (unclaimed Basic Pitch events) across 8 pieces: {total_insertions}")
    avg_align = sum(l["align"] for l in latencies) / len(latencies)
    avg_detect = sum(l["detect"] for l in latencies) / len(latencies)
    print(f"Avg latency/piece: alignment {avg_align:.2f}s, detection {avg_detect:.3f}s")

    print("\n=== Positive cases: 6 verified wrong_pitch injections (RAW COUNTS, n=6, not a %) ===")
    manifest = json.loads((HERE / "injected_cases" / "manifest.json").read_text())
    injected_events = json.loads((HERE / "injected_cases" / "basic_pitch_events.json").read_text())

    non_oracle_detected = 0
    oracle_detected = 0
    localization_ok_count = 0
    for case in manifest:
        pid = case["piece"]
        musicxml = SCORES / f"{pid}.musicxml"
        label = DATA / "labels" / f"{pid}.csv"
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        ground_truth = load_ground_truth_with_end_sec(label)

        nearest = min(ground_truth, key=lambda r: abs(r["onset_sec"] - case["onset_sec"]))
        target_idx = int(np.argmin(np.abs(na["onset_beat"] - nearest["start_beat"])))

        injected_wav = Path(case["wav_path"]).read_bytes()
        audio, sr = sf.read(Path(case["wav_path"]))
        if audio.ndim > 1:
            audio = audio.mean(axis=1)

        events = injected_events[str(case["case"])]

        alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
        result = detect_wrong_notes(na, alignment, events)
        target_note = result["notes"][target_idx]
        non_oracle_hit = target_note["verdict"] == "substitution"
        if non_oracle_hit:
            non_oracle_detected += 1
            if measure_localization_ok(na, score_dict, beats_per_measure, target_idx, case["measure"]):
                localization_ok_count += 1

        oracle_align = oracle_alignment(na, ground_truth)
        oracle_result = detect_wrong_notes(na, oracle_align, events)
        oracle_hit = oracle_result["notes"][target_idx]["verdict"] == "substitution"
        if oracle_hit:
            oracle_detected += 1

        other_subs_non_oracle = sum(1 for n in result["notes"]
                                      if n["verdict"] == "substitution" and n["score_idx"] != target_idx)

        print(f"case {case['case']} (piece {pid}, score_idx={target_idx}, "
              f"{case['original_note']}->{case['new_note']}): "
              f"non_oracle_detected={non_oracle_hit} (verdict={target_note['verdict']}, "
              f"played={target_note['played_midi']}) oracle_detected={oracle_hit} "
              f"other_false_subs_this_take={other_subs_non_oracle}")

    print(f"\nRecall (non-oracle, the GO/STOP number): {non_oracle_detected}/6 raw count")
    print(f"Recall (oracle, diagnostic only): {oracle_detected}/6 raw count")
    print(f"Correct measure localization among non-oracle detections: "
          f"{localization_ok_count}/{non_oracle_detected} raw count")

    print("\n=== Memory profile (one representative piece, 2288) ===")
    tracemalloc.start()
    pid = "2288"
    musicxml = SCORES / f"{pid}.musicxml"
    score = pt.load_musicxml(str(musicxml))
    na = score.note_array()
    audio, sr = sf.read(str(DATA / "audio" / f"{pid}.wav"))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
    result = detect_wrong_notes(na, alignment, bp_data[pid]["events"])
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    print(f"Peak traced Python memory for alignment+detection on piece 2288: {peak / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
