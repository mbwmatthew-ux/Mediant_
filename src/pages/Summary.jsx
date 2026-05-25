import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import styles from './Page.module.css'
import { playTick, playPop } from '../utils/sounds'

function scoreColor(n) {
  if (n >= 88) return '#8fbe9f'
  if (n >= 74) return 'var(--gold)'
  return 'var(--coral)'
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }

export default function Summary() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [take, setTake] = useState(undefined)

  useEffect(() => {
    const takeId = params.get('takeId')

    async function load() {
      // Try Supabase first — by URL param, then most recent take
      try {
        let query = supabase
          .from('takes')
          .select('id, piece_title, piece_composer, instrument, score, flags, created_at, video_path')
        if (takeId) {
          query = query.eq('id', takeId)
        } else {
          query = query.order('created_at', { ascending: false }).limit(1)
        }
        const { data } = await query.maybeSingle()
        if (data) { setTake(data); return }
      } catch { /* fall through */ }

      // localStorage fallback
      try {
        const stored = localStorage.getItem('mediant_last_take')
        setTake(stored ? JSON.parse(stored) : null)
      } catch {
        setTake(null)
      }
    }

    load()
  }, [params])

  if (take === undefined) {
    return (
      <div className={styles.page}>
        <div className={styles.analyzeScreen}>
          <div className={styles.analyzeIcon}>♩</div>
          <p className={styles.analyzeSub}>Loading…</p>
        </div>
      </div>
    )
  }

  if (take === null) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <p className={styles.label}>Session Summary</p>
            <h1 className={styles.title}>Session recap</h1>
          </div>
        </div>
        <div className={styles.analyzeScreen}>
          <div className={styles.analyzeIcon}>♩</div>
          <p className={styles.analyzeTitle}>No session yet</p>
          <p className={styles.analyzeSub}>Upload a recording to see your session summary here.</p>
          <button className={styles.primaryBtn} style={{ marginTop: 16 }} onClick={() => nav('/record')}>
            Upload a recording →
          </button>
        </div>
      </div>
    )
  }

  const flags     = take.flags ?? []
  const score     = take.score ?? null
  const flagTypes = [...new Set(flags.map(f => capitalize(f.type)).filter(Boolean))]

  const summaryItems = [
    {
      label: 'Piece',
      text: [take.piece_title, take.piece_composer].filter(Boolean).join(' · ') || 'Untitled',
    },
    {
      label: 'Score',
      text: score != null ? `${score}/100` : 'Not scored',
      color: score != null ? scoreColor(score) : undefined,
    },
    {
      label: 'Issues found',
      text: flags.length > 0
        ? `${flags.length} flag${flags.length !== 1 ? 's' : ''} · ${flagTypes.join(', ')}`
        : 'No issues detected',
    },
    take.instrument && { label: 'Instrument', text: take.instrument },
  ].filter(Boolean)

  const takeId = take.id

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Session Summary</p>
          <h1 className={styles.title}>Session recap</h1>
        </div>
        <button className={styles.ghostBtn} onClick={() => { playTick(); nav(takeId ? `/analysis?takeId=${takeId}` : '/analysis') }}>
          ← Back to score
        </button>
      </div>

      <div className={styles.summaryGrid}>
        {summaryItems.map(({ label, text, color }) => (
          <div key={label} className={styles.summaryCard}>
            <p className={styles.label}>{label}</p>
            <strong className={styles.summaryCardText} style={color ? { color } : undefined}>
              {text}
            </strong>
          </div>
        ))}
      </div>

      {flags.length > 0 && (
        <div className={styles.comparePanel} style={{ marginTop: 24 }}>
          <h4 className={styles.sectionLabel} style={{ marginBottom: 12 }}>Flagged measures</h4>
          {flags.map((f, i) => (
            <div key={i} className={styles.compareRow}>
              <span>m.{f.measure} · {capitalize(f.type)}</span>
              <strong className={styles.compareNeutral}>{f.title}</strong>
            </div>
          ))}
        </div>
      )}

      <button
        className={styles.primaryBtn}
        style={{ alignSelf: 'flex-start', marginTop: 24 }}
        onClick={() => { playPop(); nav('/takes') }}
      >
        View saved takes →
      </button>
    </div>
  )
}
