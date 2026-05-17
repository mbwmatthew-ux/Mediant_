import Anthropic from '@anthropic-ai/sdk'

// Search Mutopia Project for a real MusicXML file
async function fetchFromMutopia(pieceTitle, composer) {
  try {
    const query = `${pieceTitle} ${composer}`.replace(/\s+/g, '+')
    const searchUrl = `https://www.mutopiaproject.org/cgibin/make-table.cgi?searchingfor=${query}&format=XML`

    const html = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    }).then(r => r.text())

    // Extract the first .xml file link from results
    const match = html.match(/href="(\/ftp\/[^"]+\.xml)"/)
    if (!match) return null

    const xmlUrl = `https://www.mutopiaproject.org${match[1]}`
    const xml = await fetch(xmlUrl, { signal: AbortSignal.timeout(8000) }).then(r => r.text())

    return xml.trim().startsWith('<?xml') ? xml : null
  } catch {
    return null
  }
}

// Fall back to Claude generating MusicXML
async function generateWithClaude(pieceTitle, composer) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: `Generate valid MusicXML 3.1 for the opening 8 measures of "${pieceTitle}" by ${composer ?? 'the composer'}.

You MUST follow this exact structure. Return ONLY the XML, no other text:

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1">
      <part-name>Piano</part-name>
    </score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>INSERT_CORRECT_FIFTHS</fifths><mode>INSERT_MODE</mode></key>
        <time><beats>INSERT_BEATS</beats><beat-type>INSERT_BEAT_TYPE</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <!-- Insert correct notes for measure 1 -->
    </measure>
    <!-- Continue for measures 2-8 -->
  </part>
</score-partwise>

Use the correct key signature, time signature, and actual melody notes from the real piece. Each note needs <pitch>, <duration>, and <type> elements.`,
    }],
  })

  const xml = message.content[0].text.trim()
    .replace(/^```xml\n?|^```\n?|\n?```$/g, '')
    .trim()

  return xml.startsWith('<?xml') ? xml : null
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { pieceTitle, composer } = req.body ?? {}
  if (!pieceTitle) return res.status(400).json({ error: 'Missing pieceTitle' })

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  }

  // 1. Try real sheet music from Mutopia Project first
  const mutopiaXml = await fetchFromMutopia(pieceTitle, composer)
  if (mutopiaXml) {
    return res.status(200).json({ xml: mutopiaXml, source: 'mutopia' })
  }

  // 2. Fall back to Claude-generated MusicXML
  try {
    const claudeXml = await generateWithClaude(pieceTitle, composer)
    if (claudeXml) {
      return res.status(200).json({ xml: claudeXml, source: 'ai' })
    }
  } catch {
    // fall through
  }

  return res.status(200).json({ xml: null })
}
