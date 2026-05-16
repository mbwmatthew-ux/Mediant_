import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import styles from './Page.module.css'

const RECENT_SESSIONS = [
  { id: 1, piece: 'Bach Invention No. 8', date: 'Today',     score: 84, flags: 2, duration: '18 min' },
  { id: 2, piece: 'Clair de Lune',        date: 'Yesterday', score: 76, flags: 4, duration: '24 min' },
  { id: 3, piece: 'Gymnopédie No. 1',     date: 'May 13',    score: 91, flags: 1, duration: '12 min' },
  { id: 4, piece: 'Moonlight Sonata',     date: 'May 11',    score: 68, flags: 6, duration: '31 min' },
]

function scoreColor(n) {
  if (n >= 88) return '#8fbe9f'
  if (n >= 74) return 'var(--gold)'
  return 'var(--coral)'
}

function greet(name) {
  const h = new Date().getHours()
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'
  return `Good ${part}, ${name?.split(' ')[0] || 'there'}`
}

export default function Home() {
  const nav = useNavigate()
  const { user } = useAuth()

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{greet(user?.name)}</h1>
          <p className={styles.sub}>Let&apos;s keep your momentum going.</p>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.ghostBtn} onClick={() => nav('/record')}>Upload take</button>
          <button className={styles.primaryBtn} onClick={() => nav('/follow')}>▶  Start practice</button>
        </div>
      </div>

      {/* Continue practicing */}
      <button className={styles.continueCard} onClick={() => nav('/follow')}>
        <div className={styles.continueCardLeft}>
          <span className={styles.continueEyebrow}>Continue today&apos;s practice</span>
          <strong className={styles.continueName}>Bach Invention No. 8</strong>
          <span className={styles.continueMeta}>12 min remaining · 2 measures to review</span>
        </div>
        <div className={styles.continueArrow}>→</div>
      </button>

      {/* Quick actions — one unified 4-cell strip */}
      <div className={styles.actionStrip}>
        {[
          { label: 'Find Music',   sub: '12 pieces available',  to: '/search'   },
          { label: 'Upload Take',  sub: 'Add a recording',       to: '/record'   },
          { label: 'Score Review', sub: '3 flags to review',     to: '/analysis' },
          { label: 'Follow Along', sub: 'Live score guidance',   to: '/follow'   },
        ].map(({ label, sub, to }) => (
          <button key={to} className={styles.actionTile} onClick={() => nav(to)}>
            <strong className={styles.actionTileLabel}>{label}</strong>
            <span className={styles.actionTileSub}>{sub}</span>
          </button>
        ))}
      </div>

      {/* Recent sessions */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionHeaderTitle}>Recent Sessions</span>
          <button className={styles.sectionHeaderAction} onClick={() => nav('/takes')}>View all →</button>
        </div>
        <table className={styles.table}>
          <thead className={styles.tableHead}>
            <tr>
              <th className={styles.th}>Piece</th>
              <th className={styles.th}>Date</th>
              <th className={styles.th}>Duration</th>
              <th className={styles.th}>Flags</th>
              <th className={styles.th}>Score</th>
            </tr>
          </thead>
          <tbody>
            {RECENT_SESSIONS.map(s => (
              <tr key={s.id} className={styles.tableRow} onClick={() => nav('/analysis')}>
                <td className={styles.td}>{s.piece}</td>
                <td className={styles.tdSoft}>{s.date}</td>
                <td className={styles.tdSoft}>{s.duration}</td>
                <td className={styles.tdSoft}>{s.flags} flag{s.flags !== 1 ? 's' : ''}</td>
                <td className={styles.td} style={{ color: scoreColor(s.score), fontWeight: 600 }}>{s.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  )
}
