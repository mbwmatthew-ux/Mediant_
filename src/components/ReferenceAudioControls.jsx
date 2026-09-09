import styles from './ReferenceAudioControls.module.css'

/**
 * Presentational only — no UI polish per this feature's explicit "just needs
 * to be accurate, don't worry about how it looks" scope. Placement within
 * Analysis.jsx is not load-bearing; wherever it's reachable is fine.
 */
export default function ReferenceAudioControls({
  isLoading, error, isPlaying, tempo, onPlayPause, onTempoChange,
}) {
  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.btn} disabled={isLoading} onClick={onPlayPause}>
        {isLoading ? 'Generating…' : isPlaying ? 'Pause reference' : 'Play reference'}
      </button>
      {tempo != null && (
        <label className={styles.tempoLabel}>
          Tempo (BPM)
          <input
            type="number" min="20" max="300" step="1"
            className={styles.tempoInput}
            value={Math.round(tempo)}
            onChange={e => onTempoChange(Number(e.target.value))}
          />
        </label>
      )}
      {error && <span className={styles.error}>{error}</span>}
    </div>
  )
}
