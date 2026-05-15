import { Link } from 'react-router-dom'
import styles from './Landing.module.css'

const FEATURES = [
  {
    icon: '♩',
    title: 'Score-Aware Analysis',
    body: 'Upload a recording and Mediant aligns it to the sheet music — flagging timing, dynamics, and voicing issues measure by measure.',
  },
  {
    icon: '▶',
    title: 'Follow Along Playback',
    body: 'Practice with a live moving playhead. Mediant guides you through each row and highlights trouble spots as you play.',
  },
  {
    icon: '✦',
    title: 'AI Coaching Feedback',
    body: 'Receive warm, specific feedback from an AI that understands music — not just pitch detection. Like a private teacher in your pocket.',
  },
]

const STEPS = [
  {
    num: '1',
    title: 'Upload your recording',
    body: 'Drop in an audio file from your practice session — any format works.',
  },
  {
    num: '2',
    title: 'Mediant analyzes it',
    body: 'The AI maps your performance to the score and identifies specific measures to review.',
  },
  {
    num: '3',
    title: 'Review, fix, improve',
    body: 'Click flagged measures to read targeted feedback, then loop them until they feel right.',
  },
]

export default function Landing() {
  return (
    <div className={styles.page}>
      {/* Nav */}
      <nav className={styles.nav}>
        <Link to="/" className={styles.brand}>Mediant</Link>
        <div className={styles.navLinks}>
          <Link to="/login"  className={styles.navLogin}>Log in</Link>
          <Link to="/signup" className={styles.navCta}>Get started free</Link>
        </div>
      </nav>

      {/* Hero */}
      <section className={styles.hero}>
        <span className={styles.eyebrow}>AI-Powered Practice Coach</span>
        <h1 className={styles.heroHeading}>
          Practice smarter.<br />
          <em>Play better.</em>
        </h1>
        <p className={styles.heroSub}>
          Mediant listens to your recordings, maps them to your sheet music, and gives you specific, encouraging feedback — measure by measure.
        </p>
        <div className={styles.heroCtas}>
          <Link to="/signup" className={styles.ctaPrimary}>Start for free</Link>
          <Link to="/login"  className={styles.ctaGhost}>Log in</Link>
        </div>
      </section>

      {/* App preview mockup */}
      <div className={styles.previewWrap}>
        <div className={styles.previewCard}>
          <div className={styles.previewBar}>
            {[0,1,2].map(i => <div key={i} className={styles.previewDot} />)}
          </div>
          <div className={styles.previewBody}>
            <div className={styles.previewScore}>
              <p className={styles.previewScoreLabel}>Score Review — Bach Invention No. 8</p>
              <div className={styles.previewStaves}>
                <div className={styles.previewStave} />
                <div className={styles.previewStave} style={{ position: 'relative' }}>
                  <div className={styles.previewFlag} />
                </div>
                <div className={styles.previewStave} />
                <div className={styles.previewStave} />
              </div>
            </div>
            <div className={styles.previewSidebar}>
              <p className={styles.previewSidebarLabel}>Feedback</p>
              <div className={styles.previewFeedbackCard}>
                <p className={styles.previewTag}>Timing · m.16</p>
                <p className={styles.previewFeedTitle}>Entrance is slightly early</p>
                <p className={styles.previewFeedBody}>
                  This phrase starts just ahead of the beat. Slow the pickup down and let the phrase breathe into the downbeat.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Features */}
      <section className={styles.features}>
        <div className={styles.featuresHead}>
          <p className={styles.sectionLabel}>What you get</p>
          <h2 className={styles.featuresTitle}>Everything a practice session needs</h2>
          <p className={styles.featuresSub}>From raw recording to actionable feedback in minutes.</p>
        </div>
        <div className={styles.featuresGrid}>
          {FEATURES.map(f => (
            <div key={f.title} className={styles.featureCard}>
              <div className={styles.featureIcon}>{f.icon}</div>
              <h3 className={styles.featureTitle}>{f.title}</h3>
              <p className={styles.featureBody}>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className={styles.howItWorks}>
        <div className={styles.howHead}>
          <p className={styles.sectionLabel}>How it works</p>
          <h2 className={styles.howTitle}>Three steps to better practice</h2>
        </div>
        <div className={styles.steps}>
          {STEPS.map(s => (
            <div key={s.num} className={styles.step}>
              <span className={styles.stepNum}>{s.num}</span>
              <h3 className={styles.stepTitle}>{s.title}</h3>
              <p className={styles.stepBody}>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className={styles.ctaSection}>
        <h2 className={styles.ctaTitle}>Ready to practice smarter?</h2>
        <p className={styles.ctaSub}>Free to start. No credit card required.</p>
        <Link to="/signup" className={styles.ctaPrimary}>Create your account</Link>
      </section>

      {/* Footer */}
      <footer className={styles.footer}>
        <span className={styles.footerBrand}>© 2026 Mediant</span>
        <div className={styles.footerLinks}>
          <a href="#" className={styles.footerLink}>Privacy</a>
          <a href="#" className={styles.footerLink}>Terms</a>
          <a href="#" className={styles.footerLink}>Contact</a>
        </div>
      </footer>
    </div>
  )
}
