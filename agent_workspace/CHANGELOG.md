# Changelog — Practapal (formerly Mediant)

## 2026-08-12 — Restore the larger sheet-music size (without the horizontal cut)

The width-fit change fixed the horizontal cropping but shrank the score ~20%
in the process (it was previously oversized *because* it was overflowing). Got
the old size back by giving the score more room rather than reintroducing a
zoom multiplier — so it still fits the width exactly, still never scrolls
horizontally:
- `.page` max-width `1200px` → `1440px`.
- Score grid column `minmax(440px, 620px)` → up to `800px`.
- `.scorePanelBody` padding `14px` → `14px 30px`, so there's a real white
  gutter either side of the score for the page arrows to sit against.

Net: rendered score width 530px → 650px (back to roughly the pre-fix size),
with the issues panel still *wider* than it was before today at 576px.

**Caught a regression while verifying at multiple widths:** the first attempt
used `minmax(520px, 800px)` for the score column, putting the hard floor on
the wrong track — at a ~1000px viewport the score column hogged its 800px max
and starved the issues panel down to ~140px, truncating every title to two or
three characters. Fixed by moving the floor to the issues column instead
(`minmax(0, 800px) minmax(340px, 1fr)`), so the score column is the one that
yields when space is tight. Verified at 1700 / 1200 / 1000px: equal 30px
padding and zero horizontal overflow at every width, score column shrinking
gracefully (650 → 646 → 446px) while the issues panel holds its floor.

## 2026-08-12 — Score panel: fit width exactly, scroll vertically only

Per feedback, dropped `SCORE_ZOOM` and the `min(width-fit, height-fit)` sizing
entirely — the image now scales to `panelContentWidth / naturalWidth` and
nothing else, so its rendered width always exactly equals the panel's content
box (`clientWidth` minus its own left/right padding, read via
`getComputedStyle` so it can't drift out of sync with the CSS). That
guarantees equal padding on both sides and zero horizontal scrollbar, ever —
`.scorePanelBody` also now sets `overflow-x: hidden` explicitly rather than
relying on the math to land exactly at zero. Height just follows from the
image's own aspect ratio: for a typical portrait score it now exceeds the
panel and the panel scrolls vertically only, which was the actual goal (bigger
sheet music) — horizontal scrolling was a side effect of the old uniform
zoom-both-axes approach, not something anyone wanted.

Verified the same way as the clipping fix earlier today — intercepted the demo
image request and served a synthetic tall SVG in its place — confirming zero
horizontal overflow, exactly equal left/right padding (measured, not just
visually eyeballed), and the vertical centering/scroll-to-top/scroll-to-bottom
behavior from the previous fix still holds with the new sizing math.

## 2026-08-12 — Fix score panel clipping a tall image with no way to scroll to it

Real bug, not just sizing: a tall (portrait) sheet-music photo — the actual use
case, unlike the wide demo clarinet asset used in most of today's earlier
testing — rendered squished/clipped at the bottom with no way to scroll down
to see the rest. Root cause: `.scorePanelBody` centered its content via
`display:flex; align-items:center; justify-content:center`. That's "unsafe" CSS
box alignment — per spec, when centered content overflows, browsers are
allowed to make the portion that falls *before* the visual center unreachable
by scrolling, rather than guaranteeing the full scrollable range. That's
exactly what this looked like: content simply cut off at the container's
edge, no scrollbar movement reaching the rest.

Fixed by centering via the child's own `margin: auto` instead of the
container's `align-items`/`justify-content` — a flex item's own auto margins
resolve differently (clamp to 0 when negative, matching normal box-model
behavior) and don't have the unsafe-overflow problem. `scoreImgWrap` is now
`margin: auto` on a plain `display:flex` container (no `align-items`/
`justify-content` at all). Verified by intercepting the demo image request and
serving a synthetic 800×3000 portrait SVG in its place — confirmed both the
top and bottom of the tall image are now reachable by scrolling, and the
initial view still lands centered.

While in there, per feedback that the score panel looked "squished": widened
the score grid column (`minmax(360px,460px)` → `minmax(440px,620px)`) and
bumped `SCORE_ZOOM` back up slightly (`1.3` → `1.4`).

## 2026-08-12 — Score panel smaller + centered, issues panel wider

Follow-up sizing/spacing pass on the score panel:
- `SCORE_ZOOM` down from `1.5` to `1.3` (a little smaller, per feedback).
- `.twoPanel` grid flipped: score column is now `minmax(360px, 460px)` (capped) instead of `1fr`, and the issues column gets `1fr` (was a fixed `340px`) — issues panel is now noticeably wider so titles truncate less.
- Sheet music is properly centered in its card with equal space on both sides now, including when it doesn't need to scroll at all: `.scoreImgWrap` switched from `display:inline-block` to `display:block; width:fit-content; margin:0 auto`, and `.scorePanelBody` is a `flex column` with `align-items:center; justify-content:center`. (Confirmed the earlier flex-centering concern doesn't apply anymore — that bug was the debounce/resize-race fixed last time, not flex itself; re-added it for the vertical axis without reintroducing the original bug.)
- The page-arrow slots (`.scoreSideArrow`) are now always rendered (previously conditionally, `{scorePageCount > 1 && ...}`) and just `visibility:hidden` for single-page takes, so the card's width and centering stay identical whether or not a take has multiple pages — no more layout jump when pagination does show up.
- `scorePanelBody` padding up from `4px` to `14px` for a bit of breathing room around the image inside the card.

