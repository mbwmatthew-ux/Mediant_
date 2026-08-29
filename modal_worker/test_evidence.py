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


def test_stamped_rule_beats_reconstruction():
    print("\n[3] a flag's own stamped rule/measured wins over reconstruction")
    # Two timing sub-detectors both have a row for measure 20 (placement AND
    # durations). Reconstructing provenance from the report dicts alone always
    # picks "placement" first (see the fixed priority order in
    # _provenance_for's fallback) regardless of which sub-detector's finding
    # actually survived (measure, type) dedup and became this flag. worker.py
    # now stamps the true rule/measured on the flag at creation time — this
    # must win, or a measure with two candidate timing issues silently
    # reports the wrong one's number to Phase 2's threshold calibration.
    bundle = build_evidence_bundle(
        flags=[{"flag_key": "timing:20", "type": "timing", "measure": 20,
                "rule": "durations", "measured": 45.0}],
        timing_report={"ok": True, "spb": 0.5, "bpm": 120.0, "n_notes": 40,
                       "placement": {20: {"median_ms": 130.0, "worst_ms": 150.0,
                                          "direction": "late", "n": 3}},
                       "drift": {}, "durations": {20: {"delta_ms": 45.0}},
                       "overall": None, "notes": []},
        dynamics_report={"ok": False, "reason": "no markings"},
        wrong_note_candidates=[], crack_candidates=[], aligned=[],
        beats={"tempo_bpm": 120.0, "beat_times": []},
        score={"source": "music21", "measures": []}, alignment_method="score_dtw",
    )
    prov = bundle["flags"][0]
    check("stamped rule wins over the 'placement' reconstruction default",
          prov["rule"] == "durations", prov["rule"])
    check("stamped measured value wins", prov["measured"] == 45.0, str(prov["measured"]))


def test_error_flags_carry_their_measurement():
    print("\n[4] wrong-note/crack flags are traceable, not just labelled measured")
    # Before the fix, type=="error" always fell through _provenance_for with
    # measured=None even though _DETECTOR_BY_TYPE labels it evidence_class
    # "measured" — an untraceable member of a category that claims to be
    # traceable. worker.py now parses the semitone distance/jump out of the
    # candidate string at the _add() call site and stamps it on the flag.
    bundle = build_evidence_bundle(
        flags=[
            {"flag_key": "error:12", "type": "error", "measure": 12,
             "rule": "wrong_note", "measured": 5.0},
            {"flag_key": "error:20", "type": "error", "measure": 20,
             "rule": "crack", "measured": 19.0},
        ],
        timing_report={"ok": False}, dynamics_report={"ok": False},
        wrong_note_candidates=[], crack_candidates=[], aligned=[],
        beats={"tempo_bpm": 120.0, "beat_times": []},
        score={"source": "music21", "measures": []}, alignment_method="score_dtw",
    )
    prov = {p["flag_key"]: p for p in bundle["flags"]}
    check("wrong-note flag carries its semitone distance",
          prov["error:12"]["measured"] == 5.0, str(prov["error:12"]["measured"]))
    check("crack flag carries its semitone jump",
          prov["error:20"]["measured"] == 19.0, str(prov["error:20"]["measured"]))
    check("both stay labelled measured (not demoted to unverifiable)",
          prov["error:12"]["evidence_class"] == "measured"
          and prov["error:20"]["evidence_class"] == "measured",
          f"{prov['error:12']['evidence_class']} / {prov['error:20']['evidence_class']}")


def test_replay_reproduces_the_recorded_flags():
    print("\n[5] replay reproduces flags from a bundle alone")
    from replay import replay_bundle
    bundle = {
        "version": 1,
        "flags": [
            {"flag_key": "timing:20", "type": "timing", "measure": 20,
             "detector": "analyze_timing_vs_score", "evidence_class": "measured",
             "rule": "placement", "measured": 130.0, "confirmed": True,
             "raw_detail": ""},
            {"flag_key": "intonation:21", "type": "intonation", "measure": 21,
             "detector": "run_pitch_tracking", "evidence_class": "measured",
             "rule": "cents_vs_tuning_centre", "measured": 18.0,
             "confirmed": True, "raw_detail": ""},
        ],
        "timing_notes": [], "timing_fit": {"ok": True},
        "dynamics": {"ok": False}, "candidates": {"wrong_notes": [], "cracks": []},
        "alignment": {"method": "score_dtw"}, "score_parse": {}, "events": [],
    }
    out = replay_bundle(bundle)
    check("returns one entry per flag", len(out) == 2, str(len(out)))
    check("keys round-trip",
          {f["flag_key"] for f in out} == {"timing:20", "intonation:21"},
          str(sorted(f["flag_key"] for f in out)))
    check("measurement round-trips",
          next(f for f in out if f["flag_key"] == "timing:20")["measured"] == 130.0)


