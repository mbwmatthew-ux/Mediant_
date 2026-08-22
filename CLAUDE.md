# Mediant — Claude Code Instructions

## READ THESE FILES AT THE START OF EVERY SESSION

Before writing any code or answering any question, read the following in order:

1. `/Users/matthewwu/Documents/Claude (database)/🏠 Start Here.md`
2. `/Users/matthewwu/Documents/Claude (database)/Project/Mediant — State of the Product.md`
3. `agent_workspace/AGENT_TASKS.md`

If the task involves an area you haven't touched recently, also read:
- `/Users/matthewwu/Documents/Claude (database)/Gotchas/Gotchas — Things That Will Bite You.md`
- The relevant file in `/Users/matthewwu/Documents/Claude (database)/Knowledge/`

---

## WRITE NOTES DURING AND AFTER EVERY SESSION

The Obsidian vault is the shared brain for this project. Keep it updated.

**During coding:** When you make a non-obvious decision, discover a bug, or work around a known limitation — write it immediately. Don't batch at the end.

**After a session ends:** Write a session note to:
`/Users/matthewwu/Documents/Claude (database)/Sessions/YYYY-MM-DD — Topic.md`

**After a significant fix:** Write a fix note to:
`/Users/matthewwu/Documents/Claude (database)/Fixes/Fix — Topic.md`

**After a product or design decision:** Write to:
`/Users/matthewwu/Documents/Claude (database)/Decisions/`

**After discovering a recurring trap:** Write to:
`/Users/matthewwu/Documents/Claude (database)/Gotchas/Gotchas — Things That Will Bite You.md`

**After shipping a code change:** Update:
`agent_workspace/CHANGELOG.md`

---

## Project overview

Mediant is an AI music performance coach. Musicians upload recordings + sheet music → AI analyzes the performance → measure-level feedback on pitch, rhythm, dynamics, articulation. The app includes a coaching chat, session history, Loop playback tied to specific feedback flags, and progress tracking.

**Stack:** React 19 + Vite + CSS Modules → Supabase (auth, postgres, storage, edge functions) → Modal.com (Python analysis worker) → Anthropic Claude + Google Gemini

**Current stage:** MVP functional. Core loop works end-to-end. Payments stubbed. Not yet launched.

---

## Keeping AGENT_TASKS.md updated

Update `agent_workspace/AGENT_TASKS.md` as work progresses — not just at the end:

- **When picking up a task:** move it from `Approved Tasks` → `In Progress`
- **When finishing a task:** move it from `In Progress` → `Completed`
- **When something needs the user to check it:** move it to `Needs Review` with a one-line note on what to verify
- **When you discover something that should be built but isn't approved yet:** add it to `Backlog`
- **Never move something to `Approved Tasks` yourself** — that's the user's decision

The user's only job on this board is: move items from `Backlog` → `Approved Tasks` when they've decided to build it.

---

## Key rules

- The warm cream/off-white, gold, and dark theme is intentional. Do not introduce cool grays, blue accents, or generic SaaS aesthetics.
- Sheet music stays visible during analysis on desktop. Never hide it behind a tab.
- Loop is a core feature — every feedback flag must have an inline Loop button.
- The AI coach chat is specific to a take. It must never ask the user what notes they played — it has the analysis data.
- Read `agent_workspace/DESIGN_RULES.md` before touching any UI file.
- Read `agent_workspace/PRODUCT_DECISIONS.md` before adding or changing any feature logic.
- Before building tooling by hand — parsers, tracers, converters, analysers, image
  processing — run `npx skills find <task>` and check for an existing skill first.
  A whole contour-tracing tool got hand-written here before anyone checked, and
  `image-to-svg` already did it better. Installed skills are listed automatically;
  this rule is about the ones that are *not* installed yet.
