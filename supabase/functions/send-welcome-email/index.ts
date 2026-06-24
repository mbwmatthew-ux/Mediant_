import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { sendEmail, emailWrapper, ctaButton } from '../_shared/email.ts'

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(req) })
  }

  const CORS = corsHeaders(req)

  try {
    const { email, name } = await req.json()
    if (!email) {
      return new Response(JSON.stringify({ error: 'email required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    const firstName = (name ?? '').split(' ')[0] || 'there'

    const html = emailWrapper(`
      <h1 style="font-size:1.4rem;font-weight:700;color:#1a1710;margin:0 0 8px;">Welcome to Mediant, ${firstName}.</h1>
      <p style="color:#5a5040;font-size:0.95rem;line-height:1.7;margin:0 0 20px;">
        You now have an AI music performance coach that reviews your playing measure by measure —
        flagging specific moments in pitch, rhythm, technique, and posture, just like working with a professional teacher.
      </p>
      <p style="color:#5a5040;font-size:0.95rem;line-height:1.7;margin:0 0 24px;">
        <strong style="color:#1a1710;">To get started:</strong> upload a short video of yourself playing and attach your sheet music.
        Mediant will read the score, listen to your performance, and give you measure-level feedback within a few minutes.
      </p>
      ${ctaButton('https://www.mediant-music.com/#/record', 'Upload your first recording →')}
      <hr style="border:none;border-top:1px solid #e8e4dc;margin:32px 0 24px;" />
      <p style="color:#8a8070;font-size:0.82rem;line-height:1.6;margin:0;">
        A phone video is all you need — no fancy equipment required.
        If you have any questions, reply to this email or reach us at
        <a href="mailto:mediantteam@gmail.com" style="color:#587965;">mediantteam@gmail.com</a>.
      </p>
    `)

    await sendEmail({
      to: email,
      subject: `Welcome to Mediant, ${firstName}`,
      html,
    })

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    console.error('[send-welcome-email] error:', (err as Error).message)
    return new Response(JSON.stringify({ ok: false }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
