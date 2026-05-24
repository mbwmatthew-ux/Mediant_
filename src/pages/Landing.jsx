import { useEffect, useState } from 'react'
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
    title: 'Score-aware analysis',
    body: 'Every flag is tied to a specific measure and beat — not a vague average. Mediant reads the sheet music, not just the audio.',
  },
  {
    icon: CoachIcon,
    title: 'Feedback that sounds human',
    body: 'Feedback reads like it came from a conservatory teacher. Musical context, not just correct vs. incorrect.',
  },
  {
    icon: ProgressIcon,
    title: 'Session history',
    body: 'Track exactly which passages improved across every take. See where your practice is paying off.',
  },
]

const STEPS = [
  { num: '01', title: 'Upload your recording', body: 'Drop in a video or audio file from your practice session.' },
  { num: '02', title: 'Maps it to the score',  body: 'Mediant aligns every note to your sheet music, measure by measure.' },
  { num: '03', title: 'Get targeted feedback', body: 'Click any flagged measure for specific, actionable feedback.' },
]

const INSTRUMENTS = ['Piano', 'Violin', 'Viola', 'Cello', 'Voice', 'Flute', 'Clarinet', 'Guitar', 'Harp', 'Trumpet']

/* ── Animated logo that draws itself in ──────────────────────── */
function AnimatedLogo({ size = 28 }) {
  const vb = 84
  const w = size
  const h = Math.round(size * (vb / vb))
  return (
    <svg width={w} height={h} viewBox="0 0 84 84" fill="none" className={styles.logoSvg}>
      <line x1="6"  y1="14" x2="78" y2="14" stroke="currentColor" strokeWidth="5" strokeLinecap="square"
        className={styles.ll} style={{ '--d': '0ms',   '--l': 72 }} />
      <line x1="6"  y1="72" x2="78" y2="72" stroke="currentColor" strokeWidth="5" strokeLinecap="square"
        className={styles.ll} style={{ '--d': '55ms',  '--l': 72 }} />
      <line x1="14" y1="14" x2="14" y2="72" stroke="currentColor" strokeWidth="5" strokeLinecap="square"
        className={styles.ll} style={{ '--d': '110ms', '--l': 58 }} />
      <line x1="42" y1="14" x2="42" y2="72" stroke="currentColor" strokeWidth="5" strokeLinecap="square"
        className={styles.ll} style={{ '--d': '155ms', '--l': 58 }} />
      <line x1="70" y1="14" x2="70" y2="72" stroke="currentColor" strokeWidth="5" strokeLinecap="square"
        className={styles.ll} style={{ '--d': '200ms', '--l': 58 }} />
      <line x1="14" y1="14" x2="42" y2="72" stroke="currentColor" strokeWidth="5" strokeLinecap="square"
        className={styles.ll} style={{ '--d': '255ms', '--l': 65 }} />
      <line x1="70" y1="14" x2="42" y2="72" stroke="currentColor" strokeWidth="5" strokeLinecap="square"
        className={styles.ll} style={{ '--d': '310ms', '--l': 65 }} />
    </svg>
  )
}

/* ── Large glowing hero logo ─────────────────────────────────── */
function HeroLogo() {
  return (
    <div className={styles.heroLogoWrap}>
      <div className={styles.heroLogoGlow} />
      <svg width="80" height="80" viewBox="0 0 84 84" fill="none" className={styles.heroLogoSvg}>
        <line x1="6"  y1="14" x2="78" y2="14" stroke="rgba(232,240,235,0.9)" strokeWidth="5" strokeLinecap="square"
          className={styles.ll} style={{ '--d': '100ms', '--l': 72 }} />
        <line x1="6"  y1="72" x2="78" y2="72" stroke="rgba(232,240,235,0.9)" strokeWidth="5" strokeLinecap="square"
          className={styles.ll} style={{ '--d': '160ms', '--l': 72 }} />
        <line x1="14" y1="14" x2="14" y2="72" stroke="rgba(232,240,235,0.9)" strokeWidth="5" strokeLinecap="square"
          className={styles.ll} style={{ '--d': '220ms', '--l': 58 }} />
        <line x1="42" y1="14" x2="42" y2="72" stroke="rgba(232,240,235,0.9)" strokeWidth="5" strokeLinecap="square"
          className={styles.ll} style={{ '--d': '270ms', '--l': 58 }} />
        <line x1="70" y1="14" x2="70" y2="72" stroke="rgba(232,240,235,0.9)" strokeWidth="5" strokeLinecap="square"
          className={styles.ll} style={{ '--d': '320ms', '--l': 58 }} />
        <line x1="14" y1="14" x2="42" y2="72" stroke="rgba(232,240,235,0.9)" strokeWidth="5" strokeLinecap="square"
          className={styles.ll} style={{ '--d': '380ms', '--l': 65 }} />
        <line x1="70" y1="14" x2="42" y2="72" stroke="rgba(232,240,235,0.9)" strokeWidth="5" strokeLinecap="square"
          className={styles.ll} style={{ '--d': '435ms', '--l': 65 }} />
      </svg>
    </div>
  )
}

