import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import './GazeAccuracyTest.css'

// ─── 5-Point test grid (corners + centre) ────────────────────────────────────
// Positions expressed as fractions of viewport [0–1], with safe margin inset
const MARGIN = 0.05  // keep targets away from edges so they're fully visible
const TEST_POINTS = [
  { id: 'top-left',     label: 'Top Left',     nx: MARGIN,        ny: MARGIN        },
  { id: 'top-right',    label: 'Top Right',    nx: 1 - MARGIN,    ny: MARGIN        },
  { id: 'centre',       label: 'Centre',       nx: 0.5,           ny: 0.5           },
  { id: 'bottom-left',  label: 'Bottom Left',  nx: MARGIN,        ny: 1 - MARGIN    },
  { id: 'bottom-right', label: 'Bottom Right', nx: 1 - MARGIN,    ny: 1 - MARGIN    },
]

const DWELL_MS        = 1200   // ms to dwell on each target to capture it
const SAMPLE_WINDOW   = 600    // ms of samples to average for offset calculation
const TARGET_RADIUS   = 11     // px — 25% of original size for improved accuracy
const HIT_RADIUS      = 80     // px — generous hit zone

// ─── Scoring thresholds (normalised to screen width) ─────────────────────────
const TIERS = [
  { id: 'excellent', label: 'Excellent',         emoji: '🌟', color: '#22c55e', maxNorm: 0.025 },
  { id: 'good',      label: 'Good',              emoji: '✅', color: '#84cc16', maxNorm: 0.050 },
  { id: 'fair',      label: 'Fair',              emoji: '⚠️', color: '#f59e0b', maxNorm: 0.080 },
  { id: 'poor',      label: 'Needs Recalibration', emoji: '🔴', color: '#ef4444', maxNorm: Infinity },
]

function getTier(normOffset) {
  return TIERS.find(t => normOffset <= t.maxNorm) ?? TIERS[TIERS.length - 1]
}

// Star count for rating (1–5 based on tier)
function getStars(tier) {
  switch (tier.id) {
    case 'excellent': return 5
    case 'good':      return 4
    case 'fair':      return 2
    default:          return 1
  }
}

// Commentary aimed at the caregiver
const COMMENTARY = {
  excellent: 'The eye tracker is mapping gaze very accurately across the whole screen. This level of accuracy is great for AAC communication.',
  good:      'The eye tracker is tracking well. Small positional offsets are normal and should not affect everyday AAC use.',
  fair:      'There is some drift in gaze tracking. Check positioning and lighting, then try recalibrating the eye tracker.',
  poor:      'Gaze accuracy is low. Please recalibrate the eye tracker device and ensure the learner is seated correctly and comfortably.',
}

// ─── Web Audio tone reward ────────────────────────────────────────────────────
function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12)
    gain.gain.setValueAtTime(0.25, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.4)
    osc.onended = () => ctx.close()
  } catch (_) { /* audio not available */ }
}

