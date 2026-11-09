# Local End-to-End Integration Harness — 2026-11-08

Build round. Local, offline, CPU-only, $0. No Modal call, no Anthropic or
Gemini call, no Supabase access, no `src/` change, no `worker.py` change, no
`page_omr_adapter.py` change. BASE `f365b1c`.

Harness: `modal_worker/local_e2e_integration_harness.py` (run with
`/Users/matthewwu/.cache/mediant_validation/venv/bin/python modal_worker/local_e2e_integration_harness.py`).

## Summary

- The chain runs end to end on one real fixture: MusicNet 2220, Bach Cello
  Suite 3 "4. Sarabande", solo cello, 302 s. All 7 Task 2 property checks
  pass on the final run. Task 3 schema check passes. Regression suite matches
  baseline.
- **One real integration defect found and fixed in the harness (not in
  production code).** Parangonar's default `max_bp=64` (a cap of 1.28 s per
  beat at 50 fps) cannot track this performance, which runs at about 2.06 s
  per beat. On the unmodified default, 194 of 196 notes came back at the same
  time (0.52 s). The fix is one constructor argument, derived from this
  piece's own audio length and score span (no ground-truth labels used in the
  rule). After the fix: 192 distinct times, monotonic, 0.54–301.96 s.
- **Mismatched audio is not caught by the matcher.** Silence, white noise,
  and a different MusicNet recording (2186) each produce a plausible-looking,
  monotonic, full-span alignment. Structural checks do not flag them. Only an
  independent Basic Pitch onset-evidence check does. That check must be part
  of any future use.
- **Fixture coverage gap (pre-existing, in the Step 1 corpus builder).** The
  MIDI has four tracks. The builder keeps only the "Solo Cello" track (196
  notes). The four tracks hold 196 + 144 + 68 + 26 = 434 notes, the same count
  as the MusicNet labels (428 of 434 match on beat and pitch). So the page shows
  about 45% of the performed notes. Ten measures
  (19–23 and 35–39) are rest-only in the rendered score, and most of the
  alignment error sits in those spans. Not fixed here (see Task 1 notes).
- Decision: **GO for the next, separately approved step (a limited live
  canary)**, with the conditions listed in Task 4. This is not approval of
  that step, and it is not a validation of per-note timing.

## Task 1: the chain

| Step | Component (reused, not reimplemented) | Result on 2220 | Time |
|---|---|---|---|
| 1 | `build_visual_validation_corpus.build_corpus_entry` | 1 page, 48 measures, 3/4, 196 pitched notes in GT | 0.5 s |
| 2 | `page_omr_adapter.score_pages_with_page_omr` (production entry point) | source `page_omr`, no error, 48 measures, `time_signature=None`, `key_signature=None` | 6.1 s (includes model load) |
| 3 | `_ensure_model_loaded` / `_bytes_to_image` / `deskew_image` / `run_inference`, then music21 humdrum parse, MusicXML write, `partitura.load_musicxml().note_array()` | 196 notes; kern pitch content equals Step 2's read | 5.3 s |
| 4 | Basic Pitch via `score_conditioned_error_classifier.BP_PY` and `BP_SCRIPT` (subprocess) | onset matrix (25972, 88) | 3.6 s (predict 2.3 s) |
| 5 | `pa.AudioToScoreMatcher` (see defect below) | 196 `performance_time` values | 3.4 s (final config) |

Peak RSS for the full run: about 2.1–2.2 GB (`ru_maxrss`). Total wall time
about 45 s on this machine (includes a second Basic Pitch run and the
degenerate-input runs).

### Fixture confirmation

- MIDI: `musicnet_midis/Bach/2220_cs3-4sar.mid`
- Audio: `musicnet/train_data/2220.wav` (302.0 s, 44.1 kHz, stereo, averaged to mono)
- Labels: `musicnet/train_labels/2220.csv` (434 rows)
- Metadata: `2220,"Bach","Cello Suite 3","4. Sarabande","Solo Cello",...,302`
- Instrument string used: `Cello` (from `ensemble` = "Solo Cello")

## Defect found and fixed: Parangonar tempo bound

**Symptom (before fix).** `AudioToScoreMatcher()` with default settings on the
real pair returns 196 times with only 2 distinct values. 194 notes sit at
0.52 s, and the last note sits at 301.96 s. The output is monotonic, so an
ordering check alone would have passed it. Structural guard: degenerate.

**Root cause.** Matcher source (`parangonar/match/audio_matchers.py`): the
initial beat-period estimate is `audio_frames / score_beat_span`. For this
pair that is 302 s × 50 fps / 142 beats = 106 frames per beat, but the
default cap `max_bp` is 64 frames (1.28 s per beat). Independent tempo
evidence from MusicNet labels: 2.06 s per beat (29 bpm). The initial estimate
falls outside the tracked range, and the DP collapses.

**Fix (harness only).** `max_bp = max(64, audio_sec × 50 / score_beat_span)`.
The rule never goes below the default, so for the harp case (HARPSET 01,
initial estimate 37.6 frames) it resolves to 64 and behaves exactly as before.
Checked: for the harp clip the rule resolves to 64, identical to the default. The default run gives 45 notes, 0.04–25.48 s, 0 non-monotonic steps (same as the 2026-11-08 staging check).

