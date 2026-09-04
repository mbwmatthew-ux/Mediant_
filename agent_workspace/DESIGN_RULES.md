# Design Rules — Mediant

> **2026-09-04 — "Atelier" is the new app-wide direction, rolling out
> page by page.** Chosen through a mockup-comparison session (see
> `.superpowers/brainstorm/` for the session's visual comparisons, if still
> present) against two other explored directions ("Conservatory" and
> "Studio"). Goal, in the user's own words: keep the existing teal/orange/
> warm-white palette family, but rework the visual system so it reads as
> deliberately designed rather than templated — and specifically so it does
> not look AI-generated.
>
> **Status: `Landing.jsx` and `Analysis.jsx` are converted. Every other page
> still runs the older tokens below this notice (or, for `/home`, its own
> scoped exploration — see the note beneath this one) until it gets its own
> conversion pass.** Do not assume the rest of the app matches this section
> yet — check the individual page's CSS module before touching it.
>
> The Atelier system replaces the Colors and Typography sections below for
> any page that has been converted. Component Rules (cards/buttons/flags)
> are superseded specifically on `border-radius` — Atelier's cut-corner
> shape replaces the uniform `8px`/`12px` radius everywhere it appears.
>
> ### Atelier — Colors
>
> | Role | Value | Notes |
> |---|---|---|
> | Background (paper) | `#F3EEE3` | Warm paper tone — replaces `#F7F4EF` |
> | Surface (cards, panels) | `#FBF8F0` | Slightly lighter than paper |
> | Text (primary / ink) | `#241E15` | Warm near-black |
> | Text (secondary) | `#6E6555` | Muted warm brown-gray |
> | Border / line | `#E3D9C2` | Warm, visible but quiet |
> | Structural dark (teal) | `#2C4A3E` | Nav/score-panel grounds, secondary buttons — replaces the old near-black dark surface in this role |
> | Teal, mid | `#3B6455` | Secondary data series, eyebrows, icons on teal |
> | Accent (orange) | `#B5471F` | The one accent — CTAs, active states, highlighted measures. Replaces gold `#C09040` |
> | Error (red) | `#9C2728` | Unchanged — still strictly semantic, error flags only |
>
> Same accent discipline as before: orange is structural/CTA, red is
> semantic/error-only, never mixed as decoration. No blue, no purple.
>
> ### Atelier — Typography
>
> | Role | Font | Notes |
> |---|---|---|
> | Display (headings, hero) | `'Instrument Serif'` | Italic for emphasis words within a headline (e.g. "the way your *teacher* would") |
> | Body / UI | `'Karla'` | Weights 400/500/600/700 |
> | Monospace (timestamps, measure numbers) | unchanged — see the general Typography section below | |
>
> `Instrument Serif` + `Karla` replaces the SF Pro / Geist Sans / Playfair
> stack for converted pages. Still never Inter, Roboto, or Open Sans as a
> *primary* font — `Landing.module.css`'s old `Avenir Next → Inter → Segoe
> UI` fallback stack goes away entirely on conversion, not just the first
> link in the chain.
>
> ### Atelier — Shape language
>
> The signature differentiator. Every card, button, and panel that would
> otherwise get a uniform `border-radius: 8px` / `12px` gets an asymmetric
> **cut corner** instead: two opposite corners sharp, two rounded.
> - Large elements (cards, panels): `border-radius: 3px 22px 3px 22px;`
> - Small elements (buttons, chips, small cards): `border-radius: 2px 10px 2px 10px;`
> - Never round all four corners uniformly on a converted page — that is
>   the exact "rounded-lg everywhere" look this direction exists to move
>   away from.

> **2026-08-18 — Home screen is running a different palette on purpose.**
> `/home` is an approved exploration of a new visual direction: sage green,
> lavender, a serif display face, and an illustrated mascot. Those tokens are
> declared **inside `Home.module.css`, scoped to `.page`** — deliberately NOT in
> `index.css` — so the rest of the app still follows the rules below and the
> exploration cannot leak.
>
> Two rules below are knowingly broken *on that screen only*: the "no purple"
> rule (the lavender "Up next" card) and the single-accent rule (coral, green
> and lavender all appear). Do not "fix" the Home screen back to the cream/gold
> palette — it is intentional and the user asked for it. If the direction is
> adopted app-wide, move those tokens up into `:root` and rewrite this file.
>
> `/home` has NOT been converted to Atelier. When it is, this note and the
> Atelier note above both need updating.

Last updated: 2026-09-04

This file is the source of truth for Mediant's visual system.
Coding agents must read this before touching any UI file.

---

## Core Identity

Mediant is a music coach, not a productivity tool and not a generic AI chatbot.
The UI should feel like premium sheet music software crossed with a private lesson room.
Warm, precise, human, specific to music.

---

## Colors (pages not yet converted to Atelier)

| Role | Value | Notes |
|---|---|---|
| Background (primary) | `#F7F4EF` / `#FBFAF7` | Warm off-white / cream — not pure white |
| Surface (cards, panels) | `#FFFFFF` or `#F9F8F5` | Slightly warmer than background |
| Text (primary) | `#1A1410` | Warm near-black — never `#000000` |
| Text (secondary) | `#7A6F64` | Muted warm gray |
| Border | `rgba(0,0,0,0.07)` or `#E8E4DC` | Ultra-light, warm |
| Accent (gold) | `#C09040` | Used sparingly — CTAs, active states, highlighted measures |
| Accent (red) | `#9C2728` or `#B03030` | Error flags, critical feedback markers |
| Dark surface | `#1A1410` | Nav, score overlay backgrounds |

