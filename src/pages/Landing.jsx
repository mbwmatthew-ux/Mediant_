import { useEffect, useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import styles from './Landing.module.css'

function SheetMusicPage({ seed = 0, showTitle = false }) {
  return (
    <div style={{
      position: 'relative',
      width: '100%',
      height: '100%',
      background: '#f7e8be',
      overflow: 'hidden',
      borderRadius: 'inherit',
      boxShadow: 'inset 0 0 20px rgba(26,15,5,0.06)'
    }}>
      {/* High-fidelity, GPU-cached image representation of the sheet music (guarantees buttery 120 FPS!) */}
      <img
        src="/sheet_music_page.png"
        alt="Sheet Music Page"
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
          pointerEvents: 'none',
          userSelect: 'none'
        }}
      />
      
      {/* Slight tint overlay to vary the aged-paper stain across seed values (uses fast hardware alpha blending) */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: `rgba(184, 146, 42, ${(seed % 4) * 0.018})`,
        pointerEvents: 'none'
      }} />

      {/* Overlay brand titles on specific cards */}
      {showTitle && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          background: 'rgba(247, 232, 190, 0.95)',
          borderBottom: '1px solid rgba(184, 146, 42, 0.18)',
          padding: '10px 8px 6px',
          textAlign: 'center',
          pointerEvents: 'none'
        }}>
          <h4 style={{
            margin: 0,
            fontFamily: '"Iowan Old Style", Georgia, serif',
            fontSize: '9.5px',
            fontWeight: 800,
            letterSpacing: '0.12em',
            color: '#1a0f05',
            textTransform: 'uppercase'
          }}>
            Concerto Cello
          </h4>
          <p style={{
            margin: '1px 0 0',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: '7px',
            color: 'rgba(26, 15, 5, 0.55)',
            letterSpacing: '0.03em'
          }}>
            I. Prelude (J.S. Bach) · m.12
          </p>
        </div>
      )}
    </div>
  )
}

/* ── Intro sheet music fan ────────────────────────────────────── */
const INTRO_SHEETS = [
  { angle: -75, rx: '4px 11px 9px 5px' },
  { angle: -45, rx: '6px  8px 11px 4px' },
  { angle: -15, rx: '3px 10px  7px 8px' },
  { angle:  15, rx: '7px  9px  6px 10px' },
  { angle:  45, rx: '4px 12px  8px 5px' },
  { angle:  75, rx: '8px  7px 10px 4px' },
]

function MusicIntro() {
  const [state, setState] = useState('initial')

  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setState('fanned')))
    return () => cancelAnimationFrame(id)
  }, [])

  function cls(side) {
    return [
      styles.introSheet,
      side === 'right' && styles.introSheetR,
      state === 'fanned' && styles.introFanning,
      state === 'fanned' && styles.introSheetFanned,
    ].filter(Boolean).join(' ')
  }

  return (
    <div className={styles.introOverlay} aria-hidden="true">
      {INTRO_SHEETS.map((s, i) => (
        <div
          key={`left_${i}`}
          className={cls('left')}
          style={{ '--angle': `${s.angle}deg`, '--i': i, borderRadius: s.rx }}
        >
          <SheetMusicPage seed={i} showTitle={i === 4} />
        </div>
      ))}
      {INTRO_SHEETS.map((s, i) => (
        <div
          key={`right_${i}`}
          className={cls('right')}
          style={{ '--angle': `${s.angle}deg`, '--i': i, borderRadius: s.rx }}
        >
          <SheetMusicPage seed={i + 12} showTitle={i === 2} />
        </div>
      ))}
    </div>
  )
}



const ANALYSIS_TEXT =
  "The triplet figures in mm. 12–15 are rushing by about 18ms ahead of the pulse — a common response to the harmonic tension building here, but it softens the improvisatory character Chopin intended. Try isolating mm. 13–14 at 76bpm: anchor on the left hand's bass octaves and let the right hand breathe over them rather than leading. Your voicing in the opening phrase is outstanding — carry that patience into this passage and the crescendo at m. 16 will land with real weight."

const ANALYSIS_TEXT_COLUMN =
  "The lower F♯ octave sits roughly 20 cents flat on the entrance. Clear your damper pedal just before the strike and anchor with a deeper, more centered finger contact to let the fundamental ring true."

