"""
Stage 3 of the visual score-reading validation harness: runs the real
read_score_notes_claude against Stage 1/2's corpus images and scores the
result against ground truth.

NOT part of the production Modal image. Requires a real API key (see
module-level REQUIRED_ENV_VARS below) and dispatches real Audiveris
calls via `with w.app.run():` — this starts a temporary EPHEMERAL Modal
run from local source, NOT a call into the already-deployed
`mediant-worker` Modal app. Confirmed necessary by direct test: a bare
`w.run_audiveris_on_row.spawn(...)` call outside that context fails
with "Function has not been hydrated...because the App it is defined
on is not running."

See docs/superpowers/specs/2026-10-23-visual-score-reading-validation-harness-design.md
for the full design.

Usage:
    export ANTHROPIC_API_KEY=...
    python3 validate_score_reading_against_corpus.py \\
        --corpus-dir /Users/matthewwu/.cache/mediant_validation/visual_corpus \\
        # fast-iteration subset (5 pieces) by default; pass --full for all 24
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import worker as w  # noqa: E402 — needs the REAL modal/music21/etc. stack; run in the validation venv.

REQUIRED_ENV_VARS = ("ANTHROPIC_API_KEY",)

# Hardcoded for fast, comparable day-to-day iteration — the 4 CONFIRMED
# single-page pieces in the corpus (2204=Flute, 2220=Cello, 2243=Violin,
# 2296=Cello — verified directly against ground_truth.json's "n_pages"
# field, not assumed), plus one more single-instrument-diverse piece
# (2191, Violin, 2 pages — the cheapest way to get a second Violin
# piece once the 4 single-page candidates are exhausted) for breadth.
# Total: 6 pages across 5 pieces. The previous subset
# (["2191","2204","2298","2659","2203"]) totaled ~10 pages — roughly
# double the intended cost per run — because it was never checked
# against actual per-piece page counts. Checkpoint/gate runs use --full
# (all 24 pieces) instead. See the spec's "Cost policy" section for why
# this exists: every validation run here costs real Claude+Audiveris
# API calls, unlike the audio side's fully-local CREPE harness.
FAST_ITERATION_SUBSET = ["2204", "2220", "2243", "2296", "2191"]


def score_measures(predicted: list, ground_truth: list, time_sig: str) -> tuple:
    """
    Returns (n_correct, n_total). `n_total` is the number of ground-truth
    measures. A ground-truth measure number with no matching entry in
    `predicted` counts as incorrect, not excluded — a failure to produce
    an answer is a wrong answer, matching the audio side's convention.

    Uses `w._cross_source_measure_match`, NOT `w._measure_fingerprint`
    (final-review C1 fix). `_measure_fingerprint` compares raw pitch
    strings and raw duration units, which is correct only for comparing
    two SAME-SOURCE Claude reads against each other. Here `predicted`
    (Claude's vision read) and `ground_truth` (music21-derived) are two
    INDEPENDENT sources that do not share a pitch-spelling convention
    ("Bb4" vs music21's "B-4" — never equal under raw-string comparison)
    or a duration-unit convention (Claude reports notated beats;
    music21's `duration_beats` is a quarterLength — they only coincide
    in simple time, diverging in 6/8, 12/8, etc.). `_cross_source_
    measure_match` normalizes both (pitch via `midi_from_name`,
    duration by dividing the ground-truth side by
    `quarter_lengths_per_beat(time_sig)`) before comparing, and never
    matches an empty/missing measure against another empty one.
    """
    predicted_by_number = {m["number"]: m for m in predicted}
    n_correct = 0
    for gt_measure in ground_truth:
        pred_measure = predicted_by_number.get(gt_measure["number"])
        if pred_measure is not None and \
                w._cross_source_measure_match(pred_measure, gt_measure, time_sig):
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


def run_validation_for_piece_tier(piece_id: str, tier_dir: Path, ground_truth_entry: dict,
                                   anthropic_key: str) -> tuple:
    """
    Runs read_score_notes_claude against every page of `piece_id` in
    `tier_dir`, then scores the combined result's measures against
    ground truth. Returns (n_correct, n_total).

    `instrument`/`time_sig` are passed as read_score_notes_claude's
    own hints to the vision prompt, not used for scoring — "Violin" is
    a reasonable stand-in for every piece here (MusicNet's instruments
    are Violin/Cello/Flute; read_score_notes_claude's prompt does not
    change its note-extraction schema based on this hint, only its
    guidance text) rather than threading the real per-piece instrument
    through, since scoring only ever checks the extracted notes, not
    whether the instrument hint was used correctly — that is a
    different, not-yet-built type of test.
    """
    page_paths = sorted(tier_dir.glob(f"{piece_id}_page*.png"))
    if not page_paths:
        print(f"  [{piece_id}] no page images found in {tier_dir}, counted as a full miss")
        return 0, len(ground_truth_entry["measures"])

    pages = []
    try:
        for p in page_paths:
            with open(p, "rb") as f:
                pages.append((f.read(), "image/png"))
    except OSError as e:
        print(f"  [{piece_id}] failed to read page image(s) from {tier_dir} "
              f"({type(e).__name__}: {e}), counted as a full miss")
        return 0, len(ground_truth_entry["measures"])

    result = _call_read_score_notes_with_one_retry(pages, anthropic_key, piece_id)
    if result is None:
        return 0, len(ground_truth_entry["measures"])

    predicted_measures = result.get("measures") or []
    return score_measures(predicted_measures, ground_truth_entry["measures"],
                           ground_truth_entry["time_signature"])


def _call_read_score_notes_with_one_retry(pages: list, anthropic_key: str, label: str) -> dict | None:
    """
    Calls read_score_notes_claude, retrying ONCE before giving up — per
    the spec's error-handling rule: "a transient-looking API error
    (timeout, rate limit) ... gets one retry before being counted as a
    real failure." This does not try to classify transient vs.
    permanent errors precisely (the spec doesn't define that boundary
    either); one retry on any failure is the simple version of that
    rule, and a second consecutive failure is treated as real.

    Retries on TWO distinct failure shapes (final-review M1 fix): the
    function RAISING, and the function returning normally with an
    error-shaped result (`{"error": "...", ...}` and no usable
    "measures" key) — read_score_notes_claude can fail either way, and
    the spec's retry rule doesn't distinguish between them.

    Returns None if both attempts fail.
    """
    def _is_error_shaped(result: dict) -> bool:
        return bool(result.get("error")) and not result.get("measures")

    for attempt in (1, 2):
        try:
            with w.app.run():
                result = w.read_score_notes_claude(
                    pages=pages, start_measure=1, instrument="Violin",
                    time_sig="4/4", anthropic_api_key=anthropic_key)
            if not _is_error_shaped(result):
                return result
            print(f"  [{label}] attempt {attempt} returned an error-shaped "
                  f"result ({result.get('error')!r})"
                  + (" — retrying once" if attempt == 1 else " — counted as a full miss"))
        except Exception as e:                                   # noqa: BLE001
            print(f"  [{label}] attempt {attempt} raised "
                  f"{type(e).__name__}: {e}"
                  + (" — retrying once" if attempt == 1 else " — counted as a full miss"))
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus-dir", default="/Users/matthewwu/.cache/mediant_validation/visual_corpus")
    parser.add_argument("--full", action="store_true",
                         help="Score all 24 pieces instead of the fast-iteration subset")
    args = parser.parse_args()

    missing = [v for v in REQUIRED_ENV_VARS if not os.environ.get(v)]
    if missing:
        print(f"[validate_score_reading_against_corpus] missing required "
              f"env var(s): {', '.join(missing)} — set them and re-run.")
        return 1
    anthropic_key = os.environ["ANTHROPIC_API_KEY"]

    corpus_dir = Path(args.corpus_dir)
    with open(corpus_dir / "ground_truth.json") as f:
        ground_truth = json.load(f)

    piece_ids = sorted(ground_truth.keys()) if args.full else FAST_ITERATION_SUBSET
    tiers = {
        "clean": corpus_dir / "clean",
        "mild": corpus_dir / "degraded" / "mild",
        "severe": corpus_dir / "degraded" / "severe",
    }

    results_by_tier = {}
    for tier_name, tier_dir in tiers.items():
        per_piece_results = {}
        for piece_id in piece_ids:
            if piece_id not in ground_truth:
                print(f"  [{tier_name}/{piece_id}] no ground truth, skipping")
                continue
            n_correct, n_total = run_validation_for_piece_tier(
                piece_id, tier_dir, ground_truth[piece_id], anthropic_key)
            per_piece_results[piece_id] = (n_correct, n_total)
            print(f"  [{tier_name}/{piece_id}] {n_correct}/{n_total} measures correct")
        results_by_tier[tier_name] = aggregate_scores(per_piece_results)

    anchors_dir = Path(os.path.dirname(os.path.abspath(__file__))) / "visual_validation_anchors"
    anchors = load_anchor_cases(anchors_dir)
    anchor_results = {}
    for name, anchor in anchors.items():
        pages = []
        for p in anchor["pages"]:
            with open(p, "rb") as f:
                pages.append((f.read(), "image/png"))
        result = _call_read_score_notes_with_one_retry(pages, anthropic_key, f"anchor/{name}")
        if result is None:
            n_correct, n_total = 0, len(anchor["ground_truth"]["measures"])
        else:
            n_correct, n_total = score_measures(
                result.get("measures") or [], anchor["ground_truth"]["measures"],
                anchor["ground_truth"]["time_signature"])
        pct = round(100.0 * n_correct / n_total, 4) if n_total else 0.0
        anchor_results[name] = pct
        print(f"  [anchor/{name}] {n_correct}/{n_total} measures correct ({pct}%)")

    print("\n" + "=" * 70)
    print("Visual score-reading validation — % correct-measure-match")
    print("=" * 70)
    for tier_name, agg in results_by_tier.items():
        print(f"\n{tier_name}:")
        for piece_id, pct in agg["per_piece"].items():
            print(f"  {piece_id}: {pct}%")
        print(f"  OVERALL ({tier_name}): {agg['overall']}%")

    print("\nanchors:")
    for name, pct in anchor_results.items():
        print(f"  {name}: {pct}%")
    print("=" * 70)
    return 0


def load_anchor_cases(anchors_dir: Path) -> dict:
    """
    Discovers every subdirectory of `anchors_dir` containing a
    ground_truth.json and at least one page{N}.png, and loads them.
    Returns {anchor_name: {"pages": [Path, ...], "ground_truth": {...}}}.
    """
    anchors = {}
    if not anchors_dir.exists():
        return anchors
    for sub in sorted(anchors_dir.iterdir()):
        if not sub.is_dir():
            continue
        gt_path = sub / "ground_truth.json"
        pages = sorted(sub.glob("page*.png"))
        if not gt_path.exists() or not pages:
            continue
        with open(gt_path) as f:
            ground_truth = json.load(f)
        anchors[sub.name] = {"pages": pages, "ground_truth": ground_truth}
    return anchors


if __name__ == "__main__":
    sys.exit(main())