**Honest caveats about the fix.**
- Before choosing the rule I ran three bounds (64, 100, 200) and printed
  label errors for each. The rule lands at 106.3, which behaves like 100. So the
  rule was chosen with some visibility into label error on this one piece.
  The rule is principled (it brackets the matcher's own initial estimate), but
  it has been tested on one piece only.
- The rule assumes the score covers the whole performance. On this fixture it
  does not (see Task 2 check 4), so the rule is an approximation here.

**Result (before → after).**

| Run | max_bp | Distinct times | Range (s) | Monotonic | Basic Pitch support (aligned vs shuffled null) | Structural degenerate |
|---|---|---|---|---|---|---|
| A (before) | 64 (default) | 2 | 0.52–301.96 | yes (flat) | 10.2% vs 10.2% | **yes** |
| B (after) | 106.3 | 192 | 0.54–301.96 | yes | 81.1% vs 19.4% | no |

## Task 2: structured object and property checks

Structured object: one entry per `note_array` row (196), fields `measure`,
`pitch_midi`, `pitch_name`, `score_time_beat`, `audio_time_sec`, `instrument`,
`wrong_note_finding`. Written as JSON to the run's scratch directory (not
committed). Every entry has `wrong_note_finding = "unavailable — not
independently validated"`. No wrong-note verdict is computed or borrowed.

| # | Check | Evidence | Result |
|---|---|---|---|
| 1 | Pitch and octave, page-omr vs independent GT, by measure + position | **196/196** pitched notes match. No measure has a different note count from GT. | PASS |
| 2 | Note ordering, `note_array` vs GT (sorted by absolute onset, then pitch) | Same 196-pitch sequence. First 10 `note_array`: C4 C4 A3 B3 B-3 B-3 G3 A3 D3 E3. First 10 GT: identical. | PASS |
| 3 | Measure numbering and mapping | GT numbers are sequential 1–48. Entry measures are verified against GT by (measure, beat in bar, pitch): **196/196**. Bar length is uniform at 3.0 beats across all 48 measures. 38 measures carry pitched notes. Measures 19–23 and 35–39 are rest-only in the Solo Cello track. This is recorded, not a numbering gap. | PASS |
| 4 | Score-time to audio-time mapping | Monotonic: **0 decreasing steps**. Range 0.54–301.96 s. Spot checks: idx 0 (beat 0.0, C4) → 0.54 s; idx 98 (beat 83.5, A2) → 171.84 s; idx 195 (beat 142.0, C2) → 301.96 s. | PASS |
| 4a | Cross-check vs MusicNet label onsets (same beat and pitch, 192 notes) | Median \|error\| **0.30 s**, p90 **4.12 s**, **18.8%** of notes over 1 s, 46.4% within 0.25 s. Uniform-tempo baseline with no audio: median 5.88 s, p90 8.12 s, 85.4% over 1 s. | Reported |
| 4b | Basic Pitch onset support | Aligned times: **81.1%** have an onset within ±0.1 s at the same pitch. Shuffled null: 19.4%. | Reported |
| 5 | Instrument metadata | All 196 entries `Cello` | PASS |
| 6 | No missing or duplicate mapping | 196 entries, 196 unique `note_array` indices, 0 duplicates | PASS |
| 7a | Per-note confidence signal | Matcher returns only `label`, `score_id`, `performance_time`. `return_everything=True` exposes DP internals (cost matrix, path), not a per-note confidence. **No confidence signal exists.** Limitation. `score_id` is the string `'None'` for every note, so mapping relies on list position. | INFO (limitation) |
| 7b | Deliberately mismatched audio, same final config | See table below. | All 3 flagged |

### Where the alignment error sits (check 4a, final config)

| Score beats | Measures | Median \|err\| | Share over 1 s |
|---|---|---|---|
| 0–47 | 1–16 | 0.12–0.13 s | 3% |
| 48–71 | 17–24 | **3.38 s** | **80%** (only 5 labeled notes in window) |
| 72–95 | 25–32 | 0.16 s | 0% |
| 96–119 | 33–40 | 0.27 s | 0% |
| 120–143 | 41–48 | 0.94 s | 49% (max 7.3 s) |

Most of the large error falls where the rendered score has rests (measures
19–23 and 35–39), so the matcher has no notes to anchor on. This is a
consequence of the fixture coverage gap, not evidence about the matcher on a
complete score.

### Task 2 item 7b: mismatched audio (structural guard is not enough)

| Case | Time | Range (s) | Structural guard | Basic Pitch aligned vs null | Flagged |
|---|---|---|---|---|---|
| Silence, 302 s | 4.5 s | 0.00–301.96 | **not flagged** (192 distinct, full span) | 0.0% vs 0.0% | yes |
| White noise, 302 s | 3.5 s | 0.00–301.96 | **not flagged** | 80.6% vs 69.3% | yes (gap < 30 points) |
| Different recording (MusicNet 2186, 214.4 s) | 2.1 s | 1.02–214.12 | **not flagged** | 6.6% vs 2.9% | yes (gap < 30 points) |

