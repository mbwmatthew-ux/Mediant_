import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import styles from './Landing.module.css'

const FEATURES = [
  {
    title: 'Score-Aware Analysis',
    body: 'Mediant maps your recording directly to the sheet music — not just pitch detection. Every flag is tied to a specific measure, beat, and voice.',
  },
  {
    title: 'Coaching Feedback',
    body: 'Receive warm, specific feedback that sounds like a teacher, not a metronome app. Mediant understands musical context and phrasing.',
  },
  {
    title: 'Session History',
    body: 'Every take is saved and scored. Track which passages improved over time and see exactly where your practice is paying off.',
  },
  {
    title: 'Measure-Level Flags',
    body: 'Flagged measures are tagged by issue type — timing, dynamics, voicing, articulation — so you know exactly what to work on.',
  },
  {
    title: 'Any Instrument, Any Level',
    body: 'Piano, violin, voice, and more. Beginner to advanced. Mediant adapts its feedback to your instrument and experience level.',
  },
]

const STEPS = [
  {
    num: '01',
    title: 'Upload your recording',
    body: 'Drop in an audio file from your practice session. Mediant accepts any format and works with live recordings or exports from your DAW.',
  },
  {
    num: '02',
    title: 'Maps it to the score',
    body: 'Mediant aligns your performance to the sheet music measure by measure, detecting timing, dynamics, and voicing issues with musical precision.',
  },
  {
    num: '03',
    title: 'Get targeted feedback',
    body: 'Click any flagged measure to read specific, actionable feedback. Loop the passage, fix it, and move on — with a clear record of improvement.',
  },
]

const INSTRUMENTS = ['Piano', 'Violin', 'Viola', 'Cello', 'Voice', 'Flute', 'Clarinet', 'Guitar', 'Harp', 'Trumpet', 'Oboe', 'Bassoon']

function LogoMark() {
  const S = 4.5
  const C = 'rgba(255,255,255,0.92)'
  const top = 14, bot = 72
  const xL = 14, xC = 42, xR = 70
  return (
    <svg width="22" height="26" viewBox="0 0 84 84" fill="none">
      <line x1="6"  y1={top} x2="78" y2={top} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1="6"  y1={bot} x2="78" y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1={xL} y1={top} x2={xL} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1={xC} y1={top} x2={xC} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1={xR} y1={top} x2={xR} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1={xL} y1={top} x2={xC} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1={xR} y1={top} x2={xC} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
    </svg>
  )
}

