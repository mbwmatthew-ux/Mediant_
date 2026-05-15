import { useNavigate } from 'react-router-dom'
import styles from './Page.module.css'

export default function Summary() {
  const nav = useNavigate()
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Session Summary</p>
          <h1 className={styles.title}>Constructive recap</h1>
        </div>
        <button className={styles.ghostBtn} onClick={() => nav('/analysis')}>← Back to score</button>
      </div>

      <div className={styles.summaryLead}>
        <p className={styles.label}>Overall sound</p>
        <h2 className={styles.summaryLeadTitle}>Expressive and controlled, with a few unstable transitions.</h2>
        <p className={styles.sub}>Feedback is meant to feel like a strong teacher: clear, respectful, and practical.</p>
      </div>

      <div className={styles.summaryGrid}>
        {[
          { label: 'Biggest takeaway', text: 'Rhythm separation between hands in measure 16 needs attention.' },
          { label: 'Strongest moment', text: 'The ending cadence feels balanced and musically convincing.' },
          { label: 'Next practice goal', text: 'Loop flagged passages slowly, then return to full phrase context.' },
          { label: 'Session length', text: '2 takes · 14 minutes of practice today.' },
        ].map(({ label, text }) => (
          <div key={label} className={styles.summaryCard}>
            <p className={styles.label}>{label}</p>
            <strong className={styles.summaryCardText}>{text}</strong>
          </div>
        ))}
      </div>

      <button className={styles.primaryBtn} style={{ alignSelf: 'flex-start', marginTop: 8 }} onClick={() => nav('/takes')}>
        View saved takes →
      </button>
    </div>
  )
}
