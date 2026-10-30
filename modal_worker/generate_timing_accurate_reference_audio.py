"""Gate 1B — standalone, experimental timing-accurate reference-audio
generator for the LadderSym benchmark. NOT production code; not wired
into worker.py; not imported by anything else in the pipeline.

Renders `score_audio` for LadderSym from MusicNet's validated ground
truth (onset_sec/end_sec/note), instead of trusting the cached MIDI
files' own tempo tracks (shown in Gate 1 to diverge from real performance
timing by 10-32% on 16 of 18 held-out pieces). Provenance of that ground
truth, confirmed via the MusicNet paper (Thickstun, Harchaoui & Kakade,
"Learning Features of Music from Scratch", arXiv:1611.09827): note
*identity* (pitch) comes from the digital MIDI score; note *timing* comes
from DTW-aligning that score to the real recording; labels are musician-
verified at an estimated 4% error rate. This is "the correct note, played
at the time it was really played" -- not a transcription of whatever the
performer actually got wrong -- which is exactly the score_audio contract
LadderSym's training data construction uses (Gate 1 finding: its own
CocoChorales-E `score_audio` is a stem rendered from the same take's
clean MIDI, sharing that take's timeline).

Deliberately reuses Mediant's existing `gm_program_for_instrument` for
GM program selection (imported directly from worker.py, not
reimplemented) -- the same instrument-to-timbre mapping production uses.
Deliberately does NOT apply `transpose_for_instrument`: MusicNet's `note`
values are already absolute/concert-pitch MIDI numbers (verified against
real audio via DTW), and flute/violin/cello are non-transposing
instruments in Mediant's own INSTRUMENT_TRANSPOSE table in any case, so
applying a transposition here would be both wrong (the label is already
concert pitch) and a no-op for these three instruments regardless.

Soundfont: pretty_midi's bundled TimGM6mb.sf2, NOT production's
`/usr/share/sounds/sf2/FluidR3_GM.sf2` -- that file is an apt package on
Modal's Linux container and isn't available in this local macOS dev
environment. Both are General MIDI-compliant (same program numbers map
to the same instrument families), so this doesn't affect the benchmark's
timing-validation purpose, but it IS a real deviation from production's
exact timbre that would need reconciling before any production use --
see the module docstring's benchmark-vs-production distinction, which
this file does not attempt to resolve.
"""
import io
import sys
from pathlib import Path

import numpy as np
import pretty_midi
import soundfile as sf

sys.path.insert(0, str(Path(__file__).parent))
from worker import gm_program_for_instrument  # noqa: E402

SAMPLE_RATE = 16000  # LadderSym's required input rate (Gate 1 finding)
_SF2_PATH = str(Path(pretty_midi.__file__).parent / "TimGM6mb.sf2")


def render_timing_accurate_reference_audio(
    ground_truth_notes: list[dict], instrument: str, sr: int = SAMPLE_RATE,
) -> bytes:
    """
    Renders a WAV (bytes) from real per-note timing.

    ground_truth_notes: list of {"onset_sec": float, "note": int (MIDI,
    absolute pitch), "end_sec": float}. Overlapping/repeated notes are
    NOT deduplicated or merged -- pretty_midi.Instrument.notes is just a
    list, and fluidsynth renders true polyphony from overlapping Note
    objects, so chords/repeated attacks/held-over-next-onset notes all
    come through as what they are.
    """
    program = gm_program_for_instrument(instrument)
    midi = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=program)
    for n in ground_truth_notes:
        start, end = float(n["onset_sec"]), float(n["end_sec"])
        if end <= start:
            continue
        pitch = max(0, min(127, int(n["note"])))
        inst.notes.append(pretty_midi.Note(velocity=90, pitch=pitch, start=start, end=end))
    midi.instruments.append(inst)

    audio = midi.fluidsynth(fs=sr, sf2_path=_SF2_PATH)

    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="FLOAT")
    return buf.getvalue()
