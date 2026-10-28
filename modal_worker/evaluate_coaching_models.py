"""
Phase 2 experiment: compares coaching-text quality and cost across three
arms for the same synthetic issue list -- Sonnet 5 (current production
model), Haiku 5.5 (candidate), and a deterministic template (zero LLM
cost, measures how much value the language model adds above free string
formatting). See spec Section 4 ("Testing -- three arms, not two").

Does NOT call or modify compare_and_coach_claude in worker.py -- this is
an isolated prompt experiment reusing that function's exact prompt text
and JSON schema, confirmed separately so this experiment can never affect
a real analysis.
"""
import json
from pathlib import Path


def deterministic_coaching_template(issue: dict) -> dict:
    """
    Zero-LLM-cost baseline. Fills a fixed string template from the issue's
    own fields -- mirrors compare_and_coach_claude's own title-formatting
    rule for intonation issues (worker.py:9617's "Sharp"/"Flat" prefix
    requirement, no digits in the title) so this arm is a fair baseline
    against the SAME hard constraints the LLM arms must satisfy, not a
    strawman.
    """
    issue_type = issue.get("type", "issue")
    location = issue.get("location", "")
    if issue_type == "intonation":
        direction = issue.get("direction", "sharp").capitalize()
        note = issue.get("note", "a note")
        # The title rule bans digits (worker.py:9617): a raw scientific-
        # pitch note like "F#4" carries its octave as a digit, so strip
        # digits for the title only -- the octave still appears in the
        # body, same as the rest of the cents/register detail.
        title_note = "".join(c for c in note if not c.isdigit()) or note
        title = f"{direction} on {title_note}"
        body = (f"Your {note} at {location} was {issue.get('cents', '?')} cents "
                f"{issue.get('direction', 'off')}. Practice that interval slowly "
                f"with a tuner until it locks in.")
    else:
        title = f"{issue_type.capitalize()} issue at {location}"
        body = f"Review {location} for a {issue_type} discrepancy and repeat it slowly."
    return {"title": title, "body": body}


def coach_with_model(model_id: str, issue: dict, instrument: str,
                      piece_title: str, composer: str, api_key: str) -> dict:
    """
    Calls Claude (any model_id) with the EXACT same prompt shape
    compare_and_coach_claude uses (worker.py:9600-9632), for one issue,
    so output is directly comparable to what production would say for the
    same input under a different model.
    """
    import anthropic as ac

    issue_line = json.dumps({"i": 0, **issue})
    coach_prompt = f"""You are a master {instrument} teacher writing feedback on a student's performance of "{piece_title}" by {composer}.

Below is the VERIFIED list of issues found in the performance. Write specific coaching for EACH issue. Do NOT add, remove, merge, reorder, or skip any — return exactly one coaching entry per issue, matched by its index "i".

Every issue below is CONFIRMED — state it as fact. Never use hedging language like "possible", "may have", "appears to", or "worth checking".

For "intonation" issues, the title MUST begin with the word "Sharp" or "Flat" (whichever the "observed" text says), followed by 2-5 words naming WHERE it happened. NEVER put a number, a cents value, or the words "slightly"/"very" in an intonation title.

ISSUES:
{issue_line}

WRITE TIGHT. The body is 2 sentences, 40 words maximum.

Return JSON only (no markdown):
{{"coaching": [{{"i": <index>, "title": "<4-8 word title naming the exact issue>", "body": "<2 sentences, 40 words max>"}}]}}"""

    try:
        client = ac.Anthropic(api_key=api_key)
        msg = client.messages.create(
            model=model_id, max_tokens=4000,
            messages=[{"role": "user", "content": coach_prompt}],
        )
        raw = "".join(block.text for block in msg.content if block.type == "text")
        parsed = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
        coaching = parsed.get("coaching", [{}])[0]
        usage = getattr(msg, "usage", None)
        return {
            "title": coaching.get("title", ""),
            "body": coaching.get("body", ""),
            "input_tokens": usage.input_tokens if usage else 0,
            "output_tokens": usage.output_tokens if usage else 0,
        }
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


# Anthropic pricing, per this session's own verified research against
# Anthropic's current pricing page: Sonnet 5 $2/$10 per 1M tokens,
# Haiku 5.5 $0.10/$0.50 per 1M tokens (prompts under 100K tokens).
PRICING_PER_MILLION_TOKENS = {
    "claude-sonnet-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),
}


def main():
    import os
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from evaluate_gemini_crosscheck import BudgetGuard

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ANTHROPIC_API_KEY not set -- export it and re-run.")
        return 1

    guard = BudgetGuard(cap_dollars=3.00)
    sample_issues = [
        {"type": "intonation", "direction": "sharp", "location": "m.12",
         "note": "F#4", "cents": 34},
        {"type": "rhythm", "location": "m.25-27", "note": "the dotted rhythm"},
        {"type": "intonation", "direction": "flat", "location": "m.8",
         "note": "the sustained high A", "cents": 22},
    ]

    for issue in sample_issues:
        print(f"\n--- issue: {issue} ---")
        template_result = deterministic_coaching_template(issue)
        print(f"  [template]    title={template_result['title']!r}")
        print(f"                body={template_result['body']!r}")

        for model_id in ("claude-sonnet-5", "claude-haiku-5-5"):
            in_price, out_price = PRICING_PER_MILLION_TOKENS[model_id]
            estimated_cost = 500 * in_price / 1_000_000 + 200 * out_price / 1_000_000
            if not guard.can_spend(estimated_cost):
                print(f"  [{model_id}] skipped: would exceed ${guard.cap_dollars} cap")
                continue
            result = coach_with_model(model_id, issue, "violin", "Partita No. 3",
                                       "J.S. Bach", api_key)
            if "error" in result:
                print(f"  [{model_id}] error: {result['error']}")
                continue
            real_cost = (result["input_tokens"] * in_price / 1_000_000 +
                         result["output_tokens"] * out_price / 1_000_000)
            guard.record_spend(real_cost)
            print(f"  [{model_id}] title={result['title']!r}")
            print(f"                body={result['body']!r}")
            print(f"                cost=${real_cost:.5f}, running total=${guard.total_spent:.4f}")

    print(f"\nTotal spent: ${guard.total_spent:.4f} of ${guard.cap_dollars:.2f} cap")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
