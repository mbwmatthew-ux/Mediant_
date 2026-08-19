# Changelog — Practapal (formerly Mediant)

## 2026-08-18 (fourth pass) — Asset shapes traced from the reference

The shapes were still wrong, because they were drawn by eye from a full-page
view where the mascot is 200px inside a 1672px image. Two fixes, plus a tool so
this does not recur.

**`agent_workspace/trace_asset.py`** — masks a flat-coloured region of a
reference image, walks its boundary, simplifies (RDP) and smooths into cubic
béziers. The hero blob is now the reference's actual silhouette: hand-drawing it
had produced an ellipse and lost the deep concave sweep along the bottom-left,
which is the shape's entire character.

**The mascot was redrawn from a 4× crop.** At that magnification it is plainly
not what was implemented: a pear body (narrow crown, broad base), large angled
oval ear cups with a lighter inner face, closed content eyes, an **open mouth
with a tongue**, soft cheeks, a thumbs-up and an arm sweeping down the right. It
had been a circle with a thin band and small rectangular cups. Proportions were
then measured against the reference — the first redraw was ~30% oversized, which
made the ear cups dominate.

**Three traps worth recording:**
- **RDP collapses a closed contour.** First and last vertices coincide, so the
  baseline has zero length and every distance measures ~0 — the ring simplified
  to one point. Split at the vertex farthest from the start, simplify each half
  as an open polyline, rejoin.
- **Segmentation needs two axes.** Mascot and blob share a hue; saturation alone
  selected both. Body is darker *and* more saturated.
- **Always render the mask.** The first blob trace used light morphological
  closing, a sparkle broke the silhouette, and the walk traced a visible spike
  through the notch.

Tracing works for flat shapes on contrasting ground. It could **not** separate
the mascot from the blob's gradient, so that one is a hand redraw guided by the
zoom — an interpretation, not a reproduction. For exact fidelity the right input
is a vector export of the assets, not a screenshot.

Method written up in the vault: *Working from a design mockup — the accurate
workflow*.

## 2026-08-18 (third pass) — Home matched against the actual reference file

**Sidebar reverted.** The 232px Home rail is gone; every route is back to the
72px hover rail it had before.

**The real change: the reference image is now a file on disk.** Pasted images are
visible to the agent in-conversation but are not files, so they cannot be
colour-picked or measured — which is why the first two passes guessed the palette
and got it wrong. `agent_workspace/extract_pasted_images.py` recovers them from
the session transcript, and the mockup now lives at
`agent_workspace/reference/home-redesign-2026-08.jpeg`.

Sampling it changed real decisions:

| Element | Guessed | Sampled |
|---|---|---|
| "Up next" card | `#EAE4F8` (purple) | `#F1EAF6` (pale mauve) |
| Dark card | `#2E6349` (olive) | `#1D5C51` (teal) |
| Hero blob | `#6FB295` (saturated) | `#85B5A5` (muted sage) |
| Page background | `#F5F0E8` | `#FCF9F4` |
| Bar/ring track | green tint | `#F1EAE1` warm cream |

Structural corrections that only became visible by cropping and zooming the
reference:
- **All three progress bars are the same green.** I had invented a
  green/gold/coral gradient per row.
- **The streak icon is lavender, not coral**, and the flame sits at the end of
  the bar rather than beside the value.
- **Values are split**: bold achieved number, muted target — "**18** / 25".
- **Chip icons sit beside the text**, not above it, and the leading chip gets a
  solid coral fill while the rest stay tinted.
- The "Up next" heading is near-black, not purple; the clipboard is a character
  with a face and motion ticks, sized to sit inside the card.

"Most improved" now computes its delta over the **current calendar month**, so
the reference's short "+N points this month" wording is actually true. The
sparkline still shows the last 8 takes regardless of date — two different
windows, kept deliberately separate.

## 2026-08-18 (second pass) — Home screen: sidebar + decorative layer

First pass shipped the layout but not the things that actually make the mockup
look like the mockup. Two gaps, both mine:

**The sidebar.** I had scoped it out as "shared, therefore not a home-screen
change". Wrong call — it is the largest thing on screen. `/home` now renders the
rail expanded at 232px with labels, icon tiles, a green active pill, a "Tip of
the day" card with the mascot, and a profile row. Gated on `isHome`, so every
other route keeps the 72px hover rail and this cannot restyle the app.

**The decorative layer** — a warm radial wash top-right, a dot field bottom-left,
hand-drawn ticks by the CTA, floating music notes, sparkles, and the sun/mint
shapes tucked behind the blob's lower-left edge. Notes and sparkles drift on
different cycles so they never pulse in lockstep. The whole layer is
`aria-hidden` and `pointer-events: none`, and is hidden below 760px where it
would land on top of text rather than beside it. The hero blob was also redrawn
asymmetric — the first path was effectively an ellipse and read as a stock shape.

Chip icons are now coloured **by issue type** (intonation coral, rhythm blue,
dynamics green, articulation purple) with the frequency pill keeping its own
scale. Keying both to frequency had made three of four chips identical coral.

**Two CSS bugs worth remembering:**
- `radial-gradient(circle at 40% 45%, …)` defaults to `farthest-corner` sizing,
  so with an off-centre origin the paint was still part-opaque when it reached
  the near box edge — the browser cut it there and left a hard vertical seam down
  the page. `circle closest-side at 50% 50%` guarantees transparency by every
  edge. Found by cropping the corner, not by reading the code.
- The rail's collapsed state hides labels with `max-width: 0`, so setting
  `opacity: 1` alone left the Record CTA as a bare icon. Both properties must be
  released.

**Known deviation:** nav labels stay Overview / Analysis / Sessions / Reports.
The mockup shows Home / Sessions / Progress / Library / Insights; those last two
are not real routes, and inventing dead links would be worse than the mismatch.

## 2026-08-18 — New Home screen (design exploration, shipped as final)

`/home` rebuilt from the user's mockup: sage green + lavender palette, serif
display headline with a hand-drawn underline, illustrated mascot, and a card
grid (progress ring / most improved / up next, then "what Mediant is hearing" +
recent sessions). Every number is real — sessions this month, average score,
streak, score trend, and recurring flag types come from `useTakes`, nothing is
hard-coded from the mockup.

**The new palette is scoped to `.page` in `Home.module.css`, not `index.css`.**
This is an exploration; putting sage/lavender in `:root` would silently restyle
every other screen with no clean way back. The diff is two files plus one new
hook — the rest of the app is provably untouched. `DESIGN_RULES.md` now carries
a note explaining that Home knowingly breaks its "no purple" and "one accent per
screen" rules, so a future agent does not "fix" it back.

**Scope held:** the mockup's 220px labelled sidebar (with tip card and profile
block) was NOT built. The real sidebar is a 72px rail shared by every page, so
changing it is a global change rather than a home-screen one.

**Animation:** one shared `riseIn` keyframe staggered via a `--d` custom
property; dynamic values (ring sweep, bar fills, sparkline draw-in) use CSS
transitions driven by a `useMounted()` flag rather than keyframes. `useMounted`
waits **two** animation frames — with one, React can batch the "from" and "to"
into a single paint and the transition silently never runs.

`prefers-reduced-motion` renders the **finished** state, not a frozen one —
verified the ring reads its real percentage, bars have real width, and cards are
visible. Disabling the animation alone would have left the ring at 0%.

