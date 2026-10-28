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
import io
import json
import os
from pathlib import Path

import music21
import verovio
import resvg_py
from PIL import Image


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
    Walks `measured` (a Part-like stream containing Measures — either
    the direct output of .makeMeasures(), or a re-parsed-from-disk
    equivalent) and builds ground truth containing the 4 fields
    (`pitch`/`is_rest`/`beat`/`duration_beats`) that worker.py's
    `_cross_source_measure_match` (and, for same-source comparisons,
    `_measure_fingerprint`) actually compare — not a full copy of
    worker.py's richer note dict (see parse_musicxml's note-building
    block, re-grep `el.pitch.nameWithOctave` for its current line, it
    drifts). That richer dict also carries `articulation`/`dynamic`;
    those are deliberately omitted here because both comparison
    functions ignore them. `beat` is music21's own `.beat` property,
    `duration_beats` is music21's own `.duration.quarterLength` (confirmed
    directly in worker.py: "a music21 quarterLength, despite the name").

    CORRECTION (final-review I2): an earlier version of this docstring
    claimed "zero Chord objects, zero Voice objects, zero simultaneous-
    offset Note pairs" were found across the corpus. That claim was
    false — the final review found 116 measures with simultaneous
    events across the real 24-piece corpus (e.g. piece 2191's opening
    double stops). Simultaneous/chord-like content (double stops, etc.)
    DOES occur here; the Chord-handling branch below is load-bearing,
    not defensive. `_cross_source_measure_match` (like
    `_measure_fingerprint` before it) compares notes in LIST ORDER, not
    sorted by pitch/offset — this is an inherited characteristic of the
    production function being reused here, not a new limitation, so no
    additional sorting/normalization is added in this module beyond
    whatever `_cross_source_measure_match` itself does.
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


def render_musicxml_to_pngs(musicxml_path: str, out_prefix: str) -> list:
    """
    Renders every page of `musicxml_path` to `{out_prefix}_page{N}.png`
    (1-indexed), returning the written paths.

    verovio only renders to SVG natively (confirmed: no renderToPNG/
    renderToBitmap method exists on its toolkit); resvg-py does the
    SVG->PNG step. Both install as prebuilt wheels with zero system
    library dependencies (confirmed on this machine) — cairosvg was
    tried first and rejected for needing a system libcairo that isn't
    present.

    (C2 fix) `resvg_py.svg_to_bytes`'s output is RGBA with a fully
    TRANSPARENT background whose underlying RGB is (0, 0, 0), not
    (255, 255, 255) — confirmed directly: `Image.open(...).convert("L")`
    on a raw write of these bytes gives mean pixel value 0.0, i.e. every
    pixel black. It only *looks* white in a viewer that composites
    transparency onto a white canvas. `read_score_notes_claude`'s own
    pipeline converts to "L"/"RGB" with plain `.convert()`, which drops
    alpha without compositing, so every page would be read as solid
    black. Must flatten onto a real white RGB canvas before writing —
    same pattern degrade_visual_corpus.py's main() already uses for the
    degraded tiers.
    """
    tk = verovio.toolkit()
    ok = tk.loadFile(musicxml_path)
    if not ok:
        return []
    paths = []
    for page_num in range(1, tk.getPageCount() + 1):
        svg = tk.renderToSVG(page_num)
        png_bytes = bytes(resvg_py.svg_to_bytes(svg_string=svg))
        img = Image.open(io.BytesIO(png_bytes))
        if img.mode == "RGBA":
            background = Image.new("RGB", img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[3])
            img = background
        else:
            img = img.convert("RGB")
        out_path = f"{out_prefix}_page{page_num}.png"
        img.save(out_path, format="PNG")
        paths.append(out_path)
    return paths


