import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import styles from './Page.module.css'

const RECENT_SESSIONS = [
  { id: 1, piece: 'Bach Invention No. 8',   date: 'Today',       score: 84, flags: 2, duration: '18 min' },
  { id: 2, piece: 'Clair de Lune',           date: 'Yesterday',   score: 76, flags: 4, duration: '24 min' },
  { id: 3, piece: 'Gymnopédie No. 1',        date: 'May 13',      score: 91, flags: 1, duration: '12 min' },
  { id: 4, piece: 'Moonlight Sonata',        date: 'May 11',      score: 68, flags: 6, duration: '31 min' },
]

function scoreColor(n) {
  if (n >= 88) return 'var(--hero-green)'
  if (n >= 74) return 'var(--gold)'
  return 'var(--coral)'
}

function greet(name) {
  const h = new Date().getHours()
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'
  const first = name?.split(' ')[0] || 'there'
  return `Good ${part}, ${first}`
}

export default function Home() {
  const nav = useNavigate()
  const { user } = useAuth()

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Dashboard</p>
          <h1 className={styles.title}>{greet(user?.name)}</h1>
          <p className={styles.sub}>Let&apos;s keep your momentum going.</p>
        </div>
        <div className={styles.streakCard}>
          <div className={styles.streakTop}>
            <strong>Practice Streak</strong>
            <span className={styles.streakBadge}>7 days</span>
          </div>
          <div className={styles.streakBars}>
            {[...Array(7)].map((_, i) => <span key={i} />)}
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className={styles.statsRow}>
        {[
          { label: 'Sessions this week', value: '5' },
          { label: 'Hours practiced',    value: '3.2 h' },
          { label: 'Avg. score',         value: '80 / 100' },
          { label: 'Pieces active',      value: '3' },
        ].map(({ label, value }) => (
          <div key={label} className={styles.statCard}>
            <p className={styles.label}>{label}</p>
            <strong className={styles.statValue}>{value}</strong>
          </div>
        ))}
      </div>

      {/* Continue card */}
      <button className={styles.continueCard} onClick={() => nav('/follow')}>
        <div>
          <p className={styles.accentLabel}>Continue today&apos;s practice</p>
          <h3 className={styles.continueTitle}>Bach Invention No. 8</h3>
          <p className={styles.continueSub}>12 min remaining · 2 measures to review</p>
        </div>
        <div className={styles.playOrb}>▶</div>
      </button>

      {/* Quick Actions */}
      <h4 className={styles.sectionLabel}>Quick Actions</h4>
      <div className={styles.actionGrid}>
        {[
          { icon: '⌕', color: 'green', label: 'Find Music',    to: '/search'   },
          { icon: '↑', color: 'gold',  label: 'Upload Take',   to: '/record'   },
          { icon: '◫', color: 'coral', label: 'Review Score',  to: '/analysis' },
          { icon: '▶', color: 'green', label: 'Follow Along',  to: '/follow'   },
        ].map(({ icon, color, label, to }) => (
          <button key={to} className={styles.actionCard} onClick={() => nav(to)}>
            <span className={`${styles.actionIcon} ${styles[color]}`}>{icon}</span>
            <strong>{label}</strong>
          </button>
        ))}
      </div>

      {/* Recent sessions */}
      <h4 className={styles.sectionLabel}>Recent Sessions</h4>
      <div className={styles.sessionList}>
        {RECENT_SESSIONS.map(s => (
          <button
            key={s.id}
            className={styles.sessionRow}
            onClick={() => nav('/analysis')}
          >
            <div className={styles.sessionLeft}>
              <strong className={styles.sessionPiece}>{s.piece}</strong>
              <span className={styles.sessionMeta}>{s.date} · {s.duration} · {s.flags} flag{s.flags !== 1 ? 's' : ''}</span>
            </div>
            <div className={styles.sessionScore} style={{ color: scoreColor(s.score) }}>
              {s.score}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
