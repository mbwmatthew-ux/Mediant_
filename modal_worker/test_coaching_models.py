import sys, os
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evaluate_coaching_models as ecm

RESULTS = []


def check(desc, passed, detail=""):
    RESULTS.append(passed)
    print(f"  {'PASS' if passed else 'FAIL'}  {desc}" + (f"   {detail}" if detail else ""))


def test_deterministic_template_produces_the_required_fields():
    print("\n[1] deterministic_coaching_template fills title/body from the "
          "issue dict with zero LLM calls")
    issue = {"type": "intonation", "direction": "sharp", "location": "m.12",
              "note": "F#4", "cents": 34}
    result = ecm.deterministic_coaching_template(issue)
    check("has a title", bool(result.get("title")), str(result))
    check("has a body", bool(result.get("body")), str(result))
    check("title does not contain a number (matches the sharp/flat title rule)",
          not any(c.isdigit() for c in result["title"]), result["title"])
    check("title starts with Sharp or Flat for an intonation issue",
          result["title"].startswith(("Sharp", "Flat")), result["title"])


class _FakeUsage:
    """Looks like a real anthropic Usage object for a successfully billed
    call -- real, non-zero token counts."""
    input_tokens = 12345
    output_tokens = 6789


class _FakeContentBlock:
    """Looks like a real content block, but its text is NOT valid JSON,
    simulating truncated/malformed model output."""
    type = "text"
    text = "not valid json {{{"


class _FakeMessage:
    content = [_FakeContentBlock()]
    usage = _FakeUsage()


class _FakeMessages:
    def create(self, **kwargs):
        return _FakeMessage()


class _FakeAnthropic:
    """Stands in for anthropic.Anthropic -- no real network call is made."""

    def __init__(self, *a, **kw):
        self.messages = _FakeMessages()


def test_billed_but_unparseable_response_still_reports_real_tokens():
    print("\n[2] coach_with_model reports REAL (non-zero) token counts when "
          "Claude billed a response that then fails to parse as JSON, so "
          "main()'s record_spend never silently counts a real call as $0")
    with patch("anthropic.Anthropic", _FakeAnthropic):
        result = ecm.coach_with_model(
            "claude-sonnet-5",
            {"type": "intonation", "direction": "sharp", "location": "m.12",
             "note": "F#4", "cents": 34},
            "violin", "Partita No. 3", "J.S. Bach", api_key="fake-key")
    check("result reports an error (unparseable text)", "error" in result, str(result))
    check("input_tokens is the real billed value, not 0",
          result.get("input_tokens") == 12345, str(result.get("input_tokens")))
    check("output_tokens is the real billed value, not 0",
          result.get("output_tokens") == 6789, str(result.get("output_tokens")))

    # Mirror main()'s accounting: record_spend must be called unconditionally,
    # using these real token counts, even though "error" is in result.
    from evaluate_gemini_crosscheck import BudgetGuard
    guard = BudgetGuard(cap_dollars=3.00)
    in_price, out_price = ecm.PRICING_PER_MILLION_TOKENS["claude-sonnet-5"]
    real_cost = (result.get("input_tokens", 0) * in_price / 1_000_000 +
                 result.get("output_tokens", 0) * out_price / 1_000_000)
    guard.record_spend(real_cost)
    check("a billed-but-unparseable call records non-zero spend, not $0",
          guard.total_spent > 0, str(guard.total_spent))


def main():
    test_deterministic_template_produces_the_required_fields()
    test_billed_but_unparseable_response_still_reports_real_tokens()
    passed = sum(1 for r in RESULTS if r)
    total = len(RESULTS)
    print(f"\n{'='*70}\n{passed}/{total} checks passed\n{'='*70}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
