import { useEffect, useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import styles from './Landing.module.css'

const ROTATING_LINES = [
  { we: 'elevate', you: 'create',  color: '#a58fe8' },
  { we: 'listen',  you: 'perform', color: '#e18676' },
  { we: 'analyze', you: 'refine',  color: '#d6b168' },
  { we: 'map',     you: 'improve', color: '#5cb86b' },
  { we: 'guide',   you: 'grow',    color: '#5cb86b' },
]

const FEATURES = [
  {
    icon: ScoreIcon,
    num: '01',
    title: 'Score-aware analysis',
    body: 'Every flag is tied to a specific measure and beat — not a vague average. Mediant reads the sheet music, not just the audio.',
  },
  {
    icon: CoachIcon,
    num: '02',
    title: 'Coaching, not just corrections',
    body: 'Every note you play has context — the phrase it belongs to, the style it\'s drawn from, the habit behind it. Mediant addresses all three.',
  },
  {
    icon: ProgressIcon,
    num: '03',
    title: 'Session history',
    body: 'Track exactly which passages improved across every take. See where your practice is paying off.',
  },
]

const STEPS = [
  { num: '01', title: 'Upload your recording', body: 'Drop in a video or audio file from your practice session.' },
  { num: '02', title: 'Maps it to the score',  body: 'Mediant aligns every note to your sheet music, measure by measure.' },
  { num: '03', title: 'Get targeted feedback', body: 'Click any flagged measure for specific, actionable feedback.' },
]

const STATS = [
  { value: 40,  suffix: '+', label: 'Instruments supported' },
  { value: 6,   suffix:  '', label: 'Types of feedback' },
  { value: 100, suffix: '%', label: 'Your recordings stay private' },
]

/* ── Instrument helpers ── */
const NOTES = ['♩', '♪', '♫', '♬']

function useInView(threshold = 0.12) {
  const ref = useRef(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true) },
      { threshold }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [threshold])
  return [ref, inView]
}

/* Music notes drifting upward from the instrument's sound origin */
function BellNotes({ count = 5, color = '#5cb86b', fromBottom = true, topPct }) {
  const posStyle = fromBottom
    ? {}
    : { top: topPct != null ? `${topPct}%` : '40%', bottom: 'auto' }
  return (
    <div className={styles.bellNotes} aria-hidden style={posStyle}>
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={styles.bellNote}
          style={{
            '--nd': `${i * 0.85}s`,
            '--nx': `${-22 + (i * 14) % 48}px`,
            '--ndur': `${2.8 + (i % 3) * 0.7}s`,
            color,
            fontSize: `${0.9 + (i % 3) * 0.22}rem`,
          }}
        >
          {NOTES[i % NOTES.length]}
        </span>
      ))}
    </div>
  )
}

/* Google-Docs-style typing indicator — simple left-border box */
function DocTyping({ text, color, active, delay = 0 }) {
  const [displayed, setDisplayed] = useState('')
  const [phase, setPhase]         = useState('idle')
  const timerRef = useRef(null)

  const pauseAt = Math.floor(text.length * 0.65)
  const minLen  = Math.floor(text.length * 0.50)

  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => { setDisplayed(''); setPhase('forward') }, delay)
    return () => clearTimeout(t)
  }, [active, delay])

  useEffect(() => {
    clearTimeout(timerRef.current)
    if (phase === 'idle' || phase === 'done') return

    if (phase === 'forward') {
      if (displayed.length < pauseAt) {
        timerRef.current = setTimeout(
          () => setDisplayed(text.slice(0, displayed.length + 1)),
          95 + Math.random() * 55
        )
      } else {
        timerRef.current = setTimeout(() => setPhase('deleting'), 750)
      }
    } else if (phase === 'deleting') {
      if (displayed.length > minLen) {
        timerRef.current = setTimeout(
          () => setDisplayed(text.slice(0, displayed.length - 1)),
          58 + Math.random() * 30
        )
      } else {
        timerRef.current = setTimeout(() => setPhase('finishing'), 480)
      }
    } else if (phase === 'finishing') {
      if (displayed.length < text.length) {
        timerRef.current = setTimeout(
          () => setDisplayed(text.slice(0, displayed.length + 1)),
          82 + Math.random() * 48
        )
      } else {
        setPhase('done')
      }
    }

    return () => clearTimeout(timerRef.current)
  }, [phase, displayed, text, pauseAt, minLen])

  const isTyping = phase === 'forward' || phase === 'deleting' || phase === 'finishing'

  return (
    <div className={styles.docTyping} style={{ '--cc': color }}>
      <p className={styles.docText}>
        {displayed}
        {phase !== 'idle' && (
          <span className={styles.docCaret} style={{ '--cc': color }}>
            {isTyping && (
              <span className={styles.docCaretLabel} style={{ background: color }}>Mediant</span>
            )}
          </span>
        )}
      </p>
    </div>
  )
}

