import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(req) })
  }

  const CORS = corsHeaders(req)

  try {
    // Verify the calling user
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } },
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // 1. Fetch every storage object owned by this user so nothing private is
    //    left behind. Recordings + take sheet-music come from `takes`; separately
    //    uploaded pieces live in `user_pieces`, and reference MIDI in
    //    `reference_performances`. (DB rows themselves cascade when the auth user
    //    is deleted, but storage objects do NOT — they must be removed explicitly.)
    const [{ data: takes }, { data: pieces }, { data: refs }] = await Promise.all([
      admin.from('takes').select('video_path, score_path').eq('user_id', user.id),
      admin.from('user_pieces').select('file_path').eq('user_id', user.id),
      admin.from('reference_performances').select('file_path').eq('user_id', user.id),
    ])

    // 2. Delete storage files (best-effort — don't fail the whole request if a file is missing)
    const videoPaths = (takes ?? []).map(t => t.video_path).filter(Boolean)
    // Sheet-music bucket holds both take scores and separately-uploaded pieces.
    const scorePaths = [
      ...(takes ?? []).map(t => t.score_path),
      ...(pieces ?? []).map(p => p.file_path),
    ].filter(Boolean)
    const refPaths = (refs ?? []).map(r => r.file_path).filter(Boolean)

    if (videoPaths.length > 0) {
      await admin.storage.from('recordings').remove(videoPaths).catch(e =>
        console.warn('[delete-account] recording removal partial fail:', e.message)
      )
    }
    if (scorePaths.length > 0) {
      await admin.storage.from('sheet-music').remove(scorePaths).catch(e =>
        console.warn('[delete-account] score removal partial fail:', e.message)
      )
    }
    if (refPaths.length > 0) {
      await admin.storage.from('reference-midi').remove(refPaths).catch(e =>
        console.warn('[delete-account] reference-midi removal partial fail:', e.message)
      )
    }

    // 3. Delete database rows. Most cascade from the auth user, but delete the
    //    ones holding storage references explicitly so nothing is orphaned even
    //    if a cascade FK is ever missing.
    await admin.from('takes').delete().eq('user_id', user.id)
    await admin.from('user_pieces').delete().eq('user_id', user.id).catch(() => {})
    await admin.from('reference_performances').delete().eq('user_id', user.id).catch(() => {})
    await admin.from('songs').delete().eq('user_id', user.id).catch(() => {})
    await admin.from('subscriptions').delete().eq('user_id', user.id).catch(() => {})

    // 4. Delete the auth user — this is the point of no return
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id)
    if (deleteError) {
      console.error('[delete-account] auth.admin.deleteUser failed:', deleteError.message)
      return new Response(JSON.stringify({ error: 'Could not delete account. Please contact mediantteam@gmail.com.' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })

  } catch (err) {
    console.error('[delete-account] unhandled error:', (err as Error).message)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
