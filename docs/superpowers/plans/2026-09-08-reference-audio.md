# AI Reference Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a student generate and play an AI-synthesized reference recording of
a piece (correct notes/rhythm/timing), at an adjustable tempo defaulting to their
declared practice tempo, and select a measure range on the sheet-music image to
isolate and hear.

**Architecture:** A new synchronous Modal endpoint builds a MIDI file from the
same note-list data the analysis pipeline already parses (`flatten_score_notes`),
renders it to audio via `pretty_midi`'s built-in FluidSynth wrapper against a
bundled General MIDI soundfont, and returns audio bytes + a per-measure time
mapping. A new Supabase edge function orchestrates caching (generate once per
take, reuse forever after) and storage. The frontend adds a small custom hook for
playback/tempo control and reuses the sheet-music overlay's existing per-measure
position data for drag-to-select range handles — no new position/geometry logic.

**Tech Stack:** Python/Modal (`pretty_midi`, FluidSynth via the `fluid-soundfont-gm`
apt package), Deno edge function, Supabase Storage + Postgres, React (a new custom
hook + two small components).

**Spec:** `docs/superpowers/specs/2026-09-08-reference-audio-design.md`

## Global Constraints

- Scope is **image/PDF-uploaded scores only** — MusicXML has no visual rendering
  path in `Analysis.jsx` today and is explicitly out of scope.
- Reference audio covers the **whole piece**, not just the take's played range —
  `start_measure`/`end_measure`/`time_sig` are request-scoped params to
  `analyze-performance` and are **not** persisted on `takes` (verified during
  spec self-review — same gap already found for `time_sig` in the prior BPM
  feature), so whole-piece generation is what's actually buildable from
  persisted data (`score_path`, `instrument`, `declared_bpm`).
- Default reference tempo is the take's `declared_bpm`; further tempo changes
  are **client-side only** via `audio.playbackRate` + `audio.preservesPitch` —
  never a server round-trip.
- Range-selection snaps to **measure boundaries only** — no per-note position
  data exists anywhere in this codebase to support finer snapping.
- Synthesis is **MIDI + soundfont** (`pretty_midi` + FluidSynth), not a
  realistic/neural audio model — explicitly accepted trade-off.
- The new Modal endpoint is **synchronous** (no `.spawn()`/webhook) — pure CPU
  DSP rendering, fast enough for direct request/response.
- Generation is **lazy and cached**: only happens on first request per take,
  never as part of the main analysis pipeline.

---

### Task 1: Migration — storage bucket + `takes` columns

**Files:**
- Create: `supabase/migrations/20260908020000_create_reference_audio.sql`

**Interfaces:**
- Produces: a `reference-audio` storage bucket (private, same shape as the
  existing `recordings` bucket) and three new nullable columns on `takes`
  (`reference_audio_path TEXT`, `reference_audio_bpm NUMERIC`,
  `reference_audio_timeline JSONB`), consumed by Task 5 (edge function) and
  Task 6 (frontend hook).

- [ ] **Step 1: Write the migration**

Modeled directly on the existing bucket-creation pattern in
`supabase/migrations/20260517_create_takes.sql:24-42` (the `recordings`
bucket) — same `INSERT INTO storage.buckets` + per-operation RLS policy
shape, scoped by `(storage.foldername(name))[1] = auth.uid()::text` (the
bucket path convention every other bucket in this repo already uses:
`{user_id}/...`).

```sql
-- Reference-audio: AI-synthesized "how this piece should sound" recordings,
-- generated lazily (first request per take) and cached forever after via
-- takes.reference_audio_path. One file per take, stored at
-- reference-audio/{user_id}/{take_id}.wav — server-generated, so INSERT uses
-- upsert from the edge function's service-role client (bypasses these RLS
-- policies entirely; the policies below only govern direct client access).
INSERT INTO storage.buckets (id, name, public)
VALUES ('reference-audio', 'reference-audio', false)
ON CONFLICT DO NOTHING;

CREATE POLICY "Users can read own reference audio"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'reference-audio' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can delete own reference audio"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'reference-audio' AND (storage.foldername(name))[1] = auth.uid()::text);

-- No client-side INSERT policy: only the edge function's service-role client
-- (which bypasses RLS) ever writes to this bucket. A client-side INSERT
-- policy would let a user upload arbitrary "reference audio" as themselves,
-- which is meaningless here — generation is always server-driven.

-- Per-take cache of the generated reference audio. Nullable: absent until
-- first requested. reference_audio_bpm records what tempo the cached file
-- was actually rendered at (always declared_bpm at generation time today,
-- since declared_bpm is immutable once set — stored defensively in case a
-- future change makes declared_bpm editable, so a stale cache becomes
-- detectable rather than silently wrong).
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_path TEXT;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_bpm NUMERIC;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_timeline JSONB;
```

- [ ] **Step 2: Verify the migration file matches the project's existing style**

Compare against `supabase/migrations/20260517_create_takes.sql` (bucket +
policy shape) and `supabase/migrations/20260629_add_note_to_takes.sql`
(`ADD COLUMN IF NOT EXISTS` shape). No automated test applies to a bare SQL
file — verification is this direct comparison.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260908020000_create_reference_audio.sql
git commit -m "feat(db): add reference-audio bucket and takes columns"
```

---

### Task 2: Worker — General MIDI instrument program lookup

**Files:**
- Modify: `modal_worker/worker.py` (new dict + function, placed directly after
  `transpose_for_instrument` ends, i.e. after line 3459 and before
  `find_wrong_note_candidates` at line 3460)
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Produces: `gm_program_for_instrument(instrument: str) -> int`, a General
  MIDI program number 0-127, always returning a value (never `None` — unlike
  `transpose_for_instrument`, an unmatched instrument here should not block
  audio generation, so it falls back to Acoustic Grand Piano rather than
  refusing). Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Add this test function to `modal_worker/test_analysis.py`, directly after
`test_tempo_vs_declared_reports_fact_not_fault` and before
`test_declared_bpm_flows_into_compare_and_coach_claude` (both already exist
in the file from the prior feature — insert between them, in either order,
since neither references this new function):

```python
def test_gm_program_lookup():
    print("\n[61] instrument name -> General MIDI program number")
    check("clarinet resolves", w.gm_program_for_instrument("Clarinet (B♭)") == 71,
          str(w.gm_program_for_instrument("Clarinet (B♭)")))
    check("bare clarinet resolves via substring match",
          w.gm_program_for_instrument("Bb Clarinet 1") == 71,
          str(w.gm_program_for_instrument("Bb Clarinet 1")))
    check("violin resolves", w.gm_program_for_instrument("Violin") == 40)
    check("piano resolves", w.gm_program_for_instrument("Piano") == 0)
    check("trumpet resolves", w.gm_program_for_instrument("Trumpet (B♭)") == 56)
    check("unmatched instrument falls back to piano, not None",
          w.gm_program_for_instrument("Theremin") == 0,
          str(w.gm_program_for_instrument("Theremin")))
    check("empty string falls back to piano",
          w.gm_program_for_instrument("") == 0)
    check("None falls back to piano",
          w.gm_program_for_instrument(None) == 0)
    check("result is always an int in range",
          isinstance(w.gm_program_for_instrument("Glockenspiel"), int)
          and 0 <= w.gm_program_for_instrument("Glockenspiel") <= 127)
