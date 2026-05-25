import { useEffect, useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import styles from './Landing.module.css'

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

/* ── Instrument section helpers ── */
const NOTES = ['♩', '♪', '♫', '♬']

function FloatingNotes({ count = 6, color = '#5cb86b' }) {
  return (
    <div className={styles.notesContainer} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={styles.floatingNote}
          style={{
            '--note-delay': `${i * 0.55}s`,
            '--note-x':     `${12 + (i * 15) % 74}%`,
            '--note-dur':   `${2.6 + (i % 3) * 0.8}s`,
            color,
            fontSize: `${0.9 + (i % 3) * 0.35}rem`,
          }}
        >
          {NOTES[i % NOTES.length]}
        </span>
      ))}
    </div>
  )
}

function TypeBox({ lines, accentColor = '#5cb86b', active }) {
  const [displayed, setDisplayed] = useState('')
  const [charIdx, setCharIdx]     = useState(0)
  const [done, setDone]           = useState(false)
  const timerRef = useRef(null)
  const fullText = lines.join('\n')

  useEffect(() => {
    if (!active) return
    setDisplayed('')
    setCharIdx(0)
    setDone(false)
  }, [active])

  useEffect(() => {
    if (!active || done) return
    if (charIdx < fullText.length) {
      timerRef.current = setTimeout(() => {
        setDisplayed(fullText.slice(0, charIdx + 1))
        setCharIdx(c => c + 1)
      }, 24 + Math.random() * 20)
    } else {
      setDone(true)
    }
    return () => clearTimeout(timerRef.current)
  }, [active, charIdx, done, fullText])

  return (
    <div className={styles.typeBox}>
      <div className={styles.typeBoxBar}>
        <div className={styles.typeBoxDot} />
        <div className={styles.typeBoxDot} />
        <div className={styles.typeBoxDot} />
        <span className={styles.typeBoxLabel} style={{ color: accentColor }}>Mediant Analysis</span>
      </div>
      <div className={styles.typeBoxBody}>
        <pre className={styles.typeBoxText}>
          {displayed}
          {!done && active && <span className={styles.typeCursor} style={{ background: accentColor }} />}
        </pre>
      </div>
    </div>
  )
}

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

/* ── SVG instruments ── */
function ClarinetSVG() {
  return (
    <svg viewBox="0 0 80 380" fill="none" xmlns="http://www.w3.org/2000/svg" className={styles.instrumentSvg} style={{ height: 300, width: 'auto' }}>
      <rect x="33" y="18" width="14" height="300" rx="7" fill="rgba(232,240,235,0.04)" stroke="rgba(232,240,235,0.18)" strokeWidth="1.5"/>
      <path d="M26 318 Q40 375 54 318" fill="rgba(232,240,235,0.04)" stroke="rgba(232,240,235,0.18)" strokeWidth="1.5"/>
      <rect x="35" y="4" width="10" height="16" rx="3" fill="rgba(232,240,235,0.08)" stroke="rgba(232,240,235,0.25)" strokeWidth="1.5"/>
      {[60,98,136,174,212,250,288].map((y, i) => (
        <ellipse key={i} cx={i % 2 === 0 ? 28 : 52} cy={y} rx="5" ry="3.5" fill="rgba(92,184,107,0.25)" stroke="rgba(92,184,107,0.5)" strokeWidth="1"/>
      ))}
      {[80,118,156,194,232].map((y, i) => (
        <circle key={i} cx="40" cy={y} r="3" fill="rgba(232,240,235,0.06)" stroke="rgba(232,240,235,0.15)" strokeWidth="1"/>
      ))}
    </svg>
  )
}

