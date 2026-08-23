# Agent Tasks — Mediant

AFTER EVERY CHANGE, WHEN APPROPRIATE, MAKE SURE TO UPDATE THIS FILE

Last updated: 2026-06-30 (evening)

---

## Current Goal

**Build the song-thread model and make the analysis view feel cohesive.**

Each song should have one persistent thread. The user uploads a recording, sees analysis with Loop tied to specific flags, asks the AI coach follow-up questions, and comes back later to upload another take. The second take compares against the first. This thread never resets. 

---

## Approved Tasks

_Nothing pending — all approved tasks have been completed._

---

## In Progress

_Nothing active._

---

## Needs Review

- [ ] **Settings — live backend check.** Visual + lint verified, but the functional controls (profile save, password change, email change) call `supabase.auth.updateUser` and could only be confirmed in-browser with placeholder Supabase keys. Re-test password/email/profile saves once real project credentials are in `.env` and a user is logged in.

---

## Completed

- [x] **Analysis accuracy: three reported defects traced to root cause** — (a) `midi_from_name` mis-parsed music21's flat spelling (`"B-4"` -> -25 instead of 70), corrupting most of the score on flat-key pieces and warping DTW alignment around every flat note; this alone drove phantom rests, wrong-note false positives AND bad timing flags. (b) The placement "median" took the upper element on even lists, systematically over-reporting dragging and under-reporting rushing. (c) Squeaks reached the wrong-note detector (22 Aug regression). (d) Gemini wrong-note claims were confirmed by unrelated crack evidence. (e) The "N-beat rest after it" text asserted rests the pipeline has no data for; coach prompt gained a ban on inventing notation. (f) Tempo fit gained a goodness-of-fit gate measuring roughness, not spread. 151/151 unit checks, 28/28 coverage. (2026-08-23)
- [x] **Loudness measured over the note body, not the attack** — every note's loudness and timbre were measured over a fixed 100 ms window from the onset, i.e. the attack transient. That put articulation inside every dynamics verdict: a hard-tongued *p* can out-peak a slurred *f*, so `analyze_dynamics_vs_score` could report "no contrast" or an inversion on passages with real contrast. New `note_body_window()` trims the attack, caps at 500 ms, takes the middle of the note, and never bleeds into the next onset. Breath-noise gate deliberately left on the old attack window so event *selection* is unchanged. Also fixed a one-sample window for notes starting near the end of the buffer (the last note of every take). torch/torchaudio/torchcrepe gained major-version ceilings. 142/142 unit checks, 28/28 coverage. (2026-08-23)
- [x] **Timbre analysis + clarinet squeak fix** — Events now carry `centroid_hz`, `flatness`, `centroid_ratio`; the worker previously had no spectral analysis at all. Clarinet 12th-harmonic suppression no longer deletes register-break squeaks (it consults timbre, keeps squeak-shaped events, tags them `squeak_suspect`). Crack-vs-wrong-note confirmation no longer substring-matches Gemini's prose — it confirms against both detectors. `find_crack_candidates` gains an airy/split-note branch needing no pitch jump. 131/131 unit checks, 28/28 coverage. (2026-08-22)
- [x] **Teacher dashboard UI** — `/teacher` route with student list, invite-by-email, per-student take list, and full ✓/✎/✗/+ annotation controls on flags. Calls `teacher-students` and `annotate-flags` edge functions. (2026-06-30)
- [x] **Signup role selection** — "I am a…" Student/Teacher toggle on signup form. Teachers are written to `profiles.role` and redirected to `/teacher` after signup. (2026-06-30)
- [x] **Annotation UI on Analysis page** — When logged-in user is a teacher, each flag card shows inline ✓/✗/✎ buttons with reject-reason picker and edit form. Loads/saves via `annotate-flags`. (2026-06-30)
- [x] **Reference MIDI upload UI** — Optional MIDI section on Record page. After analysis completes, uploads `.mid` to `reference-midi` bucket and writes to `reference_performances` linked to the song. (2026-06-30)
- [x] **Teacher nav item** — "Students" link in AppShell sidebar, shown only when `profile.role === 'teacher'`. AuthContext now fetches and exposes the full `profile` row. (2026-06-30)
- [x] **Reference MIDI alignment** — `dtw_align_to_reference()` in `worker.py`. When a reference MIDI exists for a song, the pipeline uses it as the primary alignment source (more accurate than score DTW because it carries real timing). Falls back to score DTW → beat-grid → tempo anchor as before. (2026-06-30)
- [x] **Teacher-student backend** — DB migrations for `profiles`, `teacher_students`, `flag_annotations`, `reference_performances`; edge functions `annotate-flags` and `teacher-students` fully implemented. (2026-06-30)
- [x] **Pipeline debug logging** — Every take now writes `pipeline_debug` (list of step summaries) to the DB. If Modal fails, the Modal dispatch error is also written immediately. This makes diagnosing audio analysis failures possible without reading server logs. (2026-06-30)
- [x] Settings rebuilt as tabbed layout (Account / Security / Privacy / Billing). Security: change password, change email (both functional), 2FA frame. Privacy: accurate data-handling copy, real cache-clear, export + delete-account frames. Billing: plan card, Stripe-managed payment display, sample invoice history. Warm theme preserved in light + dark. (2026-06-16)
- [x] Full webapp UI redesign: AppShell, Home, Library, Record, Analysis, Progress, Settings, Auth pages + Landing page (2026-06-14)
- [x] Song-thread data model: `songs` table, `song_id` FK on takes, persistent `chat_history` per song (2026-06-14)
- [x] Loop scrubbing: timestamp is a seek button, gold progress bar while looping, active Loop button styled gold (2026-06-14)
- [x] Refactored thread tab strip into a premium full-bleed top navigation bar with rounded score badges (2026-06-09)
- [x] Landing page hero logo centering (padding-left: 50px on `.heroLogoLarge` to compensate for PNG canvas offset)
- [x] Analysis page redesign — timeline UI, WaveformTimeline component, Session Summary tab
- [x] AI coach chat bug fixes (alternating message ordering, history trimming)
- [x] CORS fixes for Supabase edge functions

