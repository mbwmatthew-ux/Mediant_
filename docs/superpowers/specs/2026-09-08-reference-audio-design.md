# AI Reference Audio + Range Selection — Design

**Date:** 2026-09-08
**Status:** approved, ready for implementation plan
**Part of:** two-part request from the same session; Part 1 (declared BPM) already
shipped to `main`. This spec covers Part 2.

---

## Goal

> Let the student hear exactly how a section of the piece is supposed to sound
> — correct notes, correct rhythm, correct timing — so they can compare it
> directly against their own take.

Explicitly **not** a goal for this pass: visual polish, or a realistic/human-sounding
instrument timbre. Both are acknowledged trade-offs the user accepted up front.

Scope, confirmed with the user during brainstorming:
- **Requirement "visual issue marker on the sheet music" is already built** —
  `Analysis.jsx`'s existing `measure_layout`-driven marker system (percentage-
  coordinate boxes per measure, one marker per flag) already does this. Nothing
  to build here.
- **Image/PDF-uploaded scores only**, not MusicXML. This is the only score type
  with real per-measure position data today (`x_pct`/`y_pct` from
  `get_measure_positions_gemini`), matches the user's own phrasing ("sheet
  music PNG"), and matches the dominant real upload path (phone photos). A
  visual-rendering path for MusicXML in `Analysis.jsx` does not exist at all
  today (confirmed: no OSMD usage anywhere in that file) and is out of scope
  here — a separate piece of work if ever wanted.
- **Reference tempo defaults to the take's `declared_bpm`** (shipped in Part 1)
  for a fair, apples-to-apples comparison against what the student actually
  attempted — with the student able to change it afterward.
- **Synthesis is MIDI + soundfont**, not a realistic/neural audio model —
  deterministic, exact notes/rhythm/timing by construction, at the cost of
  sounding synthesized. Confirmed acceptable.

---

## Grounding: what already exists

Corrects stale assumptions from earlier in this session (the Obsidian
knowledge base's "Score Rendering" note describes an OSMD-based highlight
system that no longer exists in `Analysis.jsx` — worth fixing separately, not
in this spec).

**Existing marker system** (`src/pages/Analysis.jsx:1962-2154`): `measure_layout`
(written by the worker, read as `take.measure_layout.measures`) carries
`{number, x_pct, y_pct}` per measure. `boxByMeasure[lm.number] = {x, y, left,
right, rowIndex}` (line 2004) is already computed — `left`/`right` are exactly
the horizontal edges a range-selection handle needs, so this spec's UI reuses
them rather than computing new geometry. `markerSpecs` builds one marker per
flag (line 2058), rendered as `<button className={aStyles.scoreMarker}>` and
`<div className={aStyles.scoreSpanBar}>` for multi-measure spans. Only
`currentScorePage === 0` gets overlays today.

**Existing note-list shape** (`modal_worker/worker.py`, `flatten_score_notes`,
line 1373): for image/PDF scores, `read_score_notes_claude` (Claude vision, not
music21) produces the `score` dict; `flatten_score_notes(score, start_measure,
end_measure, beats_per_measure)` flattens it to `[{"midi", "measure", "beat",
"dur_beats", "pitch", "artic", "abs_beat"}]` — `abs_beat` is the note's beat
position from the window's start, already computed, exactly what a MIDI
builder needs to place notes in time. This is the function this spec's audio
generator reuses — no new score-parsing logic.

**Existing tempo/time-signature helpers**: `beats_per_measure_from_time_sig`
and `quarter_lengths_per_beat` (worker.py:3290, :3300) already convert a time
signature string into beat-count and quarter-length-per-beat — reused to turn
`abs_beat` into absolute seconds at a target BPM.

**Existing instrument-lookup pattern**: `INSTRUMENT_TRANSPOSE` (worker.py:3397)
and `transpose_for_instrument` (worker.py:3448) — a normalized-string dict with
a longest-substring-match fallback (`"Bb Clarinet 1"` resolves via `"clarinet"`
being a substring). This spec's General-MIDI program lookup follows the
identical shape, for consistency and because the fuzzy-matching behavior is
already proven correct in production.

