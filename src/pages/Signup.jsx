import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import styles from './Auth.module.css'

const INSTRUMENTS = [
  'Piano', 'Violin', 'Viola', 'Cello', 'Double Bass',
  'Flute', 'Oboe', 'Clarinet', 'Bassoon',
  'Trumpet', 'Horn', 'Trombone', 'Tuba',
  'Voice (Soprano)', 'Voice (Alto)', 'Voice (Tenor)', 'Voice (Bass)',
  'Guitar', 'Harp', 'Percussion', 'Other',
]

export default function Signup() {
  const { signup } = useAuth()
  const nav = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [instrument, setInstrument] = useState('')
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!instrument) {
      setError('Please select your primary instrument.')
      return
    }
    const result = await signup(name, email, password, instrument)
    if (result.ok) {
      nav(result.user ? '/home' : '/confirm-email')
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
        <Link to="/" className={styles.brandMark}>Mediant</Link>
      </nav>

      <div className={styles.card}>
        <p className={styles.eyebrow}>Get started</p>
        <h1 className={styles.heading}>Create your account</h1>
        <p className={styles.sub}>Free to try. No credit card needed.</p>

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
