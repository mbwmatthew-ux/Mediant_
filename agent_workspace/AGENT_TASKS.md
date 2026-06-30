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

- [ ] Mobile-friendly dashboard view
- [ ] Coaching tone preference setting (user selects "strict" / "encouraging")
- [ ] Compare two takes side by side in the thread
- [ ] Export analysis summary as PDF
- [ ] Email digest of weekly progress
- [ ] Sheet music annotation layer (highlight flagged measures directly on the score image)
- [ ] Onboarding flow for new users