```

Register it in `main()`'s test tuple (`modal_worker/test_analysis.py`, the
long tuple passed to the `for t in (...)` loop), directly after
`test_declared_bpm_flows_into_compare_and_coach_claude,` (added by the prior
feature — search for that exact line):

```python
              test_declared_bpm_flows_into_compare_and_coach_claude,
              test_gm_program_lookup,
              test_crescendo_that_never_arrives_is_flagged):
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -A3 "gm_program"`
Expected: `AttributeError: module 'worker' has no attribute 'gm_program_for_instrument'`

- [ ] **Step 3: Implement the lookup**

Add directly after `transpose_for_instrument` (worker.py, ends at line 3459),
before `find_wrong_note_candidates` (line 3460):

```python
# General MIDI program numbers (0-indexed, per the GM spec) for every
# instrument in src/lib/instruments.js's INSTRUMENT_OPTIONS list. Same
# normalized-string-with-longest-substring-match shape as
# INSTRUMENT_TRANSPOSE/transpose_for_instrument, reusing the same key set
# where an instrument appears in both tables, so a string that already
# resolves correctly for transposition resolves the same way here.
#
# Percussion (snare drum, drum set) is deliberately ABSENT: GM drum kits are
# selected by MIDI channel 10, not a program number, and the flattened note
# list's "pitch" field has no meaningful sense for unpitched percussion in
# the first place — these fall through to the piano default below, same as
# any unrecognised instrument. A few entries (bass clarinet, euphonium,
# mandolin, cornet, flugelhorn, contrabassoon) have no distinct GM program
# and reuse the closest available family member — a known, deliberate
# approximation, not a bug.
INSTRUMENT_GM_PROGRAM = {
    "piccolo": 72, "flute": 73, "oboe": 68,
    "english horn": 69, "cor anglais": 69,
    "bassoon": 70, "contrabassoon": 70,
    "clarinet (b♭)": 71, "clarinet (bb)": 71, "bb clarinet": 71, "clarinet": 71,
    "clarinet (a)": 71, "a clarinet": 71,
    "clarinet (e♭)": 71, "clarinet (eb)": 71, "eb clarinet": 71,
    "bass clarinet": 71,
    "soprano saxophone": 64, "alto saxophone": 65, "tenor saxophone": 66,
    "baritone saxophone": 67, "alto sax": 65, "tenor sax": 66,
    "recorder": 74,
    "trumpet (b♭)": 56, "trumpet (bb)": 56, "trumpet": 56, "trumpet (c)": 56,
    "cornet (b♭)": 56, "cornet": 56, "flugelhorn": 56,
    "french horn (f)": 60, "french horn": 60, "horn": 60,
    "trombone": 57, "bass trombone": 57, "euphonium": 58, "tuba": 58,
    "violin": 40, "viola": 41, "cello": 42, "double bass": 43, "harp": 46,
    "classical guitar": 24, "electric guitar": 27, "guitar": 24,
    "bass guitar": 33, "ukulele": 24, "mandolin": 105, "banjo": 105,
    "piano": 0, "organ": 19, "harpsichord": 6, "voice": 52,
    "marimba": 12, "vibraphone": 11, "xylophone": 13, "glockenspiel": 9,
    "timpani": 47,
}

_GM_PROGRAM_DEFAULT = 0   # Acoustic Grand Piano — silence would be worse


def gm_program_for_instrument(instrument: str) -> int:
    """
    General MIDI program number for the declared instrument, or Acoustic Grand
    Piano (0) when unrecognised. Unlike transpose_for_instrument, this never
    returns None — an unmatched instrument should not block audio generation.
    """
    key = (instrument or "").strip().lower()
    if not key:
        return _GM_PROGRAM_DEFAULT
    if key in INSTRUMENT_GM_PROGRAM:
        return INSTRUMENT_GM_PROGRAM[key]
    hits = [(len(k), v) for k, v in INSTRUMENT_GM_PROGRAM.items() if k in key]
    return max(hits)[1] if hits else _GM_PROGRAM_DEFAULT
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -10`
Expected: final line `NNN/NNN checks passed`, no `FAILED:` line naming
`test_gm_program_lookup`.

- [ ] **Step 5: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add General MIDI instrument program lookup"
```

---

### Task 3: Worker — MIDI timing + reference-audio generation

**Files:**
- Modify: `modal_worker/worker.py` (three new functions, placed directly
  after `note_value_name` ends, i.e. after line 3344 and before
  `anchor_and_align_py` at line 3344's next definition — search for
  `def anchor_and_align_py` and insert immediately above it)
- Modify: `modal_worker/worker.py` image definition (`apt_install`/
  `pip_install` blocks, lines 33-69)
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `flatten_score_notes` (worker.py:1373, unmodified, called with
  `start_measure=None, end_measure=None` for whole-piece mode — already
  supported, its signature defaults both to `None`), `beats_per_measure_from_time_sig`
  and `quarter_lengths_per_beat` (worker.py:3290/:3300, unmodified),
  `gm_program_for_instrument` (Task 2).
- Produces: `generate_reference_audio(score: dict, instrument: str, bpm: float)
  -> tuple[bytes, list[dict]]` — `(wav_bytes, timeline)` where `timeline` is
  `[{"measure": int, "start_sec": float, "end_sec": float}, ...]` for every
  measure in the score. Consumed by Task 4 (the new Modal endpoint).

