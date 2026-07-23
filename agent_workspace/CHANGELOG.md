# Changelog — Practapal (formerly Mediant)

## 2026-07-21e — Frontend loop had its OWN duplicate 3s-minimum padding bug

After 0ebac50 fixed the backend's over-padding, the loop still spilled into one extra unmarked measure (e.g. flag says "measures 20-22", audio also played 23). Root cause: `src/pages/Analysis.jsx`'s loop effect had a SEPARATE, frontend-only `MIN_LEN = 3` (3 seconds) floor in `resolveWindow()` — the same class of bug as the backend one, just duplicated on the client. A short passage (fast tempo or few measures) whose true duration was under 3s got stretched forward to 3s regardless of what the backend had already computed as the exact boundary.

- Removed the 3s floor; `resolveWindow()` now trusts the backend's own timestamp_start/timestamp_end as authoritative (it already has its own ~1s audibility floor) and only clamps to the real recording duration, with a negligible 0.3s guard against a literal zero-length window.
- Tightened the loop-back boundary check from the browser's `timeupdate` event (fires ~4x/sec, so playback could overshoot the end by up to ~250ms before being caught) to a `requestAnimationFrame` poll (~60x/sec) — the loop now snaps back within a few milliseconds of the true boundary instead of up to a quarter-second late, which for a short passage was enough to spill into the next measure.

## 2026-07-21d — Loop no longer bleeds into measures not mentioned in the flag

Regression from the previous loop fix (a2567cb): after switching the loop window to `measure_to_time_range()` (the exact inverse of the measure-label math), I still padded it with `max(est_measure_sec * span_measures, natural_len)`. `est_measure_sec` is a coarse GLOBAL estimate (median CREPE range duration, or a generic tempo fallback, clamped [1.2, 8.0]) — whenever it was larger than the true, precise duration of the specific labeled measure(s) (which `measure_to_time_range` already computes correctly), the loop got stretched past the measure's real end into neighboring measures the flag never mentions. This is exactly what "loop plays the wrong section" / "includes other measures not marked in the issue" was.

