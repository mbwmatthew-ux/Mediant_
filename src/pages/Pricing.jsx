import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import styles from './Pricing.module.css'

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    monthlyPrice: null,
    yearlyPrice: null,
    description: 'Get started with the basics.',
    cta: 'Current plan',
    ctaVariant: 'ghost',
    features: [
      { text: '5 recording uploads per month',  included: true  },
      { text: 'Score alignment & analysis',      included: true  },
      { text: 'Measure-by-measure feedback',     included: true  },
      { text: 'Session history (30 days)',        included: true  },
      { text: 'Coach chat',                       included: true  },
      { text: 'Unlimited uploads',               included: false },
      { text: 'Priority analysis queue',         included: false },
      { text: 'Full session history',            included: false },
      { text: 'PDF export',                      included: false },
      { text: 'Advanced progress tracking',      included: false },
      { text: 'Multi-instrument profiles',       included: false },
      { text: 'Early access to new features',    included: false },
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    monthlyPrice: '$19.99',
    yearlyPrice: '$14.99',
    description: 'For musicians who practice seriously.',
    cta: 'Get Pro',
    ctaVariant: 'gold',
    badge: 'Most popular',
    features: [
      { text: '5 recording uploads per month',  included: true  },
      { text: 'Score alignment & analysis',      included: true  },
      { text: 'Measure-by-measure feedback',     included: true  },
      { text: 'Session history (30 days)',        included: true  },
      { text: 'Coach chat',                       included: true  },
      { text: 'Unlimited uploads',               included: true  },
      { text: 'Priority analysis queue',         included: true  },
      { text: 'Full session history',            included: true  },
      { text: 'PDF export',                      included: true  },
      { text: 'Advanced progress tracking',      included: false },
      { text: 'Multi-instrument profiles',       included: false },
      { text: 'Early access to new features',    included: false },
    ],
  },
  {
    id: 'max',
    name: 'Max',
    monthlyPrice: '$34.99',
    yearlyPrice: '$24.99',
    description: 'The full experience, no limits.',
    cta: 'Get Max',
    ctaVariant: 'green',
    features: [
      { text: '5 recording uploads per month',  included: true  },
      { text: 'Score alignment & analysis',      included: true  },
      { text: 'Measure-by-measure feedback',     included: true  },
      { text: 'Session history (30 days)',        included: true  },
      { text: 'Coach chat',                       included: true  },
      { text: 'Unlimited uploads',               included: true  },
      { text: 'Priority analysis queue',         included: true  },
      { text: 'Full session history',            included: true  },
      { text: 'PDF export',                      included: true  },
      { text: 'Advanced progress tracking',      included: true  },
      { text: 'Multi-instrument profiles',       included: true  },
      { text: 'Early access to new features',    included: true  },
    ],
  },
]

export default function Pricing() {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const [billing, setBilling] = useState('yearly')

  function handleCta(plan) {
    if (plan.id === 'free') return
    if (!user) { nav('/signup'); return }
    nav('/home')
  }

  return (
    <div className={styles.page}>
      {/* Nav */}
      <nav className={styles.nav}>
        <div className={styles.navLeft}>
          <Link to="/" className={styles.brand}>Mediant</Link>
        </div>
        <div className={styles.navRight}>
          {user ? (
            <>
              <span className={styles.navUser}>{user.email}</span>
              <button className={styles.navBtn} onClick={async () => { await logout(); nav('/') }}>Sign out</button>
            </>
          ) : (
            <>
              <Link to="/login"  className={styles.navBtn}>Log in</Link>
              <Link to="/signup" className={styles.navCta}>Get started free</Link>
            </>
          )}
        </div>
      </nav>

      {/* Hero */}
      <section className={styles.hero}>
        <span className={styles.eyebrow}>Plans &amp; Pricing</span>
        <h1 className={styles.title}>Choose your level</h1>
        <p className={styles.subtitle}>
          Start free, upgrade when you're ready. All plans include score-aware analysis and coaching feedback.
        </p>

        {/* Billing toggle */}
        <div className={styles.toggle}>
          <button
            className={`${styles.toggleBtn} ${billing === 'monthly' ? styles.toggleActive : ''}`}
            onClick={() => setBilling('monthly')}
          >Monthly</button>
          <button
            className={`${styles.toggleBtn} ${billing === 'yearly' ? styles.toggleActive : ''}`}
            onClick={() => setBilling('yearly')}
          >
            Yearly
            <span className={styles.saveBadge}>Save 25%</span>
          </button>
        </div>
      </section>

      {/* Plan cards */}
      <div className={styles.cardsRow}>
        {PLANS.map(plan => (
          <div key={plan.id} className={`${styles.card} ${plan.badge ? styles.cardFeatured : ''}`}>
            {plan.badge && <span className={styles.cardBadge}>{plan.badge}</span>}

            <div className={styles.cardHead}>
              <p className={styles.planName}>{plan.name}</p>
              {plan.monthlyPrice ? (
                <div className={styles.priceRow}>
                  <span className={styles.price}>
                    {billing === 'yearly' ? plan.yearlyPrice : plan.monthlyPrice}
                  </span>
                  <span className={styles.perMonth}>/mo</span>
                </div>
              ) : (
                <div className={styles.priceRow}>
                  <span className={styles.priceFree}>Free</span>
                </div>
              )}
              {plan.monthlyPrice && billing === 'yearly' && (
                <p className={styles.billedNote}>
                  Billed {plan.id === 'pro' ? '$179.88' : '$299.88'}/year
                </p>
              )}
              <p className={styles.planDesc}>{plan.description}</p>
            </div>

            <button
              className={`${styles.ctaBtn} ${styles['ctaBtn_' + plan.ctaVariant]}`}
              onClick={() => handleCta(plan)}
              disabled={plan.id === 'free' && !!user}
            >
              {plan.id === 'free' && user ? 'Current plan' : plan.cta}
            </button>

            <ul className={styles.featureList}>
              {plan.features.map(f => (
                <li key={f.text} className={`${styles.featureItem} ${f.included ? '' : styles.featureItemDim}`}>
                  <span className={f.included ? styles.checkYes : styles.checkNo}>
                    {f.included ? '✓' : '–'}
                  </span>
                  {f.text}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className={styles.finePrint}>Cancel anytime · Secure payment via Stripe · All prices in USD</p>

      {user && (
        <div className={styles.backWrap}>
          <Link to="/home" className={styles.backLink}>← Back to dashboard</Link>
        </div>
      )}
    </div>
  )
}