const ROTATING_LINES = [
  { we: 'elevate', you: 'create',  color: '#7a5230' },
  { we: 'listen',  you: 'perform', color: '#c4824a' },
  { we: 'analyze', you: 'refine',  color: '#b8922a' },
  { we: 'map',     you: 'improve', color: '#8b6f3a' },
  { we: 'guide',   you: 'grow',    color: '#d4a644' },
]

const FEATURES = [
  {
    icon: ScoreIcon,
    num: '01',
    title: 'Score-aware analysis',
    body: 'Every flag is tied to a specific measure and beat — not a vague average. Mediant reads the sheet music, not just the audio.',
  },
  {
    icon: CoachIcon,
    num: '02',
    title: 'Coaching, not just corrections',
    body: 'Every note you play has context — the phrase it belongs to, the style it\'s drawn from, the habit behind it. Mediant addresses all three.',
  },
  {
    icon: ProgressIcon,
    num: '03',
    title: 'Session history',
    body: 'Track exactly which passages improved across every take. See where your practice is paying off.',
  },
]

const STEPS = [
  { num: '01', title: 'Upload your recording', body: 'Drop in a video or audio file from your practice session.' },
  { num: '02', title: 'Maps it to the score',  body: 'Mediant aligns every note to your sheet music, measure by measure.' },
  { num: '03', title: 'Get targeted feedback', body: 'Click any flagged measure for specific, actionable feedback.' },
]

const STATS = [
  { value: 40,  suffix: '+', label: 'Instruments supported' },
  { value: 6,   suffix:  '', label: 'Types of feedback' },
  { value: 100, suffix: '%', label: 'Your recordings stay private' },
]


/* ── IntersectionObserver hook ── */
function useInView(threshold = 0.12) {
  const ref = useRef(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true) },
      { threshold }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [threshold])
  return [ref, inView]
}

/* ── Typing caret animation (loops: type → highlight → clear → repeat) ── */
function DocTyping({ text, active, delay = 0 }) {
  const [displayed, setDisplayed] = useState('')
  const [phase, setPhase]         = useState('idle')
  const timerRef = useRef(null)

  useEffect(() => {
    if (!active) { setPhase('idle'); setDisplayed(''); return }
    const id = setTimeout(() => setPhase('typing'), delay)
    return () => clearTimeout(id)
  }, [active, delay])

  useEffect(() => {
    clearTimeout(timerRef.current)
    if (phase === 'idle') return

    if (phase === 'typing') {
      if (displayed.length < text.length) {
        timerRef.current = setTimeout(
          () => setDisplayed(text.slice(0, displayed.length + 1)),
          95 + Math.random() * 75,
        )
      } else {
        // Done typing — pause then enter highlight phase
        timerRef.current = setTimeout(() => setPhase('selected'), 700)
      }
    } else if (phase === 'selected') {
      // Hold highlight, then clear and loop
      timerRef.current = setTimeout(() => {
        setDisplayed('')
        setPhase('pausing')
      }, 900)
    } else if (phase === 'pausing') {
      timerRef.current = setTimeout(() => setPhase('typing'), 500)
    }

    return () => clearTimeout(timerRef.current)
  }, [phase, displayed, text])

  return (
    <div className={styles.docTypingCard}>
      <p className={styles.docText}>
        <span className={phase === 'selected' ? styles.docSelected : undefined}>
          {displayed}
        </span>
        {phase === 'typing' && (
          <span className={styles.docCaret}>
            <span className={styles.docCaretLabel}>Mediant</span>
          </span>
        )}
      </p>
    </div>
  )
}

/* ── Logo mark ── */
function AnimatedLogo({ size = 28, thicker = false }) {
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      background: 'var(--text)',
      WebkitMask: `url('/logo-mark.png') center/contain no-repeat`,
      WebkitMaskMode: 'luminance',
      mask: `url('/logo-mark.png') center/contain no-repeat`,
      maskMode: 'luminance',
      filter: thicker
        ? 'drop-shadow(0 0 2px #1a0f05) drop-shadow(0 0 2px #1a0f05) drop-shadow(0 0 2px #1a0f05)'
        : undefined,
    }} />
  )
}

function Wordmark({ className }) {
  return <span className={`${styles.wordmark} ${className || ''}`}>Mediant</span>
}