export default function Landing() {
  useEffect(() => {
    const els = document.querySelectorAll(`.${styles.reveal}`)
    if (!els.length) return
    const obs = new IntersectionObserver(
      entries => entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add(styles.revealVisible)
        } else {
          e.target.classList.remove(styles.revealVisible)
        }
      }),
      { threshold: 0.08, rootMargin: '0px 0px -40px 0px' }
    )
    els.forEach(el => obs.observe(el))
    return () => obs.disconnect()
  }, [])

  return (
    <div className={styles.page}>

      {/* Nav */}
      <nav className={styles.nav}>
        <div className={styles.navLeft}>
          <Link to="/" className={styles.brand}>
            <LogoMark />
          </Link>
          <span className={styles.navSep}>/</span>
          <span className={styles.navOrg}>Mediant</span>
          <span className={styles.navBadge}>PRACTICE</span>
        </div>
        <div className={styles.navRight}>
          <Link to="/login"  className={styles.navLogin}>Log in</Link>
          <Link to="/signup" className={styles.navCta}>Get started free</Link>
        </div>
      </nav>

      {/* Hero */}
      <section className={styles.hero}>
        <span className={styles.eyebrow}>Intelligent Practice Coach</span>
        <h1 className={styles.heroHeading}>
          The practice coach<br />
          <em>that actually listens.</em>
        </h1>
        <p className={styles.heroSub}>
          Mediant listens to your recordings, aligns them to your sheet music, and gives you
          specific, measure-by-measure feedback — like having a teacher in the room with you.
        </p>
        <div className={styles.heroCtas}>
          <Link to="/signup" className={styles.ctaPrimary}>Start for free →</Link>
          <Link to="/login"  className={styles.ctaGhost}>Log in</Link>
        </div>
        <p className={styles.heroNote}>Free to start · No credit card required · Works with any instrument</p>
      </section>

      {/* App mockup */}
      <div className={`${styles.previewWrap} ${styles.reveal}`}>
        <div className={styles.previewShell}>
          {/* Top bar */}
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
              <div className={styles.previewAvatar}>PS</div>
            </div>
          </div>
          {/* Body */}
          <div className={styles.previewBody}>
            {/* Sidebar */}
            <div className={styles.previewSidebar}>
              {[
                { icon: '♩', label: 'Score' },
                { icon: '↑', label: 'Record' },
                { icon: '▤', label: 'Takes' },
                { icon: '♪', label: 'Follow' },
                { icon: '≡', label: 'Summary' },
                { icon: '⊙', label: 'Library' },
                { icon: '✦', label: 'Coach' },
              ].map((item, i) => (
                <div key={i} className={`${styles.previewNavItem} ${i === 0 ? styles.previewNavItemActive : ''}`} title={item.label}>
                  {item.icon}
                </div>
              ))}
            </div>
            {/* Main content */}
            <div className={styles.previewMain}>
              {/* Header row */}
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
              {/* Score + feedback */}
              <div className={styles.previewTwoCol}>
                {/* Score area */}
                <div className={styles.previewScore}>
                  {[
                    [{x:'22%',y:'32%'},{x:'30%',y:'60%'},{x:'38%',y:'42%'},{x:'46%',y:'72%'},{x:'58%',y:'28%'},{x:'66%',y:'56%'},{x:'74%',y:'40%'},{x:'82%',y:'66%'}],
                    [{x:'22%',y:'56%'},{x:'30%',y:'36%'},{x:'38%',y:'70%'},{x:'46%',y:'44%'},{x:'58%',y:'76%'},{x:'66%',y:'38%'},{x:'74%',y:'62%'},{x:'82%',y:'50%'}],
                    [{x:'22%',y:'44%'},{x:'32%',y:'68%'},{x:'42%',y:'30%'},{x:'52%',y:'58%'},{x:'62%',y:'46%'},{x:'72%',y:'72%'},{x:'82%',y:'36%'}],
                    [{x:'22%',y:'38%'},{x:'32%',y:'64%'},{x:'42%',y:'50%'},{x:'52%',y:'30%'},{x:'62%',y:'68%'},{x:'72%',y:'44%'},{x:'82%',y:'56%'}],
                  ].map((notes, i) => (
                    <div key={i} className={`${styles.previewStave} ${i === 1 ? styles.previewStaveFlagged : ''}`}>
                      {/* Clef */}
                      <span className={styles.previewClef}>𝄞</span>
                      {/* Time sig on first stave only */}
                      {i === 0 && (
                        <div className={styles.previewTimeSig}><span>4</span><span>4</span></div>
                      )}
                      {/* Measure numbers */}
                      {[0,1,2,3].map(m => (
                        <span key={m} className={styles.previewMeasureNum} style={{ left: `${m * 25 + (i===0 ? 19 : 19)}%` }}>{i * 4 + m + 1}</span>
                      ))}
                      {/* Staff lines */}
                      <div className={styles.previewStaffLine} />
                      <div className={styles.previewStaffLine} />
                      <div className={styles.previewStaffLine} />
                      <div className={styles.previewStaffLine} />
                      <div className={styles.previewStaffLine} />
                      {/* Measure bars */}
                      {['25%','50%','75%'].map(pos => (
                        <div key={pos} className={styles.previewMeasureBar} style={{ left: pos }} />
                      ))}
                      {/* Notes */}
                      {notes.map((n, j) => {
                        const stemDown = parseFloat(n.y) <= 50
                        return (
                          <div
                            key={j}
                            className={`${styles.previewNote} ${i === 1 ? styles.previewNoteFlagged : ''} ${stemDown ? styles.previewNoteStemDown : ''}`}
                            style={{ left: n.x, top: n.y }}
                          />
                        )
                      })}
                      {i === 1 && (
                        <div className={styles.previewInlineAnnotation}>
                          <div className={styles.previewAnnotationCaret} />
                          Rushing
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* SVG connector */}
                <svg className={styles.previewConnectorSvg} viewBox="0 0 32 264" preserveAspectRatio="none" style={{ overflow: 'visible' }}>
                  <circle cx="1" cy="102" r="3.5" fill="rgba(225,134,118,0.92)" />
                  <path d="M 1 102 C 22 102 10 46 28 46" stroke="rgba(225,134,118,0.6)" strokeWidth="1.5" strokeDasharray="4 3" fill="none" />
                  <circle cx="28" cy="46" r="2.5" fill="rgba(225,134,118,0.92)" />
                </svg>

                {/* Feedback panel */}
                <div className={styles.previewFeedback}>
                  <span className={styles.previewFeedTag}>Timing · m.13</span>
                  <span className={styles.previewFeedTitle}>Rushing</span>
                  <ul className={styles.previewFeedList}>
                    <li className={styles.previewFeedItem}>Playing ahead of the beat in mm. 12–14</li>
                    <li className={styles.previewFeedItem}>Rushing through the 8th-note runs</li>
                    <li className={styles.previewFeedItem}>Slow the pickup — let the phrase breathe</li>
                  </ul>
                  <div className={styles.previewWaveform}>
                    {[28,45,70,38,60,82,50,35,65,44,72,30].map((h, j) => (
                      <span key={j} className={j < 7 ? styles.previewWaveDone : styles.previewWaveTodo} style={{ height: `${h}%` }} />
                    ))}
                  </div>
                  <button className={styles.previewFeedBtn}>Loop excerpt</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Instruments strip */}
      <div className={`${styles.instrumentsWrap} ${styles.reveal}`}>
        <p className={styles.instrumentsLabel}>Works with</p>
        <div className={styles.instruments}>
          {INSTRUMENTS.map(i => (
            <span key={i} className={styles.instrumentChip}>{i}</span>
          ))}
        </div>
      </div>

      {/* Features */}
      <section className={styles.features}>
        <div className={styles.featuresLayout}>
          <div className={`${styles.featuresHead} ${styles.reveal}`}>
            <p className={styles.sectionLabel}>What you get</p>
            <h2 className={styles.featuresTitle}>Everything a serious practice session needs</h2>
            <p className={styles.featuresSub}>From raw recording to actionable feedback in under a minute.</p>
          </div>
          <div className={styles.featuresList}>
            {FEATURES.map((f, i) => (
              <div key={f.title} className={`${styles.featuresItem} ${styles.reveal}`} style={{ '--d': `${i * 60}ms` }}>
                <span className={styles.featureNum}>0{i + 1}</span>
                <div>
                  <h3 className={styles.featureTitle}>{f.title}</h3>
                  <p className={styles.featureBody}>{f.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className={styles.howItWorks}>
        <div className={`${styles.howHead} ${styles.reveal}`}>
          <p className={styles.sectionLabel}>How it works</p>
          <h2 className={styles.howTitle}>Three steps to better practice</h2>
        </div>
        <div className={styles.steps}>
          {STEPS.map((s, i) => (
            <div key={s.num} className={`${styles.step} ${styles.reveal}`} style={{ '--d': `${i * 90}ms` }}>
              <span className={styles.stepNum}>{s.num}</span>
              <h3 className={styles.stepTitle}>{s.title}</h3>
              <p className={styles.stepBody}>{s.body}</p>
              {i < STEPS.length - 1 && <div className={styles.stepConnector} />}
            </div>
          ))}
        </div>
      </section>

      {/* Difference section */}
      <section className={styles.diff}>
        <div className={styles.diffInner}>
          <div className={`${styles.diffText} ${styles.reveal}`}>
            <p className={styles.sectionLabel}>Why Mediant</p>
            <h2 className={styles.diffTitle}>Not just a tuner.<br />A real musical ear.</h2>
            <p className={styles.diffBody}>
              Most practice tools detect pitch and tempo. Mediant understands music — phrasing, voicing, dynamics, and the relationship between notes over time. The feedback reads like it came from a conservatory teacher, not a spec sheet.
            </p>
            <ul className={styles.diffList}>
              <li>Feedback tied to specific measures, not vague averages</li>
              <li>Understands musical context — not just correct vs. incorrect</li>
              <li>Works with the sheet music, not against it</li>
              <li>Tracks improvement across sessions</li>
            </ul>
            <Link to="/signup" className={styles.ctaPrimary} style={{ alignSelf: 'flex-start', display: 'inline-block', marginTop: 8 }}>
              Try it free →
            </Link>
          </div>
          <div className={`${styles.diffVisual} ${styles.reveal}`} style={{ '--d': '120ms' }}>
            <div className={styles.diffCard}>
              <p className={styles.diffCardTag}>Timing · m.16</p>
              <p className={styles.diffCardTitle}>Entrance is slightly early</p>
              <p className={styles.diffCardBody}>
                This phrase starts just ahead of the beat. Slow the pickup down and let the phrase breathe into the downbeat — the tension resolves much more convincingly that way.
              </p>
              <div className={styles.diffCardFooter}>
                <button className={styles.diffCardBtn}>Loop this measure</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className={`${styles.ctaSection} ${styles.reveal}`}>
        <p className={styles.sectionLabel}>Get started</p>
        <h2 className={styles.ctaTitle}>Practice with intention, not just repetition.</h2>
        <p className={styles.ctaSub}>Join musicians who use Mediant to turn practice time into real progress.</p>
        <div className={styles.heroCtas}>
          <Link to="/signup" className={styles.ctaPrimary}>Create your free account</Link>
          <Link to="/login"  className={styles.ctaGhost}>Log in</Link>
        </div>
        <p className={styles.heroNote}>No credit card · Cancel anytime</p>
      </section>

      {/* Footer */}
      <footer className={styles.footer}>
        <div className={styles.footerLeft}>
          <Link to="/" className={styles.brand} style={{ gap: 8 }}>
            <LogoMark />
            <span className={styles.brandName}>Mediant</span>
          </Link>
          <p className={styles.footerTagline}>Intelligent music practice coaching.</p>
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
