"""
Dynamic-programming note-sequence evaluator.

Replaces two informal matching methods used earlier in this
investigation (an independent nearest-time lookup, and an
order-respecting two-pointer walk) that gave materially different
wrong-pitch counts on the same real data (3268 vs 2447 on the 9
CREPE-bound MusicNet pieces) -- neither was trustworthy enough to act
on. This is a real edit-distance-style alignment: it finds the
GLOBALLY minimum-cost monotonic correspondence between a ground-truth
note sequence and a predicted note sequence, rather than approximating
it with local/greedy decisions.

Problem shape
--------------
Two note sequences, each a list of {"time_sec": float, "midi": int}:
  - ground_truth: G = [g_1 .. g_n]
  - predicted:    P = [p_1 .. p_m]

An alignment is any way of walking both sequences IN ORDER such that
each g_i is either matched to exactly one p_j (with i and j both
increasing along the path) or left unmatched ("missing"), and each p_j
is either matched or left unmatched ("extra"). This is exactly the
edit-distance / sequence-alignment problem (same family as DTW itself,
just applied here to validate a detector rather than to align score to
audio).

Costs (frozen BEFORE any real corpus was examined -- see
note_sequence_evaluator.FREEZE_NOTE below)
--------------------------------------------
  DELETE_COST = INSERT_COST = 1.0
    Flat cost for a ground-truth note with no match ("missing") or a
    predicted event with no match ("extra"). This is the reference
    scale every match cost is compared against.

  Pitch cost, as a function of `semis = abs(g.midi - p.midi)`:
    semis == 0                -> 0.0                  (correct)
    semis % 12 == 0, semis>0  -> OCTAVE_COST = 0.5     (octave error)
    otherwise                 -> min(1.0, semis / PITCH_SCALE) * SUBSTITUTION_MAX
                                  PITCH_SCALE = 12.0, SUBSTITUTION_MAX = 1.8

    An octave error is a qualitatively different failure from a generic
    wrong note -- the pitch CLASS is right, which is far more consistent
    with a measurement/analysis artifact (a doubled or halved
    fundamental) than with a genuinely different note being played. It
    is priced at roughly a quarter of the worst-case generic
    substitution (0.5 vs the 1.8 cap), so the matcher prefers explaining
    an octave-related event as an octave error rather than as an
    unrelated substitution, but still prices it well above a correct
    match.

    A generic substitution's cost rises linearly with semitone distance
    up to a cap at 12 semitones (an octave away, where the octave rule
    above takes over instead) and is capped at 1.8 -- deliberately BELOW
    DELETE_COST + INSERT_COST (2.0), so a plausible nearby substitution
    is still preferred over calling it missing+extra, but combined with
    a timing penalty (below) an implausible pairing can still exceed
    2.0 and correctly fall back to missing+extra.

  Timing cost, as a function of `dt = abs(g.time_sec - p.time_sec)`:
    min(1.0, dt / TIMING_SCALE) * TIMING_MAX
      TIMING_SCALE = 2.0 seconds, TIMING_MAX = 1.0

    Caps at 1.0 once the onset gap reaches 2 seconds. This exists so a
    prediction that is pitch-plausible but absurdly far away in time
    (which would otherwise look like a cheap match) is pushed toward
    missing+extra instead, the same way an absurd pitch distance is.

  match_cost(g, p) = pitch_cost(semis) + timing_cost(dt)

  Worst case (semis >= 12 non-octave AND dt >= 2.0): 1.8 + 1.0 = 2.8,
  which exceeds DELETE_COST + INSERT_COST (2.0) -- confirming the
  matcher prefers two single-sided errors over one absurd pairing,
  while any genuinely close pairing (small semis, small dt) costs much
  less than 2.0 and is preferred as a match. Verified against the
  hand-constructed cases in test_note_sequence_evaluator.py.

Ambiguous matches / tie-breaking
---------------------------------
When two or more DP transitions into a cell carry exactly the same
minimum cost, this implementation prefers, in order: MATCH over DELETE
over INSERT (explaining a correspondence is preferred over leaving
either side unmatched when cost is otherwise tied), and among tied
matches, the one reached by the standard DP recurrence order (MATCH,
then DELETE-of-g, then INSERT-of-p) -- i.e. ties resolve deterministically
toward matching whenever a tie exists at all. This is implemented by
checking the three transitions in that fixed order and only replacing
the current best on a STRICTLY lower cost.

Classification of a matched pair is pitch-only: "correct" (semis==0),
"octave_error" (semis%12==0, semis>0), or "wrong_pitch" (otherwise). The
timing offset of a match is reported as a separate numeric field
(`onset_offset_sec`), never blended into the categorical label -- this
keeps "alignment quality" and "pitch correctness" as separate
measurements, matching this project's own stated principle of not
averaging unrelated metrics into one number.
"""