/* ── Per-character fade word ── */
function AnimatedWord({ word, color, visible }) {
  return (
    <span className={styles.heroWordFrame}>
      {word.split('').map((ch, i) => (
        <span
          key={ch + i}
          className={visible ? styles.heroCharVisible : styles.heroCharHidden}
          style={{ '--wi': i, '--w-color': color }}
        >
          {ch}
        </span>
      ))}
    </span>
  )
}

/* ── Stacked shuffle cards ── */
const SHUFFLE_ITEMS = [
  { color: '#7a5230', text: 'Aligning your recording to the score...' },
  { color: '#c4824a', text: 'Detecting timing drift in measures 12–15...' },
  { color: '#b8922a', text: 'Mapping pitch accuracy across 47 notes...' },
  { color: '#8b6f3a', text: 'Comparing this take to your last session...' },
  { color: '#d4a644', text: 'Generating targeted practice feedback...' },
]

function ShuffleCards({ idx }) {
  const [hist, setHist] = useState(() => [
    idx,
    (idx + SHUFFLE_ITEMS.length - 1) % SHUFFLE_ITEMS.length,
    (idx + SHUFFLE_ITEMS.length - 2) % SHUFFLE_ITEMS.length,
  ])
  useEffect(() => {
    setHist(prev => [idx, prev[0], prev[1]])
  }, [idx])

  const cur = SHUFFLE_ITEMS[hist[0]]
  const gh1 = SHUFFLE_ITEMS[hist[1]]
  const gh2 = SHUFFLE_ITEMS[hist[2]]

  return (
    <div className={styles.shuffleWrap}>
      <div className={`${styles.shuffleGhostCard} ${styles.shuffleGhostFar}`} style={{ borderColor: gh2.color, background: `${gh2.color}10` }}>
        <span className={styles.shuffleText}>{gh2.text}</span>
      </div>
      <div className={`${styles.shuffleGhostCard} ${styles.shuffleGhostNear}`} style={{ borderColor: gh1.color, background: `${gh1.color}1e` }}>
        <span className={styles.shuffleText}>{gh1.text}</span>
      </div>
      <div key={hist[0]} className={styles.shuffleCard} style={{ borderColor: cur.color, boxShadow: `0 0 14px 2px ${cur.color}33` }}>
        <span className={styles.shuffleText}>{cur.text}</span>
      </div>
    </div>
  )
}

/* ── Animated stat counter ── */
function StatCard({ value, suffix, label, delay }) {
  const [active, setActive] = useState(false)
  const [count, setCount]   = useState(0)
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setActive(true); obs.disconnect() }
    }, { threshold: 0.4 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    if (!active) return
    const start = performance.now()
    const dur   = 2200
    function frame(now) {
      const p    = Math.min((now - start) / dur, 1)
      const ease = 1 - Math.pow(1 - p, 4)
      setCount(Math.round(ease * value))
      if (p < 1) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }, [active, value])

  function onMove(e) {
    const el = ref.current; if (!el) return
    const r = el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width  - 0.5
    const y = (e.clientY - r.top)  / r.height - 0.5
    el.style.transition = 'transform 0.08s ease, background 300ms ease'
    el.style.transform = `perspective(700px) rotateY(${x * 14}deg) rotateX(${-y * 10}deg) scale(1.03)`
  }
  function onLeave() {
    const el = ref.current; if (!el) return
    el.style.transition = 'transform 0.55s cubic-bezier(0.16, 1, 0.3, 1), background 300ms ease'
    el.style.transform = ''
  }

  return (
    <div ref={ref} className={`${styles.statCard} ${styles.revealScale}`} style={{ '--d': delay }}
      onMouseMove={onMove} onMouseLeave={onLeave}>
      <span className={styles.statValue}>{count.toLocaleString()}{suffix}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  )
}