The harness flags a case if the structural guard fires, **or** if Basic Pitch
onset support does not show clear evidence (aligned ≥ 50% and at least 30
points above the shuffled null). The 30-point and 50% thresholds were set
before these cases were run. The white-noise case is flagged only because
its gap is small, and Basic Pitch fires on noise broadly. That is a weak
signal, not a clean separation.

## Task 3: one complete offline run and shape compatibility

- **Full chain ran end to end without crashing**, once for the final
  verification run (`OVERALL: PASS`), plus earlier runs during development.
- **Stubs:** none. Every generative or model call is real local inference
  (page-omr, Basic Pitch). Nothing was faked.
- **Shape check against `worker.py`** (read, not called). `dtw_align_to_score`
  takes a score dict of `measures[].number` (1-indexed) and
  `measures[].notes[].pitch` (note-name string or None). The page-omr output
  already has that shape. `find_wrong_note_candidates` takes aligned CREPE
  events with `midi`/`midi_raw`, `score_pitch`, and confidence fields, none of
  which this chain produces. **Not exercised, by design:** no call into
  `run_full_analysis`, `dtw_align_to_score`, or `find_wrong_note_candidates`.
  Those need CREPE events, Gemini, and Claude; a pure-local stub would not
  test the real contract.
- Results: page-omr numbering 1–48 sequential; (measure, pitch) pairs in the
  structured object equal page-omr's pitched notes (196 vs 196); pitch name to
  MIDI round trip holds for all 196 entries.
- `time_signature` is `None` in the page-omr output. `dtw_align_to_score`
  takes `beats_per_measure` from the caller, so a production caller would have
  to supply it. Noted, not fixed.
- Wrong-note literal: every entry carries
  `unavailable — not independently validated`. No detector is wired, imported,
  or converted. The output contains no wrong-note claim.
- Errors and uncertainty: a degenerate or mismatched alignment is flagged by
  the harness (structural guard and Basic Pitch evidence check). No crash.
- **Not claimed:** no Claude or Gemini coaching accuracy. No API was called.

## Task 4: decision

**GO for a next, separately approved, limited live canary.** This is a
decision that the chain is plausible enough to justify that step. It does not
approve or perform the step.

Conditions that must hold before any canary:
1. **Audio-evidence gate is mandatory.** The matcher returns plausible
   alignments for silence, noise, and a different recording. Any caller must
   run the Basic Pitch onset-evidence check and refuse to use an alignment
   that fails it.
2. **No per-note timing claims.** On this piece, about 19% of notes are more
   than 1 s off, with drift of 3–4 s in a rest-heavy span. The alignment
   supports coarse localization, not precise timing.
3. **Tempo bound must be re-derived per piece,** and only where the score
   covers the performance. The rule has been tested on one piece.
4. **Score coverage must be checked.** The page must contain the full
   performance. The Step 1 corpus builder keeps only the most-notes track, so
   the page here covers about 45% of notes (see below).
5. **`time_signature` must come from somewhere.** page-omr returns `None`, and
   `dtw_align_to_score` needs `beats_per_measure`.

Not a recommendation to deploy the experimental Basic Pitch wrong-note
detector, or to wire Parangonar into production. No production code changed.

## Known limitations and findings (not fixed)

- **Corpus builder keeps only one of four MIDI tracks.**
  `build_visual_validation_corpus.select_real_part` picks the track with the
  most notes. For 2220 that is "Solo Cello" (196 notes). The other three tracks
  hold 144, 68, and 26 notes. Together the four tracks hold 434 notes, the
  same count as the MusicNet labels (428 of 434 match on beat and pitch). The docstring claim that smaller tracks are "duplicated automation
  tracks" does not hold for this piece. Fixing it would change the validated
  visual corpus, so it is out of scope for this round and is logged for review.
- **Parangonar match is index-based.** `score_id` is `'None'` for every note,
  so the mapping from alignment output back to `note_array` depends on list
  order. Verified only by length and monotonicity, not by identity.
- **Single piece.** All numbers here are from one piece with one real
  recording. No generalization is claimed.

## Regression

`cd modal_worker && /Users/matthewwu/.cache/mediant_validation/venv/bin/python -m pytest --continue-on-collection-errors -q`

| Run | Passed | Failed | Errors |
|---|---|---|---|
| Recorded baseline | 296 | 5 | 1 collection |
| This round (BASE `f365b1c` + harness) | **296** | **5** | **1 collection** |

Failures are the same five in `test_visual_validation.py`. The collection
error is the `AttributeError` in `test_generate_timing_accurate_reference_audio.py`.
No new failures. The harness is not collected (not a `test_*` file).

## Files changed

- `modal_worker/local_e2e_integration_harness.py` (new)
- `agent_workspace/LOCAL_E2E_INTEGRATION_HARNESS_2026-11-08.md` (this file, new)
- `agent_workspace/AGENT_TASKS.md`, `agent_workspace/AUDIO_PIPELINE_AUDIT.md` (log entries)
- Not changed: `src/`, `worker.py`, `page_omr_adapter.py`
