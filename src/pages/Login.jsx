import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import styles from './Auth.module.css'
import LogoMark from '../components/LogoMark'

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
      <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  )
}

export default function Login() {
  const { login, signInWithGoogle } = useAuth()
  const [googleLoading, setGoogleLoading] = useState(false)
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

  async function handleGoogle() {
    setGoogleLoading(true)
    const result = await signInWithGoogle()
    if (!result.ok) { setError(result.error); setGoogleLoading(false) }
    // on success, Supabase redirects the browser — no further action needed
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

            <button type="button" className={styles.googleBtn} onClick={handleGoogle} disabled={googleLoading}>
              <GoogleIcon />
              {googleLoading ? 'Redirecting…' : 'Continue with Google'}
            </button>

            <div className={styles.divider}><span>or</span></div>

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
