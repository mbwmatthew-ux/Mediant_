import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTakes } from '../hooks/useTakes'
import { useRecordModal } from '../context/RecordModalContext'
import styles from './Sessions.module.css'
import { playPop } from '../utils/sounds'

function scoreColor(n) {
  if (n == null) return 'var(--text-faint)'
  if (n >= 90) return 'var(--score-good)'
  if (n >= 74) return 'var(--score-ok)'
  return 'var(--score-bad)'
}

function relativeDate(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const diffMs = Date.now() - d
    const mins = Math.floor(diffMs / 60000)
    if (mins < 60) return `${mins || 1}m ago`
    const hours = Math.floor(diffMs / 3600000)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(diffMs / 86400000)
    if (days === 1) return 'Yesterday'
    if (days < 7) return `${days} days ago`
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}

function commonIssue(flags) {
  const counts = {}
  for (const f of flags ?? []) {
    const type = (f.type ?? '').toLowerCase()
    if (type) counts[type] = (counts[type] || 0) + 1
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  if (!top) return null
  return top[0].charAt(0).toUpperCase() + top[0].slice(1)
}

export default function Sessions() {
  const nav = useNavigate()
  const { setOpen } = useRecordModal()
  const rawTakes = useTakes({ limit: 100 })
  const takes = rawTakes ?? []
  const loading = rawTakes === undefined
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return takes
    return takes.filter(t => {
      const hay = [
        t.piece_title, t.piece_composer, t.instrument,
        relativeDate(t.created_at),
        commonIssue(t.flags),
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [takes, search])

  function openTake(take) {
    playPop()
    localStorage.setItem('mediant_selected_take', take.id ?? '')
    nav(take.id ? `/analysis?takeId=${take.id}` : '/analysis')
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <h1 className={styles.title}>All sessions</h1>
        <button className={styles.newBtn} onClick={() => { playPop(); setOpen(true) }}>
          <PlusIcon /> New recording
        </button>
      </div>

      {/* Search */}
      <div className={styles.searchWrap}>
        <SearchIcon />
        <input
          className={styles.searchInput}
          placeholder="Search by piece, tag, or date..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* List */}
      {loading ? (
        <div className={styles.list}>
          {[0, 1, 2, 3].map(i => <div key={i} className={styles.rowSkeleton} />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>
            {search ? 'No sessions match your search.' : 'No sessions yet.'}
          </p>
          {!search && (
            <button className={styles.emptyBtn} onClick={() => { playPop(); setOpen(true) }}>
              Record your first session →
            </button>
          )}
        </div>
      ) : (
        <div className={styles.list}>
          {filtered.map((take, i) => {
            const issue = commonIssue(take.flags)
            return (
              <button key={take.id || i} className={styles.row} onClick={() => openTake(take)}>
                <span className={styles.rowIcon}><MusicNoteIcon /></span>
                <div className={styles.rowMain}>
                  <span className={styles.rowTitle}>{take.piece_title || 'Untitled'}</span>
                  <span className={styles.rowSub}>
                    {[take.piece_composer, take.instrument].filter(Boolean).join(' · ') || 'Unknown'}
                  </span>
                </div>
                {issue && <span className={styles.rowTag}>{issue}</span>}
                <span className={styles.rowDate}>{relativeDate(take.created_at)}</span>
                <span className={styles.rowScore} style={{ color: scoreColor(take.score) }}>
                  {take.score != null ? take.score : '—'}
                </span>
                <span className={styles.rowArrow}><ArrowIcon /></span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ── Icons ── */
function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  )
}
function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>
    </svg>
  )
}
function MusicNoteIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
    </svg>
  )
}
function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
    </svg>
  )
}
