import sys, os
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evaluate_gemini_crosscheck as egc

RESULTS = []


def check(desc, passed, detail=""):
    RESULTS.append(passed)
    print(f"  {'PASS' if passed else 'FAIL'}  {desc}" + (f"   {detail}" if detail else ""))


def test_budget_guard_stops_before_exceeding_cap():
    print("\n[1] BudgetGuard.can_spend returns False once the running total "
          "would exceed the cap, and never raises")
    guard = egc.BudgetGuard(cap_dollars=2.00)
    check("can spend $1.00 against a fresh $2.00 cap", guard.can_spend(1.00) is True)
    guard.record_spend(1.00)
    check("can spend another $0.99 (total would be $1.99)", guard.can_spend(0.99) is True)
    guard.record_spend(0.99)
    check("cannot spend $0.02 more (total would be $2.01, over cap)",
          guard.can_spend(0.02) is False)
    check("running total is exactly 1.99 so far", abs(guard.total_spent - 1.99) < 1e-9,
          str(guard.total_spent))


class _FakeResponse:
    """Looks like a real httpx.Response for a successfully billed Gemini
    call: is_success=True, real usageMetadata token counts -- but its
    text content is NOT valid JSON, simulating truncated/malformed model
    output (e.g. maxOutputTokens too small for a measure-dense piece)."""

    def __init__(self, data):
        self.is_success = True
        self.status_code = 200
        self.text = "fake response body"
        self._data = data

    def json(self):
        return self._data


class _FakeClient:
    """Stands in for httpx.Client -- no real network call is made."""

    def __init__(self, *a, **kw):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, *a, **kw):
        return _FakeResponse({
            "usageMetadata": {"promptTokenCount": 12345, "candidatesTokenCount": 6789},
            "candidates": [{"content": {"parts": [{"text": "not valid json {{{"}]}}],
        })


def test_billed_but_unparseable_response_still_reports_real_tokens():
    print("\n[2] crosscheck_score_with_gemini reports REAL (non-zero) token "
          "counts when Gemini billed a response that then fails to parse "
          "as JSON, so record_spend never silently counts a real call as $0")
    with patch("httpx.Client", _FakeClient):
        result = egc.crosscheck_score_with_gemini([], api_key="fake-key")
    check("result reports an error (unparseable text)", "error" in result, str(result))
    check("input_tokens is the real billed value, not 0",
          result.get("input_tokens") == 12345, str(result.get("input_tokens")))
    check("output_tokens is the real billed value, not 0",
          result.get("output_tokens") == 6789, str(result.get("output_tokens")))

    # Mirror main()'s accounting: record_spend must be called unconditionally,
    # using these real token counts, even though "error" is in result.
    guard = egc.BudgetGuard(cap_dollars=2.00)
    real_cost = (result.get("input_tokens", 0) * egc.GEMINI_FLASH_INPUT_PER_TOKEN +
                 result.get("output_tokens", 0) * egc.GEMINI_FLASH_OUTPUT_PER_TOKEN)
    guard.record_spend(real_cost)
    check("a billed-but-unparseable call records non-zero spend, not $0",
          guard.total_spent > 0, str(guard.total_spent))


def main():
    test_budget_guard_stops_before_exceeding_cap()
    test_billed_but_unparseable_response_still_reports_real_tokens()
    passed = sum(1 for r in RESULTS if r)
    total = len(RESULTS)
    print(f"\n{'='*70}\n{passed}/{total} checks passed\n{'='*70}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
