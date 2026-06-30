# Changelog — Practapal (formerly Mediant)

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
