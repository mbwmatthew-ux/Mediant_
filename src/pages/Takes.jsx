import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useTakes } from '../hooks/useTakes'
import styles from './Page.module.css'
import { playTick, playPop, playThud } from '../utils/sounds'

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
  const rawTakes = useTakes()
  const [takes, setTakes] = useState(undefined)
  const [confirmDelete, setConfirmDelete] = useState(null)

  useEffect(() => {
    if (rawTakes !== undefined) setTakes(rawTakes)
  }, [rawTakes])

  async function deleteTake(id) {
    playThud()
    try {
      await supabase.from('takes').delete().eq('id', id)
    } catch (e) {
      console.error('Delete failed:', e)
    }
    setTakes(prev => prev?.filter(t => t.id !== id) ?? [])
    setConfirmDelete(null)
  }

  if (takes === undefined) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <p className={styles.label}>Saved Takes</p>
            <h1 className={styles.title}>Your recordings</h1>
          </div>
        </div>
        <div className={styles.takesGrid}>
          {[0, 1, 2, 3].map(i => (
            <div key={i} className={`${styles.takeCard} ${i === 0 ? styles.takeCardFeatured : ''}`} style={{ gap: 10 }}>
              <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 4, height: 10, width: 60, animation: 'pulse 1.5s ease-in-out infinite' }} />
              <div style={{ background: 'rgba(255,255,255,0.07)', borderRadius: 4, height: 14, width: '70%', animation: 'pulse 1.5s ease-in-out infinite' }} />
              <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 4, height: 10, width: '50%', animation: 'pulse 1.5s ease-in-out infinite' }} />
              <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 6, height: 30, width: 120, marginTop: 6, animation: 'pulse 1.5s ease-in-out infinite' }} />
            </div>
          ))}
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
          <button className={styles.primaryBtn} style={{ marginTop: 16 }} onClick={() => { playPop(); nav('/record') }}>
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
        <button className={styles.ghostBtn} onClick={() => { playTick(); nav('/summary') }}>View recap</button>
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
                formatDate(t.created_at || t.date),
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
            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <button
                className={i === 0 ? styles.primaryBtn : styles.ghostBtn}
                onClick={() => { playTick(); nav(t.id ? `/analysis?takeId=${t.id}` : '/analysis') }}
              >
                View review
              </button>
              {t.id && confirmDelete !== t.id && (
                <button className={styles.deleteBtn} onClick={() => { playTick(); setConfirmDelete(t.id) }}>
                  Delete
                </button>
              )}
              {confirmDelete === t.id && (
                <>
                  <button className={styles.deleteBtnConfirm} onClick={() => deleteTake(t.id)}>
                    Confirm delete
                  </button>
                  <button className={styles.ghostBtn} onClick={() => { playTick(); setConfirmDelete(null) }}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
