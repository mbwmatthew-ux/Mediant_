import { useNavigate } from 'react-router-dom'
import styles from './Page.module.css'

export default function Takes() {
  const nav = useNavigate()
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Saved Takes</p>
          <h1 className={styles.title}>Compare your recordings</h1>
        </div>
        <button className={styles.ghostBtn} onClick={() => nav('/summary')}>View recap</button>
      </div>

      <div className={styles.takesGrid}>
        <div className={`${styles.takeCard} ${styles.takeCardFeatured}`}>
          <p className={styles.label}>Latest take</p>
          <h3 className={styles.resultTitle}>Take 03</h3>
          <p className={styles.resultSub}>Cleaner ending, better dynamic shape, one unstable left-hand entrance.</p>
          <button className={styles.primaryBtn} style={{ marginTop: 16 }} onClick={() => nav('/analysis')}>View score review</button>
        </div>
        <div className={styles.takeCard}>
          <p className={styles.label}>Previous take</p>
          <h3 className={styles.resultTitle}>Take 02</h3>
          <p className={styles.resultSub}>More hesitations in measures 16 and 28, but stronger pulse through the middle.</p>
          <button className={styles.ghostBtn} style={{ marginTop: 16 }}>View score review</button>
        </div>
      </div>

      <div className={styles.comparePanel}>
        <h4 className={styles.sectionLabel} style={{ marginBottom: 12 }}>Take 03 vs Take 02</h4>
        {[
          { metric: 'Timing',     value: 'Improved',       good: true },
          { metric: 'Dynamics',   value: 'More even',      good: true },
          { metric: 'Confidence', value: 'Still building', good: false },
          { metric: 'Phrasing',   value: 'Stronger',       good: true },
        ].map(({ metric, value, good }) => (
          <div key={metric} className={styles.compareRow}>
            <span>{metric}</span>
            <strong className={good ? styles.compareGood : styles.compareNeutral}>{value}</strong>
          </div>
        ))}
      </div>
    </div>
  )
}
