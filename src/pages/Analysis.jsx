import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { SkeletonCard } from '../components/Skeleton'
import WaveformTimeline, { WAVEFORM_GROUPS } from '../components/WaveformTimeline'
import MasterclassPanel from '../components/MasterclassPanel'
import AnalysisOnboarding from '../components/AnalysisOnboarding'
import styles from './Page.module.css'
import aStyles from './Analysis.module.css'
import { playTick, playPop, playNav } from '../utils/sounds'

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }

const HEADER_WAVE_BARS = [
  22, 40, 58, 30, 75, 48, 90, 62, 38, 55,
  70, 42, 65, 32, 52, 80, 58, 36, 68, 44,
  76, 50, 34, 82, 60, 40, 72, 46, 28, 56,
]

const QUICK_PROMPTS = [
  'What should I practice first?',
  'Give me a drill for the hardest flag',
  'How can I fix my timing?',
  'What improved from my last take?',
  'Explain the biggest issue in detail',
]

const TYPE_META = {
  technique:    { icon: '⊙', cls: 'iconGreen' },
  intonation:   { icon: '♯', cls: 'iconCoral' },
  rhythm:       { icon: '♩', cls: 'iconGold'  },
  timing:       { icon: '♩', cls: 'iconGold'  },
  dynamics:     { icon: 'ƒ', cls: 'iconCoral' },
  articulation: { icon: '▸', cls: 'iconGold'  },
  tone:         { icon: '◎', cls: 'iconGreen' },
  phrasing:     { icon: '∿', cls: 'iconGold'  },
  expression:   { icon: '∿', cls: 'iconGold'  },
  posture:      { icon: '⊕', cls: 'iconGreen' },
}

function flagTypeMeta(type) {
  return TYPE_META[(type ?? '').toLowerCase()] ?? { icon: '◆', cls: 'iconCoral' }
}

const PRACTICE_RECS = {
  intonation:   'Long-tone exercise with a tuner: sustain each note for 8 beats, centering the pitch with a reference drone before moving to the next.',
  timing:       'Isolate the passage at 60% tempo with a metronome. Subdivide internally (count eighth-note subdivisions aloud) before raising speed in 5 BPM steps.',
  rhythm:       'Clap the rhythmic pattern separately from pitch. Count aloud with a metronome before adding notes, then transfer the same subdivision to your playing.',
  dynamics:     'Practice extremes first: play the passage pp only, then ff only. For forte passages, use arm weight from the shoulder — not finger force.',
  articulation: 'Exaggerate the style first (maximum staccato or maximum legato), then find the correct midpoint. Record and compare.',
  technique:    'Slow-practice hands/parts separately at 40% speed, attending entirely to hand position and movement efficiency. No notes until position is clean.',
  tone:         'Sustain a single pitch for 8 beats on each note in the passage, listening for evenness and warmth across the full duration before continuing.',
  phrasing:     'Sing the phrase aloud to feel its shape and direction. Then transfer that same arc and breath control to your instrument.',
  expression:   'Identify the emotional peak of the phrase. Practice leading deliberately to that moment and releasing away from it.',
  posture:      'Use a mirror or video to observe alignment during practice. Focus on releasing shoulder tension and keeping wrists neutral throughout the passage.',
}

function practiceRec(type) {
  return PRACTICE_RECS[(type ?? '').toLowerCase()] ?? 'Practice this passage slowly in isolation, focusing entirely on the flagged element before increasing speed.'
}

const ASPECT_LABELS = {
  intonation:   { label: 'Intonation', icon: '♯' },
  timing:       { label: 'Timing',     icon: '♩' },
  dynamics:     { label: 'Dynamics',   icon: 'ƒ' },
  articulation: { label: 'Articulation', icon: '▸' },
  technique:    { label: 'Technique',  icon: '⊙' },
  tone:         { label: 'Tone',       icon: '◎' },
}

function computeAspectScores(take) {
  if (!take?.flags || take.score == null) return null
  const base = take.score
  const aspects = Object.keys(ASPECT_LABELS)
  const result = {}
  aspects.forEach(aspect => {
    const related = (take.flags ?? []).filter(f => {
      const t = (f.type ?? '').toLowerCase()
      if (aspect === 'timing') return t === 'timing' || t === 'rhythm'
      return t === aspect
    })
    const flagWeight = related.reduce((sum, f) => sum + (f.confidence ?? 80) / 100, 0)
    const deduction = Math.round(flagWeight * 9)
    const bonus = related.length === 0 ? Math.round(Math.random() * 4 + 2) : 0
    result[aspect] = Math.max(18, Math.min(100, base - deduction + bonus))
  })
  return result
}

const DEMO_TAKE = {
  id: 'demo',
  piece_title: 'Clair de lune',
  piece_composer: 'Claude Debussy',
  instrument: 'Piano',
  score: 82,
  analysis_quality: { trust: 'high', reasons: [] },
  analysis_backend: 'gemini-inline',
  created_at: new Date().toISOString(),
  flags: [
    {
      measure: 5,
      type: 'timing',
      confidence: 91,
      title: 'Rushing the triplet descent',
      detail: 'The right-hand triplet run in m.5 arrives roughly 40ms early, clipping the lyrical line. Subdivide each triplet group against a slow metronome (♩=40) until the three notes feel even, then gradually raise tempo.',
      timestamp_start: 8.2,
      timestamp_end: 10.1,
    },
    {
      measure: 14,
      type: 'dynamics',
      confidence: 88,
      title: 'Subito forte too percussive',
      detail: 'The fortissimo chord in m.14 is struck rather than weighted — the tone loses its warmth. Approach it with arm weight from the shoulder rather than a finger strike, letting the key beds down through the sound.',
      timestamp_start: 22.4,
      timestamp_end: 23.9,
    },
    {
      measure: 21,
      type: 'intonation',
      confidence: 85,
      title: 'Left-hand bass F♯ tuning',
      detail: 'The bass F♯ octave in m.21 sits slightly thin — likely a touch of damper pedal blurring the lower partial. Clear the pedal just before this beat and use a deeper key contact to reinforce the fundamental.',
      timestamp_start: 35.0,
      timestamp_end: 36.5,
    },
    {
      measure: 27,
      type: 'technique',
      confidence: 82,
      title: 'Thumb tuck on inner voice D♭',
      detail: 'The thumb crosses under the hand awkwardly on the D♭ in m.27, creating a slight accent in an inner voice that should be nearly inaudible. Practice the LH alone, voicing the top melody note and letting the inner D♭ fall naturally under the palm.',
      timestamp_start: 46.8,
      timestamp_end: 48.3,
    },
  ],
  video_path: null,
  score_path: null,
  _demo: true,
}

const CLARINET_DEMO_TAKE = {
  id: 'demo_clarinet',
  piece_title: 'Procession of the Nobles',
  piece_composer: 'Nicholas Rimsky-Korsakov',
  instrument: 'Clarinet in Bb',
  score: 72,
  analysis_quality: { trust: 'medium', reasons: [] },
  analysis_backend: 'gemini-inline',
  created_at: new Date(Date.now() - 4 * 86400000).toISOString(),
  flags: [
    {
      measure: 12,
      type: 'technique',
      confidence: 68,
      title: 'Right hand fingers hovering too high off keys',
      detail: 'Keep fingers closer to the tone holes to minimize motion and improve facility.',
      timestamp_start: 12.1,
      timestamp_end: 15.0
    },
    {
      measure: 14,
      type: 'technique',
      confidence: 68,
      title: 'Left thumb angle pressing awkwardly on register key',
      detail: 'Position the thumb at a 45-degree angle to easily roll onto the register key.',
      timestamp_start: 12.1,
      timestamp_end: 15.0
    },
    {
      measure: 17,
      type: 'technique',
      confidence: 68,
      title: 'Right pinky visibly splayed away from low keys',
      detail: 'Keep the pinky relaxed and hovering near the low keys to avoid tension.',
      timestamp_start: 12.1,
      timestamp_end: 15.0
    },
    {
      measure: 20,
      type: 'technique',
      confidence: 68,
      title: 'Instrument angle tilted too far outward from body',
      detail: 'Hold the clarinet at a 30 to 40-degree angle from your body for optimal embouchure support.',
      timestamp_start: 24.1,
      timestamp_end: 28.0
    },
    {
      measure: 25,
      type: 'technique',
      confidence: 68,
      title: 'Chin muscles visibly bunching under lower lip',
      detail: 'Keep the chin flat and pointed, firming the corners of the mouth to prevent bunching.',
      timestamp_start: 36.2,
      timestamp_end: 40.0
    },
    {
      measure: 35,
      type: 'technique',
      confidence: 68,
      title: 'Head tilting downward losing upper body alignment',
      detail: 'Bring the instrument up to your mouth rather than tilting your head down to meet it.',
      timestamp_start: 48.2,
      timestamp_end: 52.0
    }
  ],
  video_path: null,
  score_path: '/Clarinet.png',
  _demo: true
}

const INITIAL_AI_MESSAGES = {
  'Procession of the Nobles': [
    {
      role: 'assistant',
      content: "Hi Matthew! I've analyzed your latest take of Nicholas Rimsky-Korsakov's **Procession of the Nobles** (Take 5). Your technique score is **72/100**.\n\nYou have good energy, but I've flagged a few posture and hand-positioning items:\n- **m.12 (Technique)**: Right hand fingers hovering too high off keys.\n- **m.14 (Technique)**: Left thumb register key angle pressing awkwardly.\n- **m.20 (Technique)**: Instrument angle tilted too far outward.\n\nWhich area would you like to work on first?",
    }
  ],
  'Clair de lune': [
    {
      role: 'assistant',
      content: "Hi Elena! I've analyzed your latest take of Claude Debussy's **Clair de lune** (Take 12). Your technique score is **82/100** (a +4 increase from your last take!).\n\nYour tone in the middle section is exceptionally warm, but I've flagged a few spots of interest:\n- **m.5 (Timing)**: Slightly early on the triplet run descent.\n- **m.14 (Dynamics)**: Subito forte is slightly percussive.\n- **m.21 (Intonation/Pedaling)**: Dampers slightly blurred the bass F♯ octave.\n\nWhich area would you like to work on first?",
    }
  ],
  'Nocturne in E♭, Op. 9 No. 2': [
    {
      role: 'assistant',
      content: "Hi Elena! I've reviewed your performance of Frédéric Chopin's **Nocturne in E♭, Op. 9 No. 2** (Take 6). Your score is **81/100**.\n\nYou have beautiful control over the rubato, but I noticed a slight rush on the trill ornament in measure 16. Subdivide the accompaniment beats to ground your phrasing. What would you like to focus on?",
    }
  ],
  'Cello Suite No. 1 — Prélude': [
    {
      role: 'assistant',
      content: "Excellent bow contact on J.S. Bach's **Cello Suite No. 1 — Prélude**! Your score sits at **88/100**.\n\nThe string crossings in measure 31 are extremely clean. Keep the lower voice ringing, and make sure to relax your shoulder during the G-string pedal points. How can I help you refine this session?",
    }
  ],
  'Fantaisie-Impromptu, Op. 66': [
    {
      role: 'assistant',
      content: "Hi! I've analyzed your take of Chopin's **Fantaisie-Impromptu** (Take 4). The polyrhythm is always tricky—your score is **67/100**.\n\nCurrently, the left-hand 6-against-4 is rushing, which throws off the right-hand cross-rhythms. Let's do slow practicing (♩=50) mapping each note intersection precisely. Ask me for exercise patterns!",
    }
  ],
  'Gymnopédie No. 1': [
    {
      role: 'assistant',
      content: "Wonderful atmosphere on Satie's **Gymnopédie No. 1**! Your score is an excellent **92/100**.\n\nYour tempo consistency is pristine, and you capture the melancholy beautifully. My only recommendation is to voice the top melodic voice slightly more over the bass chords in measure 12. Would you like to practice that together?",
    }
  ]
}