**Mobile bug caught by screenshotting, not building:** the organic blob is a
background SVG behind the help panel. Once the hero stacked, the panel outgrew
the blob's safe area and white text spilled onto the cream page, unreadable.
Below 760px the panel now carries its own gradient background and the SVG is
hidden. Verified no horizontal overflow at 430px.

## 2026-08-16 — "Explain" screen on every flagged issue

An **Explain** button at the bottom of each flagged issue (single-flag and
grouped multi-occurrence cards both), opening a focused screen: a deeper
explanation of that one flag, then a box for follow-up questions. Back button
top-left, Escape also returns. The analysis keeps its scroll position and open
card underneath.

**Depth without length.** A button like this invites a wall of text, so the
prompt states the budget up front: three labelled parts (What happened / Why it
happens / How to fix it), **120 words hard cap**, no preamble, no closing
summary, no praise. "Why it happens" gets the most room — it is the reason the
student tapped — and must be concrete about embouchure, air, fingers, bow or
hands rather than generic.

`activeFlag` now carries the flag's `detail` plus an instruction that the
analysis is measured fact, so the coach can never ask the student what they
played. That is a standing product rule that had only been enforced for the main
chat.

**Implementation notes.** The screen is `position: absolute` inside `.page`, not
`fixed` — a fixed layer slides under AppShell's 72px sidebar, and `/#/demo`
renders outside AppShell so that bug would not show up in the demo. The
animation uses `fill-mode: backwards`, never `both`, because `both` leaves a
permanent transform that would trap any `position: fixed` descendant.

**Three bugs the build could not catch, found by running it:**
- `placeholder="…"` — a `\u` escape in a JSX string *attribute* is not an
  escape and printed literally. It works inside `{}` template literals, which is
  why only the placeholder broke and the header's `·`/`–` were fine.
- The floating orange section-nav arrow rendered on top of the Explain screen.
- Content sat flush against the window edge instead of lining up with the page.

## 2026-08-16 (later still) — Wrong notes: the B♭ transposition, and making it visible

User's diagnosis was right. A take reported "2 semitones away" at m.29 — exactly
the B♭ clarinet interval. CREPE hears *sounding* pitch, the score shows *written*
pitch, and on a B♭ instrument those differ by −2.

The instrument field itself was fine (recent takes hold `Clarinet (B♭)`, the
lookup resolves it to −2, codepoints match). The problem was that **the
transposition decision was invisible**, so diagnosing this meant guessing.

- `pipeline_debug` now carries a `transposition:` line — `declared=… measured=…
  applied=…`, or `CONFLICT …`. Anything that silently rewrites pitches must say
  what it did.
- **The declared instrument now wins** over the DTW-measured offset. The
  declaration is a required, stated fact; the measurement is inferred from an
  alignment that may itself be wrong. Previously the measurement won.
- **Declared vs measured disagreeing by >1 semitone suppresses wrong-note
  detection entirely.** A B♭ player reading a concert score is indistinguishable
  from a broken alignment, and guessing means accusing someone of mistakes they
  did not make.
- A note *exactly* right under the untransposed reading is skipped — that is the
  fingerprint of a transposition artifact, not a mistake.
- Fixed a bug I introduced in the previous pass: `ev["score_pitch"]` is the
  WRITTEN pitch and was not transposed, so evidence could name a note the student
  never saw with a distance that did not match it.

11 new checks in `test_analysis.py` [19]; 82/82 pass.

**Note on the investigation:** I first queried `instrument` on takes, saw NULLs,
and concluded the field was broken. Those were older rows predating the required
instrument box — recent takes were fine. Read the timestamps.

## 2026-08-16 (later) — Wrong-note flags: conservative, and silent when unsure

`find_wrong_note_candidates()` authors its own `error` flags with
`confirmed=True`, so the UI states them as fact. A false "you played the wrong
note" against correct playing costs far more trust than a missed one, so the
detector is now tuned to be conservative and to stay silent when it cannot tell.

**Was wrong:** a single event could flag a measure (no duration floor, no
stability check, confidence ≥50) — so a key click, breath, reverb tail or one
CREPE octave slip became a confident flag. There was no global sanity check, so
a bad score read or alignment made *every* note mismatch and filled the page
with false accusations. Alignment slop was blamed on the student. Evidence named
the nearest note in the bar rather than the note DTW matched.

**Now** a candidate must pass all of: confidence ≥65, `cents_spread` ≤40¢,
inter-onset duration ≥80ms, ≥2 semitones from every pitch in its bar,
pitch-class distance ≥2 (octave displacement is not a wrong note), with
transposition already applied. Then the **global sanity gate**: if ≥12 notes
qualified and >25% look wrong, report nothing and log why — a student does not
play a quarter of their notes wrong, so the detector is what's broken. Output is
capped at 6, ranked by confidence × duration.

**Three design errors the tests caught**, each a plausible idea measurement
killed:
- Judging every note against its bar *plus both neighbours* was far too
  permissive — on scale writing, three bars of pitches cover most of the scale
  and nothing could ever be wrong. Only the first/last onset of a measure gets
  the neighbours now; alignment slop is a boundary phenomenon.
- The duration gate silently disabled the whole detector, because `end_sec` is
  absent on some paths so `dur` computed as 0. Unknown duration now skips the
  gate, not the note. Only caught because a test asserted real wrong notes ARE
  still found.
- `end_sec` is the *next onset*, not note length, so my first 120ms floor would
  have blinded anything faster than a 16th at 120bpm.

10 new checks in `test_analysis.py` [18]; 71/71 pass.

## 2026-08-16 — Concise flag bodies, descriptive sharp/flat titles, real intonation accuracy

### Intonation accuracy (the substantive one)
`cents_offset` was absolute against A=440, so an instrument tuned to A=442 — or
a player sitting a few cents sharp throughout — produced one intonation flag per
measure for a single tuning problem.

- Cents are now measured **relative to the take's own reference pitch** (median
  of confident, stable notes). The overall offset is reported **once**, as a
  tuning matter, when it exceeds 10¢. A note genuinely out of tune against the
  player's own centre still flags — verified by test.
- Pitch is read on the note's **sustained core** (middle 60%), not the whole
  window; attacks scoop and releases sag, worth ~6¢ of false flatness.
- **Median** instead of mean, so one CREPE octave-error frame (~22¢ of drag on a
  mean) cannot move the note.
- Confidence gate 25 → **50**, plus a new spread gate: a note whose pitch travels
  >35¢ has no centre to be sharp or flat of, so it is not flagged.
- `measure_note_pitch()` and `apply_tuning_center()` extracted as pure functions
  so this is testable without audio. 11 new checks, 59/59 passing.

Noted for honesty: the log-vs-Hz averaging correction is in here too, but
measurement showed it is worth ~0.2¢, not the flag-source I first claimed in the
comment. The test failed on my overstatement and both are now corrected.

### Flag bodies are tighter
Coaching bodies were 3 sentences including "why it matters musically" — reliable
filler. Now 2 sentences, 40 words max: what went wrong specifically, then the
fix. The prompt explicitly bans the why-this-matters sentence, restating the
issue type, and opening praise, while requiring that specifics (note names,
beats, cents, hand, direction) are kept — concise means fewer words, not vaguer.