from __future__ import annotations

DELETE_COST = 1.0
INSERT_COST = 1.0
OCTAVE_COST = 0.5
SUBSTITUTION_MAX = 1.8
PITCH_SCALE = 12.0
TIMING_MAX = 1.0
TIMING_SCALE = 2.0

# This module's cost constants were frozen against ONLY the hand-constructed
# cases in test_note_sequence_evaluator.py, before the real MusicNet corpus
# was examined. Do not adjust these values to change a real-corpus result --
# see the Task 1 report (2026-10-31) for the explicit before/after ordering.
FREEZE_NOTE = (
    "Frozen 2026-10-31 against hand-constructed cases only. "
    "Do not tune against real-corpus results."
)


def pitch_cost(semis: int) -> float:
    semis = abs(semis)
    if semis == 0:
        return 0.0
    if semis % 12 == 0:
        return OCTAVE_COST
    return min(1.0, semis / PITCH_SCALE) * SUBSTITUTION_MAX


def timing_cost(dt: float) -> float:
    return min(1.0, abs(dt) / TIMING_SCALE) * TIMING_MAX


def match_cost(g: dict, p: dict) -> float:
    return pitch_cost(g["midi"] - p["midi"]) + timing_cost(g["time_sec"] - p["time_sec"])


def classify_match(g: dict, p: dict) -> str:
    semis = abs(g["midi"] - p["midi"])
    if semis == 0:
        return "correct"
    if semis % 12 == 0:
        return "octave_error"
    return "wrong_pitch"


class AlignmentResult:
    __slots__ = ("pairs", "missing_idx", "extra_idx", "total_cost")

    def __init__(self, pairs, missing_idx, extra_idx, total_cost):
        self.pairs = pairs              # list[(gt_idx, pred_idx)]
        self.missing_idx = missing_idx  # list[int] -- unmatched ground_truth indices
        self.extra_idx = extra_idx      # list[int] -- unmatched predicted indices
        self.total_cost = total_cost

    def summary(self, ground_truth: list[dict], predicted: list[dict]) -> dict:
        counts = {"missing": len(self.missing_idx), "extra": len(self.extra_idx),
                  "wrong_pitch": 0, "octave_error": 0, "correct": 0}
        for gi, pi in self.pairs:
            counts[classify_match(ground_truth[gi], predicted[pi])] += 1
        return counts


def align_note_sequences(ground_truth: list[dict], predicted: list[dict]) -> AlignmentResult:
    """
    Globally-optimal monotonic alignment between two note sequences.

    Each item in `ground_truth`/`predicted` must have "time_sec" (float)
    and "midi" (int). Returns the minimum-cost alignment under the costs
    documented at module level, with deterministic tie-breaking
    (MATCH > DELETE > INSERT).
    """
    n, m = len(ground_truth), len(predicted)

    # dp[i][j] = min cost to account for ground_truth[:i] and predicted[:j]
    # back[i][j] = one of "match", "delete", "insert" -- how we got here
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    back = [[None] * (m + 1) for _ in range(n + 1)]

    for i in range(1, n + 1):
        dp[i][0] = dp[i - 1][0] + DELETE_COST
        back[i][0] = "delete"
    for j in range(1, m + 1):
        dp[0][j] = dp[0][j - 1] + INSERT_COST
        back[0][j] = "insert"

    for i in range(1, n + 1):
        g = ground_truth[i - 1]
        dp_i = dp[i]
        dp_im1 = dp[i - 1]
        back_i = back[i]
        for j in range(1, m + 1):
            p = predicted[j - 1]

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

    # Backtrack
    pairs: list[tuple[int, int]] = []
    missing_idx: list[int] = []
    extra_idx: list[int] = []
    i, j = n, m
    while i > 0 or j > 0:
        move = back[i][j]
        if move == "match":
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif move == "delete":
            missing_idx.append(i - 1)
            i -= 1
        else:  # "insert"
            extra_idx.append(j - 1)
            j -= 1

    pairs.reverse()
    missing_idx.reverse()
    extra_idx.reverse()
    return AlignmentResult(pairs, missing_idx, extra_idx, dp[n][m])