**A unit-conversion trap, verified against the live code before writing this
task — do not use a simpler-looking formula than the one below.** The
flattened note list's `dur_beats` field is **not** in notated-beat units
despite its name — worker.py:1468 states explicitly: `` `duration_beats` — a
music21 quarterLength, despite the name. `` Meanwhile `abs_beat` (also on each
flattened note) genuinely *is* in notated-beat units (computed from `beat`,
which music21 reports in the time signature's own beat unit). Converting a
quarterLength duration to seconds at a given BPM therefore needs
`quarter_lengths_per_beat(time_sig)` as a divisor — using the same scaling for
`dur_beats` as for `abs_beat` would silently reproduce this codebase's own
documented bug class (`quarter_lengths_per_beat`'s docstring: getting this
exact conversion wrong "made every note in 6/8 look ~33% too short").

- [ ] **Step 1: Write the failing tests**

Add these three test functions to `modal_worker/test_analysis.py`, directly
after `test_gm_program_lookup` (Task 2) and before
`test_declared_bpm_flows_into_compare_and_coach_claude`:

```python
def test_measure_audio_timeline_covers_every_measure():
    print("\n[62] measure audio timeline covers every measure, including rest-only ones")
    score = make_score()   # MEASURE_NUMBERS = 12..37 + 40..50, BEATS_PER_MEASURE = 3
    timeline = w.build_measure_audio_timeline(score, "3/4", 120.0, 3)
    check("one entry per measure in the score",
          len(timeline) == len(score["measures"]), str(len(timeline)))
    check("first measure starts at t=0",
          timeline[0]["measure"] == 12 and abs(timeline[0]["start_sec"]) < 1e-6,
          str(timeline[0]))
    # 3 beats/measure at 120 BPM (0.5s/beat) = 1.5s per measure.
    check("measure duration matches beats-per-measure at the given tempo",
          abs(timeline[0]["end_sec"] - timeline[0]["start_sec"] - 1.5) < 1e-6,
          str(timeline[0]))
    check("measure 13 starts where measure 12 ends (no gap, no overlap)",
          abs(timeline[1]["start_sec"] - timeline[0]["end_sec"]) < 1e-6,
          str((timeline[0], timeline[1])))
    check("timeline is in ascending measure order",
          [t["measure"] for t in timeline] == sorted(t["measure"] for t in timeline))
    check("empty score yields empty timeline",
          w.build_measure_audio_timeline({"measures": []}, "3/4", 120.0, 3) == [])


def test_notes_to_timed_events_uses_quarter_length_conversion():
    print("\n[63] note durations convert from quarterLength, not raw beats")
    # One note: abs_beat=0 (start of window), dur_beats=1.0 (a quarterLength,
    # per flatten_score_notes' real field meaning), pitch C4=60.
    notes = [{"midi": 60, "measure": 1, "beat": 1.0, "dur_beats": 1.0,
              "pitch": "C4", "artic": "", "abs_beat": 0.0}]
    # 4/4: quarter_lengths_per_beat=1.0, so a 1.0-quarterLength note IS exactly
    # one notated beat — the simple case where the trap doesn't bite.
    events_44 = w.notes_to_timed_events(notes, "4/4", 120.0)
    check("4/4 at 120bpm: quarter note lasts exactly 0.5s",
          abs(events_44[0]["end_sec"] - events_44[0]["start_sec"] - 0.5) < 1e-6,
          str(events_44))
    # 6/8: quarter_lengths_per_beat=1.5 (a dotted-quarter beat). The SAME
    # 1.0-quarterLength note is 1.0/1.5 = 0.667 of a notated beat, NOT a full
    # beat — this is exactly the conversion the trap above describes.
    events_68 = w.notes_to_timed_events(notes, "6/8", 120.0)
    expected_sec = (1.0 / 1.5) * (60.0 / 120.0)
    check("6/8 at 120bpm: a 1.0-quarterLength note is 2/3 of a notated beat, not a full beat",
          abs(events_68[0]["end_sec"] - events_68[0]["start_sec"] - expected_sec) < 1e-6,
          f"got {events_68[0]}, expected duration {expected_sec}")
    check("doubling the tempo halves every timestamp",
          abs(w.notes_to_timed_events(notes, "4/4", 240.0)[0]["end_sec"] - 0.25) < 1e-6)
    check("a note with abs_beat > 0 starts later, not at t=0",
          w.notes_to_timed_events(
              [{**notes[0], "abs_beat": 4.0}], "4/4", 120.0
          )[0]["start_sec"] > 1.9)
    check("a zero-duration note produces no negative-length event",
          w.notes_to_timed_events(
              [{**notes[0], "dur_beats": 0.0}], "4/4", 120.0
          )[0]["end_sec"] >= w.notes_to_timed_events(
              [{**notes[0], "dur_beats": 0.0}], "4/4", 120.0
          )[0]["start_sec"])


def test_generate_reference_audio_smoke():
    print("\n[64] generate_reference_audio runs end-to-end (pretty_midi/soundfile mocked)")
    score = make_score()
    audio_bytes, timeline = w.generate_reference_audio(score, "Clarinet (B♭)", 96.0)
    check("returns a bytes-like object", isinstance(audio_bytes, (bytes, bytearray)),
          str(type(audio_bytes)))
    check("returns one timeline entry per measure",
          len(timeline) == len(score["measures"]), str(len(timeline)))
    check("timeline entries have the expected keys",
          set(timeline[0].keys()) == {"measure", "start_sec", "end_sec"},
          str(timeline[0].keys()))
```

Register all three in `main()`'s test tuple, directly after
`test_gm_program_lookup,`:

```python
              test_gm_program_lookup,
              test_measure_audio_timeline_covers_every_measure,
              test_notes_to_timed_events_uses_quarter_length_conversion,
              test_generate_reference_audio_smoke,
              test_crescendo_that_never_arrives_is_flagged):
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "build_measure_audio_timeline\|notes_to_timed_events\|generate_reference_audio"`
Expected: `AttributeError` for each — none of these three functions exist yet.

- [ ] **Step 3: Add the soundfont/MIDI dependencies to the Modal image**

In `modal_worker/worker.py`, change the `apt_install` block (lines 33-39)
from:

```python
    .apt_install(
        "curl",
        "ca-certificates",
        "ffmpeg",
        "libsndfile1",
        "libxtst6",
    )
```

to:

```python
    .apt_install(
        "curl",
        "ca-certificates",
        "ffmpeg",
        "libsndfile1",
        "libxtst6",
        "fluidsynth",
        "fluid-soundfont-gm",
    )
```

`fluid-soundfont-gm` is an official Debian package (the image's base is
`debian_slim`) providing a General MIDI soundfont at the fixed path
`/usr/share/sounds/sf2/FluidR3_GM.sf2` — preferred over `curl`-fetching a
soundfont from an arbitrary mirror (the existing Audiveris pattern in
`run_commands`) since this is an official distro package with clear
(MIT-family) licensing and no external-URL fragility.

Then change the `pip_install` block (lines 53-69) from:

```python
    .pip_install(
        # Audio processing
        "librosa==0.10.2",
        "soundfile==0.12.1",
        "numpy>=1.24,<2.0",
        "scipy>=1.10",
        # Score parsing
        "music21==9.1.0",
        # PDF → PNG rendering for Gemini (so PDF scores work the same as image scores)
        "pymupdf==1.24.11",
        # Utilities
        "fastapi[standard]",
        "requests==2.31.0",
        "httpx==0.27.0",
        # AI SDKs (used in async full-pipeline)
        "anthropic>=0.30.0",
    )
```

to:

```python
    .pip_install(
        # Audio processing
        "librosa==0.10.2",
        "soundfile==0.12.1",
        "numpy>=1.24,<2.0",
        "scipy>=1.10",
        # Score parsing
        "music21==9.1.0",
        # PDF → PNG rendering for Gemini (so PDF scores work the same as image scores)
        "pymupdf==1.24.11",
        # Reference-audio synthesis: builds MIDI from the parsed note list and
        # renders it via the fluidsynth binary installed above.
        "pretty_midi==0.2.10",
        # Utilities
        "fastapi[standard]",
        "requests==2.31.0",
        "httpx==0.27.0",
        # AI SDKs (used in async full-pipeline)
        "anthropic>=0.30.0",
    )
```

No change needed to `modal_worker/test_analysis.py`'s mocked-modules list —
`pretty_midi` is **already** present there (line 35:
`for _n in ["modal", "torch", "torchcrepe", "librosa", "soundfile", "music21", "requests", "scipy", "scipy.signal", "pretty_midi", "mido", "httpx"]:`),
pre-emptively added ahead of this feature. Verify this yourself with
`grep -n "pretty_midi" modal_worker/test_analysis.py` before proceeding —
if it is somehow missing, add it to that list before continuing, since
without it `import pretty_midi` inside `generate_reference_audio` would try
to import a package not installed in the local dev/test environment and
crash the whole test file at collection time.

- [ ] **Step 4: Implement the three functions**

Add directly after `note_value_name` ends (worker.py:3344, right before
`def anchor_and_align_py`):

```python
def build_measure_audio_timeline(
    score: dict, time_sig: str, bpm: float, beats_per_measure: int,
) -> list[dict]:
    """
    [{"measure", "start_sec", "end_sec"}] for every measure in the score, in
    printed order, regardless of whether the measure contains any pitched
    notes (a rest-only or multirest measure still gets a time span — silence
    in the rendered audio is not a gap in this timeline).

    Assumes one constant time signature for the whole piece — the same
    assumption `score["time_signature"]` (a single top-level field, not
    per-measure) already makes everywhere else in this file. Not a new
    limitation introduced here.
    """
    sec_per_beat = 60.0 / bpm if bpm and bpm > 0 else 0.5
    numbers = sorted(
        m["number"] for m in score.get("measures", [])
        if isinstance(m.get("number"), int)
    )
    if not numbers:
        return []
    first = numbers[0]
    timeline = []
    for num in numbers:
        start_sec = (num - first) * beats_per_measure * sec_per_beat
        end_sec = start_sec + beats_per_measure * sec_per_beat
        timeline.append({
            "measure": num,
            "start_sec": round(start_sec, 3),
            "end_sec": round(end_sec, 3),
        })
    return timeline


def notes_to_timed_events(notes: list[dict], time_sig: str, bpm: float) -> list[dict]:
    """
    Convert flatten_score_notes() output into absolute-time note events:
    [{"midi", "start_sec", "end_sec", "measure"}].

    See this task's header comment for why dur_beats needs
    quarter_lengths_per_beat() as a divisor and abs_beat does not — they are
    different units (dur_beats is a quarterLength; abs_beat is already in
    notated-beat units) despite both having "beat" in the name.
    """
    qlb = quarter_lengths_per_beat(time_sig)
    sec_per_beat = 60.0 / bpm if bpm and bpm > 0 else 0.5
    events = []
    for n in notes:
        start_sec = n["abs_beat"] * sec_per_beat
        dur_notated_beats = (n["dur_beats"] / qlb) if qlb else n["dur_beats"]
        end_sec = start_sec + max(dur_notated_beats, 0.0) * sec_per_beat
        events.append({
            "midi": n["midi"],
            "start_sec": round(start_sec, 3),
            "end_sec": round(max(end_sec, start_sec), 3),
            "measure": n["measure"],
        })
    return events


def generate_reference_audio(score: dict, instrument: str, bpm: float) -> tuple[bytes, list[dict]]:
    """
    Render an AI reference performance of the WHOLE piece (not a played
    range — see this plan's Global Constraints) as WAV audio, plus a
    per-measure timeline for range-selection playback.

    Not unit-tested for actual audio correctness (pretty_midi/soundfile are
    mocked in the test harness, same convention as every other binary/IO-heavy
    dependency in this file) — test_generate_reference_audio_smoke only
    verifies the function runs end-to-end and returns the right shapes. Real
    audio-quality verification is a manual smoke test against a live Modal
    deployment (see this plan's Task 4).
    """
    time_sig = score.get("time_signature") or "4/4"
    beats_per_measure = beats_per_measure_from_time_sig(time_sig)
    notes = flatten_score_notes(score, None, None, beats_per_measure)
    events = notes_to_timed_events(notes, time_sig, bpm)
    timeline = build_measure_audio_timeline(score, time_sig, bpm, beats_per_measure)

    import pretty_midi
    safe_bpm = max(20.0, min(300.0, float(bpm))) if bpm else 120.0
    midi = pretty_midi.PrettyMIDI(initial_tempo=safe_bpm)
    inst = pretty_midi.Instrument(program=gm_program_for_instrument(instrument))
    for ev in events:
        if ev["end_sec"] <= ev["start_sec"]:
            continue
        pitch = max(0, min(127, int(ev["midi"])))
        inst.notes.append(pretty_midi.Note(
            velocity=90, pitch=pitch, start=ev["start_sec"], end=ev["end_sec"],
        ))
    midi.instruments.append(inst)

    audio = midi.fluidsynth(fs=22050, sf2_path="/usr/share/sounds/sf2/FluidR3_GM.sf2")

    import soundfile as sf
    import io
    buf = io.BytesIO()
    sf.write(buf, audio, 22050, format="WAV")
    return buf.getvalue(), timeline
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -10`
Expected: final line `NNN/NNN checks passed`, no `FAILED:` lines naming any
of the three new tests.

- [ ] **Step 6: Verify the file still compiles**

Run: `python -m py_compile modal_worker/worker.py`
Expected: no output, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): generate reference audio + measure timeline from parsed scores"
```

---

### Task 4: Worker — new synchronous Modal endpoint

**Files:**
- Modify: `modal_worker/worker.py` — insert the new function between
  `analyze_async` and `test_local`. As of this plan's writing, that region
  reads exactly:

  ```python
  @app.function(image=image, timeout=30, min_containers=1)
  @modal.fastapi_endpoint(method="POST", docs=True)
  def analyze_async(body: dict) -> dict:
      """
      Validates payload, spawns run_full_analysis in the background, returns immediately.
      The Edge Function only needs to wait ~2s for this acknowledgement.
      """
      take_id   = body.get("take_id")
      video_url = body.get("video_url")
      if not take_id or not video_url:
          return {"error": "take_id and video_url are required"}
      run_full_analysis.spawn(body)
      print(f"[analyze_async] spawned analysis for take {take_id}")
      return {"queued": True, "take_id": take_id}


  @app.local_entrypoint()
  def test_local():
      print("Mediant worker app loaded OK.")
  ```

  Insert the new function's full code (Step 1 below) directly after
  `analyze_async`'s closing `return {"queued": True, "take_id": take_id}`
  line and its two trailing blank lines, and before the
  `@app.local_entrypoint()` line. If this exact text is not found verbatim
  when you reach this task (e.g. an intervening change altered it), stop and
  report NEEDS_CONTEXT rather than guessing at a new location — the file has
  drifted from what this plan was written against.

**Interfaces:**
- Consumes: `generate_reference_audio` (Task 3).
- Produces: an HTTP POST endpoint accepting JSON `{"score": <dict>,
  "instrument": <str>, "bpm": <number>}` and returning JSON
  `{"audio_base64": <str>, "timeline": [...]}` on success or `{"error": <str>}`
  on failure (same shape `analyze()`'s existing validation failures already
  use, e.g. `{"error": "video_url is required"}` at worker.py:2404). This
  exact request/response shape is what Task 5 (the edge function) is written
  against — do not change field names without updating Task 5 to match.

**Important — this is a genuinely new, separately-addressed Modal endpoint.**
Per the documented Gotcha ("Modal URL has no path — root only"), every
`@modal.fastapi_endpoint`-decorated function on a Modal app gets its own
distinct URL (there is no shared path-based routing). This new endpoint is
**not** reachable via the existing `MODAL_WORKER_URL` env var — after this
task deploys, a human needs to look up the new function's URL from the Modal
deploy output/dashboard and add it as a new Supabase secret. This plan's
final task calls this out explicitly as a manual step; it cannot be
automated from inside this repo.

- [ ] **Step 1: Implement the endpoint**

```python
# ── Reference-audio endpoint ────────────────────────────────────────────────
# Synchronous — pure CPU synthesis, no ML model, fast enough for a direct
# request/response instead of the async .spawn()+webhook pattern the main
# analysis pipeline needs. Gets its OWN Modal URL (see Gotchas: "Modal URL
# has no path — root only"), separate from MODAL_WORKER_URL.