### Sharp/flat titles say what, never how much
Titles were hard-overwritten to bare "Sharp"/"Flat". They now read like "Flat on
the sustained high notes" — direction first, then 2-5 words naming where. Claude's
title is accepted only if it leads with the correct direction word, carries no
number or cents value, and is 2-8 words; otherwise it falls back to the bare word.

## 2026-08-16 (hotfix) — Settings/Signup/Record/AppShell crashed: I overwrote an existing module

`Minified React error #31 ... object with keys {name, family, transpose}` on
Settings. Straightforwardly my fault: `src/lib/instruments.js` **already
existed**, exporting `INSTRUMENTS` as a flat array of name strings, and four
screens (Settings, Signup, Record, and AppShell's profile prompt) render those
directly with `INSTRUMENTS.map(i => <option key={i}>{i}</option>)`. I replaced
the file wholesale with an array of objects, so every one of them tried to render
an object as a React child.

The build passed and the analysis form worked, because this is a runtime type
mismatch in screens I had not opened. I should have checked who imported the
module before rewriting it — the editor even reported the file as *updated*
rather than created, which was the signal I missed.

Fixed by keeping both, with the reason written into the file so the next person
does not repeat it:
- `INSTRUMENTS` — restored verbatim to the original strings. Shape is
  load-bearing; the four screens above map it straight into children.
- `INSTRUMENT_OPTIONS` — the detailed list (name/family/transpose) behind the
  analysis form's type-ahead. It has to be separate because the flat list cannot
  express transposition: "Clarinet" alone does not say B♭, A or E♭, and that
  interval is the difference between a correct reading and a page of false
  wrong-note flags.

Verified all four consumers use the value as a string, and that the public pages
(including Signup, which uses `INSTRUMENTS` identically to Settings) render with
no page errors.

## 2026-08-16 — Required instrument field with type-ahead; fixes wrong-note flags at the source

The submission form never sent an instrument at all. The analysis therefore had
no idea what was being played — which matters twice over: it sets CREPE's
expected pitch range, and it determines whether the part is **transposing**. A
B♭ clarinet sounds a major 2nd below what is printed, so a correctly-played part
read as a page full of wrong notes.

**Form.** New required Instrument combobox, `src/lib/instruments.js` (46
instruments across woodwind/brass/strings/keyboard/voice/percussion, each with
its written→sounding offset):
- Ranked type-ahead: names that START with the query come first, then a match on
  any word, then a substring, then the family. So "c" gives Cello and the three
  clarinets before Bass Clarinet; "clarinet" gives all four; "sax" gives all four
  saxophones; "horn" finds English Horn and Flugelhorn.
- Plain "b" matches "♭", so nobody has to hunt for the flat sign.
- Full keyboard support (up/down/enter/escape), click-to-select, outside-click to
  dismiss, family shown on the right, tick when set. Analyze stays disabled until
  an instrument is chosen. Free text is still allowed for anything not listed.

**Worker.** `INSTRUMENT_TRANSPOSE` + `transpose_for_instrument()`, matched against
the same names the form sends and tolerant of free text ("Bb Clarinet 1" → -2).
The declared instrument is used as a **prior**, not an override: the measured
offset (median difference against the DTW-matched note) still wins when there is
enough evidence, since a student may be reading a concert-pitch part on a
transposing instrument. The declared value fills in when the measurement cannot
be made, and a disagreement between the two is logged rather than hidden.

Verified: search ranking across nine queries, transposition lookup across twelve
instruments including free text and unknowns, and the form end-to-end in a
browser (Analyze correctly disabled until an instrument is picked; keyboard
selection sets the value). Suite: 48 checks.

## 2026-08-16 (hotfix) — NameError shipped; added a static check that would have caught it

`Analysis failed: name 'time_sig_hint' is not defined`. My time-signature change
used a variable belonging to a **different function** (`analyze`), not to
`run_full_analysis`. Syntax was valid and all 47 tests passed, because no test
executes `run_full_analysis` — it needs real audio and API keys. So the crash
went straight to production.

Ran pyflakes over the whole module and it found **two more landmines I had
introduced in the same session**, neither of which any test would have reached:
- `tempo_bpm` used inside `_timeline()` — that name does not exist there; the
  function receives a `tempo` dict. Would have crashed whenever the tempo could
  not be derived from the anchors.
- `re.match` in `run_full_analysis` — `re` is imported inside other functions,
  not at module level. Replaced with a plain split/isdigit check rather than
  adding an import, since the validation is trivial.

Added **test [0]: a static undefined-name check** over the entire worker, wired
into the suite ahead of everything else. Unit tests only cover code they execute;
a NameError in an unexercised branch is invisible to them but fatal in
production. This reads the whole module, including paths no test touches.

Suite: 48 checks. Requires `pyflakes` (the test reports clearly if it is missing
rather than silently passing).

## 2026-08-16 (four fixes) — form wins, transposition, run-up in timing, hand naming

**1. The form's time signature and measure range now win over the vision read.**
The reader is a probabilistic look at a photo and had returned 2/4 for a page
that plainly reads 3/4; a wrong beats-per-measure corrupts the beat axis, the
timeline and every derived measure number. The typed value is used whenever it
parses, the read only fills in when nothing usable was supplied, and a
disagreement is logged. The score is also windowed to the typed measure range, so
a read that invents measures outside what was played cannot widen what DTW aligns
against.

**2. Wrong-note flags on a transposing part.** `find_wrong_note_candidates`
compared CREPE's SOUNDING pitch against the score's WRITTEN pitch. This part is
"B♭ CLARINET 1" — written pitch sounds a major 2nd lower — so essentially every
correctly-played note read as ~2 semitones wrong. Rather than hard-code an
instrument table (which breaks on octave choices, capos, or a student reading a
concert-pitch part), the offset is now measured: the median semitone difference
between each played note and the score note DTW matched it to. A real
transposition is a tight cluster; scattered wrong notes leave the median at 0,
and it only applies when ≥60% of notes agree, so genuine mistakes are not masked.

*Worth remembering:* the first version compared against the NEAREST note in the
bar and silently failed — on stepwise writing a 2-semitone shift lands on a
neighbouring scale degree that is also in that measure, so the difference reads 0
and the transposition stays invisible (diffs split evenly between -2 and 0,
median 0). Using the DTW-matched note gives a clean -2. The test caught this.

**3. "Late arrival" on the opening downbeat.** The timing analysis was fed events
captured while the player was still getting ready; they sit before the first note
but still match a score note, so the tempo fit began early and the opening was
judged late against the run-up rather than against the playing. It now receives
only events at or after where `_timeline()` says the music starts — reusing that
one definition rather than inventing a second.

**4. Naming the wrong hand.** Gemini reported tension in the "right hand" when
only the left was in frame. Screen position cannot settle this — a camera facing
the player mirrors them, and phone front cameras often mirror again. The prompt
now requires the hand to be identified by its position ON THE INSTRUMENT, which
is invariant to camera angle (for clarinet/sax/flute/oboe/recorder the upper hand
is the left), to say left/right from the player's own perspective, never to
describe a hand that is not visible, and to say "the visible hand" rather than
guess a side.

Suite: 47 checks.

## 2026-08-16 (run-up) — the loop still opened on the preparation. Root cause found in the logs.

The lead-in trim shipped earlier today did not take effect, and the reason was
not the trim — it was the safety net I added alongside it. Modal logs:

    [measure_timeline] REJECTED tier=dtw_onsets: measure spans range
    0.35-15.12s against a median of 0.84s — alignment is untrustworthy
    [measure_timeline] tier=dtw_onsets+rejected_uneven m.20-37

The score read is still poor (18 of 62 measures covered), so DTW came out
lopsided, the sanity gate correctly rejected it — **and the even-distribution
fallback then spread measures from t=0**, putting the entire run-up inside m.20.
The trim was applied to the anchors it discarded. A take shipped with m.20's
loop starting at 0.00s.

Three fixes, all on the "measures begin at a note" rule:
1. **The even fallback now starts at the first note**, not at zero: it spreads
   measures across the part of the recording that actually has music.
2. **Anchors require a confident event.** A measure was anchored on its first
   event of any kind, so a low-periodicity blip (breath, key noise, stand knock)
   inside a bar pulled its start earlier than anything audible. Now `confidence
   >= 50`, falling back to any event only if a take has nothing confident.
3. **A hard floor on every path**: whatever tier produced the timeline, if the
   first measure starts before the first note the whole timeline is shifted so it
   does not. Logged when it happens.

Two new tests, both from this failure rather than invented: a run-up combined
with a *rejected* alignment (the exact production shape — the earlier lead-in
test passed because its alignment was healthy), and a measure whose first event
is a blip rather than a note. Suite: 41 checks.

**Still outstanding:** the score read remains the weak link — 62 measures for
this page, DTW covering only 18. Measure *placement* is now correct and
guaranteed against the audio, but placement can only be as good as the numbering
underneath it.

## 2026-08-16 (hotfix) — score upload broke on the second upload of the same photo

`Analysis failed: Sheet music upload failed: new row violates row-level security
policy`. Self-inflicted by the content-hash change earlier today.

Naming score objects by their content hash means uploading the same photo twice
targets the same path — and I paired that with `upsert: true`. Upsert issues an
**UPDATE** when the object exists, but the storage policies grant INSERT, SELECT
and DELETE only (confirmed: zero UPDATE policies on `storage.objects`). So the
first upload of a photo succeeded and every subsequent one failed RLS. The
content-hash change is what made a repeat path possible at all, so this could not
have happened before it.

Fixed by dropping back to `upsert: false` and treating a duplicate as success —
which is not a workaround but the correct semantics here: the path *is* the
file's content hash, so an object already at that path is byte-identical and
there is nothing to re-upload. Matches both shapes Storage returns (`statusCode`
409 as string or number, and the "already exists"/"Duplicate" message), while a
genuine RLS or network error still fails loudly. Verified the guard against all
four error shapes, including that it does NOT swallow a real RLS message.

Deliberately did not add an UPDATE policy: that would widen write permissions on
every user's stored files to fix a case that should never write at all.

## 2026-08-16 (hard invariant) — the Loop is now guaranteed to play the flagged measure

Found the remaining guaranteed-mismatch path and then made the whole class of
bug unshippable rather than fixing one more instance of it.

**The path.** `measure_to_time_range()` did `idx.get(int(m0)) or tl[0]`. Any flag
whose measure was not in the timeline — Gemini's own printed number, or a number
parsed out of free text, neither of which is bounded by anything — silently
resolved to **the first measure's window**. So the flag said m.30 and the Loop
played bar one. Now clamped into the timeline instead of falling back.

**The guarantee.** A final pass runs over every flag before it is returned. It
asks the canonical timeline which measure the flag's Loop window *actually*
plays, and if that disagrees with the label, **the label is corrected** — never
the other way round. The Loop window is authoritative because it is what the user
hears; a flag pointing at the bar you can hear is useful, a flag pointing at a
bar that never plays is not. Any correction is logged with both values.

This means no future upstream change — a new flag source, a different score
reader, another alignment tier — can reintroduce a label/audio mismatch. It is
checked at the exit, not trusted along the way.

**Adversarial test.** Test 11 feeds deliberately corrupt measure numbers (999, 0,
41, 12345) and asserts that every emitted flag's Loop window really is the
measure(s) it claims, using a timeline rebuilt the same way the worker builds it.
Suite is 38 checks.

## 2026-08-16 (final) — Measures start at the music; measure = the matched note

Two requests: the first measure was being labelled over the seconds spent
preparing to play, and issue measures should come from actually reading the
notes rather than from elapsed time.

**Run-up no longer counts as the first measure.** CREPE emits low-periodicity
events while the player settles, breathes and adjusts, and whichever measure they
landed on absorbed the whole lead-in — so m.20 started seconds before a note was
played. The timeline now ignores everything before the music starts, defined as
the first confident event with **at least three** confident events in the
following two seconds. Density is the point: a phrase opens with several notes in
quick succession, a key click does not. The first rule tried ("followed by
another within 2s") was caught by its own test — an isolated click 1.6s before
the real entry still qualified and opened the piece early.

**Measures now come from the notes.** DTW already matched each played note to a
note in the score, but that answer was being discarded:
- intonation resolved its measure with `time_to_measure(t)` and only fell back to
  the event's own matched note — backwards, since the event *is* a matched note
- Gemini's findings were placed purely by timestamp

Both now use the note correspondence first. New `measure_from_notes(t)` snaps a
moment to the measure of the nearest DTW-matched note (within 1.5s, else it
declines and the timeline answers). Time lookup says "what should be sounding if
the tempo held"; the note match says "which written note *was* sounding" — which
is what a teacher means by "the issue is in bar 24". They agree in steady playing
and diverge exactly where it matters: after a hesitation, a dropped note, or any
rubato.

Test suite is 35 checks, adding lead-in trimming (with the isolated-click case
that broke the first attempt) and note-derived measures across a hesitation.

## 2026-08-16 (later) — The score read was non-deterministic; that was corrupting everything

Reported: flag measure still not matching the Loop clip. Pulled the take apart
rather than guessing, and the timeline rework was working correctly — it was
being fed garbage.

**Evidence from the take.** Flag m.20 carried a Loop window of **2.00-19.28s**, a
seventeen-second "measure", while m.21, m.22, m.23 were each about one second.
The score read for that run reported **54 measures** and a **2/4** time
signature, with numbering `12…35, 40…51, 55…72`. Downloaded the actual page to
check: it is plainly **3/4**, opens with an 11-bar multirest, first sounded bar
is boxed **12**. Earlier runs of the SAME image read 64 and 68 measures, and 3/4.

**Root cause.** Two compounding problems:
1. `read_score_notes_claude` ran at the API's default `temperature` (1.0).
   Reading a score is deterministic extraction, not a creative task — at 1.0 the
   same photo parses differently every run, and every wrong measure count / time
   signature flows straight into numbering and alignment.
2. `score_cache` is keyed on `score_path`, but the upload named objects
   `${Date.now()}-${filename}` — so a re-uploaded photo got a new path every
   time and the cache could **never** hit. Each run paid for a fresh, differently
   wrong read.

**Fixes.**
- `temperature=0` on the score read.
- Score uploads are now named by **SHA-256 of the file content**, so an identical
  photo reuses one cached parse: consistent measure numbers run to run, and no
  repeated vision cost or latency. (The cache read/write machinery was already
  correct; it just had a key that could never match.)
- Logs the parsed time signature next to the hint, so a misread is visible in the
  take record instead of only in Modal logs.
- **Sanity gate on the timeline.** Anchors are only as good as the alignment
  behind them. If any measure's span exceeds 4x the median, the alignment is
  rejected and an even distribution is used instead. A Loop that plays seventeen
  seconds labelled as one bar is never musically real, and the user should not be
  shown it even when the score read fails.

Test suite is now 32 checks, including the exact lopsided-timeline shape from
this take. Deployed (worker + frontend).

## 2026-08-16 — Reworked the measure/time model onto one canonical timeline

Asked to stop patching symptoms and rebuild this properly. Architecture note:
`Knowledge/Analysis — measure timeline architecture.md`.

**The actual defect.** `time_to_measure()` and `measure_to_time_range()` were two
~70-line functions, each walking the same seven-tier ladder (DTW ranges → scaled
beats → two-point map → uniform tempo → raw beats → …), kept mirrored by hand,
with comments asserting they could never disagree. They disagreed constantly,
because **each resolved its tier independently per call** — a flag could be
labelled from the DTW tier while its Loop window came from the beat-grid tier.
Every symptom this week was that one defect: wrong measure numbers, Loop not
matching the label, Loop not cutting off correctly, posture on the wrong bar.
Patching them one at a time never converged, and two of those patches each
introduced a fresh off-by-one.

**The rework.** `build_measure_timeline()` produces ONE contiguous,
non-overlapping array of `{measure, start, end}` covering the played range,
where every `end` is the next measure's `start`. The tier is chosen once, turned
into anchors, and everything — labels, Loop windows, posture, span merging —
reads that array. Disagreement is now structurally impossible rather than
something to keep re-fixing. ~180 lines of duplicated ladder became ~120 lines
with one source of truth.

Measures with no anchor (rest bars, multirests, missed detections) are
interpolated **on the measure-number axis** between neighbours, so they get real
bounds instead of falling through to a different model — and an 11-bar multirest
occupies eleven bars of time instead of collapsing.

**The three reported issues, fixed via the framework rather than around it:**
- *Loop not cutting off at the right measure* — a measure used to end on its last
  note's ONSET, truncating that note and leaving a gap before the next measure.
  It now ends exactly where the next begins; the final measure runs past its last
  note.
- *Posture flags on the wrong measure* — posture and technique are body
  observations, not events; you do not slouch for one bar. Pinning them to
  whichever measure held a timestamp (or to `measure_lo` when there was none) was
  arbitrary by construction. They now span the passage, or an explicit range when
  Gemini gives two timestamps.
- *Multi-measure flags for continuous issues* — a strictly consecutive run of the
  same type AND direction merges into one span carrying the worst magnitude in
  the run. Deliberately conservative: an isolated measure stays separate, the
  same fault recurring with gaps stays separate, and a flag with no direction
  (Gemini free text) never merges — a wrong merge invents a span that was never
  observed.

**Stopped flying blind.** Added `modal_worker/test_analysis.py`: 29 ground-truth
checks over a synthetic performance shaped like the real clarinet part (printed
numbering from 12, a 2-bar multirest at 37→40). No audio, no API keys, no
network. It asserts the contract the UI depends on — spans tile the timeline;
every flag's Loop window lies inside its own measures; Loop covers the measure
through its final note without spilling past it; printed numbering and multirests
survive; continuous runs merge and unlike ones do not — plus degenerate anchor
inputs (dense/sparse/single/none/inverted). **Run it before touching anything
measure-related.** The two off-by-ones from earlier this week would each have
been caught in seconds.

Verified: 29/29 checks pass, and the seven timing scenarios (clean, late entry,
rushed/dragged half, held note, gradual accelerando, human jitter) all still
report the same correct root cause. Deployed to Modal.

## 2026-08-15 (final) — Score reader was overwriting the printed measure numbers

Reported: "it says measure 30 while the clip shows measure 20". Diagnosed by
dumping the take's stored measure numbers, which came back as
`20,21,22,…,87` — a perfectly consecutive run starting at exactly
`start_measure`. That is not what the page says.

**Cause:** `read_score_notes_claude` ended with

    if measures and measures[0].get("number") != start_measure:
        for i, m in enumerate(measures):
            m["number"] = start_measure + i

so every measure number Claude read off the page was thrown away and replaced
with a consecutive run from the student's start measure. Two independent things
break:

- `start_measure` is where the **student began playing**, not where the
  **photo** begins. Downloaded the actual score image to confirm: it is the full
  first page, and the first sounded bar is printed **12**. Renumbering it to 20
  shifts every label by 8 immediately.
- Consecutive numbering cannot represent **multirests**, and this part is full of
  them — it opens with an 11-bar rest and has 2-, 2- and 4-bar rests later. Rest
  measures consume numbers but are (correctly) not emitted, so true numbering has
  gaps and the offset *grows* through the piece. Hence m.20 reading as m.30.

Fixes:
- Removed the renumbering. Printed numbers are kept as read; only entries that
  are missing or non-monotonic get repaired, and only to the smallest sensible
  value.
- Rewrote the numbering section of the prompt: printed numbers are the sole
  source of truth, a multirest consumes N measure numbers, gaps in the output are
  expected and correct, and a perfectly consecutive run is the signature of the
  bug. The no-printed-numbers fallback now starts at 1 rather than at
  `start_measure`.
- `flatten_score_notes` now derives `abs_beat` from the measure **number** rather
  than order of appearance. With real numbering gaps, counting appearances would
  collapse an 11-bar rest to zero beats and make the timing fit think the player
  jumped ahead.
- Logs the measure range and gap count, and warns explicitly when numbering comes
  back perfectly consecutive from `start_measure` — the exact signature of this
  bug, so it can never again be invisible in the take record.

Verified: printed numbering with a multirest gap (…37, 40…) survives intact;
malformed and non-monotonic entries are repaired; `abs_beat` advances 9 beats
across a 2-bar rest in 3/4 as it should; DTW still labels a windowed take 54/54
exactly. Deployed.

## 2026-08-15 (later still) — Flag measure numbers disagreed with the Loop clip

Reported: "the clip played in Loop does not match the measure number". Both come
from `alignment_ranges`, so the ranges' shape had to be wrong twice over — and it
was, for two separate reasons.

`alignment_ranges` were built as the min/max of detected note ONSETS in each
measure, then padded to `start + 0.9 * nominal measure`. That gives ranges which
are neither contiguous nor reliably non-overlapping:

- The padding could **overlap** into the next measure. `time_to_measure` returns
  the FIRST range containing the timestamp, so notes belonging to m+1 were
  labelled m — the number and the clip disagreed.
- Onset min/max ends a measure on its **last note's onset**, so the loop cut that
  note off, and the space before the next measure's first onset was a **gap**.
  Timestamps landing in a gap fell through to the beat-grid tier, a completely
  different measure model from the one the Loop window uses. Measured on a
  representative 18-measure take: **17 gaps, ~25% of sampled timestamps
  mislabelled**.

Ranges are now chained — each measure ends exactly where the next one's first
onset begins — so they are contiguous and non-overlapping, the loop includes the
measure's final note, and nothing can fall through to a different tier. A gap in
measure *numbers* (measures where nothing was detected) is capped at one nominal
measure so a single range can't swallow the rest.

**Caught while verifying:** making the ranges contiguous introduced an
off-by-one. With `end == next start` and an inclusive `<=` on both bounds, every
downbeat matched the *previous* measure first. Test injected sharp notes in m.25
and m.33 and got flags on m.24 and m.32. `time_to_measure`'s DTW lookup is now
half-open `[start, end)`, with the final range left inclusive so the last note of
the piece still lands. Re-tested: flags land on exactly m.25 and m.33, and zero
flags have a timestamp outside their own measure's Loop window.

## 2026-08-15 (later) — Measure numbers were wrong: DTW ignored the played range

The streaming fix worked — this take shows `score_parse: 64 measures` and
`alignment: score_dtw` for the first time. That immediately exposed the next
bug: **`start_measure` was declared as a `dtw_align_to_score` parameter and never
used in the body.**

DTW warps the whole audio onto the whole note sequence it is handed. The photo
of two pages contained 64 measures; the take covered 18 of them (m.20–37). So
those 18 measures were stretched across all 64, and the traceback additionally
forced the path onto the score's final note. Reproduced exactly: a performance
of m.20–37 came out labelled **m.1–19, 0/54 measure numbers correct**. With the
fix it is m.20–37, **54/54 correct**.

Three changes:
- `flatten_score_notes` takes a `start_measure`/`end_measure` window, so DTW only
  ever sees the measures the student said they played.
- Open-**end** traceback: start from the best-scoring column of the last row
  instead of the score's final note, so a take that stops partway (or one where
  we could not determine an end measure) is not stretched to fill the score.
  Verified identical results with and without an `end_measure`.
- DTW now stamps the matched score note's own data (`score_beat`,
  `score_dur_beats`, `score_abs_beat`, `score_pitch`) directly onto each event,
  and `analyze_timing_vs_score` reads those instead of re-deriving the note list.
  It previously re-flattened the score itself — which, the moment windowing was
  introduced, would have produced a *differently filtered* list and misattributed
  every timing residual to the wrong note. Removing the index coupling makes that
  class of bug impossible rather than merely fixed.