function timeAgo(iso) {
  if (!iso) return null
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (diff < 60)   return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatTs(sec) {
  if (sec == null) return '—'
  const s = Number(sec)
  if (!isFinite(s) || s < 0) return '—'
  const m = Math.floor(s / 60)
  const r = (s % 60).toFixed(1).padStart(4, '0')
  return `${m}:${r}`
}

function confColor(confidence) {
  if (confidence >= 90) return 'var(--score-good)'
  if (confidence >= 70) return 'var(--score-ok)'
  return 'var(--score-bad)'
}

function confLabel(confidence) {
  if (confidence >= 90) return 'High'
  if (confidence >= 70) return 'Medium'
  return 'Low'
}

function scoreColor(n) {
  if (n >= 88) return 'var(--score-good)'
  if (n >= 74) return 'var(--score-ok)'
  return 'var(--score-bad)'
}

function scoreBgColor(n) {
  if (n >= 88) return 'color-mix(in srgb, var(--score-good) 16%, transparent)'
  if (n >= 74) return 'color-mix(in srgb, var(--score-ok) 16%, transparent)'
  return 'color-mix(in srgb, var(--score-bad) 16%, transparent)'
}

function scoreFileForPiece(title) {
  if (!title) return null
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const known = {
    'clair-de-lune': '/scores/clair-de-lune.mxl',
  }
  return known[slug] ?? null
}

function ConfidenceGauge({ confidence }) {
  const radius = 18;
  const strokeWidth = 3.5;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (confidence / 100) * circumference;
  const color = confColor(confidence);
  const label = confLabel(confidence);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, marginTop: 4 }}>
      <div style={{ position: 'relative', width: 44, height: 44 }}>
        <svg width="44" height="44" viewBox="0 0 44 44" style={{ transform: 'rotate(-90deg)', display: 'block' }}>
          <circle
            cx="22" cy="22" r={radius}
            fill="transparent"
            stroke="rgba(0,0,0,0.04)"
            strokeWidth={strokeWidth}
          />
          <circle
            cx="22" cy="22" r={radius}
            fill="transparent"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.35s ease' }}
          />
        </svg>
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '11px', fontWeight: '700', color: 'var(--text)',
          fontFamily: 'var(--font-mono)'
        }}>
          {confidence}%
        </div>
      </div>
      <span style={{ fontSize: '11px', fontWeight: '600', color: color, letterSpacing: '0.02em' }}>
        {label}
      </span>
    </div>
  );
}

