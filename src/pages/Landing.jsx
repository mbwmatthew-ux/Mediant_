import { useEffect, useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import styles from './Landing.module.css'

const ANALYSIS_TEXT =
  "The triplet figures in mm. 12–15 are rushing by about 18ms ahead of the pulse — a common response to the harmonic tension building here, but it softens the improvisatory character Chopin intended. Try isolating mm. 13–14 at 76bpm: anchor on the left hand's bass octaves and let the right hand breathe over them rather than leading. Your voicing in the opening phrase is outstanding — carry that patience into this passage and the crescendo at m. 16 will land with real weight."

const ROTATING_LINES = [
  { we: 'elevate', you: 'create',  color: '#a58fe8' },
  { we: 'listen',  you: 'perform', color: '#e18676' },
  { we: 'analyze', you: 'refine',  color: '#d6b168' },
  { we: 'map',     you: 'improve', color: '#5cb86b' },
  { we: 'guide',   you: 'grow',    color: '#5cb86b' },
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
function AnimatedLogo({ size = 28 }) {
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      background: 'white',
      WebkitMask: `url('/logo-mark.png') center/contain no-repeat`,
      WebkitMaskMode: 'luminance',
      mask: `url('/logo-mark.png') center/contain no-repeat`,
      maskMode: 'luminance',
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
  { color: '#a58fe8', text: 'Aligning your recording to the score...' },
  { color: '#e18676', text: 'Detecting timing drift in measures 12–15...' },
  { color: '#d6b168', text: 'Mapping pitch accuracy across 47 notes...' },
  { color: '#5cb86b', text: 'Comparing this take to your last session...' },
  { color: '#a58fe8', text: 'Generating targeted practice feedback...' },
]

function ShuffleCards({ idx }) {
  // Track [current, ghost1, ghost2] indices in sync with parent wordIdx
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
      <div className={`${styles.shuffleGhostCard} ${styles.shuffleGhostFar}`} style={{ borderColor: gh2.color }}>
        <span className={styles.shuffleText}>{gh2.text}</span>
      </div>
      <div className={`${styles.shuffleGhostCard} ${styles.shuffleGhostNear}`} style={{ borderColor: gh1.color }}>
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

  return (
    <div ref={ref} className={`${styles.statCard} ${styles.revealScale}`} style={{ '--d': delay }}>
      <span className={styles.statValue}>{count.toLocaleString()}{suffix}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  )
}

export default function Landing() {
  const [wordIdx, setWordIdx]     = useState(0)
  const [wordVisible, setWordVisible] = useState(true)
  const canvasRef = useRef(null)
  const [analysisRef, analysisInView] = useInView(0.15)

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
        ctx.strokeStyle = `rgba(92,184,107,${wave.alpha})`
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

      {/* ── Nav ── */}
      <nav className={styles.nav}>
        <Link to="/" className={styles.navBrand}>
          <AnimatedLogo size={34} />
          <Wordmark />
        </Link>
        <div className={styles.navRight}>
          <Link to="/login"  className={styles.navLogin}>Log in</Link>
          <Link to="/signup" className={styles.navCta}>Get started free →</Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className={styles.hero}>
        <canvas ref={canvasRef} className={styles.waveCanvas} aria-hidden="true" />

        <div className={styles.heroLogoLarge}>
          <AnimatedLogo size={140} />
        </div>

        <h1 className={styles.heroHeading}>
          <span className={styles.heroLine}>
            <span className={styles.heroStatic}>We</span>
            <AnimatedWord word={current.we}  color={current.color} visible={wordVisible} />
            <span className={styles.heroComma}>,&nbsp;you</span>
            <AnimatedWord word={current.you} color={current.color} visible={wordVisible} />
          </span>
        </h1>

        <ShuffleCards idx={wordIdx} />

        <p className={styles.heroSub}>
          Upload a recording. Mediant maps it to your sheet music and delivers
          feedback that sounds like it came from a teacher — not an app.
        </p>

        <div className={styles.heroCtas}>
          <Link to="/signup" className={styles.ctaPrimary}>Start for free →</Link>
          <Link to="/login"  className={styles.ctaGhost}>Log in</Link>
        </div>

        <p className={styles.heroNote}>Free to start · No credit card · Any instrument</p>
      </section>

      {/* ── Analysis Demo ── */}
      <section className={styles.analysisSection}>
        <div className={`${styles.analysisHead} ${styles.reveal}`}>
          <p className={styles.sectionLabel}>AI Analysis</p>
          <h2 className={styles.analysisTitle}>Your personal<br />practice analyst</h2>
          <p className={styles.analysisSub}>
            Mediant doesn't just flag wrong notes. It reads the phrase, the style,
            and the habit behind every mistake — then explains exactly what to fix and why.
          </p>
        </div>

        <div className={`${styles.analysisDemo} ${styles.reveal}`} ref={analysisRef} style={{ '--d': '120ms' }}>
          <div className={styles.analysisStatus}>
            <span className={styles.analysisPulse} />
            <span className={styles.analysisStatusText}>Mediant</span>
            <span className={styles.analysisDivider}>·</span>
            <span className={styles.analysisStatusMeta}>Chopin — Nocturne in E♭ major, Op. 9 No. 2</span>
          </div>

          <DocTyping text={ANALYSIS_TEXT} active={analysisInView} delay={400} />

          <div className={styles.analysisFooter}>
            <span>mm. 12–15</span>
            <span className={styles.analysisSep}>·</span>
            <span>Timing</span>
            <span className={styles.analysisSep}>·</span>
            <span>Phrasing</span>
            <span className={styles.analysisSep}>·</span>
            <span className={styles.analysisFooterGreen}>3 flags resolved</span>
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
            <div className={styles.featureVisual}>
              <f.icon />
            </div>
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
            <AnimatedLogo size={28} />
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
