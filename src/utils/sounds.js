let _ctx = null

function ac() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)()
  if (_ctx.state === 'suspended') _ctx.resume()
  return _ctx
}

function play(fn) {
  try {
    if (localStorage.getItem('mediant_sound') === 'false') return
    fn(ac())
  } catch {}
}

// ── Click / interaction sounds ────────────────────────────────

// Soft pop — primary button clicks
export function playPop() {
  play(c => {
    const osc  = c.createOscillator()
    const gain = c.createGain()
    osc.connect(gain); gain.connect(c.destination)
    const t = c.currentTime
    osc.type = 'sine'
    osc.frequency.setValueAtTime(500, t)
    osc.frequency.exponentialRampToValueAtTime(220, t + 0.09)
    gain.gain.setValueAtTime(0.12, t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11)
    osc.start(t); osc.stop(t + 0.12)
  })
}

// Light tick — list row taps
export function playTick() {
  play(c => {
    const osc  = c.createOscillator()
    const gain = c.createGain()
    osc.connect(gain); gain.connect(c.destination)
    const t = c.currentTime
    osc.type = 'sine'
    osc.frequency.setValueAtTime(900, t)
    osc.frequency.exponentialRampToValueAtTime(500, t + 0.045)
    gain.gain.setValueAtTime(0.07, t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
    osc.start(t); osc.stop(t + 0.07)
  })
}

// Two-tone swish — sidebar navigation
export function playNav() {
  play(c => {
    [0, 0.055].forEach((delay, i) => {
      const osc  = c.createOscillator()
      const gain = c.createGain()
      osc.connect(gain); gain.connect(c.destination)
      const t = c.currentTime + delay
      osc.type = 'sine'
      osc.frequency.value = i === 0 ? 380 : 520
      gain.gain.setValueAtTime(0.07, t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
      osc.start(t); osc.stop(t + 0.1)
    })
  })
}

// Toggle switch snap — settings toggles
export function playToggle(on = true) {
  play(c => {
    const osc  = c.createOscillator()
    const gain = c.createGain()
    osc.connect(gain); gain.connect(c.destination)
    const t = c.currentTime
    osc.type = 'square'
    // Higher pitch for on, lower for off
    osc.frequency.setValueAtTime(on ? 1200 : 800, t)
    osc.frequency.exponentialRampToValueAtTime(on ? 900 : 500, t + 0.04)
    gain.gain.setValueAtTime(0.04, t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
    osc.start(t); osc.stop(t + 0.06)
  })
}

// Save success — two ascending notes
export function playSave() {
  play(c => {
    [[440, 0], [660, 0.1]].forEach(([freq, delay]) => {
      const osc  = c.createOscillator()
      const gain = c.createGain()
      osc.connect(gain); gain.connect(c.destination)
      const t = c.currentTime + delay
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.09, t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25)
      osc.start(t); osc.stop(t + 0.3)
    })
  })
}

// Soft thud — dismiss / cancel
export function playThud() {
  play(c => {
    const osc  = c.createOscillator()
    const gain = c.createGain()
    osc.connect(gain); gain.connect(c.destination)
    const t = c.currentTime
    osc.type = 'sine'
    osc.frequency.setValueAtTime(180, t)
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.08)
    gain.gain.setValueAtTime(0.1, t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1)
    osc.start(t); osc.stop(t + 0.11)
  })
}

// ── File / upload sounds ──────────────────────────────────────

// File dropped / attached — soft landing thunk
export function playDrop() {
  play(c => {
    const osc    = c.createOscillator()
    const filter = c.createBiquadFilter()
    const gain   = c.createGain()
    osc.connect(filter); filter.connect(gain); gain.connect(c.destination)
    const t = c.currentTime
    filter.type = 'lowpass'
    filter.frequency.value = 600
    osc.type = 'sine'
    osc.frequency.setValueAtTime(300, t)
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.12)
    gain.gain.setValueAtTime(0.15, t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
    osc.start(t); osc.stop(t + 0.18)
  })
}

// ── Analysis sounds ───────────────────────────────────────────

// Analysis started — quick ascending 3-note trill (G A B)
export function playAnalyzeStart() {
  play(c => {
    [392, 440, 494].forEach((freq, i) => {
      const osc  = c.createOscillator()
      const gain = c.createGain()
      osc.connect(gain); gain.connect(c.destination)
      const t = c.currentTime + i * 0.07
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.08, t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
      osc.start(t); osc.stop(t + 0.2)
    })
  })
}

// Analysis complete — warm C major chord resolution (the satisfying one)
export function playAnalyzeComplete() {
  play(c => {
    // C4, E4, G4, C5 — staggered for a "bloom" effect
    [[261, 0], [330, 0.06], [392, 0.12], [523, 0.20]].forEach(([freq, delay]) => {
      const osc  = c.createOscillator()
      const gain = c.createGain()
      osc.connect(gain); gain.connect(c.destination)
      const t = c.currentTime + delay
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.1, t + 0.06)   // soft attack
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.8)
      osc.start(t); osc.stop(t + 0.85)
    })
  })
}

// Musical chime — C-E-G ascending (for generic success)
export function playChime() {
  play(c => {
    [523, 659, 784].forEach((freq, i) => {
      const osc  = c.createOscillator()
      const gain = c.createGain()
      osc.connect(gain); gain.connect(c.destination)
      const t = c.currentTime + i * 0.09
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.09, t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45)
      osc.start(t); osc.stop(t + 0.5)
    })
  })
}
