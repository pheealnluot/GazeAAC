import { useState, useEffect, useRef } from 'react'
import { GazeCalibrationEngine } from '../engine/GazeCalibrationEngine'
import { useGazeSettings } from '@context/GazeSettingsContext'
import './CalibrationScreen.css'

/**
 * CalibrationScreen – 5-point gaze calibration UI.
 *
 * Renders five target dots at center + four corners. The user dwells on each
 * dot for 500ms while raw gaze samples are collected. After all 5 dots are
 * captured the engine computes a correction transform, persists it, and shows
 * a brief quality result before calling `onComplete`.
 *
 * Props:
 *   onComplete   (correctionData | null) => void  – Called with correction JSON
 *                 when calibration finishes, or null when skipped / disabled.
 *   gazeRef      React.RefObject<{ x, y }|null>  – Direct ref to latest gaze pos.
 *                 Read inside the rAF loop for zero-latency position access.
 *                 Does NOT go through React state — no re-render on gaze move.
 *   dwellMs      number      – Dwell threshold for capturing a point (unused, kept for API compat).
 *   enabled      boolean     – If false, immediately calls onComplete(null).
 */

const CALIBRATION_POINTS = [
  { id: 'c',  x: 0.5,  y: 0.5  },  // Center
  { id: 'tl', x: 0.04, y: 0.04 },  // Top-Left
  { id: 'tr', x: 0.96, y: 0.04 },  // Top-Right
  { id: 'bl', x: 0.04, y: 0.96 },  // Bottom-Left
  { id: 'br', x: 0.96, y: 0.96 },  // Bottom-Right
]

const CALIBRATION_DWELL_MS = 800    // ms to capture each point (slowed down from 500ms for more stable staring)

// Synthesize a premium audio confirmation chord chime using Web Audio API
function playSuccessChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc1 = ctx.createOscillator()
    const osc2 = ctx.createOscillator()
    const gainNode = ctx.createGain()

    osc1.connect(gainNode)
    osc2.connect(gainNode)
    gainNode.connect(ctx.destination)

    osc1.type = 'sine'
    // C5 (523.25 Hz) -> E5 (659.25 Hz) -> G5 (783.99 Hz)
    osc1.frequency.setValueAtTime(523.25, ctx.currentTime)
    osc1.frequency.exponentialRampToValueAtTime(659.25, ctx.currentTime + 0.15)
    osc1.frequency.exponentialRampToValueAtTime(783.99, ctx.currentTime + 0.3)

    osc2.type = 'triangle'
    osc2.frequency.setValueAtTime(261.63, ctx.currentTime) // C4
    osc2.frequency.exponentialRampToValueAtTime(329.63, ctx.currentTime + 0.15) // E4
    osc2.frequency.exponentialRampToValueAtTime(392.00, ctx.currentTime + 0.3) // G4

    gainNode.gain.setValueAtTime(0.001, ctx.currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.05)
    gainNode.gain.exponentialRampToValueAtTime(0.09, ctx.currentTime + 0.18)
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6)

    osc1.start(ctx.currentTime)
    osc2.start(ctx.currentTime)
    osc1.stop(ctx.currentTime + 0.6)
    osc2.stop(ctx.currentTime + 0.6)
    osc1.onended = () => ctx.close()
  } catch (_) { /* audio context not supported or blocked */ }
}

// Spoken announcements for gaze-dwell instructions
function speakText(text) {
  if (window.gazeAPI?.speak) {
    window.gazeAPI.speak(text)
  } else if (window.speechSynthesis) {
    // Cancel any ongoing speech so new guidance is immediately audible
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 0.95
    window.speechSynthesis.speak(utterance)
  }
}

