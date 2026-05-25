import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useTakes } from '../hooks/useTakes'
import styles from './Page.module.css'
import pStyles from './ProgressFeedback.module.css'
import { playAnalyzeStart, playToggle, playTick } from '../utils/sounds'

function scoreColor(n) {
  if (n >= 88) return '#8fbe9f'
  if (n >= 74) return 'var(--gold)'
  return 'var(--coral)'
}

function formatDate(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}

function filterTakesByPeriod(takes, period) {
  const now = new Date()
  const cutoff = new Date(now)
  if (period === 'weekly') {
    cutoff.setDate(now.getDate() - 7)
  } else {
    cutoff.setDate(now.getDate() - 30)
  }
  return takes.filter(t => {
    const d = new Date(t.created_at || t.date || 0)
    return d >= cutoff
  })
}

function computeStats(takes) {
  const scored = takes.filter(t => t.score != null)
  const avgScore = scored.length > 0
    ? Math.round(scored.reduce((s, t) => s + t.score, 0) / scored.length)
    : null
  const totalFlags = takes.reduce((s, t) => s + (t.flags?.length ?? 0), 0)
  const pieces = [...new Set(takes.map(t => t.piece_title).filter(Boolean))]
  return { avgScore, totalFlags, pieces }
}

export default function ProgressFeedback() {
  const nav = useNavigate()
  const [period, setPeriod]   = useState('weekly')
  const [feedback, setFeedback] = useState(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)

  const allTakes = useTakes() ?? []

  // Auto-regenerate when period changes if feedback was already shown
  const [prevPeriod, setPrevPeriod] = useState(period)
  useEffect(() => {
    if (period === prevPeriod) return
    setPrevPeriod(period)
    setError(null)
    if (feedback) {
      setFeedback(null)
      generateFeedback()
    } else {
      setFeedback(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period])

  const takes = filterTakesByPeriod(allTakes, period)
  const { avgScore, totalFlags, pieces } = computeStats(takes)
  const periodLabel = period === 'weekly' ? 'week' : 'month'

  async function generateFeedback() {
    setLoading(true)
    setError(null)
    setFeedback(null)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('progress-feedback', {
        body: { period, takes },
      })
      if (fnErr) throw new Error(fnErr.message ?? String(fnErr))
      if (data?.error) throw new Error(data.error)
      setFeedback(data.feedback)
    } catch {
      setError('Could not generate feedback. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Progress Report</p>
          <h1 className={styles.title}>Practice feedback</h1>
        </div>
        <div className={pStyles.periodToggle}>
          <button
            className={`${pStyles.toggleBtn} ${period === 'weekly' ? pStyles.toggleBtnActive : ''}`}
            onClick={() => { playToggle(true); setPeriod('weekly') }}
          >
            This week
          </button>
          <button
            className={`${pStyles.toggleBtn} ${period === 'monthly' ? pStyles.toggleBtnActive : ''}`}
            onClick={() => { playToggle(true); setPeriod('monthly') }}
          >
            This month
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className={styles.metrics}>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{takes.length}</span>
          <span className={styles.metricLabel}>Sessions</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue} style={avgScore != null ? { color: scoreColor(avgScore) } : {}}>
            {avgScore != null ? avgScore : '—'}
          </span>
          <span className={styles.metricLabel}>Avg score</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{pieces.length}</span>
          <span className={styles.metricLabel}>Pieces</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{totalFlags}</span>
          <span className={styles.metricLabel}>Total flags</span>
        </div>
      </div>

      {/* Sessions list */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionHeaderTitle}>
            Sessions this {periodLabel}
          </span>
          <button className={styles.sectionHeaderAction} onClick={() => { playTick(); nav('/takes') }}>
            View all →
          </button>
        </div>

        {takes.length === 0 ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyStateTitle}>No sessions this {periodLabel}</p>
            <p className={styles.emptyStateSub}>
              Upload a practice recording to start tracking your progress.
            </p>
            <button className={styles.primaryBtn} onClick={() => nav('/record')}>
              Upload a recording →
            </button>
          </div>
        ) : (
          <div className={pStyles.sessionTable}>
            {takes.map((t, i) => (
              <div key={t.id || i} className={pStyles.sessionRow}>
                <div className={pStyles.sessionInfo}>
                  <span className={pStyles.sessionPiece}>{t.piece_title || 'Untitled'}</span>
                  <span className={pStyles.sessionMeta}>
                    {[t.piece_composer, t.instrument, formatDate(t.created_at || t.date)].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <div className={pStyles.sessionRight}>
                  {t.score != null && (
                    <span className={pStyles.sessionScore} style={{ color: scoreColor(t.score) }}>
                      {t.score}
                    </span>
                  )}
                  {t.flags?.length > 0 && (
                    <span className={pStyles.sessionFlags}>{t.flags.length} flags</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Generate button */}
      {takes.length > 0 && !feedback && (
        <div className={pStyles.generateRow}>
          <button
            className={styles.primaryBtn}
            onClick={() => { playAnalyzeStart(); generateFeedback() }}
            disabled={loading}
          >
            {loading ? 'Generating…' : `Generate ${periodLabel}ly feedback`}
          </button>
          <p className={pStyles.generateHint}>
            Mediant will analyse your {takes.length} session{takes.length !== 1 ? 's' : ''} and give you personalised insights.
          </p>
        </div>
      )}

      {error && (
        <div className={styles.errorBanner}>
          <span>⚠</span>
          <span>{error}</span>
          <button className={styles.errorRetry} onClick={generateFeedback}>Retry</button>
        </div>
      )}

      {/* Feedback card */}
      {feedback && (
        <div className={pStyles.feedbackCard}>
          <div className={pStyles.feedbackCardHeader}>
            <p className={styles.label}>{period === 'weekly' ? 'Weekly' : 'Monthly'} review</p>
            <button
              className={styles.ghostBtn}
              style={{ fontSize: '0.78rem', padding: '5px 12px' }}
              onClick={generateFeedback}
              disabled={loading}
            >
              {loading ? '…' : 'Regenerate'}
            </button>
          </div>

          <h2 className={pStyles.feedbackHeadline}>{feedback.headline}</h2>

          <p className={pStyles.feedbackOverview}>{feedback.overview}</p>

          {feedback.strengths?.length > 0 && (
            <div className={pStyles.feedbackSection}>
              <p className={pStyles.feedbackSectionTitle}>
                <span className={pStyles.iconGreen}>✓</span> Strengths
              </p>
              <ul className={pStyles.feedbackList}>
                {feedback.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          {feedback.patterns?.length > 0 && (
            <div className={pStyles.feedbackSection}>
              <p className={pStyles.feedbackSectionTitle}>
                <span className={pStyles.iconGold}>↺</span> Patterns to watch
              </p>
              <ul className={pStyles.feedbackList}>
                {feedback.patterns.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}

          {feedback.nextSteps?.length > 0 && (
            <div className={pStyles.feedbackSection}>
              <p className={pStyles.feedbackSectionTitle}>
                <span className={pStyles.iconBlue}>→</span> Goals for next {periodLabel}
              </p>
              <ul className={pStyles.feedbackList}>
                {feedback.nextSteps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
