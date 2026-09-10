import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, requireAuth } from '../_shared/cors.ts'

// The cached score a take's reference audio is built from is not guaranteed
// to cover the whole piece from measure 1 — score_cache is shared across
// every take that reuses the same photographed page, and can be a partial
// parse left over from whichever take first populated it (the vision read
// can anchor on that take's own played range instead of the full page).
// Silently labelling a partial excerpt "the reference audio" reads as wrong
// content ("this doesn't sound like my piece") rather than what it is: a
// correct but incomplete window. Surface the actual measure range so the
// caller can be honest about it instead of implying full-piece coverage.
function measureRangeFromTimeline(timeline: unknown): { start: number, end: number } | null {
  if (!Array.isArray(timeline) || timeline.length === 0) return null
  const nums = timeline
    .map((t: unknown) => (t && typeof t === 'object' ? (t as { measure?: unknown }).measure : null))
    .filter((n: unknown): n is number => typeof n === 'number')
  if (!nums.length) return null
  return { start: Math.min(...nums), end: Math.max(...nums) }
}

serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const auth = await requireAuth(req)
  if (auth instanceof Response) return auth
  const { user } = auth

  const jsonHeaders = { 'Content-Type': 'application/json', ...CORS }

  try {
    const { takeId } = await req.json()
    if (!takeId || typeof takeId !== 'string') {
      return new Response(JSON.stringify({ error: 'takeId is required' }), {
        status: 400, headers: jsonHeaders,
      })
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Ownership check happens in the same query that fetches the row — a
    // take that exists but belongs to someone else returns no row, exactly
    // like a take that doesn't exist. Same pattern as job-status/index.ts.
    const { data: take, error: takeErr } = await admin
      .from('takes')
      .select('id, score_path, score_paths, instrument, declared_bpm, reference_audio_path, reference_audio_bpm, reference_audio_timeline')
      .eq('id', takeId)
      .eq('user_id', user.id)
      .single()

    if (takeErr || !take) {
      return new Response(JSON.stringify({ error: 'Take not found' }), {
        status: 404, headers: jsonHeaders,
      })
    }

    // Cache hit: already generated, return it without touching Modal.
    if (take.reference_audio_path) {
      const { data: signed, error: signErr } = await admin.storage
        .from('reference-audio')
        .createSignedUrl(take.reference_audio_path, 86400)
      if (!signErr && signed?.signedUrl) {
        return new Response(JSON.stringify({
          audioUrl: signed.signedUrl,
          timeline: take.reference_audio_timeline ?? [],
          bpm: Number(take.reference_audio_bpm),
          measureRange: measureRangeFromTimeline(take.reference_audio_timeline),
        }), { headers: jsonHeaders })
      }
      // Signing failed (e.g. the stored object was deleted out from under a
      // still-cached path) — fall through to regeneration instead of a
      // permanent dead end.
      console.warn('[generate-reference-audio] cached reference audio could not be signed, regenerating:', signErr?.message)
    }

    if (!take.score_path) {
      return new Response(JSON.stringify({ error: 'This take has no sheet music to generate reference audio from' }), {
        status: 400, headers: jsonHeaders,
      })
    }

    // Cache miss: do a FRESH, dedicated vision read of the take's own score
    // page(s) — NOT a reuse of score_cache. score_cache is shared per-image
    // content-hash across every take that reuses that exact photo, and can
    // hold a partial parse left over from whichever take first populated it
    // (confirmed live 2026-09-09: a 58-measure part was cached as just 16
    // measures because an earlier take had only played that range, and the
    // vision read apparently anchored on that take's own start measure
    // despite the reader prompt's explicit rule against exactly that — see
    // Gotchas: "score_cache is shared per-image and can silently hold a
    // PARTIAL parse, not the whole piece"). The worker's fresh-read path
    // always anchors at measure 1, never any take's own start measure.
    //
    // score_cache is still queried, but only as a FALLBACK the worker uses
    // if the fresh read fails (network hiccup, vision call error) — a
    // possibly-partial result beats a hard failure. Not used as the primary
    // source, so its own possible incompleteness no longer matters here.
    const paths = Array.isArray(take.score_paths)
      ? take.score_paths.filter((p: unknown): p is string => typeof p === 'string')
      : (take.score_path ? [take.score_path] : [])

    const signedScorePages = await Promise.all(
      paths.map((p: string) =>
        admin.storage.from('sheet-music').createSignedUrl(p, 7200)
          .then(r => r.data?.signedUrl ?? null)
          .catch(() => null)
      )
    )
    const scoreUrls = signedScorePages.every(Boolean) ? signedScorePages as string[] : []
    if (!scoreUrls.length) {
      return new Response(JSON.stringify({ error: 'Could not access the sheet music for this take' }), {
        status: 500, headers: jsonHeaders,
      })
    }

    const scoreCacheKey = paths.length > 1 ? paths.join('|') : take.score_path
    const { data: cacheRow } = await admin
      .from('score_cache')
      .select('parsed_notes')
      .eq('score_path', scoreCacheKey)
      .maybeSingle()

    const bpm = Number(take.declared_bpm)
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) {
      return new Response(JSON.stringify({ error: 'This take has no valid declared tempo to generate reference audio at' }), {
        status: 400, headers: jsonHeaders,
      })
    }

    const modalUrl = Deno.env.get('MODAL_REFERENCE_AUDIO_URL')
    if (!modalUrl) {
      return new Response(JSON.stringify({ error: 'Reference audio service is not configured' }), {
        status: 500, headers: jsonHeaders,
      })
    }

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')

    const modalRes = await fetch(modalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        score_urls: scoreUrls,
        score: cacheRow?.parsed_notes ?? null,
        instrument: take.instrument ?? '',
        bpm,
        anthropic_api_key: anthropicKey,
      }),
      signal: AbortSignal.timeout(140000),
    }).catch((e) => { console.warn('[generate-reference-audio] Modal call failed:', e?.message); return null })

    if (!modalRes || !modalRes.ok) {
      return new Response(JSON.stringify({ error: 'Reference audio generation failed' }), {
        status: 502, headers: jsonHeaders,
      })
    }

    const modalJson = await modalRes.json()
    if (modalJson.error || !modalJson.audio_base64) {
      return new Response(JSON.stringify({ error: modalJson.error ?? 'Reference audio generation failed' }), {
        status: 502, headers: jsonHeaders,
      })
    }

    const audioBytes = Uint8Array.from(atob(modalJson.audio_base64), (c) => c.charCodeAt(0))
    const storagePath = `${user.id}/${takeId}.wav`

    const { error: uploadErr } = await admin.storage
      .from('reference-audio')
      .upload(storagePath, audioBytes, { contentType: 'audio/wav', upsert: true })
    if (uploadErr) {
      return new Response(JSON.stringify({ error: `Failed to store reference audio: ${uploadErr.message}` }), {
        status: 500, headers: jsonHeaders,
      })
    }

    await admin.from('takes').update({
      reference_audio_path: storagePath,
      reference_audio_bpm: bpm,
      reference_audio_timeline: modalJson.timeline ?? [],
    }).eq('id', takeId)

    const { data: signed, error: signErr } = await admin.storage
      .from('reference-audio')
      .createSignedUrl(storagePath, 86400)
    if (signErr || !signed?.signedUrl) {
      return new Response(JSON.stringify({ error: 'Reference audio generated but could not be signed for playback' }), {
        status: 500, headers: jsonHeaders,
      })
    }

    return new Response(JSON.stringify({
      audioUrl: signed.signedUrl,
      timeline: modalJson.timeline ?? [],
      bpm,
      measureRange: measureRangeFromTimeline(modalJson.timeline),
    }), { headers: jsonHeaders })

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
