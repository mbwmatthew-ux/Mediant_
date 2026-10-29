"""
Phase 2 experiment: runs SMT zero-shot (no fine-tuning) against the
calibration and held-out splits of the visual validation corpus, reporting
accuracy with confidence intervals and per-instrument breakdowns -- never
an aggregate alone, per spec Section 6.

Zero Anthropic/Google API cost: SMT runs entirely as self-hosted inference.
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import smt_inference as si  # noqa: E402
import split_validation_corpus as svc  # noqa: E402
from validate_score_reading_against_corpus import score_measures  # noqa: E402


def wilson_confidence_interval(n_correct: int, n_total: int, z: float = 1.96) -> tuple:
    """95% Wilson score interval for a proportion -- more reliable than a
    normal approximation at the small sample sizes this corpus has."""
    if n_total == 0:
        return (0.0, 0.0)
    p = n_correct / n_total
    denom = 1 + z**2 / n_total
    center = (p + z**2 / (2 * n_total)) / denom
    margin = (z * math.sqrt(p * (1 - p) / n_total + z**2 / (4 * n_total**2))) / denom
    return (max(0.0, center - margin), min(1.0, center + margin))


def evaluate_piece_set(piece_ids: set, corpus_dir: Path, ground_truth: dict,
                        checkpoint: str) -> dict:
    """Returns {piece_id: (n_correct, n_total, instrument)} for every piece
    in `piece_ids`, reading pages from `corpus_dir` ('clean' or a degraded
    tier subdirectory)."""
    results = {}
    for piece_id in sorted(piece_ids):
        gt_entry = ground_truth[piece_id]
        page_paths = sorted(corpus_dir.glob(f"{piece_id}_page*.png"))
        if not page_paths:
            results[piece_id] = (0, len(gt_entry["measures"]),
                                  gt_entry.get("instrument", "unknown"))
            continue
        print(f"  transcribing {piece_id} ({gt_entry.get('instrument', 'unknown')}, "
              f"{len(page_paths)} page(s))...", flush=True)
        smt_result = si.transcribe_with_smt(page_paths, checkpoint)
        if smt_result.get("error"):
            print(f"    -> error: {smt_result['error']}", flush=True)
        n_correct, n_total = score_measures(
            smt_result.get("measures") or [], gt_entry["measures"],
            gt_entry["time_signature"])
        print(f"    -> {n_correct}/{n_total} measures correct", flush=True)
        results[piece_id] = (n_correct, n_total, gt_entry.get("instrument", "unknown"))
    return results


def main():
    corpus_dir = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus")
    with open(corpus_dir / "ground_truth.json") as f:
        ground_truth = json.load(f)

    calibration_ids, held_out_ids = svc.split_corpus_by_piece(
        ground_truth, calibration_fraction=0.5, seed=20261028)

    print(f"calibration set ({len(calibration_ids)} pieces): {sorted(calibration_ids)}")
    print(f"held-out set ({len(held_out_ids)} pieces): {sorted(held_out_ids)}")

    checkpoint = "antoniorv6/smt-grandstaff"
    for set_name, piece_ids in (("calibration", calibration_ids), ("held_out", held_out_ids)):
        results = evaluate_piece_set(piece_ids, corpus_dir / "clean", ground_truth, checkpoint)
        by_instrument = {}
        for piece_id, (n_correct, n_total, instrument) in results.items():
            by_instrument.setdefault(instrument, [0, 0])
            by_instrument[instrument][0] += n_correct
            by_instrument[instrument][1] += n_total

        print(f"\n=== {set_name} set ===")
        total_correct = sum(v[0] for v in by_instrument.values())
        total_n = sum(v[1] for v in by_instrument.values())
        for instrument, (n_correct, n_total) in sorted(by_instrument.items()):
            pct = round(100 * n_correct / n_total, 2) if n_total else 0.0
            lo, hi = wilson_confidence_interval(n_correct, n_total)
            print(f"  {instrument}: {pct}% ({n_correct}/{n_total}), "
                  f"95% CI [{round(lo*100, 2)}%, {round(hi*100, 2)}%]")
        agg_pct = round(100 * total_correct / total_n, 2) if total_n else 0.0
        lo, hi = wilson_confidence_interval(total_correct, total_n)
        print(f"  AGGREGATE: {agg_pct}% ({total_correct}/{total_n}), "
              f"95% CI [{round(lo*100, 2)}%, {round(hi*100, 2)}%]")

    return 0


if __name__ == "__main__":
    sys.exit(main())
