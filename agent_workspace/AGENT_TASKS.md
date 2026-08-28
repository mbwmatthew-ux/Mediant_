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

- [x] **Trust model: the inline fallback no longer ships what the main path refuses.** `analyze-performance` falls through to an inline pipeline whenever the Modal dispatch fails, and that pipeline's trust model was the opposite of Modal's — it capped confidence where Modal deletes. Worst case was `runClaudeCoaching`: it never heard or saw the recording, read only the score, predicted "likely practice risks", and wrote them into `takes.flags` with `timestamp_start/end = 0` while the completion email said "Mediant found N areas to work on". That violated **PD-005** (every flag carries a measure AND a timestamp range) and its own prompt said "these are NOT performance errors". Now: when no path can analyse the actual recording the take is marked `failed` with a plain retry message (verified to reach the student through `job-status` → `NewRecordingModal`); `runClaudeCoaching` stays in the file marked DELIBERATELY NOT CALLED so it cannot be mistaken for live architecture; and the surviving fallback paths are visible in the UI as a gold "Reduced" / "Video only" banner driven by `analysis_quality`, which had been read into a dead variable for months. Build passes, lint unchanged (−1 error), worker 174/174 + 28/28 coverage unaffected. (2026-08-28)

- [x] **Analysis accuracy, part 2** — rhythm corroboration resolved (the earlier contradiction was instrumentation sampling the wrong one of ~24 invocations; real profile is [0,75,0,75], so corroboration now takes max(bar median deviation, bar roughness) against a 70 ms / 12%-of-a-beat floor). Also: wrong-note evidence string now names a distance matching the note it prints; ALL articulations read (accent+staccato no longer loses the staccato) and the dead "marcato"/"wedge"/"portato" strings replaced with ones the parser emits; part selection matches the declared instrument instead of taking the first part; release detection tolerates an 80 ms mid-note dip instead of truncating on vibrato/slurs; drift reference falls back to the piece fit when the opening is not steady; bare "Saxophone" no longer silently resolves to alto; ~108 lines of dead tier code deleted; dropped unconfirmed findings recorded to pipeline_debug so the gate's false-positive rate is finally measurable; repeats detected and warned. Fixtures gained a flat-key score in music21 spelling. 171/171 unit checks, 28/28 coverage, every fix red-green verified. (2026-08-23)
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

- [ ] **Delete `src/pages/Record.jsx`.** 930 lines, unrouted (`/record` → `/home`) and imported nowhere; the live upload path is `NewRecordingModal.jsx`. Two docs described it as the main entrypoint until 2026-08-26. It also carries a 4-minute poll loop that sits below the 6-minute job-status self-heal floor, so it is a live bug waiting for anyone who re-routes `/record`. Deleting it is the cheapest way to stop it misleading readers.
- [ ] **Drop Audiveris from the Modal image, or wire it up.** `convert_visual_score_to_musicxml` has zero call sites; visual scores go to `read_score_notes_claude` instead. The image still curls + installs Audiveris 5.10.2 on every build. Removing it speeds up builds; wiring it in would give real OMR for photo scores. Either is fine — the current state is paying for it and not using it.

- [ ] **K-weight the loudness measurement (ITU-R BS.1770).** Now that loudness is measured over the note body, the remaining error is perceptual: raw dBFS treats a low chalumeau note and a high clarion note at the same amplitude as equally loud, which they are not. `pyloudnorm` (MIT, v0.2.0, needs only scipy+numpy — both already in the image) designs correct K-weighting biquads at 22050 Hz. Verified API: `pyloudnorm.Meter(22050)._filters` yields `high_shelf` and `high_pass` IIRfilters with `.b`/`.a` coefficients — apply once to the whole signal with `scipy.signal.lfilter`, then take per-note RMS on the filtered signal. Do NOT use `Meter.integrated_loudness` per note: its 400 ms block size is longer than most notes. Caveat: `_filters` is a private attribute; the public `IIRfilter(G, Q, fc, rate, filter_type)` can build the same two filters from the BS.1770 constants. **Needs real audio to validate** — deferred for that reason, not for difficulty.
- [ ] **Expand repeats in the score parse.** Detection + a loud warning now ship (`has_repeats`), but expansion does not. A repeated strain appears once in the note list and twice in the audio, so DTW folds ~2x the events onto the written notes and everything after the repeat is offset. Design is settled: music21's `expandRepeats()` PRESERVES printed measure numbers (verified — 1,2,3,4 with a repeat over 1-2 becomes 1,2,1,2,3,4), so flags would still name what the student sees. The blocker is that a measure number then appears twice at different times, which `build_measure_timeline` and Loop windows assume cannot happen; `flatten_score_notes` would also need `abs_beat` to follow play order rather than measure number. Needs a real repeat-containing take to validate Loop behaviour.
- [ ] **CREPE Notes (arXiv 2311.08884) for note segmentation.** A method, not a dependency: turns the existing frame-level CREPE contour into discrete note events with onsets/offsets. Would directly improve every per-note duration and hold-time claim. No licence cost, no new model.
- [ ] Mobile-friendly dashboard view
- [ ] Coaching tone preference setting (user selects "strict" / "encouraging")
- [ ] Compare two takes side by side in the thread
- [ ] Export analysis summary as PDF
- [ ] Email digest of weekly progress
- [ ] Sheet music annotation layer (highlight flagged measures directly on the score image)
- [ ] Onboarding flow for new users
- [ ] Multi-page sheet music: AI reads/annotates every page, not just page 0. Upload + storage + Analysis-page pagination already ships (2026-08-12) — `takes.score_paths`, upload modal `multiple` file input, prev/next arrows. What's missing is the Modal worker (`read_score_notes_claude`) sending all page images to Claude in one vision call, a `page` field per measure in `measure_layout`, and `score_cache` rekeyed off the full path array instead of one path. See `Fixes/Fix — Multi-page sheet music (score_paths).md` in the Obsidian vault for the full breakdown.
