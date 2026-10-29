"""
Phase 2 experiment: compares coaching-text quality and cost across three
arms for the same synthetic issue list -- Sonnet 5 (current production
model), Haiku 5.5 (candidate), and a deterministic template (zero LLM
cost, measures how much value the language model adds above free string
formatting). See spec Section 4 ("Testing -- three arms, not two").

Does NOT call or modify compare_and_coach_claude in worker.py -- this is
an isolated prompt experiment reusing that function's prompt content
(every hard constraint carried over; see coach_with_model's docstring for
the two intentionally-dropped, non-information-bearing paragraphs) and
JSON schema, confirmed separately so this experiment can never affect a
real analysis.
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
    Calls Claude (any model_id) with the same prompt content
    compare_and_coach_claude uses (worker.py:9608-9632), adapted for a
    single synthetic issue instead of a real multi-issue batch, so output
    is directly comparable to what production would say for the same
    input under a different model. Carries over every hard constraint
    from the real prompt verbatim -- the measure-authority/anti-
    hallucination guardrail, the Sharp/Flat intonation title rule, the
    tight-body rule, and the JSON schema. Drops only the optional
    `user_note` conditional line (batching-specific) and the closing
    "Cut everything else" / "Keep all specifics" style paragraphs (general
    writing-style enforcement, not information content being compared
    here) -- not a byte-exact copy, but close enough that this is a fair,
    production-representative comparison.
    """
    import anthropic as ac

    issue_line = json.dumps({"i": 0, **issue})
    coach_prompt = f"""You are a master {instrument} teacher writing feedback on a student's performance of "{piece_title}" by {composer}.

Below is the VERIFIED list of issues found in the performance. Write specific coaching for EACH issue. Do NOT add, remove, merge, reorder, or skip any — return exactly one coaching entry per issue, matched by its index "i".

The location given for each issue (e.g. "m.25" or "m.25-27") is the VERIFIED, authoritative measure — it was computed from the recording's timing, not read off the page, so trust it completely. If the "observed" text for an issue mentions a different measure number, that is a stale/incorrect reference — ignore it and use ONLY the given location in your title and body. Never cite a measure number in your response other than the one given for that issue.

Every issue below is CONFIRMED — state it as fact. Never use hedging language like "possible", "may have", "appears to", or "worth checking".
Use ONLY the musical facts given in "observed". Never introduce notation that is not stated there — in particular never mention a rest, a repeat, a key change, a dynamic marking, an articulation or a tempo marking unless that exact word appears in "observed". You are not shown the score and cannot see what is on the page; asserting notation you were not given is the single fastest way to lose a musician's trust.

For "intonation" issues, the title MUST begin with the word "Sharp" or "Flat" (whichever the "observed" text says), followed by 2-5 words naming WHERE it happened — the note, register, or gesture. Examples of the right shape: "Flat on the sustained high notes", "Sharp entering the descending run", "Flat across the slurred leap". NEVER put a number, a cents value, or the words "slightly"/"very" in an intonation title — how far off it is belongs in the body, not the headline. Do not name the measure in the title.

ISSUES:
{issue_line}

WRITE TIGHT. The body is 2 sentences, 40 words maximum:
  1. What went wrong, concretely — the note, beat, interval, or cents value from "observed". Name the specific thing, not the category.
  2. What to do about it — one practice instruction the student can act on today.

Return JSON only (no markdown):
{{"coaching": [{{"i": <index>, "title": "<4-8 word title naming the exact issue>", "body": "<2 sentences, 40 words max>"}}]}}"""

    input_tokens = output_tokens = 0
    try:
        client = ac.Anthropic(api_key=api_key)
        msg = client.messages.create(
            model=model_id, max_tokens=4000,
            messages=[{"role": "user", "content": coach_prompt}],
        )
        # Capture usage immediately after the billed call returns, BEFORE
        # any parsing that can raise -- a parse failure on an already-
        # billed call must never cause its real tokens to go unrecorded
        # (the caller's BudgetGuard depends on input_tokens/output_tokens
        # being accurate even on the error path below).
        usage = getattr(msg, "usage", None)
        if usage is not None:
            input_tokens = usage.input_tokens
            output_tokens = usage.output_tokens
        raw = "".join(block.text for block in msg.content if block.type == "text")
        parsed = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
        coaching = parsed.get("coaching", [{}])[0]
        return {
            "title": coaching.get("title", ""),
            "body": coaching.get("body", ""),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }
    except Exception as e:
        # input_tokens/output_tokens are real (non-zero) here if the API
        # call itself succeeded and only the response parsing failed --
        # e.g. truncated/malformed JSON after an already-billed call.
        return {"error": f"{type(e).__name__}: {e}",
                "input_tokens": input_tokens, "output_tokens": output_tokens}


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
            # Record real spend unconditionally, BEFORE checking for an
            # error -- a billed call that fails to parse still spent real
            # money, and the cap must see it (coach_with_model returns real
            # input_tokens/output_tokens on that path, zero only if the API
            # call itself never returned).
            real_cost = (result.get("input_tokens", 0) * in_price / 1_000_000 +
                         result.get("output_tokens", 0) * out_price / 1_000_000)
            guard.record_spend(real_cost)
            if "error" in result:
                print(f"  [{model_id}] error: {result['error']} "
                      f"(cost=${real_cost:.5f}, running total=${guard.total_spent:.4f})")
                continue
            print(f"  [{model_id}] title={result['title']!r}")
            print(f"                body={result['body']!r}")
            print(f"                cost=${real_cost:.5f}, running total=${guard.total_spent:.4f}")

    print(f"\nTotal spent: ${guard.total_spent:.4f} of ${guard.cap_dollars:.2f} cap")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
