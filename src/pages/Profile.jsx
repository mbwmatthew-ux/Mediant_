import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useTakes } from '../hooks/useTakes'
import { supabase } from '../lib/supabase'
import styles from './Page.module.css'
import { playSave, playThud } from '../utils/sounds'

const COACHING_STYLES = ['Constructive and direct', 'Encouraging and gentle', 'Technical and precise']
const INSTRUMENTS = [
  'Piano', 'Violin', 'Viola', 'Cello', 'Double Bass',
  'Flute', 'Oboe', 'Clarinet', 'Bassoon',
  'French Horn', 'Trumpet', 'Trombone', 'Tuba',
  'Guitar', 'Harp', 'Voice', 'Other',
]

export default function Profile() {
  const { user, subscription, logout } = useAuth()
  const nav    = useNavigate()
  const takes  = useTakes() ?? []

  const [name,          setName]          = useState(user?.name       || '')
  const [instrument,    setInstrument]    = useState(user?.instrument || '')
  const [coachingStyle, setCoachingStyle] = useState(
    user?.user_metadata?.coaching_style || 'Constructive and direct'
  )
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const [saveErr, setSaveErr] = useState('')

  const stats = useMemo(() => {
    const totalSessions  = takes.length
    const uniquePieces   = new Set(takes.map(t => t.piece_title).filter(Boolean)).size
    const bestStreak     = calcBestStreak(takes)
    return { totalSessions, uniquePieces, bestStreak }
  }, [takes])

  async function handleSave() {
    setSaving(true)
    setSaveErr('')
    const { error } = await supabase.auth.updateUser({
      data: {
        name:           name.trim()    || user?.name,
        instrument:     instrument     || user?.instrument,
        coaching_style: coachingStyle,
      },
    })
    setSaving(false)
    if (error) {
      setSaveErr(error.message)
    } else {
      playSave()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
  }

  function handleLogout() {
    playThud()
    logout()
    nav('/')
  }

  const initials = name
    ? name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : '?'

  const planLabel = subscription?.status === 'active' && subscription?.plan
    ? `Pro · ${subscription.plan}`
    : subscription?.status === 'active'
    ? 'Pro'
    : 'Free'

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Account</p>
          <h1 className={styles.title}>{user?.name || 'Your Profile'}</h1>
          <p className={styles.sub}>{[user?.instrument, user?.email].filter(Boolean).join(' · ')}</p>
        </div>
        <div className={styles.avatarLg}>{initials}</div>
      </div>

      {/* Stats */}
      <div className={styles.statsRow}>
        {[
          { label: 'Total sessions',  value: takes === undefined ? '…' : String(stats.totalSessions) },
          { label: 'Pieces reviewed', value: takes === undefined ? '…' : String(stats.uniquePieces) },
          { label: 'Best streak',     value: takes === undefined ? '…' : `${stats.bestStreak} days` },
          { label: 'Plan',            value: planLabel },
        ].map(({ label, value }) => (
          <div key={label} className={styles.statCard}>
            <p className={styles.label}>{label}</p>
            <strong className={styles.statValue}>{value}</strong>
          </div>
        ))}
      </div>

      {/* Profile */}
      <div className={styles.profileSection}>
        <h4 className={styles.sectionLabel}>Your Profile</h4>
        <div className={styles.prefList}>
          <div className={styles.prefRow}>
            <div>
              <strong className={styles.prefLabel}>Name</strong>
            </div>
            <input
              className={styles.prefInput}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Your name"
            />
          </div>
          <div className={styles.prefRow}>
            <div>
              <strong className={styles.prefLabel}>Primary instrument</strong>
            </div>
            <select
              className={styles.prefSelect}
              value={instrument}
              onChange={e => setInstrument(e.target.value)}
            >
              <option value="">Select instrument…</option>
              {INSTRUMENTS.map(i => <option key={i}>{i}</option>)}
            </select>
          </div>
          <div className={styles.prefRow}>
            <div>
              <strong className={styles.prefLabel}>Email</strong>
              <p className={styles.prefSub}>Contact support to change</p>
            </div>
            <span className={styles.prefReadonly}>{user?.email}</span>
          </div>
        </div>
      </div>

      {/* Preferences */}
      <div className={styles.profileSection}>
        <h4 className={styles.sectionLabel}>Feedback Preferences</h4>
        <div className={styles.prefList}>
          <div className={styles.prefRow}>
            <div>
              <strong className={styles.prefLabel}>Feedback style</strong>
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
        </div>

        {saveErr && <p className={styles.errorMsg}>{saveErr}</p>}

        <div className={styles.prefActions}>
          <button className={styles.primaryBtn} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save changes'}
          </button>
        </div>
      </div>

      {/* Account */}
      <div className={styles.profileSection}>
        <h4 className={styles.sectionLabel}>Account</h4>
        <div style={{ marginTop: 8 }}>
          <button className={styles.dangerBtn} onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}

function calcBestStreak(takes) {
  if (!takes.length) return 0
  const days = [...new Set(
    takes.map(t => new Date(t.created_at).toDateString())
  )].map(d => new Date(d)).sort((a, b) => b - a)

  let best = 1, cur = 1
  for (let i = 1; i < days.length; i++) {
    const diff = (days[i - 1] - days[i]) / 86400000
    cur = diff === 1 ? cur + 1 : 1
    if (cur > best) best = cur
  }
  return best
}
