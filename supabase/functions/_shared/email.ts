const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const FROM = 'Mediant <hello@mediant-music.com>'

export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string
  subject: string
  html: string
}): Promise<void> {
  if (!RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set — skipping')
    return
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    })
    if (!res.ok) {
      const body = await res.text()
      console.error('[email] Resend error:', res.status, body)
    }
  } catch (err) {
    console.error('[email] sendEmail threw:', (err as Error).message)
  }
}

// ── Reusable HTML wrapper ────────────────────────────────────────────────────

export function emailWrapper(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Mediant</title>
</head>
<body style="margin:0;padding:0;background:#f5f3ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ee;padding:40px 16px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
      <!-- Logo -->
      <tr><td style="padding-bottom:28px;">
        <span style="font-size:1.15rem;font-weight:700;letter-spacing:-0.01em;color:#1a1710;">♩ Mediant</span>
      </td></tr>
      <!-- Card -->
      <tr><td style="background:#ffffff;border-radius:12px;padding:36px 40px;border:1px solid #e8e4dc;">
        ${content}
      </td></tr>
      <!-- Footer -->
      <tr><td style="padding:24px 0 0;text-align:center;color:#8a8070;font-size:0.78rem;line-height:1.6;">
        Mediant · <a href="https://www.mediant-music.com/privacy" style="color:#587965;text-decoration:none;">Privacy policy</a>
        · <a href="mailto:mediantteam@gmail.com" style="color:#587965;text-decoration:none;">Contact us</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`
}

export function ctaButton(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:#587965;color:#ffffff;text-decoration:none;border-radius:8px;padding:11px 22px;font-size:0.9rem;font-weight:600;margin-top:8px;">${label}</a>`
}