Verified via Playwright: `.scoreImgWrap`'s rendered box sits symmetrically inside `.scorePanelBody` on both axes (confirmed CSS auto-margins DO center correctly even when the content overflows — negative auto-margins split the overflow evenly rather than clamping to 0 as I'd assumed last time), scroll-centering math still lands exactly on `(scrollWidth-clientWidth)/2`, issues panel measurably wider, no console errors, mobile fallback (<960px, arrows hidden entirely there) unaffected.

## 2026-08-12 — Sheet music now zooms in + scrolls instead of shrinking to fit

Reversed the earlier "must fit without scrolling" design for the score panel specifically — user wants it bigger and legible, scrolling to see the rest. `scorePanelBody` is now the scroll viewport (`overflow: auto`, minimal 4px padding so the scrollbar sits close to the image, not out at the card's edge); the image renders at `1.5x` its "fits the panel" size (`SCORE_ZOOM` in Analysis.jsx), computed from `img.naturalWidth/Height` vs. the panel's `clientWidth/Height` and set as an explicit inline pixel `width`/`height` (not CSS `max-width`, since the zoom target is a multiple of the fit size — only JS can compute that). View starts scrolled to the middle of the zoomed score rather than the top-left corner.

Hit a real bug getting the initial centering right: applying the new (larger) image size makes scrollbars appear, which shrinks `scorePanelBody`'s own `clientWidth`/`clientHeight` (scrollbar reserves space) — that resize re-fires the same `ResizeObserver` watching the panel, which recomputes a *smaller* target image size to compensate, shrinking the image again just after the first centering pass already ran against the larger, pre-scrollbar size. The already-set `scrollLeft` then gets silently clamped to the new (smaller) max by the browser, landing at the far edge instead of centered. Fixed by debouncing the "center once" step (80ms of no further resize) instead of firing on the very first `ResizeObserver` callback — confirmed via Playwright that `scrollLeft`/`scrollTop` land exactly at `(scrollWidth - clientWidth) / 2` / `(scrollHeight - clientHeight) / 2` after settling.

Also switched `.scoreImgWrap`/`scorePanelBody` off flexbox for this (was `display:flex; align-items:center; justify-content:center`) — flexbox's centering combined with scrollable overflow has inconsistent, browser-dependent scroll-range semantics (`scrollLeft: 0` doesn't reliably mean the content's true left edge once it's centered *and* overflowing). Plain block layout keeps `scrollLeft`/`scrollTop` unambiguous, which the centering math depends on.

