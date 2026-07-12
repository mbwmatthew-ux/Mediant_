import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import styles from './Auth.module.css'
import LogoMark from '../components/LogoMark'

export default function Login() {
  const { login } = useAuth()
  const nav = useNavigate()
  const [email,      setEmail]      = useState('')
  const [password,   setPassword]   = useState('')
  const [error,      setError]      = useState('')
  const [forgotMode, setForgotMode] = useState(false)
  const [resetState, setResetState] = useState('idle')
  const [resetMsg,   setResetMsg]   = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) nav('/home', { replace: true })
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) nav('/home', { replace: true })
    })
    return () => subscription.unsubscribe()
  }, [nav])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    const result = await login(email, password)
    if (result.ok) { nav('/home') } else { setError(result.error) }
  }

  async function handleForgot(e) {
    e.preventDefault()
    if (resetState === 'sending') return
    setResetState('sending'); setResetMsg('')
    const redirectTo = `${window.location.origin}/#/reset-password`
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    if (error) { setResetState('error'); setResetMsg(error.message); return }
    setResetState('sent')
    setResetMsg(`Reset link sent to ${email} — check your inbox.`)
  }

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.logoLink}>
        <LogoMark size={32} />
        MEDIANT
      </Link>

      <div className={styles.card}>
        {forgotMode ? (
          <>
            <p className={styles.eyebrow}>Account recovery</p>
            <h1 className={styles.heading}>Reset your password</h1>
            <p className={styles.sub}>Enter your email and we'll send a reset link.</p>

            {resetState === 'sent' ? (
              <p className={styles.successMsg}>{resetMsg}</p>
            ) : (
              <form className={styles.form} onSubmit={handleForgot}>
                {resetState === 'error' && <div className={styles.error}>{resetMsg}</div>}
                <div className={styles.field}>
                  <label className={styles.label}>Email</label>
                  <input className={styles.input} type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
                </div>
                <button className={styles.submitBtn} type="submit" disabled={resetState === 'sending'}>
                  {resetState === 'sending' ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
            )}

            <hr className={styles.footerDivider} />
            <p className={styles.footer}>
              <button className={styles.footerLink} onClick={() => { setForgotMode(false); setResetState('idle'); setResetMsg('') }}>
                ← Back to log in
              </button>
            </p>
          </>
        ) : (
          <>
            <p className={styles.eyebrow}>Welcome back</p>
            <h1 className={styles.heading}>Log in to Mediant</h1>
            <p className={styles.sub}>Pick up right where you left off.</p>

            <form className={styles.form} onSubmit={handleSubmit}>
              {error && <div className={styles.error}>{error}</div>}
              <div className={styles.field}>
                <label className={styles.label}>Email</label>
                <input className={styles.input} type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Password</label>
                <input className={styles.input} type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} required />
              </div>
              <button className={styles.submitBtn} type="submit">Log in</button>
            </form>

            <hr className={styles.footerDivider} />
            <p className={styles.footer}>
              <button className={styles.footerLink} onClick={() => setForgotMode(true)}>
                Forgot password?
              </button>
            </p>
            <p className={styles.footer}>
              Don&apos;t have an account?{' '}
              <Link to="/signup" className={styles.footerLink}>Create an account</Link>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
