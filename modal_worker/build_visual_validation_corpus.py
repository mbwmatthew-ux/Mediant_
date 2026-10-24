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
import verovio
import resvg_py


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
    """
    tk = verovio.toolkit()
    ok = tk.loadFile(musicxml_path)
    if not ok:
        return []
    paths = []
    for page_num in range(1, tk.getPageCount() + 1):
        svg = tk.renderToSVG(page_num)
        png_bytes = bytes(resvg_py.svg_to_bytes(svg_string=svg))
        out_path = f"{out_prefix}_page{page_num}.png"
        with open(out_path, "wb") as f:
            f.write(png_bytes)
        paths.append(out_path)
    return paths


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
      8. Extract ground truth from the SAME measured Stream that was
         written and rendered (not a re-parse of the written file) —
         image and ground truth are self-consistent by construction.

    Returns {"n_pages": int, "measures": [...]} on success, or None on
    any failure — the caller (Task 4's CLI loop) is responsible for
    logging and skipping, matching the "one bad piece must not abort
    the whole corpus build" error-handling rule from the spec.
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

        measures = extract_ground_truth_measures(measured)
        return {"n_pages": len(pngs), "measures": measures}
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