**Rules:**
- One accent per screen. Do not mix gold and red as decoration — red is semantic (error/flag), gold is structural (active/CTA).
- No bright blue, purple, or generic SaaS gradients anywhere.
- The background is warm. The text is warm. They belong together. Do not introduce cool-gray tones without a reason.

---

## Typography (pages not yet converted to Atelier)

**Display / headings:**
- Font: `'Instrument Serif'`, `'Newsreader'`, or `'Playfair Display'` for editorial hero headings only
- Font: `'SF Pro Display'`, `'Geist Sans'`, or `'Helvetica Neue'` for UI headings (section titles, card headers)
- Tracking: `-0.02em` to `-0.04em` for large display text
- Line height: `1.1` for headlines, `1.6` for body

**Body / UI:**
- Font: `'SF Pro Text'`, `'Geist Sans'`, `'Helvetica Neue'`, or system-ui
- Size: `15px–16px` base, `13px` for metadata/secondary
- Color: `#1A1410` primary, `#7A6F64` secondary

**Monospace (timestamps, measure numbers, flags):**
- Font: `'Geist Mono'`, `'SF Mono'`, or `'JetBrains Mono'`
- Use for: audio timestamps, measure numbers, tempo markings, technical metadata

**Rules:**
- Never use Inter, Roboto, or Open Sans as the primary font.
- Measure numbers and timestamps always use monospace — they are data, not prose.
- Do not mix font families within a single card or UI section.

---

## Layout Principles

- **Macro whitespace first.** Give every section room to breathe. Minimum `64px` vertical padding between major sections.
- **Max content width:** `1200px` centered. Sheet music and waveform panels may go wider if the layout needs it.
- **Column structure:** Prefer two-column layouts (score/analysis split) on desktop. Single column on mobile.
- **No decorative empty space.** Every gap should feel intentional, not like something is missing.
- **Grid over float math.** Use CSS Grid. Never `width: calc(50% - 12px)` when `grid-cols-2` works.

---

## Component Rules

**Cards:**
- Border: `1px solid rgba(0,0,0,0.07)`
- Border-radius: `8px` or `12px` — pick one per context and stay consistent
- Shadow: none, or `0 1px 4px rgba(0,0,0,0.04)` at most
- Padding: `20px–32px`

**Buttons:**
- Primary: `background: #1A1410; color: #FFFFFF; border-radius: 6px`
- Secondary: `background: transparent; border: 1px solid #1A1410; color: #1A1410`
- Gold CTA: `background: #C09040; color: #FFFFFF` — use only for the single most important action on screen
- Hover: `scale(0.98)` or subtle color shift — no glow, no box-shadow pop

