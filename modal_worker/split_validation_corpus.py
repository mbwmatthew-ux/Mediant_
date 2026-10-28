"""
Splits the visual validation corpus into a calibration set (used ONLY to
pick numeric acceptance thresholds) and a held-out test set (used ONLY for
the actual accept/reject measurement) -- split by PIECE, before any
degradation variant exists, per the spec's Section 6/7 requirement that a
threshold must never be set by looking at the same data it's graded
against, and that no split may leak degraded variants of one piece across
both sides.

See docs/superpowers/specs/2026-10-28-visual-pipeline-cost-redesign-design.md
Section 6 ("Threshold-setting methodology") for the full rationale.
"""
import hashlib


def split_corpus_by_piece(ground_truth: dict, calibration_fraction: float,
                           seed: int) -> tuple[set, set]:
    """
    Deterministically partitions `ground_truth`'s piece IDs into
    (calibration_ids, held_out_ids). Deterministic via a seeded hash of each
    piece ID rather than `random.shuffle`, so the same (seed, piece ID) pair
    always lands on the same side regardless of dict iteration order or
    how many pieces are in the corpus -- adding a new piece later does not
    reshuffle which existing pieces were calibration vs. held-out.
    """
    piece_ids = sorted(ground_truth.keys())
    n_calibration = round(len(piece_ids) * calibration_fraction)

    def _rank(piece_id: str) -> str:
        return hashlib.sha256(f"{seed}:{piece_id}".encode()).hexdigest()

    ranked = sorted(piece_ids, key=_rank)
    calibration_ids = set(ranked[:n_calibration])
    held_out_ids = set(ranked[n_calibration:])
    return calibration_ids, held_out_ids
