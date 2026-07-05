export default function LogoMark({ size = 32, rounded = true, style }) {
  const r = rounded ? Math.round(size * 0.22) : 0
  return (
    <img
      src="/Newlogo.png"
      width={size}
      height={size}
      alt="Mediant"
      style={{ borderRadius: r, display: 'block', flexShrink: 0, objectFit: 'cover', ...style }}
    />
  )
}
