import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'
import { corsHeaders } from '../_shared/cors.ts'
import { sendEmail, emailWrapper, ctaButton } from '../_shared/email.ts'

// ── Gemini video analysis via Files API ───────────────────────────────────────
// ── Tempo → seconds per measure ──────────────────────────────────────────────
function secsPerMeasure(timeSig: string, bpm: number): number | null {
  const m = timeSig.match(/^(\d+)\/(\d+)$/)
  if (!m || bpm <= 0) return null
  const num = parseInt(m[1])
  const den = parseInt(m[2])
  return (num / den) * 240 / bpm
}

const FLAG_TYPES = new Set([
  'timing',
  'rhythm',
  'intonation',
  'dynamics',
  'articulation',
  'technique',
  'tone',
  'phrasing',
  'posture',
  'error',
])

type EvidenceKind = 'audio-video' | 'visual-only' | 'score-only'

type NormalizedFlag = {
  measure: number
  measure_end: number | null
  type: string
  confidence: number
  title: string
  detail: string
  timestamp_start: number
  timestamp_end: number
  evidence: EvidenceKind
  confidence_reason: string
  review_priority: 'high' | 'medium' | 'low'
}

type MeasureTimelineEntry = {
  measure: number
  start: number
  end: number
  beats: number
  notes: number
  rests: number
  onsets: number
  silenceRatio: number
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function cleanText(value: unknown, fallback: string, max = 900): string {
  const text = String(value ?? fallback).replace(/\s+/g, ' ').trim()
  return (text || fallback).slice(0, max)
}

function normalizeType(type: unknown, fallback = 'technique'): string {
  const raw = String(type ?? fallback).toLowerCase().trim()
  if (raw === 'rhythmic') return 'timing'
  if (raw === 'pitch') return 'intonation'
  if (raw === 'body' || raw === 'position') return 'technique'
  return FLAG_TYPES.has(raw) ? raw : fallback
}

function inferMeasureFromTimestamp(
  timestamp: number,
  safeStart: number,
  maxMeasure: number,
  timeSig: string,
  tempo: number,
  measureTimeline?: MeasureTimelineEntry[],
): number | null {
  if (measureTimeline?.length && timestamp > 0) {
    const hit = measureTimeline.find(m => timestamp >= m.start && timestamp < m.end)
    if (hit) return clamp(hit.measure, safeStart, maxMeasure)
  }
  const spm = secsPerMeasure(timeSig, tempo)
  if (!spm || spm <= 0 || timestamp <= 0) return null
  return clamp(safeStart + Math.floor(timestamp / spm), safeStart, maxMeasure)
}

function inferTimestampFromMeasure(
  measure: number,
  measureTimeline?: MeasureTimelineEntry[],
): number | null {
  if (!measureTimeline?.length) return null
  const hit = measureTimeline.find(m => m.measure === measure)
  return hit ? hit.start : null
}

function normalizeFlag(f: any, opts: {
  safeStart: number
  safeEnd: number | null
  timeSig: string
  tempo: number
  evidence: EvidenceKind
  defaultType: string
  defaultTitle: string
  confidenceCap: number
  confidenceDefault: number
  timestampWindow: number
  measureTimeline?: MeasureTimelineEntry[]
  hasStructuredScore?: boolean
  hasAudioFeatures?: boolean
}): NormalizedFlag | null {
  if (!f || typeof f !== 'object') return null

  const maxMeasure = opts.safeEnd ?? opts.safeStart + 200
  const rawStart = Number(f.timestamp_start)
  const timestampStart = opts.evidence === 'score-only'
    ? 0
    : Math.max(0, Number.isFinite(rawStart) ? rawStart : 0)

  const declaredMeasure = Math.round(Number(f.measure_start ?? f.measure) || 0)
  const inferredMeasure = inferMeasureFromTimestamp(timestampStart, opts.safeStart, maxMeasure, opts.timeSig, opts.tempo, opts.measureTimeline)
  const declaredMeasureInRange = declaredMeasure >= opts.safeStart && declaredMeasure <= maxMeasure
    ? declaredMeasure
    : null
  let measure = declaredMeasureInRange ?? inferredMeasure ?? opts.safeStart
  const timelineCorrectedMeasure = Boolean(
    opts.evidence === 'audio-video'
    && timestampStart > 0
    && declaredMeasureInRange != null
    && inferredMeasure != null
    && Math.abs(declaredMeasureInRange - inferredMeasure) > 1
  )
  if (timelineCorrectedMeasure && inferredMeasure != null) {
    measure = inferredMeasure
  }

  const declaredEnd = f.measure_end != null ? Math.round(Number(f.measure_end)) : null
  const measureEnd = declaredEnd != null && declaredEnd > measure && declaredEnd <= maxMeasure
    ? declaredEnd
    : null

  const rawEnd = Number(f.timestamp_end)
  const timelineTimestamp = opts.evidence === 'score-only' || timestampStart > 0
    ? null
    : inferTimestampFromMeasure(measure, opts.measureTimeline)
  const alignedTimestampStart = timelineTimestamp ?? timestampStart
  const timestampEnd = opts.evidence === 'score-only'
    ? 0
    : rawEnd > alignedTimestampStart
      ? rawEnd
      : alignedTimestampStart + opts.timestampWindow

  const type = normalizeType(f.type, opts.defaultType)
  const rawConfidence = Math.round(Number(f.confidence) || opts.confidenceDefault)
  const timelineMeasure = opts.measureTimeline?.find(m => m.measure === measure)
  const restOnlyPitchClaim = Boolean(
    opts.hasStructuredScore
    && timelineMeasure
    && timelineMeasure.notes === 0
    && timelineMeasure.rests > 0
    && ['intonation', 'error', 'articulation'].includes(type)
  )
  const silentWindowClaim = Boolean(
    timelineMeasure
    && timelineMeasure.silenceRatio >= 0.65
    && ['timing', 'rhythm', 'intonation', 'articulation', 'error', 'tone'].includes(type)
  )
  const lowOnsetClaim = Boolean(
    opts.hasAudioFeatures
    && timelineMeasure
    && timelineMeasure.onsets === 0
    && ['timing', 'rhythm', 'articulation', 'error'].includes(type)
  )
  const unanchoredAudioClaim = Boolean(
    opts.evidence === 'audio-video'
    && timestampStart <= 0
    && !timelineTimestamp
  )
  const confidenceCap = [
    opts.confidenceCap,
    restOnlyPitchClaim ? 68 : opts.confidenceCap,
    silentWindowClaim ? 66 : opts.confidenceCap,
    lowOnsetClaim ? 72 : opts.confidenceCap,
    unanchoredAudioClaim ? 74 : opts.confidenceCap,
  ].reduce((min, cap) => Math.min(min, cap), opts.confidenceCap)
  const confidence = clamp(rawConfidence, 45, confidenceCap)
  const reviewPriority = confidence >= 84 ? 'high' : confidence >= 68 ? 'medium' : 'low'
  const sourceText = opts.evidence === 'audio-video'
    ? 'Full recording was analyzed; confidence reflects audible evidence plus score context when available.'
    : opts.evidence === 'visual-only'
      ? 'Based on sampled video frames only; timing, pitch, and dynamics are not directly verified.'
      : 'Score-based coaching note only; not verified against the recording.'
  const confidenceReason = [
    f.confidence_reason ?? sourceText,
    timelineCorrectedMeasure ? `Measure adjusted from m.${declaredMeasureInRange} to m.${measure} using timestamp alignment.` : null,
    restOnlyPitchClaim ? 'Confidence capped because the score timeline marks this measure as rest-heavy.' : null,
    silentWindowClaim ? 'Confidence capped because objective audio marks this window as mostly silence.' : null,
    lowOnsetClaim ? 'Confidence capped because objective audio did not find clear note attacks in this measure window.' : null,
    unanchoredAudioClaim ? 'Confidence capped because the issue had no reliable timestamp anchor.' : null,
  ].filter(Boolean).join(' ')

  return {
    measure,
    measure_end: measureEnd,
    type,
    confidence,
    title: cleanText(f.title, opts.defaultTitle, 110),
    detail: cleanText(f.detail, 'Review this passage slowly and compare it against the score and recording.', 1200),
    timestamp_start: Number(alignedTimestampStart.toFixed(2)),
    timestamp_end: Number(timestampEnd.toFixed(2)),
    evidence: opts.evidence,
    confidence_reason: cleanText(confidenceReason, sourceText, 360),
    review_priority: reviewPriority,
  }
}

function dedupeFlags(flags: NormalizedFlag[]): NormalizedFlag[] {
  const merged: NormalizedFlag[] = []
  for (const flag of flags) {
    const same = merged.find(existing => {
      const sameType = existing.type === flag.type
      const closeMeasure = Math.abs(existing.measure - flag.measure) <= 1
      const closeTime = flag.timestamp_start > 0 && existing.timestamp_start > 0
        ? Math.abs(existing.timestamp_start - flag.timestamp_start) < 1.5
        : false
      const titleOverlap = existing.title.toLowerCase().slice(0, 18) === flag.title.toLowerCase().slice(0, 18)
      return sameType && (closeTime || (closeMeasure && titleOverlap))
    })

    if (!same) {
      merged.push(flag)
      continue
    }

    same.confidence = Math.max(same.confidence, flag.confidence)
    same.review_priority = same.confidence >= 84 ? 'high' : same.confidence >= 68 ? 'medium' : 'low'
    same.timestamp_start = Math.min(same.timestamp_start || flag.timestamp_start, flag.timestamp_start || same.timestamp_start)
    same.timestamp_end = Math.max(same.timestamp_end, flag.timestamp_end)
    same.measure = Math.min(same.measure, flag.measure)
    same.measure_end = Math.max(same.measure_end ?? same.measure, flag.measure_end ?? flag.measure) > same.measure
      ? Math.max(same.measure_end ?? same.measure, flag.measure_end ?? flag.measure)
      : null
    if (flag.detail.length > same.detail.length) same.detail = flag.detail
  }

  return merged
    .sort((a, b) => (a.timestamp_start || a.measure) - (b.timestamp_start || b.measure))
    .slice(0, 8)
}

function finalizeFlags(flags: NormalizedFlag[], evidence: EvidenceKind): NormalizedFlag[] {
  return flags
    .filter(flag => {
      const title = flag.title.toLowerCase()
      const detail = flag.detail.toLowerCase()
      const genericTitle = /^(issue detected|practice risk|visible technique issue|review this passage)$/i.test(flag.title.trim())
      const genericDetail = detail.includes('review this passage slowly') || detail.length < 80
      if (genericTitle && genericDetail) return false
      if (evidence === 'audio-video' && flag.confidence < 52) return false
      if (evidence === 'audio-video' && flag.timestamp_start <= 0 && flag.confidence < 70) return false
      if (evidence === 'visual-only' && flag.confidence < 50) return false
      if (title.includes('generic') || title.includes('unclear issue')) return false
      return true
    })
    .slice(0, 8)
}

function calibrateScore(rawScore: number, flags: NormalizedFlag[], evidence: EvidenceKind): number {
  let score = clamp(Math.round(rawScore), 0, 100)
  const high = flags.filter(f => f.review_priority === 'high').length
  const medium = flags.filter(f => f.review_priority === 'medium').length

  if (flags.length === 0) score = Math.max(score, 90)
  if (flags.length >= 6 || high >= 3) score = Math.min(score, 78)
  else if (flags.length >= 4 || high >= 2) score = Math.min(score, 84)
  else if (flags.length >= 2 || medium >= 2) score = Math.min(score, 92)
  if (evidence === 'visual-only') score = Math.min(score, 88)
  if (evidence === 'score-only') score = Math.min(score, 72)

  return score
}

function buildQuality(opts: {
  trust: 'high' | 'medium' | 'low'
  backend: string
  evidence: EvidenceKind
  flags: NormalizedFlag[]
  reasons?: string[]
  backendError?: string | null
  scoreContext?: string
}) {
  const averageConfidence = opts.flags.length
    ? Math.round(opts.flags.reduce((sum, f) => sum + f.confidence, 0) / opts.flags.length)
    : opts.trust === 'high' ? 90 : opts.trust === 'medium' ? 74 : 58

  return {
    trust: opts.trust,
    evidence: opts.evidence,
    backend: opts.backend,
    overall_confidence: averageConfidence,
    reasons: opts.reasons ?? [],
    limitations: opts.evidence === 'audio-video'
      ? ['Measure placement depends on the provided start/end measure and tempo metadata.']
      : opts.evidence === 'visual-only'
        ? ['Only sampled frames were available; audio details like pitch, timing, and dynamics are not directly verified.']
        : ['This is score-aware coaching, not verified performance analysis. Upload/processable video analysis is required for timestamps.'],
    score_context: opts.scoreContext ?? null,
    ...(opts.backendError ? { fallback_reason: opts.backendError } : {}),
  }
}

function scorePartMatchText(part: any): string {
  return [
    part?.id,
    part?.name,
    part?.abbreviation,
    part?.instrumentName,
  ].filter(Boolean).join(' ').toLowerCase()
}

function partMatchScore(part: any, requestedInstrument: string, requestedPart: string): number {
  const haystack = scorePartMatchText(part)
  const needles = [requestedPart, requestedInstrument]
    .flatMap(value => String(value ?? '').toLowerCase().split(/[^a-z0-9]+/))
    .filter(token => token.length >= 2)

  let score = 0
  for (const token of needles) {
    if (haystack === token) score += 8
    else if (haystack.includes(token)) score += token.length >= 5 ? 5 : 2
  }

  if (/clarinet/.test(requestedInstrument.toLowerCase()) && /clarinet|cl\b/.test(haystack)) score += 6
  if (/violin/.test(requestedInstrument.toLowerCase()) && /violin|vln/.test(haystack)) score += 6
  if (/viola/.test(requestedInstrument.toLowerCase()) && /viola|vla/.test(haystack)) score += 6
  if (/cello/.test(requestedInstrument.toLowerCase()) && /cello|violoncello|vc\b/.test(haystack)) score += 6
  if (/flute/.test(requestedInstrument.toLowerCase()) && /flute|fl\b/.test(haystack)) score += 6
  if (/piano|keyboard/.test(requestedInstrument.toLowerCase()) && /piano|keyboard|pno/.test(haystack)) score += 6
  return score
}

function selectScoreFactsForPart(scoreFacts: any, requestedInstrument: string, requestedPart: string): any {
  if (!scoreFacts || typeof scoreFacts !== 'object') return null
  const parts = Array.isArray(scoreFacts.parts) ? scoreFacts.parts : []
  if (!parts.length) return scoreFacts

  const ranked = parts
    .map((part: any, index: number) => ({
      part,
      index,
      score: partMatchScore(part, requestedInstrument, requestedPart),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)

  const selected = ranked[0]?.score > 0 ? ranked[0].part : parts[0]
  return {
    ...scoreFacts,
    selectedPart: {
      id: selected.id ?? '',
      name: selected.name ?? '',
      abbreviation: selected.abbreviation ?? '',
      instrumentName: selected.instrumentName ?? '',
      matchScore: ranked[0]?.score ?? 0,
    },
    measureCount: selected.measureCount ?? scoreFacts.measureCount,
    timeSignature: selected.timeSignature ?? scoreFacts.timeSignature,
    keyFifths: selected.keyFifths ?? scoreFacts.keyFifths,
    measures: Array.isArray(selected.measures) ? selected.measures : scoreFacts.measures,
  }
}

function compactScoreFacts(scoreFacts: any): string {
  if (!scoreFacts || typeof scoreFacts !== 'object') return 'No structured score facts were available.'
  const measures = Array.isArray(scoreFacts.measures) ? scoreFacts.measures : []
  const denseMeasures = measures.slice(0, 90).map((m: any) => {
    const measure = cleanText(m.measure, '?', 12)
    const notes = Number(m.notes ?? 0)
    const rests = Number(m.rests ?? 0)
    const beats = Number(m.writtenQuarterBeats ?? 0)
    const expected = Number(m.expectedQuarterBeats ?? 0)
    const pitches = Array.isArray(m.pitches) && m.pitches.length
      ? ` pitches:${m.pitches.slice(0, 10).join(' ')}`
      : ''
    const dynamics = Array.isArray(m.dynamics) && m.dynamics.length
      ? ` dyn:${m.dynamics.slice(0, 4).join('/')}`
      : ''
    const articulations = Array.isArray(m.articulations) && m.articulations.length
      ? ` art:${m.articulations.slice(0, 4).join('/')}`
      : ''
    return `m.${measure} beats:${beats}/${expected} notes:${notes} rests:${rests}${pitches}${dynamics}${articulations}`
  }).join('\n')

  return [
    `Structured score facts (${scoreFacts.source ?? 'unknown'}):`,
    `title=${scoreFacts.title ?? ''}; composer=${scoreFacts.composer ?? ''}; measures=${scoreFacts.measureCount ?? measures.length}; time=${scoreFacts.timeSignature ?? ''}; keyFifths=${scoreFacts.keyFifths ?? ''}`,
    scoreFacts.selectedPart ? `selectedPart=${scoreFacts.selectedPart.name || scoreFacts.selectedPart.instrumentName || scoreFacts.selectedPart.id}; matchScore=${scoreFacts.selectedPart.matchScore ?? 0}` : '',
    denseMeasures || 'No measure-level facts extracted.',
  ].filter(Boolean).join('\n').slice(0, 15000)
}

function compactAudioFeatures(audioFeatures: any): string {
  if (!audioFeatures || typeof audioFeatures !== 'object') return 'No objective audio feature packet was available.'
  const onsets = Array.isArray(audioFeatures.onsetCandidates)
    ? audioFeatures.onsetCandidates.slice(0, 90).map((o: any) => `${Number(o.time ?? 0).toFixed(2)}s`).join(', ')
    : ''
  const silences = Array.isArray(audioFeatures.silenceSegments)
    ? audioFeatures.silenceSegments.slice(0, 24).map((s: any) => `${Number(s.start ?? 0).toFixed(2)}-${Number(s.end ?? 0).toFixed(2)}s`).join(', ')
    : ''

  return [
    `Objective audio features (${audioFeatures.source ?? 'unknown'}):`,
    `duration=${audioFeatures.duration ?? 'unknown'}s; active=${audioFeatures.activeStart ?? 0}-${audioFeatures.activeEnd ?? audioFeatures.duration ?? 'unknown'}s; activeRatio=${audioFeatures.activeRatio ?? 'unknown'}; onsetCount=${audioFeatures.onsetCount ?? 'unknown'}; meanRms=${audioFeatures.meanRms ?? 'unknown'}; maxRms=${audioFeatures.maxRms ?? 'unknown'}`,
    `onset candidates: ${onsets || 'none'}`,
    `silence/rest candidates: ${silences || 'none'}`,
  ].join('\n').slice(0, 10000)
}

function expectedQuarterBeats(timeSig: string): number {
  const m = timeSig.match(/^(\d+)\/(\d+)$/)
  if (!m) return 4
  const num = parseInt(m[1])
  const den = parseInt(m[2])
  return Number.isFinite(num) && Number.isFinite(den) && den > 0 ? num * (4 / den) : 4
}

function numericMeasure(value: unknown): number | null {
  const match = String(value ?? '').match(/\d+/)
  if (!match) return null
  const n = parseInt(match[0], 10)
  return Number.isFinite(n) ? n : null
}

function overlapSeconds(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

function buildMeasureTimeline(opts: {
  scoreFacts?: any
  audioFeatures?: any
  safeStart: number
  safeEnd: number | null
  timeSig: string
  tempo: number
}): MeasureTimelineEntry[] {
  const maxMeasure = opts.safeEnd ?? opts.safeStart + 80
  const scoreMeasures = Array.isArray(opts.scoreFacts?.measures) ? opts.scoreFacts.measures : []
  const sourceMeasures = scoreMeasures
    .map((m: any, index: number) => {
      const measure = numericMeasure(m.measure) ?? index + 1
      return {
        measure,
        beats: Number(m.writtenQuarterBeats || m.expectedQuarterBeats || 0),
        notes: Number(m.notes ?? 0),
        rests: Number(m.rests ?? 0),
      }
    })
    .filter((m: { measure: number }) => m.measure >= opts.safeStart && m.measure <= maxMeasure)
    .slice(0, 140)

  const fallbackBeats = expectedQuarterBeats(opts.timeSig)
  const measures = sourceMeasures.length
    ? sourceMeasures
    : Array.from({ length: Math.min(80, maxMeasure - opts.safeStart + 1) }, (_, i) => ({
      measure: opts.safeStart + i,
      beats: fallbackBeats,
      notes: 0,
      rests: 0,
    }))

  if (!measures.length) return []

  const audioDuration = Number(opts.audioFeatures?.duration ?? 0)
  const activeStart = Math.max(0, Number(opts.audioFeatures?.activeStart ?? 0) || 0)
  const activeEnd = Number(opts.audioFeatures?.activeEnd ?? 0) > activeStart
    ? Number(opts.audioFeatures.activeEnd)
    : audioDuration
  const activeDuration = activeEnd > activeStart ? activeEnd - activeStart : audioDuration
  const totalBeats = measures.reduce((sum, m) => sum + Math.max(0.25, Number(m.beats) || fallbackBeats), 0)
  const secondsPerBeat = activeDuration > 0 && totalBeats > 0
    ? activeDuration / totalBeats
    : opts.tempo > 0 ? 60 / opts.tempo : 1
  const onsets = Array.isArray(opts.audioFeatures?.onsetCandidates)
    ? opts.audioFeatures.onsetCandidates
      .map((o: any) => Number(o.time))
      .filter((time: number) => Number.isFinite(time) && time >= 0)
    : []
  const silences = Array.isArray(opts.audioFeatures?.silenceSegments)
    ? opts.audioFeatures.silenceSegments
      .map((s: any) => ({ start: Number(s.start), end: Number(s.end) }))
      .filter((s: { start: number; end: number }) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    : []

  let cursor = activeStart
  return measures.map(m => {
    const beats = Math.max(0.25, Number(m.beats) || fallbackBeats)
    const start = cursor
    const end = start + beats * secondsPerBeat
    const duration = Math.max(0.01, end - start)
    const onsetCount = onsets.filter(time => time >= start && time < end).length
    const silenceSeconds = silences.reduce((sum, s) => sum + overlapSeconds(start, end, s.start, s.end), 0)
    cursor = end
    return {
      measure: m.measure,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      beats: Number(beats.toFixed(3)),
      notes: Math.max(0, Number(m.notes) || 0),
      rests: Math.max(0, Number(m.rests) || 0),
      onsets: onsetCount,
      silenceRatio: Number(clamp(silenceSeconds / duration, 0, 1).toFixed(2)),
    }
  })
}

function compactMeasureTimeline(timeline: MeasureTimelineEntry[]): string {
  if (!timeline.length) return 'No estimated measure timeline available.'
  return [
    'Estimated measure timeline. Use as an alignment guardrail, not as perfect ground truth:',
    timeline.slice(0, 100).map(m =>
      `m.${m.measure}: ${m.start.toFixed(2)}-${m.end.toFixed(2)}s beats:${m.beats} notes:${m.notes} rests:${m.rests} onsets:${m.onsets} silence:${Math.round(m.silenceRatio * 100)}%`
    ).join('\n'),
  ].join('\n').slice(0, 10000)
}

function evidenceReasons(scoreFacts: any, audioFeatures: any, timeline: MeasureTimelineEntry[]): string[] {
  const reasons: string[] = []
  if (scoreFacts?.source === 'musicxml') {
    reasons.push('Structured MusicXML/MXL score facts were used for measures, rests, notes, dynamics, and articulations.')
  } else {
    reasons.push('No structured MusicXML/MXL score facts were available; score reading may depend on image/model interpretation.')
  }
  if (audioFeatures?.source === 'web-audio') {
    reasons.push('Browser-extracted audio features were used for active range, silence, and onset guardrails.')
  } else {
    reasons.push('No browser-extracted audio feature packet was available; timing alignment relies more heavily on model/video analysis.')
  }
  if (timeline.length) {
    reasons.push('An estimated measure timeline was used to correct measure/timestamp drift.')
  }
  return reasons
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function loadScoreContext(scoreUrl: string | null, scoreMimeType: string | null): Promise<{
  parts: any[]
  promptNote: string
  qualityNote: string
}> {
  if (!scoreUrl || !scoreMimeType) {
    return { parts: [], promptNote: 'No score file was provided to the model; do not overclaim exact note comparisons.', qualityNote: 'metadata-only' }
  }

  const mime = scoreMimeType.toLowerCase()
  try {
    if (/image\/(jpeg|jpg|png|webp)/i.test(mime)) {
      const res = await fetch(scoreUrl)
      if (!res.ok) throw new Error(`score fetch ${res.status}`)
      const length = Number(res.headers.get('content-length') || 0)
      if (length > 8 * 1024 * 1024) {
        return {
          parts: [],
          promptNote: 'The score image was too large to attach; use piece metadata and audio only.',
          qualityNote: 'score-image-too-large',
        }
      }
      const b64 = arrayBufferToBase64(await res.arrayBuffer())
      return {
        parts: [{ inlineData: { mimeType: scoreMimeType, data: b64 } }],
        promptNote: 'A score image is attached after the video. Use it to align measure numbers and visible notation, but do not invent unreadable notes.',
        qualityNote: 'score-image-attached',
      }
    }

    if (mime.includes('xml') || mime.includes('text')) {
      const res = await fetch(scoreUrl)
      if (!res.ok) throw new Error(`score fetch ${res.status}`)
      const text = (await res.text()).slice(0, 65000)
      return {
        parts: [{ text: `SCORE CONTEXT (MusicXML/text excerpt, truncated if long):\n${text}` }],
        promptNote: 'MusicXML/text score context is attached. Prefer it over visual guessing for measures, rests, and notation.',
        qualityNote: 'score-text-attached',
      }
    }
  } catch (err) {
    console.warn('[score-context] unavailable:', (err as Error).message)
  }

  return {
    parts: [],
    promptNote: 'The score file could not be attached in a model-readable form; keep note/measure claims conservative.',
    qualityNote: 'score-context-unavailable',
  }
}

async function runGeminiVideo(opts: {
  takeId:       string
  videoUrl:     string
  videoMimeType: string
  scoreUrl:     string | null
  scoreMimeType: string | null
  pieceTitle:   string
  composer:     string
  instrument:   string
  timeSig:      string
  keySignature: string
  safeStart:    number
  safeEnd:      number | null
  tempo:        number
  difficulty:   string
  priorTake:    { score: number | null; flags: any[] } | null
  scoreFacts?:   unknown
  audioFeatures?: unknown
  measureTimeline?: MeasureTimelineEntry[]
  userNote?:    string
}): Promise<{ score: number; flags: NormalizedFlag[]; scoreContext: string }> {
  const apiKey = Deno.env.get('GOOGLE_AI_API_KEY')
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not configured')

  // Fetch video — read headers only, do NOT buffer the body (avoids OOM on large files)
  const videoRes = await fetch(opts.videoUrl)
  if (!videoRes.ok) throw new Error(`Video fetch failed: ${videoRes.status}`)
  const contentLength = videoRes.headers.get('content-length') ?? '0'
  console.log(`[gemini] streaming ${contentLength}b to Files API`)

  // Start Gemini Files API resumable upload
  const initResp = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol':              'resumable',
        'X-Goog-Upload-Command':               'start',
        'X-Goog-Upload-Header-Content-Length': contentLength,
        'X-Goog-Upload-Header-Content-Type':   opts.videoMimeType,
        'Content-Type':                         'application/json',
      },
      body: JSON.stringify({ file: { displayName: 'performance' } }),
    }
  )
  if (!initResp.ok) {
    const t = await initResp.text()
    throw new Error(`Files API init failed ${initResp.status}: ${t.slice(0, 400)}`)
  }
  const uploadUrl = initResp.headers.get('X-Goog-Upload-URL')
  if (!uploadUrl) throw new Error('No Gemini upload URL returned')

  // Stream video body directly to Gemini — never loaded into heap
  const uploadResp = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset':  '0',
      'Content-Type':          opts.videoMimeType,
      'Content-Length':        contentLength,
    },
    body: videoRes.body,
  })
  if (!uploadResp.ok) {
    const t = await uploadResp.text()
    throw new Error(`File upload failed ${uploadResp.status}: ${t.slice(0, 200)}`)
  }
  const fileInfo = await uploadResp.json()
  const fileUri  = fileInfo.file?.uri
  const fileName = fileInfo.file?.name
  if (!fileUri) throw new Error('No fileUri from Gemini upload')

  // Wait until ACTIVE — max 45s (15 × 3s)
  let state = fileInfo.file?.state ?? 'PROCESSING'
  for (let i = 0; i < 15 && state === 'PROCESSING'; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const s = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`)
    state = (await s.json()).state ?? 'FAILED'
  }
  if (state !== 'ACTIVE') throw new Error(`File never became ACTIVE (state: ${state})`)

  const measureRange = opts.safeEnd
    ? `measures ${opts.safeStart}–${opts.safeEnd}`
    : `from measure ${opts.safeStart}`
  const scoreContext = await loadScoreContext(opts.scoreUrl, opts.scoreMimeType)

  const instrumentFamily = (() => {
    const i = opts.instrument.toLowerCase()
    if (/clarinet|flute|oboe|bassoon|saxophone/.test(i)) return 'woodwind'
    if (/trumpet|trombone|french horn|tuba|horn/.test(i)) return 'brass'
    if (/violin|viola|cello|double bass|bass/.test(i)) return 'strings'
    if (/piano|keyboard/.test(i)) return 'piano'
    if (/voice|soprano|alto|tenor|bass/.test(i)) return 'voice'
    return 'other'
  })()

  const instrumentSpecific = {
    woodwind: `For woodwind (${opts.instrument}): listen for squeaks, cracks, tone breaks, over-blowing that drives pitch sharp, breathy tone from weak air support, smeared tonguing, and register-key/harmonic issues. Only flag them when clearly present.`,
    brass: `For brass (${opts.instrument}): listen for missed lip slurs, clipped or smeared valve attacks, notes that do not speak cleanly, upper-register intonation drift, and breath support failures that make notes sag or cut out.`,
    strings: `For strings (${opts.instrument}): listen for bow scratches, tone cracks, clipped string crossings, late or out-of-tune shifts, open string intonation issues, and bow instability that breaks the line.`,
    piano: `For piano: listen for clearly wrong notes, notes that do not speak, pedal blur, uneven voicing, and rushing/dragging between melody and accompaniment.`,
    voice: `For voice: listen for sharp/flat pitch centers, unstable vibrato, vowel changes that affect pitch, and breath support failures at phrase ends.`,
    other: `Listen for clearly supported wrong notes, tone issues, intonation drift, rhythmic instability, and technique problems.`,
  }[instrumentFamily]

  const difficultyTone = {
    Beginner: `STUDENT LEVEL: Beginner. Write all feedback in plain, friendly language — no jargon. Focus on the most important basics: correct notes, steady beat, basic posture. Give short, concrete fixes like "try playing this passage slowly, one note at a time." Avoid terms like intonation, articulation, or dynamics unless you explain them simply.`,
    Intermediate: `STUDENT LEVEL: Intermediate. Use moderate musical language. The student understands basic terms like dynamics, rhythm, and intonation. Focus on consistency, phrasing, and cleaner technique. Reference specific passages and markings when relevant.`,
    Advanced: `STUDENT LEVEL: Advanced. Use full conservatory-level language. The student expects precise technical feedback: intonation tendencies by note name, specific articulation markings, bow or breath technique, tonal projection, and musical interpretation. Be direct and detailed.`,
  }[opts.difficulty] ?? ''
  const scoreFactsText = compactScoreFacts(opts.scoreFacts)
  const audioFeaturesText = compactAudioFeatures(opts.audioFeatures)
  const timelineText = compactMeasureTimeline(opts.measureTimeline ?? [])

  const prompt = `AUDIO-FIRST PERFORMANCE ANALYSIS TASK. You are analyzing a student's performance video. Your primary job is to LISTEN and report issues that are clearly supported by the recording. Use visual information only when it explains an audible or technical problem.

You are a constructive music performance coach. Be specific and honest, but do not force issues. If evidence is uncertain, lower confidence or omit the flag.
${difficultyTone ? `\n${difficultyTone}\n` : ''}
Piece: "${opts.pieceTitle}" by ${opts.composer}
Instrument: ${opts.instrument}
${opts.keySignature ? `Key: ${opts.keySignature}. ` : ''}Time signature: ${opts.timeSig}
Recording covers: ${measureRange}
${opts.tempo > 0 ? `Reference tempo: ${opts.tempo} BPM` : ''}
Score context: ${scoreContext.promptNote}

${instrumentSpecific}
OBJECTIVE EVIDENCE PACKETS:
These were extracted before the AI analysis. Use them to anchor measure mapping, rests, and likely note/onset locations. They are guardrails, not perfect truth.
${scoreFactsText}

${audioFeaturesText}

${timelineText}
${opts.priorTake ? `
PREVIOUS TAKE CONTEXT: This student has recorded this piece before. Use this to make the feedback comparative and progress-aware.
Previous take score: ${opts.priorTake.score ?? 'unknown'}/100
Previous take issues flagged:
${opts.priorTake.flags.slice(0, 5).map((f: any) => `- ${f.type ?? 'issue'} (m.${f.measure ?? '?'}): ${f.title ?? ''}`).join('\n') || '- No specific flags recorded'}

Instructions for comparison:
- If you hear an issue that was flagged in the previous take, note it as RECURRING: "This was also flagged in your previous take — [what changed or didn't]."
- If a previous issue is no longer present, note it as IMPROVED: "Your [issue] from last time is no longer flagged — good progress."
- Do not invent improvements or regressions. Only compare what you can actually hear.
` : ''}
${opts.userNote ? `
STUDENT'S OWN NOTE ABOUT THIS RECORDING (context only — treat as subjective; always prioritize what you actually see and hear over these claims):
"${opts.userNote}"
Use it to interpret ambiguous moments (e.g. a sight-read, slow practice, a different instrument or tuning, a noisy phone mic), but never invent issues or excuse clearly audible problems because of it.
` : ''}
HIGH-VALUE DETECTION TARGETS:
1. WRONG NOTES: Only flag when the pitch is clearly wrong against the attached/known score. If the exact expected note is unreadable, say the audible problem without pretending to know the score.
2. SQUEAKS / TONE BREAKS: Flag unintended squeaks, cracks, pops, or tone failures when clearly audible.
3. RUSHING / DRAGGING: Flag only when the pulse visibly/audibly shifts over a phrase or repeated figure, not for tiny expressive rubato.
4. INTONATION: Flag sharp/flat tendencies only when they are clearly audible. Avoid fake cent estimates unless the evidence is strong.
5. DYNAMICS / ARTICULATION: Flag when the performance clearly misses a visible/known marking or the articulation damages clarity.
6. TECHNIQUE / TONE: Flag when the sound suggests a concrete technique issue or the video clearly supports it.

WHAT "ISSUE SPANS MULTIPLE MEASURES" MEANS: If the same problem continues across several measures (e.g., rushing from m.5 to m.12, or consistently flat intonation in a phrase), report it as ONE flag with a measure range. Do not repeat the same issue as separate flags.

SCORING (calibrated for serious students):
- 90–100: Near-professional. Genuinely rare. No wrong notes, no squeaks, near-perfect intonation and rhythm.
- 80–89: Strong performance with a few clear, actionable issues.
- 65–79: Useful musical foundation, but several audible/visible issues need focused work.
- 45–64: Major recurring timing, pitch, tone, or technique problems.
- Below 45: Serious accuracy or tone production breakdowns.
The score must be consistent with the number and seriousness of the flags. Do not create filler flags just to justify a score.

Return ONLY valid JSON (no markdown fences, no explanation text):
{
  "score": <integer 0-100>,
  "flags": [
    {
      "measure_start": <integer — ABSOLUTE score measure where the issue BEGINS. Recording starts at measure ${opts.safeStart}${opts.safeEnd ? ` and ends at measure ${opts.safeEnd}` : ''}. Never reset to 1.>,
      "measure_end": <integer | null — ABSOLUTE score measure where the issue ENDS. Use null if the issue is confined to a single measure. Use a number if the issue spans multiple measures (e.g. rushing from m.5 to m.12 → measure_end: 12).>,
      "type": "timing"|"intonation"|"dynamics"|"technique"|"tone"|"error",
      "confidence": <integer 45-95>,
      "title": "<8 words max — be specific: name the note, direction, or technique failure>",
      "detail": "<3-5 sentences: (1) exactly what you heard and when, (2) name the specific note/beat/measure if relevant, (3) why it matters musically, (4) a concrete practice fix>",
      "timestamp_start": <seconds from start of video when this issue first occurs>,
      "timestamp_end": <seconds from start of video when this issue ends>,
      "confidence_reason": "<one short sentence explaining what evidence supports this confidence>"
    }
  ]
}

Use exact pitches, beats, rests, and technique only when the evidence actually supports them. If structured score facts show a rest-heavy measure, do not invent missing played notes there. Never write vague feedback, and never hallucinate rests, notes, or markings that are not visible/audible.`

  // Use confirmed-available models (v1beta only — v1 doesn't have these models)
  const candidates = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite',
  ]
  let genData: any = null

  for (const model of candidates) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { fileData: { mimeType: opts.videoMimeType, fileUri } },
              ...scoreContext.parts,
              { text: prompt },
            ],
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: 2048,
          },
        }),
      }
    )
    if (r.ok) { genData = await r.json(); console.log(`[gemini] success: ${model}`); break }
    const errTxt = await r.text()
    console.warn(`[gemini] ${model} → ${r.status}: ${errTxt.slice(0, 200)}`)
    // Only hard-stop on auth errors — try next model for 400/404/500
    if (r.status === 401 || r.status === 403) throw new Error(`Gemini auth error ${r.status}: ${errTxt.slice(0, 200)}`)
  }

  // Cleanup file (non-fatal)
  if (fileName) fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`, { method: 'DELETE' }).catch(() => {})

  if (!genData) throw new Error('No Gemini model available — check GOOGLE_AI_API_KEY has Gemini API access.')

  // Skip thinking parts (gemini-2.5 series may include thought:true parts)
  const parts: any[] = genData.candidates?.[0]?.content?.parts ?? []
  const textPart = parts.find((p: any) => !p.thought && typeof p.text === 'string' && p.text.trim())
  const rawText = textPart?.text ?? '{}'
  let parsed: any = {}
  try { parsed = JSON.parse(rawText) } catch {
    const m = rawText.match(/\{[\s\S]*\}/)
    if (m) try { parsed = JSON.parse(m[0]) } catch { /* empty */ }
  }

  const rawFlags = Array.isArray(parsed.flags) ? parsed.flags : []
  const flags = finalizeFlags(dedupeFlags(rawFlags
    .map((f: any) => normalizeFlag(f, {
      safeStart: opts.safeStart,
      safeEnd: opts.safeEnd,
      timeSig: opts.timeSig,
      tempo: opts.tempo,
      evidence: 'audio-video',
      defaultType: 'technique',
      defaultTitle: 'Issue detected',
      confidenceCap: 95,
      confidenceDefault: 82,
      timestampWindow: 3,
      measureTimeline: opts.measureTimeline,
      hasStructuredScore: Boolean(opts.scoreFacts),
      hasAudioFeatures: Boolean(opts.audioFeatures),
    }))
    .filter(Boolean) as NormalizedFlag[]), 'audio-video')
  const score = calibrateScore(Number(parsed.score) || 75, flags, 'audio-video')

  // No flags at all means Gemini couldn't find anything actionable — fall back to
  // Claude coaching so the user always gets specific practice priorities.
  if (flags.length === 0) {
    throw new Error(`Gemini returned no flags (score ${score}) — falling back to coaching`)
  }

  return { score, flags, scoreContext: scoreContext.qualityNote }
}

