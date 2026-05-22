import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import TunerModal from '../components/Tuner'
import styles from './Page.module.css'

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

function formatDate(iso) {
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffDays = Math.floor((now - d) / 86400000)
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}

export default function Home() {
  const nav = useNavigate()
  const { user } = useAuth()

  const [recentSessions, setRecentSessions] = useState([])
  const [pieceCount, setPieceCount]         = useState(0)
  const [showTuner, setShowTuner]           = useState(false)

  useEffect(() => {
    try {
      const takes = JSON.parse(localStorage.getItem('mediant_takes') || '[]')
      setRecentSessions(takes.slice(0, 5))
    } catch { setRecentSessions([]) }

    try {
      const pieces = JSON.parse(localStorage.getItem('mediant_user_pieces') || '[]')
      setPieceCount(pieces.length)
    } catch { setPieceCount(0) }
  }, [])

  const lastTake = recentSessions[0] ?? null

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{greet(user?.name)}</h1>
          <p className={styles.sub}>
            {recentSessions.length > 0
              ? "Let's keep your momentum going."
              : 'Upload a recording to get started.'}
          </p>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.ghostBtn} onClick={() => nav('/search')}>My library</button>
          <button className={styles.primaryBtn} onClick={() => nav('/record')}>Upload take →</button>
        </div>
      </div>

      {/* Continue card — only shown when there's a real last take */}
      {lastTake && (
        <button className={styles.continueCard} onClick={() => nav('/analysis')}>
          <div className={styles.continueCardLeft}>
            <span className={styles.continueEyebrow}>Last session</span>
            <strong className={styles.continueName}>{lastTake.piece_title || 'Untitled'}</strong>
            <span className={styles.continueMeta}>
              {lastTake.piece_composer || 'Unknown'}
              {lastTake.score != null && ` · ${lastTake.score}/100`}
              {lastTake.flags?.length > 0 && ` · ${lastTake.flags.length} flag${lastTake.flags.length !== 1 ? 's' : ''}`}
            </span>
          </div>
          <div className={styles.continueArrow}>→</div>
        </button>
      )}

      {/* Quick actions */}
      <div className={styles.actionStrip}>
        {[
          { label: 'My Library',   sub: pieceCount > 0 ? `${pieceCount} piece${pieceCount !== 1 ? 's' : ''}` : 'Add your sheet music', to: '/search'   },
          { label: 'Upload Take',  sub: 'Submit a recording',   to: '/record'   },
          { label: 'Score Review', sub: recentSessions.length > 0 ? 'View last analysis' : 'No sessions yet', to: '/analysis' },
          { label: 'Saved Takes',  sub: 'View all recordings',  to: '/takes'    },
        ].map(({ label, sub, to }) => (
          <button key={to} className={styles.actionTile} onClick={() => nav(to)}>
            <strong className={styles.actionTileLabel}>{label}</strong>
            <span className={styles.actionTileSub}>{sub}</span>
          </button>
        ))}
      </div>

      {/* Tuner trigger */}
      <button className={styles.tunerBtn} onClick={() => setShowTuner(true)}>
        ♩ Tune your instrument
      </button>

      {showTuner && <TunerModal onClose={() => setShowTuner(false)} />}

      {/* Recent sessions */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionHeaderTitle}>Recent Sessions</span>
          {recentSessions.length > 0 && (
            <button className={styles.sectionHeaderAction} onClick={() => nav('/takes')}>View all →</button>
          )}
        </div>

        {recentSessions.length === 0 ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyStateTitle}>No sessions yet</p>
            <p className={styles.emptyStateSub}>
              Upload your first recording and Mediant will analyze your performance.
            </p>
            <button className={styles.primaryBtn} onClick={() => nav('/record')}>Upload a take →</button>
          </div>
        ) : (
          <table className={styles.table}>
            <thead className={styles.tableHead}>
              <tr>
                <th className={styles.th}>Piece</th>
                <th className={styles.th}>Date</th>
                <th className={styles.th}>Flags</th>
                <th className={styles.th}>Score</th>
              </tr>
            </thead>
            <tbody>
              {recentSessions.map((s, i) => (
                <tr key={s.id || i} className={styles.tableRow} onClick={() => nav('/analysis')}>
                  <td className={styles.td}>{s.piece_title || 'Untitled'}</td>
                  <td className={styles.tdSoft}>{formatDate(s.date)}</td>
                  <td className={styles.tdSoft}>{s.flags?.length ?? 0} flag{(s.flags?.length ?? 0) !== 1 ? 's' : ''}</td>
                  <td className={styles.td} style={{ color: s.score != null ? scoreColor(s.score) : 'var(--text-soft)', fontWeight: 600 }}>
                    {s.score != null ? s.score : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  )
}
