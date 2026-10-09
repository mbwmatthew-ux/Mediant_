// A single eighth note (teal) with an AI "sparkle" accent (coral) on a
// cream rounded-square badge. Rebuilt from an actual reference PNG the
// user supplied (not a rendered chat image) — colors sampled directly via
// a canvas pixel scan, and the flag's curl traced from the real pixel
// silhouette (a fine color-match grid scan) rather than eyeballed; a first
// pass working only from what was visible in the chat came out visibly
// off. See design workspace's analyze-logo.mjs / trace-logo.mjs /
// measure-logo.mjs / gen-logo3.mjs for the extraction + generator.
//
// viewBox is cropped tight to the badge (325,325)-(929,929) rather than
// the full 1254x1254 source canvas — the source PNG had the badge
// centered in a canvas roughly twice its size, so a viewBox matching the
// full canvas rendered the badge at only ~46% of whatever size was
// requested. That was the actual cause of it reading as "too small," not
// the size prop itself.
export default function LogoMark({ size = 32, rounded = true, style }) {
  const r = rounded ? 110 : 0
  return (
    <svg
      width={size}
      height={size}
      viewBox="325 325 604 604"
      role="img"
      aria-label="Mediant"
      style={{ display: 'block', flexShrink: 0, ...style }}
    >
      <rect x="337" y="337" width="580" height="580" rx={r} fill="#FCF9F2" stroke="#CBB587" strokeWidth="4" />
      <g fill="#1A4B35">
        <ellipse cx="569.5" cy="746.5" rx="73" ry="65" transform="rotate(-20 569.5 746.5)" />
        <path d="M 630 738.5 L 630 428 L 641 428 L 641 738.5 Z" />
        <path d="M 631.0 426.0 C 636.5 432.0, 652.8 451.0, 664.0 462.0 C 675.2 473.0, 687.3 483.5, 698.0 492.0 C 708.7 500.5, 717.5 505.5, 728.0 513.0 C 738.5 520.5, 755.0 528.0, 761.0 537.0 C 767.0 546.0, 763.0 557.0, 764.0 567.0 C 765.0 577.0, 767.0 588.5, 767.0 597.0 C 767.0 605.5, 764.5 614.5, 764.0 618.0 C 763.0 614.5, 764.0 605.5, 758.0 597.0 C 752.0 588.5, 742.5 577.0, 728.0 567.0 C 713.5 557.0, 684.5 545.5, 671.0 537.0 C 657.5 528.5, 653.7 534.5, 647.0 516.0 C 640.3 497.5, 633.7 441.0, 631.0 426.0 Z" />
      </g>
      <path d="M 742.5 622 Q 754.3 667.2 796 680 Q 754.3 692.8 742.5 738 Q 730.7 692.8 689 680 Q 730.7 667.2 742.5 622 Z" fill="#B85D37" />
    </svg>
  )
}