/* ── 3D tilt wrapper ── */
function TiltBox({ className, style, children }) {
  const ref = useRef(null)
  function onMove(e) {
    const el = ref.current; if (!el) return
    const r = el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width  - 0.5
    const y = (e.clientY - r.top)  / r.height - 0.5
    el.style.transition = 'transform 0.08s ease'
    el.style.transform = `perspective(500px) rotateY(${x * 22}deg) rotateX(${-y * 16}deg) scale(1.06)`
  }
  function onLeave() {
    const el = ref.current; if (!el) return
    el.style.transition = 'transform 0.6s cubic-bezier(0.16, 1, 0.3, 1)'
    el.style.transform = ''
  }
  return (
    <div ref={ref} className={className} style={style} onMouseMove={onMove} onMouseLeave={onLeave}>
      {children}
    </div>
  )
}

const CELLO_DEMO_FLAGS = [
  {
    flag: 'flag_0',
    measure: 12,
    type: 'timing',
    confidence: 91,
    title: 'Rushing the sixteenth descent',
    timestamp: 12.4,
    detail: 'The sixteenth-note run in measure 12 is rushing by about 22ms ahead of the pulse. Keep your bow stroke even and anchor the left-hand thumb to stabilize timing.'
  },
  {
    flag: 'flag_1',
    measure: 18,
    type: 'dynamics',
    confidence: 88,
    title: 'Percussive string crossing',
    timestamp: 24.8,
    detail: 'The accent on the crossing to the D-string in m.18 is too harsh. Lighten the index finger pressure on the bow grip to let the string resonate naturally.'
  },
  {
    flag: 'flag_2',
    measure: 21,
    type: 'intonation',
    confidence: 85,
    title: 'Bass F♯ sits 15 cents flat',
    timestamp: 36.2,
    detail: 'The high F♯ sits roughly 15 cents flat in this shift. Anchor your third finger firmly and keep the elbow elevated to support the high hand position.'
  }
]

