import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import styles from './Pricing.module.css'

// TODO: replace this with the Stripe checkout flow once Stripe is configured

const FEATURES = [
  'Unlimited recording uploads',
  'Score alignment & analysis',
  'Measure-by-measure feedback',
  'Session summaries & history',
  'Saved takes library',
  'Text prompt coaching',
  'Video & audio technique analysis',
]

export default function Pricing() {
  const { user, subscription, refreshSubscription, logout } = useAuth()
  const nav = useNavigate()
  const [billing, setBilling] = useState('yearly')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  const isActive = subscription?.status === 'active'

  // SUBSCRIPTIONS DISABLED — replace with Stripe or Supabase upsert once table is set up
  function handleSubscribe() {
    if (!user) { nav('/signup'); return }
    nav('/home')
  }

  return (
    <div className={styles.page}>
      <nav className={styles.nav}>
        <Link to="/" className={styles.brand}>Mediant</Link>
        <div className={styles.navLinks}>
          {user ? (
            <>
              <span className={styles.navUser}>{user.email}</span>
              <button className={styles.navLogout} onClick={async () => { await logout(); nav('/') }}>
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link to="/login"  className={styles.navLogin}>Log in</Link>
              <Link to="/signup" className={styles.navCta}>Sign up</Link>
            </>
          )}
        </div>
      </nav>

      <section className={styles.hero}>
        <span className={styles.eyebrow}>Unlock Mediant</span>
        <h1 className={styles.title}>
          One plan. Everything included.
        </h1>
        <p className={styles.subtitle}>
          Full access to coaching, score analysis, and practice tools — for serious musicians.
        </p>
      </section>

      <div className={styles.toggle}>
        <button
          className={`${styles.toggleBtn} ${billing === 'monthly' ? styles.toggleActive : ''}`}
          onClick={() => setBilling('monthly')}
        >
          Monthly
        </button>
        <button
          className={`${styles.toggleBtn} ${billing === 'yearly' ? styles.toggleActive : ''}`}
          onClick={() => setBilling('yearly')}
        >
          Yearly
          <span className={styles.saveBadge}>Save 25%</span>
        </button>
      </div>

      <div className={styles.cardWrap}>
        <div className={styles.card}>
          <div className={styles.cardTop}>
            <p className={styles.planName}>Mediant Pro</p>
            <div className={styles.priceRow}>
              <span className={styles.price}>
                {billing === 'monthly' ? '$19.99' : '$14.99'}
              </span>
              <span className={styles.perMonth}>/month</span>
            </div>
            {billing === 'yearly' && (
              <p className={styles.billedYearly}>Billed $179.99/year</p>
            )}
          </div>

          <ul className={styles.featureList}>
            {FEATURES.map(f => (
              <li key={f} className={styles.featureItem}>
                <span className={styles.check}>✓</span>
                {f}
              </li>
            ))}
          </ul>

          {isActive ? (
            <div className={styles.activeBox}>
              <span className={styles.activeDot} />
              Subscription active — {subscription.plan} plan
            </div>
          ) : (
            <button
              className={styles.ctaBtn}
              onClick={handleSubscribe}
              disabled={loading}
            >
              {loading ? 'Redirecting…' : 'Subscribe now'}
            </button>
          )}

          {error && <p className={styles.errorMsg}>{error}</p>}

          <p className={styles.finePrint}>
            Cancel anytime. Secure payment via Stripe.
          </p>
        </div>
      </div>

      {isActive && (
        <div className={styles.continueWrap}>
          <Link to="/home" className={styles.continueBtn}>Go to your dashboard →</Link>
        </div>
      )}
    </div>
  )
}
