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
  // Always holds the latest takeId, read (not just captured at generate()
  // call time) inside the poll loop below — lets an in-flight generate()
  // notice it's been superseded by a takeId change and bail out instead
  // of writing a stale take's audio/timeline into the new take's state.
  // Synced via effect, not a direct render-body assignment, matching the
  // same ref-sync pattern already used by Coach.jsx's takeRef (this
  // project's lint config forbids writing ref.current during render).
  const takeIdRef = useRef(takeId)
  useEffect(() => { takeIdRef.current = takeId }, [takeId])
  // Holds the in-flight generate() promise, if one is running. generate()'s
  // only other re-entrancy guard (audioRef.current?.src) is checked once,
  // before any async work, so two calls issued close together (e.g. the
  // main "Play reference" button and the drag-to-select range's own play
  // button, which has no disabled state of its own) would otherwise both
  // pass that check and each independently POST to generate-reference-audio
  // and poll for up to ~17 minutes — a real duplicate paid Modal generation,
  // not just a wasted HTTP call, since each spawns its own full 2-3x vision
  // cross-validation. Callers now share the SAME in-flight promise instead.
  const generateInFlightRef = useRef(null)
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
    // A generate() already in flight — share its promise instead of
    // starting a second, independent (and independently paid) generation.
    if (generateInFlightRef.current) return generateInFlightRef.current
    const myTakeId = takeId
    setIsLoading(true)
    setError('')
    const runGenerate = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        }
        const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-reference-audio`

        // Reference-audio generation now runs as a background job. The score
        // read cross-validates with 2-3 sequential vision calls (see
        // read_score_notes_claude in worker.py) instead of 1, and the Modal
        // background function's own timeout was raised to 890s to give that
        // room — 120 attempts (10 minutes) could time out on a legitimately
        // still-running generation before it ever got a chance to finish.
        // 200 attempts (~16.7 minutes) stays comfortably above the backend's
        // own 950s self-heal window (generate-reference-audio/index.ts).
        let body = null
        for (let attempt = 0; attempt < 200; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 5000))
          if (takeIdRef.current !== myTakeId) return null
          try {
            const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ takeId }) })
            if (!resp.ok) continue
            const json = await resp.json()
            if (json.status === 'done') { body = json; break }
            if (json.status === 'failed') throw new Error(json.error || 'Failed to generate reference audio')
            // status === 'processing' -> keep polling
          } catch (pollErr) {
            if (pollErr.message && !pollErr.message.includes('Failed to fetch')) throw pollErr
          }
        }
        if (!body) throw new Error('Reference audio is taking longer than expected. Please try again in a moment.')
        if (takeIdRef.current !== myTakeId) return null

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
        generateInFlightRef.current = null
      }
    }
    const promise = runGenerate()
    generateInFlightRef.current = promise
    return promise
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
    try {
      await audio.play()
      setIsPlaying(true)
    } catch (e) {
      clearRangeWatcher()
      setError(e.message || 'Could not play reference audio')
    }
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
      try {
        await audioRef.current.play()
        setIsPlaying(true)
      } catch (e) {
        setError(e.message || 'Could not play reference audio')
      }
      return
    }
    const audio = audioRef.current
    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
    } else {
      clearRangeWatcher()
      try {
        await audio.play()
        setIsPlaying(true)
      } catch (e) {
        setError(e.message || 'Could not play reference audio')
      }
    }
  }, [isPlaying, clearRangeWatcher, generate])

  return useMemo(() => ({
    audioRef, timeline, isLoading, error, isPlaying, tempo, measureRange,
    generate, playRange, setTempo, togglePlayPause,
  }), [timeline, isLoading, error, isPlaying, tempo, measureRange, generate, playRange, setTempo, togglePlayPause])
}
