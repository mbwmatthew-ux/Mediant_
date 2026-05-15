import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as Vex from 'vexflow'
import styles from './Page.module.css'

const FLAGS = {
  timing: {
    tag: 'Measure 16 · Timing',
    title: 'Left hand enters early',
    body: 'The left hand arrives just ahead of the beat here. Slow this entrance down and count aloud before bringing it back up to tempo. Try isolating the left hand through measures 14–17 until the arrival feels natural and unhurried.',
  },
  dynamics: {
    tag: 'Measure 28 · Dynamics',
    title: 'Phrase settles too early',
    body: 'The dynamic line softens before the phrase actually ends. Keep the line moving through the final note — the resolution should arrive at the cadence, not before it. Think of this as a long exhale, not a quick release.',
  },
  voicing: {
    tag: 'Measure 33 · Voicing',
    title: 'Inner voices too prominent',
    body: 'The middle voices are slightly louder than the melody, which blurs the harmonic texture. Bring the top line forward and let the inner voices recede — try exaggerated melody weight until the balance becomes instinctive.',
  },
}

const ISSUE_CHIPS = [
  { flag: 'timing',   label: 'm.16 · Timing' },
  { flag: 'dynamics', label: 'm.28 · Dynamics' },
  { flag: 'voicing',  label: 'm.33 · Voicing' },
]

