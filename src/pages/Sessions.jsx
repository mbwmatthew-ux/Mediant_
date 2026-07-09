import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTakes } from '../hooks/useTakes'
import { useAuth } from '../context/AuthContext'
import { useRecordModal } from '../context/RecordModalContext'
import { supabase } from '../lib/supabase'
import styles from './Sessions.module.css'
import { playPop, playThud } from '../utils/sounds'

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
  const { user } = useAuth()
  const { setOpen } = useRecordModal()
  const rawTakes = useTakes({ limit: 100 })
  const loading = rawTakes === undefined

  // Track optimistic deletes by ID — avoids a two-state sync that causes a one-frame flash
  const [deletedIds, setDeletedIds] = useState(new Set())
  const takes = (rawTakes ?? []).filter(t => !deletedIds.has(t.id))

  const [search, setSearch] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(null) // takeId pending confirm
  const [deleting, setDeleting] = useState(null)           // takeId being deleted

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
    nav(take.id ? `/analysis?takeId=${take.id}&from=sessions` : '/analysis?from=sessions')
  }

  async function handleDeleteConfirm(takeId) {
    setDeleting(takeId)
    setConfirmDelete(null)
    setDeletedIds(prev => new Set([...prev, takeId]))
    playThud()
    if (user?.id) {
      await supabase.from('takes').delete().eq('id', takeId)
    } else {
      try {
        const stored = JSON.parse(localStorage.getItem('mediant_takes') || '[]')
        localStorage.setItem('mediant_takes', JSON.stringify(stored.filter(t => t.id !== takeId)))
      } catch {}
    }
    setDeleting(null)
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
            const isPendingDelete = confirmDelete === take.id
            return (
              <div key={take.id || i} className={`${styles.row} ${isPendingDelete ? styles.rowDanger : ''}`}>
                {/* Main clickable area */}
                <button className={styles.rowBtn} onClick={() => openTake(take)}>
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

                {/* Delete controls */}
                <div className={styles.rowActions}>
                  {isPendingDelete ? (
                    <>
                      <button
                        className={styles.confirmDeleteBtn}
                        onClick={() => handleDeleteConfirm(take.id)}
                        disabled={deleting === take.id}
                      >
                        Delete
                      </button>
                      <button className={styles.cancelDeleteBtn} onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      className={styles.deleteBtn}
                      onClick={e => { e.stopPropagation(); setConfirmDelete(take.id) }}
                      aria-label="Delete session"
                      title="Delete session"
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              </div>
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
function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
      <path d="M10 11v6M14 11v6"/>
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
    </svg>
  )
}
