"""
Stage 3 of the visual score-reading validation harness: runs the real
read_score_notes_claude against Stage 1/2's corpus images and scores the
result against ground truth.

NOT part of the production Modal image. Requires real API keys (see
module-level REQUIRED_ENV_VARS below) and dispatches real Audiveris
calls against the deployed `mediant-worker` Modal app via `with
w.app.run():` — confirmed necessary by direct test: a bare
`w.run_audiveris_on_row.spawn(...)` call outside that context fails
with "Function has not been hydrated...because the App it is defined
on is not running."

See docs/superpowers/specs/2026-10-23-visual-score-reading-validation-harness-design.md
for the full design.

Usage:
    export ANTHROPIC_API_KEY=...
    export GEMINI_API_KEY=...
    python3 validate_score_reading_against_corpus.py \\
        --corpus-dir /Users/matthewwu/.cache/mediant_validation/visual_corpus \\
        --subset            # fast-iteration subset (5 pieces); omit for --full
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import worker as w  # noqa: E402 — needs the REAL modal/music21/etc. stack; run in the validation venv.

REQUIRED_ENV_VARS = ("ANTHROPIC_API_KEY", "GEMINI_API_KEY")

# Hardcoded for fast, comparable day-to-day iteration — the shortest
# piece from each of the 3 solo instruments in the corpus, plus 2 more
# for a little breadth. Checkpoint/gate runs use --full (all 24 pieces)
# instead. See the spec's "Cost policy" section for why this exists:
# every validation run here costs real Claude+Gemini+Audiveris API
# calls, unlike the audio side's fully-local CREPE harness.
FAST_ITERATION_SUBSET = ["2191", "2204", "2298", "2659", "2203"]


def score_measures(predicted: list, ground_truth: list) -> tuple:
    """
    Returns (n_correct, n_total). `n_total` is the number of ground-truth
    measures. A ground-truth measure number with no matching entry in
    `predicted` counts as incorrect, not excluded — a failure to produce
    an answer is a wrong answer, matching the audio side's convention.
    """
    predicted_by_number = {m["number"]: m for m in predicted}
    n_correct = 0
    for gt_measure in ground_truth:
        pred_measure = predicted_by_number.get(gt_measure["number"])
        if pred_measure is not None and \
                w._measure_fingerprint(pred_measure) == w._measure_fingerprint(gt_measure):
            n_correct += 1
    return n_correct, len(ground_truth)


def aggregate_scores(per_piece_results: dict) -> dict:
    """
    `per_piece_results`: {piece_id: (n_correct, n_total)}.
    Returns {"per_piece": {piece_id: pct}, "overall": pct}.
    """
    per_piece = {}
    total_correct, total_measures = 0, 0
    for piece_id, (n_correct, n_total) in per_piece_results.items():
        per_piece[piece_id] = round(100.0 * n_correct / n_total, 4) if n_total else 0.0
        total_correct += n_correct
        total_measures += n_total
    overall = round(100.0 * total_correct / total_measures, 4) if total_measures else 0.0
    return {"per_piece": per_piece, "overall": overall}
