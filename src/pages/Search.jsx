import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import UploadPieceModal from '../components/UploadPieceModal'
import PieceDetailPanel from '../components/PieceDetailPanel'
import styles from './Page.module.css'
import { playTick, playPop } from '../utils/sounds'

const difficultyColor = { Beginner: 'green', Intermediate: 'gold', Advanced: 'coral' }

function unique(arr) { return [...new Set(arr.filter(Boolean))].sort() }

export default function Search() {
  const { user } = useAuth()
  const nav = useNavigate()
  const [query,      setQuery]      = useState('')
  const [instrument, setInstrument] = useState(null)
  const [era,        setEra]        = useState(null)
  const [difficulty, setDifficulty] = useState(null)
  const [userPieces,    setUserPieces]    = useState([])
  const [loadingPieces, setLoadingPieces] = useState(true)
  const [fetchError,    setFetchError]    = useState(null)
  const [showUpload,    setShowUpload]    = useState(false)
  const [selectedPiece, setSelectedPiece] = useState(null)

  async function fetchPieces() {
    if (!user?.id) { setUserPieces([]); setLoadingPieces(false); return }
    setLoadingPieces(true)
    setFetchError(null)
    try {
      const { data, error } = await supabase
        .from('user_pieces')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
      if (error) throw error
      setUserPieces(data ?? [])
    } catch (err) {
      console.warn('[Search] fetch error:', err.message)
      setFetchError('Could not load your library. Check your connection and try again.')
    } finally {
      setLoadingPieces(false)
    }
  }

  useEffect(() => { fetchPieces() }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function handlePieceAdded(piece) {
    setUserPieces(prev => [piece, ...prev])
  }

  const instruments  = unique(userPieces.map(p => p.instrument))
  const eras         = unique(userPieces.map(p => p.era))
  const difficulties = unique(userPieces.map(p => p.difficulty))

  const results = userPieces.filter(p => {
    if (query) {
      const q = query.toLowerCase()
      if (!p.title?.toLowerCase().includes(q) &&
          !p.composer?.toLowerCase().includes(q) &&
          !p.instrument?.toLowerCase().includes(q)) return false
    }
    if (instrument && p.instrument !== instrument) return false
    if (era        && p.era        !== era)        return false
    if (difficulty && p.difficulty !== difficulty) return false
    return true
  })

  return (
    <div className={styles.page}>
      {showUpload && (
        <UploadPieceModal
          onClose={() => setShowUpload(false)}
          onAdded={handlePieceAdded}
        />
      )}
      {selectedPiece && (
        <PieceDetailPanel
          piece={selectedPiece}
          onClose={() => setSelectedPiece(null)}
          onDeleted={id => setUserPieces(prev => prev.filter(p => p.id !== id))}
        />
      )}

      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Music Library</h1>
          <p className={styles.sub}>
            {userPieces.length === 0
              ? 'Your library is empty — upload your first piece to get started'
              : `${userPieces.length} piece${userPieces.length !== 1 ? 's' : ''} in your library`}
          </p>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.ghostBtn} onClick={() => { playTick(); nav('/record') }}>
            + New recording
          </button>
          <button className={styles.primaryBtn} onClick={() => { playPop(); setShowUpload(true) }}>
            ↑ Upload sheet music
          </button>
        </div>
      </div>

      <div className={styles.toolbar}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search by title, composer, or instrument…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
        {userPieces.length > 0 && (
          <div className={styles.toolbarFilters}>
            {instruments.length >= 1 && (
              <div className={styles.filterGroup}>
                <span className={styles.filterGroupLabel}>Instrument</span>
                <div className={styles.filterStrip}>
                  <button
                    className={`${styles.filterChip} ${!instrument ? styles.filterChipActive : ''}`}
                    onClick={() => setInstrument(null)}
                  >All</button>
                  {instruments.map(f => (
                    <button
                      key={f}
                      className={`${styles.filterChip} ${instrument === f ? styles.filterChipActive : ''}`}
                      onClick={() => setInstrument(instrument === f ? null : f)}
                    >{f}</button>
                  ))}
                </div>
              </div>
            )}
            {eras.length >= 1 && (
              <div className={styles.filterGroup}>
                <span className={styles.filterGroupLabel}>Era</span>
                <div className={styles.filterStrip}>
                  <button
                    className={`${styles.filterChip} ${!era ? styles.filterChipActive : ''}`}
                    onClick={() => setEra(null)}
                  >All eras</button>
                  {eras.map(f => (
                    <button
                      key={f}
                      className={`${styles.filterChip} ${era === f ? styles.filterChipActive : ''}`}
                      onClick={() => setEra(era === f ? null : f)}
                    >{f}</button>
                  ))}
                </div>
              </div>
            )}
            {difficulties.length >= 1 && (
              <div className={styles.filterGroup}>
                <span className={styles.filterGroupLabel}>Level</span>
                <div className={styles.filterStrip}>
                  <button
                    className={`${styles.filterChip} ${!difficulty ? styles.filterChipActive : ''}`}
                    onClick={() => setDifficulty(null)}
                  >Any level</button>
                  {difficulties.map(f => (
                    <button
                      key={f}
                      className={`${styles.filterChip} ${difficulty === f ? styles.filterChipActive : ''}`}
                      onClick={() => setDifficulty(difficulty === f ? null : f)}
                    >{f}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {fetchError && (
        <div className={styles.errorBanner}>
          <span>⚠</span>
          <span>{fetchError}</span>
          <button className={styles.errorRetry} onClick={fetchPieces}>Retry</button>
        </div>
      )}

      {loadingPieces && !fetchError ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead className={styles.tableHead}>
              <tr>
                {['Title','Composer','Instrument','Era','Level','Key · Time'].map(h => (
                  <th key={h} className={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[0,1,2,3,4].map(i => (
                <tr key={i} className={styles.tableRow} style={{ pointerEvents: 'none' }}>
                  {[70,55,50,42,36,48].map((w, j) => (
                    <td key={j} className={styles.td}>
                      <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 3, height: 10, width: w, animation: 'pulse 1.5s ease-in-out infinite' }} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
      <>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionHeaderTitle}>
          {results.length} result{results.length !== 1 ? 's' : ''}
        </span>
      </div>

      {results.length === 0 ? (
        <div className={styles.emptyLibrary}>
          {userPieces.length === 0 ? (
            <>
              <p className={styles.emptyLibraryTitle}>Your library is empty</p>
              <p className={styles.emptyLibrarySub}>Upload a piece of sheet music to get started. Mediant will read it and add it to your library automatically.</p>
              <button className={styles.primaryBtn} onClick={() => setShowUpload(true)}>↑ Upload your first piece</button>
            </>
          ) : (
            <p className={styles.emptyLibrarySub}>No pieces match your filters.</p>
          )}
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead className={styles.tableHead}>
              <tr>
                <th className={styles.th}>Title</th>
                <th className={styles.th}>Composer</th>
                <th className={styles.th}>Instrument</th>
                <th className={styles.th}>Era</th>
                <th className={styles.th}>Level</th>
                <th className={styles.th}>Key · Time</th>
              </tr>
            </thead>
            <tbody>
              {results.map(p => (
                <tr key={p.id} className={styles.tableRow} onClick={() => { playTick(); setSelectedPiece(p) }}>
                  <td className={styles.td}>
                    {p.title}
                    {p.userUploaded && <span className={styles.uploadedTag}> · Uploaded</span>}
                  </td>
                  <td className={styles.tdSoft}>{p.composer}</td>
                  <td className={styles.tdSoft}>{p.instrument}</td>
                  <td className={styles.tdSoft}>{p.era}</td>
                  <td className={styles.td}>
                    <span className={`${styles.diffBadge} ${styles[difficultyColor[p.difficulty]]}`}>
                      {p.difficulty}
                    </span>
                  </td>
                  <td className={styles.tdSoft}>{p.key} · {p.time}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}
    </div>
  )
}