function CelloSVG() {
  return (
    <svg viewBox="0 0 160 440" fill="none" xmlns="http://www.w3.org/2000/svg" className={styles.instrumentSvg} style={{ height: 300, width: 'auto' }}>
      <path d="M50 110 Q18 90 18 66 Q18 34 55 24 Q80 18 105 24 Q142 34 142 66 Q142 90 110 110" fill="rgba(232,240,235,0.03)" stroke="rgba(232,240,235,0.18)" strokeWidth="1.5"/>
      <path d="M50 110 Q34 144 38 176 Q42 208 50 212" stroke="rgba(232,240,235,0.18)" strokeWidth="1.5" fill="none"/>
      <path d="M110 110 Q126 144 122 176 Q118 208 110 212" stroke="rgba(232,240,235,0.18)" strokeWidth="1.5" fill="none"/>
      <path d="M50 212 Q14 232 14 278 Q14 334 80 348 Q146 334 146 278 Q146 232 110 212" fill="rgba(232,240,235,0.03)" stroke="rgba(232,240,235,0.18)" strokeWidth="1.5"/>
      <rect x="70" y="0" width="20" height="28" rx="4" fill="rgba(232,240,235,0.05)" stroke="rgba(232,240,235,0.2)" strokeWidth="1.5"/>
      <path d="M70 0 Q60 -8 65 -16 Q70 -22 80 -18 Q86 -12 80 -4" stroke="rgba(232,240,235,0.24)" strokeWidth="1.5" fill="none"/>
      {[-5,-1,1,5].map((x, i) => (
        <line key={i} x1={80+x} y1={-4} x2={80+x*0.3} y2={338} stroke="rgba(232,240,235,0.14)" strokeWidth="0.8"/>
      ))}
      <path d="M57 248 Q54 258 57 270 Q59 274 56 282" stroke="rgba(232,240,235,0.28)" strokeWidth="1.2" fill="none"/>
      <path d="M103 248 Q106 258 103 270 Q101 274 104 282" stroke="rgba(232,240,235,0.28)" strokeWidth="1.2" fill="none"/>
      <path d="M65 302 L75 297 L85 297 L95 302" stroke="rgba(214,177,104,0.45)" strokeWidth="1.2" fill="none"/>
      <line x1="80" y1="348" x2="80" y2="395" stroke="rgba(232,240,235,0.16)" strokeWidth="2"/>
    </svg>
  )
}

function PianoSVG() {
  return (
    <svg viewBox="0 0 600 160" fill="none" xmlns="http://www.w3.org/2000/svg" className={styles.instrumentSvg} style={{ width: '100%', height: 'auto', maxWidth: 600 }}>
      <path d="M30 36 L130 8 L570 8 L570 36 Q570 46 560 46 L40 46 Q30 46 30 36Z" fill="rgba(232,240,235,0.04)" stroke="rgba(232,240,235,0.14)" strokeWidth="1.5"/>
      <rect x="30" y="46" width="540" height="84" rx="4" fill="rgba(232,240,235,0.03)" stroke="rgba(232,240,235,0.12)" strokeWidth="1.5"/>
      {Array.from({ length: 22 }).map((_, i) => (
        <rect key={i} x={38 + i * 23} y="50" width="21" height="72" rx="2" fill="rgba(232,240,235,0.08)" stroke="rgba(232,240,235,0.1)" strokeWidth="1"/>
      ))}
      {[1,2,4,5,6,8,9,11,12,13,15,16,18,19].map((pos, i) => (
        <rect key={i} x={38 + pos * 23 + 13} y="50" width="14" height="48" rx="2" fill="rgba(9,17,12,0.9)" stroke="rgba(232,240,235,0.08)" strokeWidth="1"/>
      ))}
      <ellipse cx="248" cy="143" rx="13" ry="7" fill="rgba(214,177,104,0.2)" stroke="rgba(214,177,104,0.4)" strokeWidth="1"/>
      <ellipse cx="280" cy="143" rx="13" ry="7" fill="rgba(214,177,104,0.2)" stroke="rgba(214,177,104,0.4)" strokeWidth="1"/>
      <ellipse cx="312" cy="143" rx="13" ry="7" fill="rgba(214,177,104,0.2)" stroke="rgba(214,177,104,0.4)" strokeWidth="1"/>
    </svg>
  )
}

const CLARINET_LINES = [
  'Analyzing m.12 — clarinet entrance...',
  '',
  'Timing: 18ms early on the pickup.',
  'Intonation: high D sits sharp.',
  '',
  '→ Ease into the triplet run.',
  '  Let the phrase land on the beat.',
]

const CELLO_LINES = [
  'Issue · m.24 — bow pressure',
  '',
  'Sustained G shows uneven tone —',
  'bow speed drops mid-note.',
  '',
  '→ Keep arm weight constant.',
  '  Contact point: middle of bow.',
]

const PIANO_LINES_1 = [
  'Dynamics · m.8',
  'Left hand too prominent.',
  '→ Soften bass to mp.',
]

const PIANO_LINES_2 = [
  'Voicing · m.16',
  'Inner voices masking soprano.',
  '→ Weight the top line.',
]

const PIANO_LINES_3 = [
  'Timing · m.31',
  'Rubato slightly rushed.',
  '→ Hold the phrase peak.',
]

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

