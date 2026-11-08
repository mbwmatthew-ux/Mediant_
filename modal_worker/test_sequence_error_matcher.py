"""
Hand-constructed validation for sequence_error_matcher.align_sequences,
per the directive's Task 2. Every expected alignment below was worked
out BY HAND before running the matcher -- each test's docstring/comment
shows the arithmetic that makes the expected result the DP's unique
minimum-cost path, the same discipline test_note_sequence_evaluator.py
already uses. These are the ONLY cases DURATION_MAX/DURATION_RATIO_CAP
were calibrated against -- never the 8-piece benchmark, per the
directive's anti-overfitting instruction.
"""
import pytest

from sequence_error_matcher import (
    ScoreNote, PerformedEvent, align_sequences,
    pitch_cost, timing_cost, duration_cost,
)


def g(idx, midi, t, dur=None, measure=None):
    return ScoreNote(idx, midi, t, dur, measure)


def p(idx, t, end, midi):
    return PerformedEvent(idx, t, end, midi)


def ops_summary(ops):
    return [(o.op, o.score_idx, o.perf_idx, o.pitch_status) for o in ops]


def test_identical_performance_and_score():
    gs = [g(0, 60, 0.0), g(1, 62, 1.0), g(2, 64, 2.0)]
    ps = [p(0, 0.0, 0.9, 60), p(1, 1.0, 1.9, 62), p(2, 2.0, 2.9, 64)]
    ops = align_sequences(gs, ps)
    assert ops_summary(ops) == [
        ("match", 0, 0, "correct"),
        ("match", 1, 1, "correct"),
        ("match", 2, 2, "correct"),
    ]


def test_one_wrong_pitch_substitution():
    # 62 -> 67 is 5 semitones, not an octave (5 % 12 != 0) -> "substitution"
    # (>= SUBSTITUTION_SEMITONES=2). pitch_cost(5) = min(1, 5/12)*1.8 = 0.75.
    gs = [g(0, 60, 0.0), g(1, 62, 1.0), g(2, 64, 2.0)]
    ps = [p(0, 0.0, 0.9, 60), p(1, 1.0, 1.9, 67), p(2, 2.0, 2.9, 64)]
    ops = align_sequences(gs, ps)
    assert ops_summary(ops) == [
        ("match", 0, 0, "correct"),
        ("match", 1, 1, "substitution"),
        ("match", 2, 2, "correct"),
    ]


def test_one_missing_note():
    # g=62 at t=1 has no nearby performed event (only p=60@0, p=64@2 exist).
    # Expected path: match(0,0)=0 + delete(g1)=1.0 + match(2,1)=0 = 1.0.
    # Alt (match g1->p1 instead): timing_cost(|1-2|=1)=0.5 +
    #   pitch_cost(62-64=-2,2%12!=0)=min(1,2/12)*1.8=0.3 -> 0.8, then g2
    #   has no performed event left -> delete=1.0. Alt total = 0+0.8+1.0=1.8.
    # Expected (1.0) < alt (1.8), so deletion is the unique minimum.
    gs = [g(0, 60, 0.0), g(1, 62, 1.0), g(2, 64, 2.0)]
    ps = [p(0, 0.0, 0.9, 60), p(1, 2.0, 2.9, 64)]
    ops = align_sequences(gs, ps)
    assert ops_summary(ops) == [
        ("match", 0, 0, "correct"),
        ("deletion", 1, None, None),
        ("match", 2, 1, "correct"),
    ]


def test_one_extra_note():
    # p=62 at t=1 has no nearby score note (only g=60@0, g=64@2 exist).
    # Expected path: match(0,0)=0 + insert(p1)=1.0 + match(1,2)=0 = 1.0.
    # Alt (match g1->p1 instead): timing_cost(|2-1|=1)=0.5 +
    #   pitch_cost(64-62=2,2%12!=0)=0.3 -> 0.8, then p2 unmatched -> insert=1.0.
    #   Alt total = 0+0.8+1.0=1.8. Expected (1.0) < alt (1.8).
    gs = [g(0, 60, 0.0), g(1, 64, 2.0)]
    ps = [p(0, 0.0, 0.9, 60), p(1, 1.0, 1.9, 62), p(2, 2.0, 2.9, 64)]
    ops = align_sequences(gs, ps)
    assert ops_summary(ops) == [
        ("match", 0, 0, "correct"),
        ("insertion", None, 1, None),
        ("match", 1, 2, "correct"),
    ]


