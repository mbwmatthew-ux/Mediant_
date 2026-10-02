import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import LogoMark from '../components/LogoMark'
import styles from './Auth.module.css'

export default function ResetPassword() {
  const nav = useNavigate()
  const [ready,    setReady]    = useState(false) // true once PASSWORD_RECOVERY event fires
  const [pw,       setPw]       = useState('')
  const [pw2,      setPw2]      = useState('')
  const [state,    setState]    = useState('idle') // idle | saving | saved | error
  const [msg,      setMsg]      = useState('')

  useEffect(() => {
    // Supabase fires PASSWORD_RECOVERY when the user arrives via the reset link
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setReady(true)
    })
    // Also check if there's already a session (user already landed and session was set)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setReady(true)
    })
    return () => subscription.unsubscribe()
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    if (pw.length < 8) { setState('error'); setMsg('Use at least 8 characters.'); return }
    if (pw !== pw2)    { setState('error'); setMsg("Passwords don't match."); return }
    setState('saving'); setMsg('')
    const { error } = await supabase.auth.updateUser({ password: pw })
    if (error) { setState('error'); setMsg(error.message); return }
    setState('saved')
    setMsg('Password updated. Taking you to your sessions…')
    setTimeout(() => nav('/sessions', { replace: true }), 1800)
  }

  return (
    <div className={styles.page}>
      <nav className={styles.nav}>
        <Link to="/" className={styles.brandMark} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LogoMark size={24} />
          Mediant
        </Link>
      </nav>

      <div className={styles.card}>
        <p className={styles.eyebrow}>Security</p>
        <h1 className={styles.heading}>Set a new password</h1>

        {!ready ? (
          <p className={styles.sub} style={{ marginTop: 12 }}>
            Verifying your reset link… if nothing happens,{' '}
            <Link to="/login" className={styles.footerLink}>request a new one</Link>.
          </p>
        ) : state === 'saved' ? (
          <p className={styles.sub} style={{ marginTop: 12, color: 'var(--accent, #587965)' }}>
            {msg}
          </p>
        ) : (
          <form className={styles.form} onSubmit={handleSubmit} style={{ marginTop: 16 }}>
            {state === 'error' && <div className={styles.error}>{msg}</div>}

            <div className={styles.field}>
              <label className={styles.label}>New password</label>
              <input
                className={styles.input}
                type="password"
                placeholder="At least 8 characters"
                value={pw}
                onChange={e => setPw(e.target.value)}
                minLength={8}
                required
                autoFocus
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Confirm new password</label>
              <input
                className={styles.input}
                type="password"
                placeholder="Same password again"
                value={pw2}
                onChange={e => setPw2(e.target.value)}
                minLength={8}
                required
              />
            </div>

            <button className={styles.submitBtn} type="submit" disabled={state === 'saving'}>
              {state === 'saving' ? 'Saving…' : 'Set new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