/* ── Per-character word materialization ── */
function AnimatedWord({ word, visible, color }) {
  return (
    <>
      {word.split('').map((char, i) => (
        <span
          key={i}
          className={`${styles.heroChar} ${visible ? styles.heroCharIn : styles.heroCharOut}`}
          style={{ '--ci': i, '--ct': word.length, '--w-color': color }}
        >
          {char}
        </span>
      ))}
    </>
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
  const [wordIdx, setWordIdx]         = useState(0)
  const [wordVisible, setWordVisible] = useState(true)
  const canvasRef = useRef(null)
  const [clarinetRef, clarinetInView] = useInView()
  const [celloRef,    celloInView]    = useInView()
  const [pianoRef,    pianoInView]    = useInView()

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

  /* ── Word cycling ── */
  useEffect(() => {
    const id = setInterval(() => {
      setWordVisible(false)
      // Give the exit animation time to fully finish before swapping text
      setTimeout(() => setWordIdx(i => (i + 1) % ROTATING_LINES.length), 480)
      setTimeout(() => setWordVisible(true), 540)
    }, 3600)
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
            <span className={styles.heroWordFrame} aria-live="polite" aria-atomic="true">
              <AnimatedWord word={current.we} visible={wordVisible} color={current.color} />
            </span>
            <span className={styles.heroComma}>,&nbsp;you</span>
            <span className={styles.heroWordFrame} aria-live="polite" aria-atomic="true">
              <AnimatedWord word={current.you} visible={wordVisible} color={current.color} />
            </span>
          </span>
        </h1>

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

      {/* ── Instruments ── */}
      <section className={styles.instrumentsSection}>

        {/* Clarinet — instrument on right */}
        <div className={`${styles.instrumentBand} ${styles.revealL}`} ref={clarinetRef}>
          <div className={styles.instrumentText}>
            <span className={styles.sectionLabel}>Woodwinds</span>
            <h2 className={styles.instrumentTitle}>Measure-by-measure<br />clarity for wind players</h2>
            <p className={styles.instrumentBody}>
              Mediant catches timing drift, intonation shifts, and tonal inconsistencies that are easy to miss in the moment — flagged to the exact measure.
            </p>
            <TypeBox lines={CLARINET_LINES} accentColor="#5cb86b" active={clarinetInView} />
          </div>
          <div className={`${styles.instrumentVisual} ${styles.revealR}`} style={{ '--d': '80ms' }}>
            <div className={styles.instrumentSvgWrap}>
              <div className={styles.instrumentGlow} style={{ '--glow-color': 'rgba(92,184,107,0.12)' }} />
              <ClarinetSVG />
            </div>
            <div className={styles.notesContainer} aria-hidden>
              <FloatingNotes count={7} color="#5cb86b" />
            </div>
          </div>
        </div>

        {/* Cello — instrument on left */}
        <div className={`${styles.instrumentBand} ${styles.instrumentBandFlip} ${styles.revealR}`} ref={celloRef}>
          <div className={styles.instrumentText}>
            <span className={styles.sectionLabel}>Strings</span>
            <h2 className={styles.instrumentTitle}>Bow technique feedback<br />you can act on</h2>
            <p className={styles.instrumentBody}>
              From bow pressure to phrasing shape — Mediant hears what your ear misses and tells you exactly what to adjust next session.
            </p>
            <TypeBox lines={CELLO_LINES} accentColor="#d6b168" active={celloInView} />
          </div>
          <div className={`${styles.instrumentVisual} ${styles.revealL}`} style={{ '--d': '80ms' }}>
            <div className={styles.instrumentSvgWrap}>
              <div className={styles.instrumentGlow} style={{ '--glow-color': 'rgba(214,177,104,0.1)' }} />
              <CelloSVG />
            </div>
            <div className={styles.notesContainer} aria-hidden>
              <FloatingNotes count={6} color="#d6b168" />
            </div>
          </div>
        </div>

        {/* Piano — full width center */}
        <div className={`${styles.pianoBand} ${styles.reveal}`} ref={pianoRef}>
          <div className={styles.pianoHead}>
            <span className={styles.sectionLabel}>Keyboard</span>
            <h2 className={styles.instrumentTitle}>Every voice, every hand,<br />every measure</h2>
            <p className={styles.instrumentBody} style={{ maxWidth: 520, margin: '0 auto' }}>
              Piano analysis tracks both hands independently — voicing balance, dynamic shaping, and rhythmic precision all at once.
            </p>
          </div>
          <div className={styles.pianoVisualWrap}>
            <div className={styles.pianoFadeLeft} />
            <div className={styles.pianoFadeRight} />
            <div className={styles.notesContainer} aria-hidden>
              <FloatingNotes count={10} color="#5cb86b" />
            </div>
            <PianoSVG />
          </div>
          <div className={styles.pianoBoxes}>
            <TypeBox lines={PIANO_LINES_1} accentColor="#5cb86b"  active={pianoInView} />
            <TypeBox lines={PIANO_LINES_2} accentColor="#d6b168" active={pianoInView} />
            <TypeBox lines={PIANO_LINES_3} accentColor="#5cb86b"  active={pianoInView} />
          </div>
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