/* ── Clarinet SVG — wireframe outline style ── */
function ClarinetSVG() {
  const s  = 'rgba(205, 162, 88, 0.88)'    // main amber stroke
  const sd = 'rgba(205, 162, 88, 0.45)'    // dim amber
  const sf = 'rgba(205, 162, 88, 0.22)'    // faint amber fill tint
  return (
    <svg viewBox="0 0 90 480" fill="none" xmlns="http://www.w3.org/2000/svg"
         style={{ height: 380, width: 'auto' }}>

      {/* ── Mouthpiece ── */}
      <path d="M38 4 L52 4 L54 12 L52 36 L38 36 L36 12 Z"
            fill={sf} stroke={s} strokeWidth="1.3" strokeLinejoin="round"/>
      {/* Beak tip */}
      <path d="M38 4 L52 4 L53 8 L37 8 Z" fill="none" stroke={s} strokeWidth="0.9"/>
      {/* Reed slot line */}
      <line x1="45" y1="6" x2="45" y2="34" stroke={sd} strokeWidth="0.7"/>
      {/* Window opening */}
      <rect x="39" y="10" width="12" height="18" rx="1" fill="none" stroke={sd} strokeWidth="0.8"/>

      {/* ── Ligature (two bands) ── */}
      <rect x="36" y="15" width="18" height="3.5" rx="1.5" fill={sf} stroke={s} strokeWidth="1.1"/>
      <rect x="36" y="23" width="18" height="3.5" rx="1.5" fill={sf} stroke={s} strokeWidth="1.1"/>
      {/* Ligature screws */}
      <circle cx="40" cy="16.75" r="1.4" fill={s}/>
      <circle cx="50" cy="16.75" r="1.4" fill={s}/>
      <circle cx="40" cy="24.75" r="1.4" fill={s}/>
      <circle cx="50" cy="24.75" r="1.4" fill={s}/>

      {/* ── Barrel ── */}
      <rect x="37" y="38" width="16" height="34" rx="3" fill={sf} stroke={s} strokeWidth="1.3"/>
      {/* Barrel end rings */}
      <line x1="37" y1="43" x2="53" y2="43" stroke={sd} strokeWidth="0.8"/>
      <line x1="37" y1="68" x2="53" y2="68" stroke={sd} strokeWidth="0.8"/>

      {/* ── Upper joint ── */}
      <rect x="37" y="74" width="16" height="148" rx="2" fill={sf} stroke={s} strokeWidth="1.3"/>
      <line x1="37" y1="78" x2="53" y2="78" stroke={sd} strokeWidth="0.7"/>

      {/* Speaker / register key — side arm */}
      <path d="M37 90 L24 86 L20 90 L24 94 L37 92 Z" fill={sf} stroke={s} strokeWidth="1"/>
      <circle cx="19" cy="90" r="5.5" fill="none" stroke={s} strokeWidth="1.1"/>
      <circle cx="19" cy="90" r="2.8" fill="none" stroke={sd} strokeWidth="0.7"/>
      <circle cx="19" cy="90" r="1" fill={s}/>

      {/* Left-hand tone holes (3) */}
      {[108, 132, 158].map(y => (
        <g key={y}>
          {/* Hole ring */}
          <circle cx="45" cy={y} r="7" fill="none" stroke={s} strokeWidth="1.2"/>
          {/* Pad cup inner */}
          <circle cx="45" cy={y} r="4.5" fill="none" stroke={sd} strokeWidth="0.8"/>
          <circle cx="45" cy={y} r="1.8" fill={sf} stroke={sd} strokeWidth="0.6"/>
        </g>
      ))}

      {/* Left side trill keys — two small levers to the right */}
      {[112, 128].map((y, i) => (
        <g key={i}>
          <path d={`M53 ${y} C60 ${y-3} 66 ${y-1} 68 ${y+3}`}
                fill="none" stroke={s} strokeWidth="1"/>
          <ellipse cx="68" cy={y+4} rx="4" ry="3" fill="none" stroke={s} strokeWidth="1"/>
          <ellipse cx="68" cy={y+4} rx="2.2" ry="1.6" fill="none" stroke={sd} strokeWidth="0.6"/>
        </g>
      ))}

      {/* Left pinky keys — cluster of levers */}
      <path d="M53 174 L66 170 L68 176 L55 180 Z" fill={sf} stroke={s} strokeWidth="1"/>
      <path d="M53 182 L66 178 L68 184 L55 188 Z" fill={sf} stroke={s} strokeWidth="1"/>
      <path d="M53 190 L64 187 L65 193 L54 195 Z" fill={sf} stroke={s} strokeWidth="1"/>

      {/* Ring keys on upper joint body */}
      {[108, 132, 158].map(y => (
        <g key={`rk-${y}`}>
          <path d={`M37 ${y-4} L28 ${y-6} L26 ${y} L28 ${y+5} L37 ${y+4}`}
                fill="none" stroke={sd} strokeWidth="0.8"/>
        </g>
      ))}

      {/* ── Joint socket ring ── */}
      <rect x="35" y="223" width="20" height="9" rx="2"
            fill={sf} stroke={s} strokeWidth="1.3"/>
      <line x1="35" y1="228" x2="55" y2="228" stroke={sd} strokeWidth="0.6"/>

      {/* ── Lower joint ── */}
      <rect x="37" y="234" width="16" height="128" rx="2" fill={sf} stroke={s} strokeWidth="1.3"/>
      <line x1="37" y1="238" x2="53" y2="238" stroke={sd} strokeWidth="0.7"/>

      {/* Right-hand tone holes (3) */}
      {[254, 278, 304].map(y => (
        <g key={y}>
          <circle cx="45" cy={y} r="7" fill="none" stroke={s} strokeWidth="1.2"/>
          <circle cx="45" cy={y} r="4.5" fill="none" stroke={sd} strokeWidth="0.8"/>
          <circle cx="45" cy={y} r="1.8" fill={sf} stroke={sd} strokeWidth="0.6"/>
        </g>
      ))}

      {/* Right trill keys */}
      {[258, 274].map((y, i) => (
        <g key={i}>
          <path d={`M53 ${y} C60 ${y-3} 66 ${y-1} 68 ${y+3}`}
                fill="none" stroke={s} strokeWidth="1"/>
          <ellipse cx="68" cy={y+4} rx="4" ry="3" fill="none" stroke={s} strokeWidth="1"/>
          <ellipse cx="68" cy={y+4} rx="2.2" ry="1.6" fill="none" stroke={sd} strokeWidth="0.6"/>
        </g>
      ))}

      {/* Right pinky cluster */}
      <path d="M53 312 L67 308 L69 314 L55 318 Z" fill={sf} stroke={s} strokeWidth="1"/>
      <path d="M53 321 L67 317 L69 323 L55 327 Z" fill={sf} stroke={s} strokeWidth="1"/>

      {/* Right ring keys */}
      {[254, 278, 304].map(y => (
        <g key={`rkr-${y}`}>
          <path d={`M37 ${y-4} L28 ${y-6} L26 ${y} L28 ${y+5} L37 ${y+4}`}
                fill="none" stroke={sd} strokeWidth="0.8"/>
        </g>
      ))}

      {/* Thumb rest */}
      <path d="M37 290 L28 288 L26 296 L35 298 Z" fill={sf} stroke={s} strokeWidth="1"/>

      {/* ── Bell socket ── */}
      <rect x="35" y="363" width="20" height="9" rx="2"
            fill={sf} stroke={s} strokeWidth="1.3"/>

      {/* ── Bell body ── */}
      <path d="M37 374 Q32 398 18 422 Q14 430 12 436 L78 436 Q76 430 72 422 Q58 398 53 374 Z"
            fill={sf} stroke={s} strokeWidth="1.3"/>
      {/* Bell inner curves */}
      <path d="M40 378 Q36 400 24 422" fill="none" stroke={sd} strokeWidth="0.8"/>
      <path d="M50 378 Q54 400 66 422" fill="none" stroke={sd} strokeWidth="0.8"/>
      {/* Bell rim outer */}
      <ellipse cx="45" cy="436" rx="33" ry="9.5" fill="none" stroke={s} strokeWidth="1.3"/>
      {/* Bell rim inner */}
      <ellipse cx="45" cy="436" rx="25" ry="6.5" fill="none" stroke={sd} strokeWidth="0.9"/>
    </svg>
  )
}

