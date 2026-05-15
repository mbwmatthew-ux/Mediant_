import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './Page.module.css'

const PIECES = [
  { id:  1, instrument: 'Piano',  era: 'Romantic',  difficulty: 'Advanced',     title: 'Clair de Lune',             composer: 'Claude Debussy',        key: 'D♭ major', time: '9/8',  scoreReady: true  },
  { id:  2, instrument: 'Piano',  era: 'Baroque',   difficulty: 'Intermediate', title: 'Invention No. 8',           composer: 'J.S. Bach',             key: 'F major',  time: '3/4',  scoreReady: true  },
  { id:  3, instrument: 'Voice',  era: 'Classical', difficulty: 'Beginner',     title: 'Caro Mio Ben',              composer: 'Tommaso Giordani',      key: 'G major',  time: '4/4',  scoreReady: true  },
  { id:  4, instrument: 'Piano',  era: 'Romantic',  difficulty: 'Advanced',     title: 'Moonlight Sonata',          composer: 'Ludwig van Beethoven',  key: 'C♯ minor', time: '4/4',  scoreReady: true  },
  { id:  5, instrument: 'Violin', era: 'Baroque',   difficulty: 'Advanced',     title: 'Partita No. 2 in D minor',  composer: 'J.S. Bach',             key: 'D minor',  time: '4/4',  scoreReady: false },
  { id:  6, instrument: 'Piano',  era: 'Modern',    difficulty: 'Beginner',     title: 'Gymnopédie No. 1',          composer: 'Erik Satie',            key: 'G major',  time: '3/4',  scoreReady: true  },
  { id:  7, instrument: 'Piano',  era: 'Classical', difficulty: 'Intermediate', title: 'Sonata K. 331',             composer: 'Wolfgang A. Mozart',    key: 'A major',  time: '6/8',  scoreReady: false },
  { id:  8, instrument: 'Violin', era: 'Romantic',  difficulty: 'Intermediate', title: 'Meditation from Thaïs',     composer: 'Jules Massenet',        key: 'D major',  time: '4/4',  scoreReady: true  },
  { id:  9, instrument: 'Piano',  era: 'Romantic',  difficulty: 'Advanced',     title: 'Ballade No. 1',             composer: 'Frédéric Chopin',       key: 'G minor',  time: '6/4',  scoreReady: true  },
  { id: 10, instrument: 'Voice',  era: 'Classical', difficulty: 'Intermediate', title: 'Nessun Dorma',              composer: 'Giacomo Puccini',       key: 'B♭ major', time: '4/4',  scoreReady: false },
  { id: 11, instrument: 'Piano',  era: 'Baroque',   difficulty: 'Beginner',     title: 'Minuet in G',               composer: 'J.S. Bach',             key: 'G major',  time: '3/4',  scoreReady: true  },
  { id: 12, instrument: 'Violin', era: 'Modern',    difficulty: 'Advanced',     title: 'Violin Sonata No. 1',       composer: 'Béla Bartók',           key: 'Atonal',   time: '4/4',  scoreReady: false },
]

const INSTRUMENT_FILTERS = ['All', 'Piano', 'Voice', 'Violin']
const ERA_FILTERS         = ['All eras', 'Baroque', 'Classical', 'Romantic', 'Modern']
const DIFFICULTY_FILTERS  = ['Any level', 'Beginner', 'Intermediate', 'Advanced']

const difficultyColor = { Beginner: 'green', Intermediate: 'gold', Advanced: 'coral' }

export default function Search() {
  const nav = useNavigate()
  const [query, setQuery] = useState('')
  const [instrument, setInstrument] = useState('All')
  const [era, setEra] = useState('All eras')
  const [difficulty, setDifficulty] = useState('Any level')

  const results = PIECES.filter(p => {
    if (query) {
      const q = query.toLowerCase()
      if (!p.title.toLowerCase().includes(q) &&
          !p.composer.toLowerCase().includes(q) &&
          !p.instrument.toLowerCase().includes(q)) return false
    }
    if (instrument !== 'All' && p.instrument !== instrument) return false
    if (era !== 'All eras' && p.era !== era) return false
    if (difficulty !== 'Any level' && p.difficulty !== difficulty) return false
    return true
  })

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Library</p>
          <h1 className={styles.title}>Find your piece</h1>
          <p className={styles.sub}>{PIECES.length} pieces available with score matching</p>
        </div>
      </div>

      <input
        className={styles.searchInput}
        type="text"
        placeholder="Search by title, composer, or instrument…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        autoFocus
      />

      {/* Filter strips */}
      <div className={styles.filterGroup}>
        <div className={styles.filterStrip}>
          {INSTRUMENT_FILTERS.map(f => (
            <button
              key={f}
              className={`${styles.filterChip} ${instrument === f ? styles.filterChipActive : ''}`}
              onClick={() => setInstrument(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <div className={styles.filterStrip}>
          {ERA_FILTERS.map(f => (
            <button
              key={f}
              className={`${styles.filterChip} ${era === f ? styles.filterChipActive : ''}`}
              onClick={() => setEra(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <div className={styles.filterStrip}>
          {DIFFICULTY_FILTERS.map(f => (
            <button
              key={f}
              className={`${styles.filterChip} ${difficulty === f ? styles.filterChipActive : ''}`}
              onClick={() => setDifficulty(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {results.length === 0 ? (
        <p className={styles.emptyState}>No pieces match your filters. Try broadening your search.</p>
      ) : (
        <>
          <p className={styles.resultCount}>{results.length} result{results.length !== 1 ? 's' : ''}</p>
          <div className={styles.resultGrid}>
            {results.map(p => (
              <button
                key={p.id}
                className={styles.resultCard}
                onClick={() => nav('/record')}
              >
                <div className={styles.resultCardTop}>
                  <span className={`${styles.diffBadge} ${styles[difficultyColor[p.difficulty]]}`}>
                    {p.difficulty}
                  </span>
                  {p.scoreReady && (
                    <span className={styles.scoreReadyBadge}>Score ready</span>
                  )}
                </div>
                <h3 className={styles.resultTitle}>{p.title}</h3>
                <p className={styles.resultComposer}>{p.composer}</p>
                <div className={styles.resultMeta}>
                  <span>{p.instrument}</span>
                  <span>·</span>
                  <span>{p.era}</span>
                  <span>·</span>
                  <span>{p.key}</span>
                  <span>·</span>
                  <span>{p.time}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