Re-verified end to end afterwards: a take with m.30 entered late and m.36–37
rushed produces timing flags on exactly those measures, all inside the played
window, and a clean take with ±20 ms jitter still produces none. Deployed.

## 2026-08-15 — Retry transient Gemini failures instead of losing the take

Reported: `Analysis failed: All Gemini models failed. Last error: gemini-2.5-pro
→ HTTP 503 ... "This model is currently experiencing high demand."`

A capacity spike on Google's side, not our bug — but the handling was brittle.
`evaluate_with_gemini` attempted each model/config **exactly once with no
backoff**, so a momentary 503 (the error text literally says "spikes in demand
are usually temporary") failed the whole analysis and threw away the upload,
making the student re-record for nothing.

Added bounded retry around the Gemini POST:
- retries only genuinely transient statuses (408/429/500/502/503/504); a 400 or
  401 still fails immediately rather than burning the budget on a request that
  will never succeed
- exponential backoff with jitter (~1.5s, 3s), max 3 attempts per model/config,
  honouring `Retry-After` when the server sends one
- a global 100s sleep budget so retries can't run past the 300s Modal function
  timeout — worst case adds ~20s across all models/configs

Also replaced the user-facing message for 429/503 with a plain-language one
saying the provider is temporarily at capacity and the recording uploaded fine.
The old text surfaced a raw provider JSON blob, which reads like the upload was
broken and invites a pointless re-record.

Verified the retry logic against a mocked transport: 503→200 retries once and
succeeds; persistent 503 stops at 3 attempts with growing backoff; a
non-transient 400 is not retried at all; 429 is retried. Deployed to Modal.

## 2026-08-14 (later) — Score read: my own max_tokens fix broke it harder

The previous entry raised `read_score_notes_claude` to `max_tokens=32000` to
stop long scores truncating. That made things worse: above roughly 20k the
Anthropic SDK **refuses a non-streaming request client-side**, before it is even
sent —

    ValueError: Streaming is required for operations that may take longer than
    10 minutes.

So the score read went from "truncated, parse fails" to "never runs at all", and
`score_parse: 0 measures` persisted for the same downstream reason (no
`score_idx` → no DTW → objective timing skipped entirely).

Reproduced the guard directly against the installed SDK: `max_tokens` 8192 and
16000 send fine (fail only on auth with a fake key); 32000 raises the ValueError
without any network call.

Fix: the score read now uses `client.messages.stream(...)` +
`get_final_message()`, which is the supported way to request a long generation.
Verified `messages.stream` / `get_final_message` exist in the SDK before
deploying. The truncation salvage from the previous entry stays as a safety net.

**Also made this class of failure diagnosable from the DB.** A failed score read
silently disables DTW, objective timing and wrong-note corroboration, but
`pipeline_debug` only said `score_parse: 0 measures` with no reason — which cost
a round trip to Modal logs both times. `read_score_notes_claude` now returns an
`error` field and the debug line reads
`score_parse: 0 measures — FAILED: <reason>`.

## 2026-08-14 — Score reads were failing silently; end of piece was unreachable

Reported as "still fails to capture timing flags, and it skipped the flags at
the end of the piece". Diagnosed from the take row + Modal logs rather than by
guessing, and both turned out to be upstream of the timing work shipped
yesterday.

**Root cause 1 — the sheet music was never being read.** `pipeline_debug`
showed `score_parse: 0 measures` and `alignment: beat_grid`, and the Modal log
showed `[read_score_notes_claude] no JSON`. `read_score_notes_claude` asks for
one JSON object *per note*, but ran with `max_tokens=8192` — a couple of pages
overflows that, the reply is cut off mid-object, and the resulting unbalanced
JSON fails to parse. The whole score was then discarded (not just the tail),
which cascaded:
- no score notes → DTW declines → `beat_grid` alignment → **no `score_idx` → the
  entire new timing analysis is skipped**, so zero timing flags;
- no score → no wrong-note corroboration, so Gemini's 8 wrong-note findings were
  culled too (the take had 15 Gemini rhythm issues and 0 survived).

Fixes: `max_tokens` 8192 → 32000, and `extract_json_object` now falls back to
`repair_truncated_json`, which walks the text tracking string/escape state,
truncates at the last cleanly-closed element and re-closes the open brackets —
so a truncated read salvages the measures it did complete instead of losing
everything. Also logs `stop_reason` and the response **tail** (head-only logging
is useless for truncation — the head always looks fine).

**Root cause 2 — the end of the piece was outside the measure map.**
`anchor_end` was estimated only from the beat grid and Gemini's issue span, and
never from the parsed score. Both of those are really "as far as I noticed", so
they systematically under-shoot; measures past that point fall outside the
two-point map and cannot be flagged at all. The score — which literally lists
its measures — was never consulted. It is now one of three estimators, and the
combiner takes the **largest**: all three are lower bounds, under-shooting
silently truncates the report, while over-shooting only adds empty measures
nobody flags. Deliberately not "prefer the score", because a salvaged partial
read can itself under-shoot.

Verified: `repair_truncated_json` unit-tested at four truncation points (7/12/16/19
measures salvaged), on garbage, on fenced input, and on brackets inside string
literals; pipeline test confirms a flag now lands on the final measure (m.38)
and the end estimate reads `score=38`. Clean take with jitter still yields 0
flags. Deployed to Modal.

## 2026-08-13 — Objective timing analysis: CREPE+DTW now owns timing

Reported as "almost nothing on timing". It wasn't under-tuned — timing was
structurally unable to fire. Full write-up in
`Fixes/Fix — Objective timing analysis (DTW residuals).md`.

**Root cause.** Timing flags were only ever *authored* by Gemini's subjective
`rhythm_issues`; the only corroborating signal was a hesitation detector that
fires on a `>0.8 s` gap; and unconfirmed issues are dropped outright. So a
timing flag survived **only if the player paused for over 0.8 s**. Rushing,
dragging, a note 120 ms late, wrong note lengths — detected by nobody.

**Fix.** `analyze_timing_vs_score` diffs performed onsets against the score's
expected beat positions using the DTW note correspondence that already existed
(`dtw_align_to_score` was resolving the matching score note and then discarding
everything but its measure number). No transcription-to-notation: alignment is
a solved problem, transcription isn't. Emits placement (early/late ≥110 ms),
drift (local vs established tempo ≥7%), duration (≥1.65x / ≤0.60x written
length) and a piece-level accelerando/rit. — all with measured numbers, so they
are `confirmed=True` by construction and survive the cull.

Three findings worth remembering, all caught while testing:
- **Drift is measured against the tempo the player established, not the global
  average.** With a steady first half and a rushed second half the global fit
  lands between them, so the *steady* half got reported as "dragging".
- **One explanation per measure, placement > duration > drift.** A late entry
  compresses the preceding note (spurious "too short"); a held note skews its
  measure's tempo fit (spurious "rushing"). Reporting the side-effect sends the
  student after the wrong fix.
- **The no-evidence guard had to move.** `compare_and_coach_claude` bailed early
  when CREPE and Gemini both found nothing — but an in-tune, right-notes,
  un-commented-on take can still be rhythmically wrong, which was exactly the
  reported bug. Timing now counts as evidence in its own right.

Also: measured timing findings now outrank Gemini's for the same measure in
dedup (`_priority`), and `evidence_candidates[:8]` — which truncated in measure
order, intonation first, so it meant "the first couple of measures only" — is
now sorted by magnitude and raised to 16.

Verified by unit-testing the math against 7 synthetic performances and running
`compare_and_coach_claude` end-to-end with `anthropic` mocked: a take with zero
intonation/note/Gemini evidence now produces 4 timing flags where it previously
produced 0, and a clean take with ±25 ms human jitter still produces none.
**Thresholds are first-guess conservative and should be revisited once real
analyses accumulate.** Deployed to Modal.

## 2026-08-13 — New-recording modal: removable uploads, no tags, everything required

- **Removed the Piece / Warm-up / Sight-read chips** and the `tag` state behind
  them. That state fed `notes: "Session type: …"` into the analyze request, so
  that line is gone too — no other consumer referenced it.
- **Removed the REQUIRED / OPTIONAL BUT RECOMMENDED badges** and their CSS.
- **Sheet music is now genuinely required**, matching "everything is required":
  `readyToAnalyze` is `performanceFile && scoreFiles.length > 0`, so Analyze
  stays disabled until both a performance and at least one score page are
  attached. *This is a real behaviour change* — takes could previously be
  analysed with no score at all.
- **Uploads are now removable.** `UploadCard` takes an optional `onRemove` and
  layers a trash control on the card, so the video/audio can be cleared rather
  than only replaced. Sheet music gets a numbered row per page, each with its
  own delete — and the card itself now *adds* pages instead of replacing the
  selection (its hint copy is overridden via a new `activeHint` prop, since the
  default "Click to replace" contradicted that).

Two details worth keeping:
- Clearing a file also resets `input.value`. Without that, re-picking the *same
  file* fires no `change` event and the upload silently appears to do nothing —
  verified by removing and re-adding the identical video in the test.
- The remove control on a card is a `<span role="button">`, not a `<button>`:
  the card is itself a `<button>`, and nesting interactive elements is invalid
  HTML that React warns about and browsers recover from inconsistently. Clicks
  are `stopPropagation`'d so removing doesn't also reopen the file picker.

Verified end-to-end against an isolated instance of the modal: chips and badges
gone, Analyze disabled with nothing / with video-but-no-score / after removing
either, pages append rather than replace across successive picks, removing a
middle page renumbers the rest, and the same file is re-addable after removal.

## 2026-08-13 — Nav arrow centred against the whole viewport

The arrow is positioned against `.page`, which starts *below* AppShell's 56px
sticky top bar — so `top: 50%` centred it within that box, leaving it 28px
(half the bar) below the true middle of the window. Changed to
`top: calc(50vh - var(--topbar-h))`, which puts its centre on 50vh exactly.

Introduced `--topbar-h: 56px` on `.page` and switched its own
`height: calc(100vh - 56px)` to use it, so the arrow's offset and the page
height can't drift apart if the bar height ever changes.

Kept `position: absolute` rather than switching to `fixed` (which would centre
trivially) — `fixed` measures from the window edge and tucks the left-hand
arrow under the sidebar, the bug fixed in the previous entry.

Verified inside a real AppShell at three viewport heights (720/900/1100): the
arrow's centre matches the viewport centre exactly (delta 0 in all six
analysis + summary cases), stays clickable, and stays clear of the sidebar.
The ≤960px bottom-corner FAB is unchanged — a centred floating button would
cover content on a phone.