def test_replay_applies_a_threshold_override():
    print("\n[6] replay can re-decide a flag at a new threshold")
    from replay import replay_bundle
    bundle = {
        "version": 1,
        "flags": [
            {"flag_key": "timing:20", "type": "timing", "measure": 20,
             "detector": "analyze_timing_vs_score", "evidence_class": "measured",
             "rule": "placement", "measured": 130.0, "confirmed": True,
             "raw_detail": ""},
        ],
        "timing_notes": [], "timing_fit": {"ok": True},
        "dynamics": {"ok": False}, "candidates": {"wrong_notes": [], "cracks": []},
        "alignment": {"method": "score_dtw"}, "score_parse": {}, "events": [],
    }
    # Raising the placement floor above the measured value must drop the flag.
    # This is the whole point of the harness: try a threshold, see what changes,
    # WITHOUT re-running CREPE or paying for an API call.
    kept = replay_bundle(bundle, thresholds={"placement_ms": 200.0})
    check("flag drops above the new floor", kept == [], str(kept))
    kept2 = replay_bundle(bundle, thresholds={"placement_ms": 100.0})
    check("flag survives below it", len(kept2) == 1, str(len(kept2)))


def test_replay_contrast_fires_below_its_floor():
    print("\n[7] contrast rule has inverted semantics: fires when spread is BELOW floor")
    from replay import replay_bundle
    # Contrast is the only rule that fires when the measurement is BELOW the
    # threshold, not above. A contrast finding means "insufficient dynamic range",
    # so it triggers when the spread is small. This test pins both directions to
    # prevent a future swap of <= and >= from silently inverting all contrast
    # flags during calibration.
    bundle = {
        "version": 1,
        "flags": [
            {"flag_key": "dynamics:20", "type": "dynamics", "measure": 20,
             "detector": "run_dynamics_check", "evidence_class": "measured",
             "rule": "contrast", "measured": 2.0, "confirmed": True,
             "raw_detail": ""},
        ],
        "timing_notes": [], "timing_fit": {"ok": True},
        "dynamics": {"ok": False}, "candidates": {"wrong_notes": [], "cracks": []},
        "alignment": {"method": "score_dtw"}, "score_parse": {}, "events": [],
    }
    # 2.0 dB spread is below the production floor of 3.0, so it IS a contrast flag.
    kept = replay_bundle(bundle, thresholds={"dynamics_db": 3.0})
    check("flag survives below the floor (spread too small)", len(kept) == 1, str(len(kept)))
    # 2.0 dB spread now exceeds the lower floor of 1.0, so it is NOT a contrast flag.
    kept2 = replay_bundle(bundle, thresholds={"dynamics_db": 1.0})
    check("flag drops above the floor (spread sufficient)", kept2 == [], str(kept2))


def test_scoring_against_annotations():
    print("\n[8] precision and recall per flag type")
    from score_against_annotations import score_take, aggregate
    flags = [
        {"flag_key": "timing:20", "type": "timing"},
        {"flag_key": "timing:24", "type": "timing"},
        {"flag_key": "intonation:21", "type": "intonation"},
        {"flag_key": "posture:20", "type": "posture"},   # unlabelled
    ]
    annotations = [
        {"flag_key": "timing:20", "action": "approve"},
        {"flag_key": "timing:24", "action": "reject", "rejection_reason": "not_audible"},
        {"flag_key": "intonation:21", "action": "edit"},
        {"flag_key": None, "action": "add",
         "edited_flag": {"type": "dynamics", "measure": 30}},
    ]
    r = score_take(flags, annotations)
    check("approve counts as a hit", r["timing"]["tp"] == 1, str(r["timing"]))
    check("reject counts against us", r["timing"]["fp"] == 1, str(r["timing"]))
    check("edit counts as a hit", r["intonation"]["tp"] == 1, str(r["intonation"]))
    check("teacher-added is a miss", r["dynamics"]["fn"] == 1, str(r["dynamics"]))
    # An unlabelled flag must not be scored at all. Counting it as correct is
    # how a precision number flatters itself.
    check("unlabelled flag is not scored",
          "posture" not in r or r["posture"]["tp"] == 0, str(r.get("posture")))

    agg = aggregate([r])
    check("timing precision is 0.5", abs(agg["timing"]["precision"] - 0.5) < 1e-9,
          str(agg["timing"]["precision"]))
    check("dynamics recall is 0.0", agg["dynamics"]["recall"] == 0.0,
          str(agg["dynamics"]["recall"]))


