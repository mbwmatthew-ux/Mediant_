import styles from './Skeleton.module.css'

export function Skeleton({ width = '100%', height = 14, radius = 8 }) {
  return <div className={styles.bone} style={{ width, height, borderRadius: radius }} />
}

export function SkeletonCard() {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <Skeleton width="40%" height={12} />
        <Skeleton width="60%" height={20} />
        <Skeleton width="80%" height={12} />
      </div>
      <Skeleton width="100%" height={1} />
      <div className={styles.cardBody}>
        <Skeleton height={12} />
        <Skeleton height={12} />
        <Skeleton width="70%" height={12} />
      </div>
    </div>
  )
}
