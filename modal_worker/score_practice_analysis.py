"""
Deterministic, score-only practice-target analysis for V2.

Uses ONLY the canonical score representation already produced by
page_omr_adapter.kern_to_measures / parse_musicxml / read_score_notes_claude
(measures: [{"number", "notes": [{"pitch","is_rest","beat","duration_beats",
"part","voice","tied"}, ...]}]) -- no audio, no performance data, no paid
model calls. See "MEDIANT -- Build Score-Grounded Practice Recommendations".

This module never claims the musician played anything wrong. It identifies
passages that are, by the score's own structure, relatively more demanding
than the rest of the piece -- large melodic leaps, locally dense note
attacks, and simultaneous/chordal/multi-voice complexity -- and turns the
most salient few into concrete, measure-specific practice suggestions.
Every threshold is relative to the piece's own content (its own median
interval/density), not a universal difficulty scale.
"""
from __future__ import annotations

import re

_MAX_TARGETS = 5
_MIN_LEAP_SEMITONES = 5.0
_LEAP_RELATIVE_MULT = 2.0
_MIN_DENSITY_NOTES = 4.0
_DENSITY_RELATIVE_MULT = 1.5
_MIN_CHORD_SIZE = 3
_MIN_VOICE_COUNT = 2

_ACCIDENTAL_STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_PITCH_RE = re.compile(r"^([A-Ga-g])([#\-]*)(-?\d+)$")


def _pitch_to_midi(pitch_name: str | None) -> int | None:
    """Converts a music21-style nameWithOctave (e.g. 'C#5', 'B-4') to a MIDI-
    like integer. Returns None for anything unparseable rather than guessing."""
    if not pitch_name:
        return None
    m = _PITCH_RE.match(pitch_name)
    if not m:
        return None
    letter, accidental, octave = m.groups()
    semitone = _ACCIDENTAL_STEP[letter.upper()]
    semitone += accidental.count("#") - accidental.count("-")
    return semitone + (int(octave) + 1) * 12


def _median(values: list[float]) -> float:
    s = sorted(values)
    n = len(s)
    mid = n // 2
    if n % 2:
        return float(s[mid])
    return (s[mid - 1] + s[mid]) / 2.0


def _is_attack(note: dict) -> bool:
    """A new sounding onset -- excludes rests and tied continuations
    ('continue'/'stop' pick up a sound already started by a previous note,
    so they are never counted as a second attack of the same note)."""
    if note.get("is_rest"):
        return False
    return note.get("tied") not in ("continue", "stop")


def _build_tracks(measures: list[dict]) -> dict[tuple[int, object], list[dict]]:
    """
    Groups attack events by (part, voice) track, in piece order. Chord tones
    that share the same (part, voice, beat, measure) are collapsed into ONE
    event carrying every pitch -- so a chord is always one onset-event, never
    several sequential ones, and can never be read as a melodic leap between
    its own tones.
    """
    tracks: dict[tuple[int, object], list[dict]] = {}
    for m in measures:
        number = m.get("number")
        if number is None:
            continue
        events: dict[tuple, list[int]] = {}
        order: dict[tuple, int] = {}
        for note in m.get("notes", []):
            if not _is_attack(note):
                continue
            midi = _pitch_to_midi(note.get("pitch"))
            if midi is None:
                continue
            part = note.get("part", 0)
            voice = note.get("voice")
            beat = note.get("beat")
            key = (part, voice, beat)
            events.setdefault(key, []).append(midi)
        for (part, voice, beat), pitches in events.items():
            tracks.setdefault((part, voice), []).append(
                {"measure": number, "beat": beat, "pitches": sorted(pitches)}
            )
    for key in tracks:
        tracks[key].sort(key=lambda e: (e["measure"], e["beat"]))
    return tracks


def _leap_events(track_events: list[dict]) -> list[dict]:
    """
    Consecutive-EVENT intervals only (never tone-to-tone within one chord
    event) -- each event is represented by its highest pitch, a skyline
    reduction, so a chord never introduces a spurious leap at its own onset.
    """
    out = []
    prev_top = None
    prev_measure = None
    for ev in track_events:
        top = max(ev["pitches"])
        if prev_top is not None:
            out.append({
                "from_measure": prev_measure,
                "to_measure": ev["measure"],
                "interval_semitones": abs(top - prev_top),
            })
        prev_top, prev_measure = top, ev["measure"]
    return out


def _density_per_measure(track_events: list[dict]) -> dict[int, int]:
    counts: dict[int, int] = {}
    for ev in track_events:
        counts[ev["measure"]] = counts.get(ev["measure"], 0) + 1
    return counts


def _complexity_per_measure(tracks: dict[tuple[int, object], list[dict]]) -> dict[int, dict]:
    result: dict[int, dict] = {}
    for (part, voice), events in tracks.items():
        for ev in events:
            slot = result.setdefault(
                ev["measure"], {"voices": set(), "max_chord": 0, "chord_part_voice": None}
            )
            slot["voices"].add((part, voice))
            if len(ev["pitches"]) > slot["max_chord"]:
                slot["max_chord"] = len(ev["pitches"])
                slot["chord_part_voice"] = (part, voice)
    return result


