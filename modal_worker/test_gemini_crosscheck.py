import sys, os
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


def main():
    test_budget_guard_stops_before_exceeding_cap()
    passed = sum(1 for r in RESULTS if r)
    total = len(RESULTS)
    print(f"\n{'='*70}\n{passed}/{total} checks passed\n{'='*70}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