## 2026-08-13 — Fix: summary nav arrow was hidden behind the sidebar

The previous change made the summary-view nav arrow `position: fixed` so it
wouldn't scroll away. But `fixed` resolves against the **viewport**, so
`left: 16px` put it at 16px from the window edge — directly underneath
AppShell's 72px sidebar (`z-index: 200`), which covered it completely. The
arrow simply vanished on the summary view.

Reworked so the arrow never needs `position: fixed` on desktop:
- `.pageSummary` no longer unlocks `.page`'s height. `.page` stays fixed-height
  with `overflow: hidden`, so the arrow stays `position: absolute` against it —
  and because `.page` starts *after* the sidebar, `left: 16px` is measured from
  the main column, safely clear of it.
- Instead, `.pageSummary` makes `.page` full-bleed (`max-width: none`, no side
  padding) so `.lockedBodyScroll` spans the whole main column and its scrollbar
  still lands on the window's right edge. The gutters moved onto the scroller
  (`padding: 0 80px` — padding sits *inside* the scrollbar, so it doesn't push
  it inward) and the 1280px content cap onto its children, which reproduces the
  analysis view's content box exactly. Measured: identical 176px gutters either
  side, matching the analysis view.
- The ≤960px FAB still uses `position: fixed`, and had the same defect between
  761–960px where the sidebar is still on screen — `.sectionNavArrowLeft` is
  now `left: 88px` there, reset to `16px` below 760px where the sidebar is
  replaced by the bottom nav.