@app.function(image=image, timeout=60, memory=2048)
@modal.fastapi_endpoint(method="POST", docs=True)
def generate_reference_audio_endpoint(body: dict) -> dict:
    """
    Renders an AI reference performance for a whole parsed score.
    Accepts: score (the parsed-score dict, same shape as score_cache.parsed_notes
    or the Modal worker's own score parse output), instrument (declared
    instrument string), bpm (target tempo).
    Returns: { audio_base64, timeline } or { error }.
    """
    score = body.get("score")
    instrument = body.get("instrument", "")
    bpm = body.get("bpm")

    if not isinstance(score, dict) or not score.get("measures"):
        return {"error": "score with at least one measure is required"}
    try:
        bpm_f = float(bpm)
    except (TypeError, ValueError):
        return {"error": "bpm must be a number"}
    if not (20 <= bpm_f <= 300):
        return {"error": "bpm must be between 20 and 300"}

    try:
        audio_bytes, timeline = generate_reference_audio(score, instrument, bpm_f)
    except Exception as e:
        print(f"[generate_reference_audio_endpoint] FAILED: {e}")
        return {"error": f"Reference audio generation failed: {e}"}

    import base64
    return {
        "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
        "timeline": timeline,
    }
```

- [ ] **Step 2: Verify the file still compiles**

Run: `python -m py_compile modal_worker/worker.py`
Expected: no output, exit code 0.

- [ ] **Step 3: Run the full worker test suite**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -5`
Expected: `NNN/NNN checks passed`, zero failures (confirms nothing else in
the file regressed — this endpoint function itself has no dedicated test,
matching the existing convention that `analyze`/`analyze_async` — the two
endpoints it's modeled on — have none either; endpoint-level correctness is
verified by the manual smoke test in Task 8).