def test_dedup_by_flag_key():
    print("\n[9] duplicate rows for one flag_key are counted once")
    from score_against_annotations import score_take, aggregate
    # 20260829000003 dropped the UNIQUE index on (take_id, teacher_id,
    # flag_key): a take re-analysed and re-annotated can legitimately leave
    # two rows sharing one flag_key. Scoring must not count both, or a
    # single teacher judgement inflates whichever verdict happened twice.
    flags = [{"flag_key": "timing:5", "type": "timing"}]
    annotations = [
        {"flag_key": "timing:5", "action": "reject",
         "updated_at": "2026-08-01T00:00:00Z"},
        {"flag_key": "timing:5", "action": "approve",
         "updated_at": "2026-08-10T00:00:00Z"},   # newer -> this one should win
    ]
    r = score_take(flags, annotations)
    check("only one verdict counted, not two",
          r["timing"]["tp"] + r["timing"]["fp"] == 1, str(r["timing"]))
    check("the latest updated_at wins (approve, not reject)",
          r["timing"]["tp"] == 1 and r["timing"]["fp"] == 0, str(r["timing"]))

    agg = aggregate([r])
    check("aggregate reflects the deduped count, not the raw row count",
          agg["timing"]["n_labelled"] == 1, str(agg["timing"]))

    # Missing/equal updated_at: no reliable signal, so the tie-break is the
    # last row encountered in iteration order (explicit, not accidental).
    flags2 = [{"flag_key": "timing:9", "type": "timing"}]
    annotations2 = [
        {"flag_key": "timing:9", "action": "reject"},   # no updated_at
        {"flag_key": "timing:9", "action": "approve"},  # no updated_at, encountered last
    ]
    r2 = score_take(flags2, annotations2)
    check("tie-break keeps the last row encountered when updated_at is missing",
          r2["timing"]["tp"] == 1 and r2["timing"]["fp"] == 0, str(r2["timing"]))


def test_legacy_flag_index_matching():
    print("\n[10] legacy flag_key=NULL rows fall back to flag_index and are counted")
    from score_against_annotations import score_take, aggregate, format_report
    # Rows written before flag_key existed have flag_key = NULL but a valid
    # flag_index. That position is only trustworthy if the take has not been
    # re-analysed since -- so every match on it must be visible, not silent.
    flags = [
        {"flag_key": "timing:5", "type": "timing"},
        {"flag_key": "intonation:9", "type": "intonation"},
    ]
    annotations = [
        {"flag_key": None, "flag_index": 1, "action": "approve"},
    ]
    r = score_take(flags, annotations)
    check("legacy row matched by array position",
          r["intonation"]["tp"] == 1, str(r.get("intonation")))
    check("legacy match is tallied separately",
          r["intonation"]["legacy_matched"] == 1, str(r.get("intonation")))
    check("the other flag (position 0) is untouched",
          "timing" not in r, str(r.get("timing")))

    agg = aggregate([r])
    check("legacy_matched survives aggregation",
          agg["intonation"]["legacy_matched"] == 1, str(agg["intonation"]))
    report = format_report(agg)
    intonation_line = next(l for l in report.splitlines() if l.startswith("intonation"))
    check("legacy count is visible in the report",
          "LEGACY" in report and intonation_line.rstrip().endswith("1"), report)

    # A teacher-added flag (action='add') must never be routed through the
    # positional fallback even if it happens to carry a flag_index.
    add_annotations = [
        {"flag_key": None, "flag_index": 0, "action": "add",
         "edited_flag": {"type": "dynamics", "measure": 12}},
    ]
    r2 = score_take(flags, add_annotations)
    check("'add' rows are never treated as a legacy positional match",
          "timing" not in r2, str(r2.get("timing")))
    check("'add' rows still score as a miss for the added type",
          r2["dynamics"]["fn"] == 1, str(r2.get("dynamics")))


def main():
    test_bundle_is_json_safe_and_bounded()
    test_every_flag_gets_provenance()
    test_stamped_rule_beats_reconstruction()
    test_error_flags_carry_their_measurement()
    test_replay_reproduces_the_recorded_flags()
    test_replay_applies_a_threshold_override()
    test_replay_contrast_fires_below_its_floor()
    test_scoring_against_annotations()
    test_dedup_by_flag_key()
    test_legacy_flag_index_matching()
    failed = [r for r in RESULTS if not r[1]]
    print("\n" + "=" * 70)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    print("=" * 70)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