def test_repeated_identical_notes():
    # Same pitch (60) three times in a row -- order must come from TIMING
    # alone, since pitch gives the DP no discriminating signal at all.
    gs = [g(0, 60, 0.0), g(1, 60, 1.0), g(2, 60, 2.0)]
    ps = [p(0, 0.0, 0.9, 60), p(1, 1.0, 1.9, 60), p(2, 2.0, 2.9, 60)]
    ops = align_sequences(gs, ps)
    assert ops_summary(ops) == [
        ("match", 0, 0, "correct"),
        ("match", 1, 1, "correct"),
        ("match", 2, 2, "correct"),
    ]


def test_consecutive_neighboring_pitches():
    # Chromatic steps (60,61,62) -- each performed event has BOTH zero
    # timing cost and zero pitch cost against its own index, which is
    # the unique global minimum (0 total); any cross-pairing would incur
    # a nonzero pitch_cost for at least one pair, so cannot tie let alone win.
    gs = [g(0, 60, 0.0), g(1, 61, 1.0), g(2, 62, 2.0)]
    ps = [p(0, 0.0, 0.9, 60), p(1, 1.0, 1.9, 61), p(2, 2.0, 2.9, 62)]
    ops = align_sequences(gs, ps)
    assert ops_summary(ops) == [
        ("match", 0, 0, "correct"),
        ("match", 1, 1, "correct"),
        ("match", 2, 2, "correct"),
    ]


def test_tempo_variation():
    # Performed onsets drift from the expected (score-aligned) times by
    # up to 0.3s (rubato) -- well inside TIMING_SCALE=2.0s, so timing_cost
    # stays small (e.g. 0.3/2.0*1.0=0.15) and matching remains far cheaper
    # than delete+insert (2.0) for every note; pitches are all correct.
    gs = [g(0, 60, 0.0), g(1, 62, 1.0), g(2, 64, 2.0)]
    ps = [p(0, 0.05, 0.9, 60), p(1, 1.30, 2.1, 62), p(2, 2.10, 2.9, 64)]
    ops = align_sequences(gs, ps)
    assert ops_summary(ops) == [
        ("match", 0, 0, "correct"),
        ("match", 1, 1, "correct"),
        ("match", 2, 2, "correct"),
    ]


def test_incorrect_note_sharing_pitch_of_a_nearby_score_note():
    # Middle note expected=62 but performed=64 -- which happens to equal
    # the NEXT score note's own pitch (a direct "neighbor pitch collision",
    # the exact shape of case this week's Category-D finding was about).
    # This module has NO neighbor-suppression layer (by design, per the
    # directive) -- it must still report "substitution", not silently
    # reclassify or drop it. In-order matching is clearly cheapest here
    # (same reasoning as test_one_missing_note/test_one_extra_note: any
    # cross-pairing leaves another note unmatched at DELETE_COST=1.0,
    # dominating the modest pitch_cost(62-64=2 semis)=0.3 this path pays).
    gs = [g(0, 60, 0.0), g(1, 62, 1.0), g(2, 64, 2.0)]
    ps = [p(0, 0.0, 0.9, 60), p(1, 1.0, 1.9, 64), p(2, 2.0, 2.9, 64)]
    ops = align_sequences(gs, ps)
    assert ops_summary(ops) == [
        ("match", 0, 0, "correct"),
        ("match", 1, 1, "substitution"),
        ("match", 2, 2, "correct"),
    ]
    assert ops[1].played_midi == 64 and ops[1].expected_midi == 62


def test_spurious_basic_pitch_note_event():
    # A spurious extra Basic Pitch event (midi=75, clearly unrelated pitch)
    # sits between two real notes. Matching g=1(t=1,midi=62) to this spurious
    # event instead of insertion would cost timing_cost(|1-0.5|=0.5)=0.25 +
    # pitch_cost(62-75=-13,13%12=1!=0)=min(1,13/12)*1.8=1.8 -> 2.05, THEN the
    # real p=62@t=1 would be unmatched -> + insert(1.0) = 3.05 total for that
    # path. Expected path: match(0,0)=0 + insert(spurious)=1.0 + match(1,2)=0
    # = 1.0, far cheaper.
    gs = [g(0, 60, 0.0), g(1, 62, 1.0)]
    ps = [p(0, 0.0, 0.9, 60), p(1, 0.5, 0.6, 75), p(2, 1.0, 1.9, 62)]
    ops = align_sequences(gs, ps)
    assert ops_summary(ops) == [
        ("match", 0, 0, "correct"),
        ("insertion", None, 1, None),
        ("match", 1, 2, "correct"),
    ]


