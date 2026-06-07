import { useRef, useEffect, useCallback, useState } from 'react'
import { useGazeSettings } from '@context/GazeSettingsContext'
import './ContextualResponseGrid.css'

/**
 * playReadyChime — synthesizes a soft two-tone "ready" chime via Web Audio.
 * Called once when contextual responses first appear (0 → N).
 * No external audio file — pure oscillator synthesis.
 */
function playReadyChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()

    const gain = ctx.createGain()
    gain.connect(ctx.destination)

    // Two-note chime: perfect 5th interval (523 Hz C5 + 784 Hz G5)
    const notes = [
      { freq: 523.25, startOffset: 0,    duration: 0.55 },
      { freq: 784.00, startOffset: 0.08, duration: 0.55 },
    ]

    notes.forEach(({ freq, startOffset, duration }) => {
      const osc  = ctx.createOscillator()
      const env  = ctx.createGain()

      osc.type      = 'sine'
      osc.frequency.setValueAtTime(freq, ctx.currentTime)

      // Soft attack + exponential decay envelope
      env.gain.setValueAtTime(0, ctx.currentTime + startOffset)
      env.gain.linearRampToValueAtTime(0.22, ctx.currentTime + startOffset + 0.015)
      env.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startOffset + duration)

      osc.connect(env)
      env.connect(gain)

      osc.start(ctx.currentTime + startOffset)
      osc.stop(ctx.currentTime + startOffset + duration)
    })

    // Close AudioContext after chime finishes to free resources
    setTimeout(() => ctx.close(), 1200)
  } catch (e) {
    // Audio not available — fail silently
  }
}

/**
 * playGateUnlockChime — synthesizes a bright ascending two-note "go!" cue.
 * Fired once when the AnswerGate bar reaches 100% (timer path) or when the
 * Proceed button is pressed (manual gate path), signalling that the response
 * tiles are now individually dwell-selectable.
 * Deliberately distinct from playReadyChime (two simultaneous notes) by using
 * a quick ascending sequence — like a "ding-ding" unlock sound.
 */
function playGateUnlockChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()

    const gain = ctx.createGain()
    gain.connect(ctx.destination)

    // Ascending two-note sequence: D5 → A5 (bright perfect 5th, quick)
    const notes = [
      { freq: 587.33, startOffset: 0,    duration: 0.22 },  // D5
      { freq: 880.00, startOffset: 0.13, duration: 0.45 },  // A5
    ]

    notes.forEach(({ freq, startOffset, duration }) => {
      const osc = ctx.createOscillator()
      const env = ctx.createGain()

      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, ctx.currentTime)

      env.gain.setValueAtTime(0, ctx.currentTime + startOffset)
      env.gain.linearRampToValueAtTime(0.16, ctx.currentTime + startOffset + 0.012)
      env.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startOffset + duration)

      osc.connect(env)
      env.connect(gain)

      osc.start(ctx.currentTime + startOffset)
      osc.stop(ctx.currentTime + startOffset + duration)
    })

    setTimeout(() => ctx.close(), 1000)
  } catch (e) {
    // Audio not available — fail silently
  }
}

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
 * Manual Gate (settings.answerGateMs === -1):
 *   The gate starts locked and the bar stays at 0%. The hover timer never
 *   runs. The parent unlocks by calling onGateUnlockedChange(true) from the
 *   Proceed button. The bar then flashes to 100% green.
 *   onManualGatePending(true/false) lets the parent know when Proceed should
 *   be shown.
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
  onGateUnlockedChange,
  onManualGatePending,
  onUnlockTriggerReady,
  onLockTriggerReady,
  singleReplyMode = false,
  lockedResponseIdx = -1,
  onResetSingleReplyLock,
}) {
  const { settings } = useGazeSettings()
  const gridRef    = useRef(null)
  const barRef     = useRef(null)   // the .ctx-gate-bar container
  const barFillRef = useRef(null)   // the .ctx-gate-bar__fill — direct DOM mutations

  // ── AnswerGate ─────────────────────────────────────────────────────────────
  const answerGateMs = settings.answerGateMs ?? 0
  // Manual mode: answerGateMs === -1 → gate is active but never auto-unlocks
  const isManualGate = answerGateMs === -1
  const gateActive   = answerGateMs > 0 || isManualGate

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

  // Stabilize callbacks to prevent reference recreation from resetting the gate
  const onGateUnlockedChangeRef = useRef(onGateUnlockedChange)
  useEffect(() => {
    onGateUnlockedChangeRef.current = onGateUnlockedChange
  }, [onGateUnlockedChange])

  const onManualGatePendingRef = useRef(onManualGatePending)
  useEffect(() => {
    onManualGatePendingRef.current = onManualGatePending
  }, [onManualGatePending])

  // ── Imperative unlock trigger (used by Proceed button via onUnlockTriggerReady) ────
  // Calling this does everything setGateUnlocked does in the timer tick:
  // updates both the ref (for the router) and the React state (for the UI),
  // marks the bar done, and plays the unlock chime.
  const triggerManualUnlock = useCallback(() => {
    if (gateUnlockedRef.current) return          // already unlocked — no-op
    gateUnlockedRef.current = true
    setGateUnlocked(true)
    markBarDone()
    onGateUnlockedChangeRef.current?.(true)
    onManualGatePendingRef.current?.(false)
    playGateUnlockChime()
  }, [markBarDone])

  // Expose the trigger to the parent so the Proceed button can call it directly
  useEffect(() => {
    onUnlockTriggerReady?.(triggerManualUnlock)
  }, [triggerManualUnlock, onUnlockTriggerReady])

  // ── Imperative lock trigger (used by Lock button via onLockTriggerReady) ────
  const triggerManualLock = useCallback(() => {
    if (!gateUnlockedRef.current) return          // already locked — no-op
    gateUnlockedRef.current = false
    setGateUnlocked(false)
    if (barRef.current) barRef.current.classList.remove('ctx-gate-bar--done')
    setBarWidth(0)
    onGateUnlockedChangeRef.current?.(false)
    onManualGatePendingRef.current?.(true)
  }, [setBarWidth])

  // Expose the trigger to the parent so the Lock button can call it directly
  useEffect(() => {
    onLockTriggerReady?.(triggerManualLock)
  }, [triggerManualLock, onLockTriggerReady])

  // ── Chime on response ready ───────────────────────────────────────────────
  // In manual gate mode: chime on every new response batch so the user always
  // hears an audio cue that responses are available, even if the AI returned
  // the same suggestions as last time.
  // In timer/no-gate mode: only chime on the 0 → N transition (the gate-unlock
  // chime that follows shortly after provides the "go" signal).
  const prevResponseCountRef = useRef(0)
  const prevResponsesRef = useRef(responses)
  useEffect(() => {
    const prev      = prevResponseCountRef.current
    const curr      = responses.length
    const prevResp  = prevResponsesRef.current
    prevResponseCountRef.current = curr
    prevResponsesRef.current     = responses
    if (curr === 0) return
    if (isManualGate) {
      // Play on every new batch — even if count didn't change (same responses)
      if (prev === 0 || responses !== prevResp) {
        playReadyChime()
      }
    } else {
      // Timer / no-gate mode: only on 0 → N
      if (prev === 0) playReadyChime()
    }
  }, [responses, isManualGate])

  // Reset gate whenever responses change or gate setting toggles
  useEffect(() => {
    if (!gateActive || !responses.length) {
      accRef.current = 1
      gateUnlockedRef.current = true
      setGateUnlocked(true)
      setBarWidth(1)
      onGateUnlockedChangeRef.current?.(true)
      onManualGatePendingRef.current?.(false)
    } else {
      accRef.current = 0
      gateUnlockedRef.current = false
      setGateUnlocked(false)
      setBarWidth(0)
      if (barRef.current) barRef.current.classList.remove('ctx-gate-bar--done')
      onGateUnlockedChangeRef.current?.(false)
      // For manual gate: notify parent that Proceed button should appear
      if (isManualGate) onManualGatePendingRef.current?.(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [responses, gateActive, isManualGate, setBarWidth])

  // Whether any tile is currently hovered/gazed
  const isHoveringRef = useRef(false)
  const lastHoverTimeRef = useRef(performance.now())
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
    const now = performance.now()
    lastTimeRef.current = now
    lastHoverTimeRef.current = now

    const tick = (nowTime) => {
      const dt = nowTime - lastTimeRef.current
      lastTimeRef.current = nowTime

      // Manual gate: never auto-unlock, the loop should not run
      if (isManualGate) {
        stopGateLoop()
        return
      }

      // Grace period implementation:
      // Even if isHoveringRef is briefly false (moving between tiles, eye tracking dropout),
      // allow continuous progress for up to 300ms transition grace period.
      const isCurrentlyHovered = isHoveringRef.current
      if (isCurrentlyHovered) {
        lastHoverTimeRef.current = nowTime
      }
      const withinGracePeriod = (nowTime - lastHoverTimeRef.current) < 300

      if (!withinGracePeriod || gateUnlockedRef.current || answerGateMs <= 0) {
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
        onGateUnlockedChangeRef.current?.(true)
        onManualGatePendingRef.current?.(false)
        playGateUnlockChime()  // ← "tiles are now selectable" audio cue
        return
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
  }, [answerGateMs, isManualGate, setBarWidth, markBarDone, stopGateLoop])

  // Gaze state drives hover (eye-tracker / mouse hover mode)
  // Manual gate: skip — hover never fills the bar
  useEffect(() => {
    if (!gateActive || gateUnlockedRef.current || isManualGate) return
    const { cellId } = gazeState
    const onAnyTile = typeof cellId === 'string' && cellId.startsWith('ctx-r')
    isHoveringRef.current = onAnyTile
    if (onAnyTile) startGateLoop()
  }, [gazeState, gateActive, isManualGate, startGateLoop])

  // Cleanup rAF on unmount
  useEffect(() => () => stopGateLoop(), [stopGateLoop])

  // Mouse enter/leave — any tile contributes to the shared gate
  // Manual gate: hover doesn't fill the bar
  const handleAnyTileEnter = useCallback(() => {
    if (!gateActive || gateUnlockedRef.current || isManualGate) return
    isHoveringRef.current = true
    startGateLoop()
  }, [gateActive, isManualGate, startGateLoop])

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

  // Clear registered grid cells when responses are cleared / empty
  useEffect(() => {
    if (!responses || responses.length === 0) {
      onGridMeasured?.([])
    }
  }, [responses, onGridMeasured])

  const { cellId: gazedId, dwellProgress = 0 } = gazeState
  const isGated = gateActive && !gateUnlocked

  // Single Reply derived state
  // A tile is "locked out" when singleReplyMode is on, a selection has been made,
  // and this tile is NOT the selected one.
  const singleReplyLocked = singleReplyMode && lockedResponseIdx !== -1

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
          // A tile is individually locked out in Single Reply mode
          const isLockedOut = singleReplyLocked && i !== lockedResponseIdx
          const isSelected  = singleReplyMode && i === lockedResponseIdx
          const interactive = !isGated && !isLockedOut
          const progress   = isGazed && interactive ? dwellProgress : 0
          const ringCirc   = 2 * Math.PI * 40
          const dashOffset = ringCirc * (1 - progress)
          const opacity    = settings.dwellProgressOpacity ?? 1.0

          return (
            <button
              key={cellId}
              className={[
                'ctx-cell',
                isGazed && interactive ? 'ctx-cell--gazed' : '',
                progress >= 1 && interactive ? 'ctx-cell--activated' : '',
                isGated ? 'ctx-cell--gated' : '',
                isLockedOut ? 'ctx-cell--locked-out' : '',
                isSelected  ? 'ctx-cell--selected' : '',
              ].filter(Boolean).join(' ')}
              data-cell-id={cellId}
              style={{
                '--dwell-progress': progress,
                '--dwell-ring-opacity': opacity,
                '--ctx-hue': 200 + i * 40,
              }}
              aria-label={text}
              aria-disabled={(isGated || isLockedOut) ? 'true' : undefined}
              onClick={() => interactive && onActivate?.(cellId)}
              onMouseEnter={handleAnyTileEnter}
              onMouseLeave={handleAnyTileLeave}
            >
              {interactive && (
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