/* ── Cello SVG — dark-body style ── */
function CelloSVG() {
  const bd = 'rgba(16, 10, 6, 0.94)'       // body fill
  const s  = 'rgba(220, 210, 195, 0.52)'   // main stroke (warm white)
  const sf = 'rgba(28, 18, 10, 0.82)'      // body surface fill
  const gs = 'rgba(214, 177, 104, 0.75)'   // gold (bow / bridge)
  const fs = 'rgba(220, 210, 195, 0.55)'   // f-hole stroke
  return (
    <svg viewBox="0 0 160 500" fill="none" xmlns="http://www.w3.org/2000/svg"
         style={{ height: 340, width: 'auto', filter: 'drop-shadow(0 0 22px rgba(220,210,195,0.07))' }}>

      {/* Scroll */}
      <path d="M73 14 C73 8 78 4 83 6 C89 8 90 14 86 18 C82 22 76 20 76 15 C76 11 80 9 83 11"
            fill="none" stroke={s} strokeWidth="1.5"/>
      <path d="M83 6 C88 6 91 10 90 15 C89 20 84 23 80 21"
            fill="none" stroke={s} strokeWidth="1"/>

      {/* Pegbox */}
      <rect x="72" y="18" width="16" height="28" rx="2" fill={bd} stroke={s} strokeWidth="1.3"/>

      {/* Pegs */}
      {[[68,25],[90,25],[68,37],[90,37]].map(([x,y],i) => (
        <g key={i}>
          <line x1={x} y1={y} x2={x === 68 ? 82 : 78} y2={y} stroke={s} strokeWidth="1.8"/>
          <circle cx={x} cy={y} r="2.5" fill={bd} stroke={s} strokeWidth="1.1"/>
        </g>
      ))}

      {/* Nut */}
      <rect x="71" y="46" width="18" height="4.5" rx="1" fill="rgba(200,190,170,0.15)" stroke={s} strokeWidth="1"/>

      {/* Neck */}
      <path d="M75 50 L85 50 L87 100 L73 100 Z" fill={sf} stroke={s} strokeWidth="1.3"/>
      {/* Neck centre line */}
      <line x1="80" y1="52" x2="80" y2="99" stroke="rgba(220,210,195,0.1)" strokeWidth="0.6"/>

      {/* Body fill */}
      <path
        d="M80 100 C112 100,132 118,132 148 C132 170,118 182,116 204 C114 220,130 234,136 262 C142 292,138 340,80 358 C22 340,18 292,24 262 C30 234,46 220,44 204 C42 182,28 170,28 148 C28 118,48 100,80 100 Z"
        fill={sf}/>

      {/* Body outline */}
      <path d="M80 100 C112 100,132 118,132 148 C132 170,118 182,116 204 C114 220,130 234,136 262 C142 292,138 340,80 358"
            fill="none" stroke={s} strokeWidth="1.6"/>
      <path d="M80 100 C48 100,28 118,28 148 C28 170,42 182,44 204 C46 220,30 234,24 262 C18 292,22 340,80 358"
            fill="none" stroke={s} strokeWidth="1.6"/>

      {/* Purfling (edge inlay lines) */}
      <path d="M80 106 C108 106,126 122,126 148 C126 168,114 180,112 202 C110 218,126 232,131 258"
            fill="none" stroke="rgba(220,210,195,0.12)" strokeWidth="1"/>
      <path d="M80 106 C52 106,34 122,34 148 C34 168,46 180,48 202 C50 218,34 232,29 258"
            fill="none" stroke="rgba(220,210,195,0.12)" strokeWidth="1"/>

      {/* F-holes */}
      <path d="M58 212 C53 222,52 234,58 243 C64 252,64 264,58 274"
            fill="none" stroke={fs} strokeWidth="1.6"/>
      <circle cx="58" cy="211" r="3" fill="rgba(8,5,3,0.95)" stroke={fs} strokeWidth="1"/>
      <circle cx="58" cy="275" r="3" fill="rgba(8,5,3,0.95)" stroke={fs} strokeWidth="1"/>
      <path d="M102 212 C107 222,108 234,102 243 C96 252,96 264,102 274"
            fill="none" stroke={fs} strokeWidth="1.6"/>
      <circle cx="102" cy="211" r="3" fill="rgba(8,5,3,0.95)" stroke={fs} strokeWidth="1"/>
      <circle cx="102" cy="275" r="3" fill="rgba(8,5,3,0.95)" stroke={fs} strokeWidth="1"/>

      {/* Bridge */}
      <path d="M62 300 L66 294 L80 292 L94 294 L98 300 L90 300 L88 308 L72 308 L70 300 Z"
            fill="rgba(200,190,170,0.08)" stroke={gs} strokeWidth="1.1"/>
      <line x1="72" y1="300" x2="72" y2="308" stroke={gs} strokeWidth="0.7"/>
      <line x1="88" y1="300" x2="88" y2="308" stroke={gs} strokeWidth="0.7"/>

      {/* Strings */}
      {[-4.5,-1.5,1.5,4.5].map((x,i) => (
        <line key={i} x1={80+x} y1={48} x2={80+x*0.55} y2={352}
              stroke="rgba(220,210,195,0.18)" strokeWidth="0.9"/>
      ))}

      {/* Tailpiece */}
      <path d="M67 352 L93 352 L96 364 L64 364 Z"
            fill={bd} stroke={s} strokeWidth="1.1"/>
      <line x1="74" y1="352" x2="73" y2="364" stroke="rgba(220,210,195,0.1)" strokeWidth="0.6"/>
      <line x1="86" y1="352" x2="87" y2="364" stroke="rgba(220,210,195,0.1)" strokeWidth="0.6"/>

      {/* Endpin */}
      <line x1="80" y1="364" x2="80" y2="424" stroke={s} strokeWidth="2"/>
      <circle cx="80" cy="426" r="3.5" fill={bd} stroke={s} strokeWidth="1.1"/>

      {/* ── Bow ── */}
      <path d="M8 318 Q80 288 152 260" fill="none" stroke="rgba(220,210,195,0.28)" strokeWidth="3.5" strokeLinecap="round"/>
      <path d="M6 310 Q80 276 154 250" fill="none" stroke={gs} strokeWidth="1.8" strokeLinecap="round"/>
      {/* Frog */}
      <rect x="0" y="303" width="17" height="12" rx="2.5" fill="rgba(214,177,104,0.18)" stroke={gs} strokeWidth="1.2"/>
      {[0,4,8].map(dx => (
        <line key={dx} x1={4+dx} y1="303" x2={4+dx} y2="315" stroke="rgba(214,177,104,0.25)" strokeWidth="0.9"/>
      ))}
      {/* Tip */}
      <path d="M150 253 L157 249 L156 258 L149 261 Z" fill="rgba(214,177,104,0.12)" stroke={gs} strokeWidth="1"/>
    </svg>
  )
}

