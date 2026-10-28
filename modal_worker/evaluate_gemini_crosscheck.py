"""
Phase 2 experiment: tests whether evaluate_with_gemini's existing
video+score call (worker.py's `evaluate_with_gemini`) can be extended to
ALSO return a broader, unconditional score-crosscheck field, reconciled
against the corpus's ground truth afterward -- WITHOUT changing the real
evaluate_with_gemini function. See spec Section 3's "Gemini cross-check
extension" bullet for why this must be a broader unconditional crosscheck
(not targeted at specific uncertain measures) to respect the real parallel
pipeline structure.

Does NOT import or call the production evaluate_with_gemini -- this is an
isolated prompt experiment against the same gemini-2.5-flash model,
confirmed separately so a failure here can never affect real analyses.
"""
import base64
import json
from pathlib import Path


class BudgetGuard:
    """Tracks running API spend in dollars; never raises, only reports
    whether the NEXT call would exceed the cap, so callers can stop
    cleanly instead of finding out after an overspend."""

    def __init__(self, cap_dollars: float):
        self.cap_dollars = cap_dollars
        self.total_spent = 0.0

    def can_spend(self, estimated_dollars: float) -> bool:
        return self.total_spent + estimated_dollars <= self.cap_dollars

    def record_spend(self, actual_dollars: float) -> None:
        self.total_spent += actual_dollars


# gemini-2.5-flash pricing, per this session's own verified research:
# $0.30/1M input tokens (text/image/video), $2.50/1M output tokens.
GEMINI_FLASH_INPUT_PER_TOKEN = 0.30 / 1_000_000
GEMINI_FLASH_OUTPUT_PER_TOKEN = 2.50 / 1_000_000


def crosscheck_score_with_gemini(page_paths: list[Path], api_key: str) -> dict:
    """
    Sends every page to gemini-2.5-flash with a prompt asking for an
    unconditional, whole-score measure crosscheck (not targeted at specific
    measures -- see module docstring for why). Returns
    {"measures": [...], "input_tokens": int, "output_tokens": int} on
    success, {"error": ...} on failure.
    """
    import httpx

    parts = []
    for p in page_paths:
        b64 = base64.b64encode(p.read_bytes()).decode()
        parts.append({"inlineData": {"mimeType": "image/png", "data": b64}})
    prompt = (
        "You are cross-checking a sheet music transcription. For EVERY "
        "measure visible across all provided pages, report the notes you "
        "see: pitch (e.g. 'C4'), whether it's a rest, the beat it starts "
        "on, and its duration in beats. Return ONLY valid JSON, no markdown:\n"
        '{"measures": [{"number": <int>, "notes": [{"pitch": <str or null>, '
        '"is_rest": <bool>, "beat": <float>, "duration_beats": <float>}]}]}'
    )
    parts.append({"text": prompt})

    try:
        with httpx.Client(timeout=60) as client:
            resp = client.post(
                "https://generativelanguage.googleapis.com/v1beta/models/"
                f"gemini-2.5-flash:generateContent?key={api_key}",
                json={
                    "contents": [{"parts": parts}],
                    "generationConfig": {"temperature": 0, "maxOutputTokens": 8192,
                                          "responseMimeType": "application/json"},
                },
            )
        if not resp.is_success:
            return {"error": f"HTTP {resp.status_code}: {resp.text[:300]}"}
        data = resp.json()
        usage = data.get("usageMetadata", {})
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
        return {
            "measures": parsed.get("measures", []),
            "input_tokens": usage.get("promptTokenCount", 0),
            "output_tokens": usage.get("candidatesTokenCount", 0),
        }
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


def main():
    import os
    import sys

    api_key = os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key:
        print("GOOGLE_AI_API_KEY not set -- export it and re-run.")
        return 1

    sys.path.insert(0, str(Path(__file__).parent))
    from validate_score_reading_against_corpus import score_measures, FAST_ITERATION_SUBSET

    corpus_dir = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus")
    with open(corpus_dir / "ground_truth.json") as f:
        ground_truth = json.load(f)

    guard = BudgetGuard(cap_dollars=2.00)
    # Conservative per-call estimate: ~5000 input tokens (2 pages), ~4000
    # output tokens -- refined after the first real call's actual usage.
    estimated_call_cost = 5000 * GEMINI_FLASH_INPUT_PER_TOKEN + 4000 * GEMINI_FLASH_OUTPUT_PER_TOKEN

    for piece_id in FAST_ITERATION_SUBSET:
        if piece_id not in ground_truth:
            continue
        if not guard.can_spend(estimated_call_cost):
            print(f"Stopping before {piece_id}: would exceed ${guard.cap_dollars} cap "
                  f"(spent ${guard.total_spent:.4f} so far)")
            break
        page_paths = sorted(corpus_dir.glob(f"clean/{piece_id}_page*.png"))
        if not page_paths:
            continue
        result = crosscheck_score_with_gemini(page_paths, api_key)
        if "error" in result:
            print(f"  [{piece_id}] error: {result['error']}")
            continue
        real_cost = (result["input_tokens"] * GEMINI_FLASH_INPUT_PER_TOKEN +
                     result["output_tokens"] * GEMINI_FLASH_OUTPUT_PER_TOKEN)
        guard.record_spend(real_cost)
        n_correct, n_total = score_measures(
            result["measures"], ground_truth[piece_id]["measures"],
            ground_truth[piece_id]["time_signature"])
        pct = round(100 * n_correct / n_total, 2) if n_total else 0.0
        print(f"  [{piece_id}] {n_correct}/{n_total} measures correct ({pct}%), "
              f"cost=${real_cost:.4f}, running total=${guard.total_spent:.4f}")

    print(f"\nTotal spent: ${guard.total_spent:.4f} of ${guard.cap_dollars:.2f} cap")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