- Removed the `est_measure_sec`-based padding entirely. `measure_to_time_range`'s own output is now trusted as authoritative — it's already derived from the same tempo/anchor math as the label, so it's already correct.
- Replaced it with a tiny 1.0s absolute audibility floor (only extends a window that's pathologically short, e.g. a single measure at a very fast tempo) — this can add at most ~1s, never several seconds like before.
- Verified: a single measure at 180bpm (true duration 1.0s) now loops for exactly 1.0s with zero overrun (previously would've padded up toward the global estimate). A realistic 21-flag multi-issue scenario at 120bpm shows every single-measure loop at ~2.1s (matching the true ~2.0s/measure), none inflated.

## 2026-07-21c — Flag title and coaching body no longer cite different measures

Bug: a flag's title said "M.25" but its coaching body talked about "measure 28" and told the student to practice "measures 27 through 29". Cause: Claude writes the coaching title/body from Gemini's raw free-text `description`, and that text can contain GEMINI'S OWN (uncorrected) measure number — separate from the canonical measure we compute from the timestamp for the label/loop. The label was right; the body was quoting Gemini's wrong number straight out of the source text.

- Added `_canonicalize_measure_refs()`: rewrites every "measure N" / "m.N" / "measures N-M" / "measures N through M" reference inside an issue's `observed` text to the canonical measure(s) actually assigned to that flag, before it's ever shown to Claude. No-op for text that already cites the right number (e.g. our own CREPE-generated strings).
- Coaching prompt also now states explicitly that the given location is verified/authoritative and instructs Claude to ignore any differing number in the observed text.
- The issue location shown to Claude now includes the measure_end range (was single-measure only), so it can't lose track of a passage's span either.
- Verified: an issue whose Gemini description says "measure 28" / "measures 27 through 29" but whose canonical measure is 43 (or any other value) now has 100% of measure references in the coaching body rewritten to the canonical number — reproduced the exact screenshot scenario and confirmed the wrong numbers no longer appear.

## 2026-07-21b — Loop audio no longer disagrees with the measure label

Bug: the measure number shown on a flag could differ from what actually played when you hit Loop. Root cause: the loop's time window was built from the raw Gemini event timestamp plus a fixed 3.5s pad (and, for the no-timestamp path, could pad BACKWARD past the measure's start) — completely independent of the same-named measure boundaries used to derive the label. At normal/fast tempos (measures well under 3.5s) the loop routinely spilled into neighboring measures.

- Added `measure_to_time_range(m0, m1)` — the EXACT inverse of `time_to_measure`, using the identical priority tiers (two-point anchor → uniform tempo grid → beat count → alignment ranges → proportional) and the same closure state, so label and audio are two views of one mapping instead of two independently-computed values.
- Replaced `resolve_loop_range` (ad-hoc, backward-padding, fixed 3.5s floor) with this inverse function. The loop's start time is now always the labeled measure's true start; only the END may extend forward (never backward) when a measure is naturally short, capped at roughly one measure's estimated duration instead of 3.5s.
- Fixed the two-point anchor tier to use floor instead of round, matching the other tiers and making it exactly invertible (round() could disagree with its own inverse by up to half a measure).
- Verified: 20,000 random-timestamp probes against both the two-point and tempo-grid tiers — 0 invertibility failures (every timestamp's measure, when converted back to a time range, contains the original timestamp).

## 2026-07-20j — Reactive end-measure correction + trailing-silence anchor

- Self-corrects a small end-measure slip (e.g. user types 23 when they played to 24). Compares the user's `end_measure` against two independent estimates — the beat grid at the last playing moment, and Gemini's relative span. Overrides ONLY when both estimates agree with each other (within 1) and differ from the user by 1-2 measures. Large disagreements (e.g. beat-grid drift) never override the user.
- Two-point map now anchors the end to the last PLAYING moment (`anchor_time`), not the full recording duration — trailing silence no longer pulls the final note short of the end measure.
- Verified: user=23 → corrected to 24 (grid & Gemini agree); user=24 kept; user=37 kept even when the beat grid drifts to ~32; final note lands exactly on the end measure despite 2s of trailing silence.

## 2026-07-20i — Two-point measure anchoring (end measure was too low)

Piece ended at m.37 but analysis said m.32 — the tempo/beat grid under-counted because the estimated tempo was a bit low, stretching measures. Any single-anchor mapping (start only + tempo) is vulnerable to tempo/meter error.

- `time_to_measure` now prefers an EXACT two-point linear map: `[0, duration] → [start_measure, end_measure]`. Immune to tempo/meter estimation error; exact at both ends.
- End anchor priority: (1) user-provided `end_measure`; (2) estimate from Gemini's relative span — its absolute numbers may be offset but the gap between its first and last reported measure equals the true measure count, so `end ≈ start + (gemini_max − gemini_min)`; (3) fall back to tempo grid / beat count.
- Frontend: added an "End measure" field to `NewRecordingModal` (Record.jsx already had one). Edge function already mapped `endMeasure → end_measure`, so no edge change.
- Verified: start=20, last note at end → m.37 both with user end=37 and via Gemini-span estimate.

## 2026-07-20h — Fix measure drift toward the end (m.32 shown as m.37)

Measures were right early but ran too high by the end. The beat-grid mapping counted individual detected beats, and beat trackers over-detect in fast passages (sixteenth-note runs) — the extra beats accumulate, so late measures inflate.

- `time_to_measure` now uses a UNIFORM grid from the global tempo: `measure = start_measure + floor(t / (beats_per_measure * 60 / tempo_bpm))`. No spurious-beat accumulation, so the end measure stays correct. Falls back to beat-count, then alignment ranges, then proportional.
- Intonation flags now use the SAME mapping (from each event's timestamp) and anchor their loop on that timestamp — keeps CREPE and Gemini flags from drifting apart.
- Verified: start=20, 120bpm/(4/4), issue at 0:24 → m.32 (correct); raw beat-count would have drifted to ~35.

## 2026-07-20g — Fix "All Gemini models failed: empty response"

gemini-2.5 flash/pro are thinking models; thinking tokens count against maxOutputTokens. The heavy "examine every measure" prompt made them spend the entire 16384-token budget thinking and return an empty response (finishReason MAX_TOKENS) — both models failed → analysis failed.

- `generationConfig.thinkingConfig.thinkingBudget`: 0 for flash (disable thinking), 512 for pro (its minimum). Reserves the token budget for the actual JSON, and speeds up generation.
- Per-model fallback config: if `thinkingConfig` is rejected (400), retry that model without it at maxOutputTokens=40000 so thinking + JSON both fit.
- Empty-response handling: also accept a text part even if flagged as thought, and log `finishReason` + `usageMetadata` for diagnosis. Timeout 120s → 150s.

## 2026-07-20f — Measure numbers from the beat grid (stop trusting Gemini's photo reading)

Measure numbers were still wrong because we trusted Gemini's reading of printed numbers off a phone photo — fundamentally unreliable. Switched to a deterministic source.

- `compare_and_coach_claude` now derives every measure from the **beat grid**: `time_to_measure(t)` = `start_measure + (beats elapsed by t) // beats_per_measure`, using the CREPE `beat_times` and the same `bpm_int` CREPE uses. Deterministic, monotonic, anchored at the student's real start measure, and consistent with CREPE-numbered intonation flags. Gemini's own measure number is now only a fallback when an issue has no timestamp.
- Passage `measure_end` likewise derived from the end timestamp.
- Gemini's timestamp remains the trusted signal (it watched the video); its measure reading is no longer relied upon.
- Speed: removed the heavy "re-verify each measure number against the score" instructions from the Gemini prompt (no longer needed since we compute measures ourselves) — less model thinking, faster analysis.
- Verified: start=20, Gemini reports m.12/99/5 with correct timestamps → beat grid yields m.20/24/30.

## 2026-07-20e — Start-measure offset (analysis labeled measures too low)

Student set start measure = 20, but every flag came out ~8 measures too low (m.12 etc.). Cause: when a score image is provided, the Gemini prompt told it to read printed measure numbers but never said WHERE the recording starts — so Gemini assumed the top of the page and counted from there.

- Gemini prompt (has_score branch, now an f-string): explicitly states the recording BEGINS at measure `{start_measure}`, the first heard note is that measure, and no reported measure may be below it.
- Worker safety net: `compare_and_coach_claude` now takes `start_measure`; if Gemini's minimum reported measure is below it, shift ALL Gemini measures up by the offset (its relative spacing is right, only the base is wrong). Verified: start=20 + Gemini m.12/12-19/16 → m.20/20-27/24.

## 2026-07-20d — THE loop bug: inline ref callback re-seeking every render

The real cause of "loop is cut / very short / just wrong." Each flag's `<video>` used an **inline** `ref={el => { videoRef.current = el; el.currentTime = f.timestamp_start }}`. React re-invokes inline ref callbacks on **every render** (null, then the node). The loop effect called `setCurrentTime(t)` on every `timeupdate` (~4x/sec) → a render each time → the ref callback re-ran → `el.currentTime = timestamp_start` **yanked the video back to the flag start ~4x/sec**. The video never played more than a fraction of a second — and passages never progressed.

Fixes (`src/pages/Analysis.jsx`):
- Both `<video>` ref callbacks now **guard on node identity** (`if (!el || el === videoRef.current) return`) and seek only on a genuinely new node, via `loadedmetadata` — so re-renders no longer reset playback.
- Removed the `setCurrentTime(t)` call in the loop's `timeupdate` handler (the state was never read anywhere — pure render churn that drove the ref re-fire).
- Kept the earlier `ended`-handler + duration-clamp loop hardening.

**Gotcha:** never do side effects (especially `currentTime =`) in an inline ref callback that lives in a frequently-re-rendering subtree — it runs every render. Guard on node identity or use a stable/`useCallback` ref.

## 2026-07-20c — Loop fixes (too short + passages broken)

Loops were "very short" and passage loops didn't work at all. Two causes:
1. **Gemini timeline overrun** — Gemini sometimes reports timestamps past the real end of the recording (its tempo sense drifts). Late issues + passages got clamped to a broken ~2s sliver at the end.
2. Loops were too short (2s min < one measure) and the frontend player didn't handle a loop that reaches the end of the file.

Fixes:
- **Worker:** if Gemini's max timestamp exceeds the true duration, rescale its whole timeline proportionally back onto the recording (`piece_len / max_ts`). Min loop length 2.0 → **3.5s**; passages span their full range; `resolve_loop_range` min also 3.5s.
- **Frontend (`Analysis.jsx` loop effect):** clamp the loop window to the real duration (`video.duration`, falling back to stored `duration_seconds` for webm files that report `Infinity`), enforce a ≥3s window, and add an `ended` handler so a loop that reaches the end of the file seeks back instead of stopping (fixes passage loops).
- Verified: a 60s recording with a Gemini timeline running to 2:40 rescales correctly — all loops land inside the recording, ≥3.5s, ending passage at 53–60s.

## 2026-07-20b — Measure-range flags (mark whole passages)

Flags can now span a range of measures (e.g. "Measures 23–27") or the entire piece, not just one measure.
- Gemini schema/prompt: each issue may include optional `measure_end` + `time_end` for sustained passages; instructed to use a range when a problem persists across measures (up to the whole piece).
- Worker carries `measure_end`/`time_end_sec` through the canonical issue → flag, resolving the end measure the same way as the start (trust Gemini when reliable, else derive from the end timestamp).
- Loop window spans the whole passage: uses `time_end` when present, else extends by `est_measure_sec × span`. Single-measure issues unchanged (~2s).
- Frontend already supported `measure_end` (renders "Measures 23–27" in flag tag, list, and chat summary) — no UI change needed.
- Verified: passage m.23–27 → 20s loop; whole-piece m.1–40 dynamics → 160s loop; single measure → 2s, no range.

## 2026-07-20 — Whole-piece coverage (examine every played measure)

User wants every played measure examined and ALL issues surfaced (issue-only list, no "clean" rows).
- Gemini prompt rewritten to walk the recording **measure by measure** from first to last played measure, checking all 7 categories per measure, and to expect 10-20+ issues (not condense to a few).
- Gemini `maxOutputTokens` 8192 → **16384** so it can return many issues.
- Coaching call: coach up to **40** issues (was 16), `max_tokens` 8000 → 16000.
- Flag cap 14 → **40**.
- **Grouping disabled** — every measure with an issue is its own row (was collapsing recurring intonation/timing into "Recurring — N passages" headers, which hid coverage). Matches the per-measure list the user asked for.
- Verified: a 30-measure scenario yields 32 individual flags spanning m.1–29 with distinct loops across the whole recording, multiple issues per measure.

## 2026-07-18b — Timestamp-anchored placement (fix "everything on m.20")

Symptom after the Gemini-first rewrite: every flag showed on measure 20 and all loops played the same spot. Cause: Gemini frequently misreads printed measure numbers off the score photo and stamps every issue with the same (usually last) measure — then dedup by (measure, type) collapsed each category to one flag and every loop resolved to the same measure.

- **Placement now anchors on Gemini's timestamp, not its measure number.** New `time_to_measure()` maps each issue's "M:SS" to a measure via CREPE ranges (where accurate) or proportional distribution across the recording. Loops are built directly from the timestamp, so each issue gets a distinct, correct clip.
- **Reliability gate:** if Gemini reports a healthy spread of distinct measures, those are trusted as-is; only when its measures are clustered/degenerate do we derive the measure from the timestamp.
- **Degenerate-response repair:** if Gemini collapses everything onto one measure AND one timestamp, issues are distributed evenly across the recording by order.
- `time_to_measure` assumes the piece starts at measure 1 when the score parse is incomplete, so the "all last-measure" case still spreads.
- Stronger Gemini prompt: timestamps must be real, distinct, and span the whole recording; don't pile issues on one measure.
- Added diagnostic logging of Gemini's raw distinct-measure / distinct-timestamp counts.
- Verified with 3 scenarios (all-m20+varied-ts, fully degenerate, healthy-varied): issues spread across the piece with distinct loops; reliable measures preserved.

## 2026-07-18 — Analysis Coverage Rewrite (Gemini-first flags)

### Root problem
Analysis only surfaced ~5 issues clustered on 2-3 spots, loops played a single note, and second-half feedback vanished. Cause: the whole flag pipeline was gated on sparse CREPE alignment, and Claude acted as a funnel that dropped most of Gemini's findings.

### Fix — `modal_worker/worker.py` `compare_and_coach_claude` restructured
- **Gemini is now the primary flag author.** Note errors, timing, dynamics, tone, posture, and technique become flags **directly** from Gemini's structured output — one flag per reported issue. CREPE owns **intonation** (precise cents) and corroborates note/timing.
- **Claude no longer selects issues** — it only writes the coaching title + body for the fixed canonical list (indexed round-trip, template fallback if it drops any). It can't shrink coverage anymore.
- **Loops are passage-length**, anchored to Gemini's per-issue timestamp (new `parse_mmss_to_seconds` + `resolve_loop_range` with CREPE-range → Gemini-time → proportional fallback). No more single-note loops, no more snapping flags onto the few CREPE-aligned measures.
- **Partial score parses no longer drop second-half feedback** — Gemini flags beyond the parsed range are kept; `validate_gemini_measures` only rejects measure ≤ 0.
- **Grouping restricted** to intonation/timing (directional themes); wrong notes, dynamics, tone, posture, technique stay as distinct flags so each shows individually. Cap raised 12 → 14.
- `read_score_notes_claude` uses compact note field names so long scores fit the 8192-token budget.
- Verified with a synthetic 20-measure scenario (partial parse + cross-piece Gemini issues): flags now span m.1/3/9/14/18, all loops ≥2s, posture kept, "not visible" technique dropped.

## 2026-07-13 — Analysis Speed + Reliability Fixes

### Analysis pipeline parallelization
- CREPE audio analysis, Gemini video upload/eval, and score download now run **concurrently** with `ThreadPoolExecutor(max_workers=3)` in Modal worker
- Saves ~30-60 seconds per analysis by overlapping CREPE (~30-40s) with Gemini upload+poll (~60-90s) instead of running sequentially
- Deployed as Modal app version bump

### Analysis reliability fixes
- Fixed `FunctionsFetchError: Failed to send a request to the Edge Function` — switched all `supabase.functions.invoke()` calls to raw `fetch()` in `NewRecordingModal.jsx` and `Analysis.jsx`
- Fixed `Failed to fetch` / connection drop — edge function now returns in <1s after DB insert; all heavy work moved to `EdgeRuntime.waitUntil()` background task
- Fixed **Modal dispatch 404** — URL was `${modalUrl}/analyze_async` (wrong); changed to `${modalUrl}` (root path per `fastapi_endpoint`)
- Extended frontend polling from 60×4s (4 min) to 120×5s (10 min) — allows `job-status` self-heal to trigger and Modal to finish
- Improved error messages: upload failures show `Upload failed: <reason>` instead of generic error; timeout message now says "check back in a moment" rather than "try a shorter recording"

---

## 2026-07-01 — $7 Unlimited Plan, Score Caching, AI Practice Calendar

### Pricing
- Single **Mediant plan: $7/mo ($5/mo billed yearly)** replaces the two-tier model
- Unlimited recordings, full AI coaching, all features — no caps

### Cost optimizations (makes unlimited profitable)
- Switched Claude Sonnet → **Haiku 4.5** for score reading and coaching — 3-5× cheaper
- **Score caching**: parse PDF/image once, store in `score_cache` table, skip Claude call on repeat submissions → repeat analysis cost ~$0.018
- Gemini 2.5 Flash retained for audio (non-negotiable quality tier)

### AI Practice Plan
- After every completed analysis, Haiku generates a **5-day structured practice plan** from the flags
- Stored in `takes.practice_plan` JSONB
- Wired in `analysis-webhook` (Modal path) and `analyze-performance` (fallback path)

### Calendar page rebuilt
- Upcoming days show AI practice plan tasks (amber highlight + label + minute count in cell)
- Plan banner above calendar with one-sentence weekly summary
- Detailed day-by-day plan panel below grid with task cards (today highlighted, past days dimmed)

### DB migrations (apply in Supabase dashboard)
- `supabase/migrations/20260701_create_score_cache.sql`
- `supabase/migrations/20260701_add_practice_plan_to_takes.sql`

---

## 2026-06-30 — Teacher Features: Dashboard, Signup Role, Annotation Controls, MIDI Upload

### Teacher Dashboard (`/teacher`)
- New page with student list (active / pending), invite-by-email form, per-student take list
- Expand a take to see all AI flags with ✓ Approve / ✗ Reject / ✎ Edit / + Add controls
- Reject opens inline rejection-reason picker (6 options); Edit opens inline text fields
- All actions call `annotate-flags` edge function; annotations reload on each take open
- Non-teacher accounts see a "Teacher accounts only" guard screen

### Signup Role Selection
- "I am a…" Student/Teacher segmented toggle on the signup form
- Teacher accounts are written to `profiles.role` after signup
- Teachers redirect to `/teacher` automatically after account creation

### Teacher Nav Item
- "Students" link added to AppShell sidebar, visible only to `profile.role === 'teacher'`
- `AuthContext` now fetches and exposes the full `profile` row (role, display_name) — available via `const { profile } = useAuth()`

### Annotation Controls on Analysis Page
- When viewer is a teacher, each flag row shows a compact ✓ / ✗ / ✎ bar
- Reject opens inline reason picker; Edit opens inline correction form
- Annotations load on take switch, display badge on flagged row ("✓ approve", "✗ reject · wrong measure")
- Implemented as inline styles to avoid touching Analysis.module.css

### Reference MIDI Upload on Record Page
- Optional "Reference MIDI" drop zone added to Performance Details section
- After analysis polling completes, MIDI uploads to `reference-midi` bucket and writes to `reference_performances` table linked to the song's `song_id`
- Non-fatal — upload failure never blocks navigation to results

### Infrastructure prerequisite
User must run `supabase/migrations/20260630_*.sql` (5 files) and create the `reference-midi` storage bucket before any teacher features will work in production.

---

## 2026-06-29 — Real UI Redesign: Landing Structural Overhaul + Analysis Chat UX

### Landing Page — Structural Redesign (no more app mockups)
- **Removed** all fake app window/screenshot mockups from the landing page (hero + feature showcase)
- **Hero visual**: Replaced fake app window with an animated **waveform visualization** — 40 CSS-animated bars with coral-highlighted "flagged" bars and floating flag badges. Not a fake UI.
- **Marquee strip**: Added horizontal scrolling ticker between hero and stats ("PITCH ANALYSIS ◆ TIMING FEEDBACK ◆ DYNAMICS…")
- **How It Works**: Rebuilt from 3 identical side-by-side cards → **stacked editorial layout** with large coral step numbers, vertical divider lines, and full-width step rows
- **Coming Soon section**: Replaced "Feature Showcase" (which had a second app mockup) with a dashed-border "The full interface is on its way" section + early access CTA
- **Features**: Replaced 6-card identical grid → **two-column feature list** with icon + title + description rows and dividing lines

### Analysis Page — AI Chat Accessibility
- **Quick prompt chips**: Row of 5 pre-written questions above the sticky chat input — one click to ask instantly
- **"Ask Practa →" button**: Added to every flag card in the insights list — pre-fills the input with a specific question about that measure and issue
- **Flag context badge**: When a flag is selected, a teal badge appears in the input bar showing "m.12 · Timing" with ✕ to clear
- **Dynamic placeholder**: Input shows "Ask about Timing in m.12…" when a flag is active
- **Upload button**: Moved into the main sticky bar (was only in Session Summary tab)
- **Renamed**: "Ask Mediant" → "Ask Practa" everywhere; chat panel labeled "AI coach for this take"

---

## 2026-06-29 — Practapal Rebrand + Full UI Redesign

### Brand
- Renamed app from **Mediant** → **Practapal** throughout AppShell.jsx
- Updated all "Mediant home" aria-labels to "Practapal home"
- Updated mobile header wordmark and sidebar logo text

### Color System
- Replaced gold accent (`#bc9463`) with teal (`#159A86`) as primary accent
- Deep teal (`#0C5C52`) for backgrounds, headers, dark sections
- Coral (`#EE7B53`) as action/CTA color (record button, primary CTAs)
- Updated all CSS variables in `AppShell.module.css`: `--accent`, `--accent-bg`, `--accent-border`, `--gold`, `--hero-green`, shadow rgba values
- Mobile record button now uses coral with matching box-shadow

### Typography
- All serif fonts (Iowan Old Style, Palatino, Georgia) → **Arial, Helvetica, sans-serif** throughout Landing and AppShell
- Home page greeting title switched from serif 400 weight to Arial 700

### Landing Page — Complete Rebuild
Added full website sections:
- **Hero**: Dark teal background, large Arial Bold headline, product mockup with live sheet music SVG and flag cards
- **Stats bar**: 4 trust metrics (analyses run, musicians, instruments, recommend rate)
- **How it works**: 3-step numbered cards
- **Feature showcase**: Split layout with app UI mockup showing score + flags + Loop buttons
- **Features grid**: 6 feature cards (pitch, timing, dynamics, loop, score, progress)
- **Testimonials**: 3 quote cards on dark teal background
- **Pricing**: Free + Pro tiers with feature lists
- **FAQ**: 5 accordion items with toggle interaction
- **CTA strip**: Coral background, high contrast
- **Footer**: 4-column layout (brand, product, tools, company) on dark background

### Concepts Delivered
- `agent_workspace/concepts/landing-concept.html` — landing page mockup
- `agent_workspace/concepts/app-concept.html` — app interior mockup (Home, Analysis, New Take)

## 2026-06-30 — AI Model Accuracy Polish

### modal_worker/worker.py

**Posture + Technique detection (new)**
- Gemini prompt restructured: now asks for 7 mandatory categories — 5 audio (intonation, rhythm, wrong notes, dynamics, tone) + 2 visual (posture, technique)
- New `_technique_visual_guidance(instrument)` returns per-instrument visual observation guidance (bow contact point for strings, hand shape for piano, embouchure for winds, etc.)
- `evaluate_with_gemini` return dict now includes `posture_issues` and `technique_issues`; "not visible" placeholders are filtered before reaching Claude
- `build_gemini_block` includes posture/technique in the evidence handed to Claude

**Wrong note pre-computation (new)**
- New `find_wrong_note_candidates(aligned, score)`: compares each CREPE event's MIDI pitch to all expected notes in its assigned measure; events ≥2 semitones from every expected note are flagged as wrong note candidates (up to 6)
- Candidates merged into the evidence block alongside CREPE intonation/timing candidates

**Claude coaching improvements**
- Upgraded `compare_and_coach_claude` from `claude-haiku-4-5-20251001` → `claude-sonnet-4-6` (max_tokens 2000 → 3000)
- `allowed_types` expanded: added `posture` and `technique`
- Flag cap increased from 6 → 8; prompt now requests "4–8 issues"
- Explicit priority order in prompt: wrong notes → intonation → posture → technique → rhythm/dynamics/articulation
- Posture/technique dedup is global (one of each per analysis), not per-measure

**Deployed**: `modal deploy modal_worker/worker.py` — both endpoints healthy

### Bug Fix — cents_offset clamp order (same session)

- **Bug**: cents_offset was computed AFTER the MIDI range clamp (max 36, min 96), producing values like -500¢ for low bass notes
- **Fix**: compute cents from pre-clamp `midi_raw`, then clamp separately for pitch name display
- **Tested**: 3 live runs on Modal endpoint — all 22 events show cents in [-40, +37]¢ range, 0 variance across runs
