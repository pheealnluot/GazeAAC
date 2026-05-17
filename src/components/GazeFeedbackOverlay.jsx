import { useRef, useEffect, useCallback } from 'react'
import './GazeFeedbackOverlay.css'

/**
 * GazeFeedbackOverlay – Real-time ocular feedback visualizer.
 *
 * Position is updated via a direct DOM mutation callback registered in
 * `positionCallbackRef` — this fires on every gaze frame regardless of whether
 * the eye is on a masked or unmasked cell.  React re-renders only fire when
 * dwellProgress / cellId change (for the dwell arc and border box).
 *
 * Props:
 *   pattern            {'ring-pulse'|'spotlight'|'heat-trail'|'border'}
 *   gazePos            {{ x, y } | null}   initial/fallback position
 *   dwellProgress      {number}            [0,1]
 *   cellId             {string | null}
 *   cursorColor        {string}            CSS colour from settings
 *   positionCallbackRef {React.MutableRefObject}  populated here; called on every frame
 */
export function GazeFeedbackOverlay({
  pattern,
  gazePos,
  dwellProgress = 0,
  cellId = null,
  cursorColor = 'rgba(0,200,255,0.85)',
  positionCallbackRef,
}) {
  if (!gazePos) return null

  const rgb = parseRgb(cursorColor)

  switch (pattern) {
    case 'spotlight':
      return <SpotlightPattern
        gazePos={gazePos} dwellProgress={dwellProgress}
        rgb={rgb} positionCallbackRef={positionCallbackRef} />
    case 'heat-trail':
      return <HeatTrailPattern
        gazePos={gazePos} dwellProgress={dwellProgress}
        rgb={rgb} positionCallbackRef={positionCallbackRef} />
    case 'border':
      return <BorderPattern
        gazePos={gazePos} dwellProgress={dwellProgress}
        cellId={cellId} rgb={rgb} positionCallbackRef={positionCallbackRef} />
    case 'ring-pulse':
    default:
      return <RingPulsePattern
        gazePos={gazePos} dwellProgress={dwellProgress}
        rgb={rgb} positionCallbackRef={positionCallbackRef} />
  }
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

function parseRgb(color) {
  if (!color) return { r: 0, g: 200, b: 255 }
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (m) return { r: +m[1], g: +m[2], b: +m[3] }
  let hex = color.trim().replace('#', '')
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('')
  if (hex.length === 6) return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  }
  return { r: 0, g: 200, b: 255 }
}

