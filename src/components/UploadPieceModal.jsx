import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { saveFile } from '../lib/fileStore'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import styles from './UploadPieceModal.module.css'

const ACCEPTED    = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
const MAX_MB      = 20
const INSTRUMENTS = ['Piano', 'Violin', 'Cello', 'Viola', 'Guitar', 'Flute', 'Clarinet', 'Trumpet', 'Saxophone', 'Oboe', 'Horn', 'Harp', 'Other']
const ERAS        = ['Baroque', 'Classical', 'Romantic', 'Modern']
const LEVELS      = ['Beginner', 'Intermediate', 'Advanced']

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function UploadPieceModal({ onClose, onAdded }) {
  const { user }  = useAuth()
  const nav       = useNavigate()
  const inputRef  = useRef(null)
  const [file,       setFile]       = useState(null)
  const [drag,       setDrag]       = useState(false)
  const [instrument, setInstrument] = useState('')
  const [phase,      setPhase]      = useState('idle')   // idle | analyzing | ready | saving | saving-record
  const [form,       setForm]       = useState(null)
  const [error,      setError]      = useState(null)

  async function analyze(f) {
    setPhase('analyzing')
    setError(null)
    try {
      const imageBase64 = await fileToBase64(f)
      const { data, error } = await supabase.functions.invoke('analyze-sheet-music', {
        body: { imageBase64, mediaType: f.type },
      })
      if (error) throw new Error(error.message ?? String(error))
      const name = f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
      setForm({
        title:      data.title      || name,
        composer:   data.composer   || '',
        era:        ERAS.includes(data.era) ? data.era : 'Romantic',
        difficulty: LEVELS.includes(data.difficulty) ? data.difficulty : 'Intermediate',
        key:        '',
        time:       data.time       || '',
        bpm:        data.bpm        || '',
      })
      setPhase('ready')
    } catch {
      setError('Could not analyze the file — fill in the details manually.')
      const name = f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
      setForm({ title: name, composer: '', era: 'Romantic', difficulty: 'Intermediate', key: '', time: '', bpm: '' })

      setPhase('ready')
    }
  }

  function pickFile(f) {
    if (!f) return
    if (!ACCEPTED.includes(f.type)) { setError('Please upload a PNG, JPG, WEBP, or PDF.'); return }
    if (f.size > MAX_MB * 1024 * 1024) { setError(`File must be under ${MAX_MB} MB.`); return }
    setError(null)
    setFile(f)
    analyze(f)
  }

  function set(field) {
    return e => setForm(prev => ({ ...prev, [field]: e.target.value }))
  }

  async function handleAdd({ andRecord = false } = {}) {
    if (!file || !form || !instrument) return
    setPhase(andRecord ? 'saving-record' : 'saving')
    setError(null)
    try {
      // Upload file to Supabase storage
      const ext      = file.name.split('.').pop() ?? 'bin'
      const filePath = `${user.id}/${Date.now()}.${ext}`
      const { error: uploadErr } = await supabase.storage
        .from('sheet-music')
        .upload(filePath, file, { contentType: file.type })
      if (uploadErr) throw uploadErr

      // Insert into user_pieces
      const { data: inserted, error: insertErr } = await supabase
        .from('user_pieces')
        .insert({
          user_id:    user.id,
          title:      form.title.trim()    || file.name,
          composer:   form.composer.trim() || 'Unknown',
          instrument,
          era:        form.era,
          difficulty: form.difficulty,
          key:        form.key.trim()  || '—',
          time:       form.time.trim() || '—',
          bpm:        parseInt(form.bpm) || null,
          file_path:  filePath,
        })
        .select('id')
        .single()
      if (insertErr) throw insertErr

      // Save to IndexedDB so the score viewer works offline
      await saveFile(inserted.id, file).catch(() => {})

      const piece = {
        id:           inserted.id,
        ...form,
        title:        form.title.trim()    || file.name,
        composer:     form.composer.trim() || 'Unknown',
        instrument,
        key:          form.key.trim()  || '—',
        time:         form.time.trim() || '—',
        bpm:          parseInt(form.bpm) || null,
        file_path:    filePath,
        userUploaded: true,
        mediaType:    file.type,
      }

      onAdded(piece)

      if (andRecord) {
        sessionStorage.setItem('mediant_prefill', JSON.stringify({
          pieceTitle: piece.title,
          composer:   piece.composer,
          instrument: piece.instrument,
          key:        piece.key  !== '—' ? piece.key  : null,
          timeSig:    piece.time !== '—' ? piece.time : null,
          bpm:        piece.bpm  || null,
          pieceId:    piece.id,
          mediaType:  file.type,
        }))
        nav('/record')
      } else {
        onClose()
      }
    } catch (err) {
      setError(`Failed to save: ${err.message}`)
      setPhase('ready')
    }
  }

  return (
    <div className={styles.backdrop} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>

        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>Add a piece</h2>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <p className={styles.modalSub}>
          Drop your sheet music and Mediant will fill in the details. You just need to select the instrument.
        </p>

        {/* Drop zone */}
        <div
          className={`${styles.dropzone} ${drag ? styles.dropzoneDrag : ''} ${file ? styles.dropzoneFilled : ''}`}
          onClick={() => phase === 'idle' && inputRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); pickFile(e.dataTransfer.files[0]) }}
          style={phase !== 'idle' ? { cursor: 'default' } : {}}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED.join(',')}
            style={{ display: 'none' }}
            onChange={e => pickFile(e.target.files[0])}
          />
          {phase === 'idle' ? (
            <>
              <span className={styles.dzIcon}>♩</span>
              <strong className={styles.dzLabel}>Drop your sheet music here</strong>
              <span className={styles.dzHint}>PNG, JPG, WEBP, or PDF · up to {MAX_MB} MB</span>
            </>
          ) : (
            <>
              <span className={styles.dzIcon}>✓</span>
              <strong className={styles.dzFileName}>{file.name}</strong>
              {phase === 'idle' && <span className={styles.dzHint}>Click to change</span>}
            </>
          )}
        </div>

        {/* Analyzing spinner */}
        {phase === 'analyzing' && (
          <div className={styles.progress}>
            <div className={styles.spinner} />
            <p className={styles.progressLabel}>Reading your sheet music…</p>
            <p className={styles.progressSub}>Extracting the title, composer, key, and more.</p>
          </div>
        )}

        {/* Form — shown once analysis is done */}
        {phase === 'ready' && form && (
          <div className={styles.form}>
            {error && <p className={styles.errorMsg}>{error}</p>}

            <div className={styles.formRow}>
              <label className={styles.formLabel}>Instrument <span className={styles.formRequired}>— select yours</span></label>
              <select className={styles.formSelect} value={instrument} onChange={e => setInstrument(e.target.value)}>
                <option value="" disabled>Select instrument…</option>
                {INSTRUMENTS.map(i => <option key={i}>{i}</option>)}
              </select>
            </div>

            <div className={styles.formDivider} />

            <p className={styles.formAiLabel}>Auto-detected — edit if needed</p>

            <div className={styles.formRow}>
              <label className={styles.formLabel}>Title</label>
              <input className={styles.formInput} value={form.title} onChange={set('title')} />
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Composer</label>
              <input className={styles.formInput} value={form.composer} onChange={set('composer')} placeholder="Unknown" />
            </div>
            <div className={styles.formRowGroup}>
              <div className={styles.formRow}>
                <label className={styles.formLabel}>Era</label>
                <select className={styles.formSelect} value={form.era} onChange={set('era')}>
                  {ERAS.map(e => <option key={e}>{e}</option>)}
                </select>
              </div>
              <div className={styles.formRow}>
                <label className={styles.formLabel}>Level</label>
                <select className={styles.formSelect} value={form.difficulty} onChange={set('difficulty')}>
                  {LEVELS.map(l => <option key={l}>{l}</option>)}
                </select>
              </div>
            </div>
            <div className={styles.formRowGroup}>
              <div className={styles.formRow}>
                <label className={styles.formLabel}>Key</label>
                <input className={styles.formInput} value={form.key} onChange={set('key')} placeholder="e.g. D minor, B♭ major" />
              </div>
              <div className={styles.formRow}>
                <label className={styles.formLabel}>Time</label>
                <input className={styles.formInput} value={form.time} onChange={set('time')} placeholder="e.g. 4/4" />
              </div>
              <div className={styles.formRow}>
                <label className={styles.formLabel}>Tempo (BPM)</label>
                <input className={styles.formInput} type="number" min="1" max="400" value={form.bpm} onChange={set('bpm')} placeholder="e.g. 56" />
              </div>
            </div>
          </div>
        )}

        <div className={styles.modalActions}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.uploadBtnSecondary}
            onClick={() => handleAdd({ andRecord: false })}
            disabled={phase !== 'ready' || !instrument}
          >
            {phase === 'saving' ? 'Saving…' : 'Add to library'}
          </button>
          <button
            className={styles.uploadBtn}
            onClick={() => handleAdd({ andRecord: true })}
            disabled={phase !== 'ready' || !instrument}
          >
            {phase === 'saving-record' ? 'Saving…' : 'Add & Record →'}
          </button>
        </div>

      </div>
    </div>
  )
}
