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

- `src/pages/Record.jsx`

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
- Audiveris OMR conversion for visual scores (PDF/images) before parsing

Files:

- `modal_worker/worker.py`
- `modal_worker/deploy.sh`

Score-reading order:

- MusicXML / MXL upload -> parse directly with `music21`
- PDF / image upload -> convert to MXL with Audiveris, then parse with `music21`
- If structured parsing fails -> fall back to Claude visual reading

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
