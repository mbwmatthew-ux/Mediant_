import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { INSTRUMENTS } from '../lib/instruments'
import styles from './Auth.module.css'
import LogoMark from '../components/LogoMark'

export default function Signup() {
  const { signup } = useAuth()
  const nav = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [instrument, setInstrument] = useState('')
  const [role, setRole] = useState('student')
  const [teacherCode, setTeacherCode] = useState('')
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!instrument) {
      setError('Please select your primary instrument.')
      return
    }
    if (role === 'teacher' && !teacherCode.trim()) {
      setError('A teacher access code is required to create a teacher account. Contact the Mediant team if you need one.')
      return
    }
    const result = await signup(name, email, password, instrument)
    if (result.ok) {
      // Teacher role is NOT settable by the client — the DB pins profiles.role.
      // If the user has a session now (email confirmation off) and picked
      // "teacher", redeem the invite code through the server. If it fails, they
      // continue as a student and can retry the code later from the teacher page.
      let becameTeacher = false
      if (role === 'teacher' && result.user?.id) {
        const { data, error: codeErr } = await supabase.functions.invoke('redeem-teacher-code', {
          body: { code: teacherCode.trim() },
        }).catch(err => ({ data: null, error: err }))
        if (!codeErr && data?.ok) {
          becameTeacher = true
        } else {
          setError('Your account was created, but that teacher code was not valid. You are set up as a student — you can enter a valid code from the Teacher page to upgrade.')
        }
      }
      if (!result.user) { nav('/confirm-email'); return }
      // Fire-and-forget welcome email. Only meaningful when a session exists
      // (email-confirmation-off): the function requires the caller's JWT and
      // always sends to that user's own verified address, ignoring the body.
      supabase.functions.invoke('send-welcome-email', {
        body: { name },
      }).catch(() => {})
      nav(becameTeacher ? '/teacher' : '/home')
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
      <nav className={styles.nav}>
        <Link to="/" className={styles.brandMark} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <LogoMark size={24} />
            Mediant
          </Link>
      </nav>

      <div className={styles.card}>
        <p className={styles.eyebrow}>Get started</p>
        <h1 className={styles.heading}>Create your account</h1>
        <p className={styles.sub}>Create your Mediant account to start reviewing takes.</p>

        <form className={styles.form} onSubmit={handleSubmit}>
          {error && (
            <div className={styles.error}>
              {error === '__email_taken__' ? (
                <>
                  An account with that email already exists.{' '}
                  <Link to="/login" className={styles.footerLink}>Please log in</Link>
                  {' '}or use a different email.
                </>
              ) : error}
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label}>Full name</label>
            <input
              className={styles.input}
              type="text"
              placeholder="Your name"
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Email</label>
            <input
              className={styles.input}
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Password</label>
            <input
              className={styles.input}
              type="password"
              placeholder="At least 8 characters"
              value={password}
              onChange={e => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Primary instrument</label>
            <select
              className={styles.select}
              value={instrument}
              onChange={e => setInstrument(e.target.value)}
            >
              <option value="">Select an instrument…</option>
              {INSTRUMENTS.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>I am a…</label>
            <div className={styles.roleToggle}>
              <button
                type="button"
                className={`${styles.roleOption} ${role === 'student' ? styles.roleOptionActive : ''}`}
                onClick={() => setRole('student')}
              >
                Student
              </button>
              <button
                type="button"
                className={`${styles.roleOption} ${role === 'teacher' ? styles.roleOptionActive : ''}`}
                onClick={() => setRole('teacher')}
              >
                Teacher
              </button>
            </div>
          </div>

          {role === 'teacher' && (
            <div className={styles.field}>
              <label className={styles.label}>Teacher access code</label>
              <input
                className={styles.input}
                type="text"
                placeholder="Enter your invite code"
                value={teacherCode}
                onChange={e => setTeacherCode(e.target.value)}
                autoComplete="off"
              />
              <p style={{ marginTop: 6, fontSize: '0.8rem', color: 'var(--text-muted, #8a8070)', lineHeight: 1.5 }}>
                Teacher accounts can review students' practice data, so they're invite-only for now.
                Don't have a code? <a href="mailto:mediantteam@gmail.com" style={{ color: 'var(--accent, #587965)' }}>Request one</a>.
              </p>
            </div>
          )}

          <button className={styles.submitBtn} type="submit">Create account</button>
        </form>

        <p className={styles.footer}>
          Already have an account?{' '}
          <Link to="/login" className={styles.footerLink}>Log in</Link>
        </p>
      </div>
    </div>
  )
}
