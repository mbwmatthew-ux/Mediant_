// ─────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for plans & pricing.
// Both the Landing page and the Pricing page read from here.
// ─────────────────────────────────────────────────────────────────────────

export const PLANS = [
  {
    id: 'mediant',
    name: 'Mediant',
    monthlyPrice: '$7',
    yearlyPrice: '$5',
    yearlyTotal: '$60',
    description: 'Unlimited recordings. Full AI coaching. Everything, no caps.',
    cta: 'Start free trial',
    ctaVariant: 'gold',
    features: [
      { text: 'Unlimited recording uploads',        included: true },
      { text: 'Measure-by-measure AI feedback',     included: true },
      { text: 'Score alignment (PDF + MusicXML)',   included: true },
      { text: 'AI-generated daily practice plan',   included: true },
      { text: 'Practice calendar',                  included: true },
      { text: 'Mediant coach chat',                 included: true },
      { text: 'Session history & progress tracking',included: true },
      { text: 'Teacher annotations',                included: true },
      { text: 'Early access to new features',       included: true },
    ],
  },
]

// The single plan shown as a teaser on the marketing homepage.
export const HIGHLIGHT_PLAN_ID = 'mediant'
