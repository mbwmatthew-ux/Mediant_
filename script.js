const routes = ["home", "search", "record", "analysis", "follow", "summary", "takes", "profile"];

const viewNodes = document.querySelectorAll(".app-view");
const navNodes  = document.querySelectorAll("[data-route]");
const shell     = document.getElementById("app-shell");

let scoreInitialized = false;

function setActiveRoute(route, options = {}) {
  const nextRoute = routes.includes(route) ? route : "home";
  const { scrollToShell = false } = options;

  viewNodes.forEach((view) => {
    view.classList.toggle("active", view.dataset.view === nextRoute);
  });

  navNodes.forEach((node) => {
    node.classList.toggle("active", node.dataset.route === nextRoute);
  });

  window.location.hash = nextRoute;

  if (scrollToShell && shell) {
    shell.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (nextRoute === "analysis") {
    // Slight delay so the view is visible and has layout dimensions
    setTimeout(maybeInitScore, 60);
  }
}

navNodes.forEach((node) => {
  node.addEventListener("click", () => {
    const route = node.dataset.route;
    const shouldScroll = node.dataset.scrollShell === "true";
    setActiveRoute(route, { scrollToShell: shouldScroll });
  });
});

window.addEventListener("hashchange", () => {
  setActiveRoute(window.location.hash.replace("#", ""));
});

setActiveRoute(window.location.hash.replace("#", "") || "home");

// ── VexFlow score rendering ────────────────────────────────

function maybeInitScore() {
  if (scoreInitialized) return;
  const el = document.getElementById("vf-score");
  if (!el || typeof Vex === "undefined") return;
  scoreInitialized = true;
  renderScore(el);
}

function renderScore(el) {
  const { Renderer, Stave, StaveNote, Voice, Formatter } = Vex.Flow;

  const W = Math.max(el.clientWidth, 480);
  const ROW_H   = 118;
  const ROWS     = 4;
  const H        = ROW_H * ROWS + 48;
  const MARGIN   = 22;
  const INNER_W  = W - MARGIN * 2;
  const PER_ROW  = 4;

  // First stave of each row: extra space for clef + key sig (+ time sig on row 0)
  const PREAMBLE = 104;
  const BASE_W   = (INNER_W - PREAMBLE) / PER_ROW;
  const FIRST_W  = BASE_W + PREAMBLE;

  const renderer = new Renderer(el, Renderer.Backends.SVG);
  renderer.resize(W, H);
  const ctx = renderer.getContext();

  // 4 rows × 4 measures each; flagged measures drive the interaction
  const measureDefs = [
    // Row 0 — clean
    { num: 12, flag: null,       notes: [["db/5"], ["f/5"],  ["ab/5"]] },
    { num: 13, flag: null,       notes: [["bb/5"], ["ab/5"], ["gb/5"]] },
    { num: 14, flag: null,       notes: [["f/5"],  ["eb/5"], ["db/5"]] },
    { num: 15, flag: null,       notes: [["c/5"],  ["bb/4"], ["ab/4"]] },
    // Row 1 — m.16 flagged (timing)
    { num: 16, flag: "timing",   notes: [["ab/4"], ["gb/4"], ["f/4"]]  },
    { num: 17, flag: null,       notes: [["eb/4"], ["f/4"],  ["gb/4"]] },
    { num: 18, flag: null,       notes: [["ab/4"], ["bb/4"], ["c/5"]]  },
    { num: 19, flag: null,       notes: [["db/5"], ["eb/5"], ["f/5"]]  },
    // Row 2 — m.28 flagged (dynamics)
    { num: 28, flag: "dynamics", notes: [["db/5"], ["c/5"],  ["bb/4"]] },
    { num: 29, flag: null,       notes: [["ab/4"], ["gb/4"], ["f/4"]]  },
    { num: 30, flag: null,       notes: [["eb/4"], ["f/4"],  ["gb/4"]] },
    { num: 31, flag: null,       notes: [["ab/4"], ["bb/4"], ["c/5"]]  },
    // Row 3 — m.33 flagged (voicing)
    { num: 33, flag: "voicing",  notes: [["db/5"], ["eb/5"], ["f/5"]]  },
    { num: 34, flag: null,       notes: [["gb/5"], ["f/5"],  ["eb/5"]] },
    { num: 35, flag: null,       notes: [["db/5"], ["c/5"],  ["bb/4"]] },
    { num: 36, flag: null,       notes: [["ab/4", "db/5", "f/5"]]     }, // final chord
  ];

  const svg = el.querySelector("svg");

  measureDefs.forEach((m, i) => {
    const row     = Math.floor(i / PER_ROW);
    const col     = i % PER_ROW;
    const isFirst = col === 0;
    const isVeryFirst = i === 0;

    const x = MARGIN + (isFirst ? 0 : PREAMBLE + col * BASE_W);
    const y = 28 + row * ROW_H;
    const w = isFirst ? FIRST_W : BASE_W;

    const stave = new Stave(x, y, w);
    if (isFirst) {
      stave.addClef("treble").addKeySignature("Db");
      if (isVeryFirst) stave.addTimeSignature("3/4");
    }
    stave.setContext(ctx).draw();

    // Measure number label via SVG text
    if (svg) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", String(x + 4));
      label.setAttribute("y", String(y - 6));
      label.setAttribute("font-size", "10");
      label.setAttribute("font-family", "Avenir Next, Inter, sans-serif");
      label.setAttribute("fill", "#879484");
      label.textContent = `m.${m.num}`;
      svg.appendChild(label);
    }

    // Build voice — last measure uses a dotted-half chord
    let voice;
    if (m.notes.length === 1 && m.notes[0].length > 1) {
      const chord = new StaveNote({ clef: "treble", keys: m.notes[0], duration: "h." });
      voice = new Voice({ num_beats: 3, beat_value: 4 });
      voice.setStrict(false);
      voice.addTickables([chord]);
    } else {
      const staveNotes = m.notes.map(
        (keys) => new StaveNote({ clef: "treble", keys, duration: "q" })
      );
      voice = new Voice({ num_beats: 3, beat_value: 4 });
      voice.addTickables(staveNotes);
    }

    // Note area = from where notes start to end of stave
    const noteStart = stave.getNoteStartX();
    const noteWidth = stave.getEndX() - noteStart - 8;

    new Formatter().joinVoices([voice]).format([voice], noteWidth);
    voice.draw(ctx, stave);

    // Flagged measure: coral highlight rect + click handler
    if (m.flag && svg) {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(x + 1));
      rect.setAttribute("y", String(y - 10));
      rect.setAttribute("width", String(w - 2));
      rect.setAttribute("height", "86");
      rect.setAttribute("rx", "8");
      rect.setAttribute("fill", "rgba(225, 134, 118, 0.09)");
      rect.setAttribute("stroke", "rgba(225, 134, 118, 0.5)");
      rect.setAttribute("stroke-width", "1.5");
      rect.setAttribute("data-flag", m.flag);
      rect.setAttribute("class", `score-flag-rect score-flag-${m.flag}`);
      rect.style.cursor = "pointer";
      svg.appendChild(rect);

      rect.addEventListener("click", () => openFeedback(m.flag));
    }
  });
}

