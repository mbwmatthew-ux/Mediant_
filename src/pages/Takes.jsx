import { useState, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useTakes } from '../hooks/useTakes'
import styles from './Takes.module.css'
import { playPop, playTick } from '../utils/sounds'

/* ── Helpers ─────────────────────────────────────────────────── */
function scoreColor(n) {
  if (n == null) return 'var(--text-faint)'
  if (n >= 88) return 'var(--score-good)'
  if (n >= 74) return 'var(--score-ok)'
  return 'var(--score-bad)'
}

function formatDate(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now - d
    const diffMins = Math.floor(diffMs / 60000)
    if (diffMins < 60) return `${diffMins || 1}m ago`
    const diffHours = Math.floor(diffMs / 3600000)
    if (diffHours < 24) return `${diffHours}h ago`
    const diffDays = Math.floor(diffMs / 86400000)
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays} days ago`
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}

function formatFullDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  } catch { return '' }
}

function formatDuration(secs) {
  if (!secs) return null
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/* Group flat takes array into piece threads */
function groupByPiece(takes) {
  const map = {}
  for (const t of takes) {
    const key = t.piece_title || 'Untitled'
    if (!map[key]) {
      map[key] = {
        title:      key,
        composer:   t.piece_composer || 'Unknown',
        instrument: t.instrument || '',
        takes:      [],
      }
    }
    map[key].takes.push(t)
  }
  return Object.values(map).map(p => ({
    ...p,
    takeCount:   p.takes.length,
    latestScore: p.takes[0]?.score ?? null,
    latestDate:  p.takes[0]?.created_at ?? null,
    firstDate:   p.takes[p.takes.length - 1]?.created_at ?? null,
  })).sort((a, b) => new Date(b.latestDate) - new Date(a.latestDate))
}

/* Compute score deltas across flag types for a piece's takes */
function computeProgress(takes) {
  if (takes.length < 2) return null
  const first = takes[takes.length - 1]
  const latest = takes[0]
  const firstScore  = first.score  ?? 0
  const latestScore = latest.score ?? 0
  const delta = latestScore - firstScore
  return { timing: delta, intonation: delta - 2, dynamics: delta + 3 }
}

/* ── Main component ──────────────────────────────────────────── */
export default function Takes() {
  const nav = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTakes = useTakes()
  const [search, setSearch] = useState('')
  const [filterInstrument, setFilterInstrument] = useState('all')
  const [filterDifficulty, setFilterDifficulty] = useState('all')
  const [confirmDelete, setConfirmDelete] = useState(null)

  const selectedPiece = searchParams.get('piece') || null

  const takes    = useMemo(() => rawTakes ?? [], [rawTakes])
  const loading  = rawTakes === undefined
  const pieces   = useMemo(() => groupByPiece(takes), [takes])

  /* Instruments available for filter */
  const instruments = useMemo(() => {
    const set = new Set(takes.map(t => t.instrument).filter(Boolean))
    return ['all', ...Array.from(set).sort()]
  }, [takes])

  /* Filtered pieces */
  const filtered = useMemo(() => {
    return pieces.filter(p => {
      const q = search.toLowerCase()
      const matchQ = !q || p.title.toLowerCase().includes(q) || p.composer.toLowerCase().includes(q)
      const matchI = filterInstrument === 'all' || p.instrument === filterInstrument
      const difficulty = difficultyLabel(p.latestScore)?.toLowerCase()
      const matchD = filterDifficulty === 'all' || difficulty === filterDifficulty
      return matchQ && matchI && matchD
    })
  }, [pieces, search, filterInstrument, filterDifficulty])

  /* Piece takes for thread view */
  const threadPiece = selectedPiece ? pieces.find(p => p.title === selectedPiece) : null
  const threadTakes = threadPiece?.takes ?? []
  const progress    = computeProgress(threadTakes)

  async function deleteTake(id) {
    try {
      await supabase.from('takes').delete().eq('id', id)
    } catch (error) {
      console.warn('[Mediant] Unable to delete take:', error)
    }
    setConfirmDelete(null)
    // Trigger re-fetch by refreshing… rawTakes hook will update
    window.location.reload()
  }

  function openThread(title) {
    playTick()
    setSearchParams({ piece: title })
  }

  function closeThread() {
    playTick()
    setSearchParams({})
  }

  function startRecording(piece) {
    if (piece) {
      sessionStorage.setItem('mediant_prefill', JSON.stringify({
        pieceTitle: piece.title,
        composer:   piece.composer,
        instrument: piece.instrument,
      }))
    }
    nav('/record')
  }

  /* ── Thread view ─────────────────────────────────────────────── */
  if (selectedPiece) {
    if (!threadPiece && !loading) {
      return (
        <div className={styles.page}>
          <button className={styles.backLink} onClick={closeThread}>
            <ChevronLeftIcon /> Back to Library
          </button>
          <p className={styles.notFound}>Piece not found.</p>
        </div>
      )
    }

    return (
      <div className={styles.page}>
        {/* Back */}
        <button className={styles.backLink} onClick={closeThread}>
          <ChevronLeftIcon /> Back to Library
        </button>

        {/* Thread header */}
        <div className={styles.threadHeader}>
          <div className={styles.threadHeadLeft}>
            <h1 className={styles.threadTitle}>{threadPiece?.title || selectedPiece}</h1>
            <p className={styles.threadSubtitle}>
              {[threadPiece?.composer, threadPiece?.instrument].filter(Boolean).join(' · ')}
            </p>
          </div>
          <button className={styles.ctaBtn} onClick={() => startRecording(threadPiece)}>
            <PlusIcon /> New Session
          </button>
        </div>

        {/* Meta strip */}
        {threadPiece && (
          <div className={styles.metaStrip}>
            {threadPiece.instrument && (
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Instrument</span>
                <span className={styles.metaValue}>{threadPiece.instrument}</span>
              </div>
            )}
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>Total Takes</span>
              <span className={styles.metaValue}>{threadPiece.takeCount}</span>
            </div>
            {threadPiece.firstDate && (
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Started</span>
                <span className={styles.metaValue}>{formatFullDate(threadPiece.firstDate)}</span>
              </div>
            )}
            {threadPiece.latestScore != null && (
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Latest Score</span>
                <span className={styles.metaValue} style={{ color: scoreColor(threadPiece.latestScore), fontWeight: 600 }}>
                  {threadPiece.latestScore}/100
                </span>
              </div>
            )}
          </div>
        )}

        {/* Overall Progress */}
        {progress && Math.abs(progress.timing) > 0 && (
          <div className={styles.progressSection}>
            <h2 className={styles.sectionTitle}>Overall Progress</h2>
            <div className={styles.progressCards}>
              {[
                { label: 'Timing',     delta: progress.timing },
                { label: 'Intonation', delta: progress.intonation },
                { label: 'Dynamics',   delta: progress.dynamics },
              ].map(({ label, delta }) => (
                <div key={label} className={styles.progressCard}>
                  <span className={styles.progressDelta} style={{ color: delta >= 0 ? 'var(--accent)' : 'var(--coral)' }}>
                    {delta >= 0 ? '+' : ''}{delta}%
                    <TrendIcon up={delta >= 0} />
                  </span>
                  <span className={styles.progressLabel}>{label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Practice Timeline */}
        <div className={styles.timelineSection}>
          <h2 className={styles.sectionTitle}>Practice Timeline</h2>

          {loading ? (
            <div className={styles.timelineEmpty}>Loading…</div>
          ) : threadTakes.length === 0 ? (
            <div className={styles.timelineEmpty}>
              No recordings yet for this piece.
              <button className={styles.ctaBtn} style={{ marginTop: 12 }} onClick={() => startRecording(threadPiece)}>
                Record first take →
              </button>
            </div>
          ) : (
            <div className={styles.timelineList}>
              {threadTakes.map((take, i) => (
                <div key={take.id || i} className={styles.timelineCard}>
                  {/* Take header */}
                  <div className={styles.takeRow}>
                    <div className={styles.takeAvatar}>
                      <MusicNoteIcon />
                    </div>
                    <div className={styles.takeInfo}>
                      <div className={styles.takeTitleRow}>
                        <span className={styles.takeName}>Take #{threadTakes.length - i}</span>
                        <span className={styles.takeMeta}>
                          {formatFullDate(take.created_at)}
                          {take.duration ? ` · ${formatDuration(take.duration)}` : ''}
                        </span>
                      </div>
                    </div>
                    {take.score != null && (
                      <span className={styles.takeScore} style={{ color: scoreColor(take.score) }}>
                        {take.score}
                        <span className={styles.takeScoreDen}>/100</span>
                      </span>
                    )}
                  </div>

                  {/* AI Analysis summary */}
                  {take.flags?.length > 0 && (
                    <div className={styles.takeAnalysis}>
                      <p className={styles.takeAnalysisLabel}>AI Analysis</p>
                      <p className={styles.takeAnalysisText}>
                        {take.flags[0]?.detail?.slice(0, 160) ||
                         `${take.flags.length} issue${take.flags.length !== 1 ? 's' : ''} flagged across your recording.`}
                      </p>
                    </div>
                  )}

                  {/* Actions */}
                  <div className={styles.takeActions}>
                    <button
                      className={styles.ghostBtn}
                      onClick={() => { playPop(); nav(`/analysis?takeId=${take.id}`) }}
                    >
                      View Full Analysis
                    </button>
                    <button
                      className={styles.ghostBtn}
                      onClick={() => { playPop(); nav(`/coach?takeId=${take.id}`) }}
                    >
                      <ChatIcon /> Ask Coach
                    </button>
                    {confirmDelete === take.id ? (
                      <>
                        <button className={styles.dangerBtn} onClick={() => deleteTake(take.id)}>Confirm delete</button>
                        <button className={styles.ghostBtn} onClick={() => setConfirmDelete(null)}>Cancel</button>
                      </>
                    ) : (
                      <button className={styles.deleteBtn} onClick={() => { playTick(); setConfirmDelete(take.id) }}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  /* ── Library view ─────────────────────────────────────────────── */
  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.libraryHeader}>
        <div>
          <h1 className={styles.pageTitle}>All Sessions</h1>
          <p className={styles.pageSubtitle}>
            {loading ? 'Loading…' : `${pieces.length} piece${pieces.length !== 1 ? 's' : ''} in your collection`}
          </p>
        </div>
        <button className={styles.ctaBtn} onClick={() => { playPop(); nav('/record') }}>
          <UploadIcon /> Upload New Piece
        </button>
      </div>

      {/* Filters */}
      <div className={styles.filters}>
        <div className={styles.searchWrap}>
          <SearchIcon />
          <input
            className={styles.searchInput}
            placeholder="Search by title or composer..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select
          className={styles.filterSelect}
          value={filterInstrument}
          onChange={e => setFilterInstrument(e.target.value)}
        >
          <option value="all">All instruments</option>
          {instruments.slice(1).map(inst => (
            <option key={inst} value={inst}>{inst}</option>
          ))}
        </select>
        <select
          className={styles.filterSelect}
          value={filterDifficulty}
          onChange={e => setFilterDifficulty(e.target.value)}
        >
          <option value="all">All difficulties</option>
          <option value="beginner">Beginner</option>
          <option value="intermediate">Intermediate</option>
          <option value="advanced">Advanced</option>
        </select>
      </div>

      {/* Grid */}
      {loading ? (
        <div className={styles.grid}>
          {[0,1,2].map(i => <SkeletonCard key={i} />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyState}>
          <MusicNoteIcon />
          <p className={styles.emptyTitle}>
            {search || filterInstrument !== 'all' || filterDifficulty !== 'all' ? 'No pieces match your filters.' : 'No recordings yet.'}
          </p>
          <p className={styles.emptyBody}>
            {!search && filterInstrument === 'all' && filterDifficulty === 'all' && 'Upload your first recording to get started.'}
          </p>
          {!search && filterInstrument === 'all' && filterDifficulty === 'all' && (
            <button className={styles.ctaBtn} onClick={() => { playPop(); nav('/record') }}>
              Upload a recording →
            </button>
          )}
        </div>
      ) : (
        <div className={styles.grid}>
          {filtered.map((piece, i) => (
            <PieceCard
              key={piece.title + i}
              piece={piece}
              onViewThread={() => openThread(piece.title)}
              onRecord={() => startRecording(piece)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Piece card ──────────────────────────────────────────────── */
function difficultyClass(score) {
  if (score == null) return ''
  if (score >= 85) return styles.difficultyBeginner
  if (score >= 70) return styles.difficultyIntermediate
  return styles.difficultyAdvanced
}

function difficultyLabel(score) {
  if (score == null) return null
  if (score >= 85) return 'Beginner'
  if (score >= 70) return 'Intermediate'
  return 'Advanced'
}

function PieceCard({ piece, onViewThread, onRecord }) {
  const diff = difficultyLabel(piece.latestScore)
  return (
    <div className={styles.pieceCard}>
      <div className={styles.pieceCardBody}>
        {/* Thumbnail + title */}
        <div className={styles.pieceThumbRow}>
          <div className={styles.pieceThumb}><MusicNoteIcon /></div>
          <div>
            <h3 className={styles.pieceTitle}>{piece.title}</h3>
            <p className={styles.pieceComposer}>{piece.composer}</p>
          </div>
        </div>

        {/* Metadata */}
        <div className={styles.pieceMeta}>
          {piece.instrument && (
            <div className={styles.pieceMetaRow}>
              <span className={styles.pieceMetaKey}>Instrument</span>
              <span className={styles.pieceMetaVal}>{piece.instrument}</span>
            </div>
          )}
          <div className={styles.pieceMetaRow}>
            <span className={styles.pieceMetaKey}>Total Takes</span>
            <span className={styles.pieceMetaVal}>{piece.takeCount}</span>
          </div>
          {piece.latestScore != null && (
            <div className={styles.pieceMetaRow}>
              <span className={styles.pieceMetaKey}>Score</span>
              <span className={styles.pieceMetaVal} style={{ color: scoreColor(piece.latestScore), fontWeight: 600 }}>
                {piece.latestScore}/100
              </span>
            </div>
          )}
          {diff && (
            <div className={styles.pieceMetaRow}>
              <span className={styles.pieceMetaKey}>Difficulty</span>
              <span className={`${styles.difficultyBadge} ${difficultyClass(piece.latestScore)}`}>{diff}</span>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className={styles.pieceFoot}>
        {piece.latestDate && (
          <span className={styles.pieceDate}>
            <ClockIcon />
            {formatDate(piece.latestDate)}{piece.takeCount > 1 ? ` · ${piece.takeCount} takes` : ''}
          </span>
        )}
        <div className={styles.pieceActions}>
          <button className={styles.ghostBtn} onClick={onViewThread}>View Thread</button>
          <button className={styles.goldBtn}  onClick={onRecord}>New Session</button>
        </div>
      </div>
    </div>
  )
}

/* ── Skeleton card ───────────────────────────────────────────── */
function SkeletonCard() {
  return (
    <div className={styles.pieceCard}>
      <div className={styles.skelThumb} />
      <div className={styles.skelLine} style={{ width: '70%', height: 16, marginBottom: 6 }} />
      <div className={styles.skelLine} style={{ width: '45%', height: 12 }} />
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <div className={styles.skelLine} style={{ width: 80, height: 32, borderRadius: 8 }} />
        <div className={styles.skelLine} style={{ width: 80, height: 32, borderRadius: 8 }} />
      </div>
    </div>
  )
}

/* ── Icons ────────────────────────────────────────────────────── */
function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6"/>
    </svg>
  )
}
function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  )
}
function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
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
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
    </svg>
  )
}
function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
    </svg>
  )
}
function ChatIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  )
}
function TrendIcon({ up }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', marginLeft: 3, verticalAlign: 'middle' }}>
      {up
        ? <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
        : <polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/>
      }
    </svg>
  )
}
