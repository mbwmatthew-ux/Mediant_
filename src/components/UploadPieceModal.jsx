import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import styles from './UploadPieceModal.module.css'

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
const MAX_MB   = 20

export default function UploadPieceModal({ onClose, onAdded }) {
  const { user } = useAuth()
  const inputRef  = useRef(null)
  const [file,    setFile]    = useState(null)
  const [stage,   setStage]   = useState('idle')   // idle | uploading | analyzing | done | error
  const [error,   setError]   = useState(null)
  const [result,  setResult]  = useState(null)
  const [drag,    setDrag]    = useState(false)

  function pickFile(f) {
    if (!f) return
    if (!ACCEPTED.includes(f.type)) { setError('Please upload a PNG, JPG, WEBP, or PDF file.'); return }
    if (f.size > MAX_MB * 1024 * 1024) { setError(`File must be under ${MAX_MB} MB.`); return }
    setError(null)
    setFile(f)
  }

  function onDrop(e) {
    e.preventDefault(); setDrag(false)
    pickFile(e.dataTransfer.files[0])
  }

  async function handleUpload() {
    if (!file) return
    setStage('uploading')
    setError(null)

    try {
      // 1. Upload file to Supabase Storage
      const ext      = file.name.split('.').pop()
      const filePath = `${user.id}/${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage
        .from('sheet-music')
        .upload(filePath, file, { contentType: file.type })
      if (upErr) throw new Error(upErr.message)

      // 2. Call Edge Function to analyze with Claude
      setStage('analyzing')
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-sheet-music`,
        {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ filePath, fileType: file.type }),
        }
      )
      const analysis = await res.json()
      if (analysis.error) throw new Error(analysis.error)

      // 3. Get public URL for display
      const { data: { publicUrl } } = supabase.storage
        .from('sheet-music')
        .getPublicUrl(filePath)

      // 4. Save to user_pieces table
      const { data: piece, error: dbErr } = await supabase
        .from('user_pieces')
        .insert({
          user_id:    user.id,
          title:      analysis.title,
          composer:   analysis.composer,
          instrument: analysis.instrument,
          era:        analysis.era,
          difficulty: analysis.difficulty,
          key:        analysis.key,
          time:       analysis.time,
          ai_summary: analysis.ai_summary,
          file_path:  filePath,
          file_url:   publicUrl,
        })
        .select()
        .single()
      if (dbErr) throw new Error(dbErr.message)

      setResult({ ...piece })
      setStage('done')
    } catch (err) {
      setError(err.message)
      setStage('error')
    }
  }

  function handleDone() {
    onAdded(result)
    onClose()
  }

  return (
    <div className={styles.backdrop} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>Upload your sheet music</h2>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {stage === 'idle' || stage === 'error' ? (
          <>
            <p className={styles.modalSub}>
              Upload a PNG, JPG, or PDF of any sheet music — Mediant's AI will read it and add it to your library.
            </p>

            <div
              className={`${styles.dropzone} ${drag ? styles.dropzoneDrag : ''} ${file ? styles.dropzoneFilled : ''}`}
              onClick={() => inputRef.current.click()}
              onDragOver={e => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
            >
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPTED.join(',')}
                style={{ display: 'none' }}
                onChange={e => pickFile(e.target.files[0])}
              />
              {file ? (
                <>
                  <span className={styles.dzIcon}>✓</span>
                  <strong className={styles.dzFileName}>{file.name}</strong>
                  <span className={styles.dzHint}>Click to change file</span>
                </>
              ) : (
                <>
                  <span className={styles.dzIcon}>♩</span>
                  <strong className={styles.dzLabel}>Drop your sheet music here</strong>
                  <span className={styles.dzHint}>PNG, JPG, WEBP, or PDF · up to {MAX_MB} MB</span>
                </>
              )}
            </div>

            {error && <p className={styles.errorMsg}>{error}</p>}

            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
              <button
                className={styles.uploadBtn}
                onClick={handleUpload}
                disabled={!file}
              >
                Analyze & add to library
              </button>
            </div>
          </>
        ) : stage === 'uploading' ? (
          <div className={styles.progress}>
            <div className={styles.spinner} />
            <p className={styles.progressLabel}>Uploading your file…</p>
          </div>
        ) : stage === 'analyzing' ? (
          <div className={styles.progress}>
            <div className={styles.spinner} />
            <p className={styles.progressLabel}>AI is reading your sheet music…</p>
            <p className={styles.progressSub}>Extracting title, composer, key, difficulty, and learning notes</p>
          </div>
        ) : stage === 'done' && result ? (
          <div className={styles.resultBox}>
            <span className={styles.resultCheck}>✓</span>
            <h3 className={styles.resultTitle}>{result.title}</h3>
            <p className={styles.resultComposer}>{result.composer}</p>
            <div className={styles.resultTags}>
              <span className={styles.tag}>{result.instrument}</span>
              <span className={styles.tag}>{result.era}</span>
              <span className={styles.tag}>{result.difficulty}</span>
              <span className={styles.tag}>{result.key}</span>
              <span className={styles.tag}>{result.time}</span>
            </div>
            {result.ai_summary && (
              <p className={styles.resultSummary}>{result.ai_summary}</p>
            )}
            <button className={styles.uploadBtn} onClick={handleDone}>
              Add to my library
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
