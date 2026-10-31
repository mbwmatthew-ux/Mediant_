"""
Hand-constructed validation for note_sequence_evaluator.align_note_sequences.

Every expected alignment below was worked out BY HAND before running the
matcher (see each case's comment for the arithmetic), per the cost model
documented in note_sequence_evaluator.py. These costs were frozen against
these cases only, before the real MusicNet corpus was examined -- see
note_sequence_evaluator.FREEZE_NOTE.
"""
import pytest

from note_sequence_evaluator import align_note_sequences


def ev(t, midi):
    return {"time_sec": t, "midi": midi}


def test_all_correct():
    g = [ev(0.0, 60), ev(1.0, 62), ev(2.0, 64)]
    p = [ev(0.0, 60), ev(1.0, 62), ev(2.0, 64)]
    r = align_note_sequences(g, p)
    assert r.pairs == [(0, 0), (1, 1), (2, 2)]
    assert r.missing_idx == [] and r.extra_idx == []
    assert r.summary(g, p) == {"missing": 0, "extra": 0, "wrong_pitch": 0,
                                "octave_error": 0, "correct": 3}


def test_single_substitution():
    # semis(62,65)=3, not a multiple of 12 -> wrong_pitch, cost 0.25*1.8=0.45,
    # far cheaper than delete+insert (2.0), so a match is always preferred.
    g = [ev(0.0, 60), ev(1.0, 62), ev(2.0, 64)]
    p = [ev(0.0, 60), ev(1.0, 65), ev(2.0, 64)]
    r = align_note_sequences(g, p)
    assert r.pairs == [(0, 0), (1, 1), (2, 2)]
    assert r.missing_idx == [] and r.extra_idx == []
    assert r.summary(g, p) == {"missing": 0, "extra": 0, "wrong_pitch": 1,
                                "octave_error": 0, "correct": 2}


def test_insertion():
    # P has an extra event at t=1.0 with no nearby ground-truth note.
    # Optimal: insert P[1] (cost 1.0) rather than mismatching it against
    # either real note (which would cost > 1.0 once the other real note
    # also has to be re-explained -- see module docstring worked example).
    g = [ev(0.0, 60), ev(2.0, 64)]
    p = [ev(0.0, 60), ev(1.0, 67), ev(2.0, 64)]
    r = align_note_sequences(g, p)
    assert r.pairs == [(0, 0), (1, 2)]
    assert r.missing_idx == []
    assert r.extra_idx == [1]
    assert r.summary(g, p) == {"missing": 0, "extra": 1, "wrong_pitch": 0,
                                "octave_error": 0, "correct": 2}


def test_deletion():
    # G has a note at t=1.0 with nothing nearby in P.
    g = [ev(0.0, 60), ev(1.0, 62), ev(2.0, 64)]
    p = [ev(0.0, 60), ev(2.0, 64)]
    r = align_note_sequences(g, p)
    assert r.pairs == [(0, 0), (2, 1)]
    assert r.missing_idx == [1]
    assert r.extra_idx == []
    assert r.summary(g, p) == {"missing": 1, "extra": 0, "wrong_pitch": 0,
                                "octave_error": 0, "correct": 2}


def test_octave_error_cheaper_than_substitution():
    # semis(60,72)=12, 12%12==0 -> OCTAVE_COST=0.5, cheaper than the 1.8 cap
    # a generic substitution this far away would otherwise hit.
    g = [ev(0.0, 60)]
    p = [ev(0.0, 72)]
    r = align_note_sequences(g, p)
    assert r.pairs == [(0, 0)]
    assert r.summary(g, p)["octave_error"] == 1
    assert r.total_cost == pytest.approx(0.5)


def test_timing_offset_does_not_change_pitch_classification():
    # Correct pitch, 0.15s onset offset -> still "correct", offset reported
    # separately via the matched event times (not blended into the label).
    g = [ev(0.0, 60)]
    p = [ev(0.15, 60)]
    r = align_note_sequences(g, p)
    assert r.pairs == [(0, 0)]
    assert r.summary(g, p)["correct"] == 1
    gi, pi = r.pairs[0]
    offset = abs(g[gi]["time_sec"] - p[pi]["time_sec"])
    assert offset == pytest.approx(0.15)


def test_repeated_notes_match_in_time_order_not_crossed():
    # Three identical pitches, close together. A greedy/nearest-time
    # heuristic can cross-match these; the monotonic DP must not.
    g = [ev(0.0, 60), ev(0.5, 60), ev(1.0, 60)]
    p = [ev(0.05, 60), ev(0.55, 60), ev(0.95, 60)]
    r = align_note_sequences(g, p)
    assert r.pairs == [(0, 0), (1, 1), (2, 2)]
    assert r.missing_idx == [] and r.extra_idx == []
    assert r.summary(g, p) == {"missing": 0, "extra": 0, "wrong_pitch": 0,
                                "octave_error": 0, "correct": 3}


def test_combination_missing_extra_and_correct():
    # G1 (1.0,62) and G2 (2.0,64) each have a same-distance (dt=0.5),
    # far-off-pitch (semis>=35, capped at 1.8) distractor candidate at
    # P1 (1.5,99). Matching either directly costs 1.8+0.25=2.05, MORE than
    # deleting the ground-truth note and inserting the extra event
    # separately (1.0+1.0=2.0) -- so the optimal alignment leaves both
    # G1 and G2 missing and P1 extra, while G0/G3 match their exact
    # counterparts (G3 with a small 0.05s offset).
    g = [ev(0.0, 60), ev(1.0, 62), ev(2.0, 64), ev(3.0, 65)]
    p = [ev(0.0, 60), ev(1.5, 99), ev(3.05, 65)]
    r = align_note_sequences(g, p)
    assert r.pairs == [(0, 0), (3, 2)]
    assert r.missing_idx == [1, 2]
    assert r.extra_idx == [1]
    assert r.summary(g, p) == {"missing": 2, "extra": 1, "wrong_pitch": 0,
                                "octave_error": 0, "correct": 2}
    assert r.total_cost == pytest.approx(1.0 + 1.0 + 1.0 + timing_cost_for(0.05))


def timing_cost_for(dt):
    from note_sequence_evaluator import timing_cost
    return timing_cost(dt)


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