// ── Feedback panel interaction ─────────────────────────────

function openFeedback(flagId) {
  const idle    = document.getElementById("feedback-idle");
  const details = document.querySelectorAll(".feedback-detail");
  const chips   = document.querySelectorAll(".issue-chip[data-flag]");
  const rects   = document.querySelectorAll(".score-flag-rect");

  if (idle) idle.style.display = "none";

  details.forEach((d) => d.classList.remove("active"));
  const target = document.getElementById(`detail-${flagId}`);
  if (target) target.classList.add("active");

  chips.forEach((c) => c.classList.toggle("chip-active", c.dataset.flag === flagId));

  // Pulse the matching rect more strongly
  rects.forEach((r) => {
    const isActive = r.dataset.flag === flagId;
    r.setAttribute("fill", isActive
      ? "rgba(225, 134, 118, 0.18)"
      : "rgba(225, 134, 118, 0.09)");
    r.setAttribute("stroke", isActive
      ? "rgba(225, 134, 118, 0.85)"
      : "rgba(225, 134, 118, 0.5)");
    r.setAttribute("stroke-width", isActive ? "2" : "1.5");
  });
}

function closeFeedback() {
  const idle    = document.getElementById("feedback-idle");
  const details = document.querySelectorAll(".feedback-detail");
  const chips   = document.querySelectorAll(".issue-chip[data-flag]");
  const rects   = document.querySelectorAll(".score-flag-rect");

  if (idle) idle.style.display = "";
  details.forEach((d) => d.classList.remove("active"));
  chips.forEach((c) => c.classList.remove("chip-active"));

  rects.forEach((r) => {
    r.setAttribute("fill", "rgba(225, 134, 118, 0.09)");
    r.setAttribute("stroke", "rgba(225, 134, 118, 0.5)");
    r.setAttribute("stroke-width", "1.5");
  });
}

// Issue chip clicks
document.querySelectorAll(".issue-chip[data-flag]").forEach((chip) => {
  chip.addEventListener("click", () => openFeedback(chip.dataset.flag));
});

// Dismiss buttons inside feedback details
document.querySelectorAll("[data-close-detail]").forEach((btn) => {
  btn.addEventListener("click", closeFeedback);
});
