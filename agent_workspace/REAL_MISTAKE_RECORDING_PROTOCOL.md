# Real Mistake Recording Protocol — Plan Only, Not Executed

**Status: PLAN. No recordings exist yet. No code was written or run for
this document — it is pure planning, per the directive that produced
it (2026-11-05).**

**Why this exists:** every wrong-note-detection result measured this
week (production's `find_wrong_note_candidates`, the Basic Pitch +
`AudioToScoreMatcher` adapter, the confidence/duration gate, the
contextual-verification check) was measured against SYNTHETIC
pitch-shift injections (`inject_audio_mistakes.py`). The
contextual-verification round (2026-11-05) found a real, confirmed
confound baked into that synthetic methodology's own validity gate
(injected notes can never be octave-equivalent to nearby context,
because the gate rejects that case before an injection counts as
valid) — meaning the entire picture built this week may not generalize
to how real musicians actually play wrong notes. The smallest justified
next action is not another model or threshold: it is a small set of
real, labeled performance errors to test against.

---

## 1. Scores selected (named piece IDs, not categories)

Reused, not authored. Two contrasting instrument families, both
already fully validated in this project (real MusicXML in
`visual_corpus/clean/`, real MusicNet audio and ground truth already
cached, extensively exercised by every round this week):

| Role | Piece ID | Work | Movement | Time sig | Measures | Why this one |
|---|---|---|---|---|---|---|
| Core, bowed string | **2288** | Bach, Violin Partita No. 1 in B minor | 2. Corrente | 4/4 | 50 | Already the most-used dev piece this week — Parangonar alignment, Basic Pitch extraction, the adapter, and both verified synthetic injections (cases 1–2) all ran on it. A real recording of it is directly comparable to everything already measured. |
| Core, wind | **2202** | Bach, Flute Partita in A minor | 1. Allemande | 4/4 | 65 | A genuinely different instrument family (wind, not bowed string) — more contrast than adding a second string instrument. Also already fully validated this week (extraction, alignment). |

**Excerpt, not the whole movement** (both movements run 3–5 minutes
full length — too long for 12 short takes): **the first 8 measures of
each piece.** At each piece's own average tempo this is roughly
20–30 seconds of music — short enough to record repeatedly without
fatigue, long enough to contain several real note-to-note transitions
and at least one clear phrase boundary. Using the SAME 8-measure
excerpt for every take of a given instrument keeps the expected score
identical across all 6 of that instrument's recordings — only the
performance varies, which is what makes the takes comparable to each
other and to this week's synthetic results.

### Polyphonic instrument — checked, not included, with the reason stated plainly

The directive asked to check whether a polyphonic instrument should be
included, given 156 unused MusicNet Solo Piano recordings exist
(flagged earlier this session, never used). Checked directly: raw
MIDI exists for all 156 (e.g. piece **2310**, Bach WTK I No. 15
Prelude, the shortest at 55 seconds), but **no verified MusicXML
score** exists for any of them in this project — only
`validate_alignment_against_musicnet.py`'s `midi_score_to_dict`, which
explicitly picks the single part with the most notes and was built for
"a genuinely solo piece [with] exactly one pitched part" (its own
docstring). None of this week's evaluation tooling — production's
`find_wrong_note_candidates`, `note_sequence_evaluator.py`'s DP
matcher, or the Basic Pitch adapter — handles chords or multiple
simultaneous voices from one instrument; all three assume one pitch
per note event.

**Recommendation: do not include a genuinely polyphonic recording this
round.** Doing so would require new multi-voice matching logic, which
is new tooling and explicitly out of scope ("do not build a new
dataset platform"). If a different TIMBRE is wanted later without
building that, piece 2310 could be recorded as a **monophonic
single-line excerpt** (e.g. just the top voice of a few measures) —
but that tests a new timbre, not polyphony, and should be labeled as
such in any future manifest rather than implied to be a polyphony test.

---

## 2. Recording protocol (plain instructions, no code)

12 recordings total: **4 correct, 4 with a deliberate wrong pitch, 4
with a deliberate timing deviation** — split evenly across the two
instruments (6 each: 2 correct, 2 wrong-pitch, 2 timing-deviation per
instrument).

**Setup (once per instrument):**
1. Have the first 8 measures of the piece in front of you — use the
   existing project asset directly: `2288_page1.png` /
   `2202_page1.png` in `visual_corpus/clean/` already show this
   (crop or just read measures 1–8 off the full page).
2. Record in a quiet room, phone or any microphone is fine — this is
   about having a real recording with a real, known mistake in it, not
   about studio audio quality. Save each take as a separate audio
   file (`.wav` or `.m4a`, either is fine — convert to `.wav` before
   evaluation if needed, same as every other audio file this
   investigation has used).

**Take type A — Correct (2 per instrument, 4 total):**
Play the 8-measure excerpt as accurately as you can, start to finish,
no deliberate errors. If you know you made an accidental slip, keep
the recording anyway and note it (see manifest, field
`accidental_mistakes`) rather than discarding it — an accidentally
imperfect "correct" take is still useful real data, as long as it's
honestly labeled.

**Take type B — Deliberate wrong pitch (2 per instrument, 4 total):**
Before recording, pick ONE note in the 8 measures and decide which
different pitch you'll play instead (any clearly different pitch is
fine — a neighbour tone, a leap, whatever is natural to play "wrong"
in the moment). Play the excerpt, playing that one note as the wrong
pitch and everything else correctly. Immediately after recording —
while you still remember exactly what happened — write down: which
measure and roughly which beat the wrong note fell on, what the score
says there, and what you actually played instead.

