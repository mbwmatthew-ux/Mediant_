"""
Re-decide flags from a stored evidence bundle, offline.

Why this exists
---------------
Changing a threshold in worker.py and finding out whether it helped used to
require re-running the whole pipeline — CREPE, Gemini, Claude — against real
recordings, which costs money, takes minutes per take, and is non-deterministic
on the LLM legs. So thresholds got changed on intuition. The Gotchas file
records one being rewritten three times before being reverted unshipped.

A bundle already contains every measurement that decided every flag. Replaying
it answers "what would this take have reported at threshold X?" in milliseconds,
deterministically, for as many takes as the corpus holds.

This is deliberately NOT a re-implementation of the detectors. It re-applies the
final numeric gate to an already-measured value. Anything that changes what gets
MEASURED (a new window, a different pitch model) needs a real re-run — replay
covers threshold work, which is the bulk of calibration.
"""

# Defaults mirror worker.py. Keep them in sync when a threshold moves; the test
# suite pins the ones that matter.
DEFAULT_THRESHOLDS = {
    "placement_ms":   110.0,   # _TIMING_PLACEMENT_MS
    "drift_pct":        7.0,   # _TIMING_DRIFT_PCT
    "duration_ms":    140.0,   # _TIMING_DUR_MIN_MS
    "cents":            8.0,   # cents_flag_threshold, tightest (unfretted strings)
    "dynamics_db":      3.0,   # _DYN_MIN_DB
}

_RULE_TO_THRESHOLD = {
    "placement":              "placement_ms",
    "drift":                  "drift_pct",
    "durations":              "duration_ms",
    "cents_vs_tuning_centre": "cents",
    "contrast":               "dynamics_db",
}


def replay_bundle(bundle: dict, thresholds: dict | None = None) -> list[dict]:
    """
    Return the flags this bundle would produce under `thresholds`.

    A flag whose rule has no numeric threshold (posture, technique, tone, wrong
    notes — all decided by gates that are not a single number) passes through
    unchanged. Filtering those on a threshold they do not have would silently
    delete whole categories from a calibration run.
    """
    t = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    out: list[dict] = []
    for f in bundle.get("flags", []):
        limit_name = _RULE_TO_THRESHOLD.get(f.get("rule") or "")
        measured = f.get("measured")
        if limit_name is not None and isinstance(measured, (int, float)):
            # "contrast" fires when the spread is BELOW the floor — every other
            # rule fires when the measurement is above it.
            fires = (abs(measured) <= t[limit_name] if f.get("rule") == "contrast"
                     else abs(measured) >= t[limit_name])
            if not fires:
                continue
        out.append(dict(f))
    return out
