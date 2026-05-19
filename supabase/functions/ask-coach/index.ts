import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'

const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const authHeader = req.headers.get('Authorization')!
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) throw new Error('Unauthorized')

    const { message, context, history } = await req.json()
    if (!message) throw new Error('message is required')

    const flags = (context.flags ?? []) as Array<{
      measure: number; type: string; title: string;
      body?: string; raw_detail?: string;
      timestamp_start?: number | null; timestamp_end?: number | null;
    }>

    const layout = context.measureLayout as {
      staff_angle?: number;
      measures?: Array<{ number: number; content: string }>
    } | null

    const alignment = (context.audioAlignment as Array<{ measure: number; start: number; end: number }> | null) ?? []
    const alignmentMap = new Map<number, { start: number; end: number }>()
    for (const a of alignment) alignmentMap.set(a.measure, { start: a.start, end: a.end })

    const layoutMeasures = layout?.measures ?? []
    // The student actually played the measures present in the alignment.
    // If alignment is missing, fall back to layout's visible range.
    const playedMeasures = alignment.length > 0
      ? alignment.map(a => a.measure).sort((a, b) => a - b)
      : layoutMeasures.map(m => m.number)
    const firstMeasure = playedMeasures[0]
    const lastMeasure  = playedMeasures[playedMeasures.length - 1]

    const totalDuration = alignment.length > 0
      ? Math.max(...alignment.map(a => a.end))
      : null

    // Per-measure index combining notation content with the audio window
    // where it was played, so the coach can answer "what was happening at 0:14?"
    const scoreIndex = layoutMeasures.length > 0
      ? layoutMeasures.map(m => {
          const ts = alignmentMap.get(m.number)
          const tsStr = ts ? ` [played ${ts.start.toFixed(1)}s–${ts.end.toFixed(1)}s]` : ' [not played]'
          return `  ${m.number}${tsStr}: ${m.content}`
        }).join('\n')
      : '(score layout not available for this take)'

    const rangeLine = (firstMeasure != null && lastMeasure != null)
      ? `The student played measures ${firstMeasure}–${lastMeasure}${totalDuration != null ? ` over ${totalDuration.toFixed(1)} seconds of recording` : ''}. That is the exact range — do not claim they played outside it.`
      : 'The exact measure range played is not known.'

    const flagSummary = flags.length === 0
      ? '(no specific issues were flagged in this take — the performance was clean)'
      : flags.map((f, i) => {
          const ts = (f.timestamp_start != null && f.timestamp_end != null)
            ? ` [audio ${f.timestamp_start.toFixed(1)}s–${f.timestamp_end.toFixed(1)}s]`
            : ''
          return `#${i + 1}. Measure ${f.measure} · ${f.type}${ts}
  Title: ${f.title}
  What was heard: ${f.raw_detail ?? '(not recorded)'}
  Coaching given to student: ${f.body ?? '(not recorded)'}`
        }).join('\n\n')

    const system = `You are a warm, expert music coach helping a student improve their performance.

The student just performed "${context.pieceTitle ?? 'a piece'}" by ${context.pieceComposer ?? 'unknown composer'}.
Overall score: ${context.score != null ? `${context.score}/100` : 'not scored'}.

RANGE PLAYED:
${rangeLine}

SCORE CONTENT (the notation that was visible in the score image):
${scoreIndex}

FLAGGED ISSUES (what the AI heard go wrong during this take):
${flagSummary}

GROUNDING RULES — READ CAREFULLY:
- The RANGE PLAYED and FLAGGED ISSUES above are authoritative. The measure numbers in those sections are correct — do not second-guess them.
- When a student asks "are you sure this is measure X?" — confirm it confidently using the flagged issue data. Do NOT say you don't have the score. You have the analysis results above; use them.
- NEVER ask the student what notes they played or what is in their score. You are the coach — give answers, not questions back.
- If score layout is unavailable, still give concrete feedback from FLAGGED ISSUES. "The analysis flagged a rhythm issue in measure 8 — [body from flag]" is a complete answer.
- If the student asks about a measure outside the played range, say so: "you only played measures ${firstMeasure ?? '?'}–${lastMeasure ?? '?'}, so measure X wasn't in this take."
- If asked about something genuinely not in your data (posture, bow arm, etc.), say it wasn't captured this session.
- Be encouraging but direct. Answer in 2–4 sentences. Never deflect with a question when you have data to work with.`

    const messages = [
      ...(history ?? []).map((m: { role: string; content: string }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user' as const, content: message },
    ]

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system,
      messages,
    })

    const reply = (response.content[0] as { type: string; text: string }).text.trim()

    return new Response(JSON.stringify({ reply }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
