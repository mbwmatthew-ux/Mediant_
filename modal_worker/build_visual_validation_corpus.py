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
