"""
Mentor-recommended (round 3, point 3) finer-grained scoring on top of the
existing exact-measure-match harness (score_measures in
validate_score_reading_against_corpus.py). Exact-measure matching is a
single bit per measure -- one wrong pitch fails the whole measure, which
is why piece 2243 scored 0/20 even though several measures have only one
or two wrong notes. This module re-scores the SAME already-collected
predicted/ground-truth note lists (e.g. probe_result_2243.json) at
note-level granularity: no new Claude/Audiveris calls, zero additional
cost.

Alignment is a standard edit-distance (Levenshtein) over each measure's
note sequence, substitution cost 1, insertion/deletion cost 1 -- the
same formulation used for WER/CER in speech-recognition scoring. Notes
are compared post-normalization (MIDI pitch via w.midi_from_name,
ground-truth duration divided by quarter_lengths_per_beat) so this
never double-counts the pitch-spelling or duration-unit differences
_cross_source_measure_match already solved -- it reuses that same
normalization, just at note level instead of whole-measure level.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402 -- needs midi_from_name/quarter_lengths_per_beat only; no modal/API calls made by this module.


def _normalize_notes(notes: list, qlpb: float, from_quarter_lengths: bool) -> list:
    out = []
    for n in notes:
        pitch = n.get("pitch")
        midi = w.midi_from_name(pitch) if pitch else None
        dur = float(n.get("duration_beats") or 0)
        if from_quarter_lengths:
            dur = dur / qlpb
        out.append({
            "midi": midi,
            "is_rest": bool(n.get("is_rest")),
            "beat": round(float(n.get("beat") or 0), 2),
            "duration": round(dur, 2),
        })
    return out


def _note_equal(a: dict, b: dict) -> bool:
    return a["midi"] == b["midi"] and a["is_rest"] == b["is_rest"]


def _rhythm_equal(a: dict, b: dict) -> bool:
    return a["beat"] == b["beat"] and a["duration"] == b["duration"]


def align_measure(pred_notes: list, gt_notes: list) -> dict:
    """
    Levenshtein alignment between one measure's predicted and
    ground-truth note sequences (both already MIDI/qlpb-normalized).
    Returns counts of matches, substitutions (wrong pitch/rest at an
    aligned position), insertions (extra predicted notes), deletions
    (missing ground-truth notes), plus a separate rhythm-only match
    count (beat+duration equal, regardless of pitch).
    """
    n, m = len(pred_notes), len(gt_notes)
    # dp[i][j] = min edit distance between pred[:i] and gt[:j]
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            sub_cost = 0 if _note_equal(pred_notes[i - 1], gt_notes[j - 1]) else 1
            dp[i][j] = min(
                dp[i - 1][j - 1] + sub_cost,  # match or substitution
                dp[i - 1][j] + 1,             # insertion (extra predicted note)
                dp[i][j - 1] + 1,             # deletion (missing gt note)
            )

    # Backtrack to classify each edit operation.
    i, j = n, m
    matches = substitutions = insertions = deletions = 0
    rhythm_matches = 0
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            sub_cost = 0 if _note_equal(pred_notes[i - 1], gt_notes[j - 1]) else 1
            if dp[i][j] == dp[i - 1][j - 1] + sub_cost:
                if sub_cost == 0:
                    matches += 1
                else:
                    substitutions += 1
                if _rhythm_equal(pred_notes[i - 1], gt_notes[j - 1]):
                    rhythm_matches += 1
                i, j = i - 1, j - 1
                continue
        if i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            insertions += 1
            i -= 1
            continue
        if j > 0 and dp[i][j] == dp[i][j - 1] + 1:
            deletions += 1
            j -= 1
            continue
        # Should not be reachable given the recurrence above.
        raise AssertionError(f"alignment backtrack stuck at i={i} j={j}")

    return {
        "n_pred": n, "n_gt": m,
        "matches": matches, "substitutions": substitutions,
        "insertions": insertions, "deletions": deletions,
        "rhythm_matches": rhythm_matches,
        "edit_distance": dp[n][m],
    }


def score_detailed(predicted_measures: list, ground_truth_measures: list,
                    time_sig: str) -> dict:
    """
    Note-level counterpart to score_measures(). Returns per-measure
    alignment detail plus piece-level aggregates:
      - pitch_accuracy: matches / n_gt_notes (proportion of ground-truth
        notes whose pitch+rest-status was reproduced at the right
        position in the aligned sequence)
      - rhythm_accuracy: rhythm_matches / n_gt_notes (beat+duration
        correct, independent of pitch correctness)
      - note_error_rate: (substitutions+insertions+deletions) / n_gt_notes
        (WER-style; can exceed 1.0 when insertions are heavy)
    """
    qlpb = w.quarter_lengths_per_beat(time_sig) or 1.0
    gt_by_number = {m["number"]: m for m in ground_truth_measures}
    pred_by_number = {m["number"]: m for m in predicted_measures}

    per_measure = {}
    totals = {"matches": 0, "substitutions": 0, "insertions": 0,
              "deletions": 0, "rhythm_matches": 0, "n_gt": 0}

    for number, gt_measure in gt_by_number.items():
        pred_measure = pred_by_number.get(number)
        gt_notes = _normalize_notes(gt_measure.get("notes") or [], qlpb,
                                     from_quarter_lengths=True)
        pred_notes = _normalize_notes(
            (pred_measure or {}).get("notes") or [], qlpb,
            from_quarter_lengths=False)
        result = align_measure(pred_notes, gt_notes)
        per_measure[number] = result
        for key in ("matches", "substitutions", "insertions", "deletions",
                    "rhythm_matches"):
            totals[key] += result[key]
        totals["n_gt"] += result["n_gt"]

    n_gt = totals["n_gt"] or 1  # guard against an empty ground truth
    return {
        "per_measure": per_measure,
        "pitch_accuracy": round(totals["matches"] / n_gt, 4),
        "rhythm_accuracy": round(totals["rhythm_matches"] / n_gt, 4),
        "note_error_rate": round(
            (totals["substitutions"] + totals["insertions"] + totals["deletions"])
            / n_gt, 4),
        "totals": totals,
    }


def main():
    import json
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} probe_result_<piece>.json")
        return 1
    probe_path = Path(sys.argv[1])
    data = json.loads(probe_path.read_text())

    # The probe files saved so far don't carry the piece's time signature
    # directly; read it back out of the ground-truth corpus file rather
    # than re-deriving it, so this always matches what the probe actually
    # scored against.
    corpus_dir = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus")
    ground_truth = json.loads((corpus_dir / "ground_truth.json").read_text())
    time_sig = ground_truth[data["piece_id"]]["time_signature"]

    detail = score_detailed(data["predicted_measures"],
                             data["ground_truth_measures"], time_sig)

    print(f"Piece {data['piece_id']} ({time_sig}) -- detailed note-level scoring")
    print(f"  exact-measure accuracy (existing metric): "
          f"{data['n_correct']}/{data['n_total']} "
          f"({100 * data['n_correct'] / data['n_total']:.1f}%)")
    print(f"  pitch accuracy:  {detail['pitch_accuracy'] * 100:.1f}%  "
          f"({detail['totals']['matches']}/{detail['totals']['n_gt']} ground-truth notes)")
    print(f"  rhythm accuracy: {detail['rhythm_accuracy'] * 100:.1f}%  "
          f"({detail['totals']['rhythm_matches']}/{detail['totals']['n_gt']} ground-truth notes)")
    print(f"  note error rate: {detail['note_error_rate'] * 100:.1f}%  "
          f"(sub={detail['totals']['substitutions']} "
          f"ins={detail['totals']['insertions']} "
          f"del={detail['totals']['deletions']})")
    print()
    print("  per-measure (pred/gt notes, S/I/D):")
    for number in sorted(detail["per_measure"]):
        r = detail["per_measure"][number]
        flag = "" if r["substitutions"] + r["insertions"] + r["deletions"] == 0 else "  <-- errors"
        print(f"    m.{number}: pred={r['n_pred']} gt={r['n_gt']} "
              f"matches={r['matches']} sub={r['substitutions']} "
              f"ins={r['insertions']} del={r['deletions']}{flag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
