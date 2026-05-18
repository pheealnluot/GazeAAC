import { useRef, useEffect, useCallback, useState } from 'react'
import { useGazeSettings } from '@context/GazeSettingsContext'
import './ContextualResponseGrid.css'

/**
 * ContextualResponseGrid
 *
 * Renders 2–9 AI-generated response strings as large, gaze-selectable tiles.
 *
 * AnswerGate (settings.answerGateMs > 0):
 *   A 3px horizontal progress bar is overlaid at the very top of the grid.
 *   Hovering/gazing on ANY tile fills the bar over answerGateMs. Once
 *   complete, all tiles unlock simultaneously. The bar stays visible after
 *   unlock (turns green).
 *
 *   PERFORMANCE NOTE: The bar fill width is updated via direct DOM mutation
 *   (barFillRef.current.style.width) inside the rAF tick — identical to the
 *   gaze cursor pattern in App.jsx. This avoids a React render cycle on every
 *   frame and gives buttery-smooth 60 fps progress.
 */
export function ContextualResponseGrid({
  responses = [],
  gazeState = {},
  onActivate,
  onGridMeasured,
  onMeasureTriggerReady,
}) {
  const { settings } = useGazeSettings()
  const gridRef    = useRef(null)
  const barRef     = useRef(null)   // the .ctx-gate-bar container
  const barFillRef = useRef(null)   // the .ctx-gate-bar__fill — direct DOM mutations

  // ── AnswerGate ─────────────────────────────────────────────────────────────
  const answerGateMs = settings.answerGateMs ?? 0
  const gateActive   = answerGateMs > 0

  // Only ONE piece of React state for the gate: unlocked (structural change).
  // Progress is tracked in a plain ref and painted via direct DOM mutation.
  const accRef          = useRef(0)
  const [gateUnlocked,  setGateUnlocked]  = useState(!gateActive)
  const gateUnlockedRef = useRef(!gateActive)

  // Helper: update the bar fill width via direct DOM — zero React render cost
  const setBarWidth = useCallback((frac) => {
    if (barFillRef.current) {
      barFillRef.current.style.width = `${Math.min(1, frac) * 100}%`
    }
  }, [])

  // Helper: mark bar as "done" (add class, keep visible)
  const markBarDone = useCallback(() => {
    if (barRef.current) barRef.current.classList.add('ctx-gate-bar--done')
  }, [])

  // Reset gate whenever responses change or gate setting toggles
  useEffect(() => {
    if (!gateActive || !responses.length) {
      accRef.current = 1
      gateUnlockedRef.current = true
      setGateUnlocked(true)
      setBarWidth(1)
    } else {
      accRef.current = 0
      gateUnlockedRef.current = false
      setGateUnlocked(false)
      setBarWidth(0)
      if (barRef.current) barRef.current.classList.remove('ctx-gate-bar--done')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [responses, gateActive, setBarWidth])

  // Whether any tile is currently hovered/gazed
  const isHoveringRef = useRef(false)
  const rafRef        = useRef(null)
  const lastTimeRef   = useRef(null)

  const stopGateLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const startGateLoop = useCallback(() => {
    if (rafRef.current) return // already running
    lastTimeRef.current = performance.now()

    const tick = (now) => {
      const dt = now - lastTimeRef.current
      lastTimeRef.current = now

      if (!isHoveringRef.current || gateUnlockedRef.current || answerGateMs <= 0) {
        // Idle — keep loop alive so it resumes when hover re-enters
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      // Accumulate in ref — no setState
      const next = Math.min(1, accRef.current + dt / answerGateMs)
      accRef.current = next

      // ── Direct DOM mutation — zero React render overhead ─────────────────
      setBarWidth(next)

      if (next >= 1) {
        // Unlock: one-time React state update + DOM class change
        gateUnlockedRef.current = true
        setGateUnlocked(true)
        markBarDone()
        stopGateLoop()
        return
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
  }, [answerGateMs, setBarWidth, markBarDone, stopGateLoop])

  // Gaze state drives hover (eye-tracker / mouse hover mode)
  useEffect(() => {
    if (!gateActive || gateUnlockedRef.current) return
    const { cellId } = gazeState
    const onAnyTile = typeof cellId === 'string' && cellId.startsWith('ctx-r')
    isHoveringRef.current = onAnyTile
    if (onAnyTile) startGateLoop()
  }, [gazeState, gateActive, startGateLoop])

  // Cleanup rAF on unmount
  useEffect(() => () => stopGateLoop(), [stopGateLoop])

  // Mouse enter/leave — any tile contributes to the shared gate
  const handleAnyTileEnter = useCallback(() => {
    if (!gateActive || gateUnlockedRef.current) return
    isHoveringRef.current = true
    startGateLoop()
  }, [gateActive, startGateLoop])

  const handleAnyTileLeave = useCallback(() => {
    isHoveringRef.current = false
  }, [])

  // ── DOM measurement ───────────────────────────────────────────────────────
  const measureGrid = useCallback(() => {
    if (!gridRef.current || !onGridMeasured) return
    const buttons = gridRef.current.querySelectorAll('[data-cell-id]')
    if (!buttons.length) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const cells = []
    buttons.forEach(el => {
      const id   = el.getAttribute('data-cell-id')
      const rect = el.getBoundingClientRect()
      cells.push({
        id,
        x0: rect.left   / vw,
        y0: rect.top    / vh,
        x1: rect.right  / vw,
        y1: rect.bottom / vh,
      })
    })
    if (cells.length) onGridMeasured(cells)
  }, [onGridMeasured])

  useEffect(() => {
    if (!gridRef.current) return
    const rafId = requestAnimationFrame(() => setTimeout(measureGrid, 0))
    const obs = new ResizeObserver(measureGrid)
    obs.observe(gridRef.current)
    window.addEventListener('resize', measureGrid)
    return () => {
      cancelAnimationFrame(rafId)
      obs.disconnect()
      window.removeEventListener('resize', measureGrid)
    }
  }, [measureGrid])

  useEffect(() => { onMeasureTriggerReady?.(measureGrid) }, [measureGrid, onMeasureTriggerReady])

  useEffect(() => {
    const rafId = requestAnimationFrame(() => setTimeout(measureGrid, 0))
    return () => cancelAnimationFrame(rafId)
  }, [responses, measureGrid])

  const { cellId: gazedId, dwellProgress = 0 } = gazeState
  const isGated = gateActive && !gateUnlocked

  // ── Placeholder when no responses yet ────────────────────────────────────
  if (!responses.length) {
    return (
      <div className="ctx-grid-wrap">
        <div className="ctx-grid ctx-grid--empty" ref={gridRef}>
          <div className="ctx-grid__placeholder">
            <span className="ctx-grid__placeholder-icon">🧠</span>
            <span className="ctx-grid__placeholder-text">
              Provide context above to generate response suggestions
            </span>
            <span className="ctx-grid__placeholder-hint">
              Type, speak, or capture an image — responses will appear here
            </span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="ctx-grid-wrap">

      {/* ── AnswerGate bar — position:absolute, 3px, zero layout impact ──── */}
      {gateActive && (
        <div
          ref={barRef}
          className="ctx-gate-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Answer gate reading progress"
        >
          <div ref={barFillRef} className="ctx-gate-bar__fill" style={{ width: '0%' }} />
        </div>
      )}

      {/* ── Response tile grid ─────────────────────────────────────────────── */}
      <div
        ref={gridRef}
        className={`ctx-grid ${isGated ? 'ctx-grid--gated' : ''}`}
        data-count={responses.length}
        role="grid"
        aria-label="AI-generated response suggestions"
      >
        {responses.map((text, i) => {
          const cellId     = `ctx-r${i}`
          const isGazed    = cellId === gazedId
          const progress   = isGazed && !isGated ? dwellProgress : 0
          const ringCirc   = 2 * Math.PI * 40
          const dashOffset = ringCirc * (1 - progress)
          const opacity    = settings.dwellProgressOpacity ?? 1.0

          return (
            <button
              key={cellId}
              className={[
                'ctx-cell',
                isGazed && !isGated ? 'ctx-cell--gazed' : '',
                progress >= 1 && !isGated ? 'ctx-cell--activated' : '',
                isGated ? 'ctx-cell--gated' : '',
              ].filter(Boolean).join(' ')}
              data-cell-id={cellId}
              style={{
                '--dwell-progress': progress,
                '--dwell-ring-opacity': opacity,
                '--ctx-hue': 200 + i * 40,
              }}
              aria-label={text}
              aria-disabled={isGated ? 'true' : undefined}
              onClick={() => !isGated && onActivate?.(cellId)}
              onMouseEnter={handleAnyTileEnter}
              onMouseLeave={handleAnyTileLeave}
            >
              {!isGated && (
                <svg className="ctx-cell__ring" viewBox="0 0 100 100" aria-hidden="true">
                  <circle className="ctx-cell__ring-track" cx="50" cy="50" r="40" fill="none" strokeWidth="4" />
                  <circle
                    className="ctx-cell__ring-arc"
                    cx="50" cy="50" r="40"
                    fill="none" strokeWidth="4"
                    strokeDasharray={ringCirc}
                    strokeDashoffset={dashOffset}
                    strokeLinecap="round"
                    transform="rotate(-90 50 50)"
                  />
                </svg>
              )}
              <span className="ctx-cell__index" aria-hidden="true">{i + 1}</span>
              <span className="ctx-cell__text">{text}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