Below 960px the zoom is off entirely — `computeSize()` checks `matchMedia('(max-width: 960px)')` and clears the inline size (falls back to the mobile stylesheet's normal responsive `width:100%` image), since an inline style would otherwise override that CSS outright (inline always wins) regardless of viewport.

## 2026-08-12 — Multi-page sheet music, Analysis page layout cleanup

**Multi-page sheet music** (new feature, scoped deliberately — see `Fixes/Fix — Multi-page sheet music (score_paths).md`):
- `takes.score_paths JSONB` migration (additive; `score_path` singular unchanged, still page 0).
- Upload modal accepts multiple score images (`multiple` file input), with a removable page-chip list.
- `analyze-performance` edge function accepts/validates/stores `scorePaths` (IDOR-checked same as the existing singular path); **deployed**.
- Analysis page: `scoreUrls`/`currentScorePage` state, flanking prev/next page arrows (only rendered for >1 page), "Page X of Y" label.
- **Scope limit, on purpose:** only page 0 is ever fed to the AI (Modal worker, `score_cache`, Claude vision) — that pipeline is untouched. Pages 1+ are stored/viewable with no measure markers. Extending measure-detection across pages is flagged as follow-up work, not attempted blind against a tuned production pipeline I can't fully test here.

**Layout cleanup** (user feedback: sheet music still looked small, wanted the "SESSION" label gone, and the back-button hover looked like a floating box instead of a full row):
- Removed the "SESSION" eyebrow label above the piece title.
- Score panel (`.scorePanel`) capped at `max-width: 620px` instead of stretching the full grid column — was leaving big empty gutters beside portrait-oriented images; that freed space is now where the page arrows live.
- `.backBtn` ("← All sessions") now breaks out of `.page`'s horizontal padding via a matching negative margin, so its hover fill is one continuous full-bleed row flush with the page edges instead of a rounded box inset from them.
- Full regression pass via Playwright against `/#/demo` (including a temporary synthetic 2-page take to exercise the new pager, reverted after verifying) — no console errors, page-lock/summary-toggle/mobile-fallback from earlier today all still intact.

## 2026-08-12 — Analysis page: sheet music no longer clipped, wider score panel

Root cause of "still too small": the score image was being scaled by HEIGHT only
(`.scoreImg { height:100%; width:auto }`), which for a wide-aspect image (the demo
route's clarinet photo, ~1.8:1) meant the rendered image was WIDER than its panel —
the `overflow-x:auto` fallback then silently cropped ~15% off each side rather than
showing the whole thing. That's what looked "small": you were only ever seeing the
cropped middle of it.

Fixed properly instead of just tuning numbers: the image now uses real "contain"
sizing (`max-width/max-height:100%` + auto) so it always shows in full, scaled by
whichever axis is more restrictive — for a typical portrait sheet-music image this
still fills the panel edge-to-edge exactly as before, only an unusually wide image
would ever letterbox. The catch: `.scoreImgWrap` now fills the whole panel (not
shrink-wrapped to the image), which used to be required so the marker/span overlay's
percentage positions lined up with the image — with a wrapper bigger than a
letterboxed image, they'd land in the letterbox gap instead. Fixed by measuring the
image's actual rendered box via a `ResizeObserver` (`scoreImgBox` state in
Analysis.jsx) and rendering the marker/span overlay as its own absolutely-positioned
layer sized to that measured box, not the wrapper — so markers stay correctly
aligned regardless of letterboxing, on any viewport.

Also gave the score panel more width (twoPanel: `400px` issues column → `340px`,
gap `20px` → `16px`, page max-width `1160` → `1200`, padding `32px` → `24px`
horizontal) since a wider panel needs to letterbox less often in practice.

Verified via Playwright: image bounding box sits fully inside its panel on both
axes now (previously overflowed left/right by ~150px combined), markers still land
on the correct spots, marker click still works, window scroll still locked, mobile
(<960px) fallback unaffected — confirmed by screenshot.

## 2026-08-12 — Analysis page: bigger sheet music, remove take dropdown, fix summary scrollbar gutter

Two more follow-ups on today's locked-layout work:

1. **Sheet music was fitting but rendering smaller than it needed to.** Removed the take-selector dropdown ("Take 5 · 72") from the session header per user decision (it let you switch between takes of the same piece from this page — that's still possible via Sessions/Takes, which deep-link into `/analysis?takeId=...`). Since it's gone, clicking a thread chip or deleting a take now auto-selects that thread's newest take (`setSelectedTakeId(thread.takes[0].id)`) instead of clearing to `null` — previously that null was fine because the dropdown let you immediately pick a take, but without it, clearing to null would've dead-ended on the "No session selected" empty state. Also shaved down `.page` padding, `.sessionHeader`/`.threadStrip`/`.demoBanner` margins, `.sessionTitle` font size, and `.panelHead`/`.scorePanelBody` padding — reclaimed enough height that the demo score image grew from ~491px to ~557px tall in an 900px-viewport test.
2. **Summary view's scrollbar was rendering flush against the score/strength cards' right edge** (`.scoreBreakdownRow` / `.strWeakRow` had zero right padding on their container, so the scrollbar thumb had nowhere to sit but on top of the cards). Added a 14px right-padding gutter to `.summarySection` — verified via Playwright that the container's right edge now sits 14px outside the cards' right edge instead of flush with it.

Follow-up on the locked-layout change earlier today. Two real bugs, one CSS tightening:

1. **The page could still scroll when the cursor wasn't over the sheet music or issues panel.** Root cause: `.page` was set to `height: 100vh`, but it renders inside AppShell's `#main-content` (`.main` in AppShell.module.css), which is ALSO `height: 100vh` with `overflow-y: auto` — and `.main` also contains a 56px sticky top bar above the page content. So actual content height inside `.main` was `56px + 100vh`, 56px taller than `.main` itself, and that 56px surplus is exactly what let you scroll from anywhere outside the two inner scroll regions. Fixed by changing `.page` to `height: calc(100vh - 56px)` so it exactly fills what's left after the top bar — verified via Playwright: `window.scrollY` no longer moves no matter where on the page you wheel.
2. **Sheet music was taller than its panel and needed a scrollbar to see all of it.** Root cause was two-fold: (a) `.twoPanel`'s implicit grid row had no `grid-template-rows`, so it auto-sized to its tallest child's *natural* content height (the full-res score image) instead of being capped at the available viewport height — added `grid-template-rows: minmax(0, 1fr)` to force the row (and both panels) to the container's actual height; (b) the JSX had an unstyled wrapper `<div>` between `.scorePanelBody` (flex container, definite height) and `.scoreImgWrap` (which needs `height: 100%` to scale the image to fit) — that extra div's own height was `auto`, breaking the percentage-height chain (a `height: 100%` against an indefinite/auto containing block resolves to `auto`, not a real constraint), so the image rendered at its full intrinsic size regardless. Fixed by giving that wrapper `style={{ display: 'contents' }}` so it doesn't generate a box and `.scoreImgWrap` becomes a direct flex item of `.scorePanelBody` again. Also caught and fixed a self-inflicted regression from the same edit pass: an earlier find-and-replace had accidentally deleted the `.scorePanel` rule itself.
3. Tightened header/thread-strip/banner spacing (smaller margins and padding) to reclaim vertical room for the sheet music, since it now has to fit entirely within the viewport with no scroll fallback.

All verified via a Playwright pass against `/#/demo`: sheet music image bounding box now sits fully inside its panel's bounding box (no clipping, no scrollbar needed), `window.scrollY` stays at 0 when wheeling over any part of the page, the issues list still scrolls independently, the summary view-toggle still works both directions, and the mobile (<960px) fallback still renders and scrolls normally.

## 2026-08-12 — Remove "Fix This Section", lock the Analysis page layout

Two requests:
- Dropped the "Fix This Section" card (component left in place, unused, in case it comes back) — removed its render block and the now-dead `FixThisSection` import, plus the `useRecordModal`/`setOpenRecord` wiring that only existed to feed it.
- The Analysis page no longer scrolls as a whole. `.page` is now a fixed `height: 100vh` flex column; everything above the two-panel body (demo banner, thread strip, session header) sits at natural height and never moves. A new `.lockedBody` wrapper fills the remaining space, and only the issues list inside it scrolls (`.issuesList { overflow-y: auto }` under a `.panelHead` that stays put) — the sheet music panel and session header are simply never in a scrolling container, so they can't move.
- Because the page can't scroll to `#summary-section` anymore, the nav arrow and the two session-header buttons ("Analysis" / "Jump to summary") now toggle an `inSummaryView` view-swap (inline `display:none` on whichever panel isn't active) instead of `scrollIntoView`. Dropped the `IntersectionObserver` that used to track scroll position for the arrow — it's a direct click-driven toggle now, reset to the analysis view whenever the selected take changes.
- Below 960px the locked/pinned layout is disabled entirely (`.page { height: auto }`, panels back to `position: static` / normal overflow) — falls back to the old scrolling single-column layout, since pinning doesn't make sense once the two panels stack.
- Verified via Playwright against `/#/demo`: window-level `mouse.wheel` no longer moves the session title or score panel; wheeling over the issues list scrolls only that list; the summary toggle swaps views correctly in both directions with the arrow icon flipping; no console errors.

## 2026-07-26 — Fix TDZ crash on Analysis page; require explicit session selection

The previous nav-arrow change ("Cannot access 'D' before initialization" in prod, minified) had a `useEffect` referencing `take?.id` in its dependency array before `const take = useMemo(...)` was declared later in the component — a temporal-dead-zone bug. Moved the effect to right after `take` is declared (next to the existing "must be after `take`" annotation comment pattern already used for the teacher-annotations effect).

Also changed take-selection: previously `take` always fell back to `takesForActiveThread[0]` even with no explicit selection, so bare `nav('/analysis')` (sidebar icon, Calendar, ProgressFeedback) silently showed your latest take with no way to tell it wasn't the one you meant to view. Now non-demo users must land via an explicit `?takeId=` (from Sessions/Takes/Home/Record) or pick one from the take dropdown; landing with no selection shows a "No session selected" prompt with "Select a session" / "Record a new take" actions instead. Demo mode (`isDemo`) is unaffected — it still auto-selects its sample take. Verified via Playwright against `/#/demo` (unauthenticated route, same Analysis component with `demo` prop) — arrow toggles direction on scroll, sheet music panel sticks at `top: 20px` while the issues panel scrolls past it, no console errors.

## 2026-07-26 — Analysis page: nav arrow to Summary, sticky sheet music panel

Three UI requests on the Analysis page:
- Added a floating circular orange arrow button, fixed to the viewport edge. Right-pointing (right edge) while viewing the analysis — click scrolls smoothly to `#summary-section`. Left-pointing (left edge) while viewing the summary — click scrolls back to `#analysis-top` (the session header, now given that id). A single toggling button driven by an `IntersectionObserver` on `#summary-section` (`inSummaryView` state), not two separately-rendered buttons — keeps "only one arrow visible at a time" trivially true. Hidden below 760px (no room on mobile).
- `.scorePanel` (sheet music) is now `position: sticky; top: 20px; align-self: start;`. Since `.twoPanel` already uses CSS Grid with `align-items: start`, the sticky panel's containing block is exactly as tall as the issues column next to it, so the sheet music stays pinned in place for the full duration of the issues panel scrolling past it — no nested scroll container needed, just one continuous page scroll with one column pinned. Reset to `position: static` under the existing `@media (max-width: 960px)` breakpoint (matches the existing `.issuesPanel` mobile reset), since a single-column mobile layout has nothing to pin against.

## 2026-07-26 — Cache the AI session summary (stop regenerating it on every page load)

Investigated cutting Claude API cost without touching analysis quality. Findings:
- Measured the two Sonnet calls' static instructional text directly (`read_score_notes_claude` ~250 tokens, `compare_and_coach_claude`'s coach_prompt ~280 tokens) — both are well under Sonnet 4.6's 2048-token minimum cacheable prefix, so adding `cache_control` there would not actually reduce cost today (would silently just not cache). Not implemented, to avoid selling a change with zero real effect.
- Score parsing (`read_score_notes_claude`) already only runs once per NEW piece thanks to existing DB-level score caching — already optimal, no further action.
- The practice plan (`analysis-webhook` → Haiku) was already generated once server-side and persisted to `takes.practice_plan` — already optimal.
- **Found the real leak:** the session summary (`analysis-summary` edge function → Haiku) had no persistence at all — it re-called Claude with identical inputs every single time a take's Analysis page was opened or reloaded, producing the same content over and over for zero benefit. This was pure waste, not a needed-for-accuracy call.