- [ ] **Step 4: Commit**

```bash
git add modal_worker/worker.py
git commit -m "feat(worker): add synchronous reference-audio Modal endpoint"
```

---

### Task 5: Edge function — `generate-reference-audio`

**Files:**
- Create: `supabase/functions/generate-reference-audio/index.ts`

**Interfaces:**
- Consumes: the Modal endpoint's exact request/response shape from Task 4
  (`{score, instrument, bpm}` → `{audio_base64, timeline}` / `{error}`); the
  `takes` columns from Task 1 (`reference_audio_path`, `reference_audio_bpm`,
  `reference_audio_timeline`) and the pre-existing `score_path`, `instrument`,
  `declared_bpm` columns; `score_cache.parsed_notes` (pre-existing table,
  read the same way `analyze-performance/index.ts:1337-1343` already does).
- Produces: `POST /generate-reference-audio` accepting `{"takeId": <string>}`
  in the request body, returning `{"audioUrl": <string>, "timeline": [...],
  "bpm": <number>}` on success. This exact response shape is what Task 6 (the
  frontend hook) is written against.

- [ ] **Step 1: Write the function**

Modeled on `supabase/functions/job-status/index.ts`'s auth/ownership
pattern (small, clean — the `analyze-performance` function this repo also
has is 1600+ lines and not a good template) and
`supabase/functions/analysis-summary/index.ts:1-9`'s use of the shared
`requireAuth`/`corsHeaders` helpers from `supabase/functions/_shared/cors.ts`
(confirmed live and used by 4 other edge functions, not dead code).

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, requireAuth } from '../_shared/cors.ts'

serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const auth = await requireAuth(req)
  if (auth instanceof Response) return auth
  const { user } = auth

  const jsonHeaders = { 'Content-Type': 'application/json', ...CORS }

  try {
    const { takeId } = await req.json()
    if (!takeId || typeof takeId !== 'string') {
      return new Response(JSON.stringify({ error: 'takeId is required' }), {
        status: 400, headers: jsonHeaders,
      })
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Ownership check happens in the same query that fetches the row — a
    // take that exists but belongs to someone else returns no row, exactly
    // like a take that doesn't exist. Same pattern as job-status/index.ts.
    const { data: take, error: takeErr } = await admin
      .from('takes')
      .select('id, score_path, instrument, declared_bpm, reference_audio_path, reference_audio_bpm, reference_audio_timeline')
      .eq('id', takeId)
      .eq('user_id', user.id)
      .single()

    if (takeErr || !take) {
      return new Response(JSON.stringify({ error: 'Take not found' }), {
        status: 404, headers: jsonHeaders,
      })
    }

    // Cache hit: already generated, return it without touching Modal.
    if (take.reference_audio_path) {
      const { data: signed, error: signErr } = await admin.storage
        .from('reference-audio')
        .createSignedUrl(take.reference_audio_path, 86400)
      if (signErr || !signed?.signedUrl) {
        return new Response(JSON.stringify({ error: 'Could not sign cached reference audio' }), {
          status: 500, headers: jsonHeaders,
        })
      }
      return new Response(JSON.stringify({
        audioUrl: signed.signedUrl,
        timeline: take.reference_audio_timeline ?? [],
        bpm: take.reference_audio_bpm,
      }), { headers: jsonHeaders })
    }

    if (!take.score_path) {
      return new Response(JSON.stringify({ error: 'This take has no sheet music to generate reference audio from' }), {
        status: 400, headers: jsonHeaders,
      })
    }

    // Cache miss: read the already-parsed score (same cache analyze-performance
    // reads — no fresh vision read here, see this task's edge-case note).
    const { data: cacheRow } = await admin
      .from('score_cache')
      .select('parsed_notes')
      .eq('score_path', take.score_path)
      .maybeSingle()

    if (!cacheRow?.parsed_notes?.measures?.length) {
      return new Response(JSON.stringify({
        error: "Sheet music hasn't been analyzed yet — try again after the next analysis run",
      }), { status: 400, headers: jsonHeaders })
    }

    const bpm = Number(take.declared_bpm)
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) {
      return new Response(JSON.stringify({ error: 'This take has no valid declared tempo to generate reference audio at' }), {
        status: 400, headers: jsonHeaders,
      })
    }

    const modalUrl = Deno.env.get('MODAL_REFERENCE_AUDIO_URL')
    if (!modalUrl) {
      return new Response(JSON.stringify({ error: 'Reference audio service is not configured' }), {
        status: 500, headers: jsonHeaders,
      })
    }

    const modalRes = await fetch(modalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        score: cacheRow.parsed_notes,
        instrument: take.instrument ?? '',
        bpm,
      }),
      signal: AbortSignal.timeout(45000),
    }).catch((e) => { console.warn('[generate-reference-audio] Modal call failed:', e?.message); return null })

    if (!modalRes || !modalRes.ok) {
      return new Response(JSON.stringify({ error: 'Reference audio generation failed' }), {
        status: 502, headers: jsonHeaders,
      })
    }

    const modalJson = await modalRes.json()
    if (modalJson.error || !modalJson.audio_base64) {
      return new Response(JSON.stringify({ error: modalJson.error ?? 'Reference audio generation failed' }), {
        status: 502, headers: jsonHeaders,
      })
    }

    const audioBytes = Uint8Array.from(atob(modalJson.audio_base64), (c) => c.charCodeAt(0))
    const storagePath = `${user.id}/${takeId}.wav`

    const { error: uploadErr } = await admin.storage
      .from('reference-audio')
      .upload(storagePath, audioBytes, { contentType: 'audio/wav', upsert: true })
    if (uploadErr) {
      return new Response(JSON.stringify({ error: `Failed to store reference audio: ${uploadErr.message}` }), {
        status: 500, headers: jsonHeaders,
      })
    }

    await admin.from('takes').update({
      reference_audio_path: storagePath,
      reference_audio_bpm: bpm,
      reference_audio_timeline: modalJson.timeline ?? [],
    }).eq('id', takeId)

    const { data: signed, error: signErr } = await admin.storage
      .from('reference-audio')
      .createSignedUrl(storagePath, 86400)
    if (signErr || !signed?.signedUrl) {
      return new Response(JSON.stringify({ error: 'Reference audio generated but could not be signed for playback' }), {
        status: 500, headers: jsonHeaders,
      })
    }

    return new Response(JSON.stringify({
      audioUrl: signed.signedUrl,
      timeline: modalJson.timeline ?? [],
      bpm,
    }), { headers: jsonHeaders })

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
```

Note the 24hr (`86400` second) signed-URL TTL — matches the existing
convention documented in Gotchas ("The 24hr window was intentional — don't
reduce it below what a realistic practice session needs") for every other
signed URL in this codebase.

- [ ] **Step 2: Verify the function type-checks**

Run: `cd supabase/functions/generate-reference-audio && deno check index.ts`
Expected: no type errors. If `deno` isn't on `PATH`, run
`npx --yes deno check index.ts` from the same directory instead, and paste
the actual command output into your report — a bare "it passed" claim
without the output is not sufficient (this exact gap was flagged as a minor
finding in the prior feature's final review).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/generate-reference-audio/index.ts
git commit -m "feat(edge): add generate-reference-audio endpoint"
```