**Existing cache table**: `score_cache` (`score_path TEXT PRIMARY KEY,
parsed_notes JSONB`) already holds the parsed `score` dict for image/PDF
scores, RLS-locked to service-role only. This spec's audio generator reads
from here directly when available — no new score parsing on the hot path.

**Existing Modal image pattern**: `worker.py:29-59` builds the image via
`apt_install` + `run_commands` (e.g. Audiveris fetched via `curl` + `dpkg-deb`)
+ `pip_install`. This spec's soundfont/FluidSynth addition follows the same
`run_commands` shape.

**No existing capability** (confirmed absent): no `fluidsynth`/`pretty_midi`/
`mido` in the worker image; no MIDI-export usage of `music21` anywhere in
`worker.py`; no reference-audio storage bucket (`recordings` and `sheet-music`
are the only two live buckets — a third, `reference-midi`, exists only as a
commented-out, never-executed SQL line); no reference-audio playback UI in
`Analysis.jsx` (its two `<audio>`/`<video>` elements both play the student's
own upload).

---

## Part 1 — Backend: audio generation

New Modal function, **synchronous** (not the async+webhook pattern the main
analysis pipeline uses) — pure CPU DSP rendering, no ML model, fast enough
(sub-few-seconds even for a full piece) that a direct request/response is
simpler and gives near-instant UX instead of poll-until-done.

**New dependencies**, added to the existing image definition
(`worker.py:29-59`) in the same `apt_install`/`pip_install` shape already
used for the image's other native dependencies:
- `apt_install`: `fluidsynth` (the library/binary `pretty_midi` shells out to)
  and `fluid-soundfont-gm` — the official Debian package (the worker's base
  image is `debian_slim`) providing a General MIDI soundfont at the fixed
  path `/usr/share/sounds/sf2/FluidR3_GM.sf2`. Preferred over `curl`-fetching
  a soundfont from an arbitrary mirror (the Audiveris pattern) since this is
  an official distro package with clear (MIT-family) licensing and no
  external-URL fragility.
- `pip_install`: `pretty_midi`.

Renders the **whole piece**, not just the range the student happened to play
in their take — computationally no more expensive (same synthesis cost per
note regardless of range), and more useful: the student can preview any
section of the piece this way, including material they haven't recorded yet.
This also sidesteps a real gap found during spec self-review: `start_measure`/
`end_measure`/`time_sig` are request-scoped params to `analyze-performance`
and are **not** persisted anywhere on `takes` (confirmed via the same
migration check Part 1 already did for `time_sig`) — a later, independent
call to this feature has no access to them. Whole-piece generation needs
only what genuinely *is* persisted (`score_path`, `instrument`,
`declared_bpm`) plus `time_signature`, which is already a field on the parsed
`score` dict itself (`score_cache.parsed_notes.time_signature`) — no new
columns required.

**New function**: `generate_reference_audio(score: dict, beats_per_measure: int,
time_sig: str, instrument: str, bpm: float) -> tuple[bytes, list[dict]]`

1. `notes = flatten_score_notes(score, None, None, beats_per_measure)` —
   reuses the existing function verbatim; `None`/`None` means "the whole
   score," a mode `flatten_score_notes` already supports (its `start_measure`/
   `end_measure` params are optional).
2. Convert each note's `abs_beat` to absolute seconds:
   `sec = abs_beat * quarter_lengths_per_beat(time_sig) * (60.0 / bpm)`.