export default function Analysis({ demo: demoProp = false }) {
  const nav = useNavigate()
  const [searchParams] = useSearchParams()
  const { user, profile } = useAuth()
  
  const scoreEl  = useRef(null)
  const osmdRef  = useRef(null)
  const videoRef    = useRef(null)
  const loopRef     = useRef(null)
  const chatEndRef = useRef(null)
  const fileInputRef = useRef(null)
  const summaryRef = useRef(null)

  // Waveform header animated metric bar refs
  const hFill1Ref = useRef(null)
  const hFill2Ref = useRef(null)
  const hFill3Ref = useRef(null)
  const hNum1Ref  = useRef(null)
  const hNum2Ref  = useRef(null)
  const hNum3Ref  = useRef(null)

  const isDemo = demoProp || searchParams.get('demo') === 'true'
  const takeId = searchParams.get('takeId')

  // Threads & database takes state
  const [allTakes, setAllTakes] = useState([])
  const [takesLoaded, setTakesLoaded] = useState(false)
  // Real users start with no thread selected (it resolves to their first real
  // session once takes load); the public demo keeps the sample piece selected.
  const [activeThreadTitle, setActiveThreadTitle] = useState(isDemo ? 'Procession of the Nobles' : '')
  const [selectedTakeId, setSelectedTakeId] = useState(null)

  const [showThreadMenu, setShowThreadMenu] = useState(null) // piece_title of thread with open menu

  const [showAnalysisIntro, setShowAnalysisIntro] = useState(false)

  // Overview / Session Summary tabs
  const [activeTab, setActiveTab] = useState('overview')
  const [isLooping, setIsLooping] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  
  const [scoreUrl, setScoreUrl]       = useState(null)
  const [videoUrl, setVideoUrl]       = useState(null)
  const [activeFlag, setActiveFlag]   = useState(null)
  const [scoreReady, setScoreReady]   = useState(false)
  const [highlights, setHighlights]   = useState([])
  const [videoSpeed, setVideoSpeed]     = useState(1)
  const [videoDuration, setVideoDuration] = useState(null)
  const [scoreCollapsed, setScoreCollapsed] = useState(false)

  // AI summary state
  const [summary, setSummary]             = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError]   = useState(null)

  // Chat conversation state
  const [threadChats, setThreadChats] = useState({})
  const [chatInput, setChatInput]       = useState('')
  const [chatLoading, setChatLoading]   = useState(false)

  // Song-thread persistence state
  const [activeSongId, setActiveSongId] = useState(null)

  // AI-context note (per-take) + re-analyze state
  const [noteDraft, setNoteDraft]   = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  const [noteSaved, setNoteSaved]   = useState(false)
  const [reanalyzing, setReanalyzing] = useState(false)

  // Teacher annotation state (only active when profile.role === 'teacher')
  const [annotations,    setAnnotations]    = useState({}) // flagIndex → annotation row
  const [activeAnnot,    setActiveAnnot]    = useState(null) // { flagIndex, action }
  const [annotLoading,   setAnnotLoading]   = useState({}) // flagIndex → bool
  const [rejectReason,   setRejectReason]   = useState('wrong_measure')
  const [editedTitle,    setEditedTitle]    = useState('')
  const [editedDetail,   setEditedDetail]   = useState('')
  const [analysisAuthToken, setAnalysisAuthToken] = useState(null)

  // Keyboard shortcut state ref
  const kbRef = useRef({})

  // Fetch takes on load
  useEffect(() => {
    if (!user?.id) {
      try {
        const stored = JSON.parse(localStorage.getItem('mediant_takes') || '[]')
        setAllTakes(Array.isArray(stored) ? stored : [])
      } catch {
        setAllTakes([])
      }
      setTakesLoaded(true)
      return
    }
    setTakesLoaded(false)
    supabase
      .from('takes')
      .select('id, piece_title, piece_composer, instrument, score, flags, analysis_quality, analysis_backend, video_path, score_path, note, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!error && data) {
          setAllTakes(data)
        }
        setTakesLoaded(true)
      })
  }, [user?.id])

  // Grab auth token for teacher annotation calls
  useEffect(() => {
    if (!user?.id || profile?.role !== 'teacher') return
    supabase.auth.getSession().then(({ data: { session } }) => {
      setAnalysisAuthToken(session?.access_token ?? null)
    })
  }, [user?.id, profile?.role])

  // Find or create a songs record for the active thread, and load its chat history
  useEffect(() => {
    if (!user?.id || !activeThreadTitle || isDemo) {
      setActiveSongId(null)
      return
    }

    let cancelled = false

    supabase
      .from('songs')
      .select('id, chat_history')
      .eq('user_id', user.id)
      .eq('title', activeThreadTitle)
      .maybeSingle()
      .then(async ({ data }) => {
        if (cancelled) return

        if (data) {
          setActiveSongId(data.id)
          // Only hydrate if the DB has history and the local cache is empty
          if (Array.isArray(data.chat_history) && data.chat_history.length > 0) {
            setThreadChats(prev => {
              if (prev[activeThreadTitle]?.length > 0) return prev
              return { ...prev, [activeThreadTitle]: data.chat_history }
            })
          }
        } else {
          // Create the song record for this thread
          const { data: newSong } = await supabase
            .from('songs')
            .insert({
              user_id:    user.id,
              title:      activeThreadTitle,
              composer:   activeThread?.piece_composer ?? 'Unknown',
              instrument: activeThread?.instrument ?? null,
            })
            .select('id')
            .single()
          if (!cancelled && newSong) {
            setActiveSongId(newSong.id)
          }
        }
      })

    return () => { cancelled = true }
  // activeThread intentionally omitted — we only re-run on title/user change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, activeThreadTitle, isDemo])

  // Threads mapping (combining real takes & beautiful demo defaults)
  const threads = useMemo(() => {
    const groups = {}
    
    // Process real takes
    allTakes.forEach(t => {
      const title = t.piece_title || 'Untitled Session'
      if (!groups[title]) {
        groups[title] = {
          piece_title: title,
          piece_composer: t.piece_composer || 'Unknown Composer',
          instrument: t.instrument || 'Piano',
          takes: [],
          isPinned: false,
        }
      }
      groups[title].takes.push(t)
    })

    // Real, signed-in users see only their own sessions. The sample sessions
    // below are seeded ONLY on the public /demo route — never blended into a
    // real account's library (that's what made another player's clarinet
    // session show up for a trumpet player).
    if (!isDemo) return Object.values(groups)

    // Premium demo mock fallbacks
    const mockData = [
      {
        piece_title: 'Procession of the Nobles',
        piece_composer: 'Nicholas Rimsky-Korsakov',
        instrument: 'Clarinet in Bb',
        isPinned: true,
        takes: [
          { ...CLARINET_DEMO_TAKE, created_at: new Date(Date.now() - 4 * 86400000).toISOString() }
        ]
      },
      {
        piece_title: 'Clair de lune',
        piece_composer: 'Claude Debussy',
        instrument: 'Piano',
        isPinned: true,
        takes: [
          { ...DEMO_TAKE, score: 82, created_at: new Date(Date.now() - 120000).toISOString() },
          { ...DEMO_TAKE, score: 78, created_at: new Date(Date.now() - 86400000).toISOString() },
        ],
      },
      {
        piece_title: 'Nocturne in E♭, Op. 9 No. 2',
        piece_composer: 'Frédéric Chopin',
        instrument: 'Piano',
        isPinned: true,
        takes: [
          { id: 'mock_2', piece_title: 'Nocturne in E♭, Op. 9 No. 2', piece_composer: 'Frédéric Chopin', instrument: 'Piano', score: 81, created_at: new Date(Date.now() - 86400000).toISOString(), flags: [] },
        ],
      },
      {
        piece_title: 'Cello Suite No. 1 — Prélude',
        piece_composer: 'J.S. Bach',
        instrument: 'Cello',
        isPinned: false,
        takes: [
          { id: 'mock_3', piece_title: 'Cello Suite No. 1 — Prélude', piece_composer: 'J.S. Bach', instrument: 'Cello', score: 88, created_at: new Date(Date.now() - 172800000).toISOString(), flags: [] },
        ],
      },
      {
        piece_title: 'Fantaisie-Impromptu, Op. 66',
        piece_composer: 'Frédéric Chopin',
        instrument: 'Piano',
        isPinned: false,
        takes: [
          { id: 'mock_4', piece_title: 'Fantaisie-Impromptu, Op. 66', piece_composer: 'Frédéric Chopin', instrument: 'Piano', score: 67, created_at: new Date(Date.now() - 345600000).toISOString(), flags: [] },
        ],
      },
      {
        piece_title: 'Gymnopédie No. 1',
        piece_composer: 'Erik Satie',
        instrument: 'Piano',
        isPinned: false,
        takes: [
          { id: 'mock_5', piece_title: 'Gymnopédie No. 1', piece_composer: 'Erik Satie', instrument: 'Piano', score: 92, created_at: new Date(Date.now() - 518400000).toISOString(), flags: [] },
        ],
      }
    ]

    mockData.forEach(mock => {
      if (!groups[mock.piece_title]) {
        groups[mock.piece_title] = mock
      }
    })

    return Object.values(groups)
  }, [allTakes, isDemo])

  // Handle active thread and selected take resolution
  const activeThread = useMemo(() => {
    return threads.find(t => t.piece_title === activeThreadTitle) || threads[0]
  }, [threads, activeThreadTitle])

  const takesForActiveThread = useMemo(() => {
    return activeThread?.takes ?? []
  }, [activeThread])

  const take = useMemo(() => {
    if (selectedTakeId) {
      return takesForActiveThread.find(t => t.id === selectedTakeId) || takesForActiveThread[0]
    }
    return takesForActiveThread[0]
  }, [takesForActiveThread, selectedTakeId])

  // Keep the active thread valid. If the current selection isn't among the
  // available threads (e.g. a real user whose demo defaults are no longer
  // injected, or after deleting the last take), fall back to the newest thread.
  useEffect(() => {
    if (threads.length > 0 && !threads.some(t => t.piece_title === activeThreadTitle)) {
      setActiveThreadTitle(threads[0].piece_title)
    }
  }, [threads, activeThreadTitle])

  // Load annotations when teacher views a take (must be after `take` is declared above)
  useEffect(() => {
    if (profile?.role !== 'teacher' || !take?.id || isDemo) {
      setAnnotations({})
      return
    }
    const takeId = take.id
    if (String(takeId).startsWith('mock') || String(takeId) === 'demo') { setAnnotations({}); return }
    if (!analysisAuthToken) return

    fetch(
      `${supabase.supabaseUrl}/functions/v1/annotate-flags?takeId=${encodeURIComponent(takeId)}`,
      { headers: { Authorization: `Bearer ${analysisAuthToken}` } },
    ).then(r => r.json()).then(data => {
      const map = {}
      for (const a of (data.annotations ?? [])) map[a.flag_index] = a
      setAnnotations(map)
    }).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.role, take?.id, analysisAuthToken, isDemo])

  // Load the active take's saved AI-context note into the editor
  useEffect(() => {
    setNoteDraft(take?.note ?? '')
    setNoteSaved(false)
  }, [take?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Save the per-take AI-context note (does not re-run analysis)
  async function saveNote() {
    if (noteSaving || isDemo || !take?.id || !user?.id) return
    setNoteSaving(true)
    try {
      await supabase.from('takes').update({ note: noteDraft.trim() }).eq('id', take.id)
      setAllTakes(prev => prev.map(t => t.id === take.id ? { ...t, note: noteDraft.trim() } : t))
      setNoteSaved(true)
      setTimeout(() => setNoteSaved(false), 2200)
    } catch (e) {
      console.error('[save-note]', e)
    } finally {
      setNoteSaving(false)
    }
  }

  // Re-run analysis on this same recording, now with the note as context
  async function reanalyzeWithNote() {
    if (reanalyzing || isDemo || !take?.video_path || !user?.id) return
    setReanalyzing(true)
    try {
      // Persist the note first so it travels with the take
      await supabase.from('takes').update({ note: noteDraft.trim() }).eq('id', take.id).catch(() => {})
      const { data: jobResult, error: fnError } = await supabase.functions.invoke('analyze-performance', {
        body: {
          videoPath:     take.video_path,
          videoMimeType: 'video/mp4',
          scorePath:     take.score_path || null,
          pieceTitle:    take.piece_title,
          composer:      take.piece_composer,
          instrument:    take.instrument,
          songId:        activeSongId ?? null,
          notes:         noteDraft.trim() || undefined,
        },
      })
      if (fnError || jobResult?.error) throw new Error(jobResult?.error || fnError?.message)
      const jobId = jobResult?.jobId
      let completed = null
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 4000))
        const { data, error } = await supabase.from('takes').select('*').eq('id', jobId).single()
        if (!error && data && data.job_status === 'done') { completed = data; break }
      }
      if (completed) {
        setAllTakes(prev => [completed, ...prev.filter(t => t.id !== completed.id)])
        setSelectedTakeId(completed.id)
      } else {
        throw new Error('Re-analysis timed out')
      }
    } catch (e) {
      console.error('[reanalyze]', e)
    } finally {
      setReanalyzing(false)
    }
  }

  // Show analysis onboarding the first time a real take loads
  useEffect(() => {
    const isRealTake = take && !take._demo && !String(take.id).startsWith('mock') && String(take.id) !== 'demo'
    if (!isDemo && isRealTake && !localStorage.getItem('mediant_analysis_intro')) {
      const t = setTimeout(() => setShowAnalysisIntro(true), 600)
      return () => clearTimeout(t)
    }
  }, [take, isDemo])

  // Set default active thread if takeId query parameter exists
  useEffect(() => {
    if (takeId && allTakes.length > 0) {
      const target = allTakes.find(t => t.id === takeId)
      if (target?.piece_title) {
        setActiveThreadTitle(target.piece_title)
        setSelectedTakeId(target.id)
      }
    }
  }, [takeId, allTakes])

  // Resolve signed URLs for Supabase media
  useEffect(() => {
    setScoreUrl(null)
    setVideoUrl(null)
    setScoreReady(false)
    setHighlights([])
    
    if (!take) return
    
    if (take._demo || String(take.id).startsWith('mock')) {
      setScoreReady(true)
      if (take.piece_title === 'Procession of the Nobles') {
        setScoreUrl('/Clarinet.png')
        setVideoUrl('https://assets.mixkit.co/videos/preview/mixkit-playing-the-clarinet-close-up-41372-large.mp4')
      } else if (take.piece_title === 'Clair de lune') {
        setScoreUrl('/scores/clair-de-lune-preview.png')
        setVideoUrl('https://assets.mixkit.co/videos/preview/mixkit-hands-of-a-pianist-playing-piano-34288-large.mp4')
      }
      return
    }

    if (take.score_path) {
      supabase.storage
        .from('sheet-music')
        .createSignedUrl(take.score_path, 86400)
        .then(({ data }) => { if (data?.signedUrl) setScoreUrl(data.signedUrl) })
    }

    if (take.video_path) {
      supabase.storage
        .from('recordings')
        .createSignedUrl(take.video_path, 86400)
        .then(({ data }) => { if (data?.signedUrl) setVideoUrl(data.signedUrl) })
    }
  }, [take])

  // Chat mapping state resolvers
  const chatMessages = useMemo(() => {
    return threadChats[activeThreadTitle] || INITIAL_AI_MESSAGES[activeThreadTitle] || [
      {
        role: 'assistant',
        content: `Hi! This is the discussion thread for **${activeThreadTitle}**. Feel free to ask me anything about your practice or upload a new recording to analyze!`,
      }
    ]
  }, [threadChats, activeThreadTitle])

  const setChatMessages = useCallback((updater) => {
    setThreadChats(prev => {
      const current = prev[activeThreadTitle] || INITIAL_AI_MESSAGES[activeThreadTitle] || [
        {
          role: 'assistant',
          content: `Hi! This is the discussion thread for **${activeThreadTitle}**. Feel free to ask me anything about your practice or upload a new recording to analyze!`,
        }
      ]
      const next = typeof updater === 'function' ? updater(current) : updater
      return { ...prev, [activeThreadTitle]: next }
    })
  }, [activeThreadTitle])

  // Loop the active excerpt when isLooping is enabled
  useEffect(() => {
    const video = videoRef.current
    if (!video || !isLooping || !loopRef.current) return
    const { start, end } = loopRef.current

    function seekAndPlay() {
      try { video.currentTime = start } catch {}
      video.play().catch(() => {})
    }

    if (video.readyState >= 1) {
      seekAndPlay()
    } else {
      video.addEventListener('loadedmetadata', seekAndPlay, { once: true })
    }

    function onTimeUpdate() {
      const t = videoRef.current?.currentTime ?? start
      setCurrentTime(t)
      if (t >= end) {
        try { videoRef.current.currentTime = start } catch {}
      }
    }
    video.addEventListener('timeupdate', onTimeUpdate)
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('loadedmetadata', seekAndPlay)
      video.pause()
    }
  }, [isLooping])

  const seekTo = useCallback((sec) => {
    const video = videoRef.current
    if (!video) return
    try { video.currentTime = sec } catch {}
    video.play().catch(() => {})
  }, [])

  const startLoop = useCallback((flag) => {
    if (flag?.timestamp_start == null || flag?.timestamp_end == null) return
    const start = Number(flag.timestamp_start)
    const end   = Number(flag.timestamp_end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return
    loopRef.current = { start, end }
    setIsLooping(true)
  }, [])

  const stopLoop = useCallback(() => {
    setIsLooping(false)
    loopRef.current = null
  }, [])

  useEffect(() => { stopLoop() }, [activeFlag, stopLoop])

  const annotBtnStyle = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 4,
    color: 'var(--text-muted)',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '0.75rem',
    fontWeight: 600,
    padding: '3px 8px',
    transition: 'background 140ms ease, color 140ms ease, border-color 140ms ease',
  }

  const activeFlagIndex = activeFlag ? parseInt(activeFlag.replace('flag_', ''), 10) : -1
  const activeFlagRaw   = take?.flags?.[activeFlagIndex] ?? null
  const hasTimestamps   = activeFlagRaw?.timestamp_start != null && activeFlagRaw?.timestamp_end != null
    && Number(activeFlagRaw.timestamp_end) > Number(activeFlagRaw.timestamp_start)

  const flagsMap = take?.flags?.length
    ? Object.fromEntries(
        take.flags.map((f, i) => [
          `flag_${i}`,
          { tag: `${f.measure_end ? `Measures ${f.measure}–${f.measure_end}` : `Measure ${f.measure}`} · ${capitalize(f.type)}`, title: f.title, body: f.detail ?? f.body ?? '', confidence: f.confidence ?? 100 },
        ])
      )
    : {}

  const chips = take?.flags?.length
    ? take.flags.map((f, i) => ({
        flag:       `flag_${i}`,
        label:      `m.${f.measure}${f.measure_end ? `–${f.measure_end}` : ''} · ${capitalize(f.type)}`,
        confidence: f.confidence ?? 100,
      }))
    : []

  // Auto-seek video to flag timestamp when selected
  useEffect(() => {
    if (!activeFlagRaw) return
    const start = Number(activeFlagRaw.timestamp_start)
    const end   = Number(activeFlagRaw.timestamp_end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return

    const video = videoRef.current
    if (!video) return
    try { video.currentTime = start } catch {}
  }, [activeFlagRaw])

  // OSMD sheet music loader
  useEffect(() => {
    if (!scoreEl.current || scoreReady) return
    
    const pieceTitle = take?.piece_title ?? ''
    const scoreFile = scoreUrl ?? scoreFileForPiece(pieceTitle)

    if (!scoreFile) {
      setScoreReady(true)
      return
    }

    const flagMeasures = new Map() // Map<measureNum, { flagIds: string[], types: string[] }>
    if (take?.flags?.length) {
      take.flags.forEach((f, i) => {
        const endMeasure = f.measure_end ?? f.measure
        for (let m = f.measure; m <= endMeasure; m++) {
          const existing = flagMeasures.get(m) ?? { flagIds: [], types: [] }
          existing.flagIds.push(`flag_${i}`)
          existing.types.push(f.type ?? '')
          flagMeasures.set(m, existing)
        }
      })
    }

    const osmd = new OpenSheetMusicDisplay(scoreEl.current, {
      autoResize: true,
      backend: 'svg',
      drawTitle: false,
      drawComposer: false,
      drawCredits: false,
      drawPartNames: false,
      drawMeasureNumbers: true,
      measureNumberInterval: 1,
    })
    osmdRef.current = osmd

    osmd.load(scoreFile)
      .then(() => {
        osmd.render()
        setScoreReady(true)

        try {
          const measureList = osmd.GraphicSheet.MeasureList
          const zoom = osmd.zoom * 10
          const newHighlights = []

          flagMeasures.forEach(({ flagIds, types }, measureNum) => {
            const row = measureList[measureNum - 1]
            if (!row) return
            const gm = row[0]
            if (!gm) return
            const pos = gm.PositionAndShape
            newHighlights.push({
              flagIds,
              primaryType: types[0] ?? '',
              measureNum,
              x: pos.AbsolutePosition.x * zoom,
              y: pos.AbsolutePosition.y * zoom,
              w: pos.Size.width * zoom,
              h: pos.Size.height * zoom,
            })
          })
          setHighlights(newHighlights)
        } catch (e) {
          console.warn('Could not render measure highlights:', e)
        }
      })
      .catch(err => {
        console.error('OSMD load error:', err)
        setScoreReady(true)
      })
  }, [take, scoreUrl, scoreReady])

  // Scroll chat area
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, chatLoading])

  // Sync speed modifiers
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = videoSpeed
  }, [videoSpeed])

  // Keyboard shortcuts
  kbRef.current = { activeFlagIndex, activeFlagRaw, chips, hasTimestamps, isLooping }
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const s = kbRef.current
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault()
        const v = videoRef.current
        if (v) { if (v.paused) v.play().catch(() => {}); else v.pause() }
      }
      if (e.key === 'Escape') setActiveFlag(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Teacher annotation helpers
  async function submitAnnotation(flagIndex, action, extras = {}) {
    if (!analysisAuthToken || !take?.id) return
    setAnnotLoading(prev => ({ ...prev, [flagIndex]: true }))
    try {
      const originalFlag = take.flags?.[flagIndex] ?? null
      const body = { takeId: take.id, flagIndex: action === 'add' ? null : flagIndex, action, originalFlag, ...extras }
      const res = await fetch(
        `${supabase.supabaseUrl}/functions/v1/annotate-flags`,
        { method: 'POST', headers: { Authorization: `Bearer ${analysisAuthToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      )
      const data = await res.json()
      if (data.error) return
      setAnnotations(prev => ({ ...prev, [flagIndex ?? 'added']: data.annotation }))
      setActiveAnnot(null)
    } catch { /* ignore */ }
    finally { setAnnotLoading(prev => ({ ...prev, [flagIndex]: false })) }
  }

  async function deleteAnnotation(flagIndex) {
    if (!analysisAuthToken || !take?.id) return
    await fetch(
      `${supabase.supabaseUrl}/functions/v1/annotate-flags?takeId=${encodeURIComponent(take.id)}&flagIndex=${flagIndex}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${analysisAuthToken}` } },
    ).catch(() => {})
    setAnnotations(prev => { const n = { ...prev }; delete n[flagIndex]; return n })
  }

  // Generate Session Summary
  async function generateSummary() {
    if (!take?.flags?.length) return
    setSummaryLoading(true)
    setSummaryError(null)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('analysis-summary', {
        body: {
          pieceTitle:    take.piece_title    ?? '',
          pieceComposer: take.piece_composer ?? '',
          instrument:    take.instrument     ?? null,
          score:         take.score          ?? null,
          flags:         take.flags,
        },
      })
      if (fnErr) throw new Error(fnErr.message ?? String(fnErr))
      if (data?.error) throw new Error(data.error)
      setSummary(data.summary)
    } catch (err) {
      console.error('[analysis-summary]', err)
      setSummaryError('Could not generate summary. Try again.')
    } finally {
      setSummaryLoading(false)
    }
  }

  // Clear stale summary when the take changes, then auto-generate
  useEffect(() => {
    setSummary(null)
    setSummaryError(null)
    if (take && take.flags?.length && !take._polling) {
      generateSummary()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take?.id])

  // ChatGPT conversational questioning loop
  async function sendMessage(chipText) {
    const msg = (chipText ?? chatInput).trim()
    if (!msg || chatLoading) return
    setChatInput('')

    const flagContext = activeFlagRaw
      ? { measure: activeFlagRaw.measure, type: activeFlagRaw.type, title: activeFlagRaw.title }
      : null

    setChatMessages(prev => [...prev, { role: 'user', content: msg, flagContext }])
    setChatLoading(true)
    playPop()

    if (user?.id && !isDemo) {
      try {
        const { data, error } = await supabase.functions.invoke('coach-chat', {
          body: {
            message: msg,
            context: {
              pieceTitle:    activeThreadTitle,
              pieceComposer: activeThread?.piece_composer ?? '',
              instrument:    activeThread?.instrument ?? null,
              flags:         take?.flags ?? [],
              activeFlag:    flagContext ?? null,
            },
            history:  chatMessages,
            songId:   activeSongId ?? null,
          },
        })
        if (error) throw new Error(error.message)
        setChatMessages(prev => [...prev, { role: 'assistant', content: data?.reply ?? '' }])
      } catch {
        setChatMessages(prev => [...prev, { role: 'assistant', content: "Sorry, I couldn't reach the coaching engine. Please try again." }])
      } finally {
        setChatLoading(false)
      }
    } else {
      // Mock ChatGPT Responses for premium feel offline
      setTimeout(() => {
        let reply = "That is a great observation! "
        if (msg.toLowerCase().includes('opening') || msg.toLowerCase().includes('measure 5')) {
          reply = "For the opening of **Clair de lune** (m.5 run), focus on complete physical relaxation in your wrist. Play the triplets hands-separately at a slow tempo (♩=45). Subdivide each beat with your metronome, keeping a lightweight touch so the melody flows effortlessly."
        } else if (msg.toLowerCase().includes('rushed') || msg.toLowerCase().includes('measure 14')) {
          reply = "The subito forte in measure 14 is often struck out of excitement, which raises the percussive tone. To fix this, keep your fingers in contact with the keys *before* you play. Use your forearm and shoulder weight to depress the keybed deeply and warmly, avoiding an abrupt claw strike."
        } else if (msg.toLowerCase().includes('balance') || msg.toLowerCase().includes('left-hand')) {
          reply = "To balance the hands perfectly, practice dynamic scaling. The right-hand melody should be played at a singing *mezzoforte* (weighted keys), while the left-hand chords are played *pianissimo* (brushing the keys lightly). Try playing the left hand separately until it feels like a soft ambient backdrop."
        } else {
          reply = `In this take, your dynamic voicing is very strong. Focus on maintaining a loose wrist on the crossovers and keep your pedaling clear on the chord shifts (especially around measure 21 F♯ bass octave). Let's continue working on these focus areas!`
        }
        
        setChatMessages(prev => [...prev, { role: 'assistant', content: reply }])
        setChatLoading(false)
      }, 1500)
    }
  }

  // Follow-up recording upload picker
  function triggerFileUpload() {
    playNav()
    fileInputRef.current?.click()
  }

  async function handleFileUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return

    const userMsg = `Uploaded follow-up take: "${file.name}"`
    setChatMessages(prev => [...prev, { role: 'user', content: userMsg }])
    
    setChatLoading(true)

    // Append analysis status bubble
    const nextTakeNum = takesForActiveThread.length + 1
    setChatMessages(prev => [...prev, {
      role: 'assistant',
      content: `[Mediant is analyzing your follow-up recording (Take ${nextTakeNum})... This will take a moment.]`
    }])

    if (user?.id && !isDemo) {
      try {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-')
        const filePath = `${user.id}/${Date.now()}-${safeName}`
        
        const { error: uploadError } = await supabase.storage
          .from('recordings')
          .upload(filePath, file, { contentType: file.type || 'video/mp4', upsert: false })
        if (uploadError) throw new Error(uploadError.message)

        const { data: jobResult, error: fnError } = await supabase.functions.invoke('analyze-performance', {
          body: {
            videoPath:      filePath,
            videoMimeType:  file.type || 'video/mp4',
            scorePath:      take?.score_path || null,
            pieceTitle:     activeThreadTitle,
            composer:       activeThread?.piece_composer,
            instrument:     activeThread?.instrument,
            songId:         activeSongId ?? null,
            notes:          noteDraft.trim() || undefined,
          }
        })
        if (fnError || jobResult?.error) throw new Error(jobResult?.error || fnError?.message)

        const jobId = jobResult?.jobId
        let completedTake = null
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 4000))
          const { data, error } = await supabase
            .from('takes')
            .select('*')
            .eq('id', jobId)
            .single()
          if (!error && data && data.job_status === 'done') {
            completedTake = data
            break
          }
        }

        if (completedTake) {
          setAllTakes(prev => [completedTake, ...prev])
          setSelectedTakeId(completedTake.id)

          const scoreDiff = completedTake.score - (take?.score ?? 0)
          const reply = `Analysis complete for Take ${nextTakeNum}! \n\n**New Score: ${completedTake.score}/100** (${scoreDiff >= 0 ? '+' : ''}${scoreDiff} difference).\n\nHere is a quick summary of what changed:\n${completedTake.flags?.map(f => `- **m.${f.measure}${f.measure_end ? `–${f.measure_end}` : ''}**: ${f.title}`).join('\n') || '- No critical issues flagged!'}\n\nI've loaded your new take on screen. What should we work on next?`
          
          setChatMessages(prev => {
            const clean = prev.slice(0, prev.length - 1)
            return [...clean, { role: 'assistant', content: reply }]
          })
        } else {
          throw new Error('Analysis polling timed out')
        }
      } catch (err) {
        console.error(err)
        setChatMessages(prev => {
          const clean = prev.slice(0, prev.length - 1)
          return [...clean, { role: 'assistant', content: `Sorry, there was an issue running the edge analyzer: ${err.message}. Please try again.` }]
        })
      } finally {
        setChatLoading(false)
      }
    } else {
      // Mock follow-up upload response for high-fidelity demo sandbox
      setTimeout(() => {
        const newScore = Math.min(100, Math.max(0, (take?.score ?? 82) + 3))
        
        const newMockTake = {
          ...DEMO_TAKE,
          id: `mock_take_${nextTakeNum}_${Date.now()}`,
          piece_title: activeThreadTitle,
          piece_composer: activeThread?.piece_composer,
          instrument: activeThread?.instrument,
          score: newScore,
          created_at: new Date().toISOString(),
          flags: [
            {
              measure: 14,
              type: 'dynamics',
              confidence: 95,
              title: 'Subito forte is resolved',
              detail: 'Outstanding dynamic control! The keys are beautifully weighted and the fortissimo has rich, ringing harmonics rather than a percussive strike. Excellent adjust!',
              timestamp_start: 22.4,
              timestamp_end: 23.9,
            },
            {
              measure: 5,
              type: 'timing',
              confidence: 92,
              title: 'Triplet run descent is steady',
              detail: 'Terrific job adjusting your hand tension. The notes roll evenly, arriving precisely on beat 3. Rushing resolved.',
              timestamp_start: 8.2,
              timestamp_end: 10.1,
            },
            {
              measure: 27,
              type: 'technique',
              confidence: 82,
              title: 'Thumb tuck on inner voice D♭',
              detail: 'The thumb crosses under the hand awkwardly on the D♭ in m.27. Keep working on hands separately to voice this smoothly.',
              timestamp_start: 46.8,
              timestamp_end: 48.3,
            }
          ]
        }

        setAllTakes(prev => [newMockTake, ...prev])
        setSelectedTakeId(newMockTake.id)

        const reply = `Analysis complete for **Take ${nextTakeNum}**! \n\n**New Score: ${newScore}/100** (+3 increase from your last take!).\n\nHere is what changed:\n- **m.14 (Dynamics) [RESOLVED]**: Superb dynamics. The chord is deeply weighted from the shoulder, producing a warm singing tone.\n- **m.5 (Timing) [RESOLVED]**: Triplets are steady and aligned.\n- **m.27 (Technique) [REMAINING]**: Thumb tuck is still slightly heavy. Let's practice hands separately to ease the thumb crossover.\n\nI've updated your sheet music view to show the remaining spots. Excellent progress!`

        setChatMessages(prev => {
          const clean = prev.slice(0, prev.length - 1)
          return [...clean, { role: 'assistant', content: reply }]
        })
        setChatLoading(false)
      }, 4000)
    }
  }

  async function handleDeleteTake() {
    if (!take) return
    const isConfirmed = window.confirm(`Are you sure you want to delete this recording analysis (Score: ${take.score ?? '—'})? This action cannot be undone.`)
    if (!isConfirmed) return

    playPop()
    const targetTakeId = take.id
    
    // 1. Delete from Supabase if real
    const isDemoOrMock = !targetTakeId || String(targetTakeId).startsWith('mock') || String(targetTakeId) === 'demo' || take._demo
    if (user?.id && !isDemoOrMock) {
      try {
        const { error } = await supabase
          .from('takes')
          .delete()
          .eq('id', targetTakeId)
        if (error) throw new Error(error.message)
        
        if (take.video_path) supabase.storage.from('recordings').remove([take.video_path]).catch(() => {})
        if (take.score_path) supabase.storage.from('sheet-music').remove([take.score_path]).catch(() => {})
      } catch (err) {
        alert(`Could not delete take: ${err.message}`)
        return
      }
    }
    
    // 2. Update local state
    setAllTakes(prev => prev.filter(t => t.id !== targetTakeId))
    
    // 3. Reset active thread selections
    const remainingTakes = takesForActiveThread.filter(t => t.id !== targetTakeId)
    if (remainingTakes.length > 0) {
      setSelectedTakeId(remainingTakes[0].id)
    } else {
      setSelectedTakeId(null)
      const nextThread = threads.find(th => th.piece_title !== activeThreadTitle && th.takes?.length > 0)
      if (nextThread) {
        setActiveThreadTitle(nextThread.piece_title)
      }
      setActiveFlag(null)
    }
  }

  // Sheet music/PDF fallbacks
  const isVisualScore = scoreUrl && (() => {
    const p = (take?.score_path ?? '').toLowerCase()
    return /\.(jpe?g|png|webp|heic|pdf)$/.test(p)
  })()
  const isPdfScore = isVisualScore && (take?.score_path ?? '').toLowerCase().endsWith('.pdf')
  const isImageScore = isVisualScore && !isPdfScore

  const overallConfidence = useMemo(() => {
    if (!take) return 0;
    if (take.piece_title === 'Procession of the Nobles') return 68;
    if (take.analysis_quality?.overall_confidence) return take.analysis_quality.overall_confidence;
    if (take.flags?.length) {
      const sum = take.flags.reduce((acc, f) => acc + (f.confidence ?? 80), 0);
      return Math.round(sum / take.flags.length);
    }
    return 85; // Default fallback
  }, [take]);

  const activeSummary = useMemo(() => {
    if (take?.piece_title === 'Procession of the Nobles' || activeThreadTitle === 'Procession of the Nobles') {
      return {
        headline: "Solid fundamentals with posture and hand position refinements needed.",
        overview: "You're playing with musicality and making real progress at 72/100—the core technique is solid. What's holding you back are several interconnected postural and hand-positioning habits that are adding unnecessary friction to your playing.",
        strengths: [
          "Tone & Embouchure: Secure fundamentals with consistent air support and controlled tone production.",
          "Rhythmic Accuracy: You're tracking the time signature clearly with minimal technical hiccups.",
          "Breath Coordination: Longer phrases are supported well with steady breathing and diaphragm control."
        ],
        improvements: [
          { area: "Right Hand Finger Height", guidance: "Fingers hovering too high. Drill with scales at hand level for 2 weeks to reprogram muscle memory." },
          { area: "Left Thumb Register Key Angle", guidance: "Thumb angle pressing awkwardly on register key. Isolate B–C#–D long tones daily." },
          { area: "Instrument Angle & Embouchure Stability", guidance: "Instrument angle tilted too far outward from body. Mirror practice recommended." }
        ],
        drills: [
          { name: "Right Hand Scales (Hand Level)", duration: "5 min", frequency: "Daily", type: "spinner" },
          { name: "Left Thumb Key Angle Drill", duration: "5 min", frequency: "Daily", type: "key" },
          { name: "Mirror Posture & Embouchure Check", duration: "10 min", frequency: "Daily", type: "mirror" }
        ]
      };
    }
    if (summary) {
      const strengths = summary.strengths ?? [];
      const improvements = summary.improvements ?? [];
      return {
        headline: summary.headline ?? "Performance Analysis Complete",
        overview: summary.overview ?? "Review your score breakdown, key strengths, and recommended focus areas below.",
        strengths: strengths.map(s => typeof s === 'string' ? s : `${s.title ?? s.area}: ${s.detail ?? s.guidance}`),
        improvements: improvements.map(imp => ({
          area: imp.area ?? "Focus Area",
          guidance: imp.guidance ?? imp.detail ?? imp
        })),
        drills: (take?.flags ?? []).slice(0, 3).map((f, i) => ({
          name: `${capitalize(f.type)} m.${f.measure} Isolation`,
          duration: "5 min",
          frequency: "Daily",
          type: i % 2 === 0 ? "spinner" : "key"
        }))
      };
    }
    return {
      headline: "Great control of phrasing and dynamics.",
      overview: "Your performance shows a strong emotional connection. Focus on smoothing out triplets and stabilizing hand shifts.",
      strengths: [
        "Tone & Touch: Weight-based control over soft dynamics in the opening theme.",
        "Rubato Control: Tasteful pacing variations that enhance the emotional shape.",
        "Pedaling Flow: Dampers are used effectively to blend register changes."
      ],
      improvements: [
        { area: "Triplet Run Evenness", guidance: "Rushing in m.5. Practice slowly with subdivisions to align the notes." },
        { area: "Subito Forte Weight", guidance: "Chords in m.14 are struck too percussively. Use arm weight from the shoulder." },
        { area: "Pedal Clearness", guidance: "Dampers slightly blur the lower octave in m.21. Clear the pedal before key contact." }
      ],
      drills: [
        { name: "Slow Triplet Subdivisions", duration: "5 min", frequency: "Daily", type: "spinner" },
        { name: "Arm-Weight Chord Placement", duration: "5 min", frequency: "Daily", type: "key" },
        { name: "Damper Release Timing", duration: "10 min", frequency: "Daily", type: "mirror" }
      ]
    };
  }, [summary, take, activeThreadTitle]);

  const pieceTitle = activeThreadTitle
  const pieceComposer = activeThread?.piece_composer ?? ''
  const instrument = activeThread?.instrument ?? ''
  const score = take?.score ?? null
  const issueCount = chips.length
  const analysisQuality = take?.analysis_quality ?? null
  const info = activeFlag ? flagsMap[activeFlag] : null

  const subtext = useMemo(() => {
    const parts = []
    if (pieceComposer && pieceComposer !== 'Unknown') parts.push(pieceComposer)
    if (instrument) parts.push(instrument)
    const ago = timeAgo(take?.created_at ?? take?.date)
    if (ago) parts.push(`Analyzed ${ago}`)
    return parts.join(' · ')
  }, [pieceComposer, instrument, take])

  const sortedChips = useMemo(() => {
    return [...chips].sort((a, b) => {
      const ia = parseInt(a.flag.replace('flag_', ''), 10)
      const ib = parseInt(b.flag.replace('flag_', ''), 10)
      const ma = take?.flags?.[ia]?.measure ?? 0
      const mb = take?.flags?.[ib]?.measure ?? 0
      return ma - mb
    })
  }, [chips, take?.flags])

  const aspectScores = useMemo(() => computeAspectScores(take), [take])


  // Compute flagged bar indices from actual flag measures (scaled to bar count)
  const flaggedBarIndices = useMemo(() => {
    const flags = take?.flags ?? []
    if (!flags.length) return [6, 7, 14, 15, 22, 23]
    const maxMeasure = Math.max(...flags.map(f => f.measure ?? 0), 30)
    return flags.map(f => Math.round(((f.measure ?? 1) / maxMeasure) * (HEADER_WAVE_BARS.length - 1)))
  }, [take?.flags])

  // Real user with no recordings yet — show a friendly empty state instead of
  // the full analysis UI populated with placeholder numbers.
  if (!isDemo && takesLoaded && threads.length === 0) {
    return (
      <div className={aStyles.pageShell}>
        <main className={aStyles.mainPageContent}>
          <div className={aStyles.analysisPageHeader}>
            <div className={aStyles.analysisPageHeaderLeft}>
              <h1 className={aStyles.analysisPageTitle}>Sessions</h1>
              <p className={aStyles.analysisPageSubtitle}>Your analyzed performances will show up here.</p>
            </div>
          </div>
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
            gap: 14, padding: '64px 24px', margin: '8px auto 0', maxWidth: 460,
          }}>
            <div style={{
              fontSize: 38, lineHeight: 1, width: 84, height: 84, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--bg-card, rgba(255,255,255,0.04))', color: 'var(--accent)',
              border: '1px solid var(--border, rgba(255,255,255,0.08))',
            }}>♪</div>
            <h2 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text)' }}>No sessions yet</h2>
            <p style={{ margin: 0, color: 'var(--text-soft)', lineHeight: 1.5 }}>
              Record your first take and Mediant will break down your timing, dynamics, and intonation right here.
            </p>
            <button className={aStyles.analysisNewSessionBtn} style={{ marginTop: 8 }} onClick={() => nav('/record')}>
              Record your first take →
            </button>
          </div>
        </main>
      </div>
    )
  }

  const scoreAreaContent = (
    <div className={`${styles.scoreArea} ${aStyles.scoreAreaPolish} ${isImageScore ? `${styles.scoreAreaImage} ${aStyles.scoreAreaImagePolish}` : ''}`}>
      {isVisualScore && scoreUrl && (
        isPdfScore ? (
          <iframe src={scoreUrl} className={`${styles.scorePdf} ${aStyles.scorePdfPolish}`} title="Sheet music" />
        ) : (
          <div className={`${styles.scorePhotoWrap} ${aStyles.scorePhotoWrapPolish}`}>
            <img src={scoreUrl} className={`${styles.scorePhoto} ${aStyles.scorePhotoPolish}`} alt="Sheet music" loading="lazy" />
            {(take?.flags ?? []).map((f, i) => {
              if (!f.spot) return null
              const flagId = `flag_${i}`
              if (activeFlag !== flagId) return null
              const [y0, x0, y1, x1] = f.spot
              const cx = (x0 + x1) / 2 / 10, cy = (y0 + y1) / 2 / 10
              const w = (x1 - x0) / 10, h = (y1 - y0) / 10
              return (
                <div key={flagId}
                  style={{
                    position: 'absolute', left: `${cx}%`, top: `${cy}%`,
                    width: `${w}%`, height: `${h}%`,
                    transform: 'translate(-50%, -50%)',
                    background: 'rgba(184,146,42,0.3)', borderRadius: 4,
                  }}
                />
              )
            })}
          </div>
        )
      )}
      {!isVisualScore && (
        <>
          {take?._demo && (
            <div style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <img src="/scores/clair-de-lune-preview.png" alt="Clair de lune Sheet music"
                style={{ width: '100%', borderRadius: 8, opacity: 0.9, boxShadow: 'var(--shadow-sm)' }}
                onError={(e) => {
                  e.target.style.display = 'none'
                }}
              />
              <div style={{
                position: 'absolute', left: '20%', top: '35%', width: '15%', height: '12%',
                background: activeFlag === 'flag_0' ? 'rgba(184,146,42,0.22)' : 'rgba(184,146,42,0.06)',
                border: `2px solid ${activeFlag === 'flag_0' ? 'var(--accent)' : 'var(--accent-border)'}`,
                borderRadius: 6, cursor: 'pointer', transition: 'all 0.2s'
              }} onClick={() => { playTick(); setActiveFlag('flag_0') }} />
              <div style={{
                position: 'absolute', left: '55%', top: '55%', width: '18%', height: '12%',
                background: activeFlag === 'flag_1' ? 'rgba(184,146,42,0.22)' : 'rgba(184,146,42,0.06)',
                border: `2px solid ${activeFlag === 'flag_1' ? 'var(--accent)' : 'var(--accent-border)'}`,
                borderRadius: 6, cursor: 'pointer', transition: 'all 0.2s'
              }} onClick={() => { playTick(); setActiveFlag('flag_1') }} />
            </div>
          )}
          {!take?._demo && !scoreFileForPiece(pieceTitle) && scoreReady && (
            <div className={styles.scoreUnavailable}>
              <p>Sheet music is not uploaded for this session.</p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>Comparative review is based on audio playback.</p>
            </div>
          )}
          <div style={{ position: 'relative' }}>
            <div ref={scoreEl} />
            {scoreReady && highlights.map(({ flagIds, primaryType, measureNum, x, y, w, h }) => {
              const isMeasureActive = flagIds.includes(activeFlag)
              const TYPE_RGB = { iconGreen: '88,121,101', iconCoral: '207,63,63', iconGold: '184,146,42' }
              const rgb = TYPE_RGB[flagTypeMeta(primaryType).cls] ?? TYPE_RGB.iconGold
              return (
                <div key={measureNum}
                  onClick={() => {
                    playTick()
                    setActiveFlag(prev => {
                      if (!isMeasureActive) return flagIds[0]
                      const idx = flagIds.indexOf(prev)
                      if (idx === flagIds.length - 1) return null
                      return flagIds[idx + 1]
                    })
                  }}
                  style={{
                    position: 'absolute', left: x, top: y, width: w, height: h,
                    background: isMeasureActive ? `rgba(${rgb},0.22)` : `rgba(${rgb},0.12)`,
                    border: `1.5px solid rgba(${rgb},${isMeasureActive ? '0.65' : '0.3'})`,
                    borderRadius: 6, cursor: 'pointer', transition: 'background 150ms ease',
                  }}
                />
              )
            })}
          </div>
        </>
      )}
    </div>
  )

  return (
    <div className={aStyles.pageShell}>
      {/* Hidden file input for uploads */}
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        accept="audio/*,video/*"
        onChange={handleFileUpload}
      />

      {/* ───── MAIN CONTENT AREA ───── */}
      <main className={aStyles.mainPageContent}>

        {/* ── Page header ── */}
        <div className={aStyles.analysisPageHeader}>
          <div className={aStyles.analysisPageHeaderLeft}>
            <h1 className={aStyles.analysisPageTitle}>Sessions</h1>
            <p className={aStyles.analysisPageSubtitle}>
              {pieceTitle || 'Select a session below'}{pieceComposer ? ` · ${pieceComposer}` : ''}
            </p>
          </div>
          <button className={aStyles.analysisNewSessionBtn} onClick={() => nav('/record')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New session
          </button>
        </div>

        {/* ── Session strip (horizontal scroll of recent threads) ── */}
        <div className={aStyles.sessionStrip}>
          {threads.map((thread) => {
            const latestTake = thread.takes?.[0]
            const isActive = thread.piece_title === activeThreadTitle
            return (
              <button
                key={thread.piece_title}
                className={`${aStyles.sessionStripCard} ${isActive ? aStyles.sessionStripCardActive : ''}`}
                onClick={() => { playPop(); setActiveThreadTitle(thread.piece_title); setSelectedTakeId(null) }}
              >
                <div className={aStyles.sessionStripTop}>
                  <span className={aStyles.sessionStripPiece}>{thread.piece_title}</span>
                  {latestTake?.score != null && (
                    <span className={aStyles.sessionStripScore} style={{ color: scoreColor(latestTake.score) }}>
                      {latestTake.score}
                    </span>
                  )}
                </div>
                <div className={aStyles.sessionStripMeta}>
                  <span>{thread.piece_composer ?? ''}</span>
                  {latestTake?.created_at && (
                    <span>{timeAgo(latestTake.created_at)}</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>

        {/* Demo banner */}
        {isDemo && (
          <div style={{
            background: 'rgba(92,184,107,0.1)',
            border: '1px solid rgba(92,184,107,0.25)',
            borderRadius: 8,
            color: 'rgba(248,246,242,0.75)',
            fontSize: '0.85rem',
            marginBottom: 16,
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}>
            <span style={{ color: 'var(--hero-green)', fontWeight: 600 }}>Demo</span>
            This is a sample analysis for Clair de lune. Create a free account to analyze your own recordings.
            <a href="#/signup" style={{ color: 'var(--hero-green)', marginLeft: 'auto', textDecoration: 'none', fontWeight: 500, whiteSpace: 'nowrap' }}>
              Get started free →
            </a>
          </div>
        )}

        {/* ── Waveform score header ── */}
        <div className={aStyles.waveHeader}>
          {/* Left: piece info */}
          <div className={aStyles.waveHeaderMeta}>
            <div className={aStyles.waveHeaderTitleRow}>
              <h1 className={aStyles.waveHeaderTitle}>{pieceTitle}</h1>
              {instrument && <span className={aStyles.waveHeaderBadge}>{instrument}</span>}
            </div>
            <p className={aStyles.waveHeaderComposer}>{pieceComposer}</p>
            {takesForActiveThread.length > 0 && (
              <div className={aStyles.waveHeaderTakeRow}>
                <select
                  className={aStyles.waveHeaderTakeSelect}
                  value={selectedTakeId ?? take?.id ?? ''}
                  onChange={(e) => { playTick(); setSelectedTakeId(e.target.value) }}
                >
                  {takesForActiveThread.map((t, idx) => {
                    const takeNum = takesForActiveThread.length - idx
                    return (
                      <option key={t.id} value={t.id}>
                        Take {takeNum} of {takesForActiveThread.length}
                      </option>
                    )
                  })}
                </select>
                <button className={aStyles.waveHeaderDeleteBtn} onClick={handleDeleteTake} title="Delete this take">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
                <span className={aStyles.waveHeaderAnalyzedAt}>{timeAgo(take?.created_at) || '4d ago'}</span>
              </div>
            )}
          </div>

          {/* Center: animated waveform bars */}
          <div className={aStyles.waveHeaderBarsWrap}>
            {HEADER_WAVE_BARS.map((h, i) => (
              <div
                key={i}
                className={`${aStyles.waveHeaderBar} ${flaggedBarIndices.includes(i) ? aStyles.waveHeaderBarFlagged : ''}`}
                style={{ '--barH': `${h}px`, '--d': `${(i * 53) % 720}ms` }}
              />
            ))}
          </div>

          {/* Right: animated metric bars */}
          <div className={aStyles.waveHeaderMetrics}>
            <div className={aStyles.waveHeaderMetricRow}>
              <span className={aStyles.waveHeaderMetricLabel}>Intonation</span>
              <div className={aStyles.waveHeaderMetricTrack}>
                <div ref={hFill1Ref} className={`${aStyles.waveHeaderMetricFill} ${aStyles.waveHeaderFill1}`} style={{ width: `${aspectScores?.intonation ?? 77}%`, background: scoreColor(Math.round(aspectScores?.intonation ?? 77)) }} />
              </div>
              <span ref={hNum1Ref} className={aStyles.waveHeaderMetricVal} style={{ color: scoreColor(Math.round(aspectScores?.intonation ?? 77)) }}>{Math.round(aspectScores?.intonation ?? 77)}</span>
            </div>
            <div className={aStyles.waveHeaderMetricRow}>
              <span className={aStyles.waveHeaderMetricLabel}>Dynamics</span>
              <div className={aStyles.waveHeaderMetricTrack}>
                <div ref={hFill2Ref} className={`${aStyles.waveHeaderMetricFill} ${aStyles.waveHeaderFill2}`} style={{ width: `${aspectScores?.dynamics ?? 83}%`, background: scoreColor(Math.round(aspectScores?.dynamics ?? 83)) }} />
              </div>
              <span ref={hNum2Ref} className={aStyles.waveHeaderMetricVal} style={{ color: scoreColor(Math.round(aspectScores?.dynamics ?? 83)) }}>{Math.round(aspectScores?.dynamics ?? 83)}</span>
            </div>
            <div className={`${aStyles.waveHeaderMetricRow} ${aStyles.waveHeaderMetricRowOverall}`}>
              <span className={aStyles.waveHeaderMetricLabel}>Overall</span>
              <div className={aStyles.waveHeaderMetricTrack}>
                <div ref={hFill3Ref} className={`${aStyles.waveHeaderMetricFill} ${aStyles.waveHeaderFill3}`} style={{ width: `${score ?? 82}%`, background: scoreColor(score ?? 82) }} />
              </div>
              <span ref={hNum3Ref} className={aStyles.waveHeaderMetricVal} style={{ color: scoreColor(score ?? 82) }}>{score ?? 82}</span>
            </div>
          </div>

          {/* Far right: big score + re-analyze */}
          <div className={aStyles.waveHeaderScoreCol}>
            <div className={aStyles.waveHeaderBigScore} style={{ color: scoreColor(score ?? 82) }}>
              {score ?? '—'}
            </div>
            <div className={aStyles.waveHeaderBigScoreDenom}>/100</div>
            <button className={aStyles.waveHeaderReanalyze} onClick={() => nav('/record')}>
              New Session
            </button>
          </div>
        </div>

        {/* ── Metric tiles ── */}
        <div className={aStyles.metricTilesRow}>
          <div className={aStyles.metricTile}>
            <span className={aStyles.metricTileLabel}>ISSUES FLAGGED</span>
            <span className={aStyles.metricTileValue}>{issueCount}</span>
          </div>
          <div className={aStyles.metricTile}>
            <span className={aStyles.metricTileLabel}>MEASURES</span>
            <span className={aStyles.metricTileValue}>
              {take?.flags?.length
                ? Math.max(...take.flags.map(f => f.measure_end ?? f.measure ?? 0))
                : '—'}
            </span>
          </div>
          <div className={aStyles.metricTile}>
            <span className={aStyles.metricTileLabel}>CONFIDENCE</span>
            <span className={aStyles.metricTileValue}>{overallConfidence}%</span>
          </div>
          <div className={aStyles.metricTile}>
            <span className={aStyles.metricTileLabel}>ANALYZED</span>
            <span className={aStyles.metricTileValue} style={{ fontSize: '0.95rem', letterSpacing: '-0.01em' }}>
              {timeAgo(take?.created_at) ?? '—'}
            </span>
          </div>
        </div>

        {/* ── AI context note + re-analyze ── */}
        {!isDemo && (
          <div className={aStyles.noteCard}>
            <div className={aStyles.noteCardHead}>
              <span className={aStyles.noteCardTitle}>NOTES FOR THE AI</span>
              <span className={aStyles.noteCardHint}>Context the AI uses when analyzing this take</span>
            </div>
            <textarea
              className={aStyles.noteCardInput}
              value={noteDraft}
              onChange={e => setNoteDraft(e.target.value)}
              maxLength={800}
              rows={2}
              placeholder="e.g. “sight-reading”, “my piano runs flat”, “recorded on my phone” — then re-analyze to apply it."
            />
            <div className={aStyles.noteCardActions}>
              <button
                className={aStyles.noteSaveBtn}
                onClick={saveNote}
                disabled={noteSaving || reanalyzing || noteDraft.trim() === (take?.note ?? '').trim()}
              >
                {noteSaving ? 'Saving…' : noteSaved ? '✓ Saved' : 'Save note'}
              </button>
              <button
                className={aStyles.noteReanalyzeBtn}
                onClick={reanalyzeWithNote}
                disabled={reanalyzing || !take?.video_path}
              >
                {reanalyzing ? 'Re-analyzing…' : '↻ Re-analyze with this context'}
              </button>
            </div>
          </div>
        )}

        {/* Tab strip */}
        <div className={aStyles.tabStrip}>
          <button
            className={`${aStyles.tab} ${activeTab === 'overview' ? aStyles.tabActive : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            Analysis
          </button>
          <button
            data-onboarding-label="analysis-summary-tab"
            className={`${aStyles.tab} ${activeTab === 'summary' ? aStyles.tabActive : ''}`}
            onClick={() => setActiveTab('summary')}
          >
            Session Summary
          </button>
        </div>

        {activeTab === 'overview' ? (
          <>
            {/* Split scrollable grid layout */}
            <div className={aStyles.reviewLayoutColumns}>
              {/* Left Column: Sheet music (collapsible) */}
              <div className={aStyles.leftLane}>
                <div className={aStyles.laneCard}>
                  <div className={aStyles.laneCardHeader}>
                    <span className={aStyles.laneCardTitle}>SHEET MUSIC</span>
                    <button
                      className={aStyles.laneExpandBtn}
                      onClick={() => setScoreCollapsed(v => !v)}
                      title={scoreCollapsed ? 'Show sheet music' : 'Hide sheet music'}
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        {scoreCollapsed ? (
                          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                        ) : (
                          <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7" />
                        )}
                      </svg>
                    </button>
                  </div>
                  {!scoreCollapsed && (
                    <div className={aStyles.laneCardBody}>
                      {scoreAreaContent}
                    </div>
                  )}
                </div>
              </div>

              {/* Right Column: Insights, video, chat */}
              <div className={aStyles.rightLane}>
                {/* Insights Card */}
                <div className={`${aStyles.laneCard} ${aStyles.insightsCard}`}>
                  <div data-onboarding-label="analysis-flags" className={aStyles.laneCardHeader}>
                    <span className={aStyles.laneCardTitle} style={{ display: 'flex', alignItems: 'center' }}>
                      INSIGHTS
                      {issueCount > 0 && <span className={aStyles.insightCountBadge}>{issueCount}</span>}
                    </span>
                    <div className={aStyles.insightsLegend}>
                      <span className={aStyles.legendLabel}>CONFIDENCE:</span>
                      <span className={aStyles.legendItem}>
                        <span className={aStyles.legendDot} style={{ background: 'var(--accent)' }} /> High
                      </span>
                      <span className={aStyles.legendItem}>
                        <span className={aStyles.legendDot} style={{ background: 'var(--gold)' }} /> Medium
                      </span>
                      <span className={aStyles.legendItem}>
                        <span className={aStyles.legendDot} style={{ background: 'var(--coral)' }} /> Low
                      </span>
                    </div>
                  </div>

                  {issueCount === 0 ? (
                    <div className={aStyles.issueClean}>✓ No issues detected — clean performance.</div>
                  ) : (
                    <div className={aStyles.insightsList}>
                      {take?.flags?.map((f, i) => {
                        const flagId = `flag_${i}`
                        const isActive = activeFlag === flagId
                        const cc = confColor(f.confidence ?? 100)
                        const isThisLooping = isLooping && loopRef.current?.start === Number(f.timestamp_start)
                        const loopStart = Number(f.timestamp_start)
                        const loopEnd = Number(f.timestamp_end)
                        const loopDuration = loopEnd - loopStart
                        const loopProgress = isThisLooping && loopDuration > 0
                          ? Math.min(1, Math.max(0, (currentTime - loopStart) / loopDuration))
                          : 0
                        return (
                          <div key={flagId}>
                            <div
                              className={`${aStyles.insightRow} ${isActive ? aStyles.insightRowActive : ''}`}
                              onClick={() => { playTick(); setActiveFlag(isActive ? null : flagId) }}
                            >
                              <span className={aStyles.insightIndex}>{i + 1}</span>
                              <button
                                className={aStyles.insightTime}
                                title="Seek to this timestamp"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (f.timestamp_start != null) seekTo(Number(f.timestamp_start))
                                }}
                              >
                                {formatTs(f.timestamp_start)}
                              </button>
                              <span className={aStyles.insightMeasure}>m.{f.measure}</span>
                              <span className={aStyles.insightTypeBadge} data-type={f.type}>{f.type.toUpperCase()}</span>
                              <span className={aStyles.insightRowTitle}>{f.title}</span>
                              <span className={aStyles.insightConfDot} style={{ background: cc }} />
                              <button
                                className={`${aStyles.insightLoopBtn} ${isThisLooping ? aStyles.insightLoopBtnActive : ''}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  playTick()
                                  if (isThisLooping) {
                                    stopLoop()
                                  } else {
                                    startLoop(f)
                                  }
                                }}
                              >
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                                </svg>
                                {isThisLooping ? 'Stop' : 'Loop'}
                              </button>
                              <button
                                className={aStyles.insightAskBtn}
                                title="Ask Mediant about this flag"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  const msg = `Explain the ${capitalize(f.type)} issue in measure ${f.measure} — "${f.title}". How do I fix it?`
                                  setChatInput(msg)
                                  document.getElementById('practa-chat-input')?.focus()
                                }}
                              >
                                Ask Mediant →
                              </button>
                            </div>
                            {isThisLooping && (
                              <div style={{ height: 2, background: 'rgba(0,0,0,0.06)', margin: '0 12px', borderRadius: 1, overflow: 'hidden' }}>
                                <div style={{
                                  height: '100%',
                                  width: `${loopProgress * 100}%`,
                                  background: 'var(--gold)',
                                  transition: 'width 0.1s linear',
                                  borderRadius: 1,
                                }} />
                              </div>
                            )}

                            {/* Teacher annotation bar */}
                            {profile?.role === 'teacher' && !isDemo && !take?._demo && (() => {
                              const ann        = annotations[i]
                              const isAnnoting = activeAnnot?.flagIndex === i
                              const isAnnLoading = annotLoading[i]
                              return (
                                <div style={{ padding: '6px 12px 8px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                                    <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 4 }}>
                                      {ann ? `✓ ${ann.action}${ann.rejection_reason ? ` · ${ann.rejection_reason.replace(/_/g,' ')}` : ''}` : 'Annotate:'}
                                    </span>
                                    <button
                                      onClick={e => { e.stopPropagation(); ann?.action === 'approve' ? deleteAnnotation(i) : submitAnnotation(i, 'approve') }}
                                      disabled={isAnnLoading}
                                      style={{ ...annotBtnStyle, ...(ann?.action === 'approve' ? { background: 'rgba(143,190,159,0.18)', color: '#8fbe9f', borderColor: '#8fbe9f' } : {}) }}
                                    >✓</button>
                                    <button
                                      onClick={e => { e.stopPropagation(); setActiveAnnot(isAnnoting && activeAnnot.action === 'reject' ? null : { flagIndex: i, action: 'reject' }); setRejectReason('wrong_measure') }}
                                      disabled={isAnnLoading}
                                      style={{ ...annotBtnStyle, ...(ann?.action === 'reject' || (isAnnoting && activeAnnot.action === 'reject') ? { background: 'rgba(192,83,74,0.15)', color: 'var(--coral)', borderColor: 'var(--coral)' } : {}) }}
                                    >✗</button>
                                    <button
                                      onClick={e => { e.stopPropagation(); setActiveAnnot(isAnnoting && activeAnnot.action === 'edit' ? null : { flagIndex: i, action: 'edit' }); setEditedTitle(f.title ?? ''); setEditedDetail(f.detail ?? f.body ?? '') }}
                                      disabled={isAnnLoading}
                                      style={{ ...annotBtnStyle, ...(ann?.action === 'edit' || (isAnnoting && activeAnnot.action === 'edit') ? { background: 'rgba(184,146,42,0.15)', color: 'var(--gold)', borderColor: 'var(--gold)' } : {}) }}
                                    >✎</button>
                                    {ann && (
                                      <button onClick={e => { e.stopPropagation(); deleteAnnotation(i) }} disabled={isAnnLoading}
                                        style={{ ...annotBtnStyle, color: 'var(--text-faint)', fontSize: '0.7rem' }}>Clear</button>
                                    )}
                                  </div>

                                  {/* Reject inline */}
                                  {isAnnoting && activeAnnot.action === 'reject' && (
                                    <div style={{ marginTop: 8, padding: '10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 5 }} onClick={e => e.stopPropagation()}>
                                      <p style={{ margin: '0 0 7px', fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Why is this flag wrong?</p>
                                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                                        {[['wrong_measure','Wrong measure'],['not_audible','Not audible'],['too_harsh','Too harsh'],['not_actionable','Not actionable'],['duplicate','Duplicate'],['other','Other']].map(([v,l]) => (
                                          <button key={v} onClick={() => setRejectReason(v)} style={{ ...annotBtnStyle, ...(rejectReason === v ? { background: 'rgba(192,83,74,0.15)', color: 'var(--coral)', borderColor: 'var(--coral)' } : {}) }}>{l}</button>
                                        ))}
                                      </div>
                                      <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
                                        <button onClick={() => submitAnnotation(i, 'reject', { rejectionReason: rejectReason })} style={{ background: 'var(--accent)', border: 0, borderRadius: 4, color: '#fff', cursor: 'pointer', font: 'inherit', fontSize: '0.8rem', fontWeight: 600, padding: '6px 12px' }}>Submit</button>
                                        <button onClick={() => setActiveAnnot(null)} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-muted)', cursor: 'pointer', font: 'inherit', fontSize: '0.8rem', padding: '6px 10px' }}>Cancel</button>
                                      </div>
                                    </div>
                                  )}

                                  {/* Edit inline */}
                                  {isAnnoting && activeAnnot.action === 'edit' && (
                                    <div style={{ marginTop: 8, padding: '10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 5 }} onClick={e => e.stopPropagation()}>
                                      <p style={{ margin: '0 0 7px', fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Corrected flag</p>
                                      <input value={editedTitle} onChange={e => setEditedTitle(e.target.value)} placeholder="Corrected title" style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', borderRadius: 4, color: 'var(--text)', display: 'block', font: 'inherit', fontSize: '0.85rem', marginBottom: 6, outline: 'none', padding: '7px 10px', width: '100%' }} />
                                      <textarea value={editedDetail} onChange={e => setEditedDetail(e.target.value)} placeholder="Corrected detail…" rows={2} style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', borderRadius: 4, color: 'var(--text)', display: 'block', font: 'inherit', fontSize: '0.85rem', marginBottom: 6, outline: 'none', padding: '7px 10px', resize: 'vertical', width: '100%' }} />
                                      <div style={{ display: 'flex', gap: 7 }}>
                                        <button onClick={() => submitAnnotation(i, 'edit', { editedFlag: { ...f, title: editedTitle, detail: editedDetail } })} disabled={!editedTitle.trim()} style={{ background: 'var(--accent)', border: 0, borderRadius: 4, color: '#fff', cursor: 'pointer', font: 'inherit', fontSize: '0.8rem', fontWeight: 600, padding: '6px 12px' }}>Save</button>
                                        <button onClick={() => setActiveAnnot(null)} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-muted)', cursor: 'pointer', font: 'inherit', fontSize: '0.8rem', padding: '6px 10px' }}>Cancel</button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )
                            })()}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Expanded insight card details */}
                  {info && activeFlagRaw && (
                    <div className={aStyles.insightDetailPanel}>
                      <div className={aStyles.insightDetailHeader}>
                        <span className={`${aStyles.detailTypeIcon} ${aStyles[flagTypeMeta(activeFlagRaw?.type).cls]}`}>
                          {flagTypeMeta(activeFlagRaw?.type).icon}
                        </span>
                        <span className={aStyles.detailMeasureBadge}>m.{activeFlagRaw.measure}</span>
                        <h4 className={aStyles.detailTitle}>{info.title}</h4>
                        <button className={aStyles.detailClose} onClick={() => setActiveFlag(null)}>✕</button>
                      </div>
                      <p className={aStyles.detailBody}>{info.body}</p>
                      <div className={aStyles.practiceRecBox}>
                        <p className={aStyles.practiceRecLabel}>Practice Recommendation</p>
                        <p className={aStyles.practiceRecText}>{practiceRec(activeFlagRaw?.type)}</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Video recording */}
                <div className={`${aStyles.laneCard} ${aStyles.recordingCard}`}>
                  <div className={aStyles.laneCardHeader}>
                    <span className={aStyles.laneCardTitle}>RECORDING</span>
                  </div>
                  <div className={aStyles.videoCardBody}>
                    {videoUrl ? (
                      <>
                        <video
                          ref={videoRef}
                          src={videoUrl}
                          className={aStyles.videoPlayer}
                          controls
                          playsInline
                          preload="metadata"
                          onLoadedMetadata={e => setVideoDuration(e.currentTarget.duration || null)}
                        />
                        <div className={aStyles.videoControls}>
                          <span className={aStyles.videoSpeedLabel}>Speed</span>
                          <div className={aStyles.speedBtnsRow}>
                            {[0.5, 0.75, 1, 1.25, 1.5].map(s => (
                              <button
                                key={s}
                                className={`${aStyles.speedBtn} ${videoSpeed === s ? aStyles.speedBtnActive : ''}`}
                                onClick={() => setVideoSpeed(s)}
                              >
                                {s}×
                              </button>
                            ))}
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className={aStyles.videoMissingState}>
                        <span>No recording video is attached to this analysis.</span>
                        <button onClick={() => nav('/record')}>Upload a new take</button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Ask Mediant Chat history panel */}
                <div className={aStyles.laneCard}>
                  <div className={aStyles.laneCardHeader}>
                    <span className={aStyles.laneCardTitle}>Ask Mediant</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)', fontWeight: 500 }}>AI coach for this take</span>
                  </div>
                  <div className={aStyles.analysisChatMessages}>
                    {chatMessages.map((m, i) => (
                      <div key={i} className={m.role === 'user' ? aStyles.analysisChatMsgUser : aStyles.analysisChatMsgAI}>
                        {m.content}
                      </div>
                    ))}
                    {chatLoading && (
                      <div className={aStyles.analysisChatMsgAI}><span className={aStyles.analysisChatTyping}>···</span></div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                </div>
              </div>
            </div>

            {/* Pinned Ask Mediant bottom bar */}
            <div className={aStyles.stickyBottomBar}>
              <div className={aStyles.stickyBarPrompts}>
                {QUICK_PROMPTS.map(p => (
                  <button
                    key={p}
                    className={aStyles.stickyPromptChip}
                    onClick={() => sendMessage(p)}
                    disabled={chatLoading}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <div className={aStyles.stickyBarInner}>
                {activeFlagRaw && (
                  <span className={aStyles.stickyBarFlagCtx} title={`Context: ${activeFlagRaw.title}`}>
                    m.{activeFlagRaw.measure} · {capitalize(activeFlagRaw.type)}
                    <button className={aStyles.stickyBarFlagCtxClear} onClick={() => setActiveFlag(null)}>✕</button>
                  </span>
                )}
                <div className={aStyles.stickyBarLeft}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)', flexShrink: 0 }}>
                    <path d="M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" />
                  </svg>
                  <span className={aStyles.stickyBarLabel}>Ask Mediant</span>
                </div>
                <div className={aStyles.stickyBarDivider} />
                <input
                  id="practa-chat-input"
                  className={aStyles.stickyBarInput}
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && sendMessage()}
                  placeholder={activeFlagRaw ? `Ask about ${capitalize(activeFlagRaw.type)} in m.${activeFlagRaw.measure}…` : 'Ask anything about your performance…'}
                  disabled={chatLoading}
                />
                <button
                  className={aStyles.stickyBarUploadBtn}
                  onClick={triggerFileUpload}
                  title="Upload follow-up take"
                  disabled={chatLoading}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </button>
                <button
                  className={aStyles.stickyBarSendBtn}
                  onClick={() => sendMessage()}
                  disabled={chatLoading || !chatInput.trim()}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              </div>
            </div>
          </>
        ) : (
          /* ── Session Summary Tab Dashboard ── */
          <div className={aStyles.summaryTabScroll}>
            {/* Per-aspect score breakdown */}
            {aspectScores && (
              <div className={aStyles.aspectScoresSection}>
                <p className={aStyles.aspectScoresSectionLabel}>Score Breakdown</p>
                <div className={aStyles.aspectScoresGrid}>
                  {Object.entries(ASPECT_LABELS).map(([key, { label, icon }]) => {
                    const val = aspectScores[key] ?? take?.score ?? 0
                    return (
                      <div key={key} className={aStyles.aspectScoreCard}>
                        <span className={`${aStyles.aspectScoreIcon} ${aStyles[TYPE_META[key]?.cls ?? 'iconGold']}`}>{icon}</span>
                        <div className={aStyles.aspectScoreInfo}>
                          <span className={aStyles.aspectScoreLabel}>{label}</span>
                          <span className={aStyles.aspectScoreVal} style={{ color: scoreColor(val) }}>{val}</span>
                        </div>
                        <div className={aStyles.aspectScoreBar}>
                          <div className={aStyles.aspectScoreBarFill} style={{ width: `${val}%`, background: scoreColor(val) }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Top overview card */}
            <div className={aStyles.summaryTopCard}>
              <div className={aStyles.summaryTopScoreCol}>
                <div className={aStyles.summaryTopScoreWrap}>
                  <span className={aStyles.summaryTopScoreNum} style={{ color: scoreColor(score) }}>{score}</span>
                  <span className={aStyles.summaryTopScoreDenom}>/100</span>
                </div>
                <span className={aStyles.summaryTopScoreLabel}>TECHNIQUE SCORE</span>
                <div className={aStyles.summaryTopScoreBarTrack}>
                  <div className={aStyles.summaryTopScoreBarFill} style={{ width: `${score}%`, background: scoreColor(score) }} />
                </div>
              </div>

              <div className={aStyles.summaryTopDivider} />

              <div className={aStyles.summaryTopConfCol}>
                <span className={aStyles.summaryTopLabel}>CONFIDENCE</span>
                <ConfidenceGauge confidence={overallConfidence} />
              </div>

              <div className={aStyles.summaryTopDivider} />

              <div className={aStyles.summaryTopGlanceCol}>
                <span className={aStyles.summaryTopLabel}>AT A GLANCE</span>
                <h3 className={aStyles.summaryTopGlanceHeadline}>{activeSummary.headline}</h3>
                <p className={aStyles.summaryTopGlanceDesc}>{activeSummary.overview}</p>
              </div>

              <div className={aStyles.summaryTopDivider} />

              <div className={aStyles.summaryTopWidgetCol} onClick={() => { playTick(); setActiveTab('overview') }}>
                <div className={aStyles.widgetSparkleWrap}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" />
                  </svg>
                </div>
                <div className={aStyles.widgetTextWrap}>
                  <h4 className={aStyles.widgetTitle}>Ask Mediant AI</h4>
                  <p className={aStyles.widgetDesc}>Personalized coaching for this session</p>
                </div>
              </div>
            </div>

            {/* 3-Column dashboard layout */}
            <div className={aStyles.summaryDashboardGrid}>
              {/* Column 1: Strengths */}
              <div className={aStyles.summaryDashboardCard}>
                <div className={aStyles.dashboardCardHeader} style={{ color: 'var(--hero-green)' }}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8 }}>
                    <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.45 1-1 1H4v2h16v-2h-5c-.55 0-1-.45-1-1v-2.34M12 2a5 5 0 0 0-5 5v5c0 2.76 2.24 5 5 5s5-2.24 5-5V7a5 5 0 0 0-5-5z" />
                  </svg>
                  <span>STRENGTHS</span>
                </div>
                <div className={aStyles.dashboardCardList}>
                  {activeSummary.strengths.map((str, idx) => {
                    const parts = str.split(': ')
                    const title = parts[0]
                    const desc = parts[1] || ''
                    return (
                      <div key={idx} className={aStyles.summaryListItem}>
                        <div className={aStyles.summaryItemIconWrap} style={{ background: 'rgba(143, 190, 159, 0.12)', color: 'var(--hero-green)' }}>
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 18V5l12-2v13" />
                            <circle cx="6" cy="18" r="3" />
                            <circle cx="18" cy="16" r="3" />
                          </svg>
                        </div>
                        <div className={aStyles.summaryItemText}>
                          <h5 className={aStyles.summaryItemTitle}>{title}</h5>
                          <p className={aStyles.summaryItemDesc}>{desc}</p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Column 2: Priorities */}
              <div className={aStyles.summaryDashboardCard}>
                <div className={aStyles.dashboardCardHeader} style={{ color: 'var(--gold)' }}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8 }}>
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="12" r="6" />
                    <circle cx="12" cy="12" r="2" />
                  </svg>
                  <span>PRIORITIES / AREAS TO WORK ON</span>
                </div>
                <div className={aStyles.dashboardCardList}>
                  {activeSummary.improvements.map((imp, idx) => (
                    <div key={idx} className={aStyles.summaryListItem}>
                      <div className={aStyles.summaryItemIconWrap} style={{ background: 'rgba(192, 144, 64, 0.1)', color: 'var(--gold)' }}>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <circle cx="12" cy="12" r="2" />
                          <line x1="12" y1="2" x2="12" y2="4" />
                          <line x1="12" y1="20" x2="12" y2="22" />
                          <line x1="2" y1="12" x2="4" y2="12" />
                          <line x1="20" y1="12" x2="22" y2="12" />
                        </svg>
                      </div>
                      <div className={aStyles.summaryItemText}>
                        <h5 className={aStyles.summaryItemTitle}>{imp.area}</h5>
                        <p className={aStyles.summaryItemDesc}>{imp.guidance}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Column 3: Practice Plan */}
              <div className={aStyles.summaryDashboardCard}>
                <div className={aStyles.dashboardCardHeader}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8, color: 'var(--hero-green)' }}>
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  <span style={{ color: 'var(--text-faint)' }}>PRACTICE PLAN</span>
                  <span className={aStyles.practiceCountBadge}>{activeSummary.drills.length}</span>
                </div>
                <p className={aStyles.practicePlanSubtitle}>Recommended drills for this session</p>
                <div className={aStyles.drillsGrid}>
                  {activeSummary.drills.map((drill, idx) => (
                    <div key={idx} className={aStyles.drillCard}>
                      <div className={aStyles.drillIconWrap}>
                        {drill.type === 'spinner' ? (
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="2" x2="12" y2="6" />
                            <line x1="12" y1="18" x2="12" y2="22" />
                            <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
                            <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
                            <line x1="2" y1="12" x2="6" y2="12" />
                            <line x1="18" y1="12" x2="22" y2="12" />
                            <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
                            <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
                          </svg>
                        ) : drill.type === 'key' ? (
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5l-.01.01" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
                            <path d="M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z" />
                          </svg>
                        )}
                      </div>
                      <div className={aStyles.drillInfo}>
                        <h5 className={aStyles.drillName}>{drill.name}</h5>
                        <p className={aStyles.drillMetaText}>{drill.duration} • {drill.frequency}</p>
                      </div>
                    </div>
                  ))}
                  <button className={aStyles.viewAllDrillsBtn} onClick={() => { playTick(); nav('/takes') }}>
                    View all drills
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 4 }}>
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* Bottom Row Dashboard Cards */}
            <div className={aStyles.summaryBottomRow}>
              {/* Continue Conversation Card */}
              <div className={aStyles.summaryConversationCard}>
                <div className={aStyles.conversationHeader}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8 }}>
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <span>CONTINUE THE CONVERSATION</span>
                </div>
                <p className={aStyles.conversationDesc}>
                  I remember our conversation about this take. Ask anything, upload a new take, or get feedback on specific techniques.
                </p>
                <div className={aStyles.conversationInputRow}>
                  <button className={aStyles.uploadFollowupBtn} onClick={triggerFileUpload}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
                    </svg>
                    Upload follow-up take
                  </button>
                  <div className={aStyles.conversationInputContainer}>
                    <input
                      className={aStyles.conversationInput}
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && sendMessage()}
                      placeholder="Ask a question about your playing..."
                      disabled={chatLoading}
                    />
                    <button className={aStyles.conversationSendBtn} onClick={() => sendMessage()} disabled={chatLoading || !chatInput.trim()}>
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="19" x2="12" y2="5" />
                        <polyline points="5 12 12 5 19 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              {/* Past Takes Card */}
              <div className={aStyles.summaryPastTakesCard}>
                <div className={aStyles.pastTakesHeader}>
                  <span>PAST TAKES FOR THIS SONG</span>
                </div>
                <div className={aStyles.pastTakesList}>
                  {takesForActiveThread.slice(0, 3).map((t, idx) => {
                    const takeNum = takesForActiveThread.length - idx
                    const formattedDate = timeAgo(t.created_at) || 'Recent'
                    return (
                      <div key={t.id} className={aStyles.pastTakeRow}>
                        <div className={aStyles.pastTakeLeft}>
                          <span className={aStyles.pastTakeLabel}>Take {takeNum}</span>
                          <span className={aStyles.pastTakeScoreBadge} style={{ background: scoreBgColor(t.score), color: scoreColor(t.score) }}>{t.score}</span>
                        </div>
                        <span className={aStyles.pastTakeMeta}>
                          Analyzed {formattedDate} • 0:48
                        </span>
                        <div className={aStyles.pastTakeActions}>
                          <button className={aStyles.pastTakePlayBtn} onClick={() => { playTick(); setSelectedTakeId(t.id); setActiveTab('overview') }}>
                            <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
                              <polygon points="5 3 19 12 5 21" />
                            </svg>
                          </button>
                          <button className={aStyles.pastTakeMenuBtn} onClick={() => { playTick(); setShowThreadMenu(t.id === showThreadMenu ? null : t.id) }}>
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <circle cx="12" cy="12" r="1" />
                              <circle cx="12" cy="5" r="1" />
                              <circle cx="12" cy="19" r="1" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            <MasterclassPanel
              pieceTitle={activeThread?.piece_title ?? activeThreadTitle}
              composer={activeThread?.piece_composer}
              instrument={activeThread?.instrument}
            />
          </div>
        )}
      </main>

      {showAnalysisIntro && (
        <AnalysisOnboarding onClose={() => setShowAnalysisIntro(false)} />
      )}
    </div>
  )
}
