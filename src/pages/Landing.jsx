import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { PLANS, HIGHLIGHT_PLAN_ID } from '../lib/pricing'
import styles from './Landing.module.css'

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

function useInView(threshold = 0.12) {
  const ref = useRef(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true) },
      { threshold }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [threshold])
  return [ref, inView]
}

function Reveal({ as: Tag = 'div', className = '', children, delay = '0ms' }) {
  const [ref, inView] = useInView()
  return (
    <Tag
      ref={ref}
      className={`${styles.reveal} ${inView ? styles.revealVisible : ''} ${className}`}
      style={{ '--delay': delay }}
    >
      {children}
    </Tag>
  )
}

const STEPS = [
  {
    n: '01',
    title: 'Upload your score',
    body: 'Add the sheet music for the piece you are practicing. MusicXML gives the clearest structure, while images and PDFs can still help Mediant understand the piece.',
  },
  {
    n: '02',
    title: 'Record a take',
    body: 'Upload audio or video from a practice session. Mediant connects the performance back to the score so feedback has a place to land.',
  },
  {
    n: '03',
    title: 'Get measure-level feedback',
    body: 'Review the measures that need attention, replay the matching moment, and turn the feedback into a focused next practice session.',
  },
]

const FEATURES = [
  {
    icon: '↗',
    title: 'Pitch detection',
    body: 'Cent-level pitch accuracy measured against your score. Know when you are flat, sharp, and by exactly how much.',
  },
  {
    icon: '⊙',
    title: 'Timing analysis',
    body: 'See where the performance rushes, drags, or loses the pulse so your next repetition has a clear target.',
  },
  {
    icon: '≋',
    title: 'Dynamics tracking',
    body: 'Compare the shape of your playing against the markings in the score, from softer entrances to bigger phrase peaks.',
  },
  {
    icon: '↺',
    title: 'Loop any section',
    body: 'One click to hear the exact window where an issue happened. Loop it as many times as you need without scrubbing.',
  },
  {
    icon: '◈',
    title: 'Score always visible',
    body: 'The sheet music stays on screen while you review feedback. No tab switching, no losing your place.',
  },
  {
    icon: '▲',
    title: 'Progress over takes',
    body: 'Upload a second take and see what improved, what regressed, and what stayed the same across the thread.',
  },
]

// Teaser card on the homepage — derived from the shared pricing source so the
// homepage can never show a different price than the /pricing page.
const HIGHLIGHT = PLANS.find(p => p.id === HIGHLIGHT_PLAN_ID) ?? PLANS[0]
const PRICING = [
  {
    name: HIGHLIGHT.name,
    price: HIGHLIGHT.monthlyPrice,
    period: 'per month',
    desc: HIGHLIGHT.description,
    features: HIGHLIGHT.features.filter(f => f.included).map(f => f.text),
    cta: HIGHLIGHT.cta,
  },
]

const FAQS = [
  {
    q: 'What instruments does Mediant support?',
    a: 'Mediant is being designed for common solo practice recordings across strings, woodwinds, brass, piano, guitar, and voice. Accuracy depends on score quality, recording clarity, and the instrument being analyzed.',
  },
  {
    q: 'Do I need to upload sheet music?',
    a: 'Sheet music is recommended because it lets Mediant connect feedback to specific measures. MusicXML or MXL gives the highest-trust structure; images and PDFs can work but may be less precise.',
  },
  {
    q: 'How long does analysis take?',
    a: 'Analysis time depends on recording length, file size, and the level of review being run. You will see progress while Mediant processes your recording.',
  },
  {
    q: 'Can I use Mediant for orchestral or ensemble recordings?',
    a: 'Mediant is focused on solo practice takes first. It works best when one instrument is clearly audible and visible.',
  },
  {
    q: 'Is my music data private?',
    a: 'Yes. Your recordings and sheet music are stored securely and are never shared with or used to train third-party models. You can export or delete your data at any time from Settings.',
  },
]

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`${styles.faqItem} ${open ? styles.faqOpen : ''}`}>
      <button className={styles.faqQ} onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span>{q}</span>
        <span className={styles.faqChevron}>{open ? '−' : '+'}</span>
      </button>
      {open && <p className={styles.faqA}>{a}</p>}
    </div>
  )
}