function rgba({ r, g, b }, a) {
  return `rgba(${r},${g},${b},${a.toFixed(3)})`
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern A: Ring Pulse
// ─────────────────────────────────────────────────────────────────────────────

function RingPulsePattern({ gazePos, dwellProgress, rgb, positionCallbackRef }) {
  const svgRef = useRef(null)

  // Register position-update callback — fires every gaze frame from App.jsx.
  // This updates the SVG transform without any React re-render, ensuring the
  // ring tracks the eye across the ENTIRE board (masked + unmasked cells).
  useEffect(() => {
    if (!positionCallbackRef) return
    positionCallbackRef.current = (pos) => {
      const el = svgRef.current
      if (!el) return
      const px = pos.x * window.innerWidth
      const py = pos.y * window.innerHeight
      el.style.transform = `translate(${px - 60}px, ${py - 60}px)`
    }
    return () => { if (positionCallbackRef.current) positionCallbackRef.current = null }
  }, [positionCallbackRef])

  // Initial position from React props (used on first render)
  const px = gazePos.x * window.innerWidth
  const py = gazePos.y * window.innerHeight

  const baseRadius   = 28
  const radius       = baseRadius + dwellProgress * 10
  const circumference = 2 * Math.PI * baseRadius
  const dashOffset   = circumference * (1 - dwellProgress)
  const glowOpacity  = 0.3 + dwellProgress * 0.7
  const glowBlur     = 6 + dwellProgress * 16

  return (
    <div className="gfo gfo--ring-pulse" aria-hidden="true">
      <svg
        ref={svgRef}
        className="gfo__ring-svg"
        style={{ transform: `translate(${px - 60}px, ${py - 60}px)` }}
        viewBox="-60 -60 120 120"
        width={120}
        height={120}
      >
        <circle cx={0} cy={0} r={radius} fill="none"
          stroke={rgba(rgb, 0.2 + dwellProgress * 0.4)} strokeWidth={2} />
        <circle
          cx={0} cy={0} r={baseRadius} fill="none"
          stroke={rgba(rgb, glowOpacity)}
          strokeWidth={4}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform="rotate(-90)"
          style={{ filter: `drop-shadow(0 0 ${glowBlur}px ${rgba(rgb, glowOpacity)})` }}
        />
        <circle cx={0} cy={0} r={3 + dwellProgress * 3}
          fill={rgba(rgb, 0.6 + dwellProgress * 0.4)} />
      </svg>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern B: Gaze Spotlight
// ─────────────────────────────────────────────────────────────────────────────

function SpotlightPattern({ gazePos, dwellProgress, rgb, positionCallbackRef }) {
  const divRef = useRef(null)

  // Spotlight position is baked into the CSS gradient; we rebuild on every
  // position callback call.
  const buildGradient = useCallback((pos, progress) => {
    const spotRadius = Math.round(230 - progress * 100)
    const vignetteDark = 0.55 + progress * 0.25
    const cx = `${(pos.x * 100).toFixed(2)}%`
    const cy = `${(pos.y * 100).toFixed(2)}%`
    return [
      `radial-gradient(ellipse ${spotRadius}px ${spotRadius}px at ${cx} ${cy},`,
      `  transparent 60%,`,
      `  rgba(${rgb.r},${rgb.g},${rgb.b},${(vignetteDark * 0.35).toFixed(3)}) 80%,`,
      `  rgba(0,0,0,${vignetteDark.toFixed(3)}) 100%)`
    ].join('\n')
  }, [rgb.r, rgb.g, rgb.b])

  const dwellRef = useRef(dwellProgress)
  dwellRef.current = dwellProgress

  useEffect(() => {
    if (!positionCallbackRef) return
    positionCallbackRef.current = (pos) => {
      const el = divRef.current
      if (el) el.style.background = buildGradient(pos, dwellRef.current)
    }
    return () => { if (positionCallbackRef.current) positionCallbackRef.current = null }
  }, [positionCallbackRef, buildGradient])

  return (
    <div
      ref={divRef}
      className="gfo gfo--spotlight"
      aria-hidden="true"
      style={{ background: buildGradient(gazePos, dwellProgress) }}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern C: Heat Trail
// ─────────────────────────────────────────────────────────────────────────────

const PARTICLE_LIFETIME = 900
const MAX_PARTICLES = 80

function HeatTrailPattern({ gazePos, rgb, positionCallbackRef }) {
  const canvasRef    = useRef(null)
  const particlesRef = useRef([])
  const animFrameRef = useRef(null)
  const lastPosRef   = useRef(null)
  const rgbRef       = useRef(rgb)
  rgbRef.current = rgb

  const addParticle = useCallback((x, y, now) => {
    particlesRef.current.push({ x, y, born: now, r: 5 + Math.random() * 4 })
    if (particlesRef.current.length > MAX_PARTICLES) particlesRef.current.shift()
  }, [])

  // Position callback — heat trail simply adds particles at each new position
  useEffect(() => {
    if (!positionCallbackRef) return
    positionCallbackRef.current = (pos) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const px = pos.x * canvas.width
      const py = pos.y * canvas.height
      const last = lastPosRef.current
      const dist = last ? Math.hypot(px - last.x, py - last.y) : Infinity
      if (dist > 3) {
        addParticle(px, py, performance.now())
        lastPosRef.current = { x: px, y: py }
      }
    }
    return () => { if (positionCallbackRef.current) positionCallbackRef.current = null }
  }, [positionCallbackRef, addParticle])

  const render = useCallback((now) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const { r: cr, g: cg, b: cb } = rgbRef.current
    particlesRef.current = particlesRef.current.filter(p => {
      const age = now - p.born
      if (age > PARTICLE_LIFETIME) return false
      const progress = age / PARTICLE_LIFETIME
      const alpha = (1 - progress) * 0.75
      const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * (1 + progress))
      gr.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`)
      gr.addColorStop(1, `rgba(${Math.round(cr * 0.4)},${Math.round(cg * 0.4)},${Math.round(cb * 0.4)},0)`)
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r * (1 + progress * 0.5), 0, Math.PI * 2)
      ctx.fillStyle = gr
      ctx.fill()
      return true
    })
    animFrameRef.current = requestAnimationFrame(render)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight }
    resize()
    window.addEventListener('resize', resize)
    animFrameRef.current = requestAnimationFrame(render)
    return () => {
      window.removeEventListener('resize', resize)
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  }, [render])

  return (
    <div className="gfo gfo--heat-trail" aria-hidden="true">
      <canvas ref={canvasRef} className="gfo__heat-canvas" />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern D: Border
// ─────────────────────────────────────────────────────────────────────────────

function BorderPattern({ gazePos, dwellProgress, cellId, rgb, positionCallbackRef }) {
  const boxRef = useRef(null)
  const dotRef = useRef(null)

  // Update border-dot position via direct DOM mutation on every frame
  useEffect(() => {
    if (!positionCallbackRef) return
    positionCallbackRef.current = (pos) => {
      const dot = dotRef.current
      if (dot) {
        const px = pos.x * window.innerWidth
        const py = pos.y * window.innerHeight
        dot.style.transform = `translate(${px}px, ${py}px)`
      }
    }
    return () => { if (positionCallbackRef.current) positionCallbackRef.current = null }
  }, [positionCallbackRef])

  // Border box snaps to the gazed cell's DOM rect (only changes when cellId changes)
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    if (!cellId) { box.style.opacity = '0'; return }
    const el = document.querySelector(`[data-cell-id="${cellId}"]`)
    if (!el) { box.style.opacity = '0'; return }
    const r = el.getBoundingClientRect()
    const pad = 2
    box.style.left   = `${r.left   - pad}px`
    box.style.top    = `${r.top    - pad}px`
    box.style.width  = `${r.width  + pad * 2}px`
    box.style.height = `${r.height + pad * 2}px`
    box.style.opacity = '1'
  }, [cellId])

  const glowSpread  = 2  + dwellProgress * 10
  const glowBlur    = 4  + dwellProgress * 18
  const borderAlpha = 0.55 + dwellProgress * 0.45
  const borderWidth = 1.5 + dwellProgress * 1.5
  const borderColor = rgba(rgb, borderAlpha)
  const boxShadow = [
    `0 0 ${glowBlur}px ${glowSpread}px ${rgba(rgb, borderAlpha * 0.6)}`,
    `inset 0 0 ${glowBlur * 0.5}px ${rgba(rgb, borderAlpha * 0.15)}`
  ].join(', ')

  const dotX = gazePos.x * window.innerWidth
  const dotY = gazePos.y * window.innerHeight

  return (
    <div className="gfo gfo--border" aria-hidden="true">
      <div
        ref={boxRef}
        className="gfo__border-box"
        style={{ borderWidth: `${borderWidth}px`, borderColor, boxShadow,
          borderRadius: 'var(--radius-md)', opacity: cellId ? 1 : 0 }}
      />
      <div
        ref={dotRef}
        className="gfo__border-dot"
        style={{
          transform: `translate(${dotX}px, ${dotY}px)`,
          background: rgba(rgb, 0.55),
        }}
      />
    </div>
  )
}