**Testing note worth remembering:** `/#/demo` renders *outside* AppShell, so it
has no sidebar and no `.pageIn` — it cannot catch this class of bug, and it
reported everything green while the real page was broken. Verified this time by
temporarily adding a throwaway route that mounts `<AppShell>` around the demo
Analysis (auth bypassed), checking `elementFromPoint` hit-testing at the arrow's
centre, then removing the route. Note such a route also triggers the "what
instrument do you play?" onboarding modal (`z-index: 1000`), which blocks clicks
and must be dismissed in the test — that overlay is a bypass artifact, not a bug.

## 2026-08-12 — Summary scrollbar moved to the window edge (+ a latent position:fixed bug)

The summary's scrollbar was hugging the cards because the scroller was
`.lockedBody`, nested inside `.page`'s centered, 80px-padded box — so its thumb
rendered at that inner edge. Fixed by handing scrolling all the way up: in the
summary view `.page` drops its fixed-height/no-scroll lock (`.pageSummary`:
`height: auto; min-height: calc(100vh - 56px); overflow: visible`) and AppShell's
`.main` — full width, sidebar to window edge — does the scrolling. Analysis view
is untouched and still fully locked.

**Found and fixed a latent bug this depended on.** With `.page` no longer a
fixed-height box, the floating nav arrow has to be `position: fixed` or it
scrolls away. But AppShell's `.pageIn` used `animation: … both`, and
`fill-mode: both` keeps the final keyframe applied forever — including its
`transform: translateY(0)`. A non-`none` transform makes an element a
containing block for `position: fixed` descendants, silently pinning them to
that box instead of the viewport. Confirmed in an isolated repro: under
`both` the ancestor keeps `matrix(1,0,0,1,0,0)` and a fixed child renders at
the ancestor's offset (top 8) rather than the viewport (top 0); under
`backwards` the transform is `none` and the child pins correctly.

