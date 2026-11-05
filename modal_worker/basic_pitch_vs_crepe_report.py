"""
"MEDIANT — Basic Pitch note-extraction feasibility" (2026-11-04).

Stage 3 of 3: compare Basic Pitch (Stage 1, `basic_pitch_events.json`)
against CREPE (Stage 2, `crepe_events.json`) on the same 8 real
MusicNet dev pieces, against the same ground truth, using
`note_sequence_evaluator.align_note_sequences` UNMODIFIED (no new
matching logic written for this task). Pure Python, no heavy deps --
runs in either venv.

Metrics (per the directive):
  - note-pitch precision/recall (correct matches / predicted, / ground truth)
  - onset precision/recall (matched pairs within 50ms onset tolerance --
    a standard MIR onset-detection tolerance, not tuned against this data)
  - insertion count (extra_idx), deletion count (missing_idx)
  - octave-error count
  - event over-generation: total predicted events vs. real note count,
    per piece -- the metric that directly tests the diagnosed bottleneck
  - per-instrument breakdown (Violin/Cello/Flute)

No production code touched.

RESULTS (measured 2026-11-04, real MusicNet audio, 8 dev pieces, 7387
real notes). A real bug was caught and fixed before trusting these
numbers: Basic Pitch's raw `note_events` output is NOT time-sorted
(verified directly) -- `align_note_sequences` requires monotonic input,
so an unsorted feed silently produced near-zero onset scores and wildly
wrong precision/recall on the first run. Both predicted sequences are
explicitly sorted by `time_sec` before evaluation.

    metric                  Basic Pitch   CREPE
    note precision          0.796         0.531
    note recall             0.843         0.706
    event over-generation   1.059x        1.329x   <- the diagnosed bottleneck
    octave errors           135           289
    wrong_pitch             442           1615
    deletions               583           269
    insertions              1016          2700

Basic Pitch wins on every headline metric except raw deletion count:
CREPE's over-generation means it finds SOME candidate near almost every
real note (fewer outright misses), but a much larger fraction of what
it finds carries the wrong pitch (1615+289=1904 of 7118 matched pairs,
26.7%) vs Basic Pitch (442+135=577 of 6804 matched pairs, 8.5%) -- the
wrong-pitch penalty dominates, so Basic Pitch's overall recall is still
higher. Per-instrument: Basic Pitch wins precision AND recall on all
three (Flute 0.884/0.829 vs 0.655/0.784; Cello 0.757/0.827 vs
0.477/0.645; Violin 0.850/0.976 vs 0.584/0.887). Latency: Basic Pitch
~1.1-2.2s/piece vs CREPE ~3.1-6.2s/piece (also 2-3x faster). Cost: $0,
CPU-only (CoreML inference on this Mac -- no GPU, no TensorFlow needed
despite the package listing it, no API calls).

**Clears stop condition 1 decisively.** See
`basic_pitch_parangonar_alignment.py` for the alignment step and
`basic_pitch_injection_stage_c.py` for the wrong-note detection result
(stop condition 2 -- a real, specific limitation found there).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from note_sequence_evaluator import align_note_sequences
from benchmark_full_pipeline import load_ground_truth_with_end_sec
from validate_alignment_against_musicnet import load_rows

DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
DEV_PIECES = ["2202", "2203", "2217", "2221", "2288", "2293", "2294", "2295"]
ONSET_TOLERANCE_SEC = 0.05  # standard MIR onset tolerance (50ms), not tuned against this data


def onset_hits(ground_truth, predicted, pairs):
    return sum(1 for gi, pi in pairs
               if abs(ground_truth[gi]["time_sec"] - predicted[pi]["time_sec"]) <= ONSET_TOLERANCE_SEC)


def evaluate(ground_truth, predicted):
    result = align_note_sequences(ground_truth, predicted)
    summary = result.summary(ground_truth, predicted)
    n_gt, n_pred = len(ground_truth), len(predicted)
    correct = summary["correct"]
    onset_ok = onset_hits(ground_truth, predicted, result.pairs)
    return {
        "n_gt": n_gt, "n_pred": n_pred,
        "note_precision": correct / n_pred if n_pred else 0.0,
        "note_recall": correct / n_gt if n_gt else 0.0,
        "onset_precision": onset_ok / n_pred if n_pred else 0.0,
        "onset_recall": onset_ok / n_gt if n_gt else 0.0,
        "insertions": summary["extra"], "deletions": summary["missing"],
        "octave_errors": summary["octave_error"], "wrong_pitch": summary["wrong_pitch"],
        "correct": correct,
        "overgeneration_ratio": n_pred / n_gt if n_gt else 0.0,
    }


def main():
    bp_data = json.loads((Path(__file__).parent / "basic_pitch_events.json").read_text())
    crepe_data = json.loads((Path(__file__).parent / "crepe_events.json").read_text())
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}

    per_instrument = {}  # instrument -> {"bp": [...], "crepe": [...]}
    print(f"{'piece':6} {'instr':8} {'n_gt':5} | {'BP n':5} {'BP P':6} {'BP R':6} {'BP ons.P':8} {'BP ons.R':8} {'BP ovg':6} {'BP oct':6} {'BP wp':5} {'BP del':6} {'BP ins':6} | {'CR n':5} {'CR P':6} {'CR R':6} {'CR ons.P':8} {'CR ons.R':8} {'CR ovg':6} {'CR oct':6} {'CR wp':5} {'CR del':6} {'CR ins':6}")
    all_bp = []
    all_crepe = []
    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        label = DATA / "labels" / f"{pid}.csv"
        gt_raw = load_ground_truth_with_end_sec(label)
        ground_truth = [{"time_sec": g["onset_sec"], "midi": g["note"]} for g in gt_raw]

        # Basic Pitch's note_events are NOT returned in time order (verified
        # directly -- confirmed real, not an assumption); align_note_sequences
        # requires both sequences monotonically ordered by time, so sort here.
        bp_pred = sorted(bp_data[pid]["events"], key=lambda e: e["time_sec"])
        crepe_pred = sorted(crepe_data[pid]["events"], key=lambda e: e["time_sec"])

        bp_eval = evaluate(ground_truth, bp_pred)
        cr_eval = evaluate(ground_truth, crepe_pred)
        all_bp.append(bp_eval)
        all_crepe.append(cr_eval)
        per_instrument.setdefault(instrument, {"bp": [], "crepe": []})
        per_instrument[instrument]["bp"].append(bp_eval)
        per_instrument[instrument]["crepe"].append(cr_eval)

        print(f"{pid:6} {instrument:8} {bp_eval['n_gt']:5} | "
              f"{bp_eval['n_pred']:5} {bp_eval['note_precision']:.3f} {bp_eval['note_recall']:.3f} "
              f"{bp_eval['onset_precision']:.3f}  {bp_eval['onset_recall']:.3f}  "
              f"{bp_eval['overgeneration_ratio']:.2f}  {bp_eval['octave_errors']:6} {bp_eval['wrong_pitch']:5} "
              f"{bp_eval['deletions']:6} {bp_eval['insertions']:6} | "
              f"{cr_eval['n_pred']:5} {cr_eval['note_precision']:.3f} {cr_eval['note_recall']:.3f} "
              f"{cr_eval['onset_precision']:.3f}  {cr_eval['onset_recall']:.3f}  "
              f"{cr_eval['overgeneration_ratio']:.2f}  {cr_eval['octave_errors']:6} {cr_eval['wrong_pitch']:5} "
              f"{cr_eval['deletions']:6} {cr_eval['insertions']:6}")

    def agg(rows, key_num, key_den=None):
        if key_den is None:
            return sum(r[key_num] for r in rows)
        return sum(r[key_num] for r in rows) / sum(r[key_den] for r in rows) if sum(r[key_den] for r in rows) else 0.0

    print("\n=== Overall (8 pieces combined) ===")
    for label_, rows in [("Basic Pitch", all_bp), ("CREPE", all_crepe)]:
        total_gt = sum(r["n_gt"] for r in rows)
        total_pred = sum(r["n_pred"] for r in rows)
        total_correct = sum(r["correct"] for r in rows)
        total_onset_hits = sum(round(r["onset_precision"] * r["n_pred"]) for r in rows)
        print(f"{label_}: n_gt={total_gt} n_pred={total_pred} overgeneration={total_pred/total_gt:.3f} "
              f"note_precision={total_correct/total_pred:.3f} note_recall={total_correct/total_gt:.3f} "
              f"octave_errors={sum(r['octave_errors'] for r in rows)} "
              f"wrong_pitch={sum(r['wrong_pitch'] for r in rows)} "
              f"deletions={sum(r['deletions'] for r in rows)} insertions={sum(r['insertions'] for r in rows)}")

    print("\n=== Per-instrument ===")
    for instrument, d in per_instrument.items():
        for label_, rows in [("Basic Pitch", d["bp"]), ("CREPE", d["crepe"])]:
            total_gt = sum(r["n_gt"] for r in rows)
            total_pred = sum(r["n_pred"] for r in rows)
            total_correct = sum(r["correct"] for r in rows)
            print(f"{instrument:8} {label_:12}: n_gt={total_gt} n_pred={total_pred} "
                  f"overgeneration={total_pred/total_gt:.3f} note_precision={total_correct/total_pred:.3f} "
                  f"note_recall={total_correct/total_gt:.3f}")


if __name__ == "__main__":
    main()