Fix: added `takes.ai_summary JSONB` (migration `20260726_add_ai_summary_to_takes.sql`, applied directly via `supabase db query` — the full `db push` is blocked by a pre-existing unrelated migration-history drift, not touched). Frontend now reads `take.ai_summary` first and skips the Claude call entirely if present; on a fresh generation, persists the result back to the take row so every subsequent open of that take is free. Same exact content as before — this only removes redundant regeneration.

## 2026-07-24 — Drop hedged issues, intonation titles = "Sharp"/"Flat", first-measure loop refinement

User feedback after DTW rollout: loop is much better, just a tiny miss at measure 20 (the piece's first measure) with a missing opening note. Plus two display requests.

### Loop: first-measure margin fix
The inward-shrink margin added earlier (2026-07-23c) delays a measure's start slightly to avoid bleeding the tail of a real previous measure — but the very FIRST playable measure has no previous measure to bleed from, so that delay only risked clipping the true opening note for no benefit. `measure_to_time_range` now skips the start margin when `m0 <= start_measure`; the end margin is unaffected. Verified: first measure's loop now starts at exactly 0.000 (no delay); later measures keep the protective margin.

### Drop unconfirmed ("possible") issues entirely
User: "get rid of any issues labeled as possible... I don't really want to see those." Tier B issues (error/timing) not corroborated by CREPE were previously shown with hedged language ("possible hesitation", "may have rushed"). Now dropped from the report entirely rather than hedged — `deduped_issues` is filtered to `confirmed=True` only before coaching, and the coaching prompt's hedging instruction was removed (replaced with "every issue below is CONFIRMED — state it as fact"). Tier A issues (dynamics, tone, posture, technique) are unaffected — they're always confirmed. Verified: an unconfirmed rhythm issue and an uncorroborated wrong-note issue are both dropped from the output; a confirmed dynamics issue survives.

### Intonation titles: "Sharp"/"Flat" only, cents + fix in the body
User: title should just say "flat" or "sharp"; cents + fix belongs in the description. Added a `direction` field threaded from the intonation-detection step through to the flag; flag assembly now force-overrides the title to `iss['direction'].capitalize()` for intonation issues regardless of what Claude wrote (the coaching prompt tells Claude this will happen, so it should focus effort on the body). The underlying `observed` text (used as both the Claude-visible evidence and the template fallback) now also includes a concrete embouchure/air-support fix hint per direction. Verified: titles are exactly "Sharp"/"Flat"; cents deviation and fix guidance are present in the body even via the template fallback path.

## 2026-07-23d — Note-content alignment (DTW) enabled for photo-based scores

User's proposal: instead of estimating measure boundaries from beat-counting (which drifts if a beat is ever missed/miscounted), match the ACTUAL PITCH SEQUENCE played against the score's note sequence — when that specific pattern of notes is heard, THAT determines the measure. The codebase already had exactly this (`dtw_align_to_score`, DTW-matching CREPE-detected pitches against the score's notes) — but it was gated to MusicXML scores only (`"music21" in score_source`). Every take in this project uses a PHOTO of the sheet music (Claude-vision-parsed), so DTW was never running; every take silently used the far more fragile beat-grid method instead.

- Two bugs stacked to cause this: (1) the gate excluded any non-MusicXML `score_source`; (2) even worse, a **successfully parsed** photo score never set a `source` field at all (`read_score_notes_claude`'s success return was missing it — only the partial-failure recovery path set `"claude_vision_partial"`), so even fixing (1) alone would not have activated DTW for a normal, fully-successful score read.
- Fixed both: `read_score_notes_claude` now sets `"source": "claude_vision"` on a successful parse. The alignment gate now accepts `music21` (≥4 notes) OR `claude_vision` (≥12 notes — a higher bar since photo-read notes are less precise per-note than MusicXML, though DTW's global warping path tolerates a few wrong ones).
- `dtw_align_to_score` now returns `[]` (not the unmodified input) when it declines — previously this returned events without a `measure` key, silently risking a KeyError downstream; now the caller explicitly falls back to beat-grid.
- `compare_and_coach_claude` gained a `dtw_verified` flag; when true, `time_to_measure`/`measure_to_time_range` check the DTW-built `alignment_ranges` FIRST — ahead of every beat-count/tempo-grid tier — since those ranges are validated against real pitch content, immune to the "one missed beat shifts everything after it" failure mode nothing else could fix.
- `alignment_method` (surfaced in the `backend` field on the take) is now tracked explicitly at the point of decision instead of recomputed later from a now-stale heuristic.
- Verified: DTW correctly aligns a Claude-vision-shaped score through a mid-piece tempo change (15 events → 5/5 measures, exact pitch match); declines cleanly (empty list, no crash) on too few notes; with `dtw_verified=True`, a flag's loop is correctly anchored to the real DTW-observed range instead of beat arithmetic; default (no DTW) path unchanged.

## 2026-07-23c — Loop shrinks inward from the beat estimate to stop bleeding into neighbors

User report: loop for "measure 24" captured the last two notes of measure 23; occasionally the loop also ran one measure past what the flag described. This is a real limit of beat-tracking on a monophonic, non-percussive instrument (clarinet) — no beat detector is perfect, and any single missed/extra detected beat earlier in the piece shifts every later index-based boundary by that much (an index-based mapping has no way to self-correct that). No further math on top of a slightly-off beat estimate can make it exactly right.

- `measure_to_time_range` now shrinks its computed window inward by up to 15% of one beat (capped at 250ms) on both the start and end — delays the loop's start slightly and pulls its end in slightly, so a small beat-estimation error can no longer include a neighboring measure's notes. Skipped if it would collapse an already-short window below 0.5s.
- This only affects the LOOP's playback window — `time_to_measure` (used for the measure label) is unchanged, so labels stay exact; only the audio played is conservatively narrowed.
- Verified: for a 120bpm/3/4 tempo-grid case, a single-measure window of [6.0,7.5]s trims to [6.075,7.425]s (75ms = 15% of the 0.5s beat) — exact match to hand calculation.

## 2026-07-23b — Fixed a hardcoded '4/4' that could silently override the real time signature

Found while investigating remaining loop-boundary imprecision: `NewRecordingModal.jsx` (the "Record & Analyze" modal, the actual submission flow used throughout this project) hardcoded `timeSig: '4/4'` with no way to change it — unlike `Record.jsx`, which already had a real, editable field. The worker DOES correct this later if it successfully reads the time signature off the score image (`bpm_int` override in `run_full_analysis`), but if that score-parsing step ever misses (image quality, an unusual layout, a partial parse), it silently falls back to the WRONG hardcoded 4/4 — beats-per-measure would be off by a third for a 3/4 piece like Procession of the Nobles, which throws every measure boundary off by the same proportion (a systematic error, not just estimation noise).

- Added a real "Time sig." field to `NewRecordingModal.jsx`, matching the existing Start/End measure fields, defaulting to 4/4 but user-editable.
- Edge function (`analyze-performance`) already forwarded `timeSig -> time_sig` correctly — no backend change needed here.
- This is a belt-and-suspenders fix layered on top of the score-based auto-detection, not a replacement for it — most takes should still auto-detect correctly; this closes the failure mode where they don't.

## 2026-07-23 — Loop boundaries now track the performance's real tempo, not an assumed constant one

After the frontend padding-duplicate fix, the loop could still under/over-play by a fraction of a measure. Root cause: even with exact math, the primary measure-boundary tiers (two-point linear anchor, uniform tempo grid) both assume a PERFECTLY CONSTANT tempo across the whole recording — real playing has natural tempo fluctuation (rubato, a march that isn't machine-metronomic), so a constant-tempo model's mid-piece measure boundaries drift away from where the performer actually played the barlines, even though the overall start/end were correct.

- Added `scaled_beat_times`: the REAL detected beat onsets (from CREPE's beat tracking — already computed for every take) rescaled by a single factor so the anchored last beat lands exactly on `anchor_time`. This captures the performance's actual tempo shape (which raw beat detection sees) while removing the accumulated drift a raw, unanchored beat count would have — best of both.
- Promoted this to the TOP-priority tier in both `time_to_measure` and `measure_to_time_range` (same array, same index math, used identically in both directions) — ahead of the two-point/tempo-grid tiers, which remain as fallbacks when no usable beat-time array exists.
- Verified: doesn't change measure NUMBERING (same labels as before across no-beat-times / beat-times-no-anchor / beat-times-with-anchor cases) — only refines the loop's time-window precision. Ran cleanly against a synthetic rubato scenario (tempo speeding up mid-piece) without errors.

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