def build_synthetic_piano_entry(out_dir: "Path") -> dict:
    """
    Builds ONE synthetic piano (grand-staff) piece, since MusicNet (confirmed
    via direct inspection of all 24 rows this session) contains zero piano
    pieces — every piece is solo violin/cello/flute. Reuses the exact same
    render_musicxml_to_pngs pipeline every other corpus entry uses, so this
    piece is scored identically, not through a parallel code path.

    Returns {"n_pages": int, "measures": [...], "time_signature": str,
    "instrument": "Piano"} — the same shape build_corpus_entry returns,
    plus "instrument". (Deviation from the task brief's literal code: the
    brief had this function return `extract_ground_truth_measures(...)`
    directly and then assign `entry["n_pages"]`/`entry["instrument"]` onto
    it, which assumes that function returns a dict with a "measures" key.
    It actually returns a bare list of measure dicts — confirmed by its
    own "-> list" annotation and by build_corpus_entry's own usage just
    below, which wraps that list into a dict itself. Fixed here to match
    the real, already-established contract instead of reintroducing that
    mismatch.)
    """
    from music21 import stream, note, meter, instrument as m21_instrument, metadata

    piano_part = stream.Part()
    piano_part.insert(0, m21_instrument.Piano())
    piano_part.append(meter.TimeSignature('4/4'))
    pitches = ['C4', 'E4', 'G4', 'C5', 'B4', 'G4', 'E4', 'C4'] * 4
    for p in pitches:
        piano_part.append(note.Note(p, quarterLength=1.0))
    measured = piano_part.makeMeasures()
    measured.metadata = metadata.Metadata()
    measured.metadata.title = "Synthetic Piano Grand-Staff Test Piece"
    measured.metadata.composer = "Mediant validation harness"

    musicxml_path = out_dir / "piano_synthetic.musicxml"
    measured.write('musicxml', fp=str(musicxml_path))

    pngs = render_musicxml_to_pngs(str(musicxml_path), str(out_dir / "piano_synthetic"))

    reparsed = music21.converter.parse(str(musicxml_path))
    reparsed_part = reparsed.parts[0] if reparsed.parts else reparsed

    time_sigs = reparsed_part.flatten().getElementsByClass('TimeSignature')
    time_signature = time_sigs[0].ratioString if time_sigs else None

    measures = extract_ground_truth_measures(reparsed_part)
    return {
        "n_pages": len(pngs),
        "measures": measures,
        "time_signature": time_signature,
        "instrument": "Piano",
    }


