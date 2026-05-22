import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import styles from './Page.module.css'
import logStyles from './PracticeLog.module.css'

function today() {
  return new Date().toISOString().slice(0, 10)
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function hoursThisWeek(logs) {
  const now = new Date()
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
  monday.setHours(0, 0, 0, 0)
  return logs
    .filter(l => new Date(l.date + 'T00:00:00') >= monday)
    .reduce((sum, l) => sum + parseFloat(l.hours), 0)
}

export default function PracticeLog() {
  const { user } = useAuth()
  const [logs, setLogs]       = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState(null)

  const [date, setDate]   = useState(today())
  const [hours, setHours] = useState('1')
  const [note, setNote]   = useState('')

  useEffect(() => {
    if (!user) return
    fetchLogs()
  }, [user])

  async function fetchLogs() {
    setLoading(true)
    const { data, error } = await supabase
      .from('practice_logs')
      .select('*')
      .order('date', { ascending: false })
    if (!error) setLogs(data ?? [])
    setLoading(false)
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!date || !hours) return
    setSaving(true)
    setError(null)
    const { error } = await supabase.from('practice_logs').insert({
      user_id: user.id,
      date,
      hours: parseFloat(hours),
      note: note.trim(),
    })
    if (error) {
      setError('Could not save entry. Please try again.')
    } else {
      setNote('')
      setHours('1')
      setDate(today())
      await fetchLogs()
    }
    setSaving(false)
  }

  async function handleDelete(id) {
    await supabase.from('practice_logs').delete().eq('id', id)
    setLogs(prev => prev.filter(l => l.id !== id))
  }

  const weekHours = hoursThisWeek(logs)
  const totalHours = logs.reduce((sum, l) => sum + parseFloat(l.hours), 0)

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Practice Log</p>
          <h1 className={styles.title}>Your practice journal</h1>
        </div>
      </div>

      {/* Stats */}
      <div className={styles.metrics}>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{weekHours % 1 === 0 ? weekHours : weekHours.toFixed(1)}</span>
          <span className={styles.metricLabel}>hours this week</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{totalHours % 1 === 0 ? totalHours : totalHours.toFixed(1)}</span>
          <span className={styles.metricLabel}>hours total</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{logs.length}</span>
          <span className={styles.metricLabel}>sessions logged</span>
        </div>
      </div>

      {/* New entry form */}
      <div className={logStyles.formCard}>
        <p className={logStyles.formTitle}>Log a session</p>
        <form onSubmit={handleSave} className={logStyles.form}>
          <div className={logStyles.formRow}>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Date</label>
              <input
                type="date"
                className={`${styles.formInput} ${logStyles.dateInput}`}
                value={date}
                max={today()}
                onChange={e => setDate(e.target.value)}
                required
              />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Hours practiced</label>
              <input
                type="number"
                className={styles.formInput}
                value={hours}
                min="0.25"
                max="24"
                step="0.25"
                placeholder="1.5"
                onChange={e => setHours(e.target.value)}
                required
              />
            </div>
          </div>

          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Notes <span className={styles.formOptional}>(optional)</span></label>
            <textarea
              className={logStyles.noteInput}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="What did you work on? Any breakthroughs or challenges?"
              rows={3}
            />
          </div>

          {error && <p className={logStyles.errorText}>{error}</p>}

          <button
            type="submit"
            className={styles.primaryBtn}
            disabled={saving || !date || !hours}
          >
            {saving ? 'Saving…' : 'Save entry'}
          </button>
        </form>
      </div>

      {/* Log list */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionHeaderTitle}>Past sessions</span>
        </div>

        {loading ? (
          <div className={logStyles.emptyState}>
            <p className={styles.sub}>Loading…</p>
          </div>
        ) : logs.length === 0 ? (
          <div className={logStyles.emptyState}>
            <span className={logStyles.emptyIcon}>♩</span>
            <p className={logStyles.emptyTitle}>No sessions logged yet</p>
            <p className={styles.sub}>Add your first entry above to start tracking your practice.</p>
          </div>
        ) : (
          <div className={logStyles.logList}>
            {logs.map(log => (
              <div key={log.id} className={logStyles.logRow}>
                <div className={logStyles.logLeft}>
                  <span className={logStyles.logDate}>{fmtDate(log.date)}</span>
                  {log.note ? (
                    <p className={logStyles.logNote}>{log.note}</p>
                  ) : (
                    <p className={logStyles.logNoteMuted}>No notes</p>
                  )}
                </div>
                <div className={logStyles.logRight}>
                  <span className={logStyles.hoursBadge}>
                    {parseFloat(log.hours) % 1 === 0
                      ? parseFloat(log.hours)
                      : parseFloat(log.hours).toFixed(2).replace(/\.?0+$/, '')}h
                  </span>
                  <button
                    className={logStyles.deleteBtn}
                    onClick={() => handleDelete(log.id)}
                    title="Delete entry"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
