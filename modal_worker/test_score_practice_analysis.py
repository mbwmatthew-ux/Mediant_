"""
Ground-truth tests for modal_worker/score_practice_analysis.py — see
"MEDIANT — Build Score-Grounded Practice Recommendations".

Run:  python3 modal_worker/test_score_practice_analysis.py

Fixtures are small, hand-constructed canonical score dicts (the same
{"measures": [{"number", "notes": [...]}]} shape page_omr_adapter/
parse_musicxml/read_score_notes_claude already emit) with KNOWN ground
truth — not real OMR/kern output. This isolates the analysis logic itself
from score-reading concerns already covered by test_page_omr_adapter.py.

Follows this directory's established convention: a non-raising check()
helper plus a main() CLI runner (see test_page_omr_adapter.py's own
docstring on why pytest collection order matters here — this file avoids
the issue entirely by never indexing into a possibly-empty list without
a length guard first).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import score_practice_analysis as spa  # noqa: E402

RESULTS = []


def check(desc, condition, detail=""):
    RESULTS.append((desc, bool(condition), detail))
    status = "PASS" if condition else "FAIL"
    print(f"  {status}  {desc}" + (f"   {detail}" if detail and not condition else ""))


def _note(pitch, beat, dur=1.0, part=0, voice=None, tied=None, is_rest=False):
    return {
        "pitch": pitch, "is_rest": is_rest, "beat": beat, "duration_beats": dur,
        "part": part, "voice": voice, "tied": tied,
    }


def _measure(number, notes, page=None):
    m = {"number": number, "notes": notes}
    if page is not None:
        m["page"] = page
    return m


def _melody_measure(number, pitches, page=None):
    return _measure(number, [_note(p, float(i + 1)) for i, p in enumerate(pitches)], page)


def _find(targets, characteristic):
    return [t for t in targets if t["characteristic"] == characteristic]


# ---------------------------------------------------------------------------
# Fixture A — simple melody, small (stepwise) intervals only.
# ---------------------------------------------------------------------------
_FIXTURE_A = {
    "measures": [
        _melody_measure(1, ["C4", "D4", "E4", "F4"]),
        _melody_measure(2, ["G4", "F4", "E4", "D4"]),
        _melody_measure(3, ["C4", "D4", "E4", "F4"]),
        _melody_measure(4, ["G4", "F4", "E4", "D4"]),
        _melody_measure(5, ["C4", "D4", "E4", "F4"]),
        _melody_measure(6, ["G4", "F4", "E4", "D4"]),
    ]
}


def test_case_a_simple_melody_produces_no_targets():
    print("\n[1] Case A — a melody with only small (1-2 semitone) steps: no "
          "interval in this piece is relatively large, so nothing should be "
          "flagged. Absence of evidence must not be manufactured into advice.")
    result = spa.analyze_score_for_practice(_FIXTURE_A)
    check("status is available", result["status"] == "available", str(result))
    check("zero targets", result["targets"] == [], str(result["targets"]))
    check("reason explains why", bool(result.get("reason")), str(result))
    check("scope covers measures 1-6",
          result.get("scope") == {"measureStart": 1, "measureEnd": 6}, str(result.get("scope")))


# ---------------------------------------------------------------------------
# Fixture B — same shape as A, but with one genuine large leap (octave,
# 12 semitones) at the measure-2/measure-3 boundary; every other interval
# stays small.
# ---------------------------------------------------------------------------
_FIXTURE_B = {
    "measures": [
        _melody_measure(1, ["C4", "D4", "E4", "F4"]),
        _melody_measure(2, ["G4", "F4", "E4", "D4"]),   # ends D4
        _melody_measure(3, ["D5", "E5", "F5", "G5"]),   # starts D5 -> 12-semitone leap from D4
        _melody_measure(4, ["F5", "E5", "D5", "C5"]),
        _melody_measure(5, ["B4", "A4", "G4", "F4"]),
        _melody_measure(6, ["E4", "D4", "C4", "B3"]),
    ]
}


def test_case_b_known_large_leap_is_flagged_with_correct_evidence():
    print("\n[2] Case B — identical shape to Case A except one octave leap: "
          "exactly that leap must be flagged, with the raw interval and the "
          "piece's own median interval as evidence (a relative comparison, "
          "not a universal difficulty score).")
    result = spa.analyze_score_for_practice(_FIXTURE_B)
    leaps = _find(result["targets"], "large_melodic_interval")
    check("exactly one large-melodic-interval target", len(leaps) == 1, str(result["targets"]))
    if len(leaps) == 1:
        t = leaps[0]
        check("spans measures 2-3", (t["measureStart"], t["measureEnd"]) == (2, 3), str(t))
        check("part/voice default to backward-compatible single-voice values",
              t["part"] == 0 and t["voice"] is None, str(t))
        check("evidence reports the true 12-semitone interval",
              t["evidence"]["intervalSemitones"] == 12, str(t["evidence"]))
        check("evidence also reports the piece's own (small) median interval for context",
              0 < t["evidence"]["pieceMedianIntervalSemitones"] < 5, str(t["evidence"]))
        check("source is score-based", t["source"] == "score-based", str(t))
        check("suggestion is concrete and actionable",
              "slow" in t["suggestion"].lower() or "isolation" in t["suggestion"].lower(), t["suggestion"])


# ---------------------------------------------------------------------------
# Fixture C — three sparse measures (half notes) surrounding one dense
# measure of eighth notes; no leaps, no chords, no second voice.
# ---------------------------------------------------------------------------
_FIXTURE_C = {
    "measures": [
        _measure(1, [_note("C4", 1.0, 2.0), _note("D4", 3.0, 2.0)]),
        _measure(2, [_note("C4", 1.0, 2.0), _note("D4", 3.0, 2.0)]),
        _measure(3, [_note(p, b) for p, b in zip(
            ["C4", "D4", "E4", "F4", "G4", "F4", "E4", "D4"],
            [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5])]),
        _measure(4, [_note("C4", 1.0, 2.0), _note("D4", 3.0, 2.0)]),
    ]
}


def test_case_c_dense_passage_is_flagged_relative_to_sparse_neighbors():
    print("\n[3] Case C — one measure of 8 eighth-note attacks surrounded by "
          "sparse half-note measures: the dense measure must be flagged, "
          "with the actual count and the piece's own median count as evidence.")
    result = spa.analyze_score_for_practice(_FIXTURE_C)
    dense = _find(result["targets"], "dense_passage")
    check("exactly one dense-passage target", len(dense) == 1, str(result["targets"]))
    if len(dense) == 1:
        t = dense[0]
        check("flags measure 3 only", (t["measureStart"], t["measureEnd"]) == (3, 3), str(t))
        check("evidence: 8 notes vs piece median 2.0",
              t["evidence"]["notesInMeasure"] == 8 and t["evidence"]["pieceMedianNotesPerMeasure"] == 2.0,
              str(t["evidence"]))
    check("no spurious large-leap target from the sparse/dense boundary",
          _find(result["targets"], "large_melodic_interval") == [], str(result["targets"]))
    check("no spurious voice/chord target", _find(result["targets"], "chord_complexity") == []
          and _find(result["targets"], "simultaneous_voices") == [], str(result["targets"]))


# ---------------------------------------------------------------------------
# Fixture D — a chord (3 simultaneous pitches at one onset) inside an
# otherwise single-note melody; the three chord tones must never be read
# as sequential melodic leaps.
# ---------------------------------------------------------------------------
_FIXTURE_D = {
    "measures": [
        _melody_measure(1, ["C4", "D4", "E4", "F4"]),
        _measure(2, [
            _note("C4", 1.0), _note("E4", 1.0), _note("G4", 1.0),  # one triad onset
            _note("A4", 2.0), _note("B4", 3.0), _note("C5", 4.0),
        ]),
        _melody_measure(3, ["B4", "A4", "G4", "F4"]),
    ]
}


def test_case_d_chord_tones_preserved_as_one_onset_not_sequential_leaps():
    print("\n[4] Case D — a triad (C4,E4,G4 simultaneously): must be flagged as "
          "chord complexity, and its three simultaneous tones must never be "
          "counted as melodic leaps between each other.")
    result = spa.analyze_score_for_practice(_FIXTURE_D)
    chords = _find(result["targets"], "chord_complexity")
    check("exactly one chord-complexity target", len(chords) == 1, str(result["targets"]))
    if len(chords) == 1:
        t = chords[0]
        check("flags measure 2", (t["measureStart"], t["measureEnd"]) == (2, 2), str(t))
        check("evidence: 3 simultaneous pitches", t["evidence"]["simultaneousPitches"] == 3, str(t))
    check("no large-leap target (chord tones were not read as sequential leaps)",
          _find(result["targets"], "large_melodic_interval") == [], str(result["targets"]))
    check("no simultaneous-voices target (single voice track throughout)",
          _find(result["targets"], "simultaneous_voices") == [], str(result["targets"]))


# ---------------------------------------------------------------------------
# Fixture E — one staff, two independent simultaneous voices across two
# measures; voice 1 is a stepwise melody, voice 2 holds a single repeated
# pitch (so no spurious leap/density signal from voice 2).
# ---------------------------------------------------------------------------
_FIXTURE_E = {
    "measures": [
        _measure(1, [
            _note("C5", 1.0, part=0, voice=0), _note("D5", 2.0, part=0, voice=0),
            _note("E5", 3.0, part=0, voice=0), _note("F5", 4.0, part=0, voice=0),
            _note("C4", 1.0, 4.0, part=0, voice=1),
        ]),
        _measure(2, [
            _note("G5", 1.0, part=0, voice=0), _note("F5", 2.0, part=0, voice=0),
            _note("E5", 3.0, part=0, voice=0), _note("D5", 4.0, part=0, voice=0),
            _note("C4", 1.0, 4.0, part=0, voice=1),
        ]),
    ]
}


def test_case_e_two_independent_voices_flagged_as_simultaneous_complexity():
    print("\n[5] Case E — two independent voices in one staff sounding at the "
          "same time across 2 measures: must be flagged as simultaneous-voice "
          "complexity, identifying both voices, recommending separate practice.")
    result = spa.analyze_score_for_practice(_FIXTURE_E)
    voices = _find(result["targets"], "simultaneous_voices")
    check("exactly one simultaneous-voices target", len(voices) == 1, str(result["targets"]))
    if len(voices) == 1:
        t = voices[0]
        check("spans both measures (1-2)", (t["measureStart"], t["measureEnd"]) == (1, 2), str(t))
        check("evidence: 2 independent voices, both identified",
              t["evidence"]["independentVoiceCount"] == 2 and
              t["evidence"]["partsAndVoices"] == [{"part": 0, "voice": 0}, {"part": 0, "voice": 1}],
              str(t["evidence"]))
        check("suggestion recommends practicing parts separately",
              "separately" in t["suggestion"].lower(), t["suggestion"])
    check("no spurious leap from voice 2's repeated single pitch",
          _find(result["targets"], "large_melodic_interval") == [], str(result["targets"]))


# ---------------------------------------------------------------------------
# Fixture F — multi-page (continuous measure numbering), with the one
# genuine leap straddling the page-1/page-2 boundary.
# ---------------------------------------------------------------------------
_FIXTURE_F = {
    "measures": [
        _melody_measure(1, ["C4", "D4", "E4", "F4"], page=1),
        _melody_measure(2, ["G4", "F4", "E4", "D4"], page=1),
        _melody_measure(3, ["C4", "D4", "E4", "F4"], page=1),
        _melody_measure(4, ["G4", "F4", "E4", "D4"], page=1),   # ends D4, last page-1 measure
        _melody_measure(5, ["D5", "E5", "F5", "G5"], page=2),   # starts D5: 12-semitone leap at the boundary
        _melody_measure(6, ["F5", "E5", "D5", "C5"], page=2),
        _melody_measure(7, ["B4", "A4", "G4", "F4"], page=2),
        _melody_measure(8, ["E4", "D4", "C4", "B3"], page=2),
    ]
}


def test_case_f_multipage_practice_target_spans_the_page_boundary_correctly():
    print("\n[6] Case F — multi-page score (continuous measure numbering from "
          "the already-validated multi-page pipeline): a leap straddling the "
          "page-1/page-2 boundary must be flagged using the continuous measure "
          "numbers (4-5), not reset per page.")
    result = spa.analyze_score_for_practice(_FIXTURE_F)
    check("scope covers the full continuous range 1-8",
          result.get("scope", {}).get("measureStart") == 1 and
          result.get("scope", {}).get("measureEnd") == 8, str(result.get("scope")))
    leaps = _find(result["targets"], "large_melodic_interval")
    check("exactly one large-leap target, spanning the page boundary (measures 4-5)",
          len(leaps) == 1 and (leaps[0]["measureStart"], leaps[0]["measureEnd"]) == (4, 5),
          str(result["targets"]))


# ---------------------------------------------------------------------------
# Fixture G — incomplete/corrupted score: (G1) no usable measures at all,
# (G2) some pages recognized, one page failed.
# ---------------------------------------------------------------------------
_FIXTURE_G1_NO_MEASURES = {
    "measures": [], "error": "page-omr could not read any page: page 1: inference failed",
}

_FIXTURE_G2_PARTIAL = {
    "measures": [
        _melody_measure(1, ["C4", "D4", "E4", "F4"], page=1),
        _melody_measure(2, ["G4", "F4", "E4", "D4"], page=1),
    ],
    "partial_error": "page 2: output looks degenerate",
    "failed_pages": [2],
}


def test_case_g1_no_recognized_measures_marks_analysis_unavailable():
    print("\n[7] Case G1 — page-omr returned no usable measures at all: "
          "practice analysis must report unavailable, not an empty success.")
    result = spa.analyze_score_for_practice(_FIXTURE_G1_NO_MEASURES)
    check("status is unavailable", result["status"] == "unavailable", str(result))
    check("targets is empty", result["targets"] == [], str(result))
    check("reason is present", bool(result.get("reason")), str(result))
    check("no scope key for an unavailable result", "scope" not in result, str(result))


def test_case_g2_partial_score_scopes_recommendations_to_recognized_measures_only():
    print("\n[8] Case G2 — page 1 recognized, page 2 failed: recommendations "
          "must be explicitly scoped to the recognized measures only, and "
          "must never be presented as covering the complete piece.")
    result = spa.analyze_score_for_practice(_FIXTURE_G2_PARTIAL)
    check("status is available (recognized measures ARE analyzable)",
          result["status"] == "available", str(result))
    check("scope is confined to the 2 recognized measures",
          result.get("scope", {}).get("measureStart") == 1 and
          result.get("scope", {}).get("measureEnd") == 2, str(result.get("scope")))
    check("scope is explicitly marked partial", result.get("scope", {}).get("partial") is True,
          str(result.get("scope")))
    check("scope note names the excluded failed page",
          "2" in result.get("scope", {}).get("note", ""), str(result.get("scope")))


# ---------------------------------------------------------------------------
# Fixture I — several qualifying melodic leaps in measures adjacent to each
# other (2-3, 4-5, 6-6), with the strongest leap (24 semitones, two octaves)
# straddling the measure-4/measure-5 barline, flanked by two weaker leaps (9
# and 13 semitones) that are each adjacent to it. Regression for the real bug
# found on the MusicNet 2220 fixture (Directive E/F): _merge_and_rank used to
# treat large_melodic_interval like a contiguous span and chain all three into
# one "Measures 2-6" target carrying only the strongest leap's evidence --
# describing a transition that didn't exist at that range. Confirmed this
# fixture reproduces exactly that failure mode by simulating the pre-fix merge
# (no is_leap exclusion) directly: it collapses these three candidates into a
# single (2, 6) target whose evidence is the 24-semitone leap's -- the same
# shape of mismatch as the real "Measures 27-40" bug.
# ---------------------------------------------------------------------------
_FIXTURE_I = {
    "measures": [
        _melody_measure(1, ["C4", "D4", "E4", "F4"]),
        _melody_measure(2, ["G4", "A4", "B4", "C5"]),
        _melody_measure(3, ["A5", "G5", "F5", "E5"]),   # weak leap: C5(m2)->A5(m3) = 9 semitones
        _melody_measure(4, ["D5", "C5", "C5", "D5"]),
        _melody_measure(5, ["D3", "E3", "F3", "G3"]),    # strongest leap: D5(m4)->D3(m5) = 24 semitones, crosses the barline
        _melody_measure(6, ["A3", "B3", "C5", "D5"]),    # weak leap within m6: B3->C5 = 13 semitones
        _melody_measure(7, ["C5", "B4", "A4", "G4"]),
    ]
}


def test_case_i_strongest_leap_keeps_its_own_range_when_flanked_by_nearby_leaps():
    print("\n[12] Case I — three separate qualifying leaps in adjacent measures "
          "(2-3, 4-5, 6-6), the strongest crossing a barline: each must stay "
          "its own two-measure target with its own matching evidence, never "
          "merged into one range that only the strongest leap's evidence "
          "actually describes.")
    result = spa.analyze_score_for_practice(_FIXTURE_I)
    leaps = _find(result["targets"], "large_melodic_interval")
    check("all three leaps surface as separate targets, none merged away",
          len(leaps) == 3, str(result["targets"]))

    strongest = [t for t in leaps if t["evidence"]["intervalSemitones"] == 24]
    check("exactly one target carries the strongest (24-semitone) leap's evidence",
          len(strongest) == 1, str(leaps))
    if strongest:
        t = strongest[0]
        check("the strongest leap's range is exactly its own two measures (4-5), "
              "not extended to cover the flanking leaps",
              (t["measureStart"], t["measureEnd"]) == (4, 5), str(t))
        check("the strongest leap ranks first by salience",
              leaps[0] is t, str(leaps))

    check("the weaker leap at measures 2-3 keeps its own range and evidence, "
          "not absorbed into the strongest leap's range",
          any((t["measureStart"], t["measureEnd"]) == (2, 3) and
              t["evidence"]["intervalSemitones"] == 9 for t in leaps),
          str(leaps))
    check("the weaker leap at measure 6 keeps its own range and evidence, "
          "not extending the strongest leap's range past measure 5",
          any((t["measureStart"], t["measureEnd"]) == (6, 6) and
              t["evidence"]["intervalSemitones"] == 13 for t in leaps),
          str(leaps))

    # Confirms this fixture actually reproduces the pre-fix failure mode (the
    # real bug), rather than passing for an unrelated reason: simulate the old
    # merge behavior -- the same loop body, minus the is_leap exclusion -- and
    # verify it collapses these three candidates into one mislocated target.
    tracks = spa._build_tracks(_FIXTURE_I["measures"])
    candidates = spa._leap_candidates(tracks)
    groups = {}
    for c in candidates:
        groups.setdefault((c["characteristic"], c["part"], c["voice"]), []).append(c)
    old_merged = []
    for items in groups.values():
        items.sort(key=lambda c: c["measureStart"])
        current = None
        for c in items:
            if current is not None and c["measureStart"] <= current["measureEnd"] + 1:
                current["measureEnd"] = max(current["measureEnd"], c["measureEnd"])
                if c["_salience"] > current["_salience"]:
                    current["evidence"] = c["evidence"]
                    current["_salience"] = c["_salience"]
            else:
                if current is not None:
                    old_merged.append(current)
                current = dict(c)
        if current is not None:
            old_merged.append(current)
    check("sanity check: the pre-fix merge algorithm really does collapse this "
          "fixture into one mislocated (2, 6) target -- confirms this is a "
          "genuine regression test for the real bug, not a vacuous fixture",
          len(old_merged) == 1 and
          (old_merged[0]["measureStart"], old_merged[0]["measureEnd"]) == (2, 6) and
          old_merged[0]["evidence"]["intervalSemitones"] == 24,
          str(old_merged))


# ---------------------------------------------------------------------------
# Cross-cutting checks: determinism, field shape, and the 5-target cap.
# ---------------------------------------------------------------------------
def test_output_is_deterministic():
    print("\n[9] Same input must always produce the exact same output — no "
          "randomness, no hidden state between calls.")
    r1 = spa.analyze_score_for_practice(_FIXTURE_B)
    r2 = spa.analyze_score_for_practice(_FIXTURE_B)
    check("identical results across two independent calls", r1 == r2, f"{r1}\n!=\n{r2}")


def test_every_target_has_the_required_fields_and_score_based_source():
    print("\n[10] Every emitted target must carry the full required shape: "
          "measure range, part/voice, characteristic, numeric evidence, a "
          "concrete suggestion, and an explicit score-based source label.")
    for fixture in (_FIXTURE_B, _FIXTURE_C, _FIXTURE_D, _FIXTURE_E, _FIXTURE_F):
        result = spa.analyze_score_for_practice(fixture)
        for t in result["targets"]:
            required = {"measureStart", "measureEnd", "part", "voice",
                        "characteristic", "evidence", "suggestion", "source"}
            check(f"{fixture is _FIXTURE_B and 'B' or ''} target has all required fields",
                  required.issubset(t.keys()), str(t))
            check("source is score-based, never performance-based",
                  t["source"] == "score-based", str(t))
            check("evidence is non-empty numeric data", bool(t["evidence"]), str(t))


def test_at_most_five_targets_even_when_many_passages_qualify():
    print("\n[11] At most 5 practice targets are ever returned, even when a "
          "constructed piece has many qualifying passages.")
    measures = []
    n = 1
    for i in range(8):
        measures.append(_melody_measure(n, ["C4", "D4", "E4", "F4"])); n += 1
        measures.append(_melody_measure(n, ["D5", "E5", "F5", "G5"])); n += 1  # leap every other measure
    many_leaps = {"measures": measures}
    result = spa.analyze_score_for_practice(many_leaps)
    check("at most 5 targets returned", len(result["targets"]) <= 5, str(len(result["targets"])))


def main():
    print("=" * 70)
    print("score_practice_analysis — ground truth tests")
    print("=" * 70)
    for t in (
        test_case_a_simple_melody_produces_no_targets,
        test_case_b_known_large_leap_is_flagged_with_correct_evidence,
        test_case_c_dense_passage_is_flagged_relative_to_sparse_neighbors,
        test_case_d_chord_tones_preserved_as_one_onset_not_sequential_leaps,
        test_case_e_two_independent_voices_flagged_as_simultaneous_complexity,
        test_case_f_multipage_practice_target_spans_the_page_boundary_correctly,
        test_case_g1_no_recognized_measures_marks_analysis_unavailable,
        test_case_g2_partial_score_scopes_recommendations_to_recognized_measures_only,
        test_case_i_strongest_leap_keeps_its_own_range_when_flanked_by_nearby_leaps,
        test_output_is_deterministic,
        test_every_target_has_the_required_fields_and_score_based_source,
        test_at_most_five_targets_even_when_many_passages_qualify,
    ):
        try:
            t()
        except Exception as e:  # noqa: BLE001
            import traceback
            RESULTS.append((t.__name__, False, f"{type(e).__name__}: {e}"))
            print(f"  ERROR {t.__name__}: {type(e).__name__}: {e}")
            traceback.print_exc()
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print("\n" + "=" * 70)
    print(f"{passed}/{len(RESULTS)} checks passed")
    failed = [(n, d) for n, ok, d in RESULTS if not ok]
    for n, d in failed:
        print(f"  FAILED: {n}  {d}")
    print("=" * 70)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
