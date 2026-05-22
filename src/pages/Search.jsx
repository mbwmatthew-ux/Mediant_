import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import UploadPieceModal from '../components/UploadPieceModal'
import PieceDetailPanel from '../components/PieceDetailPanel'
import styles from './Page.module.css'

const difficultyColor = { Beginner: 'green', Intermediate: 'gold', Advanced: 'coral' }

function unique(arr) { return [...new Set(arr.filter(Boolean))].sort() }

export default function Search() {
  const { user } = useAuth()
  const [query,      setQuery]      = useState('')
  const [instrument, setInstrument] = useState(null)
  const [era,        setEra]        = useState(null)
  const [difficulty, setDifficulty] = useState(null)
  const [userPieces, setUserPieces] = useState(() => {
    try { return JSON.parse(localStorage.getItem('mediant_user_pieces') || '[]') }
    catch { return [] }
  })
  const [showUpload,    setShowUpload]    = useState(false)
  const [selectedPiece, setSelectedPiece] = useState(null)

  useEffect(() => {
    localStorage.setItem('mediant_user_pieces', JSON.stringify(userPieces))
  }, [userPieces])

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
          <button className={styles.primaryBtn} onClick={() => setShowUpload(true)}>
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
                <tr key={p.id} className={styles.tableRow} onClick={() => setSelectedPiece(p)}>
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
    </div>
  )
}
