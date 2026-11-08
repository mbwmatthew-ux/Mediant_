"""
"MEDIANT — IMPLEMENT SEQUENCE-LEVEL ERROR MATCHING" (2026-11-08).
Approved architecture, not re-litigated here: a time-constrained,
substitution-aware dynamic-programming sequence matcher between score
notes and performed (Basic Pitch) events, replacing the prior rounds'
isolated per-note classification (which forced every event into a
binary correct/substitution decision with no explicit ambiguous
state, and which the 2026-11-08 rounds already showed tops out at a
~16% FP reduction once properly constrained to production's real
boundary rule).

INPUT A — score notes: `partitura`'s `note_array()` (`onset_beat`,
`pitch`, `duration_beat`) over the same already-cached, already-
verified MusicXML in `visual_corpus/clean/` every script this
investigation uses — the same canonical representation
`parse_musicxml`/page-omr-adapter ultimately produce and verify
against, not a new one.

INPUT B — performed events: Basic Pitch's own already-extracted note
events (`time_sec`, `end_sec`, `midi`), unchanged from every Basic
Pitch round this week.

INPUT C — timing alignment: `pa.AudioToScoreMatcher`, unchanged,
giving each score note a `performance_time` used to constrain
plausible correspondences — never pitch-gated (verified directly
against its source in the 2026-11-04 round: it assigns a time to
EVERY score note regardless of pitch).

**Cost model, fixed BEFORE this module ever sees the 8-piece
benchmark, per the directive's explicit anti-overfitting instruction:**
pitch and timing costs are REUSED VERBATIM, not reinvented, from
`note_sequence_evaluator.py` (`pitch_cost`, `timing_cost`) — a cost
model already frozen on 2026-10-31 "against hand-constructed cases
only... do not adjust to change a real-corpus result" (that module's
own `FREEZE_NOTE`). This experiment adds exactly ONE new term,
duration compatibility, justified and bounded the same way: capped,
secondary in weight to pitch/timing, and calibrated only against the
deterministic unit tests in `test_sequence_error_matcher.py`, never
against the 8-piece benchmark. See `DURATION_MAX`/`DURATION_SCALE`
below for the exact values and the reasoning.

**Explicit three-way pitch classification, not forced into a binary
decision (the directive's own "preserve ambiguous cases" instruction):**
  - "correct": pitch matches exactly (0 semitones).
  - "ambiguous_pitch": 1 semitone off, OR an octave displacement
    (pc_dist==0, semis>0) — reusing the SAME threshold this entire
    investigation has used all week (`is_substitution` in
    `basic_pitch_score_adapter.py`: confirmed substitution requires
    >=2 semitones AND non-octave). A 1-semitone or octave-related
    reading is evidence of SOMETHING but not confidently a wrong note
    — reported as ambiguous, never silently promoted to a confirmed
    claim.
  - "substitution": >=2 semitones away AND not an octave — a
    confirmed wrong-pitch claim, same bar as every detector this
    investigation has built.

Unmatched score notes are explicit "deletion" entries (not silently
dropped, not misreported as a vague "unmatched"); unmatched performed
events are explicit "insertion" entries. `AutomaticNoteMatcher` is
NOT invoked anywhere in this module — the exact structural bug this
investigation found in it (pitch-equality-gated matching that routes
wrong-pitch notes into "deletion" before any distance check runs,
2026-11-04/05) is why this module's own DP never requires pitch
equality as a precondition for correspondence (item 1, 4 of the
directive's "essential matching behavior").

No independent confidence/duration/neighbor/cross-model filtering
layer is stacked on top of this matcher's own joint cost, per the
directive's explicit instruction to avoid "another collection of
independent... gates" — the joint DP cost IS the mechanism.

Monophonic only, for this prototype (directive item 7) — the
interface (`ScoreNote`/`PerformedEvent` as flat ordered sequences) is
intentionally agnostic to how those sequences were built, which is
what a future polyphonic extension would need to change, not this
module's own DP core.

`worker.py` is not imported or modified by this module's core DP
logic (only the benchmark harness, a separate file, reuses
`worker.run_pitch_tracking`/`parse_musicxml` the same way every other
script this week does). No production code touched.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Cost model -- pitch_cost/timing_cost REUSED VERBATIM from
# note_sequence_evaluator.py (frozen 2026-10-31, hand-constructed cases
# only). Only DURATION_* is new to this module; fixed against this
# module's own deterministic unit tests, never against the benchmark.
# ---------------------------------------------------------------------------
DELETE_COST = 1.0
INSERT_COST = 1.0
OCTAVE_COST = 0.5
SUBSTITUTION_MAX = 1.8
PITCH_SCALE = 12.0
TIMING_MAX = 1.0
TIMING_SCALE = 2.0

# Duration-compatibility term: a SECONDARY signal (smaller max
# contribution than pitch or timing), bounded the same way those are.
# A performed note whose duration is wildly incompatible with the
# expected note's score duration (scaled by locally-estimated tempo)
# is weaker evidence of correspondence -- but duration alone should
# never veto a correspondence a confident pitch+timing match supports,
# so its cap (0.4) is deliberately well below DELETE_COST+INSERT_COST
# (2.0) and below SUBSTITUTION_MAX+TIMING_MAX (2.8) that a clearly
# wrong pairing would already accumulate. Calibrated only against
# test_sequence_error_matcher.py's tempo-variation and
# consecutive-neighboring-pitch cases, not the 8-piece benchmark.
DURATION_MAX = 0.4
DURATION_RATIO_CAP = 3.0  # a 3x (or 1/3x) duration ratio reaches the cap

# Pitch classification thresholds -- same bar used throughout this
# investigation (basic_pitch_score_adapter.is_substitution).
SUBSTITUTION_SEMITONES = 2


def pitch_cost(semis: int) -> float:
    semis = abs(semis)
    if semis == 0:
        return 0.0
    if semis % 12 == 0:
        return OCTAVE_COST
    return min(1.0, semis / PITCH_SCALE) * SUBSTITUTION_MAX


def timing_cost(dt: float) -> float:
    return min(1.0, abs(dt) / TIMING_SCALE) * TIMING_MAX


def duration_cost(expected_dur: float | None, performed_dur: float | None) -> float:
    """0 if either duration is unknown (never penalize missing data);
    otherwise a capped penalty for a ratio far from 1.0."""
    if expected_dur is None or performed_dur is None or expected_dur <= 0 or performed_dur <= 0:
        return 0.0
    ratio = max(expected_dur, performed_dur) / min(expected_dur, performed_dur)
    if ratio <= 1.0:
        return 0.0
    excess = min(ratio, DURATION_RATIO_CAP) - 1.0
    cap_excess = DURATION_RATIO_CAP - 1.0
    return (excess / cap_excess) * DURATION_MAX


def pitch_classification(semis: int) -> str:
    semis = abs(semis)
    if semis == 0:
        return "correct"
    if semis % 12 == 0:
        return "ambiguous_pitch"  # octave displacement
    if semis < SUBSTITUTION_SEMITONES:
        return "ambiguous_pitch"  # 1 semitone -- not confidently a wrong note
    return "substitution"


@dataclass
class ScoreNote:
    score_idx: int
    expected_midi: int
    expected_time: float | None       # from Parangonar AudioToScoreMatcher
    expected_duration_sec: float | None = None
    measure: int | None = None


@dataclass
class PerformedEvent:
    perf_idx: int
    time_sec: float
    end_sec: float
    midi: int

    @property
    def duration_sec(self) -> float:
        return max(0.0, self.end_sec - self.time_sec)


@dataclass
class MatchOp:
    op: str  # "match" | "deletion" | "insertion"
    score_idx: int | None
    perf_idx: int | None
    pitch_status: str | None = None  # "correct" | "ambiguous_pitch" | "substitution" | None
    cost: float = 0.0
    expected_midi: int | None = None
    played_midi: int | None = None
    measure: int | None = None


def match_cost(g: ScoreNote, p: PerformedEvent) -> float:
    pc = pitch_cost(g.expected_midi - p.midi)
    tc = timing_cost((g.expected_time - p.time_sec) if g.expected_time is not None else TIMING_SCALE * 10)
    dc = duration_cost(g.expected_duration_sec, p.duration_sec)
    return pc + tc + dc


def align_sequences(score_notes: list[ScoreNote], performed_events: list[PerformedEvent]) -> list[MatchOp]:
    """
    Conventional edit-distance DP (match/substitution, insertion,
    deletion) over score notes (G) and performed events (P), ordered
    by score position / onset time respectively. Tie-breaking:
    MATCH > DELETE > INSERT on exactly equal cost, same convention
    `note_sequence_evaluator.py` already uses, checked in that fixed
    order so only a STRICTLY lower cost replaces the current best.
    """
    n, m = len(score_notes), len(performed_events)
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    back = [[None] * (m + 1) for _ in range(n + 1)]

    for i in range(1, n + 1):
        dp[i][0] = dp[i - 1][0] + DELETE_COST
        back[i][0] = "delete"
    for j in range(1, m + 1):
        dp[0][j] = dp[0][j - 1] + INSERT_COST
        back[0][j] = "insert"

    for i in range(1, n + 1):
        g = score_notes[i - 1]
        dp_i, dp_im1, back_i = dp[i], dp[i - 1], back[i]
        for j in range(1, m + 1):
            p = performed_events[j - 1]

            best_cost = dp_im1[j - 1] + match_cost(g, p)
            best_move = "match"

            delete_cost = dp_im1[j] + DELETE_COST
            if delete_cost < best_cost:
                best_cost, best_move = delete_cost, "delete"

            insert_cost = dp_i[j - 1] + INSERT_COST
            if insert_cost < best_cost:
                best_cost, best_move = insert_cost, "insert"

            dp_i[j] = best_cost
            back_i[j] = best_move

    ops: list[MatchOp] = []
    i, j = n, m
    while i > 0 or j > 0:
        move = back[i][j]
        if move == "match":
            g, p = score_notes[i - 1], performed_events[j - 1]
            semis = g.expected_midi - p.midi
            ops.append(MatchOp(
                op="match", score_idx=g.score_idx, perf_idx=p.perf_idx,
                pitch_status=pitch_classification(semis), cost=match_cost(g, p),
                expected_midi=g.expected_midi, played_midi=p.midi, measure=g.measure,
            ))
            i, j = i - 1, j - 1
        elif move == "delete":
            g = score_notes[i - 1]
            ops.append(MatchOp(op="deletion", score_idx=g.score_idx, perf_idx=None,
                                expected_midi=g.expected_midi, measure=g.measure, cost=DELETE_COST))
            i -= 1
        else:  # insert
            p = performed_events[j - 1]
            ops.append(MatchOp(op="insertion", score_idx=None, perf_idx=p.perf_idx,
                                played_midi=p.midi, cost=INSERT_COST))
            j -= 1

    ops.reverse()
    return ops
