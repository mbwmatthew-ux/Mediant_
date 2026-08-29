"""
Raw measurement capture for the analysis pipeline.

Why this exists
---------------
Flags carry a prose evidence string but not the numbers behind it, and
`timing_report["notes"]` — one row per note, with the residual that decided
every timing flag — is computed, read once, and thrown away when the function
returns. So "was this flag right?" could be answered by a teacher but "what
measurement produced it?" could not be answered at all, which makes threshold
work guesswork.

This module is deliberately free of Modal, audio and network imports so it can
be tested directly and reused by the offline replay harness.
"""

BUNDLE_VERSION = 1

# Which detector owns each flag type, and whether that detector measures
# anything. "unverifiable" is not a hedge — it is the honest label for a
# category with no corroborating measurement, and Phase 4 uses it to decide what
# gets marked in the UI.
#
# A few entries are keyed by RULE rather than by type, for detectors that emit
# under a borrowed type: `find_rest_violations` produces type "timing" because
# that is the category a student reads it as, but it is not the timing fit and
# must not claim to be. `_provenance_for` prefers a rule match over the type
# match, so those entries are reachable rather than decorative — the alternative
# was letting the rest detector report itself as `analyze_timing_vs_score`.
_DETECTOR_BY_TYPE = {
    "intonation": ("run_pitch_tracking",        "measured"),
    "timing":     ("analyze_timing_vs_score",   "measured"),
    "rhythm":     ("analyze_timing_vs_score",   "measured"),
    "error":      ("find_wrong_note_candidates", "measured"),
    "dynamics":   ("analyze_dynamics_vs_score", "measured"),
    "tone":       ("gemini",                    "unverifiable"),
    "posture":    ("gemini",                    "unverifiable"),
    "technique":  ("gemini",                    "unverifiable"),
    # Keyed by rule (see above), not by flag type.
    "rest_violation": ("find_rest_violations",  "measured"),
}

_MAX_TIMING_NOTES = 2000
_MAX_EVENTS = 2000


def _provenance_for(flag: dict, timing_report, dynamics_report) -> dict:
    ftype = flag.get("type", "")
    detector, evidence_class = _DETECTOR_BY_TYPE.get(ftype, ("unknown", "unverifiable"))
    measure = flag.get("measure")

    # Prefer the rule/measurement stamped on the flag at creation time by the
    # sub-detector that actually produced it (see compare_and_coach_claude's
    # _add()). Several timing sub-types (placement/drift/durations/overall)
    # share type="timing" and only one survives (measure, type) dedup, so
    # reconstructing "which rule fired" from the report dicts alone — keyed
    # only on measure number — cannot tell which of several candidates for the
    # same measure actually won and would misattribute it. Only fall back to
    # that reconstruction when the flag predates this field (e.g. an older
    # bundle replayed offline).
    #
    # The gate is "neither field is stamped", NOT "measured is missing". Some
    # call sites legitimately stamp a rule with no number: the crack "noise"
    # variant has no "jumped N semitones" text by design, so it is stamped
    # rule="crack", measured=None. Keying only on `measured is None` sent it
    # into reconstruction, where type "error" matches no branch, and the
    # stamped rule was overwritten with None — throwing away the one thing that
    # flag DID know about itself. A stamped rule must always survive.
    rule = flag.get("rule")
    measured = flag.get("measured")

    if measured is None and rule is None:
        if ftype in ("timing", "rhythm") and isinstance(timing_report, dict) and timing_report.get("ok"):
            for name in ("placement", "drift", "durations"):
                row = (timing_report.get(name) or {}).get(measure)
                if row:
                    rule = name
                    measured = (row.get("median_ms") if name == "placement"
                                else row.get("pct") if name == "drift"
                                else row.get("delta_ms"))
                    break
        elif ftype == "intonation":
            rule = "cents_vs_tuning_centre"
            measured = flag.get("cents_deviation")
        elif ftype == "dynamics" and isinstance(dynamics_report, dict) and dynamics_report.get("ok"):
            rule = "contrast" if dynamics_report.get("contrast") else "inverted"
            measured = dynamics_report.get("spread_db")

    # A stamped rule that names a detector outranks the flag's type. Only the
    # rule knows that a "timing" flag came from the rest detector rather than
    # from the timing fit; without this the bundle would credit the wrong
    # detector, and threshold work reads these attributions.
    if rule in _DETECTOR_BY_TYPE:
        detector, evidence_class = _DETECTOR_BY_TYPE[rule]

    if measured is None:
        measured = flag.get("timing_deviation_ms")
    if measured is None:
        measured = flag.get("cents_deviation")

    return {
        "flag_key":       flag.get("flag_key"),
        "type":           ftype,
        "measure":        measure,
        "detector":       detector,
        "evidence_class": evidence_class,
        "rule":           rule,
        "measured":       measured,
        "confirmed":      bool(flag.get("confirmed")),
        "raw_detail":     str(flag.get("raw_detail") or "")[:400],
    }