export function CalibrationScreen({ onComplete, gazeRef = null, routerRef = null, dwellMs, enabled = true }) {
  const { updateSetting } = useGazeSettings()
  const [captured, setCaptured] = useState(new Set())
  const [hoveredDotId, setHoveredDotId] = useState(null)
  const [progress, setProgress] = useState(0)    // 0→1 for current point
  const [resultOverlay, setResultOverlay] = useState(null) // { quality, level, ...improvement }

  // Results phase states
  const [phase, setPhase] = useState('calibrating') // 'calibrating' | 'results'
  const [buttonDwellProgress, setButtonDwellProgress] = useState(0)
  const [buttonRetryDwellProgress, setButtonRetryDwellProgress] = useState(0)
  const [buttonResetDwellProgress, setButtonResetDwellProgress] = useState(0)
  const [buttonSkipDwellProgress, setButtonSkipDwellProgress] = useState(0)
  const [caregiverTrigger, setCaregiverTrigger] = useState(false)
  const caregiverTriggerRef = useRef(caregiverTrigger)

  useEffect(() => {
    caregiverTriggerRef.current = caregiverTrigger
  }, [caregiverTrigger])

  const entryTimeRef = useRef(null)
  const hoveredDotIdRef = useRef(null)
  const capturedRef = useRef(new Set())
  const frameRef = useRef(null)
  const btnDwellStartRef = useRef(null)
  const btnRetryDwellStartRef = useRef(null)
  const btnResetDwellStartRef = useRef(null)
  const btnSkipDwellStartRef = useRef(null)
  const resultOverlayRef = useRef(null)
  const cursorRef = useRef(null)
  const mousePosRef = useRef(null)
  const localGazeRef = useRef(null)
  const smoothedGazeRef = useRef(null)

  useEffect(() => {
    const handleMouseMove = (e) => {
      mousePosRef.current = {
        x: e.clientX / window.innerWidth,
        y: e.clientY / window.innerHeight,
      }
    }
    window.addEventListener('mousemove', handleMouseMove)
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [])

  // Listen for Spacebar key presses when caregiverTrigger is active
  useEffect(() => {
    if (phase !== 'calibrating') return

    const handleKeyDown = (e) => {
      if (!caregiverTriggerRef.current) return

      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault() // Prevent screen scroll
        const uncaptured = CALIBRATION_POINTS.filter(p => !capturedRef.current.has(p.id))
        const activeTarget = uncaptured[0]
        if (activeTarget) {
          // Capture immediately using current gaze position or mouse position
          const activeGaze = localGazeRef.current || gazeRef?.current || mousePosRef.current
          const finalX = activeGaze ? activeGaze.x : activeTarget.x
          const finalY = activeGaze ? activeGaze.y : activeTarget.y
          
          captureDot(activeTarget.id, finalX, finalY, false)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [phase, gazeRef])

  // Backup and complete trackers to avoid stale or double calibration corrections
  const originalCorrectionRef = useRef(null)
  const isCompletedRef = useRef(false)

  // Per-dot sample collection
  const currentSamplesRef = useRef([])
  // Accumulated calibration pairs: { id, observed: {x, y}, target: {x, y} }
  const calibrationPairsRef = useRef([])

  const triggerRecalibration = () => {
    // Reset all calibration states
    setCaptured(new Set())
    capturedRef.current = new Set()
    setProgress(0)
    setHoveredDotId(null)
    hoveredDotIdRef.current = null
    currentSamplesRef.current = []
    calibrationPairsRef.current = []
    setResultOverlay(null)
    setButtonDwellProgress(0)
    setButtonRetryDwellProgress(0)
    setButtonResetDwellProgress(0)
    setButtonSkipDwellProgress(0)
    btnDwellStartRef.current = null
    btnRetryDwellStartRef.current = null
    btnResetDwellStartRef.current = null
    btnSkipDwellStartRef.current = null
    smoothedGazeRef.current = null
    
    // Clear in-app correction from gazeAPI (so next calibration is also uncorrected raw)
    if (window.gazeAPI?.gazeCorrection) {
      window.gazeAPI.gazeCorrection.reset()
    }
    
    isCompletedRef.current = false
    setPhase('calibrating')
    console.log('[CalibrationScreen] Recalibration triggered.')
  }

  const handleResetAppCalibration = () => {
    // 1. Reset the active correction in Tobii bridge/API (the offset layer)
    if (window.gazeAPI?.gazeCorrection) {
      window.gazeAPI.gazeCorrection.reset()
    }
    // 2. Clear stored app settings calibration
    updateSetting('gazeCorrection', null)
    // 3. Clear original correction backup so it doesn't restore on unmount
    originalCorrectionRef.current = null
    // 4. Reset screen calibration state
    triggerRecalibration()

    playSuccessChime()
    speakText('App calibration has been reset.')
    console.log('[CalibrationScreen] App calibration reset completed.')
  }

  const captureDot = (dotId, observedX, observedY, isSimulated = false) => {
    const pt = CALIBRATION_POINTS.find(p => p.id === dotId)
    if (!pt) return

    // Calculate exact window-relative target coordinates rather than grid fractions
    const el = document.querySelector(`[data-point-id="${dotId}"]`)
    let targetX = pt.x
    let targetY = pt.y
    if (el) {
      const rect = el.getBoundingClientRect()
      targetX = (rect.left + rect.width / 2) / window.innerWidth
      targetY = (rect.top + rect.height / 2) / window.innerHeight
    }

    // If simulated (mouse click), observed is very close to target so it acts as perfect demo calibration
    const finalObservedX = isSimulated ? targetX + (Math.random() - 0.5) * 0.005 : observedX
    const finalObservedY = isSimulated ? targetY + (Math.random() - 0.5) * 0.005 : observedY

    calibrationPairsRef.current.push({
      id: dotId,
      observed: { x: finalObservedX, y: finalObservedY },
      target: { x: targetX, y: targetY },
    })

    const nextCaptured = new Set(capturedRef.current)
    nextCaptured.add(dotId)
    capturedRef.current = nextCaptured
    setCaptured(nextCaptured)

    hoveredDotIdRef.current = null
    setHoveredDotId(null)
    entryTimeRef.current = null
    setProgress(0)
    currentSamplesRef.current = []

    if (nextCaptured.size === CALIBRATION_POINTS.length) {
      // ── All dots captured — compute correction ─────────
      const engine = new GazeCalibrationEngine()
      engine.computeExplicitCorrection(calibrationPairsRef.current)
      const correctionData = engine.toJSON()
      
      // Only persist the correction if it was NOT a simulated/mouse test run!
      if (!isSimulated) {
        window.gazeAPI?.gazeCorrection?.set(correctionData)
      } else {
        // If simulated, clear any actual correction from memory so we don't mess up eye tracking
        window.gazeAPI?.gazeCorrection?.reset()
      }

      // Compute comparative metrics
      const improvementPoints = calibrationPairsRef.current.map(pair => {
        const { observed, target } = pair
        const rawDx = observed.x - target.x
        const rawDy = observed.y - target.y
        const rawErr = Math.sqrt(rawDx * rawDx + rawDy * rawDy)

        const corrected = engine.apply(observed.x, observed.y)
        const corrDx = corrected.x - target.x
        const corrDy = corrected.y - target.y
        const corrErr = Math.sqrt(corrDx * corrDx + corrDy * corrDy)

        return {
          target,
          observed,
          corrected,
          rawErr,
          corrErr
        }
      })

      const avgRawErr = improvementPoints.reduce((acc, cur) => acc + cur.rawErr, 0) / improvementPoints.length
      const avgCorrErr = improvementPoints.reduce((acc, cur) => acc + cur.corrErr, 0) / improvementPoints.length
      const reductionPct = avgRawErr > 0
        ? Math.max(0, Math.min(100, Math.round(((avgRawErr - avgCorrErr) / avgRawErr) * 100)))
        : 100

      const level = engine.getQualityLevel()

      isCompletedRef.current = true // Mark calibration complete so unmount doesn't restore backup

      // Play auditory feedback chime and announce complete
      playSuccessChime()
      speakText('Calibration complete. Look at the button to continue.')

      setResultOverlay({
        quality: engine.getQuality(),
        level,
        avgRawErr,
        avgCorrErr,
        reductionPct,
        points: improvementPoints,
        correctionData,
        isSimulated
      })

      setPhase('results')
    }
  }

  // Backup existing calibration on mount and clear so we perform calibration on pure raw coords
  useEffect(() => {
    let active = true
    if (window.gazeAPI?.gazeCorrection) {
      window.gazeAPI.gazeCorrection.get().then(corr => {
        if (active) {
          originalCorrectionRef.current = corr
          window.gazeAPI.gazeCorrection.reset()
          console.log('[CalibrationScreen] Backed up and cleared existing correction.')
        }
      })
    }

    return () => {
      active = false
      // If we unmount and did not complete, restore the original calibration
      if (!isCompletedRef.current && originalCorrectionRef.current && window.gazeAPI?.gazeCorrection) {
        window.gazeAPI.gazeCorrection.set(originalCorrectionRef.current)
        console.log('[CalibrationScreen] Restored original gaze correction on cancel/unmount.')
      }
    }
  }, [])

  // Subscribe directly to raw eye tracking data stream on mount
  useEffect(() => {
    if (typeof window === 'undefined' || !window.gazeAPI) return

    console.log('[CalibrationScreen] Subscribing directly to raw gaze stream...')
    window.gazeAPI.startStream((gp) => {
      if (gp && gp.x != null && gp.y != null && gp.valid !== false) {
        localGazeRef.current = { x: gp.x, y: gp.y }
        if (gazeRef) {
          gazeRef.current = { x: gp.x, y: gp.y, timestamp: gp.timestamp || Date.now() }
        }
      } else {
        localGazeRef.current = null
        if (gazeRef) {
          gazeRef.current = null
        }
      }
    })

    return () => {
      if (routerRef?.current) {
        console.log('[CalibrationScreen] Requesting parent router to reconnect...')
        routerRef.current.reconnect()
      } else {
        console.log('[CalibrationScreen] Stopping raw gaze stream direct subscription...')
        try {
          window.gazeAPI.stopStream()
        } catch (err) {
          console.error('[CalibrationScreen] Error stopping stream on unmount:', err)
        }
      }
    }
  }, [gazeRef, routerRef])

  // Keep resultOverlayRef synchronized to prevent stale closures in rAF loops
  useEffect(() => {
    resultOverlayRef.current = resultOverlay
  }, [resultOverlay])

  // ── If disabled, skip immediately ──────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      onComplete?.(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  if (!enabled) return null

  // ── Quality result labels ──────────────────────────────────────────
  const QUALITY_LABELS = {
    good: 'Good',
    fair: 'Fair',
    poor: 'Poor',
    learning: 'Fair',
  }

  const QUALITY_ICONS = {
    good: '✓',
    fair: '✓',
    poor: '⚠',
    learning: '✓',
  }

  // ── Main calibrating rAF gaze-dwell loop ───────────────────────────
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (phase !== 'calibrating') return

    function tick() {
      // Prioritize direct raw gaze from localGazeRef first, then fallback to passed gazeRef, and then mousePosRef
      const activeGaze = localGazeRef.current || gazeRef?.current
      const hasActiveStream = !!activeGaze
      const gazePos = activeGaze || mousePosRef.current
      const cursorEl = cursorRef.current

      if (!gazePos) {
        smoothedGazeRef.current = null // Reset smoothed coordinates on gaze loss
        if (cursorEl) {
          cursorEl.style.display = 'none'
        }
        if (hoveredDotIdRef.current !== null) {
          hoveredDotIdRef.current = null
          setHoveredDotId(null)
          entryTimeRef.current = null
          setProgress(0)
          currentSamplesRef.current = []
        }
        if (btnResetDwellStartRef.current !== null) {
          btnResetDwellStartRef.current = null
          setButtonResetDwellProgress(0)
        }
        if (btnSkipDwellStartRef.current !== null) {
          btnSkipDwellStartRef.current = null
          setButtonSkipDwellProgress(0)
        }
        frameRef.current = requestAnimationFrame(tick)
        return
      }
      const { x, y } = gazePos

      if (cursorEl) {
        const px = x * window.innerWidth
        const py = y * window.innerHeight
        cursorEl.style.transform = `translate(${px}px, ${py}px)`
        cursorEl.style.display = 'block'
      }

      if (caregiverTriggerRef.current) {
        // In caregiver trigger mode, the current highlighted dot is determined sequentially,
        // and we don't perform any automatic hover-based captures.
        frameRef.current = requestAnimationFrame(tick)
        return
      }

      // Convert normalized gaze coordinates to absolute screen pixels
      const gazeX_px = x * window.innerWidth
      const gazeY_px = y * window.innerHeight

      // Maintain smoothed gaze coordinates for stable button hover detection
      if (!smoothedGazeRef.current) {
        smoothedGazeRef.current = { x, y }
      } else {
        smoothedGazeRef.current.x = smoothedGazeRef.current.x * 0.85 + x * 0.15
        smoothedGazeRef.current.y = smoothedGazeRef.current.y * 0.85 + y * 0.15
      }

      const sgx = smoothedGazeRef.current.x * window.innerWidth
      const sgy = smoothedGazeRef.current.y * window.innerHeight

      const resetBtnEl = document.getElementById('btn-calibration-reset')
      const skipBtnEl = document.getElementById('btn-calibration-skip')

      let isResetHovered = false
      if (resetBtnEl) {
        const rect = resetBtnEl.getBoundingClientRect()
        const padding = 40
        isResetHovered = (
          sgx >= rect.left - padding &&
          sgx <= rect.right + padding &&
          sgy >= rect.top - padding &&
          sgy <= rect.bottom + padding
        )
      }

      let isSkipHovered = false
      if (skipBtnEl) {
        const rect = skipBtnEl.getBoundingClientRect()
        const padding = 40
        isSkipHovered = (
          sgx >= rect.left - padding &&
          sgx <= rect.right + padding &&
          sgy >= rect.top - padding &&
          sgy <= rect.bottom + padding
        )
      }

      // Resolve overlaps
      if (isResetHovered && isSkipHovered) {
        if (resetBtnEl && skipBtnEl) {
          const rectReset = resetBtnEl.getBoundingClientRect()
          const rectSkip = skipBtnEl.getBoundingClientRect()
          const distToReset = Math.abs(sgx - (rectReset.left + rectReset.width / 2))
          const distToSkip = Math.abs(sgx - (rectSkip.left + rectSkip.width / 2))
          if (distToReset < distToSkip) {
            isSkipHovered = false
          } else {
            isResetHovered = false
          }
        }
      }

      // Handle Reset Button Dwell
      if (isResetHovered) {
        if (btnResetDwellStartRef.current === null) {
          btnResetDwellStartRef.current = Date.now()
        }
        const dwellElapsed = Date.now() - btnResetDwellStartRef.current
        const dwellProg = Math.min(dwellElapsed / 1000, 1)
        setButtonResetDwellProgress(dwellProg)

        if (dwellElapsed >= 1000) {
          btnResetDwellStartRef.current = null
          setButtonResetDwellProgress(0)
          handleResetAppCalibration()
          frameRef.current = requestAnimationFrame(tick)
          return
        }
      } else {
        if (btnResetDwellStartRef.current !== null) {
          btnResetDwellStartRef.current = null
          setButtonResetDwellProgress(0)
        }
      }

      // Handle Skip Button Dwell
      if (isSkipHovered) {
        if (btnSkipDwellStartRef.current === null) {
          btnSkipDwellStartRef.current = Date.now()
        }
        const dwellElapsed = Date.now() - btnSkipDwellStartRef.current
        const dwellProg = Math.min(dwellElapsed / 1000, 1)
        setButtonSkipDwellProgress(dwellProg)

        if (dwellElapsed >= 1000) {
          btnSkipDwellStartRef.current = null
          setButtonSkipDwellProgress(0)
          playSuccessChime()
          if (originalCorrectionRef.current && window.gazeAPI?.gazeCorrection) {
            window.gazeAPI.gazeCorrection.set(originalCorrectionRef.current)
          }
          onComplete?.(null)
          return
        }
      } else {
        if (btnSkipDwellStartRef.current !== null) {
          btnSkipDwellStartRef.current = null
          setButtonSkipDwellProgress(0)
        }
      }

      // Skip checking calibration dots if user is dwelling/focusing on header buttons
      if (isResetHovered || isSkipHovered) {
        if (hoveredDotIdRef.current !== null) {
          hoveredDotIdRef.current = null
          setHoveredDotId(null)
          entryTimeRef.current = null
          setProgress(0)
          currentSamplesRef.current = []
        }
      } else {
        let foundHoveredDot = null
        for (const pt of CALIBRATION_POINTS) {
          if (capturedRef.current.has(pt.id)) continue

          const el = document.querySelector(`[data-point-id="${pt.id}"]`)
          if (!el) continue

          const rect = el.getBoundingClientRect()
          // Compute exact center of the dot element in screen pixels
          const targetX_px = rect.left + rect.width / 2
          const targetY_px = rect.top + rect.height / 2

          const dx = gazeX_px - targetX_px
          const dy = gazeY_px - targetY_px
          const dist = Math.sqrt(dx * dx + dy * dy)

          // Hit tolerance: exact dot radius + 120px padding for ease of use (increased for better alignment handling)
          const hitTolerance = rect.width / 2 + 120

          if (dist < hitTolerance) {
            foundHoveredDot = pt
            break
          }
        }

        if (foundHoveredDot) {
          if (hoveredDotIdRef.current !== foundHoveredDot.id) {
            // Entered a new dot — reset timer and samples
            hoveredDotIdRef.current = foundHoveredDot.id
            setHoveredDotId(foundHoveredDot.id)
            entryTimeRef.current = Date.now()
            setProgress(0)
            currentSamplesRef.current = []
          } else {
            // ONLY accumulate progress automatically if we have actual tracker stream data
            if (hasActiveStream) {
              const elapsed = Date.now() - entryTimeRef.current
              const currentProgress = Math.min(elapsed / CALIBRATION_DWELL_MS, 1)
              setProgress(currentProgress)

              // Collect gaze sample on every frame during dwell
              if (gazePos.x != null && gazePos.y != null) {
                currentSamplesRef.current.push({ x: gazePos.x, y: gazePos.y })
              }

              if (elapsed >= CALIBRATION_DWELL_MS) {
                // ── Dot captured ─────────────────────────────────────
                const samples = currentSamplesRef.current
                let meanX = foundHoveredDot.x
                let meanY = foundHoveredDot.y
                if (samples.length > 0) {
                  meanX = samples.reduce((s, p) => s + p.x, 0) / samples.length
                  meanY = samples.reduce((s, p) => s + p.y, 0) / samples.length
                }
                captureDot(foundHoveredDot.id, meanX, meanY, false)
              }
            } else {
              // Hovering with mouse fallback: no auto-dwell capture to avoid bad calibration correction
              setProgress(0)
            }
          }
        } else {
          if (hoveredDotIdRef.current !== null) {
            hoveredDotIdRef.current = null
            setHoveredDotId(null)
            entryTimeRef.current = null
            setProgress(0)
            currentSamplesRef.current = []
          }
        }
      }

      frameRef.current = requestAnimationFrame(tick)
    }

    frameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, onComplete])

  // ── Results phase rAF loop (Gaze Dwell Selection Only) ─────────────
  useEffect(() => {
    if (phase !== 'results') return

    let resultsFrameId = null

    function tickResults() {
      // Button Dwell selection logic (1.0s eye-gaze hover)
      // Prioritize direct raw gaze from localGazeRef first, then fallback to passed gazeRef, and then mousePosRef
      const gazePos = localGazeRef.current || gazeRef?.current || mousePosRef.current
      const btnEl = document.getElementById('btn-calibration-done')
      const retryBtnEl = document.getElementById('btn-calibration-retry')
      const cursorEl = cursorRef.current

      if (gazePos && gazePos.x != null) {
        // Apply exponential smoothing to coordinates to filter eye jitter
        if (!smoothedGazeRef.current) {
          smoothedGazeRef.current = { x: gazePos.x, y: gazePos.y }
        } else {
          smoothedGazeRef.current.x = smoothedGazeRef.current.x * 0.85 + gazePos.x * 0.15
          smoothedGazeRef.current.y = smoothedGazeRef.current.y * 0.85 + gazePos.y * 0.15
        }

        const gx = smoothedGazeRef.current.x * window.innerWidth
        const gy = smoothedGazeRef.current.y * window.innerHeight

        if (cursorEl) {
          cursorEl.style.transform = `translate(${gx}px, ${gy}px)`
          cursorEl.style.display = 'block'
        }

        // Check Continue Button (with 40px target expansion padding)
        let isContinueHovered = false
        if (btnEl) {
          const rect = btnEl.getBoundingClientRect()
          const padding = 40
          isContinueHovered = (
            gx >= rect.left - padding &&
            gx <= rect.right + padding &&
            gy >= rect.top - padding &&
            gy <= rect.bottom + padding
          )
        }

        // Check Recalibrate Button (with 40px target expansion padding)
        let isRetryHovered = false
        if (retryBtnEl) {
          const rect = retryBtnEl.getBoundingClientRect()
          const padding = 40
          isRetryHovered = (
            gx >= rect.left - padding &&
            gx <= rect.right + padding &&
            gy >= rect.top - padding &&
            gy <= rect.bottom + padding
          )
        }

        // Resolve overlap conflicts by prioritizing the closer button horizontally
        if (isContinueHovered && isRetryHovered) {
          if (btnEl && retryBtnEl) {
            const rectContinue = btnEl.getBoundingClientRect()
            const rectRetry = retryBtnEl.getBoundingClientRect()
            const distToContinue = Math.abs(gx - (rectContinue.left + rectContinue.width / 2))
            const distToRetry = Math.abs(gx - (rectRetry.left + rectRetry.width / 2))
            if (distToContinue < distToRetry) {
              isRetryHovered = false
            } else {
              isContinueHovered = false
            }
          }
        }

        // Handle Continue Button dwell
        if (isContinueHovered) {
          if (btnDwellStartRef.current === null) {
            btnDwellStartRef.current = Date.now()
          }
          const dwellElapsed = Date.now() - btnDwellStartRef.current
          const dwellProg = Math.min(dwellElapsed / 1000, 1)
          setButtonDwellProgress(dwellProg)

          if (dwellElapsed >= 1000) {
            playSuccessChime()
            onComplete?.(resultOverlayRef.current?.correctionData)
            return
          }
        } else {
          if (btnDwellStartRef.current !== null) {
            btnDwellStartRef.current = null
            setButtonDwellProgress(0)
          }
        }

        // Handle Recalibrate Button dwell
        if (isRetryHovered) {
          if (btnRetryDwellStartRef.current === null) {
            btnRetryDwellStartRef.current = Date.now()
          }
          const dwellElapsed = Date.now() - btnRetryDwellStartRef.current
          const dwellProg = Math.min(dwellElapsed / 1000, 1)
          setButtonRetryDwellProgress(dwellProg)

          if (dwellElapsed >= 1000) {
            playSuccessChime()
            triggerRecalibration()
            return
          }
        } else {
          if (btnRetryDwellStartRef.current !== null) {
            btnRetryDwellStartRef.current = null
            setButtonRetryDwellProgress(0)
          }
        }
      } else {
        smoothedGazeRef.current = null // Reset smoothed coordinates on gaze loss
        if (cursorEl) {
          cursorEl.style.display = 'none'
        }
        if (btnDwellStartRef.current !== null) {
          btnDwellStartRef.current = null
          setButtonDwellProgress(0)
        }
        if (btnRetryDwellStartRef.current !== null) {
          btnRetryDwellStartRef.current = null
          setButtonRetryDwellProgress(0)
        }
      }

      resultsFrameId = requestAnimationFrame(tickResults)
    }

    resultsFrameId = requestAnimationFrame(tickResults)
    return () => cancelAnimationFrame(resultsFrameId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, onComplete])

  const circumference = 2 * Math.PI * 20 // r=20

  return (
    <div className="calibration-screen">
      {/* Ocular feedback dot inside CalibrationScreen for zero-latency calibration visual cue */}
      <div
        ref={cursorRef}
        className="calibration-screen__gaze-cursor"
        aria-hidden="true"
      />

      {phase !== 'results' && (
        <div className="calibration-screen__header">
          <div className="calibration-screen__header-left">
            <h1 className="calibration-screen__title">GazeAAC Calibration</h1>
            <p className="calibration-screen__subtitle">
              {caregiverTrigger
                ? "Caregiver: Ask user to look at the highlighted dot and press Spacebar (or click it)"
                : "Look at each dot for a moment"}
            </p>
          </div>
          <div className="calibration-screen__header-right">
            <label className="calibration-screen__caregiver-toggle" title="Let a caregiver manually capture dots using Spacebar or click">
              <input
                type="checkbox"
                checked={caregiverTrigger}
                onChange={(e) => {
                  const val = e.target.checked
                  setCaregiverTrigger(val)
                  speakText(val ? "Caregiver trigger enabled. Press spacebar or click to capture." : "Automatic dwell capture enabled.")
                }}
              />
              <span className="calibration-screen__caregiver-toggle-text">Caregiver Mode</span>
            </label>
            <div className="calibration-screen__counter">
              {captured.size} / {CALIBRATION_POINTS.length} Captured
            </div>
            <button
              id="btn-calibration-reset"
              className="calibration-screen__reset-btn"
              onClick={handleResetAppCalibration}
              title="Reset all app calibration adjustments back to raw coordinates"
            >
              <div className="reset-btn__dwell-wrapper">
                <svg viewBox="0 0 36 36" className="reset-btn__dwell-svg">
                  <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255, 75, 75, 0.15)" strokeWidth="5" />
                  <circle 
                    cx="18" cy="18" r="15" 
                    fill="none" 
                    stroke="hsl(355, 85%, 65%)" 
                    strokeWidth="5" 
                    strokeDasharray={2 * Math.PI * 15}
                    strokeDashoffset={2 * Math.PI * 15 * (1 - buttonResetDwellProgress)}
                    strokeLinecap="round"
                    transform="rotate(-90 18 18)"
                    className="reset-btn__dwell-path"
                  />
                </svg>
              </div>
              <span className="reset-btn__text">
                {buttonResetDwellProgress > 0 ? "Dwelling to Reset..." : "Reset Calibration"}
              </span>
            </button>
            <button
              id="btn-calibration-skip"
              className="calibration-screen__skip-btn"
              onClick={() => {
                // Restore original calibration if skipped
                if (originalCorrectionRef.current && window.gazeAPI?.gazeCorrection) {
                  window.gazeAPI.gazeCorrection.set(originalCorrectionRef.current)
                }
                onComplete?.(null)
              }}
              title="Skip calibration and open the communication board"
            >
              <div className="skip-btn__dwell-wrapper">
                <svg viewBox="0 0 36 36" className="skip-btn__dwell-svg">
                  <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255, 255, 255, 0.2)" strokeWidth="5" />
                  <circle 
                    cx="18" cy="18" r="15" 
                    fill="none" 
                    stroke="#ffffff" 
                    strokeWidth="5" 
                    strokeDasharray={2 * Math.PI * 15}
                    strokeDashoffset={2 * Math.PI * 15 * (1 - buttonSkipDwellProgress)}
                    strokeLinecap="round"
                    transform="rotate(-90 18 18)"
                    className="skip-btn__dwell-path"
                  />
                </svg>
              </div>
              <span className="skip-btn__text">
                {buttonSkipDwellProgress > 0 ? "Dwelling to Skip..." : "Skip Calibration"}
              </span>
            </button>
          </div>
        </div>
      )}

      <div className="calibration-screen__grid">
        {/* Visual Improvement Results Overlay */}
        {phase === 'results' && resultOverlay && (
          <div className="calibration-results-overlay">
            <div className="calibration-results-card">
              <div className="calibration-results-card__header">
                <div className="calibration-results-card__success-badge">
                  <span className="calibration-results-card__success-icon">✨</span>
                  Calibration Successful
                </div>
                <h2 className="calibration-results-card__title">Gaze Accuracy Improved</h2>
                <p className="calibration-results-card__subtitle">
                  We've successfully calculated a precision correction layer to reduce tracking drift.
                </p>
              </div>

              <div className="calibration-results-card__body">
                {/* Left Panel: Performance Metrics */}
                <div className="calibration-results-card__panel calibration-results-card__panel--metrics">
                  <div className="calibration-results-card__improvement-circle-wrapper">
                    <div className="calibration-results-card__improvement-circle">
                      <svg viewBox="0 0 100 100" className="calibration-results-card__circle-svg">
                        <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255, 255, 255, 0.05)" strokeWidth="6" />
                        <circle cx="50" cy="50" r="42" fill="none" stroke="var(--color-success)" strokeWidth="6"
                          strokeDasharray={2 * Math.PI * 42}
                          strokeDashoffset={2 * Math.PI * 42 * (1 - resultOverlay.reductionPct / 100)}
                          strokeLinecap="round"
                          transform="rotate(-90 50 50)"
                          className="calibration-results-card__circle-path"
                        />
                      </svg>
                      <div className="calibration-results-card__circle-content">
                        <span className="calibration-results-card__improvement-val">{resultOverlay.reductionPct}%</span>
                        <span className="calibration-results-card__improvement-lbl">Error Reduction</span>
                      </div>
                    </div>
                  </div>

                  <div className="calibration-results-card__bars">
                    <div className="calibration-results-card__bar-item">
                      <div className="calibration-results-card__bar-info">
                        <span className="calibration-results-card__bar-lbl">Uncorrected Error</span>
                        <span className="calibration-results-card__bar-val">{(resultOverlay.avgRawErr * 100).toFixed(1)}%</span>
                      </div>
                      <div className="calibration-results-card__bar-track">
                        <div className="calibration-results-card__bar-fill calibration-results-card__bar-fill--raw" 
                             style={{ width: `${Math.min(100, (resultOverlay.avgRawErr / 0.10) * 100)}%` }} />
                      </div>
                    </div>

                    <div className="calibration-results-card__bar-item">
                      <div className="calibration-results-card__bar-info">
                        <span className="calibration-results-card__bar-lbl">Corrected Error</span>
                        <span className="calibration-results-card__bar-val" style={{ color: 'var(--color-success)' }}>
                          {(resultOverlay.avgCorrErr * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="calibration-results-card__bar-track">
                        <div className="calibration-results-card__bar-fill calibration-results-card__bar-fill--corrected" 
                             style={{ width: `${Math.min(100, (resultOverlay.avgCorrErr / 0.10) * 100)}%` }} />
                      </div>
                    </div>
                  </div>

                  <div className="calibration-results-card__quality-badge">
                    Accuracy Quality: <span className={`quality-badge-text quality-badge-text--${resultOverlay.level}`}>{QUALITY_LABELS[resultOverlay.level] || 'Good'}</span>
                  </div>
                </div>

                {/* Right Panel: Accuracy Map */}
                <div className="calibration-results-card__panel calibration-results-card__panel--map">
                  <div className="calibration-results-card__map-title">Precision Mapping</div>
                  <div className="calibration-results-card__map-container">
                    <svg viewBox="0 0 300 180" className="calibration-results-card__map-svg">
                      {/* Screen Grid background lines */}
                      <line x1="0" y1="90" x2="300" y2="90" stroke="rgba(255,255,255,0.04)" strokeWidth="1" strokeDasharray="5,5" />
                      <line x1="150" y1="0" x2="150" y2="180" stroke="rgba(255,255,255,0.04)" strokeWidth="1" strokeDasharray="5,5" />
                      
                      {/* Draw error segment connectors */}
                      {resultOverlay.points.map((pt, idx) => {
                        const cx = pt.target.x * 300
                        const cy = pt.target.y * 180
                        const rx = pt.observed.x * 300
                        const ry = pt.observed.y * 180
                        const cxCorr = pt.corrected.x * 300
                        const cyCorr = pt.corrected.y * 180

                        return (
                          <g key={`lines-${idx}`}>
                            {/* Raw drift error line (dashed red) */}
                            <line 
                              x1={rx} y1={ry} 
                              x2={cx} y2={cy} 
                              stroke="hsl(350, 70%, 65%)" 
                              strokeWidth="1.5" 
                              strokeDasharray="3,3" 
                              opacity="0.85" 
                            />
                            {/* Corrected drift error line (solid green) */}
                            <line 
                              x1={cxCorr} y1={cyCorr} 
                              x2={cx} y2={cy} 
                              stroke="var(--color-success)" 
                              strokeWidth="2" 
                              opacity="0.9"
                            />
                          </g>
                        )
                      })}

                      {/* Draw coordinate indicators */}
                      {resultOverlay.points.map((pt, idx) => {
                        const cx = pt.target.x * 300
                        const cy = pt.target.y * 180
                        const rx = pt.observed.x * 300
                        const ry = pt.observed.y * 180
                        const cxCorr = pt.corrected.x * 300
                        const cyCorr = pt.corrected.y * 180

                        return (
                          <g key={`dots-${idx}`}>
                            {/* Raw gaze coordinate */}
                            <circle 
                              cx={rx} cy={ry} 
                              r="5" 
                              fill="hsl(350, 70%, 65%)" 
                              opacity="0.95"
                            />
                            {/* Corrected gaze coordinate */}
                            <circle 
                              cx={cxCorr} cy={cyCorr} 
                              r="6" 
                              fill="var(--color-success)" 
                              className="map-svg-corrected-dot"
                            />
                            {/* Target Coordinate Anchor */}
                            <circle 
                              cx={cx} cy={cy} 
                              r="3.5" 
                              fill="#ffffff" 
                              stroke="rgba(0,0,0,0.6)" 
                              strokeWidth="1"
                            />
                          </g>
                        )
                      })}
                    </svg>
                    
                    <div className="calibration-results-card__map-legend">
                      <div className="legend-item"><span className="legend-dot legend-dot--target"></span> Target</div>
                      <div className="legend-item"><span className="legend-dot legend-dot--raw"></span> Raw Gaze</div>
                      <div className="legend-item"><span className="legend-dot legend-dot--corrected"></span> Corrected</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Action area with Dwell and Recalibrate */}
              <div className="calibration-results-card__footer">
                <button
                  id="btn-calibration-retry"
                  className="calibration-results__recalibrate-btn"
                  onClick={() => {
                    playSuccessChime()
                    triggerRecalibration()
                  }}
                  title="Hover or click to reset and try calibrating again"
                >
                  <div className="recalibrate-btn__dwell-wrapper">
                    <svg viewBox="0 0 36 36" className="recalibrate-btn__dwell-svg">
                      <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="5" />
                      <circle 
                        cx="18" cy="18" r="15" 
                        fill="none" 
                        stroke="hsl(195, 100%, 60%)" 
                        strokeWidth="5" 
                        strokeDasharray={2 * Math.PI * 15}
                        strokeDashoffset={2 * Math.PI * 15 * (1 - buttonRetryDwellProgress)}
                        strokeLinecap="round"
                        transform="rotate(-90 18 18)"
                        className="recalibrate-btn__dwell-path"
                      />
                    </svg>
                  </div>
                  <span className="recalibrate-btn__text">
                    {buttonRetryDwellProgress > 0 ? "Dwelling to Recalibrate..." : "Recalibrate"}
                  </span>
                </button>

                <button
                  id="btn-calibration-done"
                  className="calibration-results__continue-btn"
                  onClick={() => {
                    playSuccessChime()
                    onComplete?.(resultOverlay.correctionData)
                  }}
                  title="Hover or click to continue to the main board"
                >
                  <div className="continue-btn__dwell-wrapper">
                    <svg viewBox="0 0 36 36" className="continue-btn__dwell-svg">
                      <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth="5" />
                      <circle 
                        cx="18" cy="18" r="15" 
                        fill="none" 
                        stroke="#ffffff" 
                        strokeWidth="5" 
                        strokeDasharray={2 * Math.PI * 15}
                        strokeDashoffset={2 * Math.PI * 15 * (1 - buttonDwellProgress)}
                        strokeLinecap="round"
                        transform="rotate(-90 18 18)"
                        className="continue-btn__dwell-path"
                      />
                    </svg>
                  </div>
                  <span className="continue-btn__text">
                    {buttonDwellProgress > 0 ? "Dwelling to Continue..." : "Continue to GazeAAC"}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}

        {phase !== 'results' && CALIBRATION_POINTS.map((pt) => {
          const isCaptured = captured.has(pt.id)
          const uncaptured = CALIBRATION_POINTS.filter(p => !captured.has(p.id))
          const currentTarget = uncaptured[0]
          const isCurrent  = caregiverTrigger ? (currentTarget && pt.id === currentTarget.id) : (pt.id === hoveredDotId)
          const ptProgress = isCurrent ? progress : 0
          const dashOffset = circumference * (1 - ptProgress)

          return (
            <div
              key={pt.id}
              onClick={() => {
                if (caregiverTrigger && !isCaptured) {
                  // Capture immediately on click
                  const activeGaze = localGazeRef.current || gazeRef?.current || mousePosRef.current
                  const finalX = activeGaze ? activeGaze.x : pt.x
                  const finalY = activeGaze ? activeGaze.y : pt.y
                  captureDot(pt.id, finalX, finalY, false)
                }
              }}
              className={[
                'calibration-dot',
                isCaptured ? 'calibration-dot--captured' : '',
                isCurrent  ? 'calibration-dot--active'   : '',
                caregiverTrigger && !isCaptured ? 'calibration-dot--clickable' : ''
              ].join(' ').trim()}
              data-point-id={pt.id}
              style={{ 
                left: `${pt.x * 100}%`, 
                top: `${pt.y * 100}%`, 
                cursor: caregiverTrigger && !isCaptured ? 'pointer' : 'default' 
              }}
            >
              <svg viewBox="0 0 60 60" className="calibration-dot__svg">
                {/* Track */}
                <circle cx="30" cy="30" r="20" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
                {/* Progress */}
                {isCurrent && !caregiverTrigger && (
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
    </div>
  )
}

