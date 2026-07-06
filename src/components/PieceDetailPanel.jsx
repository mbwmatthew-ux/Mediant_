import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { getFile } from '../lib/fileStore'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import styles from './PieceDetailPanel.module.css'

function scoreColor(n) {
  if (n >= 88) return '#2bbdc9'
  if (n >= 74) return 'var(--gold)'
  return 'var(--coral)'
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
  catch { return iso }
}

export default function PieceDetailPanel({ piece, onClose, onDeleted }) {
  const nav        = useNavigate()
  const { user }   = useAuth()
  const scoreEl    = useRef(null)
  const osmdRef    = useRef(null)

  const [scoreFetching,  setScoreFetching]  = useState(false)
  const [scoreReady,     setScoreReady]     = useState(false)
  const [scoreSource,    setScoreSource]    = useState(null)
  const [fileURL,        setFileURL]        = useState(null)
  const [scoreMediaType, setScoreMediaType] = useState(piece.mediaType ?? null)
  const [pastSessions,   setPastSessions]   = useState([])
  const [deletingId,     setDeletingId]     = useState(null)
  const [deletingPiece,  setDeletingPiece]  = useState(false)
  const [confirmDialog,  setConfirmDialog]  = useState(null) // { message, onConfirm }

  // Load past sessions for this piece from Supabase
  useEffect(() => {
    if (!user?.id) {
      try {
        const all = JSON.parse(localStorage.getItem('mediant_takes') || '[]')
        setPastSessions(all.filter(t =>
          t.piece_title?.toLowerCase() === piece.title?.toLowerCase()
        ))
      } catch { setPastSessions([]) }
      return
    }

    supabase
      .from('takes')
      .select('id, piece_title, score, flags, created_at, video_path, score_path')
      .eq('user_id', user.id)
      .ilike('piece_title', piece.title)
      .order('created_at', { ascending: false })
      .then(({ data }) => setPastSessions(data ?? []))
      .catch(() => setPastSessions([]))
  }, [piece.title, user?.id])

  // Load sheet music — use uploaded file if available, otherwise search online
  useEffect(() => {
    let objectURL = null

    function inferMediaType(filePath) {
      const ext = filePath?.split('.').pop()?.toLowerCase()
      if (ext === 'pdf')  return 'application/pdf'
      if (ext === 'png')  return 'image/png'
      if (ext === 'webp') return 'image/webp'
      return 'image/jpeg'
    }

    async function load() {
      setScoreFetching(true)
      setScoreReady(false)

      // 1. For user-uploaded pieces, try IndexedDB first, then Supabase storage
      if (piece.userUploaded || piece.file_path) {
        const file = await getFile(piece.id).catch(() => null)
        if (file) {
          objectURL = URL.createObjectURL(file)
          setFileURL(objectURL)
          setScoreSource('uploaded')
          setScoreReady(true)
          setScoreFetching(false)
          return
        }

        // IndexedDB miss — fall back to Supabase storage signed URL
        if (piece.file_path) {
          const { data: signed } = await supabase.storage
            .from('sheet-music')
            .createSignedUrl(piece.file_path, 3600)
            .catch(() => ({ data: null }))
          if (signed?.signedUrl) {
            const mediaType = piece.mediaType || inferMediaType(piece.file_path)
            setScoreMediaType(mediaType)
            setFileURL(signed.signedUrl)
            setScoreSource('uploaded')
            setScoreReady(true)
            setScoreFetching(false)
            return
          }
        }
      }

      // 2. For non-uploaded pieces, search Mutopia / ask Claude
      try {
        const res  = await fetch('/api/get-score', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ pieceTitle: piece.title, composer: piece.composer }),
        })
        const { xml, source } = await res.json()
        setScoreSource(source ?? null)

        if (xml && scoreEl.current) {
          const osmd = new OpenSheetMusicDisplay(scoreEl.current, {
            autoResize: true, backend: 'svg',
            drawTitle: false, drawComposer: false, drawCredits: false,
            drawPartNames: false, drawMeasureNumbers: true, measureNumberInterval: 4,
          })
          osmdRef.current = osmd
          await osmd.load(xml).then(() => osmd.render()).catch(() => {})
        }
      } catch { /* show nothing */ }

      setScoreReady(true)
      setScoreFetching(false)
    }

    load()
    return () => { if (objectURL) URL.revokeObjectURL(objectURL) }
  }, [piece.id, piece.title, piece.composer, piece.userUploaded])

  async function deleteSession(take) {
    setConfirmDialog({
      message: `Delete this recording from ${formatDate(take.created_at || take.date)}?`,
      onConfirm: () => doDeleteSession(take),
    })
  }

  async function doDeleteSession(take) {
    setDeletingId(take.id)
    try {
      setPastSessions(prev => prev.filter(t => t.id !== take.id))

      // Delete DB row
      if (user?.id) {
        await supabase.from('takes').delete().eq('id', take.id)
      } else {
        const all = JSON.parse(localStorage.getItem('mediant_takes') || '[]')
        localStorage.setItem('mediant_takes', JSON.stringify(all.filter(t => t.id !== take.id)))
      }

      // Delete storage files
      if (take.video_path) await supabase.storage.from('recordings').remove([take.video_path])
      if (take.score_path) await supabase.storage.from('sheet-music').remove([take.score_path])
    } catch { /* storage errors are non-fatal */ }
    finally { setDeletingId(null) }
  }

  async function deletePiece() {
    setConfirmDialog({
      message: `Delete "${piece.title}" from your library?`,
      onConfirm: doDeletePiece,
    })
  }

  async function doDeletePiece() {
    setDeletingPiece(true)
    try {
      await supabase.from('user_pieces').delete().eq('id', piece.id)
      if (piece.file_path) await supabase.storage.from('sheet-music').remove([piece.file_path]).catch(() => {})
      onDeleted?.(piece.id)
      onClose()
    } catch {
      setDeletingPiece(false)
    }
  }

  function startRecording() {
    sessionStorage.setItem('mediant_prefill', JSON.stringify({
      pieceTitle:  piece.title,
      composer:    piece.composer,
      instrument:  piece.instrument,
      key:         piece.key  && piece.key  !== '—' ? piece.key  : null,
      timeSig:     piece.time && piece.time !== '—' ? piece.time : null,
      bpm:         piece.bpm  || null,
      difficulty:  piece.difficulty ?? null,
      pieceId:     piece.userUploaded ? piece.id : null,
      filePath:    piece.file_path ?? null,
      mediaType:   piece.mediaType ?? null,
    }))
    nav('/record')
  }

  return (
    <div className={styles.backdrop} onClick={e => e.target === e.currentTarget && !confirmDialog && onClose()}>
      {confirmDialog && (
        <div className={styles.confirmOverlay} onClick={e => e.stopPropagation()}>
          <div className={styles.confirmBox}>
            <p className={styles.confirmMsg}>{confirmDialog.message}</p>
            <p className={styles.confirmSub}>This cannot be undone.</p>
            <div className={styles.confirmActions}>
              <button
                className={styles.confirmCancel}
                onClick={() => setConfirmDialog(null)}
              >
                Cancel
              </button>
              <button
                className={styles.confirmDelete}
                onClick={() => { confirmDialog.onConfirm(); setConfirmDialog(null) }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      <div className={styles.panel}>

        {/* ── Header ─────────────────────────────────────────── */}
        <div className={styles.header}>
          <button className={styles.backBtn} onClick={onClose}>← Back</button>
          <div className={styles.headerMeta}>
            <h2 className={styles.pieceTitle}>{piece.title}</h2>
            <p className={styles.pieceSub}>
              {piece.composer} · {piece.instrument} · {piece.era} · {piece.difficulty}
              {piece.key && piece.key !== '—' ? ` · ${piece.key}` : ''}
              {piece.time && piece.time !== '—' ? ` · ${piece.time}` : ''}
            </p>
          </div>
          <div className={styles.headerActions}>
            <button
              className={styles.deletePieceBtn}
              onClick={deletePiece}
              disabled={deletingPiece}
              title="Delete this piece from your library"
            >
              {deletingPiece ? 'Deleting…' : 'Delete piece'}
            </button>
            <button className={styles.recordBtn} onClick={startRecording}>
              Start Recording →
            </button>
          </div>
        </div>

        {/* ── Body ───────────────────────────────────────────── */}
        <div className={styles.body}>

          {/* Sheet music */}
          <div className={styles.scoreSection}>
            {scoreFetching && (
              <div className={styles.scoreLoading}>
                <div className={styles.spinner} />
                <p>Searching for sheet music…</p>
              </div>
            )}

            {/* Uploaded image */}
            {fileURL && scoreMediaType?.startsWith('image/') && (
              <img
                src={fileURL}
                alt={piece.title}
                style={{ width: '100%', borderRadius: 6, display: 'block' }}
              />
            )}

            {/* Uploaded PDF */}
            {fileURL && scoreMediaType === 'application/pdf' && (
              <embed
                src={fileURL}
                type="application/pdf"
                width="100%"
                height="700px"
                style={{ borderRadius: 6 }}
              />
            )}

            {/* OSMD container — shown only when no uploaded file */}
            {!fileURL && <div ref={scoreEl} />}

            {scoreReady && scoreSource && !fileURL && (
              <p className={styles.sourceLabel}>
                {scoreSource === 'mutopia'
                  ? 'Sheet music from Mutopia Project (public domain)'
                  : 'Approximated sheet music — may not be note-perfect'}
              </p>
            )}
            {scoreReady && !scoreSource && !scoreFetching && !fileURL && (
              <div className={styles.noScore}>
                <p>Sheet music not available for this piece yet.</p>
              </div>
            )}
          </div>

          {/* Past sessions */}
          <div className={styles.sessionsSection}>
            <h3 className={styles.sessionsTitle}>Past Sessions</h3>
            {pastSessions.length === 0 ? (
              <p className={styles.noSessions}>
                No recordings yet.<br />Hit "Start Recording" to add your first take.
              </p>
            ) : (
              <div className={styles.sessionList}>
                {pastSessions.map((t, i) => (
                  <div key={t.id || i} className={styles.sessionCard}>
                    <div className={styles.sessionRow}>
                      <span className={styles.sessionDate}>{formatDate(t.created_at || t.date)}</span>
                      <div className={styles.sessionRowRight}>
                        {t.score != null && (
                          <span className={styles.sessionScore} style={{ color: scoreColor(t.score) }}>
                            {t.score}/100
                          </span>
                        )}
                        <button
                          className={styles.deleteBtn}
                          onClick={() => deleteSession(t)}
                          disabled={deletingId === t.id}
                          title="Delete recording"
                        >
                          {deletingId === t.id ? '…' : '✕'}
                        </button>
                      </div>
                    </div>
                    {t.flags?.length > 0 && (
                      <div className={styles.flagList}>
                        {t.flags.map((f, fi) => (
                          <div key={fi} className={styles.flagItem}>
                            <span className={styles.flagTag}>m.{f.measure} · {f.type}</span>
                            <span className={styles.flagTitle}>{f.title}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
