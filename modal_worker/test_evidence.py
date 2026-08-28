"""Tests for the evidence bundle. No audio, no network, no API keys."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evidence import build_evidence_bundle

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))
    return ok


def test_bundle_is_json_safe_and_bounded():
    print("\n[1] bundle is JSON-serialisable and bounded")
    import json
    bundle = build_evidence_bundle(
        flags=[{"flag_key": "timing:20", "type": "timing", "measure": 20,
                "timing_deviation_ms": 130.0}],
        timing_report={"ok": True, "spb": 0.5, "bpm": 120.0, "n_notes": 40,
                       "placement": {20: {"median_ms": 130.0, "worst_ms": 150.0,
                                          "direction": "late", "n": 3}},
                       "drift": {}, "durations": {}, "overall": None,
                       "notes": [{"measure": 20, "beat": 1.0, "pitch": "C4",
                                  "time_sec": 1.0, "residual_ms": 130.0}] * 5000},
        dynamics_report={"ok": True, "levels": {"p": -30.1, "f": -18.4},
                         "spread_db": 11.7, "contrast": None, "inverted": []},
        wrong_note_candidates=[], crack_candidates=[],
        aligned=[{"time_sec": 1.0, "measure": 20, "score_idx": 3,
                  "cents_offset": 12, "confidence": 88}],
        beats={"tempo_bpm": 119.4, "beat_times": [0.0, 0.5, 1.0]},
        score={"source": "music21", "time_signature": "3/4",
               "measures": [{"number": 20, "notes": [{"pitch": "C4"}]}],
               "has_repeats": False},
        alignment_method="score_dtw",
    )
    raw = json.dumps(bundle)
    check("serialises", isinstance(raw, str))
    check("timing_notes capped", len(bundle["timing_notes"]) <= 2000,
          str(len(bundle["timing_notes"])))
    check("under 1 MB", len(raw) < 1_000_000, f"{len(raw):,} bytes")


def test_every_flag_gets_provenance():
    print("\n[2] every flag is traceable to a measurement")
    bundle = build_evidence_bundle(
        flags=[
            {"flag_key": "timing:20", "type": "timing", "measure": 20,
             "timing_deviation_ms": 130.0},
            {"flag_key": "posture:20", "type": "posture", "measure": 20},
        ],
        timing_report={"ok": True, "spb": 0.5, "bpm": 120.0, "n_notes": 40,
                       "placement": {20: {"median_ms": 130.0, "worst_ms": 150.0,
                                          "direction": "late", "n": 3}},
                       "drift": {}, "durations": {}, "overall": None, "notes": []},
        dynamics_report={"ok": False, "reason": "no markings"},
        wrong_note_candidates=[], crack_candidates=[], aligned=[],
        beats={"tempo_bpm": 120.0, "beat_times": []},
        score={"source": "music21", "measures": []}, alignment_method="score_dtw",
    )
    prov = {p["flag_key"]: p for p in bundle["flags"]}
    check("all flags present", len(prov) == 2, str(sorted(prov)))
    check("measured flag names its detector",
          prov["timing:20"]["detector"] == "analyze_timing_vs_score",
          prov["timing:20"]["detector"])
    check("measured flag carries the number",
          prov["timing:20"]["measured"] == 130.0, str(prov["timing:20"]["measured"]))
    # The honest half: an unverifiable flag must SAY it is unverifiable rather
    # than carry a blank that reads like a missing measurement.
    check("posture is marked unverifiable",
          prov["posture:20"]["evidence_class"] == "unverifiable",
          prov["posture:20"]["evidence_class"])


def main():
    test_bundle_is_json_safe_and_bounded()
    test_every_flag_gets_provenance()
    failed = [r for r in RESULTS if not r[1]]
    print("\n" + "=" * 70)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    print("=" * 70)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
