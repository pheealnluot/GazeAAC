import { useState, useEffect, useRef, forwardRef } from 'react'
import { useGazeSettings } from '@context/GazeSettingsContext'
import './HomeLanding.css'

/**
 * HomeLanding — Post-calibration mode selection screen.
 *
 * Presents two large gaze-dwell tiles:
 *   1. AAC  — enters the main communication board
 *   2. Movie Time — enters the YouTube-powered movie experience
 *
 * Gaze dwell is handled by a lightweight polling loop that wraps
 * window.gazeAPI.startStream (same API as the TelemetryRouter, but
 * without routing overhead). Mouse-hover mode is also supported.
 */
export function HomeLanding({ onSelectAAC, onSelectMovie, onSelectGames, onOpenSettings, gazeCursorRef, registerHitTargets, gazeState, onDwellRef }) {
  const { settings } = useGazeSettings()
  const [showGearPopover, setShowGearPopover] = useState(false)

  const dwellMs = settings.dwellMs ?? 800

  // Derive gaze target and dwell progress from the unified TelemetryRouter
  const gazeTarget = gazeState?.cellId ?? null
  const dwellProgress = gazeState?.dwellProgress ?? 0

  // ── Register hit targets with the unified TelemetryRouter ──────────────
  const aacRef = useRef(null)
  const movieRef = useRef(null)
  const gamesRef = useRef(null)

  useEffect(() => {
    // Delay measurement to ensure DOM is rendered
    const frame = requestAnimationFrame(() => {
      const cells = []
      const vw = window.innerWidth
      const vh = window.innerHeight
      for (const [id, ref] of [['aac', aacRef], ['movie', movieRef], ['games', gamesRef]]) {
        const el = ref.current
        if (!el) continue
        const r = el.getBoundingClientRect()
        cells.push({ id, x0: r.left / vw, y0: r.top / vh, x1: r.right / vw, y1: r.bottom / vh })
      }
      registerHitTargets?.(cells)
    })
    return () => cancelAnimationFrame(frame)
  }, [registerHitTargets])

  // Re-register on window resize
  useEffect(() => {
    const remeasure = () => {
      const cells = []
      const vw = window.innerWidth
      const vh = window.innerHeight
      for (const [id, ref] of [['aac', aacRef], ['movie', movieRef], ['games', gamesRef]]) {
        const el = ref.current
        if (!el) continue
        const r = el.getBoundingClientRect()
        cells.push({ id, x0: r.left / vw, y0: r.top / vh, x1: r.right / vw, y1: r.bottom / vh })
      }
      registerHitTargets?.(cells)
    }
    window.addEventListener('resize', remeasure)
    return () => window.removeEventListener('resize', remeasure)
  }, [registerHitTargets])

  // ── Wire dwell activation into the unified router ──────────────────────
  useEffect(() => {
    if (!onDwellRef) return
    onDwellRef.current = (cellId) => {
      if (cellId === 'aac') onSelectAAC()
      if (cellId === 'movie') onSelectMovie()
      if (cellId === 'games') onSelectGames?.()
    }
    return () => { if (onDwellRef) onDwellRef.current = null }
  }, [onDwellRef, onSelectAAC, onSelectMovie, onSelectGames])

  // ── Dwell ring geometry (perimeter of the tile, approximated as ellipse) ──
  // We use a bottom progress bar instead of a full ring for the tiles (simpler
  // to compute without knowing tile dimensions). The ring SVG is inset at
  // the tile border for a premium look.

  // Derive user's name for greeting (if available)
  const [userName, setUserName] = useState('')
  useEffect(() => {
    window.gazeAPI?.userProfile?.get?.().then(p => {
      if (p?.name) setUserName(p.name)
    }).catch(() => {})
  }, [])

  const greeting = userName ? `Hello, ${userName}! 👋` : 'Welcome Back! 👋'

  const getProgress = (id) => (gazeTarget === id ? dwellProgress : 0)

  return (
    <div className="home-landing" role="main" aria-label="Mode selection">
      {/* Animated background */}
      <div className="home-landing__bg" aria-hidden="true" />
      <div className="home-landing__orb home-landing__orb--1" aria-hidden="true" />
      <div className="home-landing__orb home-landing__orb--2" aria-hidden="true" />
      <div className="home-landing__orb home-landing__orb--3" aria-hidden="true" />

      {/* Floating settings gear — top-right corner */}
      {onOpenSettings && (
        <div className="home-landing__gear-wrap">
          <button
            id="home-settings-btn"
            className="home-landing__gear-btn"
            aria-label="Open settings"
            title="Settings"
            onClick={() => setShowGearPopover(v => !v)}
          >⚙</button>

          {showGearPopover && (
            <div
              className="home-landing__gear-popover"
              role="menu"
              onMouseLeave={() => setShowGearPopover(false)}
            >
              <button
                className="home-landing__gear-popover-item"
                role="menuitem"
                onClick={() => { onOpenSettings('eye'); setShowGearPopover(false) }}
              >
                👁 Eye Tracker Settings
              </button>
              <button
                className="home-landing__gear-popover-item"
                role="menuitem"
                onClick={() => { onOpenSettings('aac'); setShowGearPopover(false) }}
              >
                🗣 AAC Settings
              </button>
              <button
                className="home-landing__gear-popover-item"
                role="menuitem"
                onClick={() => { onOpenSettings('contextual'); setShowGearPopover(false) }}
              >
                🧠 Contextual Response Settings
              </button>
              <button
                className="home-landing__gear-popover-item"
                role="menuitem"
                onClick={() => { onOpenSettings('movietime'); setShowGearPopover(false) }}
              >
                🎬 Movie Time Settings
              </button>
            </div>
          )}
        </div>
      )}

      <div className="home-landing__content">
        {/* Small GazeAAC logo */}
        <div className="home-landing__logo" aria-label="GazeAAC">
          <span className="home-landing__logo-text">GazeAAC</span>
          <span className="home-landing__logo-sub">Eye-gaze enabled</span>
        </div>

        {/* Mode tiles */}
        <div className="home-landing__tiles" role="group" aria-label="Activity selection">
          <HomeTile
            id="aac"
            ref={aacRef}
            variant="aac"
            icon="🗣"
            label="AAC"
            desc="Communication Board"
            progress={getProgress('aac')}
            isGazed={gazeTarget === 'aac'}
            onClick={onSelectAAC}
          />
          <HomeTile
            id="movie"
            ref={movieRef}
            variant="movie"
            icon="🎬"
            label="Movie Time"
            desc="Watch & Learn"
            progress={getProgress('movie')}
            isGazed={gazeTarget === 'movie'}
            onClick={onSelectMovie}
          />
          <HomeTile
            id="games"
            ref={gamesRef}
            variant="games"
            icon="🎮"
            label="Games"
            desc="Fun & Play"
            progress={getProgress('games')}
            isGazed={gazeTarget === 'games'}
            onClick={onSelectGames}
          />
        </div>

        <p className="home-landing__footer">Gaze at a tile to select your activity</p>
      </div>
    </div>
  )
}

// ─── HomeTile ────────────────────────────────────────────────────────────────

const HomeTile = forwardRef(function HomeTile(
  { id, variant, icon, label, desc, progress, isGazed, onClick },
  ref
) {
  // The SVG dwell ring traces the full tile perimeter — we approximate as a
  // large rounded rectangle path using a rect stroke on a normalised viewBox.
  // For simplicity we use the bottom progress bar approach which looks equally
  // premium without needing dynamic bbox measurement.

  return (
    <button
      ref={ref}
      id={`home-tile-${id}`}
      className={`home-tile home-tile--${variant}${isGazed ? ' home-tile--gazed' : ''}`}
      aria-label={`${label}: ${desc}`}
      onClick={onClick}
    >
      {/* Icon */}
      <span className="home-tile__icon" aria-hidden="true">{icon}</span>

      {/* Text */}
      <div>
        <div className="home-tile__label">{label}</div>
        <div className="home-tile__desc">{desc}</div>
      </div>

      {/* Dwell progress bar */}
      <div
        className="home-tile__progress-bar"
        style={{ width: `${progress * 100}%` }}
        aria-hidden="true"
      />
    </button>
  )
})