---

### Task 6: Frontend — `useReferenceAudio` hook + playback controls

**Files:**
- Create: `src/hooks/useReferenceAudio.js`
- Create: `src/components/ReferenceAudioControls.jsx`
- Modify: `src/pages/Analysis.jsx` (wire the hook + controls in)

**Interfaces:**
- Consumes: `generate-reference-audio` edge function (Task 5) — exact request
  `{takeId}`, exact response `{audioUrl, timeline, bpm}`.
- Produces: `useReferenceAudio(takeId)` returning `{ audioRef, timeline,
  isLoading, error, isPlaying, tempo, generate, playRange, setTempo,
  togglePlayPause }`. `playRange(startMeasure, endMeasure)` is the function
  Task 7's range-selection handles call — its exact name and two-arg
  `(startMeasure, endMeasure)` signature is the interface Task 7 is written
  against; do not rename it without updating Task 7 to match.

- [ ] **Step 1: Write the hook**

```javascript
import { useCallback, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

/**
 * Fetches (or lazily generates) a take's AI reference audio, and exposes
 * playback controls including client-side tempo adjustment (no server
 * round-trip — see docs/superpowers/specs/2026-09-08-reference-audio-design.md
 * Part 3) and range-limited playback for the drag-to-select UI.
 */
export function useReferenceAudio(takeId) {
  const audioRef = useRef(null)
  const [timeline, setTimeline] = useState([])
  const [baselineBpm, setBaselineBpm] = useState(null)
  const [tempo, setTempoState] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [isPlaying, setIsPlaying] = useState(false)
  const rangeEndRef = useRef(null)

  // Returns { timeline, bpm } on success, null on failure — callers that need
  // the fresh data immediately after calling this (see playRange below) MUST
  // use the returned value, not the timeline/baselineBpm state variables:
  // setState from inside this same async call has not flushed yet by the
  // time an awaiting caller resumes, so reading state here would see the
  // PRE-generation value, not the one just fetched.
  const generate = useCallback(async () => {
    if (!takeId) return null
    if (audioRef.current?.src) return { timeline, bpm: baselineBpm }
    setIsLoading(true)
    setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-reference-audio`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token}`,
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ takeId }),
        },
      )
      const body = await resp.json()
      if (!resp.ok || body.error) throw new Error(body.error || 'Failed to generate reference audio')

      if (!audioRef.current) audioRef.current = new Audio()
      audioRef.current.src = body.audioUrl
      audioRef.current.preservesPitch = true
      const freshTimeline = Array.isArray(body.timeline) ? body.timeline : []
      setTimeline(freshTimeline)
      setBaselineBpm(body.bpm)
      setTempoState(body.bpm)
      return { timeline: freshTimeline, bpm: body.bpm }
    } catch (e) {
      setError(e.message || 'Failed to generate reference audio')
      return null
    } finally {
      setIsLoading(false)
    }
  }, [takeId, timeline, baselineBpm])

  const setTempo = useCallback((bpm) => {
    setTempoState(bpm)
    if (audioRef.current && baselineBpm) {
      audioRef.current.playbackRate = bpm / baselineBpm
    }
  }, [baselineBpm])

  const clearRangeWatcher = useCallback(() => {
    const audio = audioRef.current
    if (audio && rangeEndRef.current) {
      audio.removeEventListener('timeupdate', rangeEndRef.current)
      rangeEndRef.current = null
    }
  }, [])

  // Plays a measure range, generating the reference audio first if it hasn't
  // been fetched yet — the range-selection UI (this hook's other consumer,
  // see Task 7) has no reason to require a separate "Play reference" click
  // first, and silently no-op-ing when nothing is loaded yet would be a real
  // bug, not just an edge case to note for later.
  //
  // Uses generate()'s RETURNED timeline, not the `timeline` state variable,
  // when it just triggered a fresh generation — setTimeline's update has not
  // flushed by the time this resumes from `await generate()`, so reading the
  // `timeline` closure variable here would still see the pre-generation
  // value (usually []) and silently fail to find either measure.
  const playRange = useCallback(async (startMeasure, endMeasure) => {
    let tl = timeline
    if (!audioRef.current?.src) {
      const result = await generate()
      if (!result) return
      tl = result.timeline
    }
    const audio = audioRef.current
    if (!audio || !audio.src || !tl.length) return
    const startEntry = tl.find(t => t.measure === startMeasure)
    const endEntry = tl.find(t => t.measure === endMeasure) ?? startEntry
    if (!startEntry || !endEntry) return

    clearRangeWatcher()
    audio.currentTime = startEntry.start_sec
    const stopAt = endEntry.end_sec
    const onTick = () => {
      if (audio.currentTime >= stopAt) {
        audio.pause()
        setIsPlaying(false)
        clearRangeWatcher()
      }
    }
    rangeEndRef.current = onTick
    audio.addEventListener('timeupdate', onTick)
    audio.play()
    setIsPlaying(true)
  }, [timeline, clearRangeWatcher, generate])

  // Same "generate on first use" shape as playRange, and for the same
  // reason: composing this as two separate calls in the component
  // (onGenerate() then onPlayPause(), not awaited between them) would let
  // the play call run before generation finishes and silently no-op on the
  // still-empty audio.src — consolidating both into one hook function avoids
  // that race entirely rather than requiring the caller to sequence it
  // correctly.
  const togglePlayPause = useCallback(async () => {
    if (!audioRef.current?.src) {
      const result = await generate()
      if (!result) return
      audioRef.current.play()
      setIsPlaying(true)
      return
    }
    const audio = audioRef.current
    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
    } else {
      clearRangeWatcher()
      audio.play()
      setIsPlaying(true)
    }
  }, [isPlaying, clearRangeWatcher, generate])

  return useMemo(() => ({
    audioRef, timeline, isLoading, error, isPlaying, tempo,
    generate, playRange, setTempo, togglePlayPause,
  }), [timeline, isLoading, error, isPlaying, tempo, generate, playRange, setTempo, togglePlayPause])
}
```

- [ ] **Step 2: Write the controls component**

```jsx
import styles from './ReferenceAudioControls.module.css'

/**
 * Presentational only — no UI polish per this feature's explicit "just needs
 * to be accurate, don't worry about how it looks" scope. Placement within
 * Analysis.jsx is not load-bearing; wherever it's reachable is fine.
 */
export default function ReferenceAudioControls({
  isLoading, error, isPlaying, tempo, onPlayPause, onTempoChange,
}) {
  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.btn} disabled={isLoading} onClick={onPlayPause}>
        {isLoading ? 'Generating…' : isPlaying ? 'Pause reference' : 'Play reference'}
      </button>
      {tempo != null && (
        <label className={styles.tempoLabel}>
          Tempo (BPM)
          <input
            type="number" min="20" max="300" step="1"
            className={styles.tempoInput}
            value={Math.round(tempo)}
            onChange={e => onTempoChange(Number(e.target.value))}
          />
        </label>
      )}
      {error && <span className={styles.error}>{error}</span>}
    </div>
  )
}
```