/* ── Piano SVG — grand piano, 3/4 perspective, dark-body style ── */
function PianoSVG() {
  const bd = 'rgba(10, 8, 6, 0.97)'        // body fill
  const s  = 'rgba(220, 210, 195, 0.48)'   // warm white stroke
  const sf = 'rgba(18, 14, 10, 0.92)'      // surface fill
  const ks = 'rgba(220, 210, 195, 0.16)'   // key divider
  const gs = 'rgba(214, 177, 104, 0.52)'   // gold (pedals)
  const wkW = 21; const wkCount = 26

  return (
    <svg viewBox="0 0 660 330" fill="none" xmlns="http://www.w3.org/2000/svg"
         style={{ width: '100%', height: 'auto', maxWidth: 700 }}>

      {/* === Rear case panel === */}
      <path d="M24 56 L24 16 Q24 4 46 4 L614 4 Q636 4 636 16 L636 56 Z"
            fill={sf} stroke={s} strokeWidth="1.3"/>

      {/* === Open lid === */}
      <path d="M24 56 L24 16 Q24 4 46 4 L614 4 Q636 4 636 16 L636 56 L490 -28 Q380 -44 140 -20 Z"
            fill={sf} stroke={s} strokeWidth="1.2"/>
      <path d="M24 56 L140 -20 Q380 -44 490 -28 L636 56"
            fill="none" stroke="rgba(220,210,195,0.14)" strokeWidth="0.8"/>
      {/* Lid prop stick */}
      <line x1="390" y1="8" x2="372" y2="56" stroke="rgba(220,210,195,0.45)" strokeWidth="2" strokeLinecap="round"/>
      <circle cx="372" cy="57" r="3.5" fill={bd} stroke={s} strokeWidth="1.1"/>

      {/* === Right side wall === */}
      <path d="M636 56 L636 244 L614 256 L614 56 Z"
            fill={sf} stroke={s} strokeWidth="1"/>

      {/* === Fallboard === */}
      <path d="M24 56 L636 56 L614 70 L46 70 Z"
            fill={bd} stroke={s} strokeWidth="1.2"/>

      {/* Keybed back wall */}
      <rect x="24" y="70" width="590" height="18" rx="1.5"
            fill="rgba(30,22,14,0.95)" stroke={s} strokeWidth="1.1"/>

      {/* White keys */}
      {Array.from({ length: wkCount }).map((_, i) => (
        <rect key={i}
              x={27 + i * wkW} y="88" width={wkW - 1.5} height="118" rx="2"
              fill="rgba(220,210,195,0.14)" stroke={ks} strokeWidth="0.8"/>
      ))}

      {/* Black keys — 2+3 per octave */}
      {[1,2,4,5,6, 8,9,11,12,13, 15,16,18,19,20, 22,23,25].map((pos, i) => (
        <rect key={i}
              x={27 + pos * wkW + 13} y="88" width="13" height="76" rx="2"
              fill="rgba(5,4,3,0.98)" stroke="rgba(220,210,195,0.1)" strokeWidth="0.7"/>
      ))}

      {/* Key bottom edge */}
      <rect x="24" y="206" width="590" height="13"
            fill={bd} stroke="rgba(220,210,195,0.12)" strokeWidth="1"/>

      {/* Front rail */}
      <rect x="24" y="219" width="590" height="30" rx="4"
            fill={sf} stroke={s} strokeWidth="1.2"/>

      {/* Right-side depth of front rail */}
      <path d="M614 219 L636 207 L636 244 L614 249 Z"
            fill={bd} stroke={s} strokeWidth="0.8"/>

      {/* === Pedal lyre === */}
      <path d="M226 249 Q224 264 234 276 L426 276 Q436 264 434 249 Z"
            fill={bd} stroke={s} strokeWidth="1"/>
      {[289, 330, 371].map((x, i) => (
        <ellipse key={i} cx={x} cy="278" rx="16" ry="8"
                 fill="rgba(214,177,104,0.16)" stroke={gs} strokeWidth="1.1"/>
      ))}

      {/* === Legs === */}
      <path d="M30 249 L30 295 Q30 303 24 303 L24 308 L46 308 L46 303 Q40 303 40 295 L40 249 Z"
            fill={bd} stroke={s} strokeWidth="1"/>
      <path d="M608 249 L608 295 Q608 303 602 303 L602 308 L624 308 L624 303 Q618 303 618 295 L618 249 Z"
            fill={bd} stroke={s} strokeWidth="1"/>
    </svg>
  )
}