3. Build a `pretty_midi.PrettyMIDI()` object with one
   `pretty_midi.Instrument(program=<GM program number>)`, adding one
   `pretty_midi.Note(velocity=90, pitch=midi, start=sec, end=sec+dur_sec)`
   per flattened note (`dur_sec` from `dur_beats` via the same conversion).
   GM program number comes from a new `INSTRUMENT_GM_PROGRAM` dict, same
   normalized-string + longest-substring-match shape as
   `INSTRUMENT_TRANSPOSE`/`transpose_for_instrument`, covering the instruments
   already in `src/lib/instruments.js`'s canonical list. Default to Acoustic
   Grand Piano (GM program 0) when an instrument doesn't match — silence would
   be a worse failure than a slightly-wrong-timbre reference.
4. Render: `audio = midi.fluidsynth(fs=22050, sf2_path="/usr/share/sounds/sf2/FluidR3_GM.sf2")`
   — `pretty_midi`'s native FluidSynth wrapper, returns a numpy float
   array; encode to bytes via `soundfile.write` (already a worker dependency)
   into an in-memory buffer as MP3 or WAV (WAV is simplest — no new codec
   dependency — accept the larger file size for now; the file is short, a few
   MB at most for a full piece).
5. Build the timeline: for every measure in the score, `start_sec`/`end_sec`
   derived the same way from that measure's first/last beat —
   `[{"measure": m, "start_sec": ..., "end_sec": ...}, ...]`.
6. Return `(audio_bytes, timeline)`.

Exposed via a new `@modal.fastapi_endpoint` (mirrors `analyze_async`'s shape
but synchronous — no `.spawn()`, returns the result directly in the response
body rather than posting to a webhook).

---

## Part 2 — Storage, caching, and the edge function

**New Supabase Storage bucket**: `reference-audio`, same signed-URL pattern
(`recordings`/`sheet-music` buckets) — 24hr TTL, generated on Analysis page
load, matching the existing convention (see Gotchas: don't reduce this below
what a session needs).

**New migration**: adds `reference_audio_path TEXT`, `reference_audio_bpm
NUMERIC`, `reference_audio_timeline JSONB` to `takes` — nullable, populated
lazily on first request. `reference_audio_bpm` records what tempo the cached
file was actually rendered at, so a cache hit can be validated (if a future
change lets `declared_bpm` be edited after submission, a stale cache is
detectable — not required for v1 since `declared_bpm` is immutable once set,
but cheap to store now and avoids a silent staleness bug later).

**New edge function**: `generate-reference-audio`
1. Auth + ownership check (same pattern every other edge function here uses —
   confirm the caller owns `takeId`).
2. If `takes.reference_audio_path` is already set for this take, sign and
   return it immediately with the stored timeline — no Modal call.
3. Otherwise: read the take's `score_path`, `instrument`, and `declared_bpm`
   (all already persisted — `declared_bpm` from Part 1, the other two
   pre-existing); read the cached `score_cache.parsed_notes` for `score_path`
   (same cache `analyze-performance` already reads) — this is also where
   `time_signature` comes from, since it's a field on the parsed `score` dict
   itself, not a separate `takes` column; call the new Modal endpoint
   synchronously with the whole parsed score (no measure range needed — see
   Part 1).
4. Upload the returned audio bytes to `reference-audio/{user_id}/{take_id}.wav`;
   write `reference_audio_path`, `reference_audio_bpm` (`declared_bpm` at
   generation time), `reference_audio_timeline` to the `takes` row.
5. Sign the uploaded file (24hr TTL) and return `{ audioUrl, timeline }`.

**Edge case — no cached score notes.** If `score_cache` has no entry for this
take's `score_path` (e.g. cache was never populated, or the take predates this
feature), the edge function returns a clear error
(`"Sheet music hasn't been analyzed yet — try again after the next
analysis run"` or similar) rather than attempting a fresh vision read
inline — re-running Claude vision synchronously inside this request risks the
same Cloudflare/Chrome connection-drop issues documented in Gotchas for any
inline work over ~12s. Re-parsing on demand is out of scope for this pass.

---

## Part 3 — Frontend: playback + tempo

