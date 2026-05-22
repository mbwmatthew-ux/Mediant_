import { useRef, useState } from 'react'
import { saveFile } from '../lib/fileStore'
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
  const inputRef = useRef(null)
  const [file,       setFile]       = useState(null)
  const [drag,       setDrag]       = useState(false)
  const [instrument, setInstrument] = useState('')
  const [phase,      setPhase]      = useState('idle')   // idle | analyzing | ready
  const [form,       setForm]       = useState(null)
  const [error,      setError]      = useState(null)

  async function analyze(f) {
    setPhase('analyzing')
    setError(null)
    try {
      const imageBase64 = await fileToBase64(f)
      const res = await fetch('/api/analyze-sheet-music', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ imageBase64, mediaType: f.type }),
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      const name = f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
      setForm({
        title:      data.title      || name,
        composer:   data.composer   || '',
        era:        ERAS.includes(data.era) ? data.era : 'Romantic',
        difficulty: LEVELS.includes(data.difficulty) ? data.difficulty : 'Intermediate',
        key:        data.key        || '',
        time:       data.time       || '',
      })
      setPhase('ready')
    } catch {
      setError('Could not analyze the file — fill in the details manually.')
      const name = f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
      setForm({ title: name, composer: '', era: 'Romantic', difficulty: 'Intermediate', key: '', time: '' })
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

  async function handleAdd() {
    if (!file || !form) return
    const id = `upload-${Date.now()}`
    const piece = {
      id,
      ...form,
      title:       form.title.trim()    || file.name,
      composer:    form.composer.trim() || 'Unknown',
      key:         form.key.trim()      || '—',
      time:        form.time.trim()     || '—',
      instrument,
      mediaType:   file.type,
      userUploaded: true,
    }
    // Save the actual file to IndexedDB so it can be viewed later
    await saveFile(id, file).catch(() => {})
    onAdded(piece)
    onClose()
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
                <label className={styles.formLabel}>Key <span className={styles.formRequired}>— enter manually</span></label>
                <input className={styles.formInput} value={form.key} onChange={set('key')} placeholder="e.g. D minor, B♭ major" />
              </div>
              <div className={styles.formRow}>
                <label className={styles.formLabel}>Time</label>
                <input className={styles.formInput} value={form.time} onChange={set('time')} placeholder="e.g. 4/4" />
              </div>
            </div>
          </div>
        )}

        <div className={styles.modalActions}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.uploadBtn}
            onClick={handleAdd}
            disabled={phase !== 'ready' || !instrument}
          >
            Add to library
          </button>
        </div>

      </div>
    </div>
  )
}
