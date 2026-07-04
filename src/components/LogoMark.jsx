export default function LogoMark({ size = 28, color }) {
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      background: color || 'var(--text)',
      WebkitMask: `url('/logo-mark.png') center/contain no-repeat`,
      WebkitMaskMode: 'luminance',
      mask: `url('/logo-mark.png') center/contain no-repeat`,
      maskMode: 'luminance',
    }} />
  )
}