def _leap_candidates(tracks: dict) -> list[dict]:
    per_track_leaps = {key: _leap_events(events) for key, events in tracks.items()}
    all_intervals = [l["interval_semitones"] for leaps in per_track_leaps.values() for l in leaps]
    if not all_intervals:
        return []
    piece_median = _median(all_intervals)
    threshold = max(_MIN_LEAP_SEMITONES, piece_median * _LEAP_RELATIVE_MULT)
    out = []
    for (part, voice), leaps in per_track_leaps.items():
        for leap in leaps:
            if leap["interval_semitones"] < threshold:
                continue
            out.append({
                "measureStart": min(leap["from_measure"], leap["to_measure"]),
                "measureEnd": max(leap["from_measure"], leap["to_measure"]),
                "part": part, "voice": voice,
                "characteristic": "large_melodic_interval",
                "evidence": {
                    "intervalSemitones": leap["interval_semitones"],
                    "pieceMedianIntervalSemitones": round(piece_median, 2),
                },
                "suggestion": (
                    "Practice the transition between these two notes slowly and in "
                    "isolation before bringing it back up to tempo."
                ),
                "source": "score-based",
                "_salience": leap["interval_semitones"] / threshold,
            })
    return out


def _density_candidates(tracks: dict) -> list[dict]:
    out = []
    for (part, voice), events in tracks.items():
        per_measure = _density_per_measure(events)
        if not per_measure:
            continue
        median = _median(list(per_measure.values()))
        threshold = max(_MIN_DENSITY_NOTES, median * _DENSITY_RELATIVE_MULT)
        for measure, count in per_measure.items():
            if count < threshold:
                continue
            out.append({
                "measureStart": measure, "measureEnd": measure,
                "part": part, "voice": voice,
                "characteristic": "dense_passage",
                "evidence": {
                    "notesInMeasure": count,
                    "pieceMedianNotesPerMeasure": round(median, 2),
                },
                "suggestion": (
                    "Rehearse this passage in small groups of notes at a manageable "
                    "tempo before playing it through at full speed."
                ),
                "source": "score-based",
                "_salience": count / threshold,
            })
    return out


def _complexity_candidates(tracks: dict) -> list[dict]:
    per_measure = _complexity_per_measure(tracks)
    out = []
    for measure, info in sorted(per_measure.items()):
        if info["max_chord"] >= _MIN_CHORD_SIZE and info["chord_part_voice"] is not None:
            part, voice = info["chord_part_voice"]
            out.append({
                "measureStart": measure, "measureEnd": measure,
                "part": part, "voice": voice,
                "characteristic": "chord_complexity",
                "evidence": {"simultaneousPitches": info["max_chord"]},
                "suggestion": (
                    "Isolate this chord's pitches and practice the voicing on its own "
                    "before playing it in tempo."
                ),
                "source": "score-based",
                "_salience": float(info["max_chord"]),
            })
        if len(info["voices"]) >= _MIN_VOICE_COUNT:
            parts_voices = sorted(
                ((p, v) for p, v in info["voices"]), key=lambda pv: (pv[0], pv[1] is None, pv[1])
            )
            out.append({
                "measureStart": measure, "measureEnd": measure,
                "part": None, "voice": None,
                "characteristic": "simultaneous_voices",
                "evidence": {
                    "independentVoiceCount": len(info["voices"]),
                    "partsAndVoices": [{"part": p, "voice": v} for p, v in parts_voices],
                },
                "suggestion": (
                    "Practice each part/voice separately before combining them in this "
                    "passage."
                ),
                "source": "score-based",
                "_salience": float(len(info["voices"])),
            })
    return out


def _merge_and_rank(candidates: list[dict]) -> list[dict]:
    """Merges adjacent/overlapping same-(characteristic, part, voice) candidates
    into one measure range, keeping the most salient sub-event's evidence, then
    ranks by salience and caps at _MAX_TARGETS."""
    groups: dict[tuple, list[dict]] = {}
    for c in candidates:
        key = (c["characteristic"], c["part"], c["voice"])
        groups.setdefault(key, []).append(c)

    merged: list[dict] = []
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
                    merged.append(current)
                current = dict(c)
        if current is not None:
            merged.append(current)

    merged.sort(key=lambda c: c["_salience"], reverse=True)
    for c in merged:
        c.pop("_salience", None)
    return merged[:_MAX_TARGETS]


def analyze_score_for_practice(score_dict: dict) -> dict:
    """
    Produces up to five evidence-grounded, measure-specific practice targets
    from a canonical score dict (the same shape page_omr_adapter/parse_musicxml/
    read_score_notes_claude already return). Never detects or implies
    performance errors -- this is score-only analysis.

    Returns {"status": "available"|"unavailable", "reason": str|None,
    "scope": {...} (only when status=="available"), "targets": [...]}.
    """
    measures = score_dict.get("measures") or []
    if score_dict.get("error") or not measures:
        return {
            "status": "unavailable",
            "reason": "no recognized score measures are available for practice analysis",
            "targets": [],
        }

    tracks = _build_tracks(measures)
    measure_numbers = sorted(m.get("number") for m in measures if m.get("number") is not None)
    if not measure_numbers:
        return {
            "status": "unavailable",
            "reason": "recognized measures have no usable measure numbering",
            "targets": [],
        }

    scope: dict = {"measureStart": measure_numbers[0], "measureEnd": measure_numbers[-1]}
    failed_pages = score_dict.get("failed_pages") or []
    if score_dict.get("partial_error") or failed_pages:
        scope["partial"] = True
        scope["note"] = (
            f"recommendations are scoped only to the measures Mediant actually "
            f"recognized; page(s) {failed_pages} were not read and are excluded "
            f"from this analysis" if failed_pages else
            "recommendations are scoped only to the measures Mediant actually "
            "recognized; some pages were not fully read"
        )

    candidates = (
        _leap_candidates(tracks) + _density_candidates(tracks) + _complexity_candidates(tracks)
    )
    targets = _merge_and_rank(candidates)

    return {
        "status": "available",
        "reason": None if targets else (
            "no passage in the recognized measures stood out from the piece's own "
            "typical interval size, note density, or voice/chord complexity"
        ),
        "scope": scope,
        "targets": targets,
    }
