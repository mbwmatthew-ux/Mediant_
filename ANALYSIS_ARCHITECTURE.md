# Mediant Analysis Architecture

This document describes the current high-trust analysis direction for Mediant.

## Goal

Turn performance review from a prototype into a defensible pipeline that:

- measures first
- aligns second
- coaches last

The app should only give precise musical feedback when it has enough evidence to justify that precision.

## Current architecture

### 1. Input collection

The frontend collects:

- sheet music upload
- piece metadata
- video recording
- optional start/end measure hints

Main entrypoint:

- `src/components/NewRecordingModal.jsx`

Note: `src/pages/Record.jsx` used to be this entrypoint and is now unrouted and
unimported (`/record` redirects to `/home`). Do not read it as a description of
the current flow.

### 2. Secure storage

The frontend uploads:

- recording -> Supabase Storage bucket `recordings`
- score -> Supabase Storage bucket `sheet-music`

### 3. Analysis orchestration

The frontend invokes:

- `supabase.functions.invoke('analyze-performance')`

Main backend entrypoint:

- `supabase/functions/analyze-performance/index.ts`

### 4. Measurement layer

Preferred path:

- Modal worker
- CREPE pitch tracking
- librosa beat/onset tracking
- music21 MusicXML parsing when available

Files:

- `modal_worker/worker.py`
- `modal_worker/deploy.sh`

Score-reading order, as actually implemented in `_score_pipeline`:

- MusicXML / MXL upload -> parse directly with `music21`
- PDF / image upload -> read with Claude vision (`read_score_notes_claude`),
  then ask Gemini for each measure's on-page coordinates
- Parsed results are cached in `score_cache`, keyed by `score_path`

Audiveris now runs as a **per-row OMR cross-validation source**, not as the
whole-page conversion path this section previously described. `read_score_notes_claude`
dispatches `run_audiveris_on_row` (via `_run_audiveris_on_row`) in parallel, once per
raster row produced by `_prepare_score_rows`, alongside Claude's own vision reads. Its
per-row results are aligned back to Claude's global measure numbers
(`_group_measure_numbers_by_row` / `_align_audiveris_measures`) and feed two places: the
Claude-vs-Claude tie-break when the two/three-way reconciliation reads disagree, and
`fuse_measure_confidence`'s per-measure confidence fusion. Audiveris never runs on PDF
pages (image-only scope — PDF pages have zero rows from `_prepare_score_rows`), and any
dispatch/collection failure degrades a row to `oemer_measure=None`, identical to the old
permanently-unavailable behavior. See
`docs/superpowers/specs/2026-09-23-audiveris-cross-validation-design.md` for the full
design and the oemer NO-GO history that preceded it.

`convert_visual_score_to_musicxml` itself — the whole-page-to-MusicXML conversion
function — is a **separate, still-unused** function. It still has zero call sites;
visual scores are read via the row-level pipeline above, not by converting a whole page
to MusicXML.

Fallback path:

- Gemini transcription

This fallback exists for resilience, but it is lower trust and should not be treated as equivalent to the dedicated worker.

### 5. Corroboration layer

Gemini direct-listens to the uploaded recording and produces:

- intonation observations
- rhythm observations
- technique observations
- overall summary

This is used as corroborating evidence, not the sole source of truth.

### 6. Coaching layer

Claude Sonnet takes:

- structured score information
- aligned audio events
- alignment ranges
- Gemini direct-listening notes

It then generates:

- issue flags
- explanations
- practice advice

Claude should explain the evidence, not invent it.

## Trust model

The backend now computes an analysis-quality object:

- `trust`: `high | medium | low`
- `canProceed`: boolean
- `reasons`: array of evidence-quality problems

If confidence is too low, the backend returns a structured error instead of fake precision.

Stored on each take:

- `analysis_quality`
- `analysis_backend`

## What “high trust” means

High trust generally requires:

- the Modal worker was available
- the score produced enough readable measures
- enough audio events were extracted
- enough note events were aligned to the score
- direct listening corroboration was available

## Product guidance

For the best current results:

- prefer short solo excerpts
- prefer cleaner recordings
- prefer MusicXML / MXL over score photos
- if using a PDF or photo, use a clean, straight, high-contrast score image
- avoid over-promising precision when the system is in fallback mode

## Near-term roadmap

### Priority 1

Make the Modal worker the default measurement engine and reduce reliance on Gemini transcription fallback.

### Priority 2

Narrow “accurate mode” to the strongest cases:

- MusicXML / MXL
- clean PDF/image scores that Audiveris can convert into MXL
- short excerpts with correct start/end measure hints
- solo instrument performance

### Priority 3

Expose trust clearly in the UI and teach users how to improve low-confidence uploads.

### Priority 4

Add better deterministic alignment and confidence scoring per measure so each flag carries stronger provenance.