function speak(text) {
  window.gazeAPI?.speak(text) || window.speechSynthesis?.speak(Object.assign(new SpeechSynthesisUtterance(text), { rate: 0.9 }))
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main component
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GazeAccuracyTest
 *
 * Props:
 *   open         boolean        — Whether the overlay is visible
 *   onClose      () => void     — Called when the test ends / is dismissed
 *   gazeRef      React.RefObject<{x,y}|null>  — Live normalised gaze position
 *   dwellMs      number         — Override default dwell threshold
 */
export function GazeAccuracyTest({ open, onClose, gazeRef, dwellMs = DWELL_MS }) {
  const [phase, setPhase]         = useState('intro')   // 'intro' | 'testing' | 'results'
  const [activeIdx, setActiveIdx] = useState(0)
  const [progress, setProgress]   = useState(0)         // 0→1 for active target ring
  const [captured, setCaptured]   = useState([])        // array of { id, offset_norm }
  const [dimmed, setDimmed]       = useState(false)     // flash dimming on capture

  const entryTimeRef    = useRef(null)
  const samplesRef      = useRef([])   // gaze samples while dwelling
  const frameRef        = useRef(null)

  // Reset everything when the overlay opens
  useEffect(() => {
    if (!open) return
    setPhase('intro')
    setActiveIdx(0)
    setProgress(0)
    setCaptured([])
    setDimmed(false)
    entryTimeRef.current = null
    samplesRef.current   = []
    cancelAnimationFrame(frameRef.current)
  }, [open])

  // ── rAF loop — only runs during 'testing' phase ──────────────────────────
  useEffect(() => {
    if (phase !== 'testing') return

    const pt = TEST_POINTS[activeIdx]
    if (!pt) return

    const targetPx = {
      x: pt.nx * window.innerWidth,
      y: pt.ny * window.innerHeight,
    }

    function tick() {
      const gaze = gazeRef?.current
      if (!gaze || gaze.x == null) {
        frameRef.current = requestAnimationFrame(tick)
        return
      }

      const gx = gaze.x * window.innerWidth
      const gy = gaze.y * window.innerHeight
      const dx = gx - targetPx.x
      const dy = gy - targetPx.y
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist < HIT_RADIUS) {
        if (entryTimeRef.current === null) {
          entryTimeRef.current = Date.now()
          samplesRef.current   = []
        }
        const elapsed = Date.now() - entryTimeRef.current
        const prog = Math.min(elapsed / dwellMs, 1)
        setProgress(prog)

        // Collect samples in the SAMPLE_WINDOW before capture for offset calc
        if (elapsed >= dwellMs - SAMPLE_WINDOW) {
          samplesRef.current.push({ x: gaze.x, y: gaze.y })
        }

        if (elapsed >= dwellMs) {
          // Compute mean gaze position over samples
          const samps = samplesRef.current
          const meanX = samps.reduce((s, p) => s + p.x, 0) / (samps.length || 1)
          const meanY = samps.reduce((s, p) => s + p.y, 0) / (samps.length || 1)
          const offDx = (meanX - pt.nx) * window.innerWidth
          const offDy = (meanY - pt.ny) * window.innerHeight
          const offset_norm = Math.sqrt(offDx * offDx + offDy * offDy) / window.innerWidth

          // Capture!
          playChime()
          speak(activeIdx === TEST_POINTS.length - 1 ? 'All done! Well done!' : 'Great job!')
          setDimmed(true)
          setTimeout(() => setDimmed(false), 200)

          setCaptured(prev => [...prev, { id: pt.id, label: pt.label, nx: pt.nx, ny: pt.ny, offset_norm, meanX, meanY }])
          entryTimeRef.current = null
          samplesRef.current   = []
          setProgress(0)

          if (activeIdx < TEST_POINTS.length - 1) {
            setActiveIdx(prev => prev + 1)
          } else {
            setPhase('results')
          }
          return
        }
      } else {
        entryTimeRef.current = null
        samplesRef.current   = []
        setProgress(0)
      }

      frameRef.current = requestAnimationFrame(tick)
    }

    frameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, activeIdx, dwellMs])

  // Speak instruction when a new target becomes active
  useEffect(() => {
    if (phase !== 'testing') return
    const pt = TEST_POINTS[activeIdx]
    if (!pt) return
    const num = activeIdx + 1
    speak(`Target ${num} of ${TEST_POINTS.length}. Look at the star in the ${pt.label}.`)
  }, [phase, activeIdx])

  const handleStart = useCallback(() => {
    speak('Look at each star when it lights up. Hold your gaze until you hear the chime.')
    setTimeout(() => {
      speak('Starting now.')
      setPhase('testing')
    }, 3000)
  }, [])

  if (!open) return null

  // ── Score calculation ─────────────────────────────────────────────────────
  const meanOffset = captured.length > 0
    ? captured.reduce((s, c) => s + c.offset_norm, 0) / captured.length
    : null
  const tier = meanOffset !== null ? getTier(meanOffset) : null
  const stars = tier ? getStars(tier) : 0

  const modal = (
    <div className="gat__backdrop" role="dialog" aria-modal="true" aria-label="Gaze Accuracy Test">
      {/* ── Flash dim overlay on capture ──────────────────────────────── */}
      <div className={`gat__capture-flash ${dimmed ? 'gat__capture-flash--active' : ''}`} />

      {/* ── INTRO ─────────────────────────────────────────────────────── */}
      {phase === 'intro' && (
        <div className="gat__screen gat__screen--intro">
          <div className="gat__intro-eye">👁</div>
          <h1 className="gat__intro-title">Gaze Accuracy Test</h1>
          <p className="gat__intro-desc">
            We'll show you <strong>5 stars</strong> one at a time.<br />
            <strong>Look at each star</strong> and hold your gaze until you hear a chime.
          </p>
          <div className="gat__intro-diagram">
            {TEST_POINTS.map(pt => (
              <div
                key={pt.id}
                className="gat__intro-dot"
                style={{ left: `${pt.nx * 100}%`, top: `${pt.ny * 100}%` }}
              />
            ))}
          </div>
          <div className="gat__intro-points-label">5 targets · ~60 seconds</div>
          <button id="btn-gat-start" className="gat__btn gat__btn--primary" onClick={handleStart}>
            ▶ Start Test
          </button>
          <button id="btn-gat-cancel-intro" className="gat__btn gat__btn--ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      )}

      {/* ── TESTING ───────────────────────────────────────────────────── */}
      {phase === 'testing' && (
        <>
          {/* Progress bar along top */}
          <div className="gat__progress-bar">
            <div
              className="gat__progress-bar__fill"
              style={{ width: `${(captured.length / TEST_POINTS.length) * 100}%` }}
            />
          </div>

          {/* Counter */}
          <div className="gat__counter">
            {captured.length + 1} / {TEST_POINTS.length}
          </div>

          {/* Cancel */}
          <button id="btn-gat-cancel-test" className="gat__cancel-btn" onClick={onClose}>✕ Stop</button>

          {/* Captured confirmation dots (minimap) */}
          <div className="gat__minimap">
            {TEST_POINTS.map((pt, i) => (
              <div
                key={pt.id}
                className={[
                  'gat__minimap-dot',
                  i < captured.length ? 'gat__minimap-dot--done' : '',
                  i === activeIdx ? 'gat__minimap-dot--active' : '',
                ].join(' ')}
              />
            ))}
          </div>

          {/* Animated targets */}
          {TEST_POINTS.map((pt, idx) => {
            const isCurrent  = idx === activeIdx
            const isDone     = idx < captured.length
            const circumference = 2 * Math.PI * (TARGET_RADIUS - 5)
            const dashOffset = isCurrent ? circumference * (1 - progress) : circumference

            return (
              <div
                key={pt.id}
                className={[
                  'gat__target',
                  isCurrent ? 'gat__target--active' : '',
                  isDone    ? 'gat__target--done'   : '',
                  !isCurrent && !isDone ? 'gat__target--waiting' : '',
                ].join(' ')}
                style={{
                  left: `${pt.nx * 100}%`,
                  top:  `${pt.ny * 100}%`,
                  width:  TARGET_RADIUS * 2,
                  height: TARGET_RADIUS * 2,
                }}
                aria-label={isCurrent ? `Look here: ${pt.label}` : undefined}
              >
                <svg
                  viewBox={`0 0 ${TARGET_RADIUS * 2} ${TARGET_RADIUS * 2}`}
                  className="gat__target-svg"
                  overflow="visible"
                >
                  {/* Outer pulse ring (active only) */}
                  {isCurrent && (
                    <circle
                      cx={TARGET_RADIUS} cy={TARGET_RADIUS}
                      r={TARGET_RADIUS + 8}
                      fill="none"
                      stroke="rgba(255,255,255,0.18)"
                      strokeWidth="3"
                      className="gat__target-pulse"
                    />
                  )}
                  {/* Progress track */}
                  <circle
                    cx={TARGET_RADIUS} cy={TARGET_RADIUS}
                    r={TARGET_RADIUS - 5}
                    fill="none"
                    stroke="rgba(255,255,255,0.12)"
                    strokeWidth="5"
                  />
                  {/* Progress arc */}
                  {(isCurrent || isDone) && (
                    <circle
                      cx={TARGET_RADIUS} cy={TARGET_RADIUS}
                      r={TARGET_RADIUS - 5}
                      fill="none"
                      stroke={isDone ? '#22c55e' : 'var(--gat-accent)'}
                      strokeWidth="5"
                      strokeDasharray={circumference}
                      strokeDashoffset={isDone ? 0 : dashOffset}
                      strokeLinecap="round"
                      transform={`rotate(-90 ${TARGET_RADIUS} ${TARGET_RADIUS})`}
                      style={{ transition: isDone ? 'none' : 'stroke-dashoffset 0.05s linear' }}
                    />
                  )}
                  {/* Centre glyph */}
                  <text
                    x={TARGET_RADIUS} y={TARGET_RADIUS}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={isCurrent ? TARGET_RADIUS * 0.9 : TARGET_RADIUS * 0.7}
                    className="gat__target-emoji"
                    style={{ transition: 'font-size 0.2s ease' }}
                  >
                    {isDone ? '✓' : isCurrent ? '⭐' : '·'}
                  </text>
                </svg>
              </div>
            )
          })}

          {/* Label beneath active target */}
          {(() => {
            const pt = TEST_POINTS[activeIdx]
            return (
              <div
                className="gat__target-label"
                style={{
                  left: `${pt.nx * 100}%`,
                  top:  `calc(${pt.ny * 100}% + ${TARGET_RADIUS + 14}px)`,
                }}
              >
                {pt.label}
              </div>
            )
          })()}
        </>
      )}

      {/* ── RESULTS ───────────────────────────────────────────────────── */}
      {phase === 'results' && tier && (
        <div className="gat__screen gat__screen--results">
          {/* Header */}
          <div className="gat__results-header" style={{ '--gat-tier-color': tier.color }}>
            <div className="gat__results-emoji">{tier.emoji}</div>
            <h1 className="gat__results-title">{tier.label}</h1>
            <div className="gat__results-stars">
              {[1,2,3,4,5].map(n => (
                <span key={n} className={`gat__star ${n <= stars ? 'gat__star--lit' : ''}`}>⭐</span>
              ))}
            </div>
            <div className="gat__results-score">
              Mean offset: <strong>{(meanOffset * 100).toFixed(1)}% of screen width</strong>
            </div>
          </div>

          {/* Per-point breakdown */}
          <div className="gat__results-breakdown">
            <h2 className="gat__results-breakdown-title">Per-Target Results</h2>
            <div className="gat__results-grid">
              {/* Miniature screen diagram */}
              <div className="gat__results-diagram">
                {captured.map((c, i) => {
                  const ptTier = getTier(c.offset_norm)
                  return (
                    <div key={c.id}>
                      {/* Target dot */}
                      <div
                        className="gat__results-diagram-target"
                        style={{ left: `${c.nx * 100}%`, top: `${c.ny * 100}%` }}
                        title={`Target: ${c.label}`}
                      />
                      {/* Mean gaze dot */}
                      <div
                        className="gat__results-diagram-gaze"
                        style={{
                          left: `${c.meanX * 100}%`,
                          top:  `${c.meanY * 100}%`,
                          background: ptTier.color,
                        }}
                        title={`Measured gaze: ${(c.offset_norm * 100).toFixed(1)}%`}
                      />
                      {/* Connector line drawn via CSS custom properties */}
                    </div>
                  )
                })}
              </div>

              {/* Score table */}
              <div className="gat__results-table">
                {captured.map((c, i) => {
                  const ptTier = getTier(c.offset_norm)
                  return (
                    <div key={c.id} className="gat__results-row">
                      <span className="gat__results-row__num">{i + 1}</span>
                      <span className="gat__results-row__label">{c.label}</span>
                      <span className="gat__results-row__bar-wrap">
                        <span
                          className="gat__results-row__bar"
                          style={{
                            width: `${Math.min(c.offset_norm / 0.10, 1) * 100}%`,
                            background: ptTier.color,
                          }}
                        />
                      </span>
                      <span className="gat__results-row__val" style={{ color: ptTier.color }}>
                        {(c.offset_norm * 100).toFixed(1)}%
                      </span>
                      <span className="gat__results-row__tier">{ptTier.emoji}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Commentary */}
          <div className="gat__results-commentary" style={{ borderColor: tier.color }}>
            <span className="gat__results-commentary__icon">💬</span>
            <p>{COMMENTARY[tier.id]}</p>
          </div>

          {/* Actions */}
          <div className="gat__results-actions">
            <button
              id="btn-gat-retry"
              className="gat__btn gat__btn--outline"
              onClick={() => {
                setPhase('intro')
                setActiveIdx(0)
                setProgress(0)
                setCaptured([])
              }}
            >
              🔄 Try Again
            </button>
            <button id="btn-gat-done" className="gat__btn gat__btn--primary" onClick={onClose}>
              ✓ Done
            </button>
          </div>
        </div>
      )}
    </div>
  )

  return createPortal(modal, document.body)
}
