import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import MasterclassPanel from '../components/MasterclassPanel'
import { SkeletonCard } from '../components/Skeleton'
import WaveformTimeline, { WAVEFORM_GROUPS } from '../components/WaveformTimeline'
import styles from './Page.module.css'
import aStyles from './Analysis.module.css'
import { playTick, playPop, playNav } from '../utils/sounds'

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }

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

const INITIAL_AI_MESSAGES = {
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
  if (confidence >= 90) return 'var(--accent)'
  if (confidence >= 70) return 'var(--gold)'
  return 'var(--coral)'
}

function confLabel(confidence) {
  if (confidence >= 90) return 'High'
  if (confidence >= 70) return 'Medium'
  return 'Low'
}

function scoreColor(n) {
  if (n >= 88) return '#8fbe9f'
  if (n >= 74) return 'var(--gold)'
  return 'var(--coral)'
}

function scoreFileForPiece(title) {
  if (!title) return null
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const known = {
    'clair-de-lune': '/scores/clair-de-lune.mxl',
  }
  return known[slug] ?? null
}

export default function Analysis({ demo: demoProp = false }) {
  const nav = useNavigate()
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  
  const scoreEl  = useRef(null)
  const osmdRef  = useRef(null)
  const videoRef    = useRef(null)
  const loopRef     = useRef(null)
  const chatEndRef = useRef(null)
  const fileInputRef = useRef(null)
  const summaryRef = useRef(null)

  const isDemo = demoProp || searchParams.get('demo') === 'true'
  const takeId = searchParams.get('takeId')

  // Threads & database takes state
  const [allTakes, setAllTakes] = useState([])
  const [activeThreadTitle, setActiveThreadTitle] = useState('Clair de lune')
  const [selectedTakeId, setSelectedTakeId] = useState(null)
  const [threadsTab, setThreadsTab] = useState('all')

  const [showThreadMenu, setShowThreadMenu] = useState(null) // piece_title of thread with open menu

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
      return
    }
    supabase
      .from('takes')
      .select('id, piece_title, piece_composer, instrument, score, flags, analysis_quality, video_path, score_path, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!error && data) {
          setAllTakes(data)
        }
      })
  }, [user?.id])

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

    // Premium demo mock fallbacks (only populated if the user has absolutely zero real takes)
    const mockData = allTakes.length === 0 ? [
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
    ] : []

    mockData.forEach(mock => {
      if (!groups[mock.piece_title]) {
        groups[mock.piece_title] = mock
      }
    })

    return Object.values(groups)
  }, [allTakes])

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
    
    if (take._demo) {
      setScoreReady(false)
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
      if (videoRef.current && videoRef.current.currentTime >= end) {
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

  const activeFlagIndex = activeFlag ? parseInt(activeFlag.replace('flag_', ''), 10) : -1
  const activeFlagRaw   = take?.flags?.[activeFlagIndex] ?? null
  const hasTimestamps   = activeFlagRaw?.timestamp_start != null && activeFlagRaw?.timestamp_end != null
    && Number(activeFlagRaw.timestamp_end) > Number(activeFlagRaw.timestamp_start)

  const flagsMap = take?.flags?.length
    ? Object.fromEntries(
        take.flags.map((f, i) => [
          `flag_${i}`,
          { tag: `Measure ${f.measure} · ${capitalize(f.type)}`, title: f.title, body: f.detail ?? f.body ?? '', confidence: f.confidence ?? 100 },
        ])
      )
    : {}

  const chips = take?.flags?.length
    ? take.flags.map((f, i) => ({
        flag:       `flag_${i}`,
        label:      `m.${f.measure} · ${capitalize(f.type)}`,
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

    const flagMeasures = new Map()
    if (take?.flags?.length) {
      take.flags.forEach((f, i) => {
        const arr = flagMeasures.get(f.measure) ?? []
        arr.push(`flag_${i}`)
        flagMeasures.set(f.measure, arr)
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

          flagMeasures.forEach((flagIds, measureNum) => {
            const row = measureList[measureNum - 1]
            if (!row) return
            const gm = row[0]
            if (!gm) return
            const pos = gm.PositionAndShape
            newHighlights.push({
              flagIds,
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
            history: chatMessages,
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
          const reply = `Analysis complete for Take ${nextTakeNum}! \n\n**New Score: ${completedTake.score}/100** (${scoreDiff >= 0 ? '+' : ''}${scoreDiff} difference).\n\nHere is a quick summary of what changed:\n${completedTake.flags?.map(f => `- **m.${f.measure}**: ${f.title}`).join('\n') || '- No critical issues flagged!'}\n\nI've loaded your new take on screen. What should we work on next?`
          
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

  async function handleDeleteThread(threadToDel) {
    if (!threadToDel) return
    const isConfirmed = window.confirm(`Are you sure you want to delete the entire session thread "${threadToDel.piece_title}"? This will delete all ${threadToDel.takes.length} recordings in this session. This action cannot be undone.`)
    if (!isConfirmed) return

    playPop()
    const targetTakes = threadToDel.takes || []
    
    // 1. Delete from Supabase if real
    if (user?.id) {
      const realTakes = targetTakes.filter(take => {
        const targetTakeId = take.id
        const isDemoOrMock = !targetTakeId || String(targetTakeId).startsWith('mock') || String(targetTakeId) === 'demo' || take._demo
        return !isDemoOrMock
      })

      if (realTakes.length > 0) {
        try {
          const realIds = realTakes.map(take => take.id)
          const { error } = await supabase
            .from('takes')
            .delete()
            .in('id', realIds)
          if (error) throw new Error(error.message)
          
          realTakes.forEach(take => {
            if (take.video_path) supabase.storage.from('recordings').remove([take.video_path]).catch(() => {})
            if (take.score_path) supabase.storage.from('sheet-music').remove([take.score_path]).catch(() => {})
          })
        } catch (err) {
          alert(`Could not delete session thread: ${err.message}`)
          return
        }
      }
    }

    // 2. Update local state
    const idsToDelete = targetTakes.map(t => t.id)
    setAllTakes(prev => prev.filter(t => !idsToDelete.includes(t.id)))

    // 3. Reset active thread selections if deleted thread was active
    if (threadToDel.piece_title === activeThreadTitle) {
      setSelectedTakeId(null)
      const nextThread = threads.find(th => th.piece_title !== threadToDel.piece_title && th.takes?.length > 0)
      if (nextThread) {
        setActiveThreadTitle(nextThread.piece_title)
      } else {
        setActiveThreadTitle('')
      }
      setActiveFlag(null)
    }
  }

  // Filter threads
  const filteredThreads = useMemo(() => {
    return threads.filter(t => {
      if (threadsTab === 'pinned') return t.isPinned
      return true
    })
  }, [threads, threadsTab])

  // Sheet music/PDF fallbacks
  const isVisualScore = scoreUrl && (() => {
    const p = (take?.score_path ?? '').toLowerCase()
    return /\.(jpe?g|png|webp|heic|pdf)$/.test(p)
  })()
  const isPdfScore = isVisualScore && (take?.score_path ?? '').toLowerCase().endsWith('.pdf')
  const isImageScore = isVisualScore && !isPdfScore

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

  const scoreAreaContent = (
    <div className={`${styles.scoreArea} ${isImageScore ? styles.scoreAreaImage : ''}`}>
      {isVisualScore && scoreUrl && (
        isPdfScore ? (
          <iframe src={scoreUrl} className={styles.scorePdf} title="Sheet music" />
        ) : (
          <div className={styles.scorePhotoWrap}>
            <img src={scoreUrl} className={styles.scorePhoto} alt="Sheet music" loading="lazy" />
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
            {scoreReady && highlights.map(({ flagIds, measureNum, x, y, w, h }) => {
              const isMeasureActive = flagIds.includes(activeFlag)
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
                    background: isMeasureActive ? 'rgba(184,146,42,0.22)' : 'rgba(184,146,42,0.06)',
                    border: `1.5px solid rgba(184,146,42,${isMeasureActive ? '0.6' : '0.22'})`,
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

        {/* ── Thread tab strip ── */}
        <div className={aStyles.threadStrip}>
          <div className={aStyles.threadStripTabs}>
            {filteredThreads.map(t => {
              const isActive = t.piece_title === activeThreadTitle
              const latestScore = t.takes[0]?.score ?? null
              return (
                <button
                  key={t.piece_title}
                  className={`${aStyles.threadStripTab} ${isActive ? aStyles.threadStripTabActive : ''}`}
                  onClick={() => { playTick(); setActiveThreadTitle(t.piece_title); setSelectedTakeId(null); setActiveFlag(null) }}
                  onContextMenu={e => { e.preventDefault(); setShowThreadMenu(t.piece_title) }}
                >
                  <span className={aStyles.threadStripTitle}>{t.piece_title}</span>
                  {latestScore != null && (
                    <span className={aStyles.threadStripScore} style={{ color: scoreColor(latestScore) }}>
                      {latestScore}
                    </span>
                  )}
                  {t.isPinned && <span className={aStyles.threadStripPin}>★</span>}
                  {showThreadMenu === t.piece_title && (
                    <div className={aStyles.threadMenu} onClick={e => e.stopPropagation()} onMouseLeave={() => setShowThreadMenu(null)}>
                      <button className={aStyles.threadMenuItem} onClick={() => { handleDeleteThread(t); setShowThreadMenu(null) }}>
                        Delete thread
                      </button>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
          <button className={aStyles.threadStripNew} onClick={() => { playPop(); nav('/record') }} title="New session">
            +
          </button>
        </div>

        {/* ── Piece header ── */}
        <div className={styles.header}>
          <div>
            <h1 className={styles.reviewTitle}>{pieceTitle}</h1>
            <p className={styles.sub}>{subtext}</p>
            {takesForActiveThread.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                <select
                  className={aStyles.takeSelect}
                  value={selectedTakeId ?? take?.id ?? ''}
                  onChange={(e) => { playTick(); setSelectedTakeId(e.target.value) }}
                >
                  {takesForActiveThread.map((t, idx) => {
                    const takeNum = takesForActiveThread.length - idx
                    const formattedDate = timeAgo(t.created_at) || 'Recent'
                    return (
                      <option key={t.id} value={t.id}>
                        Take {takeNum} · {t.score ?? '—'}/100 · {formattedDate}
                      </option>
                    )
                  })}
                </select>
                <button className={aStyles.deleteTakeBtn} onClick={handleDeleteTake} title="Delete this recording analysis">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                  Delete
                </button>
              </div>
            )}
          </div>
          <div className={aStyles.headerRight}>
            {score != null && (
              <div className={aStyles.scoreBadge}>
                <p className={aStyles.scoreBadgeLabel}>Technique Score</p>
                <div className={aStyles.scoreBadgeMain}>
                  <span className={aStyles.scoreBadgeNum} style={{ color: scoreColor(score) }}>{score}</span>
                  <span className={aStyles.scoreBadgeDen}>/100</span>
                </div>
                <div className={aStyles.scoreBadgeTrack}>
                  <div className={aStyles.scoreBadgeFill} style={{ width: `${score}%`, background: scoreColor(score) }} />
                </div>
              </div>
            )}
            <button className={styles.ghostBtn} onClick={() => nav('/record')}>↺ Re-analyze</button>
          </div>
        </div>

        {/* Tab strip */}
        <div className={aStyles.tabStrip}>
          <button
            className={`${aStyles.tab} ${activeTab === 'overview' ? aStyles.tabActive : ''}`}
            onClick={() => setActiveTab('overview')}
          >Overview</button>
          <button
            className={`${aStyles.tab} ${activeTab === 'summary' ? aStyles.tabActive : ''}`}
            onClick={() => setActiveTab('summary')}
          >Session Summary</button>
        </div>

        {activeTab === 'overview' ? (
          <>
            {/* Full-width waveform timeline */}
            <div className={aStyles.waveformSection}>
              <WaveformTimeline
                flags={take?.flags ?? []}
                duration={videoDuration ?? 0}
                videoRef={videoRef}
                activeFlag={activeFlag}
                onFlagClick={(id) => { playTick(); setActiveFlag(activeFlag === id ? null : id) }}
              />
            </div>

            {/* Two-column layout: Score on Left, AI Insights on Right */}
            <div className={`${aStyles.reviewLayout} ${isImageScore ? aStyles.reviewLayoutImageScore : ''} ${scoreCollapsed ? aStyles.reviewLayoutScoreCollapsed : ''}`}>
              {/* Left Column: Sheet music score (collapsible) */}
              <div className={`${aStyles.scoreColumnWrap} ${scoreCollapsed ? aStyles.scoreColumnWrapHidden : ''}`}>
                <div className={aStyles.scoreColumn}>
                  <div className={aStyles.scoreColumnHeader}>
                    <span className={aStyles.scoreColumnTitle}>Sheet Music</span>
                    <button
                      className={aStyles.scoreCollapseBtn}
                      onClick={() => setScoreCollapsed(v => !v)}
                      title={scoreCollapsed ? 'Show sheet music' : 'Hide sheet music'}
                    >
                      {scoreCollapsed ? 'Show' : 'Hide'}
                    </button>
                  </div>
                  <div className={aStyles.scoreInner}>
                    {scoreAreaContent}
                  </div>
                </div>
              </div>

              {/* Right Column: AI insights, video, chat */}
              <div className={aStyles.rightColumn}>
                {/* Score-hidden restore button */}
                {scoreCollapsed && (
                  <button className={aStyles.scoreRestoreBtn} onClick={() => setScoreCollapsed(false)}>
                    Show sheet music
                  </button>
                )}

                {/* AI Insights — grouped by type */}
                <section className={aStyles.insightsPanel}>
                  <div className={aStyles.insightsPanelHeader}>
                    <span className={aStyles.insightsPanelTitle}>
                      AI Insights
                      {issueCount > 0 && <span className={aStyles.insightCount}>{issueCount}</span>}
                    </span>
                    <div className={aStyles.confLegend} title="How confident the AI is that this issue is real">
                      <span className={aStyles.confLegendLabel}>Confidence:</span>
                      <span className={aStyles.confLegendItem}><span className={aStyles.confDot} style={{ background: 'var(--accent)' }} />High</span>
                      <span className={aStyles.confLegendItem}><span className={aStyles.confDot} style={{ background: 'var(--gold)' }} />Medium</span>
                      <span className={aStyles.confLegendItem}><span className={aStyles.confDot} style={{ background: 'var(--coral)' }} />Low</span>
                    </div>
                  </div>

                  {issueCount === 0 ? (
                    <div className={aStyles.issueClean}>✓ No issues detected — clean performance.</div>
                  ) : (
                    <div className={aStyles.groupedTimeline}>
                      {WAVEFORM_GROUPS.map(group => {
                        const groupFlags = sortedChips.filter(({ flag }) => {
                          const idx = parseInt(flag.replace('flag_', ''), 10)
                          const f = take?.flags?.[idx]
                          return group.types.includes((f?.type ?? '').toLowerCase())
                        })
                        if (groupFlags.length === 0) return null
                        return (
                          <div key={group.key} className={aStyles.flagGroup}>
                            <div className={aStyles.flagGroupHeader} style={{ '--gc': group.color }}>
                              <span className={aStyles.flagGroupDot} />
                              <span className={aStyles.flagGroupLabel}>{group.label}</span>
                              <span className={aStyles.flagGroupDesc}>{group.desc}</span>
                              <span className={aStyles.flagGroupCount}>{groupFlags.length}</span>
                            </div>
                            <div className={aStyles.timeline}>
                              {groupFlags.map(({ flag, confidence }) => {
                                const idx = parseInt(flag.replace('flag_', ''), 10)
                                const f = take.flags[idx]
                                const isActive = activeFlag === flag
                                const cc = confColor(confidence)
                                return (
                                  <button
                                    key={flag}
                                    className={`${aStyles.timelineRow} ${isActive ? aStyles.timelineRowActive : ''}`}
                                    onClick={() => { playTick(); setActiveFlag(activeFlag === flag ? null : flag) }}
                                  >
                                    <span className={aStyles.timelineConfDot} style={{ background: cc }} />
                                    <span className={aStyles.timelineTs}>{formatTs(f?.timestamp_start)}</span>
                                    <span className={aStyles.timelineMeasure}>m.{f?.measure}</span>
                                    <span className={aStyles.timelineTitle}>{f?.title}</span>
                                    <span className={aStyles.timelineConfBadge} style={{ color: cc }}>{confLabel(confidence)}</span>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Expanded insight card */}
                  {info && activeFlagRaw && (
                    <div className={aStyles.insightCard}>
                      <div className={aStyles.insightCardHeader}>
                        <span className={aStyles.insightMeasureBadge}>m.{activeFlagRaw.measure}</span>
                        <h3 className={aStyles.insightTitle}>{info.title}</h3>
                        <span className={aStyles.insightConfBadge} style={{ color: confColor(info.confidence ?? 100) }}>
                          {confLabel(info.confidence ?? 100)}
                        </span>
                        <button className={aStyles.insightDismiss} onClick={() => setActiveFlag(null)}>✕</button>
                      </div>
                      <p className={aStyles.insightBody}>{info.body}</p>
                      <div className={aStyles.insightTags}>
                        <span className={aStyles.insightTag}>{capitalize(activeFlagRaw.type)}</span>
                        {info.confidence != null && (
                          <span className={aStyles.insightTag}>Confidence: {confLabel(info.confidence)}</span>
                        )}
                      </div>
                      {videoUrl && hasTimestamps && (
                        <div className={aStyles.insightActions}>
                          {!isLooping ? (
                            <button className={aStyles.loopBtn} onClick={() => startLoop(activeFlagRaw)}>
                              ↺ Loop m.{activeFlagRaw.measure}
                              <span className={aStyles.loopExcerptTime}>
                                {formatTs(activeFlagRaw.timestamp_start)} – {formatTs(activeFlagRaw.timestamp_end)}
                              </span>
                            </button>
                          ) : (
                            <button className={aStyles.loopStopBtn} onClick={stopLoop}>■ Stop loop</button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </section>

                {/* Video recording */}
                {videoUrl && (
                  <div className={styles.videoBar}>
                    <span className={styles.videoBarLabel}>Recording</span>
                    <video
                      ref={videoRef}
                      src={videoUrl}
                      className={styles.videoBarPlayer}
                      controls
                      playsInline
                      preload="metadata"
                      onLoadedMetadata={e => setVideoDuration(e.currentTarget.duration || null)}
                    />
                    <div className={styles.videoControls}>
                      <span className={styles.videoControlsLabel}>Speed</span>
                      <div className={styles.speedBtns}>
                        {[0.5, 0.75, 1, 1.25, 1.5].map(s => (
                          <button
                            key={s}
                            className={`${styles.speedBtn} ${videoSpeed === s ? styles.speedBtnActive : ''}`}
                            onClick={() => setVideoSpeed(s)}
                          >{s}×</button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Ask Mediant Chat */}
                <section className={aStyles.chatSection}>
                  <div className={aStyles.chatSectionHeader}>
                    <p className={styles.label}>Ask Mediant</p>
                    {activeFlagRaw && (
                      <span className={aStyles.chatContextPill}>
                        Re: m.{activeFlagRaw.measure} · {capitalize(activeFlagRaw.type)}
                      </span>
                    )}
                  </div>
                  <div className={styles.chatMessages}>
                    {chatMessages.length === 0 && (
                      <p className={styles.chatEmpty}>
                        {activeFlagRaw
                          ? `Ask about m.${activeFlagRaw.measure} · ${capitalize(activeFlagRaw.type)}, or anything about your performance.`
                          : 'Select an issue above, then ask Mediant about it — or ask anything about your performance.'}
                      </p>
                    )}
                    {chatMessages.map((m, i) => (
                      <div key={i} className={m.role === 'user' ? styles.chatMsgUser : styles.chatMsgAI}>
                        {m.role === 'user' && m.flagContext && (
                          <span className={styles.chatMsgContext}>
                            Re: m.{m.flagContext.measure} · {capitalize(m.flagContext.type)}
                          </span>
                        )}
                        {m.content}
                      </div>
                    ))}
                    {chatLoading && (
                      <div className={styles.chatMsgAI}><span className={styles.chatTyping}>···</span></div>
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  <div style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '4px 0', scrollbarWidth: 'none' }}>
                    <button className={aStyles.summaryRetryBtn} style={{ borderRadius: 16, padding: '6px 12px', whiteSpace: 'nowrap', margin: 0 }} onClick={() => sendMessage("How can I shape the opening?")}>
                      How can I shape the opening?
                    </button>
                    <button className={aStyles.summaryRetryBtn} style={{ borderRadius: 16, padding: '6px 12px', whiteSpace: 'nowrap', margin: 0 }} onClick={() => sendMessage("Why does m.14 feel rushed?")}>
                      Why does m.14 feel rushed?
                    </button>
                    <button className={aStyles.summaryRetryBtn} style={{ borderRadius: 16, padding: '6px 12px', whiteSpace: 'nowrap', margin: 0 }} onClick={() => sendMessage("Help with left-hand balance")}>
                      Help with left-hand balance
                    </button>
                  </div>

                  <div className={styles.chatInputRow}>
                    <button
                      className={styles.chatSend}
                      style={{ background: 'var(--surface-hover)', color: 'var(--text-soft)', marginRight: 6, padding: '0 8px' }}
                      onClick={triggerFileUpload}
                      title="Upload follow-up take"
                    >
                      +
                    </button>
                    <input
                      className={styles.chatInput}
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && sendMessage()}
                      placeholder="Ask about your performance or upload follow-up takes…"
                      disabled={chatLoading}
                    />
                    <button
                      className={styles.chatSend}
                      onClick={() => sendMessage()}
                      disabled={chatLoading || !chatInput.trim()}
                    >↑</button>
                  </div>
                </section>
              </div>
            </div>
          </>
        ) : (
          /* ── Session Summary tab ── */
          <section className={aStyles.summaryTab} ref={summaryRef}>
            <div className={aStyles.summaryTabTop}>
              {score != null && (
                <div className={aStyles.summaryScoreBlock}>
                  <span className={aStyles.summaryScoreNum} style={{ color: scoreColor(score) }}>{score}</span>
                  <div className={aStyles.summaryScoreMeta}>
                    <span className={aStyles.summaryScoreDen}>/100</span>
                    <p className={aStyles.summaryScoreLabel}>Technique Score</p>
                    <div className={aStyles.summaryScoreTrack}>
                      <div className={aStyles.summaryScoreFill} style={{ width: `${score}%`, background: scoreColor(score) }} />
                    </div>
                  </div>
                </div>
              )}
              <div className={aStyles.summaryTabMeta}>
                <div className={aStyles.summaryTabMetaTop}>
                  <p className={styles.label}>Session Summary</p>
                  {summary && !summaryLoading && (
                    <button className={aStyles.summaryRetryBtn} onClick={generateSummary}>Regenerate</button>
                  )}
                </div>
                {summaryLoading && (
                  <div className={aStyles.summaryLoading}>
                    <span className={aStyles.summaryLoadingDot} />
                    <span className={aStyles.summaryLoadingDot} />
                    <span className={aStyles.summaryLoadingDot} />
                    <span style={{ marginLeft: 8 }}>Generating your session summary…</span>
                  </div>
                )}
                {summaryError && !summaryLoading && (
                  <p className={aStyles.summaryError}>
                    {summaryError}
                    <button className={aStyles.summaryRetryBtn} onClick={generateSummary}>Retry</button>
                  </p>
                )}
                {summary?.headline && !summaryLoading && (
                  <h2 className={aStyles.summaryHeadline}>{summary.headline}</h2>
                )}
                {summary?.overview && !summaryLoading && (
                  <p className={aStyles.summaryOverview}>{summary.overview}</p>
                )}
                {!summary && !summaryLoading && !summaryError && issueCount === 0 && (
                  <p className={aStyles.summaryOverview} style={{ color: 'var(--accent)' }}>
                    No issues were flagged — great performance.
                  </p>
                )}
              </div>
            </div>

            {summary && !summaryLoading && (
              <div className={aStyles.summaryColumns}>
                {summary.strengths?.length > 0 && (
                  <div className={`${aStyles.summaryCard} ${aStyles.summaryCardStrengths}`}>
                    <p className={`${aStyles.summaryCardTitle} ${aStyles.summaryCardTitleStrengths}`}>✓ Strengths</p>
                    <ul className={aStyles.summaryList}>
                      {summary.strengths.map((s, i) => (
                        <li key={i} className={aStyles.summaryListItem}>{s}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {summary.improvements?.length > 0 && (
                  <div className={`${aStyles.summaryCard} ${aStyles.summaryCardImprovements}`}>
                    <p className={`${aStyles.summaryCardTitle} ${aStyles.summaryCardTitleImprovements}`}>→ Areas to work on</p>
                    <ul className={aStyles.summaryList}>
                      {summary.improvements.map((item, i) => (
                        <li key={i} className={aStyles.summaryListItem}>
                          {item.area && <span className={aStyles.summaryImprovementArea}>{item.area}</span>}
                          {item.guidance ?? item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Masterclass panel rendered correctly in page flow beneath everything */}
        <MasterclassPanel pieceTitle={pieceTitle} composer={pieceComposer} instrument={instrument} />
      </main>
    </div>
  )
}
