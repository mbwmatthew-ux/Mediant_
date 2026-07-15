import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { INSTRUMENTS } from '../lib/instruments'
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

export default function Signup() {
  const { signup, signInWithGoogle } = useAuth()
  const nav = useNavigate()
  const [name,        setName]        = useState('')
  const [email,       setEmail]       = useState('')
  const [password,    setPassword]    = useState('')
  const [instrument,  setInstrument]  = useState('')
  const [error,       setError]       = useState('')
  const [googleLoading, setGoogleLoading] = useState(false)

  async function handleGoogle() {
    setGoogleLoading(true)
    const result = await signInWithGoogle()
    if (!result.ok) { setError(result.error); setGoogleLoading(false) }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!instrument) { setError('Please select your primary instrument.'); return }
    const result = await signup(name, email, password, instrument)
    if (result.ok) {
      if (!result.user) { nav('/confirm-email', { state: { email } }); return }
      supabase.functions.invoke('send-welcome-email', { body: { name } }).catch(() => {})
      nav('/home')
    } else {
      const msg = result.error ?? ''
      if (msg.toLowerCase().includes('already registered') || msg.toLowerCase().includes('already exists')) {
        setError('__email_taken__')
      } else {
        setError(msg || 'Something went wrong. Please try again.')
      }
    }
  }

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.logoLink}>
        <LogoMark size={32} />
        MEDIANT
      </Link>

      <div className={styles.card}>
        <p className={styles.eyebrow}>Get started</p>
        <h1 className={styles.heading}>Create your account</h1>
        <p className={styles.sub}>Join Mediant and start getting AI feedback on your performances.</p>

        <button type="button" className={styles.googleBtn} onClick={handleGoogle} disabled={googleLoading}>
          <GoogleIcon />
          {googleLoading ? 'Redirecting…' : 'Continue with Google'}
        </button>

        <div className={styles.divider}><span>or</span></div>

        <form className={styles.form} onSubmit={handleSubmit}>
          {error && (
            <div className={styles.error}>
              {error === '__email_taken__' ? (
                <>An account with that email already exists.{' '}<Link to="/login" className={styles.footerLink}>Log in instead</Link>.</>
              ) : error}
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label}>Full name</label>
            <input className={styles.input} type="text" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} required autoFocus />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Email</label>
            <input className={styles.input} type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Password</label>
            <input className={styles.input} type="password" placeholder="At least 8 characters" value={password} onChange={e => setPassword(e.target.value)} minLength={8} required />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Primary instrument</label>
            <select className={styles.select} value={instrument} onChange={e => setInstrument(e.target.value)}>
              <option value="">Select an instrument…</option>
              {INSTRUMENTS.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>

          <button className={styles.submitBtn} type="submit">Create account</button>
        </form>

        <hr className={styles.footerDivider} />
        <p className={styles.footer}>
          Already have an account?{' '}
          <Link to="/login" className={styles.footerLink}>Log in</Link>
        </p>
      </div>
    </div>
  )
}
