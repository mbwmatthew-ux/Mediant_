"""
"MEDIANT — Basic Pitch wrong-note detection integration" (2026-11-04,
second round). Builds directly on the previous round's finding: Basic
Pitch's note extraction is materially better than CREPE's
(`basic_pitch_vs_crepe_report.py`), but feeding it through Parangonar's
`AutomaticNoteMatcher` produced 0/6 recall because that matcher's
fine-grained stage (`SequenceAugmentedGreedyMatcher`, verified directly
against its source) buckets notes by EXACT PITCH before ever
considering a match -- a wrong-pitch performance note can never pair
with its true score counterpart; it becomes a same-pitch "insertion"
elsewhere while the true note becomes a "deletion". See the Task 1
write-up in `agent_workspace/AUDIO_PIPELINE_AUDIT.md` for the full
source-level evidence (verified, not assumed).

This adapter avoids that bug by construction: it never requires pitch
equality as a precondition for association. It uses
`pa.AudioToScoreMatcher` -- the SAME raw-audio elastic-DP matcher Task 1
(2026-11-01) used for its 92.7-99.2% alignment result -- purely for
TIMING. Verified directly against its source
(`audio_matchers.py::_path_to_alignment`): it iterates over EVERY score
note unconditionally and assigns each one a `performance_time` via time
interpolation over the DP path; the pitch of what was actually played
is never consulted by this step at all. That performance_time is then
used only to locate the nearest Basic-Pitch-detected event in TIME;
whatpitch that event actually has is compared to the expected pitch
only AFTERWARD, as a separate, non-gating step -- exactly the
timing/pitch separation the previous attempt lacked.

Pipeline:
  1. pa.AudioToScoreMatcher(audio, score_note_array) -> performance_time
     per score note (timing only, pitch-blind, unconditional "match").
  2. For each score note, look for the nearest Basic-Pitch note event
     within a bounded time window (bounded by the NEIGHBOURING score
     notes' own predicted performance_time, capped at MAX_WINDOW_SEC,
     mirroring this session's established "don't let a window bleed
     into a neighbour" principle) -- selection is by TIME PROXIMITY
     ONLY, never by pitch.
  3. Compare the located event's pitch to the score note's expected
     pitch using the SAME distance/octave RULE `find_wrong_note_
     candidates` uses (>=2 semitones away AND non-octave, worker.py
     ~7412) -- the rule is reused verbatim (same thresholds), not the
     function itself, since that function's signature assumes CREPE-
     specific per-event confidence/spread/duration fields Basic Pitch's
     note events don't carry in the same form.
  4. Classify each score note as "correct", "substitution" (the
     distance/octave gate fires), or "deletion" (no Basic Pitch event
     found in its window) -- deletions are reported explicitly, never
     silently dropped. Basic Pitch events that never fall inside any
     score note's window are reported separately as "insertion" --
     also never silently dropped.

No production code touched. `worker.py` imported for `midi_from_name`-
free pitch comparison (note arrays already carry MIDI ints) --
nothing in it is modified. Isolated venv only.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np

MAX_WINDOW_SEC = 0.5  # cap on how far a score note's search window can extend
DISTANCE_SEMITONES = 2  # same as find_wrong_note_candidates' MIN distance gate
OCTAVE_PC_DISTANCE = 2  # same as find_wrong_note_candidates' pitch-class gate


def note_search_window(t: float, prev_t: float | None, next_t: float | None,
                        max_radius: float = MAX_WINDOW_SEC) -> tuple[float, float]:
    """Bounds for one score note's search window: half the gap to each
    neighbouring score note's own predicted performance_time, capped at
    max_radius -- prevents one note's window from reaching past where
    the adjacent note is itself expected."""
    left = max_radius if prev_t is None else min(max_radius, max(0.0, (t - prev_t) * 0.5))
    right = max_radius if next_t is None else min(max_radius, max(0.0, (next_t - t) * 0.5))
    return t - left, t + right


def is_substitution(expected_midi: int, played_midi: int) -> bool:
    """Same distance/octave rule as find_wrong_note_candidates (worker.py
    ~7412): >=2 semitones away AND not an octave displacement."""
    dist = abs(played_midi - expected_midi)
    pc_dist = min(dist % 12, 12 - dist % 12)
    return dist >= DISTANCE_SEMITONES and pc_dist >= OCTAVE_PC_DISTANCE


def detect_wrong_notes(na, alignment, performed_events: list[dict]) -> dict:
    """
    `na`: partitura score note_array (fields onset_beat, pitch).
    `alignment`: pa.AudioToScoreMatcher(...) output -- one dict per score
      note, each with "performance_time" (pitch-blind, see module docstring).
    `performed_events`: Basic Pitch note events, [{"time_sec", "end_sec",
      "midi"}, ...] -- need not be time-sorted (sorted here).

    Returns {"notes": [...], "insertions": [...]} -- `notes` has one
    entry per score note (never dropped): {"score_idx", "verdict"
    in {"correct","substitution","deletion"}, "expected_midi",
    "played_midi" (None if deletion), "window": (start, end)}.
    `insertions` lists performed-event indices claimed by no score
    note's window (never silently dropped).
    """
    performed = sorted(enumerate(performed_events), key=lambda ip: ip[1]["time_sec"])
    perf_times = np.array([e["time_sec"] for _, e in performed])

    times = [a.get("performance_time") for a in alignment]
    notes = []
    claimed_perf_idx: set[int] = set()

    for i, t in enumerate(times):
        expected_midi = int(na[i]["pitch"])
        if t is None:
            notes.append({"score_idx": i, "verdict": "deletion", "expected_midi": expected_midi,
                           "played_midi": None, "window": None,
                           "reason": "alignment produced no performance_time"})
            continue

        prev_t = times[i - 1] if i > 0 else None
        next_t = times[i + 1] if i + 1 < len(times) else None
        window_start, window_end = note_search_window(float(t), prev_t, next_t)

        in_window = np.where((perf_times >= window_start) & (perf_times <= window_end))[0]
        if len(in_window) == 0:
            notes.append({"score_idx": i, "verdict": "deletion", "expected_midi": expected_midi,
                           "played_midi": None, "window": (window_start, window_end),
                           "reason": "no Basic Pitch event found in expected time window"})
            continue

        # Nearest in TIME to the expected time -- never by pitch.
        nearest_local = in_window[np.argmin(np.abs(perf_times[in_window] - t))]
        orig_idx, event = performed[nearest_local]
        claimed_perf_idx.add(orig_idx)
        played_midi = int(event["midi"])

        verdict = "substitution" if is_substitution(expected_midi, played_midi) else "correct"
        notes.append({"score_idx": i, "verdict": verdict, "expected_midi": expected_midi,
                       "played_midi": played_midi, "window": (window_start, window_end),
                       "reason": None})

    insertions = [orig_idx for orig_idx, _ in performed if orig_idx not in claimed_perf_idx]
    return {"notes": notes, "insertions": insertions}
