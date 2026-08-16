/**
 * Two exports, deliberately:
 *
 *   INSTRUMENTS        — the original flat list of names. Four screens (profile
 *                        setup in AppShell, Signup, Settings, Record) render
 *                        these directly as strings. Do NOT change its shape:
 *                        turning it into objects made every one of those screens
 *                        throw React error #31 ("objects are not valid as a
 *                        React child"), because they map it straight into <option>
 *                        and <button> children.
 *
 *   INSTRUMENT_OPTIONS — the detailed list used by the analysis form's
 *                        type-ahead. It carries the transposition each part
 *                        needs, which the flat list cannot express: "Clarinet"
 *                        alone does not say whether it is in B♭, A or E♭, and
 *                        that interval is the difference between a correct
 *                        reading and a page of false wrong-note flags.
 *
 * `transpose` is how far SOUNDING pitch sits from WRITTEN pitch, in semitones.
 * A B♭ clarinet part sounds a major 2nd below what is printed, so -2. Keep the
 * `name` strings in sync with INSTRUMENT_TRANSPOSE in modal_worker/worker.py.
 */

// Coarse preference stored on the user profile. Shape is load-bearing — strings.
export const INSTRUMENTS = [
  'Piano', 'Violin', 'Viola', 'Cello', 'Double Bass',
  'Flute', 'Oboe', 'Clarinet', 'Saxophone', 'Bassoon',
  'French Horn', 'Trumpet', 'Trombone', 'Tuba',
  'Guitar', 'Harp', 'Percussion',
  'Voice (Soprano)', 'Voice (Alto)', 'Voice (Tenor)', 'Voice (Bass)',
  'Other',
]

export const INSTRUMENT_OPTIONS = [
  // Woodwinds
  { name: 'Flute',            family: 'Woodwind', transpose: 0 },
  { name: 'Piccolo',          family: 'Woodwind', transpose: 12 },
  { name: 'Oboe',             family: 'Woodwind', transpose: 0 },
  { name: 'English Horn',     family: 'Woodwind', transpose: -7 },
  { name: 'Bassoon',          family: 'Woodwind', transpose: 0 },
  { name: 'Contrabassoon',    family: 'Woodwind', transpose: -12 },
  { name: 'Clarinet (B♭)',    family: 'Woodwind', transpose: -2 },
  { name: 'Clarinet (A)',     family: 'Woodwind', transpose: -3 },
  { name: 'Clarinet (E♭)',    family: 'Woodwind', transpose: 3 },
  { name: 'Bass Clarinet',    family: 'Woodwind', transpose: -14 },
  { name: 'Soprano Saxophone', family: 'Woodwind', transpose: -2 },
  { name: 'Alto Saxophone',   family: 'Woodwind', transpose: -9 },
  { name: 'Tenor Saxophone',  family: 'Woodwind', transpose: -14 },
  { name: 'Baritone Saxophone', family: 'Woodwind', transpose: -21 },
  { name: 'Recorder',         family: 'Woodwind', transpose: 0 },

  // Brass
  { name: 'Trumpet (B♭)',     family: 'Brass', transpose: -2 },
  { name: 'Trumpet (C)',      family: 'Brass', transpose: 0 },
  { name: 'Cornet (B♭)',      family: 'Brass', transpose: -2 },
  { name: 'Flugelhorn',       family: 'Brass', transpose: -2 },
  { name: 'French Horn (F)',  family: 'Brass', transpose: -7 },
  { name: 'Trombone',         family: 'Brass', transpose: 0 },
  { name: 'Bass Trombone',    family: 'Brass', transpose: 0 },
  { name: 'Euphonium',        family: 'Brass', transpose: 0 },
  { name: 'Tuba',             family: 'Brass', transpose: 0 },

  // Strings
  { name: 'Violin',           family: 'Strings', transpose: 0 },
  { name: 'Viola',            family: 'Strings', transpose: 0 },
  { name: 'Cello',            family: 'Strings', transpose: 0 },
  { name: 'Double Bass',      family: 'Strings', transpose: -12 },
  { name: 'Harp',             family: 'Strings', transpose: 0 },
  { name: 'Classical Guitar', family: 'Strings', transpose: -12 },
  { name: 'Electric Guitar',  family: 'Strings', transpose: -12 },
  { name: 'Bass Guitar',      family: 'Strings', transpose: -12 },
  { name: 'Ukulele',          family: 'Strings', transpose: 0 },
  { name: 'Mandolin',         family: 'Strings', transpose: 0 },
  { name: 'Banjo',            family: 'Strings', transpose: 0 },

  // Keyboard & voice
  { name: 'Piano',            family: 'Keyboard', transpose: 0 },
  { name: 'Organ',            family: 'Keyboard', transpose: 0 },
  { name: 'Harpsichord',      family: 'Keyboard', transpose: 0 },
  { name: 'Voice',            family: 'Voice', transpose: 0 },

  // Percussion
  { name: 'Marimba',          family: 'Percussion', transpose: 0 },
  { name: 'Vibraphone',       family: 'Percussion', transpose: 0 },
  { name: 'Xylophone',        family: 'Percussion', transpose: 12 },
  { name: 'Glockenspiel',     family: 'Percussion', transpose: 24 },
  { name: 'Timpani',          family: 'Percussion', transpose: 0 },
  { name: 'Snare Drum',       family: 'Percussion', transpose: 0 },
  { name: 'Drum Set',         family: 'Percussion', transpose: 0 },
]

/**
 * Rank matches so typing a leading letter behaves the way people expect:
 * "c" lists things that START with c before things that merely contain it, and
 * "clarinet" surfaces every clarinet. Accepts a plain "b" for "♭" so nobody has
 * to hunt for the flat sign.
 */
export function searchInstruments(query, limit = 8) {
  const q = (query || '').trim().toLowerCase().replace(/b\b/g, 'b')
  if (!q) return INSTRUMENT_OPTIONS.slice(0, limit)
  const norm = (s) => s.toLowerCase().replace(/♭/g, 'b').replace(/[()]/g, '')
  const scored = []
  for (const inst of INSTRUMENT_OPTIONS) {
    const n = norm(inst.name)
    // Also match on any word so "sax" finds "Alto Saxophone" and "horn" finds
    // "French Horn" without the user typing the leading word.
    const words = n.split(/\s+/)
    let score = null
    if (n.startsWith(q)) score = 0
    else if (words.some(word => word.startsWith(q))) score = 1
    else if (n.includes(q)) score = 2
    else if (norm(inst.family).startsWith(q)) score = 3
    if (score !== null) scored.push({ inst, score })
  }
  scored.sort((a, b) => a.score - b.score || a.inst.name.localeCompare(b.inst.name))
  return scored.slice(0, limit).map(s => s.inst)
}