```css
.wrap { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.btn { padding: 8px 16px; cursor: pointer; }
.tempoLabel { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.tempoInput { width: 64px; padding: 4px; }
.error { color: #9C2728; font-size: 13px; }
```

(The error color reuses the Atelier error token `#9C2728` from
`agent_workspace/DESIGN_RULES.md` — the one piece of visual convention worth
following even in an intentionally unpolished pass, since it's the existing
semantic-error color already used everywhere else, not new decoration.)

- [ ] **Step 3: Wire into `Analysis.jsx`**

Add the import near `Analysis.jsx`'s other component imports (top of file):

```javascript
import { useReferenceAudio } from '../hooks/useReferenceAudio'
import ReferenceAudioControls from '../components/ReferenceAudioControls'
```

Inside the `Analysis` component function, add the hook call near its other
`useState`/hook calls (the component has many already — add this as one
more, referencing whatever variable currently holds the active take's id,
e.g. `take?.id`):

```javascript
  const referenceAudio = useReferenceAudio(take?.id)
```

Render the controls near the score panel — the simplest, lowest-risk
insertion point is directly before the closing of the score panel's header
`<div>` block that precedes `scorePanelBody` (the same block whose closing
`</div>` appears right before line 1956's `<div className={aStyles.scorePanelBody}...>`
seen in Task 7 below — insert the controls as a new line directly above that
`<div className={aStyles.scorePanelBody}`):

```jsx
            <ReferenceAudioControls
              isLoading={referenceAudio.isLoading}
              error={referenceAudio.error}
              isPlaying={referenceAudio.isPlaying}
              tempo={referenceAudio.tempo}
              onPlayPause={referenceAudio.togglePlayPause}
              onTempoChange={referenceAudio.setTempo}
            />
```

- [ ] **Step 4: Verify the app builds and lints clean**

Run: `npm run build`
Expected: build succeeds with no errors.

Run: `npm run lint`
Expected: no new lint errors from the three files this task touches/creates.

- [ ] **Step 5: Manual verification**

No frontend test framework exists in this repo (confirmed during the prior
feature: no `test` script in `package.json`, no `vitest`/`jest`/
`@testing-library` dependency) — this step is manual, not a placeholder for
an automated one.

1. Run `npm run dev`, open a take's Analysis page that has an uploaded
   image/PDF score and a `declared_bpm`.
2. Click "Play reference" — confirm it shows "Generating…", then plays audio.
3. Reload the page and click again — confirm it plays immediately (cache hit,
   no "Generating…" delay) and the Network tab shows no Modal-side latency on
   this second call.
4. Change the tempo number field while paused, then play — confirm the pitch
   does not shift (only speed changes). This is the one behavior this plan
   cannot verify any other way, since `audio.preservesPitch` behavior is a
   browser runtime property with no static-analysis equivalent.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useReferenceAudio.js src/components/ReferenceAudioControls.jsx src/components/ReferenceAudioControls.module.css src/pages/Analysis.jsx
git commit -m "feat(ui): add reference-audio playback hook and controls"
```

---

### Task 7: Frontend — range-selection drag handles

**Files:**
- Modify: `src/pages/Analysis.jsx` (inside the existing score-overlay block,
  lines 1962-2154 as of this plan's writing — re-verify against the live
  file before editing, since Task 6 in this same plan adds lines above this
  region and will have shifted these line numbers by the time this task
  runs; locate by searching for the exact code shown below instead of
  trusting the line numbers)

**Interfaces:**
- Consumes: `referenceAudio.playRange(startMeasure, endMeasure)` (Task 6, the
  hook instance already created in that task's Step 3) and the existing
  `boxByMeasure`/`getBox`/`scoreImgBox`/`currentScorePage` values already
  computed inside this same IIFE (worker.py:1979/:2047/`scoreImgBox` state/
  `currentScorePage` state — all pre-existing, unmodified by this task).

- [ ] **Step 1: Add selection state**

Inside the `Analysis` component function, alongside its other `useState`
calls (the same general area as Task 6's `referenceAudio` hook call):

```javascript
  const [selRange, setSelRange] = useState(null)   // {start, end} measure numbers, or null
  const [dragHandle, setDragHandle] = useState(null) // 'start' | 'end' | null
```

- [ ] **Step 2: Add the drag handles inside the existing overlay**

The overlay block that already renders markers/span-bars is the IIFE
starting at (as of this plan's writing) `src/pages/Analysis.jsx:1962`:

```jsx
                {(() => {
                  const flags = take?.flags ?? []
                  // ... boxByMeasure, rowBoundsList, getBox, markerSpecs, spanSegments
                  // all already defined here — unchanged by this task ...
                  return (
                    <div className={aStyles.scoreImgWrap} ref={scoreImgWrapRef}>
                      <img ref={scoreImgRef} src={scoreUrl} className={aStyles.scoreImg} alt="Sheet music"
                        style={scoreRenderSize ? { width: scoreRenderSize.width, height: scoreRenderSize.height } : undefined} />

                      {scoreImgBox && currentScorePage === 0 && (
                        <div style={{ position: 'absolute', left: scoreImgBox.left, top: scoreImgBox.top, width: scoreImgBox.width, height: scoreImgBox.height }}>
                          {/* existing span bars ... */}
                          {/* existing circle markers ... */}
                        </div>
                      )}
                    </div>
                  )
                })()}