**Take type C — Deliberate timing deviation (2 per instrument, 4
total):** Before recording, pick ONE place in the 8 measures to
deliberately rush, drag, or pause unnaturally (e.g. hold a note too
long, come in early after a rest, speed up through a passage). Play
the rest of the excerpt normally and at the correct pitches. Immediately
after recording, write down where the deviation was and what kind it
was (rushed / dragged / early entrance / late entrance / unnatural
pause).

**Immediately after EVERY take, before moving to the next one:**
listen back to the recording once. Confirm the intended error is
actually audible where you thought it was — **do not assume it
happened just because you meant it to.** This project already found,
in the synthetic injection work, that an intended mistake can silently
fail to land as intended (phase-vocoder artifacts, a substitute pitch
that happens to already be expected nearby, etc.) — a live take has
the same risk from a simple slip of the hand or a mistake landing
somewhere other than where you planned. If the intended error isn't
there, or something ELSE unplanned also happened, note that honestly
in the manifest rather than silently treating the take as clean.

---

## 3. Manifest format — actual schema, with a worked example

One row per recording, 12 rows total. CSV or JSON, either works with
existing tooling (`csv.DictReader` and `json.loads` are both already
used throughout this week's scripts) — JSON shown here since nested
notes are easier to read in it, but a flat CSV with the same column
names works identically.

```json
{
  "recording_id": "real_001",
  "piece_id": "2288",
  "instrument": "Violin",
  "measure_range": "1-8",
  "audio_file": "real_mistake_corpus/audio/real_001.wav",
  "recorded_date": "2026-11-06",
  "intended_error_type": "wrong_pitch",
  "intended_error_measure": 4,
  "intended_error_beat_approx": 2.0,
  "intended_error_description": "played G4 instead of F#4 on the second beat of measure 4",
  "verified": true,
  "verified_by": "<the person who recorded and listened back>",
  "verified_notes": "error audible exactly as intended; no other mistakes noticed on relisten",
  "accidental_mistakes": []
}
```

**Field reference:**

| Field | Type | Notes |
|---|---|---|
| `recording_id` | string | Unique, e.g. `real_001`–`real_012`. |
| `piece_id` | string | `"2288"` or `"2202"` — matches the existing MusicNet piece ID, so every existing loader (`load_rows`, `INSTRUMENT_MAP`) keys off it the same way it already does for every other piece this week. |
| `instrument` | string | `"Violin"` or `"Flute"` — matches `INSTRUMENT_MAP`'s existing values exactly. |
| `measure_range` | string | Always `"1-8"` for this round — kept as a field for future rounds that might vary it. |
| `audio_file` | string | Relative path under the storage location (section 4). |
| `recorded_date` | string | ISO date. |
| `intended_error_type` | string | One of `"correct"`, `"wrong_pitch"`, `"timing"`. |
| `intended_error_measure` | int \| null | `null` for `"correct"` takes. |
| `intended_error_beat_approx` | float \| null | Approximate beat within the measure; `null` for `"correct"`. |
| `intended_error_description` | string \| null | Free text — what was actually played/done, in the performer's own words. |
| `verified` | bool | **Must be set after listening back, never assumed true by default.** |
| `verified_by` | string | Who listened back and confirmed. |
| `verified_notes` | string | What was actually heard on relisten — may confirm, may contradict, the intended description. |
| `accidental_mistakes` | list of strings | Any OTHER mistake noticed on relisten that wasn't intended — explicitly never silently dropped, per the directive. Empty list if genuinely none. |

This directly mirrors the shape `inject_audio_mistakes.py`'s own
`injected` dict and `inject_mistake_verified`'s verification gates
already use (`onset_sec`/`measure`/`original_note`/`new_note` plus an
explicit valid/invalid verdict) — same spirit, applied to a human
listening instead of an automated acoustic/ambiguity check, because no
automated check can substitute for a human confirming what a human
actually played.

---

## 4. Storage location within the existing project structure

**Audio + manifest — NOT committed to git**, following the exact
existing convention every other piece of audio/validation data this
investigation has used:

```
/Users/matthewwu/.cache/mediant_validation/real_mistake_corpus/
├── manifest.json              (the 12 rows, schema above)
└── audio/
    ├── real_001.wav
    ├── real_002.wav
    └── ... real_012.wav
```

This sits alongside the existing `data/` (MusicNet audio + labels) and
`visual_corpus/` (MusicXML + page renders) directories already used by
every script this week — same cache root, same reasoning (real
recordings, however small, don't belong in the git history; the
pointer to where they live does).

**This planning document** (committed, per the directive):
`agent_workspace/REAL_MISTAKE_RECORDING_PROTOCOL.md` — alongside
`AGENT_TASKS.md`, `AUDIO_PIPELINE_AUDIT.md`, and the other planning/
audit docs already living there.

---

## 5. Minimum human recording work required — realistic, not minimized

**This cannot be done by an agent. It requires an actual musician
playing an actual violin and an actual flute** (or substitute
instruments if those aren't available — any instrument the performer
can deliberately control pitch and timing on; the SPECIFIC instrument
matters less than it being a real human performance with a real,
audible, afterward-checked mistake). Realistic time estimate for one
reasonably practiced player:

- Learning/refreshing the two 8-measure excerpts (if not already
  comfortable with this repertoire): 15–30 minutes. These are
  standard-difficulty Bach excerpts, not virtuosic — most intermediate
  players on either instrument could sight-read them with a little
  practice.
- Recording 12 short takes, including false starts and re-takes when
  an error doesn't land as intended on the first try: 30–60 minutes.
- Listening back and filling in the manifest for each take
  IMMEDIATELY after recording it (not batched at the end, per the
  protocol above): adds roughly 2–3 minutes per take, so another
  25–35 minutes.

**Total: roughly 1–2 hours of real musician time**, most of which is
recording and honest self-verification, not score-learning. The owner
(or whoever the owner recruits to play) needs to actually do this — no
part of it can be simulated, synthesized, or delegated to further
agent work.

---

## 6. Next evaluation step once recordings exist (specified, not built)

Once `manifest.json` and the 12 `.wav` files exist at the location
above, evaluation reuses exactly the tooling already built and used
this week — no new scripts, only new input data:

1. **Load each recording's audio + its manifest row.** Plain
   `json.load`/`wave file read` — no new loader needed beyond what
   `json`/`soundfile` already do everywhere else in this investigation.
2. **Score reference**: the SAME already-cached `2288.musicxml` /
   `2202.musicxml` in `visual_corpus/clean/`, parsed via `worker.parse_musicxml`
   exactly as every script this week already does. No new score
   acquisition needed — these are the same two pieces used all week.
3. **Ground truth for scoring**: unlike MusicNet audio (which has a
   pre-existing per-note CSV from the dataset itself), these real
   recordings have no independent per-note timing ground truth. The
   manifest's `intended_error_measure`/`verified_notes` fields ARE the
   ground truth for this round — a human-verified statement of what
   measure (and, for correct takes, the absence of any such measure)
   contains a real error. This is a real, disclosed limitation:
   evaluation here is at MEASURE granularity, not full per-note
   alignment accuracy the way the MusicNet synthetic-injection rounds
   measured it, because no independent note-by-note ground truth
   exists for live recordings the way MusicNet's own dataset provides
   for its audio.
4. **Run production, unmodified**: `worker.run_pitch_tracking` →
   `worker.dtw_align_to_score` → `worker.find_wrong_note_candidates`,
   exactly the chain used in every production-comparison this week —
   on each of the 12 real recordings, against its matching score. No
   code changes; same three functions, new audio.
5. **Run the still-alive candidate, unmodified**: the Basic Pitch +
   `AudioToScoreMatcher` adapter (`basic_pitch_score_adapter.detect_wrong_notes`,
   fed by `pa.AudioToScoreMatcher` alignment and Basic Pitch's own note
   extraction) — the one candidate from this week with a real, if
   imperfect, result (6/6 recall on synthetic cases, 5.99% false-positive
   rate). Same adapter, same code, new audio.
6. **Score both against the manifest** using
   `note_sequence_evaluator.align_note_sequences` (unmodified) at
   measure granularity: for each recording, does the detector's set of
   flagged measures match the manifest's verified error measure (for
   wrong-pitch/timing takes) or stay empty (for correct takes)? Report
   true positives, false positives, and misses as raw counts per
   detector, per instrument — the same units this week's every other
   round has reported in, so the two pictures (synthetic vs. real) are
   directly comparable side by side.
7. **The comparison that actually matters**: does either detector's
   synthetic-injection performance (production: ~0% recall; the
   adapter: 6/6 recall at ~6% FP) hold up on these 12 real recordings,
   or diverge from it? Divergence in either direction would be a real,
   important finding about whether this week's entire evaluation
   picture generalizes — which is the whole reason this small real
   corpus is being proposed.

No new tooling is required for any of steps 1–6. The only genuinely
new work is the recording itself (section 5).