export default function Analysis() {
  const nav = useNavigate()
  const scoreEl = useRef(null)
  const [activeFlag, setActiveFlag] = useState(null)
  const initialized = useRef(false)

  useEffect(() => {
    if (initialized.current || !scoreEl.current) return
    initialized.current = true
    renderScore(scoreEl.current, setActiveFlag)
  }, [])

  const info = activeFlag ? FLAGS[activeFlag] : null

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Score Review</p>
          <h1 className={styles.reviewTitle}>Clair de Lune</h1>
          <p className={styles.sub}>Claude Debussy · Solo Piano · 3 issues found</p>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.ghostBtn} onClick={() => nav('/record')}>Re-upload</button>
          <button className={styles.primaryBtn} onClick={() => nav('/follow')}>Follow Along ▶</button>
        </div>
      </div>

      <div className={styles.issueStrip}>
        <span className={styles.issueStripLabel}>Issues:</span>
        {ISSUE_CHIPS.map(({ flag, label }) => (
          <button
            key={flag}
            className={`${styles.issueChip} ${activeFlag === flag ? styles.issueChipActive : ''}`}
            onClick={() => setActiveFlag(activeFlag === flag ? null : flag)}
          >
            {label}
          </button>
        ))}
        <span className={styles.issueStripHint}>Click a highlighted measure or issue to read feedback.</span>
      </div>

      <div className={styles.reviewBody}>
        <div className={styles.scoreArea}>
          <div ref={scoreEl} id="vf-score" />
        </div>

        <aside className={styles.feedbackSidebar}>
          {!info ? (
            <div className={styles.feedbackIdle}>
              <span className={styles.feedbackIdleIcon}>♩</span>
              <p>Click a highlighted measure in the score, or one of the issue chips above, to read coaching feedback.</p>
            </div>
          ) : (
            <div className={styles.feedbackDetail}>
              <p className={styles.detailTag}>{info.tag}</p>
              <h3 className={styles.detailTitle}>{info.title}</h3>
              <p className={styles.detailBody}>{info.body}</p>
              <button className={styles.loopBtn} onClick={() => nav('/follow')}>Loop this section</button>
              <button className={styles.dismissBtn} onClick={() => setActiveFlag(null)}>Dismiss</button>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

// ── VexFlow score renderer ─────────────────────────────────

function renderScore(el, setActiveFlag) {
  const { Renderer, Stave, StaveNote, Voice, Formatter } = Vex

  const W = Math.max(el.clientWidth, 480)
  const ROW_H = 120
  const H = ROW_H * 4 + 48
  const MARGIN = 22
  const INNER_W = W - MARGIN * 2
  const PER_ROW = 4
  const PREAMBLE = 108
  const BASE_W = (INNER_W - PREAMBLE) / PER_ROW
  const FIRST_W = BASE_W + PREAMBLE

  const renderer = new Renderer(el, Renderer.Backends.SVG)
  renderer.resize(W, H)
  const ctx = renderer.getContext()

  const measureDefs = [
    { num: 12, flag: null,       notes: [['db/5'], ['f/5'],  ['ab/5']] },
    { num: 13, flag: null,       notes: [['bb/5'], ['ab/5'], ['gb/5']] },
    { num: 14, flag: null,       notes: [['f/5'],  ['eb/5'], ['db/5']] },
    { num: 15, flag: null,       notes: [['c/5'],  ['bb/4'], ['ab/4']] },
    { num: 16, flag: 'timing',   notes: [['ab/4'], ['gb/4'], ['f/4']]  },
    { num: 17, flag: null,       notes: [['eb/4'], ['f/4'],  ['gb/4']] },
    { num: 18, flag: null,       notes: [['ab/4'], ['bb/4'], ['c/5']]  },
    { num: 19, flag: null,       notes: [['db/5'], ['eb/5'], ['f/5']]  },
    { num: 28, flag: 'dynamics', notes: [['db/5'], ['c/5'],  ['bb/4']] },
    { num: 29, flag: null,       notes: [['ab/4'], ['gb/4'], ['f/4']]  },
    { num: 30, flag: null,       notes: [['eb/4'], ['f/4'],  ['gb/4']] },
    { num: 31, flag: null,       notes: [['ab/4'], ['bb/4'], ['c/5']]  },
    { num: 33, flag: 'voicing',  notes: [['db/5'], ['eb/5'], ['f/5']]  },
    { num: 34, flag: null,       notes: [['gb/5'], ['f/5'],  ['eb/5']] },
    { num: 35, flag: null,       notes: [['db/5'], ['c/5'],  ['bb/4']] },
    { num: 36, flag: null,       notes: [['ab/4', 'db/5', 'f/5']]     },
  ]

  const svg = el.querySelector('svg')

  measureDefs.forEach((m, i) => {
    const row = Math.floor(i / PER_ROW)
    const col = i % PER_ROW
    const isFirst = col === 0
    const isVeryFirst = i === 0

    const x = MARGIN + (isFirst ? 0 : PREAMBLE + col * BASE_W)
    const y = 28 + row * ROW_H
    const w = isFirst ? FIRST_W : BASE_W

    const stave = new Stave(x, y, w)
    if (isFirst) {
      stave.addClef('treble').addKeySignature('Db')
      if (isVeryFirst) stave.addTimeSignature('3/4')
    }
    stave.setContext(ctx).draw()

    if (svg) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      label.setAttribute('x', String(x + 4))
      label.setAttribute('y', String(y - 6))
      label.setAttribute('font-size', '10')
      label.setAttribute('font-family', 'Avenir Next, Inter, sans-serif')
      label.setAttribute('fill', '#879484')
      label.textContent = `m.${m.num}`
      svg.appendChild(label)
    }

    let voice
    if (m.notes.length === 1 && m.notes[0].length > 1) {
      const chord = new StaveNote({ clef: 'treble', keys: m.notes[0], duration: 'h.' })
      voice = new Voice({ num_beats: 3, beat_value: 4 })
      voice.setStrict(false)
      voice.addTickables([chord])
    } else {
      const staveNotes = m.notes.map(keys => new StaveNote({ clef: 'treble', keys, duration: 'q' }))
      voice = new Voice({ num_beats: 3, beat_value: 4 })
      voice.addTickables(staveNotes)
    }

    const noteWidth = stave.getEndX() - stave.getNoteStartX() - 8
    new Formatter().joinVoices([voice]).format([voice], noteWidth)
    voice.draw(ctx, stave)

    if (m.flag && svg) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', String(x + 1))
      rect.setAttribute('y', String(y - 10))
      rect.setAttribute('width', String(w - 2))
      rect.setAttribute('height', '88')
      rect.setAttribute('rx', '8')
      rect.setAttribute('fill', 'rgba(225, 134, 118, 0.09)')
      rect.setAttribute('stroke', 'rgba(225, 134, 118, 0.5)')
      rect.setAttribute('stroke-width', '1.5')
      rect.setAttribute('data-flag', m.flag)
      rect.style.cursor = 'pointer'
      svg.appendChild(rect)

      rect.addEventListener('click', () => setActiveFlag(f => f === m.flag ? null : m.flag))
    }
  })
}