def build_corpus_entry(piece_id: str, midi_path: str, metadata_row: dict, out_dir: "Path") -> dict | None:
    """
    Runs the full Stage-1 pipeline for one MusicNet piece:
      1. Parse the MIDI.
      2. Select the real part (select_real_part).
      3. Strip tempo-automation events (strip_tempo_marks).
      4. Build measures (.makeMeasures()).
      5. Set title/composer on the result's metadata, from
         `metadata_row` (musicnet_metadata.csv's own columns:
         composer/composition/movement) — cosmetic, but verovio
         defaults to a placeholder title ("1 Fragment") otherwise.
      6. Write MusicXML to `{out_dir}/{piece_id}.musicxml`.
      7. Render every page to `{out_dir}/{piece_id}_page{N}.png`.
      8. Re-parse the just-written MusicXML file and extract ground
         truth (including time signature) from THAT re-parsed stream,
         not from the pre-write `measured` object (final-review I1 fix:
         `measured.write('musicxml', ...)` runs music21's own export
         clean-up — splitting rests/durations, building voices — which
         can change a measure's content after the point ground truth
         used to be extracted from it; 72 of 2421 measures differed
         across the real corpus under the old approach). Re-parsing
         guarantees ground truth matches exactly what verovio actually
         rendered, since verovio reads the same file being re-parsed.

    Returns {"n_pages": int, "measures": [...], "time_signature": str}
    on success, or None on any failure — the caller (Task 4's CLI loop)
    is responsible for logging and skipping, matching the "one bad
    piece must not abort the whole corpus build" error-handling rule
    from the spec. `time_signature` is music21's own `ratioString`
    (e.g. "4/4", "12/8"), taken from the first TimeSignature found in
    the re-parsed stream — every piece in this corpus carries a
    consistent signature throughout (possibly with a pickup-measure
    variant at the very start), matching how `.makeMeasures()` itself
    already uses the embedded signature.
    """
    try:
        score = music21.converter.parse(midi_path)
        real_part = select_real_part(score)
        strip_tempo_marks(real_part)
        measured = real_part.makeMeasures()

        measured.metadata = music21.metadata.Metadata()
        measured.metadata.title = f"{metadata_row['composition']} - {metadata_row['movement']}"
        measured.metadata.composer = metadata_row['composer']

        mxl_path = str(out_dir / f"{piece_id}.musicxml")
        measured.write('musicxml', fp=mxl_path)

        out_prefix = str(out_dir / piece_id)
        pngs = render_musicxml_to_pngs(mxl_path, out_prefix)
        if not pngs:
            print(f"[build_visual_validation_corpus] piece {piece_id}: "
                  f"verovio produced zero pages, skipping")
            return None

        # Re-parse the written file so ground truth matches exactly what
        # was rendered (I1 fix) — see docstring above.
        reparsed_score = music21.converter.parse(mxl_path)
        reparsed_part = reparsed_score.parts[0]

        time_sigs = reparsed_part.flatten().getElementsByClass('TimeSignature')
        time_signature = time_sigs[0].ratioString if time_sigs else None

        measures = extract_ground_truth_measures(reparsed_part)
        return {"n_pages": len(pngs), "measures": measures, "time_signature": time_signature}
    except Exception as e:                                       # noqa: BLE001
        print(f"[build_visual_validation_corpus] piece {piece_id}: "
              f"FAILED ({type(e).__name__}: {e}), skipping")
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default="/Users/matthewwu/.cache/mediant_validation/data",
                         help="Directory containing midis/ and musicnet_metadata.csv")
    parser.add_argument("--out-dir", default="/Users/matthewwu/.cache/mediant_validation/visual_corpus",
                         help="Directory to write clean/ and ground_truth.json into")
    parser.add_argument("--limit", type=int, default=None,
                         help="Only process the first N pieces (for fast iteration)")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    out_dir = Path(args.out_dir) / "clean"
    out_dir.mkdir(parents=True, exist_ok=True)

    metadata_by_id = {}
    with open(data_dir / "musicnet_metadata.csv") as f:
        for row in csv.DictReader(f):
            metadata_by_id[row["id"]] = row

    midi_paths = sorted((data_dir / "midis").glob("*.mid"))
    if args.limit:
        midi_paths = midi_paths[:args.limit]

    ground_truth = {}
    n_ok, n_failed = 0, 0
    for midi_path in midi_paths:
        piece_id = midi_path.stem
        metadata_row = metadata_by_id.get(piece_id)
        if metadata_row is None:
            print(f"[build_visual_validation_corpus] piece {piece_id}: "
                  f"no metadata row, skipping")
            n_failed += 1
            continue
        entry = build_corpus_entry(piece_id, str(midi_path), metadata_row, out_dir)
        if entry is None:
            n_failed += 1
            continue
        ground_truth[piece_id] = entry
        n_ok += 1
        print(f"[build_visual_validation_corpus] piece {piece_id}: "
              f"OK ({entry['n_pages']} pages, {len(entry['measures'])} measures)")

    gt_path = Path(args.out_dir) / "ground_truth.json"
    gt_path.parent.mkdir(parents=True, exist_ok=True)
    with open(gt_path, "w") as f:
        json.dump(ground_truth, f, indent=2)

    print(f"\n{n_ok} pieces built, {n_failed} skipped. "
          f"Ground truth written to {gt_path}")
    return 0 if n_ok > 0 else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
