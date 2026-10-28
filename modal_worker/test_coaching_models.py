import sys, os
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


def main():
    test_deterministic_template_produces_the_required_fields()
    passed = sum(1 for r in RESULTS if r)
    total = len(RESULTS)
    print(f"\n{'='*70}\n{passed}/{total} checks passed\n{'='*70}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