const WAVE_BARS = [
  18, 35, 52, 28, 72, 45, 88, 60, 38, 55,
  76, 42, 64, 30, 50, 82, 57, 36, 68, 44,
  78, 53, 32, 84, 61, 40, 70, 47, 25, 58,
  75, 42, 88, 35, 62, 49, 74, 30, 55, 38,
]
const FLAGGED_BARS = [6, 7, 8, 22, 23, 24]

const MARQUEE_ITEMS = [
  'Pitch Analysis', 'Timing Feedback', 'Dynamics', 'Articulation',
  'Measure-Level', 'Loop Playback', 'AI Coaching', 'Progress Tracking',
]

export default function Landing() {
  // Refs for direct DOM writes — avoids React re-renders at 60fps
  const fill1Ref = useRef(null)
  const fill2Ref = useRef(null)
  const fill3Ref = useRef(null)
  const num1Ref  = useRef(null)
  const num2Ref  = useRef(null)
  const num3Ref  = useRef(null)

  useEffect(() => {
    let frame
    const start = performance.now()
    const PI2 = 2 * Math.PI
    function tick(now) {
      const t = (now - start) / 1000
      // Float widths → smooth bar; Math.round → integer label
      const v1 = 77   - 5   * Math.cos(t * PI2 / 3.8)
      const v2 = 83   + 5   * Math.cos(t * PI2 / 4.4)
      const v3 = 82.5 - 3.5 * Math.cos(t * PI2 / 5.2)
      if (fill1Ref.current) fill1Ref.current.style.width = `${v1}%`
      if (fill2Ref.current) fill2Ref.current.style.width = `${v2}%`
      if (fill3Ref.current) fill3Ref.current.style.width = `${v3}%`
      if (num1Ref.current)  num1Ref.current.textContent  = Math.round(v1)
      if (num2Ref.current)  num2Ref.current.textContent  = Math.round(v2)
      if (num3Ref.current)  num3Ref.current.textContent  = Math.round(v3)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div className={styles.page}>

      {/* ── NAV ────────────────────────────────────────── */}
      <nav className={styles.nav} aria-label="Main navigation">
          <Link to="/" className={styles.navBrand} aria-label="Mediant home">
          <span className={styles.navLogoMark} aria-hidden="true" />
          <span className={styles.navWordmark}>Mediant</span>
        </Link>

        <div className={styles.navLinks}>
          <a href="#how-it-works">How it works</a>
          <a href="#features">Features</a>
          <Link to="/pricing">Pricing</Link>
          <a href="#faq">FAQ</a>
        </div>

        <div className={styles.navActions}>
          <Link to="/login" className={styles.navLogin}>Log in</Link>
          <Link to="/signup" className={styles.navCta}>Get started →</Link>
        </div>
      </nav>

      <main>

        {/* ── HERO ───────────────────────────────────────── */}
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <div className={styles.heroCopy}>
              <p className={styles.heroEyebrow}>AI Music Practice Coach</p>
              <h1 className={styles.heroH1}>
                Finally, feedback that points to the measure.
              </h1>
              <p className={styles.heroLead}>
                Upload a recording. Mediant analyzes pitch, timing, and dynamics against your score — then shows you where to focus before your next session.
              </p>
              <div className={styles.heroActions}>
                <Link to="/signup" className={styles.btnPrimary}>Get started →</Link>
                <a href="#how-it-works" className={styles.btnGhost}>See how it works</a>
              </div>
              <p className={styles.heroNote}>Built for focused solo practice · Works best with clear scores and recordings</p>
            </div>

            <div className={styles.heroVisual}>
              <div className={styles.waveformCard}>
                <div className={styles.waveformCardHead}>
                  <span className={styles.waveformPieceTag}>Clair de lune — Take 7</span>
                </div>
                <div className={styles.waveformBarsWrap}>
                  {WAVE_BARS.map((h, i) => (
                    <div
                      key={i}
                      className={`${styles.waveBar} ${FLAGGED_BARS.includes(i) ? styles.waveBarFlagged : ''}`}
                      style={{ '--barH': `${h}px`, '--d': `${(i * 47) % 720}ms` }}
                    />
                  ))}
                </div>
                <div className={styles.waveformMetricBars}>
                  <div className={styles.waveformMetricRow}>
                    <span className={styles.waveformMetricLabel}>Intonation</span>
                    <div className={styles.waveformMetricTrack}>
                      <div ref={fill1Ref} className={`${styles.waveformMetricFill} ${styles.waveformMetricFill1}`} style={{ width: '72%' }} />
                    </div>
                    <span ref={num1Ref} className={styles.waveformMetricVal} style={{ color: '#EE7B53' }}>72</span>
                  </div>
                  <div className={styles.waveformMetricRow}>
                    <span className={styles.waveformMetricLabel}>Dynamics</span>
                    <div className={styles.waveformMetricTrack}>
                      <div ref={fill2Ref} className={`${styles.waveformMetricFill} ${styles.waveformMetricFill2}`} style={{ width: '88%' }} />
                    </div>
                    <span ref={num2Ref} className={styles.waveformMetricVal} style={{ color: '#C09230' }}>88</span>
                  </div>
                  <div className={`${styles.waveformMetricRow} ${styles.waveformMetricRowOverall}`}>
                    <span className={styles.waveformMetricLabel}>Overall Score</span>
                    <div className={styles.waveformMetricTrack}>
                      <div ref={fill3Ref} className={`${styles.waveformMetricFill} ${styles.waveformMetricFill3}`} style={{ width: '79%' }} />
                    </div>
                    <span ref={num3Ref} className={styles.waveformMetricVal} style={{ color: '#8fbe9f' }}>79</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── MARQUEE ────────────────────────────────────── */}
        <div className={styles.marqueeStrip} aria-hidden="true">
          <div className={styles.marqueeTrack}>
            {[...MARQUEE_ITEMS, ...MARQUEE_ITEMS].map((t, i) => (
              <span key={i} className={styles.marqueeItem}>
                {t} <span className={styles.marqueeSep}>◆</span>
              </span>
            ))}
          </div>
        </div>

        {/* ── HOW IT WORKS ───────────────────────────────── */}
        <section className={styles.howSection} id="how-it-works">
          <div className={styles.sectionInner}>
            <Reveal className={styles.sectionHead}>
              <p className={styles.eyebrow}>How it works</p>
              <h2>Three steps to sharper practice.</h2>
              <p>Use Mediant after a practice session. Walk away with a specific, prioritized list of what to fix — not a vague impression.</p>
            </Reveal>

            <div className={styles.stepsStack}>
              {STEPS.map((step, i) => (
                <Reveal key={step.n} className={styles.stepRow} delay={`${i * 100}ms`}>
                  <div className={styles.stepRowNum}>{step.n}</div>
                  <div className={styles.stepRowBar} />
                  <div className={styles.stepRowContent}>
                    <h3 className={styles.stepRowTitle}>{step.title}</h3>
                    <p className={styles.stepRowBody}>{step.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ── COMING SOON ────────────────────────────────── */}
        <section className={styles.comingSoonSection}>
          <div className={styles.sectionInner}>
            <Reveal className={styles.comingSoonBox}>
              <p className={styles.comingSoonEyebrow}>App Preview</p>
              <h2 className={styles.comingSoonH2}>The full interface is on its way.</h2>
              <p className={styles.comingSoonBody}>
                We're in the final stretch, putting the finishing touches on the Mediant experience. Sign up now and be the first to know when it launches.
              </p>
              <div className={styles.comingSoonActions}>
                <Link to="/signup" className={styles.btnPrimary}>Get early access →</Link>
                <span className={styles.comingSoonNote}>Launching soon</span>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── FEATURES GRID ──────────────────────────────── */}
        <section className={styles.featuresSection} id="features">
          <div className={styles.sectionInner}>
            <Reveal className={styles.sectionHead}>
              <p className={styles.eyebrow}>What Mediant helps with</p>
              <h2>Built around how musicians actually practice.</h2>
            </Reveal>

            <div className={styles.featuresList}>
              {FEATURES.map((f, i) => (
                <Reveal key={f.title} className={styles.featListItem} delay={`${i * 60}ms`}>
                  <span className={styles.featListIcon}>{f.icon}</span>
                  <div>
                    <h3 className={styles.featListTitle}>{f.title}</h3>
                    <p className={styles.featListBody}>{f.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ── PRICING ────────────────────────────────────── */}
        <section className={styles.pricingSection} id="pricing">
          <div className={styles.sectionInner}>
            <Reveal className={styles.sectionHead}>
              <p className={styles.eyebrow}>Pricing</p>
              <h2>Simple, honest pricing.</h2>
              <p>Choose the plan that fits how seriously you practice.</p>
            </Reveal>

            <div className={styles.pricingGrid}>
              {PRICING.map((plan, i) => (
                <Reveal key={plan.name} className={styles.pricingCard} delay={`${i * 80}ms`}>
                  <div className={styles.pricingTop}>
                    <h3 className={styles.planName}>{plan.name}</h3>
                    <div className={styles.planPrice}>
                      <span className={styles.planAmount}>{plan.price}</span>
                      <span className={styles.planPeriod}>/{plan.period}</span>
                    </div>
                    <p className={styles.planDesc}>{plan.desc}</p>
                  </div>
                  <ul className={styles.planFeatures}>
                    {plan.features.map(f => (
                      <li key={f}>
                        <span className={styles.checkMark}>✓</span>
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Link
                    to="/signup"
                    className={styles.btnPrimary}
                  >
                    {plan.cta}
                  </Link>
                </Reveal>
              ))}
            </div>
            <Reveal>
              <p className={styles.pricingCompare}>
                <Link to="/pricing">Compare all plans →</Link>
              </p>
            </Reveal>
          </div>
        </section>

        {/* ── FAQ ────────────────────────────────────────── */}
        <section className={styles.faqSection} id="faq">
          <div className={styles.sectionInner}>
            <div className={styles.faqLayout}>
              <Reveal className={styles.faqLeft}>
                <p className={styles.eyebrow}>FAQ</p>
                <h2>Questions, answered.</h2>
                <p>Anything else? <Link to="/contact">Contact us →</Link></p>
              </Reveal>
              <div className={styles.faqRight}>
                {FAQS.map((item, i) => (
                  <Reveal key={i} delay={`${i * 50}ms`}>
                    <FAQItem q={item.q} a={item.a} />
                  </Reveal>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── CTA STRIP ──────────────────────────────────── */}
        <section className={styles.ctaStrip}>
          <div className={styles.ctaInner}>
            <Reveal>
              <h2>Ready for your next take?</h2>
              <p>Use Mediant to turn your next recording into a clearer practice plan.</p>
              <div className={styles.ctaActions}>
                <Link to="/signup" className={styles.btnWhite}>Create account →</Link>
                <Link to="/login" className={styles.btnGhostLight}>Log in</Link>
              </div>
            </Reveal>
          </div>
        </section>

      </main>

      {/* ── FOOTER ─────────────────────────────────────── */}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <div className={styles.footerLogoRow}>
              <span className={styles.footerLogoMark} aria-hidden="true" />
              <span className={styles.footerWordmark}>Mediant</span>
            </div>
            <p className={styles.footerTagline}>AI music practice coaching for growing musicians.</p>
            <p className={styles.footerCopy}>© 2026 Mediant. All rights reserved.</p>
          </div>

          <div className={styles.footerCol}>
            <p className={styles.footerColHead}>Product</p>
            <a href="#how-it-works">How it works</a>
            <a href="#features">Features</a>
            <Link to="/pricing">Pricing</Link>
            <Link to="/login">Log in</Link>
            <Link to="/signup">Sign up</Link>
          </div>

          <div className={styles.footerCol}>
            <p className={styles.footerColHead}>Tools</p>
            <Link to="/home">Dashboard</Link>
            <Link to="/record">New Session</Link>
            <Link to="/analysis">Sessions</Link>
            <Link to="/progress">Reports</Link>
            <Link to="/coach">AI Coach</Link>
          </div>

          <div className={styles.footerCol}>
            <p className={styles.footerColHead}>Company</p>
            <Link to="/contact">Contact</Link>
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
          </div>
        </div>
      </footer>

    </div>
  )
}