Changed `.pageIn` to `animation-fill-mode: backwards`. The final keyframe's
values (`opacity: 1`, `translateY(0)`) are the natural defaults, so this is a
visual no-op and the entrance animation is unchanged — `backwards` still
applies the `from` state up front.

Worth flagging because **the demo route would never have caught this**:
`/#/demo` renders outside AppShell, so there's no `.pageIn` there and the arrow
tested fine while the real logged-in page would have been broken. It also
silently repairs the ≤960px mobile FAB, which had the same defect.

Verified: summary uses the document scroller with no nested scroller, arrow
stays put at scrollTop 300 on both desktop and mobile, analysis view still
locked with a pinned header, landing page unaffected.

## 2026-08-12 — Header is part of the scrolling page in the summary view

Replaces the mask-fade patch from earlier today. That treated the symptom (a
hard clip line under a pinned header); the actual ask was for the header to be
part of the page rather than something content slides beneath.

Restructured so the scroll boundary moves up instead of being disguised: the
demo banner, piece chips, and session header all moved *inside* `.lockedBody`,
and `.lockedBody` became the flex-column scroller (`.lockedBodyScroll`,
applied only when `inSummaryView`). Consequences:
- **Summary view:** `.lockedBody` scrolls, so banner/chips/title/date scroll
  away with the content — one continuous page, nothing pinned above it for
  content to be sliced under. `.summarySection` is no longer a scroller itself
  (`flex: none; height: auto; overflow: visible`) and the mask/`padding-top`
  fade pair is gone entirely.