---

## Backlog

_Ideas that are not yet approved. Do not implement these until they move to Approved Tasks._

- [ ] **K-weight the loudness measurement (ITU-R BS.1770).** Now that loudness is measured over the note body, the remaining error is perceptual: raw dBFS treats a low chalumeau note and a high clarion note at the same amplitude as equally loud, which they are not. `pyloudnorm` (MIT, v0.2.0, needs only scipy+numpy — both already in the image) designs correct K-weighting biquads at 22050 Hz. Verified API: `pyloudnorm.Meter(22050)._filters` yields `high_shelf` and `high_pass` IIRfilters with `.b`/`.a` coefficients — apply once to the whole signal with `scipy.signal.lfilter`, then take per-note RMS on the filtered signal. Do NOT use `Meter.integrated_loudness` per note: its 400 ms block size is longer than most notes. Caveat: `_filters` is a private attribute; the public `IIRfilter(G, Q, fc, rate, filter_type)` can build the same two filters from the BS.1770 constants. **Needs real audio to validate** — deferred for that reason, not for difficulty.
- [ ] **Replace the 55 ms rhythm-corroboration threshold** (`worker.py`, the `timing_conf_measures` fallback). It confirms a Gemini rhythm claim from any single note whose RAW residual exceeds 55 ms — below this pipeline's own onset noise (23 ms librosa grid, 50 ms candidate dedupe, synthetic probes injected every 350 ms inside sustained notes), computed on un-de-trended residuals whose anchor makes the first note's own error a global constant. It is effectively a pass-through. **Attempted 2026-08-23 and reverted:** three successive statistics (median deviation, then median-or-roughness, then tempo-scaled floors) each broke the `Gemini rhythm observation` coverage case, and an isolating probe showed the OLD rule would not fire on the same residuals — which contradicts the bisect showing the old rule restores the case. That contradiction is unresolved and means the mental model of this path is wrong. Do not re-attempt from code reading alone: instrument a real take, dump `timing_report["notes"]` for the claimed measure, and find out what actually populates `timing_conf_measures` there first.
- [ ] **Add accidentals to the test fixtures.** `test_analysis.py` stubs music21 and every fixture pitch is a natural, which is why a parser that destroyed every flat in every MusicXML score passed 121/121 for months. Fixtures should carry sharps, flats, music21's `-` spelling, and double accidentals. See `Fixes/Fix — music21 flats parsed as negative octaves.md`.
- [ ] **Repeats are never expanded.** No `expandRepeats` anywhere in the parsing path; a repeated strain appears once in the score sequence but twice in the audio, so DTW must fold ~2x the events onto the written notes and everything after the repeat is systematically offset.
- [ ] **`parse_musicxml` picks the first part with notes, not the student's instrument.** Upload a full score or piano+solo PDF and the entire comparison runs against a different line.
- [ ] **CREPE Notes (arXiv 2311.08884) for note segmentation.** A method, not a dependency: turns the existing frame-level CREPE contour into discrete note events with onsets/offsets. Would directly improve every per-note duration and hold-time claim. No licence cost, no new model.
- [ ] **Delete the dead Tier B subsystem** (~200 lines). `_cross_check_gemini_tier_b`, `build_gemini_block`, `_group_similar_flags`, `_UNCONFIRMED_MULT` and the unreachable `confidence: 74` branch all have zero call sites. They are the best-commented description of tier gating in the file, so they read like the live architecture and have already produced one confidently wrong explanation of how the pipeline works.
- [ ] **Persist dropped-unconfirmed flags as diagnostics.** The `_UNCONFIRMED_MULT` calibration plan (query accumulated `confirmed` data after 20+ analyses) is impossible as built: the filter at `worker.py:4810` deletes every `confirmed=False` flag before anything is written, so the query returns 100% confirmed forever. Keep the user-facing delete exactly as-is; write the dropped ones to a diagnostics field so the gate's false-positive rate becomes measurable.
- [ ] Mobile-friendly dashboard view
- [ ] Coaching tone preference setting (user selects "strict" / "encouraging")
- [ ] Compare two takes side by side in the thread
- [ ] Export analysis summary as PDF
- [ ] Email digest of weekly progress
- [ ] Sheet music annotation layer (highlight flagged measures directly on the score image)
- [ ] Onboarding flow for new users
- [ ] Multi-page sheet music: AI reads/annotates every page, not just page 0. Upload + storage + Analysis-page pagination already ships (2026-08-12) — `takes.score_paths`, upload modal `multiple` file input, prev/next arrows. What's missing is the Modal worker (`read_score_notes_claude`) sending all page images to Claude in one vision call, a `page` field per measure in `measure_layout`, and `score_cache` rekeyed off the full path array instead of one path. See `Fixes/Fix — Multi-page sheet music (score_paths).md` in the Obsidian vault for the full breakdown.
