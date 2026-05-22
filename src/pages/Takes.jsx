import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './Page.module.css'

function scoreColor(n) {
  if (n >= 88) return '#8fbe9f'
  if (n >= 74) return 'var(--gold)'
  return 'var(--coral)'
}

function formatDate(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffDays = Math.floor((now - d) / 86400000)
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}

export default function Takes() {
  const nav = useNavigate()
  const [takes, setTakes] = useState(undefined)

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('mediant_takes') || '[]')
      setTakes(Array.isArray(stored) ? stored : [])
    } catch {
      setTakes([])
    }
  }, [])

  if (takes === undefined) {
    return (
      <div className={styles.page}>
        <div className={styles.analyzeScreen}>
          <div className={styles.analyzeIcon}>♩</div>
          <p className={styles.analyzeSub}>Loading…</p>
        </div>
      </div>
    )
  }

  if (takes.length === 0) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <p className={styles.label}>Saved Takes</p>
            <h1 className={styles.title}>Your recordings</h1>
          </div>
        </div>
        <div className={styles.analyzeScreen}>
          <div className={styles.analyzeIcon}>♩</div>
          <p className={styles.analyzeTitle}>No takes yet</p>
          <p className={styles.analyzeSub}>Your recorded takes will appear here after your first upload.</p>
          <button className={styles.primaryBtn} style={{ marginTop: 16 }} onClick={() => nav('/record')}>
            Upload a recording →
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Saved Takes</p>
          <h1 className={styles.title}>Your recordings</h1>
        </div>
        <button className={styles.ghostBtn} onClick={() => nav('/summary')}>View recap</button>
      </div>

      <div className={styles.takesGrid}>
        {takes.map((t, i) => (
          <div key={t.id || i} className={`${styles.takeCard} ${i === 0 ? styles.takeCardFeatured : ''}`}>
            {i === 0 && <p className={styles.label}>Latest take</p>}
            <h3 className={styles.resultTitle}>{t.piece_title || 'Untitled'}</h3>
            <p className={styles.resultSub}>
              {[
                t.piece_composer,
                t.instrument,
                formatDate(t.date || t.created_at),
              ].filter(Boolean).join(' · ')}
            </p>
            {(t.score != null || t.flags?.length > 0) && (
              <p className={styles.resultSub} style={{ marginTop: 4 }}>
                {t.score != null && (
                  <span style={{ color: scoreColor(t.score), fontWeight: 600 }}>{t.score}/100</span>
                )}
                {t.score != null && t.flags?.length > 0 && ' · '}
                {t.flags?.length > 0 && `${t.flags.length} flag${t.flags.length !== 1 ? 's' : ''}`}
              </p>
            )}
            <button
              className={i === 0 ? styles.primaryBtn : styles.ghostBtn}
              style={{ marginTop: 16 }}
              onClick={() => nav('/analysis')}
            >
              View score review
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