export default function Landing() {
  const [wordIdx, setWordIdx]     = useState(0)
  const [wordVisible, setWordVisible] = useState(true)
  const [activeFlag, setActiveFlag] = useState('flag_2')


  const canvasRef = useRef(null)
  const [analysisRef, analysisInView] = useInView(0.15)
  const analysisSectionRef = useRef(null)
  const heroRef        = useRef(null)
  const parallaxMeshRef  = useRef(null)
  const parallaxHeadRef  = useRef(null)
  const parallaxCardsRef = useRef(null)

  /* ── Waveform canvas (breathing, not scrolling) ── */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let raf

    const WAVES = [
      { freq: 0.010, baseAmp: 36, breatheFreq: 0.40, breathePhase: 0.0, alpha: 0.07, yRatio: 0.35 },
      { freq: 0.016, baseAmp: 22, breatheFreq: 0.60, breathePhase: 1.5, alpha: 0.09, yRatio: 0.50 },
      { freq: 0.007, baseAmp: 50, breatheFreq: 0.28, breathePhase: 0.8, alpha: 0.04, yRatio: 0.65 },
      { freq: 0.022, baseAmp: 16, breatheFreq: 0.72, breathePhase: 2.2, alpha: 0.07, yRatio: 0.43 },
      { freq: 0.013, baseAmp: 30, breatheFreq: 0.50, breathePhase: 3.8, alpha: 0.05, yRatio: 0.72 },
    ]

    const dpr = window.devicePixelRatio || 1

    function resize() {
      canvas.width  = canvas.offsetWidth  * dpr
      canvas.height = canvas.offsetHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    window.addEventListener('resize', resize)
    resize()

    function tick(now) {
      const t = now * 0.001
      const w = canvas.offsetWidth
      const h = canvas.offsetHeight
      if (!w || !h) { raf = requestAnimationFrame(tick); return }
      ctx.clearRect(0, 0, w, h)

      for (const wave of WAVES) {
        const amp = wave.baseAmp * (0.3 + 0.7 * Math.sin(t * wave.breatheFreq + wave.breathePhase))
        ctx.beginPath()
        ctx.strokeStyle = `rgba(184,146,42,${wave.alpha})`
        ctx.lineWidth = 1.5
        for (let x = 0; x <= w; x += 3) {
          const y = h * wave.yRatio + Math.sin(x * wave.freq) * amp
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        }
        ctx.stroke()
      }

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize) }
  }, [])

  /* ── Mouse parallax ── */
  useEffect(() => {
    const hero = heroRef.current
    if (!hero) return
    let tx = 0, ty = 0, cx = 0, cy = 0, raf
    const lerp = (a, b, t) => a + (b - a) * t

    function tick() {
      cx = lerp(cx, tx, 0.055)
      cy = lerp(cy, ty, 0.055)
      const mesh  = parallaxMeshRef.current
      const head  = parallaxHeadRef.current
      const cards = parallaxCardsRef.current
      if (mesh)  mesh.style.transform  = `translate(${(cx * 32).toFixed(2)}px, ${(cy * 20).toFixed(2)}px)`
      if (head)  head.style.transform  = `translate(${(cx * 8).toFixed(2)}px, ${(cy * 5).toFixed(2)}px)`
      if (cards) cards.style.transform = `translate(${(cx * -12).toFixed(2)}px, ${(cy * -8).toFixed(2)}px)`
      raf = requestAnimationFrame(tick)
    }

    function onMove(e) {
      const r = hero.getBoundingClientRect()
      tx = (e.clientX - r.left) / r.width  - 0.5
      ty = (e.clientY - r.top)  / r.height - 0.5
    }
    function onLeave() { tx = 0; ty = 0 }

    hero.addEventListener('mousemove', onMove)
    hero.addEventListener('mouseleave', onLeave)
    raf = requestAnimationFrame(tick)
    return () => {
      hero.removeEventListener('mousemove', onMove)
      hero.removeEventListener('mouseleave', onLeave)
      cancelAnimationFrame(raf)
    }
  }, [])

  /* ── Word cycling with fade out / in ── */
  useEffect(() => {
    const id = setInterval(() => {
      setWordVisible(false)
      setTimeout(() => setWordIdx(i => (i + 1) % ROTATING_LINES.length), 320)
      setTimeout(() => setWordVisible(true), 360)
    }, 3400)
    return () => clearInterval(id)
  }, [])

  /* ── Scroll reveals (bidirectional) ── */
  useEffect(() => {
    const classes = [styles.reveal, styles.revealL, styles.revealR, styles.revealScale]
    const query = classes.map(c => `.${c}`).join(', ')
    const els = document.querySelectorAll(query)
    if (!els.length) return

    // threshold:0 fires only when element fully leaves — user never sees the reset
    // rootMargin shrinks trigger zone slightly so enter animation happens just after element edge crosses
    const obs = new IntersectionObserver(
      entries => entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add(styles.revealVisible)
        } else {
          // Fully offscreen — reset regardless of direction so it re-animates on re-entry
          e.target.classList.remove(styles.revealVisible)
        }
      }),
      { threshold: 0, rootMargin: '-8px 0px -8px 0px' },
    )
    els.forEach(el => obs.observe(el))
    return () => obs.disconnect()
  }, [])

  const current = ROTATING_LINES[wordIdx]

  return (
    <div className={styles.page}>

      <MusicIntro />

      {/* ── Bottom watercolor glow (color-synced with hero) ── */}
      <div
        className={styles.bottomGlow}
        style={{ '--glow-color': current.color }}
        aria-hidden="true"
      />

      {/* ── Nav ── */}
      <nav className={styles.nav}>
        <Link to="/" className={styles.navBrand}>
          <AnimatedLogo size={54} />
          <Wordmark />
        </Link>
        <div className={styles.navRight}>
          <Link to="/login"  className={styles.navLogin}>Log in</Link>
          <Link to="/signup" className={styles.navCta}>Get started free →</Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className={styles.hero} ref={heroRef}>
        <div ref={parallaxMeshRef} className={styles.meshBg} aria-hidden="true">
          <div className={`${styles.meshBlob} ${styles.meshBlob1}`} />
          <div className={`${styles.meshBlob} ${styles.meshBlob2}`} />
          <div className={`${styles.meshBlob} ${styles.meshBlob3}`} />
          <div className={`${styles.meshBlob} ${styles.meshBlob4}`} />
        </div>
        <canvas ref={canvasRef} className={styles.waveCanvas} aria-hidden="true" />

        <div ref={parallaxHeadRef} className={styles.parallaxNode}>
          <h1 className={styles.heroHeading}>
            <span className={styles.heroLine}>
              <span className={styles.heroStatic}>We</span>
              <AnimatedWord word={current.we}  color={current.color} visible={wordVisible} />
              <span className={styles.heroComma}>,&nbsp;you</span>
              <AnimatedWord word={current.you} color={current.color} visible={wordVisible} />
            </span>
          </h1>
        </div>

        <div ref={parallaxCardsRef} className={styles.parallaxNode}>
          <ShuffleCards idx={wordIdx} />
        </div>

        <p className={styles.heroSub}>
          Upload a recording. Mediant maps it to your sheet music and delivers
          feedback that sounds like it came from a teacher — not an app.
        </p>

        <div className={styles.heroCtas}>
          <Link to="/signup" className={styles.ctaPrimary}>Start for free →</Link>
          <Link to="/login"  className={styles.ctaGhost}>Log in</Link>
        </div>

        <p className={styles.heroNote}>Free to start · No credit card · Any instrument</p>

        <Link to="/demo" className={styles.heroSeeExample}>
          See an example analysis ↗
        </Link>
      </section>

      {/* ── Analysis Demo ── */}
      <section className={styles.analysisSection} ref={analysisSectionRef}>
        <div className={`${styles.analysisHead} ${styles.reveal}`}>
          <p className={styles.sectionLabel}>AI Co-Pilot</p>
          <h2 className={styles.analysisTitle}>Real-time performance review</h2>
          <p className={styles.analysisSub}>
            Mediant tracks your pitch, timing, and dynamic weight as you play, matching your performance note-by-note to the score.
          </p>
        </div>

        <div className={`${styles.analysisColumns} ${styles.reveal}`} ref={analysisRef} style={{ '--d': '120ms' }}>

          {/* Visual Callout 1 (Timeline Callout - Left Side) */}
          <div className={`${styles.calloutBox} ${styles.calloutLeft} ${styles.calloutTimeline}`}>
            <p className={styles.calloutText}>
              <span className={styles.calloutHighlight}>AI analyzes</span> timing, dynamics, and intonation note-by-note.
            </p>
            <svg className={styles.calloutArrow} width="40" height="40" viewBox="0 0 40 40">
              <path d="M10,10 C22,10 28,18 30,26" stroke="#b8922a" strokeWidth="1.8" strokeLinecap="round" fill="none" />
              <polygon points="30,26 25,22 33,21" fill="#b8922a" />
            </svg>
          </div>

          {/* Visual Callout 2 (Card Callout - Right Side) */}
          <div className={`${styles.calloutBox} ${styles.calloutRight} ${styles.calloutCard}`}>
            <svg className={styles.calloutArrow} width="40" height="40" viewBox="0 0 40 40">
              <path d="M30,10 C18,10 12,18 10,26" stroke="#b8922a" strokeWidth="1.8" strokeLinecap="round" fill="none" />
              <polygon points="10,26 7,21 15,22" fill="#b8922a" />
            </svg>
            <p className={styles.calloutText}>
              <span className={styles.calloutHighlight}>Detailed coaching</span> explains the physical habit behind each error.
            </p>
          </div>

          {/* Visual Callout 3 (Chat Callout - Left Side) */}
          <div className={`${styles.calloutBox} ${styles.calloutLeft} ${styles.calloutChat}`}>
            <p className={styles.calloutText}>
              <span className={styles.calloutHighlight}>Discuss & refine</span> your practice routines in real-time dialog.
            </p>
            <svg className={styles.calloutArrow} width="40" height="40" viewBox="0 0 40 40">
              <path d="M10,10 C22,10 28,18 30,26" stroke="#b8922a" strokeWidth="1.8" strokeLinecap="round" fill="none" />
              <polygon points="30,26 25,22 33,21" fill="#b8922a" />
            </svg>
          </div>

          {/* Right Column: Interactive App-like Dashboard modeled off of Analysis.jsx */}
          <div className={styles.analysisRightColumn}>
            <div className={styles.analysisStatus}>
              <span className={styles.analysisPulse} />
              <span className={styles.analysisStatusText}>Mediant AI Insights Timeline</span>
              <span className={styles.analysisDivider}>·</span>
              <span className={styles.analysisStatusMeta}>3 issues flagged</span>
            </div>

            {/* AI Insights Timeline list */}
            <div className={styles.timeline}>
              {CELLO_DEMO_FLAGS.map((f) => {
                const isActive = activeFlag === f.flag
                const cc = f.type === 'timing' ? 'var(--gold)' : f.type === 'dynamics' ? 'var(--coral)' : 'var(--accent)'
                const formatTime = (sec) => {
                  const m = Math.floor(sec / 60)
                  const r = (sec % 60).toFixed(1).padStart(4, '0')
                  return `${m}:${r}`
                }
                return (
                  <button
                    key={f.flag}
                    className={`${styles.timelineRow} ${isActive ? styles.timelineRowActive : ''}`}
                    onClick={() => setActiveFlag(f.flag)}
                  >
                    <span className={styles.timelineConfDot} style={{ background: cc }} />
                    <span className={styles.timelineTs}>{formatTime(f.timestamp)}</span>
                    <span className={styles.timelineMeasure}>m.{f.measure}</span>
                    <span className={styles.timelineTypePill} style={{
                      background: f.type === 'timing' ? 'rgba(214,177,104,0.15)' : f.type === 'dynamics' ? 'rgba(225,134,118,0.15)' : 'var(--accent-bg)',
                      color: cc
                    }}>{f.type}</span>
                    <span className={styles.timelineTitle}>{f.title}</span>
                    <span className={styles.timelineConfBadge} style={{ color: cc }}>High</span>
                  </button>
                )
              })}
            </div>

            {/* Expanded Insight Card */}
            {(() => {
              const activeF = CELLO_DEMO_FLAGS.find(f => f.flag === activeFlag)
              if (!activeF) return null
              const cc = activeF.type === 'timing' ? 'var(--gold)' : activeF.type === 'dynamics' ? 'var(--coral)' : 'var(--accent)'
              return (
                <div className={styles.insightCard}>
                  <div className={styles.insightCardHeader}>
                    <span className={styles.insightMeasureBadge}>m.{activeF.measure}</span>
                    <h3 className={styles.insightTitle}>{activeF.title}</h3>
                    <span className={styles.insightConfBadge} style={{ color: cc }}>
                      High Confidence
                    </span>
                  </div>
                  {activeFlag === 'flag_2' ? (
                    <div className={styles.insightTypewriterBox}>
                      <DocTyping text={activeF.detail} active={analysisInView} delay={100} />
                    </div>
                  ) : (
                    <p className={styles.insightBody}>{activeF.detail}</p>
                  )}
                  <div className={styles.insightActions}>
                    <button className={styles.loopBtn}>
                      ↺ Loop m.{activeF.measure}
                      <span className={styles.loopExcerptTime}>
                        0:{activeF.timestamp.toFixed(1)} – 0:{(activeF.timestamp + 2.5).toFixed(1)}
                      </span>
                    </button>
                  </div>
                </div>
              )
            })()}

            {/* Ask Mediant Chat Section */}
            <div className={styles.chatSection}>
              <div className={styles.chatSectionHeader}>
                <p className={styles.label} style={{ fontSize: '0.68rem', letterSpacing: '0.15em', margin: 0 }}>Ask Mediant</p>
                <span className={styles.chatContextPill}>
                  Re: m.{CELLO_DEMO_FLAGS.find(f => f.flag === activeFlag)?.measure} · {CELLO_DEMO_FLAGS.find(f => f.flag === activeFlag)?.type}
                </span>
              </div>
              <div className={styles.chatMessages}>
                <div className={styles.chatMsgUser}>
                  How do I keep my left hand relaxed in measure {CELLO_DEMO_FLAGS.find(f => f.flag === activeFlag)?.measure}?
                </div>

                <div className={styles.chatMsgAI}>
                  {activeFlag === 'flag_0' && "For m.12, keep your bowing arm fluid. Let the forearm weight carry the bow speed instead of pressing with the wrist. Practice the sixteenth notes in dotted rhythms to establish a physical timing anchor."}
                  {activeFlag === 'flag_1' && "For the crossing in m.18, let your right elbow drop slightly as you approach the D-string. This changes the bow plane organically, avoiding any percussive slapping of the hair against the string."}
                  {activeFlag === 'flag_2' && "Keep your left thumb completely relaxed behind the neck, resting opposite your second finger. Practice shifting slowly from the D3 to the F♯3 without pressing the thumb at all—let the arm weight do the work."}
                </div>
                
                {/* Mid-typing conversation indicators representing active follow-up dialog */}
                <div className={styles.typingBubbleUser}>
                  <span>You are typing...</span>
                  <span className={styles.typingIndicatorDots}>
                    <span className={styles.dot} />
                    <span className={styles.dot} />
                    <span className={styles.dot} />
                  </span>
                </div>

                <div className={styles.typingBubbleAI}>
                  <span>Mediant is typing...</span>
                  <span className={styles.typingIndicatorDots}>
                    <span className={styles.dot} />
                    <span className={styles.dot} />
                    <span className={styles.dot} />
                  </span>
                </div>
              </div>
              <div className={styles.chatInputRow}>
                <input
                  className={styles.chatInput}
                  placeholder="Ask Mediant about this passage..."
                  disabled
                />
                <button className={styles.chatSend} disabled>↑</button>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ── Stats ── */}
      <section className={styles.statsSection}>
        <div className={styles.statsGrid}>
          {STATS.map((s, i) => (
            <StatCard
              key={s.label}
              value={s.value}
              suffix={s.suffix}
              label={s.label}
              delay={`${i * 130}ms`}
            />
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section className={styles.features}>
        <div className={`${styles.featuresHead} ${styles.reveal}`}>
          <p className={styles.sectionLabel}>What you get</p>
          <h2 className={styles.featuresTitle}>Everything a serious<br />practice session needs</h2>
        </div>
        {FEATURES.map((f, i) => (
          <div
            key={f.title}
            className={`${styles.featureRow} ${i % 2 === 1 ? styles.featureRowFlip : ''} ${i % 2 === 0 ? styles.revealL : styles.revealR}`}
            style={{ '--d': `${i * 60}ms` }}
          >
            <div className={styles.featureText}>
              <span className={styles.featureNum}>{f.num}</span>
              <h3 className={styles.featureTitle}>{f.title}</h3>
              <p className={styles.featureBody}>{f.body}</p>
            </div>
            <TiltBox className={styles.featureVisual}>
              <f.icon />
            </TiltBox>
          </div>
        ))}
      </section>

      {/* ── How it works ── */}
      <section className={styles.howItWorks}>
        <div className={`${styles.howHead} ${styles.reveal}`}>
          <p className={styles.sectionLabel}>How it works</p>
          <h2 className={styles.howTitle}>Three steps to<br />better practice</h2>
        </div>
        <div className={styles.steps}>
          {STEPS.map((s, i) => (
            <div key={s.num} className={`${styles.step} ${styles.reveal}`} style={{ '--d': `${i * 160}ms` }}>
              <span className={styles.stepNum}>{s.num}</span>
              <h3 className={styles.stepTitle}>{s.title}</h3>
              <p className={styles.stepBody}>{s.body}</p>
              {i < STEPS.length - 1 && <div className={styles.stepArrow}>→</div>}
            </div>
          ))}
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className={`${styles.ctaSection} ${styles.reveal}`}>
        <h2 className={styles.ctaTitle}>Practice with intention,<br />not just repetition.</h2>
        <p className={styles.ctaSub}>Join musicians turning practice time into real, measurable progress.</p>
        <div className={styles.heroCtas}>
          <Link to="/signup" className={styles.ctaPrimary}>Create your free account</Link>
          <Link to="/login"  className={styles.ctaGhost}>Log in</Link>
        </div>
        <p className={styles.heroNote}>No credit card · Cancel anytime</p>
      </section>

      {/* ── Footer ── */}
      <footer className={styles.footer}>
        <div className={styles.footerLeft}>
          <Link to="/" className={styles.navBrand} style={{ opacity: 0.6 }}>
            <AnimatedLogo size={36} />
            <Wordmark />
          </Link>
          <p className={styles.footerTagline}>Intelligent music performance analysis.</p>
        </div>
        <div className={styles.footerLinks}>
          <Link to="/privacy" className={styles.footerLink}>Privacy</Link>
          <Link to="/terms"   className={styles.footerLink}>Terms</Link>
          <Link to="/contact" className={styles.footerLink}>Contact</Link>
        </div>
        <p className={styles.footerCopy}>© 2026 Mediant</p>
      </footer>
    </div>
  )
}

/* ── Icons (large, artistic) ── */
function ScoreIcon() {
  return (
    <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
    </svg>
  )
}
function CoachIcon() {
  return (
    <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  )
}
function ProgressIcon() {
  return (
    <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  )
}
