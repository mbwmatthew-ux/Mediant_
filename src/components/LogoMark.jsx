export default function LogoMark({ size = 32, rounded = true, style }) {
  const r = rounded ? 22 : 0
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      style={{ flexShrink: 0, display: 'block', ...style }}
      aria-label="Mediant logo"
    >
      <rect width="100" height="100" rx={r} fill="#0D8F8C"/>

      {/* White eighth note */}
      <ellipse cx="38" cy="70" rx="17" ry="15" fill="white"/>
      <rect x="53" y="20" width="5" height="52" rx="2.5" fill="white"/>
      <path
        d="M 58 20 C 90 18 90 46 72 54 C 64 58 58 52 58 47"
        stroke="white" strokeWidth="6" fill="none"
        strokeLinecap="round" strokeLinejoin="round"
      />

      {/* Coral glasses — left */}
      <rect x="17" y="63" width="24" height="16" rx="5" fill="#E8614A"/>
      <rect x="21" y="67" width="16" height="8"  rx="2.5" fill="white"/>

      {/* Coral glasses — right */}
      <rect x="43" y="63" width="24" height="16" rx="5" fill="#E8614A"/>
      <rect x="47" y="67" width="16" height="8"  rx="2.5" fill="white"/>

      {/* Bridge */}
      <rect x="41" y="67" width="2" height="6" fill="#E8614A"/>
    </svg>
  )
}
