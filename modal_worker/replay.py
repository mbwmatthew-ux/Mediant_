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
it answers a threshold question in milliseconds, deterministically, for as many
takes as the corpus holds.

What this can and cannot answer
-------------------------------
`replay_bundle` FILTERS `bundle["flags"]` — the flags that already shipped. So
the question it actually answers is:

    "which already-shipped flags survive at threshold X?"

NOT "what would this take have reported at threshold X?". Those differ, and the
difference is the tool's main limit:

  * TIGHTENING a threshold is measurable. Flags that no longer clear the higher
    bar drop out, so the effect on PRECISION can be estimated.
  * LOOSENING a threshold is NOT measurable. A flag that was never emitted is
    not in `bundle["flags"]`, so nothing here can bring it back. RECALL — the
    direction Phase 2 most wants to improve — is therefore the one thing this
    harness cannot measure.

`bundle["timing_notes"]` and `bundle["events"]` do carry the raw residuals and
cents that would in principle let a looser gate be evaluated, but doing so means
RE-DERIVING flags from those arrays, which this harness deliberately does not
do. Whoever needs a loosening measured has to write that re-derivation (or run
the real pipeline); do not read a replay sweep as if it had covered it.

Separately, and for the same reason: this is not a re-implementation of the
detectors. It re-applies the final numeric gate to an already-measured value.
Anything that changes what gets MEASURED (a new window, a different pitch
model) needs a real re-run.
"""

from evidence import BUNDLE_VERSION

# Defaults mirror worker.py. Keep them in sync when a threshold moves; the test
# suite pins the ones that matter. NOTE: nothing enforces this — the bundle does
# not record the thresholds that were live when it was written, so this table is
# a hand-maintained mirror and has drifted from production before.
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
    # The piece-level tempo trend is gated on the SAME _TIMING_DRIFT_PCT as
    # per-measure drift in worker.py, but emitted with rule="overall". Without
    # this entry those flags passed through unfiltered, so sweeping drift_pct
    # moved "drift" flags and silently left "overall" ones in place — a wrong
    # number rather than an error.
    "overall":                "drift_pct",
    "durations":              "duration_ms",
    "cents_vs_tuning_centre": "cents",
    "contrast":               "dynamics_db",
    # "inverted" is deliberately ABSENT: worker.py gates it on a separate
    # _DYN_INVERT_DB constant, not _DYN_MIN_DB, so mapping it to "dynamics_db"
    # would sweep it against a threshold it does not use. Replay exposes no knob
    # for _DYN_INVERT_DB at all; adding one means adding the constant to
    # DEFAULT_THRESHOLDS too, not reusing this key.
}


def replay_bundle(bundle: dict, thresholds: dict | None = None) -> list[dict]:
    """
    Return the subset of this bundle's already-shipped flags that still fire
    under `thresholds`. See the module docstring: this can measure a
    TIGHTENING, and cannot measure a LOOSENING (or therefore recall).

    A flag whose rule has no numeric threshold (posture, technique, tone, wrong
    notes — all decided by gates that are not a single number) passes through
    unchanged. Filtering those on a threshold they do not have would silently
    delete whole categories from a calibration run.

    Raises ValueError on a bundle that is not a well-formed version-1 bundle.
    Loud is correct here: when bundle-building throws, worker.py stores
    {"version": 0, "error": ...} with NO "flags" key, and quietly returning []
    for that is indistinguishable from "this take genuinely had zero flags" —
    so a corpus sweep would under-count by however many analyses errored and
    never say so. A wrong number is worse than no number.
    """
    if not isinstance(bundle, dict):
        raise ValueError(f"replay_bundle: expected a bundle dict, got {type(bundle).__name__}")
    version = bundle.get("version")
    if version != BUNDLE_VERSION:
        raise ValueError(
            f"replay_bundle: unsupported bundle version {version!r} "
            f"(expected {BUNDLE_VERSION}). A version 0 bundle is the error "
            f"record worker.py writes when bundle-building failed: "
            f"{str(bundle.get('error'))[:200]!r}"
        )
    if "flags" not in bundle:
        raise ValueError(
            "replay_bundle: bundle has no 'flags' key. Refusing to treat a "
            "malformed bundle as a take with zero flags."
        )

    t = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    out: list[dict] = []
    for f in bundle["flags"] or []:
        limit_name = _RULE_TO_THRESHOLD.get(f.get("rule") or "")
        measured = f.get("measured")
        if limit_name is not None and isinstance(measured, (int, float)):
            # "contrast" fires when the spread is BELOW the floor — every other
            # rule fires when the measurement is above it. Strict `<` mirrors
            # production's `spread < _DYN_MIN_DB` exactly: at the boundary
            # (spread == floor) production does NOT flag, and threshold sweeps
            # land on round numbers by construction, so this boundary gets hit.
            fires = (abs(measured) < t[limit_name] if f.get("rule") == "contrast"
                     else abs(measured) >= t[limit_name])
            if not fires:
                continue
        out.append(dict(f))
    return out
