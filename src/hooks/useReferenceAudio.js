import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

/**
 * Fetches (or lazily generates) a take's AI reference audio, and exposes
 * playback controls including client-side tempo adjustment (no server
 * round-trip — see docs/superpowers/specs/2026-09-08-reference-audio-design.md
 * Part 3) and range-limited playback for the drag-to-select UI.
 */
export function useReferenceAudio(takeId) {
  const audioRef = useRef(null)
  const [timeline, setTimeline] = useState([])
  const [baselineBpm, setBaselineBpm] = useState(null)
  const [tempo, setTempoState] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [isPlaying, setIsPlaying] = useState(false)
  // The measures the cached/generated audio actually covers — NOT guaranteed
  // to be the whole piece. score_cache is shared across every take that
  // reuses the same photographed page, and can hold a partial parse left
  // over from whichever take first populated it (the vision read can anchor
  // on that take's own played range instead of the full page — a real,
  // observed failure: a page spanning m.1-58+ cached as just m.20-35).
  // Surfacing this range is what keeps a partial excerpt from silently
  // reading as "the wrong song" — null means unknown (not yet generated).
  const [measureRange, setMeasureRange] = useState(null)
  const rangeEndRef = useRef(null)

  useEffect(() => {
    return () => {
      const audio = audioRef.current
      if (audio) {
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      }
      audioRef.current = null
      setTimeline([])
      setBaselineBpm(null)
      setTempoState(null)
      setIsPlaying(false)
      setError('')
      setMeasureRange(null)
      rangeEndRef.current = null
    }
  }, [takeId])

  // Returns { timeline, bpm } on success, null on failure — callers that need
  // the fresh data immediately after calling this (see playRange below) MUST
  // use the returned value, not the timeline/baselineBpm state variables:
  // setState from inside this same async call has not flushed yet by the
  // time an awaiting caller resumes, so reading state here would see the
  // PRE-generation value, not the one just fetched.
  const generate = useCallback(async () => {
    if (!takeId) return null
    if (audioRef.current?.src) return { timeline, bpm: baselineBpm, measureRange }
    setIsLoading(true)
    setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-reference-audio`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token}`,
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ takeId }),
        },
      )
      const body = await resp.json()
      if (!resp.ok || body.error) throw new Error(body.error || 'Failed to generate reference audio')

      if (!audioRef.current) audioRef.current = new Audio()
      audioRef.current.src = body.audioUrl
      audioRef.current.preservesPitch = true
      const freshTimeline = Array.isArray(body.timeline) ? body.timeline : []
      setTimeline(freshTimeline)
      setBaselineBpm(body.bpm)
      setTempoState(body.bpm)
      setMeasureRange(body.measureRange ?? null)
      return { timeline: freshTimeline, bpm: body.bpm, measureRange: body.measureRange ?? null }
    } catch (e) {
      setError(e.message || 'Failed to generate reference audio')
      return null
    } finally {
      setIsLoading(false)
    }
  }, [takeId, timeline, baselineBpm, measureRange])

  const setTempo = useCallback((bpm) => {
    setTempoState(bpm)
    if (audioRef.current && baselineBpm) {
      audioRef.current.playbackRate = bpm / baselineBpm
    }
  }, [baselineBpm])

  const clearRangeWatcher = useCallback(() => {
    const audio = audioRef.current
    if (audio && rangeEndRef.current) {
      audio.removeEventListener('timeupdate', rangeEndRef.current)
      rangeEndRef.current = null
    }
  }, [])

  // Plays a measure range, generating the reference audio first if it hasn't
  // been fetched yet — the range-selection UI (this hook's other consumer,
  // see Task 7) has no reason to require a separate "Play reference" click
  // first, and silently no-op-ing when nothing is loaded yet would be a real
  // bug, not just an edge case to note for later.
  //
  // Uses generate()'s RETURNED timeline, not the `timeline` state variable,
  // when it just triggered a fresh generation — setTimeline's update has not
  // flushed by the time this resumes from `await generate()`, so reading the
  // `timeline` closure variable here would still see the pre-generation
  // value (usually []) and silently fail to find either measure.
  const playRange = useCallback(async (startMeasure, endMeasure) => {
    let tl = timeline
    if (!audioRef.current?.src) {
      const result = await generate()
      if (!result) return
      tl = result.timeline
    }
    const audio = audioRef.current
    if (!audio || !audio.src || !tl.length) return
    const startEntry = tl.find(t => t.measure === startMeasure)
    const endEntry = tl.find(t => t.measure === endMeasure) ?? startEntry
    if (!startEntry || !endEntry) return

    clearRangeWatcher()
    audio.currentTime = startEntry.start_sec
    const stopAt = endEntry.end_sec
    const onTick = () => {
      if (audio.currentTime >= stopAt) {
        audio.pause()
        setIsPlaying(false)
        clearRangeWatcher()
      }
    }
    rangeEndRef.current = onTick
    audio.addEventListener('timeupdate', onTick)
    audio.play()
    setIsPlaying(true)
  }, [timeline, clearRangeWatcher, generate])

  // Same "generate on first use" shape as playRange, and for the same
  // reason: composing this as two separate calls in the component
  // (onGenerate() then onPlayPause(), not awaited between them) would let
  // the play call run before generation finishes and silently no-op on the
  // still-empty audio.src — consolidating both into one hook function avoids
  // that race entirely rather than requiring the caller to sequence it
  // correctly.
  const togglePlayPause = useCallback(async () => {
    if (!audioRef.current?.src) {
      const result = await generate()
      if (!result) return
      audioRef.current.play()
      setIsPlaying(true)
      return
    }
    const audio = audioRef.current
    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
    } else {
      clearRangeWatcher()
      audio.play()
      setIsPlaying(true)
    }
  }, [isPlaying, clearRangeWatcher, generate])

  return useMemo(() => ({
    audioRef, timeline, isLoading, error, isPlaying, tempo, measureRange,
    generate, playRange, setTempo, togglePlayPause,
  }), [timeline, isLoading, error, isPlaying, tempo, measureRange, generate, playRange, setTempo, togglePlayPause])
}
