"""
Track A (mentor-recommended, production-accuracy benchmark): a cost PROBE
for validate_score_reading_against_corpus.py -- runs the REAL production
read_score_notes_claude (Claude's 2-3-way cross-validated read, plus
Audiveris and resolve_measure_disagreement) against exactly ONE piece,
and reports the REAL dollar cost, before committing to a multi-piece run.

Why this exists as its own script rather than just calling
validate_score_reading_against_corpus.py directly: that script has NO
spend cap and no cost accounting at all -- it was built to be run by a
developer watching the terminal, not under a hard budget. read_score_notes
_claude is far heavier than the single-call experiments in Tasks 4/5 (its
own docstring: always 3 parallel Claude vision calls at max_tokens=64000
each, plus up to _RESOLUTION_CALL_CAP additional calls at max_tokens=2000
each for disagreements) -- worst-case cost per piece could be several
dollars, nothing like the few cents per call seen in the Gemini/coaching
experiments. Rather than guess at a safe multi-piece cap, this probes ONE
real piece first and reports the real cost, so a multi-piece run can be
budgeted from real data instead of a worst-case estimate that could be
wildly pessimistic (as it has been for every other experiment this
session) or, just as easily, not pessimistic enough.

Does NOT modify read_score_notes_claude or any other production code --
purely observes its EXISTING [cost] print lines (worker.py:5142, 7050) by
capturing stdout, so this has zero effect on production behavior.
"""
import io
import json
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from validate_score_reading_against_corpus import (  # noqa: E402 -- needs the real modal/music21/etc. stack; run in the validation venv.
    _call_read_score_notes_with_one_retry, score_measures)

# Sonnet 5 pricing, per this session's own verified research: $2/$10 per 1M
# input/output tokens. Every real [cost] line this probe parses is a Sonnet
# 5 call (_call_claude_score_batch and resolve_measure_disagreement both
# hardcode model="claude-sonnet-5" internally -- confirmed in worker.py).
SONNET5_INPUT_PER_TOKEN = 2.00 / 1_000_000
SONNET5_OUTPUT_PER_TOKEN = 10.00 / 1_000_000

_COST_LINE = re.compile(
    r"\[cost\] (\S+) model=(\S+).*?input_tokens=(\d+) output_tokens=(\d+)")


def probe_one_piece(piece_id: str, corpus_dir: Path, ground_truth: dict,
                     anthropic_key: str) -> dict:
    """
    Runs read_score_notes_claude for real against one piece's clean-tier
    pages, capturing stdout to parse every real [cost] line it printed
    (one per underlying Claude call -- 3 for the parallel reads, plus one
    per resolve_measure_disagreement call). Returns {"piece_id",
    "n_correct", "n_total", "real_cost_dollars", "num_claude_calls",
    "captured_output"} -- captured_output is also echoed to real stdout
    before returning, so nothing about the real run is hidden.
    """
    gt_entry = ground_truth[piece_id]
    page_paths = sorted((corpus_dir / "clean").glob(f"{piece_id}_page*.png"))
    pages = [(p.read_bytes(), "image/png") for p in page_paths]

    buf = io.StringIO()
    with redirect_stdout(buf):
        time_sig_hint = gt_entry.get("time_signature") or "4/4"
        result = _call_read_score_notes_with_one_retry(
            pages, anthropic_key, piece_id, time_sig=time_sig_hint)
    captured = buf.getvalue()
    print(captured, end="")  # echo the real run's own output, unmodified

    real_cost = 0.0
    num_calls = 0
    for match in _COST_LINE.finditer(captured):
        _source, _model, input_tokens, output_tokens = match.groups()
        real_cost += (int(input_tokens) * SONNET5_INPUT_PER_TOKEN
                      + int(output_tokens) * SONNET5_OUTPUT_PER_TOKEN)
        num_calls += 1

    if result is None:
        n_correct, n_total, predicted_measures = 0, len(gt_entry["measures"]), []
    else:
        predicted_measures = result.get("measures") or []
        n_correct, n_total = score_measures(
            predicted_measures, gt_entry["measures"], gt_entry["time_signature"])

    return {"piece_id": piece_id, "n_correct": n_correct, "n_total": n_total,
            "real_cost_dollars": round(real_cost, 4), "num_claude_calls": num_calls,
            # Real predicted measures, saved so a wrong-but-not-flagged
            # result (e.g. a measure that "resolved" but is still wrong
            # against ground truth) can be diagnosed offline afterward,
            # without needing another paid call just to look at the
            # content -- exactly the gap found probing piece 2243 after
            # the compound-meter fix: duration overshoots dropped to zero,
            # but accuracy stayed at 0%, and there was no saved content to
            # inspect why.
            "predicted_measures": predicted_measures,
            "ground_truth_measures": gt_entry["measures"]}


def main():
    import os
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if not anthropic_key:
        print("ANTHROPIC_API_KEY not set -- export it and re-run.")
        return 1

    corpus_dir = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus")
    with open(corpus_dir / "ground_truth.json") as f:
        ground_truth = json.load(f)

    # Smallest single-page piece in the fast-iteration subset -- cheapest
    # possible real probe (fewest row crops -> fewest image tokens, and no
    # multi-page batching to worry about).
    piece_id = "2243"

    print(f"Probing real cost for ONE piece ({piece_id}) via the real "
          f"production read_score_notes_claude...\n")
    # _call_read_score_notes_with_one_retry (called inside probe_one_piece)
    # already wraps its own call in `with w.app.run():` -- wrapping it again
    # here raised a real "App is already running" InvalidError on both
    # attempts of the first real probe run (confirmed: zero Claude calls
    # were made, zero cost incurred -- it failed before ever reaching the
    # API). Modal's app context is not reentrant.
    probe_result = probe_one_piece(piece_id, corpus_dir, ground_truth, anthropic_key)

    pct = round(100 * probe_result["n_correct"] / probe_result["n_total"], 2) \
        if probe_result["n_total"] else 0.0
    print(f"\n{'=' * 70}")
    print(f"  piece {probe_result['piece_id']}: "
          f"{probe_result['n_correct']}/{probe_result['n_total']} "
          f"measures correct ({pct}%)")
    print(f"  real Claude calls made: {probe_result['num_claude_calls']}")
    print(f"  REAL cost for this one piece: ${probe_result['real_cost_dollars']}")
    print(f"{'=' * 70}")

    out_path = Path(__file__).parent / f"probe_result_{piece_id}.json"
    out_path.write_text(json.dumps(probe_result, indent=2))
    print(f"\nFull predicted + ground-truth measures written to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
