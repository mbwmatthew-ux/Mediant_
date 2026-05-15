import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import styles from './Page.module.css'

const COACHING_STYLES = ['Constructive and direct', 'Encouraging and gentle', 'Technical and precise']
const DISPLAY_MODES   = ['Playback follow-along', 'Static score review', 'Both']

export default function Profile() {
  const { user, logout } = useAuth()
  const nav = useNavigate()

  const [coachingStyle, setCoachingStyle] = useState('Constructive and direct')
  const [displayMode, setDisplayMode] = useState('Playback follow-along')
  const [defaultBpm, setDefaultBpm] = useState(60)
  const [saved, setSaved] = useState(false)

  function handleSave() {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function handleLogout() {
    logout()
    nav('/')
  }

  const initials = user?.name
    ? user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : '?'

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Account</p>
          <h1 className={styles.title}>{user?.name || 'Your Profile'}</h1>
          <p className={styles.sub}>{user?.instrument} · {user?.email}</p>
        </div>
        <div className={styles.avatarLg}>{initials}</div>
      </div>

      {/* Stats */}
      <div className={styles.statsRow}>
        {[
          { label: 'Total sessions', value: '23' },
          { label: 'Hours practiced', value: '11.4 h' },
          { label: 'Best streak', value: '12 days' },
          { label: 'Pieces reviewed', value: '7' },
        ].map(({ label, value }) => (
          <div key={label} className={styles.statCard}>
            <p className={styles.label}>{label}</p>
            <strong className={styles.statValue}>{value}</strong>
          </div>
        ))}
      </div>

      {/* Practice goals */}
      <div className={styles.profileSection}>
        <h4 className={styles.sectionLabel}>Practice Goals</h4>
        <div className={styles.goalsGrid}>
          {[
            { label: 'Daily target',     value: '30 minutes' },
            { label: 'Weekly sessions',  value: '5 sessions' },
            { label: 'Current focus',    value: 'Timing & articulation' },
            { label: 'Exam / recital',   value: 'June 14, 2026' },
          ].map(({ label, value }) => (
            <div key={label} className={styles.goalCard}>
              <p className={styles.label}>{label}</p>
              <strong className={styles.goalValue}>{value}</strong>
            </div>
          ))}
        </div>
      </div>

      {/* Preferences */}
      <div className={styles.profileSection}>
        <h4 className={styles.sectionLabel}>Preferences</h4>

        <div className={styles.prefList}>
          <div className={styles.prefRow}>
            <div>
              <strong className={styles.prefLabel}>Coaching style</strong>
              <p className={styles.prefSub}>How Mediant frames its feedback</p>
            </div>
            <select
              className={styles.prefSelect}
              value={coachingStyle}
              onChange={e => setCoachingStyle(e.target.value)}
            >
              {COACHING_STYLES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>

          <div className={styles.prefRow}>
            <div>
              <strong className={styles.prefLabel}>Default score view</strong>
              <p className={styles.prefSub}>How scores are displayed during review</p>
            </div>
            <select
              className={styles.prefSelect}
              value={displayMode}
              onChange={e => setDisplayMode(e.target.value)}
            >
              {DISPLAY_MODES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>

          <div className={styles.prefRow}>
            <div>
              <strong className={styles.prefLabel}>Default tempo</strong>
              <p className={styles.prefSub}>Starting BPM for Follow Along</p>
            </div>
            <div className={styles.bpmControl}>
              <button
                className={styles.bpmBtn}
                onClick={() => setDefaultBpm(b => Math.max(40, b - 5))}
              >−</button>
              <span className={styles.bpmValue}>{defaultBpm}</span>
              <button
                className={styles.bpmBtn}
                onClick={() => setDefaultBpm(b => Math.min(200, b + 5))}
              >+</button>
            </div>
          </div>
        </div>

        <div className={styles.prefActions}>
          <button className={styles.primaryBtn} onClick={handleSave}>
            {saved ? 'Saved ✓' : 'Save preferences'}
          </button>
        </div>
      </div>

      {/* Account */}
      <div className={styles.profileSection}>
        <h4 className={styles.sectionLabel}>Account</h4>
        <div className={styles.settingsList}>
          {[
            { label: 'Name',       value: user?.name       || '—' },
            { label: 'Email',      value: user?.email      || '—' },
            { label: 'Instrument', value: user?.instrument || '—' },
            { label: 'Plan',       value: 'Free' },
          ].map(({ label, value }) => (
            <div key={label} className={styles.settingRow}>
              <span className={styles.settingLabel}>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16 }}>
          <button className={styles.dangerBtn} onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