**Flag / feedback cards (analysis view):**
- Left border accent: `4px solid #9C2728` for errors, `4px solid #C09040` for warnings
- Always show: measure number (monospace), timestamp range, flag type
- Loop button must be visible on every flag card — one click to hear the exact section

**Sheet music panel:**
- Always visible on desktop analysis view — never hidden behind a tab on desktop
- Highlighted measures use a semi-transparent gold overlay: `rgba(192, 144, 64, 0.15)`

---

## What to Avoid

- Generic card grids that look like a SaaS feature comparison table
- Centered hero layouts with a gradient blob behind them
- Dark mode as a vanity feature — only if it genuinely serves musicians practicing at night
- Pill buttons for primary CTAs on desktop
- Heavy drop shadows (`box-shadow: 0 8px 32px rgba(0,0,0,0.2)`)
- Thin hairline icons (Lucide, Feather) — use Phosphor Bold or fill-weight icons
- Empty state screens that just say "No recordings yet"
- AI chat UI that looks like a generic ChatGPT wrapper

---

## Mobile Rules

- Bottom navigation bar for primary sections (Dashboard, Library, Analysis, Profile)
- Waveform and flag cards stack vertically on mobile — score image above, flags below
- Loop button stays visible on mobile — minimum touch target `44px × 44px`
- Font sizes: minimum `15px` body, `13px` secondary — never smaller
- Padding: minimum `16px` horizontal on all content

---

## Loop Feature Visibility

Loop is a core feature — not a "nice to have" buried in a menu.

- Every flagged section in the analysis view has a Loop button inline
- Loop button label: "Loop" with a loop/repeat icon (Phosphor `ArrowsClockwise` or similar)
- Active loop state: gold accent on the button, the waveform segment highlights
- Tapping the measure number in a flag card should seek to that section — tapping Loop should begin playback and repeat

---

## Thread UI Rules

The song thread is a chronological feed of takes, feedback, and follow-up messages.

- Each take is a distinct block: recording date, score, summary, and a "View Analysis" link
- Follow-up coach messages appear inline between takes — not in a separate chat window
- New take button is always visible at the top of the thread — one action, not buried
- Thread does not paginate or hide old takes — musicians want to see their full history
- Comparison mode: when the user uploads a second take, show a delta indicator (better / same / worse) next to the score on the new take

---

## Song-Thread Data Model (as of 2026-06-14)

The `songs` table is the persistent root of each thread. One row per (user, song title).

**Schema:**
- `songs`: `id, user_id, title, composer, instrument, chat_history (JSONB), created_at, updated_at`
- `takes`: `song_id (FK → songs.id), ...all existing take columns`
- `chat_history` lives on `songs`, not on individual takes — it is thread-scoped, not take-scoped

**Lookup flow in Analysis.jsx:**
1. When user switches to a thread, look up `songs` by `(user_id, title)`
2. If found: hydrate `chat_history` into local state
3. If not found: INSERT a new songs row and hold the ID in `activeSongId`
4. Every `coach-chat` call sends `songId: activeSongId`; the edge function persists the updated history back to `songs.chat_history`

**Grouping rule:**
- Threads are still grouped by `piece_title` in the UI (matching the `songs.title` string)
- The `song_id` FK on `takes` is used to associate takes with a thread, but the UI continues to group by title string as a fallback for legacy takes without a `song_id`

---

## Loop Feature — Interaction Details

- Clicking the timestamp (e.g. `0:08.2`) on a flag row seeks the video to that position and begins playback
- Clicking "Loop" starts a repeat loop of the flag's `timestamp_start → timestamp_end` range
- While looping, a gold progress bar appears directly below the flag row showing position within the loop
- The Loop button turns gold (`var(--gold)`) and reads "Stop" while active
- Looping stops automatically when the user clicks a different flag row or presses Escape
- Loop button min touch target: `44px × 44px` on mobile