A "Play reference" control in `Analysis.jsx` (placement is not load-bearing
per the user's explicit "don't worry about UI" instruction — anywhere
reachable is fine for this pass) that, on first click, calls
`generate-reference-audio` and renders a plain `<audio>` element with the
returned signed URL. Subsequent clicks within the same session reuse the
already-fetched URL/timeline (component state), and subsequent take visits
hit the now-populated cache (edge function skips Modal).

Tempo control: a simple numeric input or slider (styling deferred), wired to
`audioEl.playbackRate = selectedBpm / referenceAudioBpm` with
`audioEl.preservesPitch = true` (standard property in current browsers,
avoids the classic "faster = higher pitched" artifact). Default value equals
`referenceAudioBpm` (i.e. `playbackRate = 1.0`), satisfying "auto-set to
declared BPM, but changeable" — no server round-trip for tempo changes.

---

## Part 4 — Frontend: range selection

Two draggable handles rendered over the sheet-music image, positioned using
the *existing* `boxByMeasure[m].left`/`.right` values the marker system
(`Analysis.jsx:2004`) already computes — no new position/geometry logic.
Dragging snaps to the nearest measure boundary (no per-note position data
exists anywhere in this codebase today, so sub-measure snapping is not
available without a much larger OMR effort — out of scope, and matches the
user's own "pull the sides of a **bar**" framing literally).

On handle release, the selected `[startMeasure, endMeasure]` is looked up
against `reference_audio_timeline` (already fetched with the audio — no
additional backend call) to get `[start_sec, end_sec]`. Playback is clipped to
that window: `audioEl.currentTime = start_sec` on play, and a `timeupdate`
listener pauses playback once `currentTime >= end_sec`.

Since generation covers the whole piece (Part 1), range selection is not
constrained to the measures the student's take happened to cover — any
measure in the score can be selected, including material outside what was
analyzed for this particular take.

---

## Testing

- **Worker**: unit tests for the new MIDI-building function against a
  synthetic score fixture (same fixture-building pattern already used
  throughout `test_analysis.py` — `make_score()`/`make_performance()`),
  asserting: note count matches the flattened note list, note start times are
  monotonically non-decreasing within a measure, a tempo change scales all
  timestamps proportionally (2x BPM → all `start`/`end` times halved), the
  GM-program lookup resolves known instruments and falls back to piano for
  unknown ones. Rendering to actual audio bytes (the FluidSynth call itself)
  is not unit-tested — matches this codebase's existing convention of mocking
  heavy/binary dependencies (`librosa`, `torch`, etc. are all mocked in the
  test harness) rather than exercising them; a manual smoke test against a
  real Modal deployment covers the actual audio-quality question this spec
  cannot verify offline.
- **Edge function**: no existing test framework for edge functions in this
  repo (confirmed during Part 1) — verified via `deno check` type-checking,
  same as Part 1.
- **Frontend**: no test framework exists here either — verified via
  build/lint plus manual browser walkthrough (generate audio for a take, drag
  the range handles, confirm playback clips correctly, confirm tempo slider
  changes speed without robotic pitch-shifting).

## Out of scope

- MusicXML score support (no visual rendering pipeline exists for it in
  `Analysis.jsx` at all — separate future work).
- Sub-measure (note/beat-level) range selection — no per-note position data
  exists to support it.
- Realistic/neural instrument synthesis — explicitly deferred, MIDI+soundfont
  accepted for this pass.
- Server-side tempo regeneration — tempo changes are client-side
  `playbackRate` only; if a genuinely different-sounding render at a very
  different tempo becomes a real product need later (extreme tempo changes
  can make `playbackRate` scaling sound unnatural well beyond ~1.5x), that is
  new scope, not this pass's.
- Any change to the existing flag-marker system — it already satisfies the
  "visual issue marker" requirement as-is.
- Editing `declared_bpm` after a take is submitted (it's immutable per Part
  1's design) — `reference_audio_bpm` is stored defensively for future
  staleness detection but nothing invalidates the cache in this pass.