```

Add the range-selection handles as a **new sibling** inside the same
`scoreImgBox && currentScorePage === 0` conditional block, after the
existing circle-markers `.map(...)` call and before that block's closing
`</div>` (i.e., append this new JSX directly after the closing `})}` of the
`{markerSpecs.map((m, mi) => { ... })}` block, still inside the same
surrounding `<div style={{ position: 'absolute', ... }}>`):

```jsx
                          {/* Range-selection handles — reuse the SAME boxByMeasure
                              geometry the markers above already compute. All
                              known measure numbers, sorted, define the draggable
                              range; dragging snaps to the nearest measure box
                              (no per-note position data exists to snap finer). */}
                          {(() => {
                            const knownMeasures = Object.keys(boxByMeasure).map(Number).sort((a, b) => a - b)
                            if (!knownMeasures.length) return null
                            const startM = selRange?.start ?? knownMeasures[0]
                            const endM = selRange?.end ?? knownMeasures[knownMeasures.length - 1]

                            function nearestMeasure(pctX, pctY) {
                              let best = knownMeasures[0]
                              let bestDist = Infinity
                              for (const n of knownMeasures) {
                                const box = boxByMeasure[n]
                                const dist = Math.abs(box.x - pctX) + Math.abs(box.y - pctY) * 4
                                if (dist < bestDist) { bestDist = dist; best = n }
                              }
                              return best
                            }

                            function onHandlePointerDown(which) {
                              return (e) => {
                                e.preventDefault()
                                setDragHandle(which)
                              }
                            }

                            // Document-level listeners while dragging — the pointer
                            // routinely leaves the small handle element itself
                            // mid-drag, so listening only on the handle would lose
                            // the drag the moment the cursor moves off it.
                            if (dragHandle) {
                              const onMove = (e) => {
                                const wrap = scoreImgWrapRef.current
                                if (!wrap) return
                                const rect = wrap.getBoundingClientRect()
                                const pctX = ((e.clientX - rect.left) / rect.width) * 100
                                const pctY = ((e.clientY - rect.top) / rect.height) * 100
                                const nearest = nearestMeasure(pctX, pctY)
                                setSelRange(prev => {
                                  const cur = prev ?? { start: startM, end: endM }
                                  if (dragHandle === 'start') {
                                    return { start: Math.min(nearest, cur.end), end: cur.end }
                                  }
                                  return { start: cur.start, end: Math.max(nearest, cur.start) }
                                })
                              }
                              const onUp = () => setDragHandle(null)
                              document.addEventListener('pointermove', onMove)
                              document.addEventListener('pointerup', onUp, { once: true })
                              // Cleanup runs on every re-render while dragging is
                              // active (dragHandle is a dependency of this whole
                              // effect-like block by virtue of being read above) —
                              // React re-invokes this IIFE on every state change,
                              // so stale listeners from the previous render must
                              // not accumulate.
                              setTimeout(() => document.removeEventListener('pointermove', onMove), 0)
                            }

                            const startBox = getBox(startM)
                            const endBox = getBox(endM)

                            return (
                              <>
                                <div
                                  className={aStyles.scoreMarker}
                                  style={{ left: `${startBox.left}%`, top: `${startBox.y}%`, background: '#2C4A3E', cursor: 'ew-resize' }}
                                  onPointerDown={onHandlePointerDown('start')}
                                  title={`Range start: m.${startM}`}
                                >{'◀'}</div>
                                <div
                                  className={aStyles.scoreMarker}
                                  style={{ left: `${endBox.right}%`, top: `${endBox.y}%`, background: '#2C4A3E', cursor: 'ew-resize' }}
                                  onPointerDown={onHandlePointerDown('end')}
                                  title={`Range end: m.${endM}`}
                                >{'▶'}</div>
                                <button
                                  type="button"
                                  className={aStyles.scoreMarker}
                                  style={{ left: `${(startBox.left + endBox.right) / 2}%`, top: `${Math.min(startBox.y, endBox.y) - 4}%`, background: 'var(--accent)' }}
                                  onClick={() => { playTick(); referenceAudio.playRange(startM, endM) }}
                                  title={`Play m.${startM}–${endM}`}
                                >{'▸'}</button>
                              </>
                            )
                          })()}
```

This reuses `aStyles.scoreMarker`'s existing CSS class for all three new
elements (two drag handles + one play button) rather than adding new CSS —
consistent with this feature's explicit "don't worry about UI" scope; the
inline `background` overrides give them a visually distinct color
(`#2C4A3E`, the Atelier "structural dark" token from `DESIGN_RULES.md`, not
an arbitrary new color) from the existing black/orange flag markers so a
user isn't confused about which markers do what, without writing new CSS
rules.

**Edge case — no `boxByMeasure` data.** If `hasExactPositions` is `false`
(the score has no real Gemini-derived positions, only the heuristic-grid
fallback), `knownMeasures` will still be populated (the fallback branch also
populates `boxByMeasure`, just with estimated positions) — so range selection
still works, just snaps to estimated rather than real measure positions. No
special-case handling needed; this falls out of reusing the existing
`boxByMeasure` object as-is.

- [ ] **Step 3: Verify the app builds and lints clean**

Run: `npm run build`
Expected: build succeeds with no errors.

Run: `npm run lint`
Expected: no new lint errors from this task's change to `Analysis.jsx`.

- [ ] **Step 4: Manual verification**

1. Open a take's Analysis page with an image/PDF score that has real
   Gemini-derived positions (`take.measure_layout.measures` has `x_pct`/
   `y_pct` values — any take analyzed after multi-page reading was added
   should have this).
2. Confirm two small handles and a play button appear over the score.
3. Drag the left handle right and the right handle left — confirm they
   don't cross past each other (start never exceeds end).
4. Click the play button — confirm reference audio plays starting at the
   selected range and stops automatically at the range's end, without
   requiring a second click to pause.
5. Confirm this works even before "Play reference" (Task 6's button) has
   ever been clicked — the range-select play button should trigger
   generation itself if no audio has been fetched yet. **If it does not**
   (i.e. `referenceAudio.playRange` silently no-ops because `audioRef.current.src`
   is empty), that's a real gap in Task 6's hook, not this task — go back
   and make `playRange` call `generate()` first when there's no audio loaded
   yet, awaiting it before proceeding to seek/play. Note this in your task
   report as a cross-task fix if you have to make it, since it touches
   `useReferenceAudio.js` from Task 6.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Analysis.jsx
git commit -m "feat(ui): add drag-to-select range playback for reference audio"
```

---

### Task 8: Deployment — manual steps (not automated, no code)

This task has no code changes and no tests — it documents what a human must
do after Tasks 1-7 are merged and deployed, since none of it can be verified
or executed from inside this repo.

- [ ] **Step 1: Apply the migration**

Apply `supabase/migrations/20260908020000_create_reference_audio.sql` to the
production database before redeploying the `generate-reference-audio` edge
function — it queries the new `takes` columns unconditionally.

- [ ] **Step 2: Deploy the worker and capture the new endpoint's URL**

After `modal deploy modal_worker/worker.py` runs (via the existing
`deploy-modal-worker.yml` CI workflow, or manually), find
`generate_reference_audio_endpoint`'s URL in the deploy output or the Modal
dashboard — it will **not** be the same URL as `MODAL_WORKER_URL`, per this
plan's Task 4 note (every `@modal.fastapi_endpoint` function gets its own
distinct URL).

- [ ] **Step 3: Set the new Supabase secret**

Add the URL captured in Step 2 as `MODAL_REFERENCE_AUDIO_URL` — the exact
env var name `generate-reference-audio/index.ts` reads (Task 5). Use
whatever mechanism this project already uses to set `MODAL_WORKER_URL`
(Supabase dashboard or `supabase secrets set`, matching the existing
project's own deployment process — not determined by this plan).

- [ ] **Step 4: Deploy the edge function**

Deploy `generate-reference-audio` the same way every other edge function in
`supabase/functions/` is deployed in this project.

- [ ] **Step 5: End-to-end smoke test**

With all of the above live, run through Task 6 Step 5 and Task 7 Step 4's
manual verification against the real deployed stack (not `npm run dev`
against local-only state) — this is the first point in the whole plan where
real audio quality (does a clarinet part actually sound like a clarinet,
does the tempo genuinely match `declared_bpm`) can be judged at all, since
every earlier task's tests run against mocked `pretty_midi`/`soundfile`.

---

## Spec coverage check

| Spec section | Task |
|---|---|
| Part 1 — audio generation (MIDI build, FluidSynth render, GM program lookup) | Task 2, Task 3 |
| Part 1 — synchronous Modal endpoint | Task 4 |
| Part 2 — storage bucket, `takes` columns | Task 1 |
| Part 2 — caching, edge function orchestration | Task 5 |
| Part 2 — no-cached-score-notes edge case | Task 5 |
| Part 3 — playback controls, client-side tempo via `playbackRate` | Task 6 |
| Part 4 — range-selection handles reusing existing position data | Task 7 |
| Testing — worker unit tests | Task 2, Task 3 |
| Testing — edge function type-check | Task 5 |
| Testing — frontend manual walkthrough | Task 6, Task 7 |
| Out of scope — MusicXML, sub-measure selection, neural synthesis, server-side tempo regen | Not touched by any task, as intended |
| (New, found during plan-writing, not in spec) — new Modal endpoint needs its own URL/secret | Task 4 (code note), Task 8 (manual deploy step) |