const CLARINET_TEXT = "m.12 – entrance is 18ms early. Ease into the pickup note and let the phrase settle onto the downbeat."
const CELLO_TEXT    = "m.24 – the shift lands slightly sharp. Relax the left hand and settle into the pitch before the phrase opens."
const PIANO_TEXT_1  = "m.8 – the left hand rushes the arpeggio. Let the accompaniment breathe so the melody stays supported."

/* ── Logo mark ── */
function AnimatedLogo({ size = 28 }) {
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      background: 'white',
      WebkitMask: `url('/logo-mark.png') center/contain no-repeat`,
      WebkitMaskMode: 'luminance',
      mask: `url('/logo-mark.png') center/contain no-repeat`,
      maskMode: 'luminance',
    }} />
  )
}

function Wordmark({ className }) {
  return <span className={`${styles.wordmark} ${className || ''}`}>Mediant</span>
}

/* ── Per-character word materialization ── */
function AnimatedWord({ word, visible, color }) {
  return (
    <>
      {word.split('').map((char, i) => (
        <span
          key={i}
          className={`${styles.heroChar} ${visible ? styles.heroCharIn : styles.heroCharOut}`}
          style={{ '--ci': i, '--ct': word.length, '--w-color': color }}
        >
          {char}
        </span>
      ))}
    </>
  )
}

