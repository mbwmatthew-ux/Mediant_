import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'
import { corsHeaders } from '../_shared/cors.ts'

const FREE_DAILY_LIMIT = 20

const STYLE_INSTRUCTIONS: Record<string, string> = {
  Encouraging: 'Be warm, positive, and motivating. Celebrate progress and frame corrections gently.',
  Technical:   'Be detailed and analytical. Focus on mechanics, muscle memory, and specific technique. Use musical terminology freely.',
  Direct:      'Be concise and to the point. Skip pleasantries. Give the fix, nothing more.',
  Balanced:    'Mix encouragement with honest critique. Be warm but specific.',
}

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const anthropicKey  = Deno.env.get('ANTHROPIC_API_KEY')
    const supabaseUrl   = Deno.env.get('SUPABASE_URL')
    const serviceKey    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not set')

    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? ''
    const jwt = authHeader.replace('Bearer ', '')

    let userId: string | null = null
    let isPro = false
    let supabase: ReturnType<typeof createClient> | null = null

    if (jwt && supabaseUrl && serviceKey) {
      supabase = createClient(supabaseUrl, serviceKey)
      const { data: { user } } = await supabase.auth.getUser(jwt)
      userId = user?.id ?? null

      if (userId) {
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('status, plan')
          .eq('user_id', userId)
          .maybeSingle()
        isPro = sub?.status === 'active' && sub?.plan !== 'free'
      }
    }

    // ── Rate limiting (free users only, best-effort via KV) ───────────────────
    if (userId && !isPro) {
      try {
        const kv  = await Deno.openKv()
        const day = new Date().toISOString().slice(0, 10)
        const key = ['coach_rate', userId, day]
        const current = await kv.get<number>(key)
        const count = current.value ?? 0

        if (count >= FREE_DAILY_LIMIT) {
          return new Response(
            JSON.stringify({ error: 'Daily coaching limit reached. Upgrade to Pro for unlimited conversations.' }),
            { status: 429, headers: { 'Content-Type': 'application/json', ...CORS } },
          )
        }

        await kv.set(key, count + 1, { expireIn: 86_400_000 })
      } catch (kvErr) {
        // KV unavailable — skip rate limiting rather than failing the request
        console.warn('[coach-chat] KV rate limiting skipped:', (kvErr as Error).message)
      }
    }

    // ── Request body ──────────────────────────────────────────────────────────
    const { message, context, history, songId } = await req.json()
    if (!message) throw new Error('message is required')

    const { pieceTitle, pieceComposer, instrument, flags, activeFlag, coachingStyle, mode } = context ?? {}

    const flagsSummary = Array.isArray(flags) && flags.length > 0
      ? flags.map((f: Record<string, unknown>) =>
          `- m.${f.measure} (${f.type}): ${f.title ?? ''} — ${f.detail ?? f.body ?? ''}`
        ).join('\n')
      : 'No issues flagged.'

    const activeFlagLine = activeFlag
      ? `\nThe student is currently asking about: measure ${activeFlag.measure}${activeFlag.measure_end ? `-${activeFlag.measure_end}` : ''}, `
        + `issue type "${activeFlag.type}" — "${activeFlag.title}".`
        + (activeFlag.detail ? `\nThe analysis said: "${activeFlag.detail}"` : '')
        + `\nThis was measured from their actual recording, so treat it as established fact. `
        + `Never ask what they played, and never ask them to describe the passage — you have the analysis.`
      : ''

    // The "Explain" screen. The student already read the one-line coaching and
    // tapped for more, so repeating it back is worthless — go deeper into cause
    // and remedy. Depth here means specificity, NOT length: a wall of text is
    // the failure mode this button invites, so the budget is stated up front.
    const explainInstruction = [
      '\nThe student has asked you to EXPLAIN this issue in more depth. Structure your answer as exactly three short labelled parts:',
      '**What happened** — one sentence restating the specific observation in plain language.',
      '**Why it happens** — two sentences on the physical or musical cause on their instrument. This is the part they came for: be concrete about embouchure, air, fingers, bow, hands, or ears as appropriate.',
      '**How to fix it** — two sentences with one specific drill, including a tempo, a rhythm, or a number of repetitions.',
      'Hard limit: 120 words total. Depth means being specific, not being long. No preamble, no summary sentence at the end, no praise.',
    ].join(' ')

    const styleKey = (coachingStyle ?? 'Balanced') as string
    const styleInstruction = STYLE_INSTRUCTIONS[styleKey] ?? STYLE_INSTRUCTIONS.Balanced

    const systemPrompt = [
      `You are an expert ${instrument ?? 'musician'} teacher providing one-on-one coaching.`,
      `The student just performed: "${pieceTitle ?? 'a piece'}"${pieceComposer ? ` by ${pieceComposer}` : ''}.`,
      `\nAnalysis flagged these issues:\n${flagsSummary}`,
      activeFlagLine,
      `\nCoaching style: ${styleInstruction}`,
      mode === 'explain'
        ? explainInstruction
        : 'Keep responses to 2–4 sentences unless a longer explanation is clearly needed.',
      'Focus on technique and musicality, not theory for its own sake.',
      // Follow-ups inside the Explain screen are about one specific flag, so
      // keep them tight too — this screen should never become a wall of text.
      mode === 'explain' ? '' : 'Be specific to this piece and this student.',
    ].filter(Boolean).join(' ')

    // ── Build conversation history for Anthropic ──────────────────────────────
    // Anthropic requires messages to start with 'user' and strictly alternate.
    // The client sends the full chat history including an initial assistant
    // greeting — strip any leading assistant turns before passing to the API.
    const rawHistory: Array<{ role: string; content: string }> = Array.isArray(history) ? history : []

    // Drop leading assistant messages
    const startIdx = rawHistory.findIndex(m => m.role === 'user')
    const validHistory = startIdx >= 0 ? rawHistory.slice(startIdx) : []

    // Build alternating user/assistant pairs, skipping any malformed turns
    const priorMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []
    let expectedRole: 'user' | 'assistant' = 'user'
    for (const m of validHistory) {
      if (!m.content) continue
      if (m.role !== expectedRole) continue
      priorMessages.push({ role: m.role as 'user' | 'assistant', content: m.content })
      expectedRole = expectedRole === 'user' ? 'assistant' : 'user'
    }

    // The final turn must end with 'assistant' so we can append the new 'user' message.
    // If the last prior message is 'user', drop it (the client already sent message separately).
    if (priorMessages.length > 0 && priorMessages[priorMessages.length - 1].role === 'user') {
      priorMessages.pop()
    }

    const anthropic = new Anthropic({ apiKey: anthropicKey })
    const response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system:     systemPrompt,
      messages:   [...priorMessages, { role: 'user', content: message }],
    })

    const reply = (response.content[0] as { type: string; text: string })?.text ?? ''

    // ── Persist chat history to songs table ───────────────────────────────────
    // Only persist if we have a valid song_id and authenticated user.
    if (songId && userId && supabase) {
      try {
        // Build the updated history: prior valid turns + new user message + new assistant reply
        const updatedHistory = [
          ...validHistory,
          { role: 'user', content: message },
          { role: 'assistant', content: reply },
        ]
        // Cap at 100 messages to avoid unbounded growth
        const cappedHistory = updatedHistory.slice(-100)

        await supabase
          .from('songs')
          .update({ chat_history: cappedHistory })
          .eq('id', songId)
          .eq('user_id', userId)
      } catch (persistErr) {
        // Non-fatal — the reply still returns to the client
        console.warn('[coach-chat] Failed to persist chat history:', (persistErr as Error).message)
      }
    }

    return new Response(JSON.stringify({ reply }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    console.error('[coach-chat]', (err as Error).message)
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } },
    )
  }
})