- **Analysis view:** `.lockedBody` doesn't scroll, so everything stays exactly
  where it was — verified the title doesn't move while the issues list scrolls,
  and nothing overflows the box.
- `.twoPanel` switched from `height: 100%` to `flex: 1; min-height: 0` — it's
  now a flex child *below* the header, so it has to claim the leftover space,
  not the parent's full height (which would have overflowed by exactly the
  header's height).

The nav arrow stays absolute against `.page` (still fixed-height, still
`overflow: hidden`), so it doesn't scroll away with the content — verified
on-screen at scrollTop 200.

## 2026-08-12 — Summary content no longer looks like it collides with the header

Reported as "the header goes on top of the other texts". It never actually
overlapped — measured a 10px gap between `.sessionHeader`'s bottom and
`.lockedBody`'s top, and `.sessionHeader` has no background to paint over
anything. The real problem was that `.summarySection` is a scroll container
whose top edge sat only 10px under the header, so scrolled content was
guillotined mid-glyph right beneath the date (half-height "45", "18", "28"…),
which reads as the header sitting on top of it.

Fixed with a top fade instead of a hard cut: `.summarySection` gets
`padding-top: 20px` plus a matching `mask-image: linear-gradient(to bottom,
transparent 0, #000 20px)`. The two sizes are a pair and must stay in sync —
because the first 20px is padding, nothing is visibly dimmed at rest
(scrollTop 0 still shows "SUMMARY" / "Your progress at a glance" at full
opacity); the fade only bites once content scrolls up into that band, which is
exactly when it's wanted. Also nudged `.sessionHeader` margin-bottom 10 → 14px
for a bit more separation.

The mask is explicitly disabled in the ≤960px block: there's no scroll
container there (the page scrolls as a whole), so it would have permanently
dimmed the section heading instead of only affecting scrolled-away content.

## 2026-08-12 — "All sessions" back link onto the title row, compact hover

- Moved the back link into `.sessionHeader` and positioned it absolutely at the row's left edge (`.sessionHeader` is now `position: relative`), so it sits on the same line as the piece title instead of stacked above it. Absolute rather than a flex sibling on purpose: the title stays centered on the *page*, not on the leftover space next to a variable-width button — and stays centered when the back link isn't rendered at all (it only shows for `?from=sessions`).
- Reverted the full-bleed row hover to a compact rounded box around the text (`display: inline-flex`, `border-radius: 8px`, `padding: 7px 12px`, no negative margins). I had this backwards when it was first raised — the earlier request was describing the full-row highlight as the bug, not asking for it.
- Below 760px the back link drops back into normal flow above the title (`position: static`, `display: flex`, `width: fit-content` so it stays left-aligned and tight despite the parent's `text-align: center`) — absolute positioning would have collided with the centered title once it wraps to two lines at that width.

Verified: back link is 114px wide vs. the 1280px header (compact, not a row), vertically centered on the header row, title still exactly page-centered, and no back-link/title overlap at 500px.

## 2026-08-12 — Analysis header/gutter cleanup, page arrows moved inside the score card

Four fixes:
- **Equal left/right gutters.** `.page` padding `24px` → `80px` (symmetric) and it's still `margin: 0 auto` inside AppShell's `.main`, so the sidebar→left-panel gap now always equals the right-panel→window-edge gap. Measured at 1700/1300/1050px: 210/210, 80/80, 80/80.
- **Header stripped to title + date, centered.** Removed the "Analysis" and "Jump to summary" buttons (and their now-dead `.analysisTabBtn` / `.jumpSummaryBtn` / `.sessionHeaderLeft` / `.sessionHeaderRight` rules); `.sessionHeader` is a plain centered block instead of a space-between flex row.
- **Page arrows moved inside the score card.** They were siblings flanking the card; they're now absolutely positioned within the card's own left/right padding. `.scorePanelBody` horizontal padding `30px` → `62px`, sized so the 40px circle (11px in from the card edge) clears the sheet music by another 11px on each side. Because the JS width-fit math reads the padding back via `getComputedStyle`, the score auto-resizes to the remaining space with no extra wiring. Bonus: reclaiming the old flanking space made the score *wider* (650 → 674px) despite the bigger gutters.
- **Nav arrow no longer overlaps the issues panel.** It was `position: fixed` (anchored to the window edge), so at narrower viewports it sat on top of the panel. Now `position: absolute` against `.page`, living in the new 80px gutter — a measured 16px clear of the panel at every width tested.

**Watch out:** removing the header buttons made the floating arrow the *only* Analysis↔Summary control, and it was previously `display: none` below 760px — which would have left mobile with no way to reach the summary at all. Below 960px it's now a `position: fixed` bottom-corner FAB instead of hidden (an absolutely-positioned arrow would scroll away with the page there, since that breakpoint uses normal document scrolling). Verified on a 500px viewport that the summary is reachable and returnable.

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
