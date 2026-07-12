import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { PLANS } from '../lib/pricing'
import styles from './Pricing.module.css'
import LogoMark from '../components/LogoMark'

export default function Pricing() {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const [pendingPlan, setPendingPlan] = useState(null)

  function handleCta(plan) {
    if (!user) { nav('/signup'); return }
    setPendingPlan(plan.id)
    setTimeout(() => setPendingPlan(null), 3000)
  }

  const plan = PLANS[0]

  return (
    <div className={styles.page}>
      {/* Nav */}
      <nav className={styles.nav}>
        <div className={styles.navLeft}>
          <Link to="/" className={styles.brand}>
            <LogoMark size={26} />
            MEDIANT
          </Link>
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
              <Link to="/signup" className={styles.navCta}>Get started</Link>
            </>
          )}
        </div>
      </nav>

      {/* Hero */}
      <section className={styles.hero}>
        <span className={styles.eyebrow}>Pricing</span>
        <h1 className={styles.title}>Simple, flat pricing</h1>
        <p className={styles.subtitle}>
          Everything Mediant has to offer — unlimited recordings, full AI coaching, no caps.
        </p>
      </section>

      {/* Plan card */}
      <div className={styles.cardWrap}>
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <p className={styles.planName}>{plan.name}</p>
            <div className={styles.priceRow}>
              <span className={styles.price}>{plan.monthlyPrice}</span>
              <span className={styles.perMonth}>/mo</span>
            </div>
            <p className={styles.planDesc}>{plan.description}</p>
          </div>

          <button
            className={styles.ctaBtn}
            onClick={() => handleCta(plan)}
          >
            {plan.cta}
          </button>
          {pendingPlan === plan.id && (
            <p className={styles.pendingNote}>Stripe checkout coming soon — we'll notify you when it's ready.</p>
          )}

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