def build_evidence_bundle(*, flags, timing_report, dynamics_report,
                          wrong_note_candidates, crack_candidates,
                          aligned, beats, score, alignment_method) -> dict:
    """
    Assemble everything needed to re-derive, audit or re-score this analysis.

    Bounded on purpose: this lands in a JSONB column on every take, and a long
    recording produces thousands of CREPE events. The caps keep a bundle well
    under a megabyte while preserving every per-note timing residual that
    threshold work actually reads.
    """
    tr = timing_report if isinstance(timing_report, dict) else {}
    dr = dynamics_report if isinstance(dynamics_report, dict) else {}

    timing_notes = [
        {"measure": r.get("measure"), "beat": r.get("beat"), "pitch": r.get("pitch"),
         "time_sec": round(float(r.get("time_sec") or 0.0), 3),
         "residual_ms": round(float(r.get("residual_ms") or 0.0), 1)}
        for r in (tr.get("notes") or [])[:_MAX_TIMING_NOTES]
    ]

    events = [
        {"t": round(float(e.get("time_sec") or 0.0), 3),
         "m": e.get("measure"),
         "si": e.get("score_idx"),
         "cents": e.get("cents_offset"),
         "spread": e.get("cents_spread"),
         "conf": e.get("confidence"),
         "db": e.get("db"),
         "held": e.get("held_sec")}
        for e in (aligned or [])[:_MAX_EVENTS]
    ]

    measures = score.get("measures") or []
    return {
        "version": BUNDLE_VERSION,
        "flags": [_provenance_for(f, tr, dr) for f in (flags or [])],
        "timing_notes": timing_notes,
        "timing_fit": {
            "ok": tr.get("ok", False),
            "reason": tr.get("reason"),
            "spb": tr.get("spb"),
            "bpm": tr.get("bpm"),
            "n_notes": tr.get("n_notes"),
        },
        "dynamics": {
            "ok": dr.get("ok", False),
            "reason": dr.get("reason"),
            "levels": dr.get("levels"),
            "spread_db": dr.get("spread_db"),
        },
        "candidates": {
            "wrong_notes": list(wrong_note_candidates or [])[:20],
            "cracks": list(crack_candidates or [])[:20],
        },
        "alignment": {
            "method": alignment_method,
            "n_events": len(aligned or []),
            "n_matched": sum(1 for e in (aligned or []) if e.get("score_idx") is not None),
            "tempo_bpm": (beats or {}).get("tempo_bpm"),
            "n_beats": len((beats or {}).get("beat_times") or []),
        },
        "score_parse": {
            "source": score.get("source"),
            "time_signature": score.get("time_signature"),
            "n_measures": len(measures),
            "n_notes": sum(len(m.get("notes") or []) for m in measures),
            "has_repeats": bool(score.get("has_repeats")),
        },
        "events": events,
    }