// ── Claude vision analysis (from browser-extracted video frames) ─────────────
async function runClaudeVision(opts: {
  frames:       { base64: string; timestamp: number }[]
  pieceTitle:   string
  composer:     string
  instrument:   string
  timeSig:      string
  keySignature: string
  safeStart:    number
  safeEnd:      number | null
  tempo:        number
  measureTimeline?: MeasureTimelineEntry[]
  userNote?:    string
}): Promise<{ score: number; flags: NormalizedFlag[] }> {
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const anthropic = new Anthropic({ apiKey: anthropicKey })
  const measureRange = opts.safeEnd ? `measures ${opts.safeStart}–${opts.safeEnd}` : `from measure ${opts.safeStart}`
  const keyNote = opts.keySignature ? `Key: ${opts.keySignature}. ` : ''

  const content: Anthropic.MessageParam['content'] = []

  // Add each frame with its timestamp label
  for (const frame of opts.frames) {
    content.push({ type: 'text', text: `Frame at ${frame.timestamp.toFixed(1)}s:` })
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: frame.base64 },
    })
  }

  content.push({
    type: 'text',
    text: `You are a conservatory-level music performance coach analyzing ${opts.frames.length} still frames from a student's recording. These frames are your only evidence. You cannot hear pitch, timing, rhythm, tone color, or dynamics, so do not claim those directly.

Piece: "${opts.pieceTitle}" by ${opts.composer}
Instrument: ${opts.instrument}
${keyNote}Time signature: ${opts.timeSig}
Passage: ${measureRange}
${opts.tempo > 0 ? `Reference tempo: ${opts.tempo} BPM` : ''}
${opts.userNote ? `\nStudent's own note about this recording (subjective context — prioritize what you can actually see over this): "${opts.userNote}"\n` : ''}
For each frame, assess visible technique only:
- Embouchure / bow hold / hand position: visible tension, collapse, or misalignment
- Body posture: hunching, raised shoulders, jaw tension, tilted head
- Instrument angle or hold: deviations from ideal position
- Visible preparation: is the student bracing for difficult passages, or caught off guard?
- Facial expression: only visible tension or bracing, not emotional guesses
- For winds: lip and jaw position at the mouthpiece; for strings: bow angle, contact point, arm weight

Be precise and conservative. It is better to return fewer accurate flags than many generic flags.

Return ONLY valid JSON (no markdown fences):
{
  "score": <integer 0-100 — score the visible technique only, not intonation or rhythm you cannot hear>,
  "flags": [
    {
      "measure_start": <integer — ABSOLUTE score measure where the issue begins. Recording starts at measure ${opts.safeStart}. Never reset to 1.>,
      "measure_end": <integer | null — last measure if the issue spans multiple measures, null if single measure>,
      "type": "technique"|"posture"|"tone"|"error",
      "confidence": <integer 45-88 — how clearly visible is this issue in the frames?>,
      "title": "<8 words max — name the body part and the specific failure>",
      "detail": "<3 sentences: (1) what is visible in which frame, (2) why this causes problems for sound or accuracy, (3) a specific physical exercise to fix it>",
      "timestamp_start": <seconds of the frame where the issue is most clearly visible>,
      "timestamp_end": <timestamp_start + 2.5>,
      "confidence_reason": "<short visible evidence statement>"
    }
  ]
}

Give 2–5 flags. Always cite the frame timestamp and the specific body part or action. Never give advice that could apply to any student — be specific to what you see.`,
  })

  const message = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages:   [{ role: 'user', content }],
  })

  const raw = ((message.content[0] as { type: string; text: string }).text ?? '{}').trim()
  let parsed: any = {}
  try {
    const jsonStr = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    parsed = JSON.parse(jsonStr)
  } catch { /* empty */ }

  const flags = finalizeFlags(dedupeFlags((Array.isArray(parsed.flags) ? parsed.flags : [])
    .map((f: any) => normalizeFlag(f, {
      safeStart: opts.safeStart,
      safeEnd: opts.safeEnd,
      timeSig: opts.timeSig,
      tempo: opts.tempo,
      evidence: 'visual-only',
      defaultType: 'technique',
      defaultTitle: 'Visible technique issue',
      confidenceCap: 88,
      confidenceDefault: 72,
      timestampWindow: 2.5,
      measureTimeline: opts.measureTimeline,
      hasStructuredScore: false,
      hasAudioFeatures: false,
    }))
    .filter(Boolean) as NormalizedFlag[]), 'visual-only')
  const score = calibrateScore(Number(parsed.score) || 72, flags, 'visual-only')

  return { score, flags }
}

// ── Claude coaching fallback (piece-aware, no video scoring) ─────────────────
async function runClaudeCoaching(opts: {
  scoreUrl:      string | null
  scoreMimeType: string | null
  pieceTitle:    string
  composer:      string
  instrument:    string
  timeSig:       string
  keySignature:  string
  safeStart:     number
  safeEnd:       number | null
  difficulty:    string
  priorTake:     { score: number | null; flags: any[] } | null
  scoreFacts?:    unknown
  measureTimeline?: MeasureTimelineEntry[]
  userNote?:     string
}): Promise<{ flags: NormalizedFlag[] }> {
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const anthropic = new Anthropic({ apiKey: anthropicKey })
  const measureRange = opts.safeEnd ? `measures ${opts.safeStart}–${opts.safeEnd}` : `from measure ${opts.safeStart}`
  const keyNote = opts.keySignature ? `Key: ${opts.keySignature}. ` : ''

  const userContent: Anthropic.MessageParam['content'] = []

  // Include score image if we have one. Keep this bounded so fallback coaching
  // cannot fail from an oversized phone photo.
  if (opts.scoreUrl && /image\/(jpeg|jpg|png|webp)/i.test(opts.scoreMimeType ?? '')) {
    try {
      const r = await fetch(opts.scoreUrl)
      if (r.ok) {
        const length = Number(r.headers.get('content-length') || 0)
        if (length <= 8 * 1024 * 1024) {
          const b64 = arrayBufferToBase64(await r.arrayBuffer())
          userContent.push({
            type: 'image',
            source: { type: 'base64', media_type: opts.scoreMimeType as 'image/jpeg' | 'image/png' | 'image/webp', data: b64 },
          })
        }
      }
    } catch { /* skip */ }
  }

  const hasImage = userContent.length > 0

  const coachingTone = {
    Beginner: `Write everything in simple, encouraging language. Avoid musical jargon. Instead of "intonation", say "playing in tune". Instead of "articulation", say "how you start each note". Keep practice tips short and concrete — one thing to try at a time.`,
    Intermediate: `Use standard musical terminology. The student knows terms like dynamics, intonation, and rhythm. Give clear, specific tips that connect what to fix with how to fix it.`,
    Advanced: `Use precise conservatory language. Name specific notes, intervals, fingerings, and technique demands. Assume the student can act on detailed technical guidance without simplified explanation.`,
  }[opts.difficulty] ?? ''
  const scoreFactsText = compactScoreFacts(opts.scoreFacts)

  userContent.push({
    type: 'text',
    text: `You are a music teacher preparing practice priorities from the score. You do not have reliable audio/video evidence here, so these are NOT performance errors. They are likely risk areas to check in practice.
${coachingTone ? `\n${coachingTone}\n` : ''}
Piece: "${opts.pieceTitle}" by ${opts.composer}
Instrument: ${opts.instrument}
${keyNote}Time signature: ${opts.timeSig}
Passage: ${measureRange}
${opts.userNote ? `\nStudent's own note about this recording (subjective context): "${opts.userNote}"\n` : ''}
${hasImage ? '\nThe sheet music is shown above — study it carefully.' : ''}
STRUCTURED SCORE FACTS:
${scoreFactsText}

${opts.priorTake ? `
PREVIOUS TAKE: The student has practiced this piece before (score: ${opts.priorTake.score ?? 'unknown'}/100). Known risk areas from that session:
${opts.priorTake.flags.slice(0, 5).map((f: any) => `- ${f.type ?? 'issue'} (m.${f.measure ?? '?'}): ${f.title ?? ''}`).join('\n') || '- No specific flags'}
Prioritise these recurring areas in your practice tips. Mark them as areas to keep watching.
` : ''}
Based on this specific passage and instrument, identify 3–5 likely practice risks. Ground them in visible notation, instrument tendencies, and common pedagogy. Do not write as if the student definitely made the mistake.

Cover ALL of these dimensions — do not skip any:
- INTONATION: which specific intervals or notes are hardest to play in tune on this instrument in this key? Name the note and the tendency (sharp or flat).
- TIMING: where are the rhythmic traps? Dotted figures, syncopations, ornaments that students rush or mangle?
- DYNAMICS: which dynamic markings are hardest to execute? Where do students over-play or under-play?
- TECHNIQUE: what are the physical demands? Shifts, string crossings, valve combinations, register breaks, awkward fingerings?
- WRONG NOTES / ERRORS: are there passages where students commonly play the wrong pitch due to difficult fingering patterns or accidentals?
- If the passage has a consistent challenge spanning multiple measures (e.g. sustained pp intonation over mm.8–15), report it as a range.

Return ONLY valid JSON (no markdown):
{
  "flags": [
    {
      "measure_start": <integer — ABSOLUTE score measure where the issue begins, between ${opts.safeStart} and ${opts.safeEnd ?? opts.safeStart + 50}>,
      "measure_end": <integer | null — last measure of the issue if it spans multiple measures, null if single measure>,
      "type": "timing"|"intonation"|"dynamics"|"technique"|"tone"|"error",
      "confidence": <integer 45-68>,
      "title": "<8 words max — name the exact pitch, rhythm, or technique failure>",
      "detail": "<4 sentences: (1) the specific technical demand in this measure, (2) why students often struggle with it on ${opts.instrument}, (3) what to listen/check for, (4) a precise practice fix>",
      "timestamp_start": 0,
      "timestamp_end": 0,
      "confidence_reason": "Score-only practice risk; not verified against this recording."
    }
  ]
}`,
  })

  const message = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1200,
    messages:   [{ role: 'user', content: userContent }],
  })

  const raw = ((message.content[0] as { type: string; text: string }).text ?? '{}').trim()
  let parsed: any = {}
  try {
    const jsonStr = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    parsed = JSON.parse(jsonStr)
  } catch { /* empty */ }

  const flags = finalizeFlags(dedupeFlags((Array.isArray(parsed.flags) ? parsed.flags : [])
    .map((f: any) => normalizeFlag(f, {
      safeStart: opts.safeStart,
      safeEnd: opts.safeEnd,
      timeSig: opts.timeSig,
      tempo: 0,
      evidence: 'score-only',
      defaultType: 'technique',
      defaultTitle: 'Practice risk',
      confidenceCap: 68,
      confidenceDefault: 58,
      timestampWindow: 0,
      measureTimeline: opts.measureTimeline,
      hasStructuredScore: Boolean(opts.scoreFacts),
      hasAudioFeatures: false,
    }))
    .filter(Boolean) as NormalizedFlag[]), 'score-only')

  return { flags }
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  // Hoisted so the outer catch can mark the take as failed if we crash mid-flight.
  let admin: ReturnType<typeof createClient> | undefined
  let takeId: string | undefined

  try {
    const authHeader = req.headers.get('Authorization')!
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    // ── Admin client (used for gate check + take insert + signed URLs) ────────
    admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // ── Free tier gate: disabled during testing — re-enable before launch ────
    // const { data: sub } = await supabase
    //   .from('subscriptions').select('status, plan').eq('user_id', user.id).maybeSingle()
    // const isPro = sub?.status === 'active' && sub?.plan !== 'free'
    // if (!isPro) {
    //   const { count } = await admin.from('takes').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
    //   if ((count ?? 0) >= 1) {
    //     return new Response(
    //       JSON.stringify({ error: 'Free accounts include one analysis. Upgrade to Pro for unlimited analyses.' }),
    //       { status: 429, headers: { 'Content-Type': 'application/json', ...CORS } },
    //     )
    //   }
    // }

    const body = await req.json()
    const {
      videoPath, videoMimeType,
      scorePath, scoreMimeType,
      pieceTitle, composer,
      timeSig, instrument, part, keySignature,
      startMeasure, endMeasure,
      videoFrames,
      tempo,
      songId,
      difficulty,
      scoreFacts,
      audioFeatures,
      notes,
    } = body

    // Optional student-supplied context for this recording. Sanitize: strip
    // control chars, trim, and cap length to bound tokens and reduce the chance
    // of prompt-injection. Treated as untrusted, lower-priority context downstream.
    const cleanNote = (typeof notes === 'string' ? notes : '')
      .split('').filter((ch) => ch >= ' ').join('')
      .replace(/ {2,}/g, ' ').trim().slice(0, 800)

    if (!videoPath || !videoMimeType) {
      return new Response(JSON.stringify({ error: 'videoPath and videoMimeType are required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    // ── Ownership guard (IDOR protection) ─────────────────────────────────────
    // Uploaded storage objects always live under `${user.id}/…` (see Record.jsx),
    // and we mint signed URLs below with the SERVICE ROLE, which bypasses storage
    // RLS. So we must confirm the caller owns every path / id they pass — otherwise
    // a user who learns another user's storage path could have us read that private
    // recording or sheet music into their own analysis.
    const ownsPath = (p: unknown): boolean =>
      typeof p === 'string' && p.startsWith(`${user.id}/`)

    if (!ownsPath(videoPath)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }
    if (scorePath && !ownsPath(scorePath)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }
    // songId drives a reference-MIDI lookup (also signed with the service role);
    // only allow songs the caller owns so it can't pull another user's reference.
    if (songId) {
      const { data: ownSong } = await admin
        .from('songs').select('id').eq('id', songId).eq('user_id', user.id).maybeSingle()
      if (!ownSong) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403, headers: { 'Content-Type': 'application/json', ...CORS },
        })
      }
    }

    const safeStart = Math.max(1, parseInt(String(startMeasure ?? 1), 10) || 1)
    const safeEnd: number | null = endMeasure
      ? Math.max(safeStart, parseInt(String(endMeasure), 10))
      : null
    const safeScoreFacts = selectScoreFactsForPart(
      scoreFacts && typeof scoreFacts === 'object' ? scoreFacts : null,
      instrument ?? '',
      part ?? '',
    )
    const safeAudioFeatures = audioFeatures && typeof audioFeatures === 'object' ? audioFeatures : null
    const safeTempo = Math.max(0, parseInt(String(tempo ?? 0), 10) || 0)
    const measureTimeline = buildMeasureTimeline({
      scoreFacts: safeScoreFacts,
      audioFeatures: safeAudioFeatures,
      safeStart,
      safeEnd,
      timeSig: timeSig ?? '4/4',
      tempo: safeTempo,
    })

    // Insert take row in processing state
    const { data: take, error: insertError } = await admin
      .from('takes')
      .insert({
        user_id:         user.id,
        piece_title:     pieceTitle  ?? 'Untitled',
        piece_composer:  composer    ?? 'Unknown',
        instrument:      instrument  ?? null,
        video_path:      videoPath,
        video_mime_type: videoMimeType,
        score_path:      scorePath   ?? null,
        note:            cleanNote,
        score:           null,
        flags:           [],
        job_status:      'processing',
        job_started_at:  new Date().toISOString(),
        ...(songId ? { song_id: songId } : {}),
      })
      .select('id')
      .single()

    if (insertError || !take) throw new Error(`DB insert failed: ${insertError?.message}`)
    takeId = take.id

    // Signed URLs
    const { data: vSigned } = await admin.storage.from('recordings').createSignedUrl(videoPath, 7200)
    const videoSignedUrl = vSigned?.signedUrl ?? null

    let scoreSignedUrl: string | null = null
    if (scorePath) {
      const { data: sSigned } = await admin.storage.from('sheet-music').createSignedUrl(scorePath, 7200)
      scoreSignedUrl = sSigned?.signedUrl ?? null
    }

    // ── Score cache lookup (avoid re-parsing the same PDF with Claude) ────────
    let cachedScoreNotes: unknown = null
    if (scorePath && scoreMimeType && /pdf|image/i.test(scoreMimeType)) {
      const { data: cacheRow } = await admin
        .from('score_cache')
        .select('parsed_notes')
        .eq('score_path', scorePath)
        .maybeSingle()
      if (cacheRow?.parsed_notes) {
        cachedScoreNotes = cacheRow.parsed_notes
        console.log('[analyze-performance] score cache hit for', scorePath)
      }
    }

    // ── Look up reference MIDI for this song (if any) ─────────────
    let referenceMidiUrl: string | null = null
    if (songId) {
      const { data: refRow } = await admin
        .from('reference_performances')
        .select('file_path, file_type')
        .eq('song_id', songId)
        .eq('file_type', 'midi')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (refRow?.file_path) {
        const { data: refSigned } = await admin.storage
          .from('reference-midi')
          .createSignedUrl(refRow.file_path, 7200)
        referenceMidiUrl = refSigned?.signedUrl ?? null
        console.log('[analyze-performance] reference MIDI found:', refRow.file_path)
      }
    }

    // ── 1. Try Modal (full async video analysis) ──────────────────
    const modalUrl = Deno.env.get('MODAL_WORKER_URL')
    if (modalUrl) {
      const dispatchRes = await fetch(`${modalUrl}/analyze_async`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          take_id:              takeId,
          webhook_url:          `${Deno.env.get('SUPABASE_URL')}/functions/v1/analysis-webhook`,
          webhook_secret:       Deno.env.get('MODAL_WEBHOOK_SECRET'),
          video_url:            videoSignedUrl,
          video_mime_type:      videoMimeType,
          score_url:            scoreSignedUrl,
          score_mime_type:      scoreMimeType      ?? null,
          reference_midi_url:   referenceMidiUrl   ?? null,
          user_note:            cleanNote,
          instrument:           instrument         ?? 'instrument',
          part:                 part               ?? '',
          piece_title:          pieceTitle         ?? 'this piece',
          composer:             composer           ?? 'the composer',
          time_sig:             timeSig            ?? '4/4',
          key_signature:        keySignature       ?? '',
          start_measure:        safeStart,
          end_measure:          safeEnd,
          score_facts:          safeScoreFacts,
          audio_features:       safeAudioFeatures,
          measure_timeline:     measureTimeline,
          score_path:           scorePath           ?? null,
          cached_score_notes:   cachedScoreNotes    ?? null,
          gemini_api_key:       Deno.env.get('GOOGLE_AI_API_KEY'),
          anthropic_api_key:    Deno.env.get('ANTHROPIC_API_KEY'),
        }),
        signal: AbortSignal.timeout(25000),
      }).catch((e) => { console.warn('[analyze-performance] Modal dispatch error:', e?.message); return null })

      if (dispatchRes?.ok) {
        console.log('[analyze-performance] dispatched to Modal:', takeId)
        return new Response(JSON.stringify({ jobId: takeId, status: 'processing' }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        })
      }
      const modalErr = dispatchRes ? await dispatchRes.text().catch(() => '') : 'timeout/network'
      console.warn(`[analyze-performance] Modal unavailable (${dispatchRes?.status ?? 'timeout'}): ${modalErr.slice(0, 200)}`)

      // Record why Modal failed so the take's debug field shows it
      await admin.from('takes').update({
        pipeline_debug: { modal_dispatch_failed: dispatchRes?.status ?? 'timeout', error: modalErr.slice(0, 500) },
      }).eq('id', takeId).catch(() => {})
    }

    // ── 2. Look up most recent prior completed take for this piece ──
    type PriorTake = { score: number | null; flags: any[] } | null
    let priorTake: PriorTake = null
    if (pieceTitle) {
      const { data: prior } = await admin
        .from('takes')
        .select('score, flags')
        .eq('user_id', user.id)
        .ilike('piece_title', pieceTitle.trim())
        .eq('job_status', 'done')
        .neq('id', takeId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (prior && (prior.score !== null || (Array.isArray(prior.flags) && prior.flags.length > 0))) {
        priorTake = { score: prior.score, flags: Array.isArray(prior.flags) ? prior.flags : [] }
        console.log('[analyze-performance] prior take found, score:', prior.score, 'flags:', priorTake.flags.length)
      }
    }

    // ── 3. Inline analysis: vision → Gemini → coaching ───────────
    const safeLevel = ['Beginner', 'Intermediate', 'Advanced'].includes(difficulty) ? difficulty : 'Intermediate'
    const sharedOpts = {
      pieceTitle:   pieceTitle   ?? 'Unknown Piece',
      composer:     composer     ?? 'Unknown',
      instrument:   instrument   ?? 'instrument',
      timeSig:      timeSig      ?? '4/4',
      keySignature: keySignature ?? '',
      safeStart,
      safeEnd,
      tempo:        safeTempo,
      difficulty:   safeLevel,
      priorTake,
      scoreFacts:    safeScoreFacts,
      audioFeatures: safeAudioFeatures,
      measureTimeline,
      userNote:      cleanNote,
    }

    let score: number | null = null
    let flags: unknown[]     = []
    let backend              = 'claude-coaching'
    let backendError: string | null = null
    let quality: unknown     = buildQuality({
      trust: 'low',
      backend,
      evidence: 'score-only',
      flags: [],
      reasons: ['Sheet music analysis only — no video score or timestamps available.'],
    })

    function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
        ),
      ])
    }

    // Path A: Gemini full-video analysis (60s max — upload + ACTIVE wait + generation)
    if (videoSignedUrl) {
      try {
        const geminiResult = await withTimeout(
          runGeminiVideo({
            takeId,
            videoUrl: videoSignedUrl,
            videoMimeType,
            scoreUrl: scoreSignedUrl,
            scoreMimeType: scoreMimeType ?? null,
            ...sharedOpts,
          }),
          75_000, 'Gemini'
        )
        score   = geminiResult.score
        flags   = geminiResult.flags
        backend = 'gemini-inline'
        quality = buildQuality({
          trust: 'high',
          backend,
          evidence: 'audio-video',
          flags: geminiResult.flags,
          reasons: evidenceReasons(safeScoreFacts, safeAudioFeatures, measureTimeline),
          scoreContext: [
            geminiResult.scoreContext,
            safeScoreFacts ? 'structured-score-facts' : null,
            safeAudioFeatures ? 'objective-audio-features' : null,
            measureTimeline.length ? 'estimated-measure-timeline' : null,
          ].filter(Boolean).join(' + '),
        })
        console.log('[analyze-performance] Gemini inline done:', takeId, 'score:', score)
      } catch (geminiErr) {
        backendError = (geminiErr as Error).message
        console.warn('[analyze-performance] Gemini failed:', backendError)
      }
    }

    // Path B: browser-extracted video frames → Claude vision (45s max)
    const frames = Array.isArray(videoFrames) && videoFrames.length > 0 ? videoFrames : null
    if (score === null && frames) {
      try {
        const visionResult = await withTimeout(
          runClaudeVision({ frames, ...sharedOpts }),
          45_000, 'Claude vision'
        )
        score   = visionResult.score
        flags   = visionResult.flags
        backend = 'claude-vision'
        quality = buildQuality({
          trust: 'medium',
          backend,
          evidence: 'visual-only',
          flags: visionResult.flags,
          reasons: [
            'Analyzed from sampled video frames — visual technique scored; intonation and precise timing are limited.',
            ...evidenceReasons(safeScoreFacts, safeAudioFeatures, measureTimeline),
          ],
          backendError,
        })
        console.log('[analyze-performance] Claude vision done:', takeId, 'score:', score, 'flags:', flags.length)
      } catch (visionErr) {
        console.warn('[analyze-performance] Claude vision failed:', (visionErr as Error).message)
      }
    }

    // Path C: Claude coaching fallback (20s max)
    if (score === null) {
      try {
        const claudeResult = await withTimeout(
          runClaudeCoaching({ scoreUrl: scoreSignedUrl, scoreMimeType: scoreMimeType ?? null, ...sharedOpts }),
          20_000, 'Claude coaching'
        )
        flags = claudeResult.flags
        backend = 'claude-coaching'
        quality = buildQuality({
          trust: 'low',
          backend,
          evidence: 'score-only',
          flags: claudeResult.flags,
          reasons: [
            'Generated practice priorities from score/context because full recording analysis was unavailable.',
            ...evidenceReasons(safeScoreFacts, safeAudioFeatures, measureTimeline),
          ],
          backendError,
        })
      } catch (err) {
        console.error('[analyze-performance] Claude coaching failed:', (err as Error).message)
      }
    }

    await admin.from('takes').update({
      job_status:       'done',
      score,
      flags,
      analysis_quality: quality,
      analysis_backend: backend,
      job_error:        null,
    }).eq('id', takeId)

    // Generate practice plan with Haiku (non-blocking)
    const anthropicKeyForPlan = Deno.env.get('ANTHROPIC_API_KEY')
    if (anthropicKeyForPlan && Array.isArray(flags) && flags.length > 0) {
      ;(async () => {
        try {
          const client = new Anthropic({ apiKey: anthropicKeyForPlan })
          const flagSummary = (flags as any[]).slice(0, 8).map((f: any) =>
            `- ${f.type ?? 'issue'} in m.${f.measure ?? '?'}: ${f.title ?? ''} — ${(f.detail ?? '').slice(0, 120)}`
          ).join('\n')
          const msg = await client.messages.create({
            model:    'claude-haiku-4-5-20251001',
            max_tokens: 1200,
            messages: [{ role: 'user', content: `You are a music practice coach. A student just completed an AI analysis of "${pieceTitle ?? 'this piece'}" on ${instrument ?? 'their instrument'}. Issues found:\n\n${flagSummary}\n\nGenerate a focused 5-day practice plan. Return ONLY valid JSON (no markdown):\n{"summary":"<one sentence>","days":[{"day":1,"label":"<short label>","tasks":[{"title":"<8 words max>","description":"<2 sentences>","minutes":15,"measure":null}],"total_minutes":30}]}` }],
          })
          const raw = (msg.content[0] as { type: string; text: string }).text ?? '{}'
          const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
          if (start !== -1 && end !== -1) {
            const plan = JSON.parse(raw.slice(start, end + 1))
            await admin.from('takes').update({ practice_plan: plan }).eq('id', takeId)
          }
        } catch { /* non-fatal */ }
      })()
    }

    // Fire-and-forget: notify user by email
    if (user.email) {
      // Escape user-controlled text before interpolating into email HTML.
      const escapeHtml = (s: unknown) =>
        String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
      const firstName = escapeHtml((user.user_metadata?.name ?? '').split(' ')[0]) || 'there'
      const safeTitle = escapeHtml(pieceTitle ?? 'your piece')
      const analysisUrl = `https://www.mediant-music.com/#/analysis?takeId=${takeId}`
      const scoreLabel = score != null ? `Your score: ${score}/100.` : ''
      const html = emailWrapper(`
        <h1 style="font-size:1.3rem;font-weight:700;color:#1a1710;margin:0 0 8px;">Your analysis is ready, ${firstName}.</h1>
        <p style="color:#5a5040;font-size:0.95rem;line-height:1.7;margin:0 0 6px;">
          <strong style="color:#1a1710;">${safeTitle}</strong>
        </p>
        <p style="color:#5a5040;font-size:0.95rem;line-height:1.7;margin:0 0 20px;">
          ${scoreLabel} Mediant found ${flags.length} area${flags.length === 1 ? '' : 's'} to work on.
          Open your session to see the full measure-level breakdown and loop through specific moments.
        </p>
        ${ctaButton(analysisUrl, 'View your analysis →')}
        <hr style="border:none;border-top:1px solid #e8e4dc;margin:28px 0 20px;" />
        <p style="color:#8a8070;font-size:0.82rem;line-height:1.6;margin:0;">
          Questions? Reply to this email or reach us at
          <a href="mailto:mediantteam@gmail.com" style="color:#587965;">mediantteam@gmail.com</a>.
        </p>
      `)
      sendEmail({ to: user.email, subject: `Analysis ready: ${pieceTitle}`, html }).catch(() => {})
    }

    // Return jobId — polling loop will see status=done on first check
    return new Response(JSON.stringify({ jobId: takeId, status: 'done' }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })

  } catch (err) {
    const msg = (err as Error).message ?? 'Unknown error'
    console.error('[analyze-performance] unhandled error:', msg)
    // If a take row was already created, mark it failed so it doesn't stay stuck in 'processing'.
    if (takeId && admin) {
      await admin.from('takes').update({
        job_status: 'failed',
        job_error:  msg,
      }).eq('id', takeId).catch((e: Error) => console.error('[analyze-performance] failed to mark take as failed:', e.message))
    }
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
