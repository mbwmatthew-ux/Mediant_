"""
"MEDIANT — Basic Pitch note-extraction feasibility" (2026-11-04), step 8,
stage C of 3 (final).

Wrong-note detection test, per the directive: ONLY the 6 verified
`wrong_pitch` injections (Stage A/B) as positive cases, and the 8
unmodified dev pieces as negative/control cases -- nothing manufactured.

Detection logic: reuses `pa.AutomaticNoteMatcher`'s explicit score_id<->
performance_id pairing (already proven in
`basic_pitch_parangonar_alignment.py`) -- since the symbolic matcher
gives a direct 1:1 note correspondence, a "wrong note" is simply a
matched pair whose performance pitch is >=2 semitones from its OWN
paired score note's pitch and not an octave multiple (same distance/
octave rule `find_wrong_note_candidates` uses, applied directly to the
matched pair instead of a measure-neighbourhood, since no measure-level
ambiguity exists once a direct pairing exists).

No production code touched.

RESULTS (measured 2026-11-04) -- **stop condition 2 triggered, a
specific, confirmed mechanism, not a vague "didn't work":**

Recall: 0/6 verified injections detected. False positives: 0/8 pieces,
0/7211 notes. Zero flags of ANY kind on BOTH positive and negative
cases is not "perfectly clean" -- it is the signature of a detector
that can never fire. Confirmed directly (not guessed) by inspecting the
raw alignment for case 1 (piece 2288, score note index 41, true pitch
69, injected to 65): `AutomaticNoteMatcher` labels that score note
`"deletion"` (unmatched), the exact same label it would give a note the
performer never played at all. **The matcher's own internal pitch-aware
cost function refuses to produce a "match" when the pitch distance is
large -- it routes a genuinely-wrong-pitch performance note into the
same bucket as a missing note, before any distance-gate logic downstream
ever sees it.** This is a structural property of a matcher built for
expressive-performance alignment (which assumes the performance is
mostly pitch-correct), not a threshold that could be retuned to fix it.

This is NOT the same failure mode found in the 2026-11-01/11-04 rounds'
frame-level verifier (which anchors on `AudioToScoreMatcher`'s raw-audio
TIME alignment, independent of pitch matching, and failed on false
positives from CREPE's own frame-level continuity artifacts instead).
Basic Pitch's discrete note+pitch-bend output is not a drop-in
substitute for CREPE's per-frame pitch/confidence surface that
architecture needs, so that approach cannot be reused here either
without building something new.

**Recommendation, named not built, per "do not automatically try more
variations":** a wrong-note detector built on Basic Pitch's notes would
need either (a) a TIME-based alignment (like `AudioToScoreMatcher`)
paired with a separate distance-gate comparison against Basic Pitch's
own per-note pitch at each aligned time (bypassing `AutomaticNoteMatcher`
entirely), or (b) explicit insertion/deletion-pair inference (noticing
a deleted score note and an unrelated inserted performance note at the
same time and inferring "this is one wrong note, not two separate
errors"). Neither attempted here.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import partitura as pt
import parangonar as pa

import worker as w
from validate_alignment_against_musicnet import load_rows
from benchmark_full_pipeline import load_ground_truth_with_end_sec
from basic_pitch_parangonar_alignment import build_score_note_array, build_performance_note_array

HERE = Path(__file__).parent
DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORES = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")
DEV_PIECES = ["2202", "2203", "2217", "2221", "2288", "2293", "2294", "2295"]


def wrong_note_flags(alignment, sna, pna, na):
    score_idx = {sid: i for i, sid in enumerate(sna["id"])}
    perf_idx = {pid: i for i, pid in enumerate(pna["id"])}
    flags = []
    for a in alignment:
        if a["label"] != "match":
            continue
        si = score_idx[a["score_id"]]
        pi = perf_idx[a["performance_id"]]
        score_midi = int(na[si]["pitch"])
        played_midi = int(pna[pi]["pitch"])
        dist = abs(played_midi - score_midi)
        pc_dist = min(dist % 12, 12 - dist % 12)
        if dist >= 2 and pc_dist >= 2:
            flags.append({"score_idx": si, "onset_beat": float(na[si]["onset_beat"]),
                           "score_midi": score_midi, "played_midi": played_midi})
    return flags


def main():
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    matcher = pa.AutomaticNoteMatcher()

    print("=== Positive cases: 6 verified wrong_pitch injections ===")
    manifest = json.loads((HERE / "injected_cases" / "manifest.json").read_text())
    injected_events = json.loads((HERE / "injected_cases" / "basic_pitch_events.json").read_text())
    detected = 0
    for case in manifest:
        pid = case["piece"]
        musicxml = SCORES / f"{pid}.musicxml"
        label = DATA / "labels" / f"{pid}.csv"
        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        sna = build_score_note_array(na)
        pna = build_performance_note_array(injected_events[str(case["case"])])
        alignment = matcher(sna, pna)
        flags = wrong_note_flags(alignment, sna, pna, na)

        # Identify the SPECIFIC score index the injection targeted (same
        # method used throughout this session: nearest ground-truth note to
        # the injection's own onset_sec -> its start_beat -> nearest score
        # note by onset_beat) -- not just "any flag with a matching pitch
        # value," which could coincidentally hit an unrelated note.
        ground_truth = load_ground_truth_with_end_sec(label)
        nearest = min(ground_truth, key=lambda r: abs(r["onset_sec"] - case["onset_sec"]))
        target_idx = int(np.argmin(np.abs(na["onset_beat"] - nearest["start_beat"])))

        case_detected = any(f["score_idx"] == target_idx for f in flags)
        if case_detected:
            detected += 1
        print(f"case {case['case']} (piece {pid}, score_idx={target_idx}, "
              f"{case['original_note']}->{case['new_note']}): "
              f"{len(flags)} total flag(s) this take, detected={case_detected}")

    print(f"\nRecall: {detected}/{len(manifest)} verified injections detected")

    print("\n=== Negative/control cases: 8 unmodified dev pieces ===")
    bp_data = json.loads((HERE / "basic_pitch_events.json").read_text())
    total_fp = 0
    pieces_with_fp = 0
    total_notes = 0
    for pid in DEV_PIECES:
        musicxml = SCORES / f"{pid}.musicxml"
        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        sna = build_score_note_array(na)
        pna = build_performance_note_array(bp_data[pid]["events"])
        alignment = matcher(sna, pna)
        flags = wrong_note_flags(alignment, sna, pna, na)
        total_fp += len(flags)
        total_notes += len(na)
        if flags:
            pieces_with_fp += 1
        print(f"{pid} ({meta_rows[pid]['instrument']}): {len(flags)} false flag(s) / {len(na)} notes")

    print(f"\nFP summary: {pieces_with_fp}/{len(DEV_PIECES)} pieces had >=1 false flag; "
          f"{total_fp}/{total_notes} notes false-flagged ({100.0*total_fp/total_notes:.2f}%)")


if __name__ == "__main__":
    main()
