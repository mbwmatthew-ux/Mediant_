import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import styles from './Auth.module.css'
import LogoMark from '../components/LogoMark'

export default function ConfirmEmail() {
  const location = useLocation()
  const email = location.state?.email ?? ''
  const [resendState, setResendState] = useState('idle') // idle | sending | sent | error

  async function handleResend() {
    if (!email || resendState === 'sending') return
    setResendState('sending')
    const { error } = await supabase.auth.resend({ type: 'signup', email })
    setResendState(error ? 'error' : 'sent')
  }

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.logoLink}>
        <LogoMark size={32} />
        MEDIANT
      </Link>

      <div className={styles.card}>
        <p className={styles.eyebrow}>Almost there</p>
        <h1 className={styles.heading}>Check your email</h1>
        <p className={styles.sub}>
          We sent a confirmation link{email ? ` to ${email}` : ' to your email address'}. Click it to activate your account, then come back and log in.
        </p>

        <div style={{ background: 'rgba(44,103,75,0.08)', borderRadius: 12, padding: '16px 18px', marginBottom: 20 }}>
          <p style={{ color: 'var(--text-soft)', fontSize: '0.88rem', lineHeight: 1.65, margin: 0 }}>
            <strong>Didn't get it?</strong> Check your spam or junk folder — confirmation emails sometimes end up there. The link expires in 24 hours.
          </p>
        </div>

        {email && resendState !== 'sent' && (
          <button
            className={styles.submitBtn}
            style={{ background: 'var(--hero-green)', marginBottom: 12 }}
            onClick={handleResend}
            disabled={resendState === 'sending'}
          >
            {resendState === 'sending' ? 'Sending…' : 'Resend confirmation email'}
          </button>
        )}

        {resendState === 'sent' && (
          <p className={styles.successMsg} style={{ marginBottom: 16 }}>
            Sent! Check your inbox (and spam folder).
          </p>
        )}
        {resendState === 'error' && (
          <p className={styles.error} style={{ marginBottom: 16 }}>
            Couldn't resend — try signing up again.
          </p>
        )}

        <Link to="/login" className={styles.submitBtn} style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
          Go to log in
        </Link>

        <p className={styles.footer}>
          Wrong email?{' '}
          <Link to="/signup" className={styles.footerLink}>Sign up again</Link>
        </p>
      </div>
    </div>
  )
}
