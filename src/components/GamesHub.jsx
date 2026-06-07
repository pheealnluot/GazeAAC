import { useState, useEffect, useRef, forwardRef } from 'react'
import { useGazeSettings } from '@context/GazeSettingsContext'
import './GamesHub.css'

/**
 * GamesHub — Game selection screen.
 *
 * Shows gaze-dwell tiles for each available game.
 * Calls onSelectGame(gameId) when a game is chosen.
 */
export function GamesHub({ onBack, onSelectGame, gazeCursorRef, registerHitTargets, gazeState, onDwellRef }) {
  const { settings } = useGazeSettings()

  const dwellMs = settings.dwellMs ?? 800
  const gazeTarget = gazeState?.cellId ?? null
  const dwellProgress = gazeState?.dwellProgress ?? 0

  const peppaRef = useRef(null)
  const balloonRef = useRef(null)

  // ── Register hit targets ──────────────────────────────────────────────────
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const cells = []
      const vw = window.innerWidth
      const vh = window.innerHeight
      for (const [id, ref] of [['game-peppa', peppaRef], ['game-balloon', balloonRef]]) {
        const el = ref.current
        if (!el) continue
        const r = el.getBoundingClientRect()
        cells.push({ id, x0: r.left / vw, y0: r.top / vh, x1: r.right / vw, y1: r.bottom / vh })
      }
      registerHitTargets?.(cells)
    })
    return () => cancelAnimationFrame(frame)
  }, [registerHitTargets])

  useEffect(() => {
    const remeasure = () => {
      const cells = []
      const vw = window.innerWidth
      const vh = window.innerHeight
      for (const [id, ref] of [['game-peppa', peppaRef], ['game-balloon', balloonRef]]) {
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

  // ── Wire dwell activation ──────────────────────────────────────────────────
  useEffect(() => {
    if (!onDwellRef) return
    onDwellRef.current = (cellId) => {
      if (cellId === 'game-peppa') onSelectGame('peppa')
      if (cellId === 'game-balloon') onSelectGame('balloon')
    }
    return () => { if (onDwellRef) onDwellRef.current = null }
  }, [onDwellRef, onSelectGame])

  const getProgress = (id) => (gazeTarget === id ? dwellProgress : 0)

  return (
    <div className="games-hub" role="main" aria-label="Game selection">
      {/* Animated background */}
      <div className="games-hub__bg" aria-hidden="true" />
      <div className="games-hub__orb games-hub__orb--1" aria-hidden="true" />
      <div className="games-hub__orb games-hub__orb--2" aria-hidden="true" />
      <div className="games-hub__orb games-hub__orb--3" aria-hidden="true" />

      {/* Back button */}
      <button
        id="games-hub-back-btn"
        className="games-hub__back"
        aria-label="Back to home"
        onClick={onBack}
      >
        ← Back
      </button>

      <div className="games-hub__content">
        {/* Header */}
        <div className="games-hub__header">
          <div className="games-hub__title">🎮 Games</div>
          <div className="games-hub__subtitle">Choose a game to play</div>
        </div>

        {/* Game tiles */}
        <div className="games-hub__tiles" role="group" aria-label="Game selection">
          <GameTile
            id="game-peppa"
            ref={peppaRef}
            variant="peppa"
            icon="🐷"
            label="Peppa's Bus Ride"
            desc="Help Peppa pick up all her friends on the bus!"
            progress={getProgress('game-peppa')}
            isGazed={gazeTarget === 'game-peppa'}
            onClick={() => onSelectGame('peppa')}
          />
          <GameTile
            id="game-balloon"
            ref={balloonRef}
            variant="balloon"
            icon="🎈"
            label="Balloon Pop"
            desc="Gaze at balloons to pop them before they float away!"
            progress={getProgress('game-balloon')}
            isGazed={gazeTarget === 'game-balloon'}
            onClick={() => onSelectGame('balloon')}
            isNew
          />
        </div>

        <p className="games-hub__footer">Gaze at a game to start playing</p>
      </div>
    </div>
  )
}

// ─── GameTile ────────────────────────────────────────────────────────────────

const GameTile = forwardRef(function GameTile(
  { id, variant, icon, label, desc, progress, isGazed, onClick, isNew },
  ref
) {
  return (
    <button
      ref={ref}
      id={`game-tile-${id}`}
      className={`game-tile game-tile--${variant}${isGazed ? ' game-tile--gazed' : ''}`}
      aria-label={`${label}: ${desc}`}
      onClick={onClick}
    >
      {isNew && <span className="game-tile__badge">New</span>}

      {/* Icon */}
      <span className="game-tile__icon" aria-hidden="true">{icon}</span>

      {/* Text */}
      <div>
        <div className="game-tile__label">{label}</div>
        <div className="game-tile__desc">{desc}</div>
      </div>

      {/* Dwell progress bar */}
      <div
        className="game-tile__progress-bar"
        style={{ width: `${progress * 100}%` }}
        aria-hidden="true"
      />
    </button>
  )
})
