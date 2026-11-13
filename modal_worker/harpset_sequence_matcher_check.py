"""
Offline HARPSET transfer test for candidate D (sequence_error_matcher,
unfiltered) and candidate F (D + neighbor-pitch-class suppression),
both frozen from commit 533bd53 -- NO tuning, NO new thresholds, NO
gates. Per the directive requesting this check: D and F are run as-is
against the corrected HARPSET manifest from `e0d25fc` (13 original
performances, 26 independently verified pitch deviations across 8
pieces' N variants), using ONLY each piece's ORIGINAL (O) score as
detector input -- exactly the same rule `harpset_evaluation.py`
already enforces for candidates A/B/C.

Reuses, unmodified:
- `harpset_evaluation.build_manifest`, `print_manifest_and_assert`,
  `score_file`, `audio_file`, `performance_exists`, `score_note_array`,
  `ground_truth_pitch_errors`, `extract_basic_pitch_events`,
  `ALL_PIECES`, `EXPECTED_N_DEVIATIONS`, `EXPECTED_N_PIECES`.
- `sequence_matcher_benchmark.build_score_notes`, `build_performed_events`,
  `run_candidate_D`.
- `sequence_matcher_gated_benchmark.suppress_neighbor_pitch_class`.
- `cross_model_fp_classification.pc_match`, `NEIGHBOR_RADIUS` (used only
  to label, in the per-case output, whether a suppressed/missed hit's
  played pitch matches a neighboring score note's pitch class --
  diagnostic labeling, not a new gate).

No CREPE anywhere in this script -- HARPSET's prior run already found
CREPE produces zero usable events on every single harp recording
(pathological sub-2% confidence, nowhere near the voicing floor), so
candidate E (CREPE-gated) is not meaningful on this corpus and is not
run here; the directive asks only for D and F.

Basic Pitch events are extracted fresh via the existing
`extract_basic_pitch_events` subprocess call (no cache previously
existed for HARPSET) and cached to `harpset_basic_pitch_events.json`
in this directory, keyed "{piece}_{variant}", so a re-run of this
script does not re-pay extraction cost. Parangonar alignment is
likewise computed once per (piece, variant) and not cached (cheap,
~seconds, and this script is the only thing that ever consumes it).

Ground truth (symbolic): `ground_truth_pitch_errors(pid, "N")` gives
na-index positions where the N score's pitch differs from the O
score's pitch -- a SCORE-vs-SCORE symbolic diff, never involving audio
or any detector's own acoustic read. This is kept strictly distinct
from the detectors' own (acoustic) pitch judgments below -- a ground
truth hit is "the detector's score_idx matches the symbolic diff's
index," nothing about whether CREPE or any other acoustic signal
agrees with that diff.

No production code touched. $0, CPU-only.
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
from harpset_evaluation import (
    build_manifest, print_manifest_and_assert, score_file, audio_file,
    performance_exists, score_note_array, ground_truth_pitch_errors,
    extract_basic_pitch_events, ALL_PIECES, EXPECTED_N_DEVIATIONS, EXPECTED_N_PIECES,
)
from sequence_matcher_benchmark import build_score_notes, build_performed_events, run_candidate_D
from sequence_matcher_gated_benchmark import suppress_neighbor_pitch_class
from cross_model_fp_classification import pc_match, NEIGHBOR_RADIUS

HERE = Path(__file__).parent
BP_CACHE_PATH = HERE / "harpset_basic_pitch_events.json"

GO_RECALL_MIN = 13   # of 26
GO_FP_MAX_PIECES = 1  # of 13 originals


def load_bp_cache() -> dict:
    if BP_CACHE_PATH.exists():
        return json.loads(BP_CACHE_PATH.read_text())
    return {}


def get_bp_events(cache: dict, pid: str, variant: str) -> list[dict]:
    key = f"{pid}_{variant}"
    if key not in cache:
        cache[key] = extract_basic_pitch_events(str(audio_file(pid, variant)))
        BP_CACHE_PATH.write_text(json.dumps(cache))
    return cache[key]


def load_audio(pid: str, variant: str):
    wav_path = audio_file(pid, variant)
    audio, sr = sf.read(str(wav_path))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return audio, sr


def main():
    manifest = build_manifest()
    print_manifest_and_assert(manifest)
    bp_cache = load_bp_cache()
    matcher = pa.AudioToScoreMatcher()

    print("\n=== Part 1: false positives on 13 original (O) performances, D vs F ===")
    d_total_fp, d_pieces_flagged = 0, 0
    f_total_fp, f_pieces_flagged = 0, 0
    notes_total = 0
    per_piece_fp = []

    for pid in ALL_PIECES:
        musicxml = score_file(pid, "O")
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        na = score_note_array(pid, "O")

        audio, sr = load_audio(pid, "O")
        bp_events = get_bp_events(bp_cache, pid, "O")

        alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
        d_result = run_candidate_D(na, alignment, bp_events, beats_per_measure)
        f_kept = suppress_neighbor_pitch_class(d_result, na)

        d_fp = len(d_result["substitutions"])
        f_fp = len(f_kept)
        d_total_fp += d_fp
        d_pieces_flagged += 1 if d_fp else 0
        f_total_fp += f_fp
        f_pieces_flagged += 1 if f_fp else 0
        notes_total += len(na)
        per_piece_fp.append((pid, d_fp, f_fp, len(na)))

        print(f"{pid}_O: D_sub={d_fp} F_kept={f_fp} / {len(na)} notes")

    print(f"\nD: {d_pieces_flagged}/13 originals falsely flagged, {d_total_fp}/{notes_total} notes "
          f"({100.0 * d_total_fp / notes_total:.2f}%)")
    print(f"F: {f_pieces_flagged}/13 originals falsely flagged, {f_total_fp}/{notes_total} notes "
          f"({100.0 * f_total_fp / notes_total:.2f}%)")
    print("Per-piece (piece: D_fp/F_fp of notes): " +
          ", ".join(f"{p}:{d}/{f} of {n}" for p, d, f, n in per_piece_fp))

    print("\n=== Part 2: pitch-error recall + localization on N variants, D vs F "
          "(ground truth = symbolic O-vs-N score diff, independent of any acoustic signal) ===")
    recall_d, recall_f, localized_d, localized_f = 0, 0, 0, 0
    total_errors = 0
    suppressed_true_hits = []

    for pid in ALL_PIECES:
        if not performance_exists(pid, "N"):
            continue
        gt_indices = ground_truth_pitch_errors(pid, "N")
        if gt_indices is None or not gt_indices:
            continue

        musicxml_o = score_file(pid, "O")
        score_dict = w.parse_musicxml(musicxml_o.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        na = score_note_array(pid, "O")  # ONLY the original score is fed to the detector

        audio, sr = load_audio(pid, "N")
        bp_events = get_bp_events(bp_cache, pid, "N")

        alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
        d_result = run_candidate_D(na, alignment, bp_events, beats_per_measure)
        f_kept = suppress_neighbor_pitch_class(d_result, na)

        d_by_idx = {o.score_idx: o for o in d_result["substitutions"]}
        f_idx = {o.score_idx for o in f_kept}

        for idx in gt_indices:
            total_errors += 1
            true_measure = int(float(na[idx]["onset_beat"]) // beats_per_measure) + 1
            d_op = d_by_idx.get(idx)
            d_hit = d_op is not None
            d_localized = d_hit and d_op.measure == true_measure
            f_hit = idx in f_idx
            f_localized = f_hit and d_op.measure == true_measure if f_hit else False

            if d_hit:
                recall_d += 1
                if d_localized:
                    localized_d += 1
            if f_hit:
                recall_f += 1
                if f_localized:
                    localized_f += 1

            suppressed_by_neighbor = None
            if d_hit and not f_hit:
                lo = max(0, idx - NEIGHBOR_RADIUS)
                hi = min(len(na), idx + NEIGHBOR_RADIUS + 1)
                neighbor_midis = [int(na[j]["pitch"]) for j in range(lo, hi) if j != idx]
                suppressed_by_neighbor = any(pc_match(d_op.played_midi, nb) for nb in neighbor_midis)
                suppressed_true_hits.append({
                    "piece": pid, "score_idx": idx, "measure": true_measure,
                    "played_midi": d_op.played_midi, "expected_midi": d_op.expected_midi,
                    "suppressed_by_neighbor_pitch_class": suppressed_by_neighbor,
                })

            print(f"{pid}_N idx={idx} measure={true_measure}: "
                  f"D_hit={d_hit}(localized={d_localized}) F_hit={f_hit}"
                  + (f"  [D hit suppressed by F; neighbor_pc_match={suppressed_by_neighbor}]"
                     if d_hit and not f_hit else ""))

    print(f"\nRecall out of {total_errors} verified pitch deviations: D={recall_d} F={recall_f}")
    print(f"Correct-measure localization among own detections: "
          f"D={localized_d}/{recall_d} F={localized_f}/{recall_f}")

    print(f"\nTrue detections F suppresses relative to D: {len(suppressed_true_hits)}")
    for s in suppressed_true_hits:
        print(f"  piece {s['piece']} idx={s['score_idx']} measure={s['measure']} "
              f"played={s['played_midi']} expected={s['expected_midi']} "
              f"neighbor_pitch_class_match={s['suppressed_by_neighbor_pitch_class']}")

    assert total_errors == EXPECTED_N_DEVIATIONS, (
        f"Expected {EXPECTED_N_DEVIATIONS} verified pitch deviations, counted {total_errors} "
        "-- manifest/ground-truth regression, do not trust results above."
    )

    print("\n=== GO/STOP ===")
    go = recall_f >= GO_RECALL_MIN and f_pieces_flagged <= GO_FP_MAX_PIECES
    print(f"F: recall+localized {localized_f}/26 (>= {GO_RECALL_MIN} required), "
          f"falsely-flagged originals {f_pieces_flagged}/13 (<= {GO_FP_MAX_PIECES} required)")
    print("DECISION: GO to broader offline validation" if go else
          "DECISION: STOP -- archive F as a research result, do not advance")


if __name__ == "__main__":
    main()