/* ── Animated stat counter ── */
function StatCard({ value, suffix, label, delay }) {
  const [active, setActive] = useState(false)
  const [count, setCount]   = useState(0)
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setActive(true); obs.disconnect() }
    }, { threshold: 0.4 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    if (!active) return
    const start = performance.now()
    const dur   = 2200
    function frame(now) {
      const p    = Math.min((now - start) / dur, 1)
      const ease = 1 - Math.pow(1 - p, 4)
      setCount(Math.round(ease * value))
      if (p < 1) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }, [active, value])

  return (
    <div ref={ref} className={`${styles.statCard} ${styles.revealScale}`} style={{ '--d': delay }}>
      <span className={styles.statValue}>{count.toLocaleString()}{suffix}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  )
}

export default function Landing() {
  const [wordIdx, setWordIdx]         = useState(0)
  const [wordVisible, setWordVisible] = useState(true)
  const canvasRef = useRef(null)
  const [clarinetRef, clarinetInView] = useInView()
  const [celloRef,    celloInView]    = useInView()
  const [pianoRef,    pianoInView]    = useInView()

  /* ── Waveform canvas (breathing, not scrolling) ── */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let raf

    const WAVES = [
      { freq: 0.010, baseAmp: 36, breatheFreq: 0.40, breathePhase: 0.0, alpha: 0.07, yRatio: 0.35 },
      { freq: 0.016, baseAmp: 22, breatheFreq: 0.60, breathePhase: 1.5, alpha: 0.09, yRatio: 0.50 },
      { freq: 0.007, baseAmp: 50, breatheFreq: 0.28, breathePhase: 0.8, alpha: 0.04, yRatio: 0.65 },
      { freq: 0.022, baseAmp: 16, breatheFreq: 0.72, breathePhase: 2.2, alpha: 0.07, yRatio: 0.43 },
      { freq: 0.013, baseAmp: 30, breatheFreq: 0.50, breathePhase: 3.8, alpha: 0.05, yRatio: 0.72 },
    ]

    const dpr = window.devicePixelRatio || 1

    function resize() {
      canvas.width  = canvas.offsetWidth  * dpr
      canvas.height = canvas.offsetHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    window.addEventListener('resize', resize)
    resize()

    function tick(now) {
      const t = now * 0.001
      const w = canvas.offsetWidth
      const h = canvas.offsetHeight
      if (!w || !h) { raf = requestAnimationFrame(tick); return }
      ctx.clearRect(0, 0, w, h)

      for (const wave of WAVES) {
        const amp = wave.baseAmp * (0.3 + 0.7 * Math.sin(t * wave.breatheFreq + wave.breathePhase))
        ctx.beginPath()
        ctx.strokeStyle = `rgba(92,184,107,${wave.alpha})`
        ctx.lineWidth = 1.5
        for (let x = 0; x <= w; x += 3) {
          const y = h * wave.yRatio + Math.sin(x * wave.freq) * amp
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        }
        ctx.stroke()
      }

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize) }
  }, [])

  /* ── Word cycling ── */
  useEffect(() => {
    const id = setInterval(() => {
      setWordVisible(false)
      // Give the exit animation time to fully finish before swapping text
      setTimeout(() => setWordIdx(i => (i + 1) % ROTATING_LINES.length), 480)
      setTimeout(() => setWordVisible(true), 540)
    }, 3600)
    return () => clearInterval(id)
  }, [])

  /* ── Scroll reveals (bidirectional) ── */
  useEffect(() => {
    const classes = [styles.reveal, styles.revealL, styles.revealR, styles.revealScale]
    const query = classes.map(c => `.${c}`).join(', ')
    const els = document.querySelectorAll(query)
    if (!els.length) return

    // threshold:0 fires only when element fully leaves — user never sees the reset
    // rootMargin shrinks trigger zone slightly so enter animation happens just after element edge crosses
    const obs = new IntersectionObserver(
      entries => entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add(styles.revealVisible)
        } else {
          // Fully offscreen — reset regardless of direction so it re-animates on re-entry
          e.target.classList.remove(styles.revealVisible)
        }
      }),
      { threshold: 0, rootMargin: '-8px 0px -8px 0px' },
    )
    els.forEach(el => obs.observe(el))
    return () => obs.disconnect()
  }, [])

  const current = ROTATING_LINES[wordIdx]

  return (
    <div className={styles.page}>

      {/* ── Nav ── */}
      <nav className={styles.nav}>
        <Link to="/" className={styles.navBrand}>
          <AnimatedLogo size={34} />
          <Wordmark />
        </Link>
        <div className={styles.navRight}>
          <Link to="/login"  className={styles.navLogin}>Log in</Link>
          <Link to="/signup" className={styles.navCta}>Get started free →</Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className={styles.hero}>
        <canvas ref={canvasRef} className={styles.waveCanvas} aria-hidden="true" />

        <div className={styles.heroLogoLarge}>
          <AnimatedLogo size={140} />
        </div>

        <h1 className={styles.heroHeading}>
          <span className={styles.heroLine}>
            <span className={styles.heroStatic}>We</span>
            <span className={styles.heroWordFrame} aria-live="polite" aria-atomic="true">
              <AnimatedWord word={current.we} visible={wordVisible} color={current.color} />
            </span>
            <span className={styles.heroComma}>,&nbsp;you</span>
            <span className={styles.heroWordFrame} aria-live="polite" aria-atomic="true">
              <AnimatedWord word={current.you} visible={wordVisible} color={current.color} />
            </span>
          </span>
        </h1>

        <p className={styles.heroSub}>
          Upload a recording. Mediant maps it to your sheet music and delivers
          feedback that sounds like it came from a teacher — not an app.
        </p>

        <div className={styles.heroCtas}>
          <Link to="/signup" className={styles.ctaPrimary}>Start for free →</Link>
          <Link to="/login"  className={styles.ctaGhost}>Log in</Link>
        </div>

        <p className={styles.heroNote}>Free to start · No credit card · Any instrument</p>
      </section>

      {/* ── Stats ── */}
      <section className={styles.statsSection}>
        <div className={styles.statsGrid}>
          {STATS.map((s, i) => (
            <StatCard
              key={s.label}
              value={s.value}
              suffix={s.suffix}
              label={s.label}
              delay={`${i * 130}ms`}
            />
          ))}
        </div>
      </section>

      {/* ── Instruments ── */}
      <section className={styles.instrumentsSection}>

        <div className={`${styles.instrumentBand} ${styles.sceneClarinet} ${styles.revealL}`} ref={clarinetRef}>
          <div className={styles.instrumentText}>
            <span className={styles.sectionLabel}>Woodwinds</span>
            <h2 className={styles.instrumentTitle}>Measure-by-measure clarity for wind players</h2>
            <p className={styles.instrumentBody}>
              Mediant catches timing drift, intonation shifts, and tonal inconsistencies — flagged to the exact beat, not a vague average.
            </p>
          </div>
          <div className={`${styles.instrumentVisual} ${styles.revealR}`} style={{ '--d': '80ms' }}>
            <div className={styles.instrumentGlow} style={{ '--glow-color': 'rgba(214,177,104,0.28)' }} />
            <div className={styles.instrumentTilt}>
              <ClarinetSVG />
            </div>
            <DocTyping text={CLARINET_TEXT} color="#d6b168" active={clarinetInView} />
          </div>
        </div>

        <div className={`${styles.instrumentBand} ${styles.scenePiano} ${styles.revealR}`} ref={pianoRef}>
          <div className={styles.instrumentText}>
            <span className={styles.sectionLabel}>Keyboard</span>
            <h2 className={styles.instrumentTitle}>Every voice, every hand, every measure</h2>
            <p className={styles.instrumentBody}>
              Piano analysis tracks both hands independently — voicing balance, dynamic shaping, and rhythmic precision, simultaneously.
            </p>
          </div>
          <div className={`${styles.instrumentVisual} ${styles.revealL}`} style={{ '--d': '80ms' }}>
            <div className={styles.instrumentGlow} style={{ '--glow-color': 'rgba(92,184,107,0.12)' }} />
            <div className={styles.instrumentTilt}>
              <PianoSVG />
            </div>
            <DocTyping text={PIANO_TEXT_1} color="#5cb86b" active={pianoInView} />
          </div>
        </div>

        <div className={`${styles.instrumentBand} ${styles.sceneCello} ${styles.revealL}`} ref={celloRef}>
          <div className={styles.instrumentText}>
            <span className={styles.sectionLabel}>Strings</span>
            <h2 className={styles.instrumentTitle}>Bow technique feedback you can act on</h2>
            <p className={styles.instrumentBody}>
              From bow pressure to phrasing shape — Mediant hears what your ear misses and tells you exactly what to change.
            </p>
          </div>
          <div className={`${styles.instrumentVisual} ${styles.revealR}`} style={{ '--d': '80ms' }}>
            <div className={styles.instrumentGlow} style={{ '--glow-color': 'rgba(214,177,104,0.12)' }} />
            <div className={styles.instrumentTilt}>
              <CelloSVG />
            </div>
            <DocTyping text={CELLO_TEXT} color="#5cb86b" active={celloInView} />
          </div>
        </div>

      </section>

      {/* ── Features ── */}
      <section className={styles.features}>
        <div className={`${styles.featuresHead} ${styles.reveal}`}>
          <p className={styles.sectionLabel}>What you get</p>
          <h2 className={styles.featuresTitle}>Everything a serious<br />practice session needs</h2>
        </div>
        {FEATURES.map((f, i) => (
          <div
            key={f.title}
            className={`${styles.featureRow} ${i % 2 === 1 ? styles.featureRowFlip : ''} ${i % 2 === 0 ? styles.revealL : styles.revealR}`}
            style={{ '--d': `${i * 60}ms` }}
          >
            <div className={styles.featureText}>
              <span className={styles.featureNum}>{f.num}</span>
              <h3 className={styles.featureTitle}>{f.title}</h3>
              <p className={styles.featureBody}>{f.body}</p>
            </div>
            <div className={styles.featureVisual}>
              <f.icon />
            </div>
          </div>
        ))}
      </section>

      {/* ── How it works ── */}
      <section className={styles.howItWorks}>
        <div className={`${styles.howHead} ${styles.reveal}`}>
          <p className={styles.sectionLabel}>How it works</p>
          <h2 className={styles.howTitle}>Three steps to<br />better practice</h2>
        </div>
        <div className={styles.steps}>
          {STEPS.map((s, i) => (
            <div key={s.num} className={`${styles.step} ${styles.reveal}`} style={{ '--d': `${i * 160}ms` }}>
              <span className={styles.stepNum}>{s.num}</span>
              <h3 className={styles.stepTitle}>{s.title}</h3>
              <p className={styles.stepBody}>{s.body}</p>
              {i < STEPS.length - 1 && <div className={styles.stepArrow}>→</div>}
            </div>
          ))}
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className={`${styles.ctaSection} ${styles.reveal}`}>
        <h2 className={styles.ctaTitle}>Practice with intention,<br />not just repetition.</h2>
        <p className={styles.ctaSub}>Join musicians turning practice time into real, measurable progress.</p>
        <div className={styles.heroCtas}>
          <Link to="/signup" className={styles.ctaPrimary}>Create your free account</Link>
          <Link to="/login"  className={styles.ctaGhost}>Log in</Link>
        </div>
        <p className={styles.heroNote}>No credit card · Cancel anytime</p>
      </section>

      {/* ── Footer ── */}
      <footer className={styles.footer}>
        <div className={styles.footerLeft}>
          <Link to="/" className={styles.navBrand} style={{ opacity: 0.6 }}>
            <AnimatedLogo size={28} />
            <Wordmark />
          </Link>
          <p className={styles.footerTagline}>Intelligent music performance analysis.</p>
        </div>
        <div className={styles.footerLinks}>
          <Link to="/privacy" className={styles.footerLink}>Privacy</Link>
          <Link to="/terms"   className={styles.footerLink}>Terms</Link>
          <Link to="/contact" className={styles.footerLink}>Contact</Link>
        </div>
        <p className={styles.footerCopy}>© 2026 Mediant</p>
      </footer>
    </div>
  )
}

/* ── Icons (large, artistic) ── */
function ScoreIcon() {
  return (
    <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
    </svg>
  )
}
function CoachIcon() {
  return (
    <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  )
}
function ProgressIcon() {
  return (
    <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  )
}