/* ── Brand wordmark ──────────────────────────────────────────── */
function Wordmark({ className }) {
  return (
    <span className={`${styles.wordmark} ${className || ''}`}>
      Mediant
    </span>
  )
}

export default function Landing() {
  const [wordIdx, setWordIdx]         = useState(0)
  const [wordVisible, setWordVisible] = useState(true)

  useEffect(() => {
    const id = setInterval(() => {
      setWordVisible(false)
      // Change word while invisible, then fade in — no key remounting needed
      setTimeout(() => setWordIdx(i => (i + 1) % ROTATING_LINES.length), 320)
      setTimeout(() => setWordVisible(true), 370)
    }, 2800)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const els = document.querySelectorAll(`.${styles.reveal}`)
    if (!els.length) return
    const obs = new IntersectionObserver(
      entries => entries.forEach(e => {
        if (e.isIntersecting) e.target.classList.add(styles.revealVisible)
      }),
      { threshold: 0.06, rootMargin: '0px 0px -40px 0px' },
    )
    els.forEach(el => obs.observe(el))
    return () => obs.disconnect()
  }, [])

  const current = ROTATING_LINES[wordIdx]

  return (
    <div className={styles.page}>

      {/* ── Nav ─────────────────────────────────────────────── */}
      <nav className={styles.nav}>
        <Link to="/" className={styles.navBrand}>
          <AnimatedLogo size={22} />
          <Wordmark />
        </Link>
        <div className={styles.navRight}>
          <Link to="/login"  className={styles.navLogin}>Log in</Link>
          <Link to="/signup" className={styles.navCta}>Get started free →</Link>
        </div>
      </nav>

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className={styles.hero}>

        {/* Large animated logo mark */}
        <div className={styles.heroLogoAnim}>
          <HeroLogo />
        </div>

        <div className={styles.heroBadge}>
          <span className={styles.heroBadgeDot} />
          Intelligent music performance
        </div>

        <h1 className={styles.heroHeading}>
          <span className={styles.heroLine}>
            <span className={styles.heroStatic}>We</span>
            <span className={styles.heroWordFrame} aria-live="polite" aria-atomic="true">
              <span
                className={`${styles.heroWord} ${wordVisible ? styles.heroWordIn : styles.heroWordOut}`}
                style={{ '--w-color': current.color }}
              >
                {current.we}
              </span>
            </span>
            <span className={styles.heroComma}>,</span>
          </span>
          <span className={styles.heroLine}>
            <span className={styles.heroStatic}>you</span>
            <span className={styles.heroWordFrame} aria-live="polite" aria-atomic="true">
              <span
                className={`${styles.heroWord} ${wordVisible ? styles.heroWordIn : styles.heroWordOut}`}
                style={{ '--w-color': current.color }}
              >
                {current.you}
              </span>
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

        {/* Instrument chips */}
        <div className={styles.instrRow}>
          <span className={styles.instrLabel}>Works with</span>
          {INSTRUMENTS.map(i => (
            <span key={i} className={styles.instrChip}>{i}</span>
          ))}
          <span className={styles.instrMore}>+ more</span>
        </div>
      </section>

      {/* ── App mockup ──────────────────────────────────────── */}
      <div className={`${styles.previewWrap} ${styles.reveal}`}>
        <div className={styles.previewShell}>
          <div className={styles.previewTopBar}>
            <div className={styles.previewTopLeft}>
              <div className={styles.previewLogoBox} />
              <span className={styles.previewSep}>/</span>
              <span className={styles.previewOrg}>Mediant</span>
              <span className={styles.previewSep}>/</span>
              <span className={styles.previewCrumb}>Score Review</span>
              <span className={styles.previewBadge}>PRACTICE</span>
            </div>
            <div className={styles.previewTopRight}>
              <span className={styles.previewNavLink}>Record</span>
              <span className={styles.previewNavLink}>Library</span>
              <div className={styles.previewAvatar}>MS</div>
            </div>
          </div>
          <div className={styles.previewBody}>
            <div className={styles.previewSidebar}>
              {[
                <svg key="h"  width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/><path d="M9 21V12h6v9"/></svg>,
                <svg key="s"  width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>,
                <svg key="u"  width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>,
                <svg key="sc" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
                <svg key="p"  width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
              ].map((icon, i) => (
                <div key={i} className={`${styles.previewNavItem} ${i === 2 ? styles.previewNavItemActive : ''}`}>
                  {icon}
                </div>
              ))}
            </div>
            <div className={styles.previewMain}>
              <div className={styles.previewContentTop}>
                <div className={styles.previewPieceInfo}>
                  <span className={styles.previewPieceName}>Clair de Lune</span>
                  <span className={styles.previewPieceMeta}>Debussy · Piano</span>
                </div>
                <div className={styles.previewScoreBadge}>
                  <span className={styles.previewScoreNum}>78</span>
                  <span className={styles.previewScoreDen}>/100</span>
                </div>
                <div className={styles.previewIssueChips}>
                  <div className={styles.previewChip}>Timing</div>
                  <div className={`${styles.previewChip} ${styles.previewChipActive}`}>Rushing ×2</div>
                  <div className={styles.previewChip}>Dynamics</div>
                </div>
              </div>
              <div className={styles.previewTwoCol}>
                <div className={styles.previewScore}>
                  {[
                    [{x:'22%',y:'32%'},{x:'30%',y:'60%'},{x:'38%',y:'42%'},{x:'46%',y:'72%'},{x:'58%',y:'28%'},{x:'66%',y:'56%'},{x:'74%',y:'40%'},{x:'82%',y:'66%'}],
                    [{x:'22%',y:'56%'},{x:'30%',y:'36%'},{x:'38%',y:'70%'},{x:'46%',y:'44%'},{x:'58%',y:'76%'},{x:'66%',y:'38%'},{x:'74%',y:'62%'},{x:'82%',y:'50%'}],
                    [{x:'22%',y:'44%'},{x:'32%',y:'68%'},{x:'42%',y:'30%'},{x:'52%',y:'58%'},{x:'62%',y:'46%'},{x:'72%',y:'72%'},{x:'82%',y:'36%'}],
                    [{x:'22%',y:'38%'},{x:'32%',y:'64%'},{x:'42%',y:'50%'},{x:'52%',y:'30%'},{x:'62%',y:'68%'},{x:'72%',y:'44%'},{x:'82%',y:'56%'}],
                  ].map((notes, i) => (
                    <div key={i} className={`${styles.previewStave} ${i === 1 ? styles.previewStaveFlagged : ''}`}>
                      <span className={styles.previewClef}>𝄞</span>
                      {i === 0 && <div className={styles.previewTimeSig}><span>4</span><span>4</span></div>}
                      <div className={styles.previewStaffLine}/><div className={styles.previewStaffLine}/>
                      <div className={styles.previewStaffLine}/><div className={styles.previewStaffLine}/>
                      <div className={styles.previewStaffLine}/>
                      {['25%','50%','75%'].map(p => <div key={p} className={styles.previewMeasureBar} style={{left:p}}/>)}
                      {notes.map((n, j) => (
                        <div key={j}
                          className={`${styles.previewNote} ${i===1?styles.previewNoteFlagged:''} ${parseFloat(n.y)<=50?'':styles.previewNoteStemDown}`}
                          style={{left:n.x,top:n.y}}/>
                      ))}
                    </div>
                  ))}
                </div>
                <svg className={styles.previewConnectorSvg} viewBox="0 0 32 264" preserveAspectRatio="none" style={{overflow:'visible'}}>
                  <circle cx="1" cy="102" r="3.5" fill="rgba(225,134,118,0.92)"/>
                  <path d="M 1 102 C 22 102 10 46 28 46" stroke="rgba(225,134,118,0.6)" strokeWidth="1.5" strokeDasharray="4 3" fill="none"/>
                  <circle cx="28" cy="46" r="2.5" fill="rgba(225,134,118,0.92)"/>
                </svg>
                <div className={styles.previewFeedback}>
                  <span className={styles.previewFeedTag}>Timing · m.13</span>
                  <span className={styles.previewFeedTitle}>Rushing</span>
                  <ul className={styles.previewFeedList}>
                    <li className={styles.previewFeedItem}>Playing ahead of the beat in mm. 12–14</li>
                    <li className={styles.previewFeedItem}>Rushing through the 8th-note runs</li>
                    <li className={styles.previewFeedItem}>Slow the pickup — let the phrase breathe</li>
                  </ul>
                  <div className={styles.previewWaveform}>
                    {[28,45,70,38,60,82,50,35,65,44,72,30].map((h,j)=>(
                      <span key={j} className={j<7?styles.previewWaveDone:styles.previewWaveTodo} style={{height:`${h}%`}}/>
                    ))}
                  </div>
                  <button className={styles.previewFeedBtn}>Loop excerpt</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Features ────────────────────────────────────────── */}
      <section className={styles.features}>
        <div className={`${styles.featuresHead} ${styles.reveal}`}>
          <p className={styles.sectionLabel}>What you get</p>
          <h2 className={styles.featuresTitle}>Everything a serious<br />practice session needs</h2>
        </div>
        <div className={styles.featureGrid}>
          {FEATURES.map((f, i) => (
            <div key={f.title} className={`${styles.featureCard} ${styles.reveal}`} style={{ '--d': `${i * 80}ms` }}>
              <div className={styles.featureIconWrap}><f.icon /></div>
              <h3 className={styles.featureTitle}>{f.title}</h3>
              <p className={styles.featureBody}>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────── */}
      <section className={styles.howItWorks}>
        <div className={`${styles.howHead} ${styles.reveal}`}>
          <p className={styles.sectionLabel}>How it works</p>
          <h2 className={styles.howTitle}>Three steps to<br />better practice</h2>
        </div>
        <div className={styles.steps}>
          {STEPS.map((s, i) => (
            <div key={s.num} className={`${styles.step} ${styles.reveal}`} style={{ '--d': `${i * 100}ms` }}>
              <span className={styles.stepNum}>{s.num}</span>
              <h3 className={styles.stepTitle}>{s.title}</h3>
              <p className={styles.stepBody}>{s.body}</p>
              {i < STEPS.length - 1 && <div className={styles.stepArrow}>→</div>}
            </div>
          ))}
        </div>
      </section>

      {/* ── Final CTA ───────────────────────────────────────── */}
      <section className={`${styles.ctaSection} ${styles.reveal}`}>
        <h2 className={styles.ctaTitle}>Practice with intention,<br />not just repetition.</h2>
        <p className={styles.ctaSub}>Join musicians turning practice time into real, measurable progress.</p>
        <div className={styles.heroCtas}>
          <Link to="/signup" className={styles.ctaPrimary}>Create your free account</Link>
          <Link to="/login"  className={styles.ctaGhost}>Log in</Link>
        </div>
        <p className={styles.heroNote}>No credit card · Cancel anytime</p>
      </section>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className={styles.footer}>
        <div className={styles.footerLeft}>
          <Link to="/" className={styles.navBrand} style={{ opacity: 0.6 }}>
            <AnimatedLogo size={18} />
            <Wordmark />
          </Link>
          <p className={styles.footerTagline}>Intelligent music performance analysis.</p>
        </div>
        <div className={styles.footerLinks}>
          <a href="#" className={styles.footerLink}>Privacy</a>
          <a href="#" className={styles.footerLink}>Terms</a>
          <a href="#" className={styles.footerLink}>Contact</a>
        </div>
        <p className={styles.footerCopy}>© 2026 Mediant</p>
      </footer>
    </div>
  )
}

/* ── Icons ─────────────────────────────────────────────────── */
function ScoreIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
    </svg>
  )
}
function CoachIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  )
}
function ProgressIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  )
}
