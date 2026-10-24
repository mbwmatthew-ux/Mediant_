"""
Stage 1 of the visual score-reading validation harness: renders the
existing MusicNet corpus (/Users/matthewwu/.cache/mediant_validation/data)
to clean sheet-music page images with self-consistent, known-correct
ground truth.

NOT part of the production Modal image — a local tool, run in the
dedicated validation venv (same category as validate_alignment_against_
musicnet.py). See docs/superpowers/specs/2026-10-23-visual-score-reading-
validation-harness-design.md for the full design and the direct
investigation (part-selection rule, tempo-mark stripping, rendering
toolchain) that grounds every choice below.

Usage:
    python3 build_visual_validation_corpus.py \\
        --data-dir /Users/matthewwu/.cache/mediant_validation/data \\
        --out-dir /Users/matthewwu/.cache/mediant_validation/visual_corpus
"""
import argparse
import csv
import json
import os
from pathlib import Path

import music21


def select_real_part(score: "music21.stream.Score") -> "music21.stream.Part":
    """
    Returns the Part with the most notes.

    music21's MIDI import of a MusicNet piece splits it into 1-4 "parts",
    but confirmed across all 24 real pieces (all independently confirmed
    "Solo <Instrument>" in musicnet_metadata.csv, no ensembles): exactly
    one part is the real musical line, always with a dramatic note-count
    lead over the rest (e.g. piece 2186: 1375 vs. 265; piece 2297: 1293
    vs. 49/5/3). The smaller parts are MIDI-encoding artifacts — on piece
    2186, both of its 2 parts carried the identical 66 MetronomeMark
    tempo-automation events, confirming the smaller part is a duplicated
    automation track, not a real second voice.
    """
    return max(score.parts, key=lambda p: len(list(p.flatten().notes)))


def strip_tempo_marks(part: "music21.stream.Part") -> None:
    """
    Removes every MetronomeMark from `part`, in place.

    Rendered without stripping, these tempo-automation events (one per
    MIDI tempo-change event, carried over from the original performance's
    expressive timing) show up as a visible "[] = NNN" box above the
    staff for EVERY event — confirmed on piece 2186: ~66 of them, turning
    a clean page into a second, mostly-empty staff cluttered with tempo
    boxes. A real printed score does not show this; it has nothing to do
    with what the OMR pipeline under test is being measured on.
    """
    for mm in list(part.flatten().getElementsByClass('MetronomeMark')):
        part.remove(mm, recurse=True)


def extract_ground_truth_measures(measured: "music21.stream.Stream") -> list:
    """
    Walks `measured` (the output of a Part's .makeMeasures()) and builds
    ground truth containing the 4 fields (`pitch`/`is_rest`/`beat`/
    `duration_beats`) that worker.py's `_measure_fingerprint` actually
    compares — not a full copy of worker.py's richer note dict (see
    parse_musicxml's note-building block, re-grep `el.pitch.nameWithOctave`
    for its current line, it drifts). That richer dict also carries
    `articulation`/`dynamic`; those are deliberately omitted here because
    `_measure_fingerprint` itself ignores them (see that function's own
    docstring in worker.py). `beat` is music21's own `.beat` property,
    `duration_beats` is music21's own `.duration.quarterLength` (confirmed
    directly in worker.py: "a music21 quarterLength, despite the name").

    Confirmed by direct inspection of all 24 real MusicNet pieces after
    this pipeline's part-selection + tempo-stripping + makeMeasures:
    every measure's notesAndRests is a flat, monophonic sequence (zero
    Chord objects, zero Voice objects, zero simultaneous-offset Note
    pairs found across a 60-measure sample of the most chord-prone piece,
    Cello Suite 3's Prelude). Chord handling below is a defensive
    fallback for a shape never actually observed in this corpus, not a
    load-bearing assumption.
    """
    import music21 as m21

    out = []
    for measure in measured.getElementsByClass('Measure'):
        notes_out = []
        for el in measure.notesAndRests:
            if isinstance(el, m21.note.Rest):
                notes_out.append({
                    "pitch": None,
                    "is_rest": True,
                    "beat": float(el.beat),
                    "duration_beats": float(el.duration.quarterLength),
                })
            elif isinstance(el, m21.chord.Chord):
                # Defensive: not observed in this corpus (see docstring),
                # but a Chord's constituent pitches would otherwise be
                # silently dropped.
                for p in el.pitches:
                    notes_out.append({
                        "pitch": p.nameWithOctave,
                        "is_rest": False,
                        "beat": float(el.beat),
                        "duration_beats": float(el.duration.quarterLength),
                    })
            elif isinstance(el, m21.note.Note):
                notes_out.append({
                    "pitch": el.pitch.nameWithOctave,
                    "is_rest": False,
                    "beat": float(el.beat),
                    "duration_beats": float(el.duration.quarterLength),
                })
        out.append({"number": measure.number, "notes": notes_out})
    return out