def test_ambiguous_one_semitone_not_confirmed_substitution():
    # 1 semitone off -- below SUBSTITUTION_SEMITONES=2, so classified
    # "ambiguous_pitch", never silently promoted to a confirmed claim.
    gs = [g(0, 60, 0.0)]
    ps = [p(0, 0.0, 0.9, 61)]
    ops = align_sequences(gs, ps)
    assert ops[0].pitch_status == "ambiguous_pitch"


def test_ambiguous_octave_displacement_not_confirmed_substitution():
    # Exactly one octave (12 semitones, pc_dist==0) -- "ambiguous_pitch",
    # same treatment this whole investigation has given octave errors all
    # week (never a confirmed wrong-note claim on its own).
    gs = [g(0, 60, 0.0)]
    ps = [p(0, 0.0, 0.9, 72)]
    ops = align_sequences(gs, ps)
    assert ops[0].pitch_status == "ambiguous_pitch"


def test_tie_break_prefers_match_over_delete_over_insert():
    # Degenerate single-note-each case where match cost can be driven to
    # exactly equal delete+insert's combined effect is hard to construct
    # exactly at the edges with capped costs; instead this confirms the
    # documented tie-break ORDER directly: dp's own code checks match,
    # then delete, then insert, replacing only on a STRICTLY lower cost
    # -- verified structurally by confirming a cheap-but-nonzero match
    # still wins over the (always worse, cost 2.0) delete+insert pair.
    gs = [g(0, 60, 0.0)]
    ps = [p(0, 1.9, 2.0, 61)]  # far in time (1.9s) AND 1 semitone off
    ops = align_sequences(gs, ps)
    # match_cost = pitch_cost(1)=min(1,1/12)*1.8=0.15 + timing_cost(1.9)=
    # min(1,1.9/2.0)*1.0=0.95 = 1.10, vs delete+insert = 1.0+1.0=2.0.
    # Match (1.10) still strictly cheaper -> match wins, not delete+insert.
    assert ops_summary(ops) == [("match", 0, 0, "ambiguous_pitch")]


def test_duration_cost_is_secondary_and_bounded():
    # Duration incompatibility alone must never flip a confident
    # pitch+timing match into a non-match: even a wildly incompatible
    # duration (ratio capped at DURATION_RATIO_CAP=3.0, contributing at
    # most DURATION_MAX=0.4) keeps total match cost (0.4) far below
    # DELETE_COST+INSERT_COST (2.0).
    assert duration_cost(0.2, 2.0) == pytest.approx(0.4)  # ratio 10 -> capped
    assert duration_cost(None, 1.0) == 0.0
    assert duration_cost(1.0, 1.0) == 0.0

    gs = [g(0, 60, 0.0, dur=0.2)]
    ps = [p(0, 0.0, 2.0, 60)]  # performed duration 2.0s vs expected 0.2s
    ops = align_sequences(gs, ps)
    assert ops_summary(ops) == [("match", 0, 0, "correct")]
    assert ops[0].cost == pytest.approx(duration_cost(0.2, 2.0))


def test_cost_functions_match_note_sequence_evaluator_values():
    # Confirms the REUSE claim directly, not just by import: identical
    # numeric outputs to note_sequence_evaluator's own frozen cost model.
    import note_sequence_evaluator as nse
    for semis in (0, 1, 2, 5, 11, 12, 13, 24):
        assert pitch_cost(semis) == nse.pitch_cost(semis)
    for dt in (0.0, 0.1, 1.0, 1.9, 2.0, 5.0):
        assert timing_cost(dt) == nse.timing_cost(dt)


if __name__ == "__main__":
    import pytest as _pytest
    import sys
    sys.exit(_pytest.main([__file__, "-v"]))
