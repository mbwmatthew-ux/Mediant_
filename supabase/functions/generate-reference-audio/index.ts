import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, requireAuth } from '../_shared/cors.ts'

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
      .select('id, score_path, instrument, declared_bpm, reference_audio_path, reference_audio_bpm, reference_audio_timeline')
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
      if (signErr || !signed?.signedUrl) {
        return new Response(JSON.stringify({ error: 'Could not sign cached reference audio' }), {
          status: 500, headers: jsonHeaders,
        })
      }
      return new Response(JSON.stringify({
        audioUrl: signed.signedUrl,
        timeline: take.reference_audio_timeline ?? [],
        bpm: take.reference_audio_bpm,
      }), { headers: jsonHeaders })
    }

    if (!take.score_path) {
      return new Response(JSON.stringify({ error: 'This take has no sheet music to generate reference audio from' }), {
        status: 400, headers: jsonHeaders,
      })
    }

    // Cache miss: read the already-parsed score (same cache analyze-performance
    // reads — no fresh vision read here, see this task's edge-case note).
    const { data: cacheRow } = await admin
      .from('score_cache')
      .select('parsed_notes')
      .eq('score_path', take.score_path)
      .maybeSingle()

    if (!cacheRow?.parsed_notes?.measures?.length) {
      return new Response(JSON.stringify({
        error: "Sheet music hasn't been analyzed yet — try again after the next analysis run",
      }), { status: 400, headers: jsonHeaders })
    }

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

    const modalRes = await fetch(modalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        score: cacheRow.parsed_notes,
        instrument: take.instrument ?? '',
        bpm,
      }),
      signal: AbortSignal.timeout(45000),
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
    }), { headers: jsonHeaders })

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
