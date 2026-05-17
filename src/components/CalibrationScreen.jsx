import { useState, useEffect, useRef } from 'react'
import './CalibrationScreen.css'

/**
 * CalibrationScreen – 9-point gaze calibration UI.
 *
 * Milestone 1 placeholder: renders nine target dots in a 3×3 grid.
 * The user dwells on each dot to "capture" it. When all 9 are captured,
 * `onComplete` is called and the main grid becomes active.
 *
 * In Milestone 2+ this will drive actual calibration data to the Tobii SDK.
 *
 * Props:
 *   onComplete   () => void   – Called when all 9 points are captured.
 *   gazeRef      React.RefObject<{ x, y }|null>  – Direct ref to latest gaze pos.
 *                 Read inside the rAF loop for zero-latency position access.
 *                 Does NOT go through React state — no re-render on gaze move.
 *   dwellMs      number      – Dwell threshold for capturing a point.
 */

const POINTS = [
  { id: 'p1', row: 1, col: 1 }, { id: 'p2', row: 1, col: 2 }, { id: 'p3', row: 1, col: 3 },
  { id: 'p4', row: 2, col: 1 }, { id: 'p5', row: 2, col: 2 }, { id: 'p6', row: 2, col: 3 },
  { id: 'p7', row: 3, col: 1 }, { id: 'p8', row: 3, col: 2 }, { id: 'p9', row: 3, col: 3 }
]

const DOT_RADIUS_PX = 28      // Hit radius in CSS pixels
const CALIBRATION_DWELL = 800 // ms to capture each point

export function CalibrationScreen({ onComplete, gazeRef = null, dwellMs = CALIBRATION_DWELL }) {
  const [captured, setCaptured] = useState(new Set())
  const [active, setActive] = useState(0)        // index of current target point
  const [progress, setProgress] = useState(0)    // 0→1 for current point
  const entryTimeRef = useRef(null)
  const frameRef = useRef(null)

  const currentPoint = POINTS[active]

  // Animate the dwell progress for the active dot
  useEffect(() => {
    function tick() {
      // Read the latest gaze pos from the ref — no React re-render needed
      const gazePos = gazeRef?.current
      if (!gazePos || !currentPoint) {
        frameRef.current = requestAnimationFrame(tick)
        return
      }
      const { x, y } = gazePos

      // Convert normalized gaze to approximate screen fraction per cell
      // Calibration grid occupies 60% of viewport width and 60% height,
      // centered. Each column/row is 1/3 of that.
      const gridW = 0.6, gridH = 0.6
      const gridOffX = (1 - gridW) / 2, gridOffY = (1 - gridH) / 2
      const cellW = gridW / 3, cellH = gridH / 3

      const targetX = gridOffX + (currentPoint.col - 0.5) * cellW
      const targetY = gridOffY + (currentPoint.row - 0.5) * cellH

      const dx = x - targetX
      const dy = y - targetY
      const dist = Math.sqrt(dx * dx + dy * dy)

      // Hit tolerance: ~DOT_RADIUS_PX / viewport_px → normalized
      const hitNorm = DOT_RADIUS_PX / window.innerWidth

      if (dist < hitNorm) {
        if (entryTimeRef.current === null) entryTimeRef.current = Date.now()
        const elapsed = Date.now() - entryTimeRef.current
        setProgress(Math.min(elapsed / dwellMs, 1))

        if (elapsed >= dwellMs) {
          setCaptured(prev => new Set([...prev, currentPoint.id]))
          entryTimeRef.current = null
          setProgress(0)
          if (active < POINTS.length - 1) {
            setActive(prev => prev + 1)
          } else {
            onComplete?.()
          }
        }
      } else {
        entryTimeRef.current = null
        setProgress(0)
      }

      frameRef.current = requestAnimationFrame(tick)
    }

    frameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameRef.current)
  // gazeRef is a stable ref object — it never changes identity, so we
  // intentionally omit it from deps. The loop always reads .current directly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, currentPoint, dwellMs, onComplete])

  const circumference = 2 * Math.PI * 20 // r=20

  return (
    <div className="calibration-screen">
      <div className="calibration-screen__header">
        <h1 className="calibration-screen__title">GazeAAC</h1>
        <p className="calibration-screen__subtitle">
          Look at each dot and hold your gaze to calibrate.
        </p>
        <p className="calibration-screen__counter">
          {captured.size} / {POINTS.length} captured
        </p>
      </div>

      <div className="calibration-screen__grid">
        {POINTS.map((pt, idx) => {
          const isCaptured = captured.has(pt.id)
          const isCurrent  = idx === active && !isCaptured
          const ptProgress = isCurrent ? progress : 0
          const dashOffset = circumference * (1 - ptProgress)

          return (
            <div
              key={pt.id}
              className={[
                'calibration-dot',
                isCaptured ? 'calibration-dot--captured' : '',
                isCurrent  ? 'calibration-dot--active'   : ''
              ].join(' ').trim()}
              data-point-id={pt.id}
            >
              <svg viewBox="0 0 60 60" className="calibration-dot__svg">
                {/* Track */}
                <circle cx="30" cy="30" r="20" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
                {/* Progress */}
                {isCurrent && (
                  <circle
                    cx="30" cy="30" r="20"
                    fill="none"
                    stroke="var(--color-accent)"
                    strokeWidth="3"
                    strokeDasharray={circumference}
                    strokeDashoffset={dashOffset}
                    strokeLinecap="round"
                    transform="rotate(-90 30 30)"
                  />
                )}
                {/* Center dot */}
                <circle
                  cx="30" cy="30"
                  r={isCaptured ? 6 : isCurrent ? 10 : 8}
                  fill={isCaptured ? 'var(--color-success)' : 'var(--color-accent)'}
                  style={{ transition: 'r 0.2s ease, fill 0.3s ease' }}
                />
              </svg>
            </div>
          )
        })}
      </div>

      {/* Skip button for dev / demo mode */}
      <button
        className="calibration-screen__skip"
        onClick={() => onComplete?.()}
      >
        Skip Calibration (Dev Mode)
      </button>
    </div>
  )
}
