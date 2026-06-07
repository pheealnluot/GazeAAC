import { useEffect, useRef, useState, useCallback } from 'react'
import { useGazeSettings } from '@context/GazeSettingsContext'
import './BalloonPopGame.css'

/**
 * BalloonPopGame — Eye-gaze balloon popping game for children (age ~9).
 *
 * Colorful balloons float upward. The child gazes at a balloon for dwellMs
 * to pop it. Popping earns points and triggers a confetti burst.
 * Balloons that escape the top cost nothing — the game is always fun!
 *
 * Levels increase balloon speed and spawn rate over time.
 * Game lasts 60 seconds per round.
 *
 * @param {Function} onBack - called when the user exits
 */

const BALLOON_COLORS = [
  { body: '#ef4444', glow: 'rgba(239,68,68,0.5)' },    // Red
  { body: '#f97316', glow: 'rgba(249,115,22,0.5)' },   // Orange
  { body: '#eab308', glow: 'rgba(234,179,8,0.5)' },    // Yellow
  { body: '#22c55e', glow: 'rgba(34,197,94,0.5)' },    // Green
  { body: '#06b6d4', glow: 'rgba(6,182,212,0.5)' },    // Cyan
  { body: '#6366f1', glow: 'rgba(99,102,241,0.5)' },   // Indigo
  { body: '#ec4899', glow: 'rgba(236,72,153,0.5)' },   // Pink
  { body: '#a855f7', glow: 'rgba(168,85,247,0.5)' },   // Purple
]

const GAME_DURATION_SEC = 60
const STAR_COUNT = 80

export function BalloonPopGame({ onBack }) {
  const { settings } = useGazeSettings()
  const dwellMs = settings.dwellMs ?? 800

  const [score, setScore]         = useState(0)
  const [level, setLevel]         = useState(1)
  const [timeLeft, setTimeLeft]   = useState(GAME_DURATION_SEC)
  const [paused, setPaused]       = useState(false)
  const [gameOver, setGameOver]   = useState(false)
  const [muted, setMuted]         = useState(false)
  const [gazePos, setGazePos]     = useState({ x: -100, y: -100 })
  const [onBalloon, setOnBalloon] = useState(false)
  const [stars, setStars]         = useState([])

  const canvasRef         = useRef(null)
  const balloonsRef       = useRef([])   // { id, x, y, size, color, vy, dwellStart, dwellProgress, el, popping }
  const nextIdRef         = useRef(0)
  const pausedRef         = useRef(false)
  const mutedRef          = useRef(false)
  const scoreRef          = useRef(0)
  const levelRef          = useRef(1)
  const gazePosRef        = useRef({ x: -100, y: -100 })
  const dwellMsRef        = useRef(dwellMs)
  const intervalsRef      = useRef([])
  const rafRef            = useRef(null)
  const timerRef          = useRef(null)
  const timeLeftRef       = useRef(GAME_DURATION_SEC)
  const gazeTargetIdRef   = useRef(null)
  const dwellStartRef     = useRef(null)

  // Sync refs
  useEffect(() => { pausedRef.current = paused }, [paused])
  useEffect(() => { mutedRef.current = muted }, [muted])
  useEffect(() => { dwellMsRef.current = dwellMs }, [dwellMs])

  // ── Generate stars once ────────────────────────────────────────────────────
  useEffect(() => {
    const s = Array.from({ length: STAR_COUNT }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: Math.random() * 2.5 + 0.5,
      dur: (Math.random() * 3 + 2).toFixed(1),
      delay: (Math.random() * 4).toFixed(1),
      maxOpacity: (Math.random() * 0.5 + 0.2).toFixed(2),
    }))
    setStars(s)
  }, [])

  // ── Sound effects ──────────────────────────────────────────────────────────
  const playPop = () => {
    if (mutedRef.current) return
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.setValueAtTime(600, ctx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.15)
      gain.gain.setValueAtTime(0.4, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.15)
    } catch (_) {}
  }

  const playLevelUp = () => {
    if (mutedRef.current) return
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      ;[0, 0.1, 0.2].forEach((t, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.frequency.value = [523, 659, 784][i]
        gain.gain.setValueAtTime(0.3, ctx.currentTime + t)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2)
        osc.start(ctx.currentTime + t)
        osc.stop(ctx.currentTime + t + 0.2)
      })
    } catch (_) {}
  }

  // ── Confetti burst ─────────────────────────────────────────────────────────
  const spawnConfetti = (x, y, color) => {
    const container = canvasRef.current
    if (!container) return
    const count = 18
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div')
      el.className = 'confetti-piece'
      const angle = (i / count) * Math.PI * 2
      const dist = 60 + Math.random() * 80
      const tx = Math.cos(angle) * dist
      const ty = Math.sin(angle) * dist - 40
      const dur = (0.5 + Math.random() * 0.4).toFixed(2)
      const rot = (Math.random() * 720 - 360).toFixed(0)
      el.style.cssText = `
        left: ${x}px; top: ${y}px;
        background: ${color};
        --tx: ${tx}px; --ty: ${ty}px;
        --dur: ${dur}s; --rot: ${rot}deg;
        border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
      `
      container.appendChild(el)
      setTimeout(() => el.remove(), parseFloat(dur) * 1000 + 100)
    }
  }

  // ── Score pop ──────────────────────────────────────────────────────────────
  const spawnScorePop = (x, y, pts) => {
    const container = canvasRef.current
    if (!container) return
    const el = document.createElement('div')
    el.className = 'score-pop'
    el.textContent = `+${pts}`
    el.style.left = `${x - 20}px`
    el.style.top  = `${y - 20}px`
    container.appendChild(el)
    setTimeout(() => el.remove(), 900)
  }

  // ── Level up flash ─────────────────────────────────────────────────────────
  const showLevelUpFlash = (lv) => {
    const el = document.createElement('div')
    el.className = 'level-up-flash'
    el.textContent = `⭐ Level ${lv}!`
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 1300)
    playLevelUp()
  }

  // ── Pop a balloon ──────────────────────────────────────────────────────────
  const popBalloon = useCallback((balloon) => {
    if (balloon.popping) return
    balloon.popping = true

    const pts = levelRef.current
    scoreRef.current += pts
    setScore(scoreRef.current)

    playPop()
    spawnConfetti(balloon.x + balloon.size / 2, balloon.y + balloon.size * 0.6, balloon.color.body)
    spawnScorePop(balloon.x + balloon.size / 2, balloon.y, pts)

    // Pop animation on DOM element
    if (balloon.el) balloon.el.classList.add('popping')

    setTimeout(() => {
      if (balloon.el) balloon.el.remove()
      balloonsRef.current = balloonsRef.current.filter(b => b.id !== balloon.id)
    }, 380)

    // Level up every 10 pops
    const newLevel = Math.min(10, Math.floor(scoreRef.current / 10) + 1)
    if (newLevel > levelRef.current) {
      levelRef.current = newLevel
      setLevel(newLevel)
      showLevelUpFlash(newLevel)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Spawn a balloon ────────────────────────────────────────────────────────
  const spawnBalloon = useCallback(() => {
    const container = canvasRef.current
    if (!container || pausedRef.current) return

    const id = nextIdRef.current++
    const size = 60 + Math.random() * 50  // 60-110px
    const color = BALLOON_COLORS[Math.floor(Math.random() * BALLOON_COLORS.length)]
    const x = Math.random() * (window.innerWidth - size - 40) + 20
    const speedBase = 40 + levelRef.current * 8  // px/s, increases with level
    const vy = -(speedBase + Math.random() * 30)
    const wobble = (Math.random() - 0.5) * 20  // slight horizontal drift

    // Create DOM element
    const el = document.createElement('div')
    el.className = 'balloon'
    el.id = `balloon-${id}`
    el.style.cssText = `
      left: ${x}px;
      top: ${window.innerHeight}px;
      --size: ${size}px;
      --color: ${color.body};
    `
    el.innerHTML = `
      <div class="balloon__body">
        <div class="balloon__shine"></div>
        <div class="balloon__knot"></div>
        <svg class="balloon__dwell-ring" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="3"/>
          <circle class="balloon-dwell-arc" cx="50" cy="50" r="46" fill="none"
            stroke="${color.body}" stroke-width="4" stroke-linecap="round"
            stroke-dasharray="289 289" stroke-dashoffset="289"
            transform="rotate(-90 50 50)"
            style="filter: drop-shadow(0 0 4px ${color.glow}); transition: stroke-dashoffset 0.05s linear;"/>
        </svg>
      </div>
      <div class="balloon__string"></div>
    `
    container.appendChild(el)

    const balloon = { id, x, y: window.innerHeight, size, color, vy, wobble, el, popping: false, time: 0 }
    balloonsRef.current.push(balloon)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Main RAF loop ──────────────────────────────────────────────────────────
  const runLoop = useCallback(() => {
    let lastTime = performance.now()

    function tick(now) {
      if (pausedRef.current) { lastTime = now; rafRef.current = requestAnimationFrame(tick); return }
      const dt = Math.min(0.1, (now - lastTime) / 1000)
      lastTime = now

      // Update each balloon
      const gx = gazePosRef.current.x, gy = gazePosRef.current.y
      let hovering = false

      balloonsRef.current = balloonsRef.current.filter(balloon => {
        if (balloon.popping) return true  // keep until timeout removes
        balloon.time += dt
        balloon.y += balloon.vy * dt
        balloon.x += balloon.wobble * Math.sin(balloon.time * 1.5) * dt

        if (balloon.el) {
          balloon.el.style.top  = `${balloon.y}px`
          balloon.el.style.left = `${balloon.x}px`
        }

        // Check if escaped top
        if (balloon.y + balloon.size < 80) {
          if (balloon.el) balloon.el.remove()
          return false
        }

        // Gaze hit test
        const cx = balloon.x + balloon.size / 2
        const cy = balloon.y + balloon.size * 0.55
        const radius = balloon.size * 0.55
        const dist = Math.sqrt((gx - cx) ** 2 + (gy - cy) ** 2)
        const isHit = dist < radius

        if (isHit) {
          hovering = true
          if (gazeTargetIdRef.current !== balloon.id) {
            gazeTargetIdRef.current = balloon.id
            dwellStartRef.current = now
          }
          const elapsed = now - dwellStartRef.current
          const progress = Math.min(1, elapsed / dwellMsRef.current)

          // Update dwell arc
          if (balloon.el) {
            const arc = balloon.el.querySelector('.balloon-dwell-arc')
            if (arc) {
              const circumference = 289
              arc.style.strokeDashoffset = circumference * (1 - progress)
            }
          }

          if (progress >= 1) {
            popBalloon(balloon)
          }
        } else {
          // Reset dwell arc if this was the target
          if (gazeTargetIdRef.current === balloon.id) {
            gazeTargetIdRef.current = null
            dwellStartRef.current = null
          }
          if (balloon.el) {
            const arc = balloon.el.querySelector('.balloon-dwell-arc')
            if (arc) arc.style.strokeDashoffset = '289'
          }
        }
        return true
      })

      setOnBalloon(hovering)
      if (!hovering && gazeTargetIdRef.current !== null) {
        gazeTargetIdRef.current = null
        dwellStartRef.current = null
      }

      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [popBalloon])

  // ── Mouse/gaze tracking ────────────────────────────────────────────────────
  useEffect(() => {
    const handleMove = (e) => {
      const pos = { x: e.clientX, y: e.clientY }
      gazePosRef.current = pos
      setGazePos(pos)
    }
    window.addEventListener('mousemove', handleMove)
    return () => window.removeEventListener('mousemove', handleMove)
  }, [])

  // ── Game lifecycle ─────────────────────────────────────────────────────────
  const startGame = useCallback(() => {
    // Clear any existing intervals
    intervalsRef.current.forEach(clearInterval)
    intervalsRef.current = []
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (timerRef.current) clearInterval(timerRef.current)

    // Reset state
    if (canvasRef.current) canvasRef.current.innerHTML = ''
    balloonsRef.current = []
    scoreRef.current = 0
    levelRef.current = 1
    timeLeftRef.current = GAME_DURATION_SEC
    pausedRef.current = false
    gazeTargetIdRef.current = null
    dwellStartRef.current = null

    setScore(0)
    setLevel(1)
    setTimeLeft(GAME_DURATION_SEC)
    setPaused(false)
    setGameOver(false)

    // Spawn interval: adapts with level
    let lastSpawnInterval = null
    const updateSpawnInterval = () => {
      if (lastSpawnInterval) clearInterval(lastSpawnInterval)
      const ms = Math.max(600, 2000 - levelRef.current * 150)
      lastSpawnInterval = setInterval(() => {
        if (!pausedRef.current) spawnBalloon()
      }, ms)
      intervalsRef.current.push(lastSpawnInterval)
    }
    updateSpawnInterval()

    // Level monitoring — update spawn rate on level change
    const levelWatcher = setInterval(() => {
      const expected = Math.min(10, Math.floor(scoreRef.current / 10) + 1)
      if (expected !== levelRef.current) updateSpawnInterval()
    }, 1000)
    intervalsRef.current.push(levelWatcher)

    // Countdown timer
    timerRef.current = setInterval(() => {
      if (pausedRef.current) return
      timeLeftRef.current--
      setTimeLeft(timeLeftRef.current)
      if (timeLeftRef.current <= 0) {
        clearInterval(timerRef.current)
        intervalsRef.current.forEach(clearInterval)
        intervalsRef.current = []
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        setGameOver(true)
      }
    }, 1000)

    runLoop()
  }, [spawnBalloon, runLoop])

  useEffect(() => {
    startGame()
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (timerRef.current) clearInterval(timerRef.current)
      intervalsRef.current.forEach(clearInterval)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const togglePause = () => {
    const next = !pausedRef.current
    pausedRef.current = next
    setPaused(next)
  }

  const toggleMute = () => {
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)
  }

  const handleRestart = () => startGame()

  const handleExit = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (timerRef.current) clearInterval(timerRef.current)
    intervalsRef.current.forEach(clearInterval)
    onBack()
  }

  const progressPct = (timeLeft / GAME_DURATION_SEC) * 100

  return (
    <div className="balloon-pop-game">
      {/* Stars */}
      <div className="balloon-pop-game__stars" aria-hidden="true">
        {stars.map(s => (
          <div key={s.id} className="balloon-pop-game__star" style={{
            left: `${s.x}%`, top: `${s.y}%`,
            width: `${s.size}px`, height: `${s.size}px`,
            '--dur': `${s.dur}s`,
            '--max-opacity': s.maxOpacity,
            animationDelay: `${s.delay}s`,
          }} />
        ))}
      </div>

      {/* Header */}
      <div className="balloon-pop-game__header">
        <div className="balloon-pop-game__score-block">
          <span className="balloon-pop-game__score-label">Score</span>
          <span className={`balloon-pop-game__score`}>{score}</span>
        </div>

        <div className="balloon-pop-game__level-badge">
          <span className="balloon-pop-game__level-label">Level</span>
          <span className="balloon-pop-game__level-num">{level}</span>
        </div>

        <div className="balloon-pop-game__level-badge">
          <span className="balloon-pop-game__score-label">Time</span>
          <span className="balloon-pop-game__level-num" style={{
            color: timeLeft <= 10 ? '#ef4444' : '#f1f5f9',
            transition: 'color 0.3s'
          }}>{timeLeft}s</span>
        </div>

        <div className="balloon-pop-game__controls">
          <button className="balloon-pop-game__btn" onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
            {muted ? '🔇' : '🔊'}
          </button>
          <button className="balloon-pop-game__btn" onClick={togglePause} title={paused ? 'Resume' : 'Pause'}>
            {paused ? '▶' : '⏸'}
          </button>
          <button className="balloon-pop-game__btn exit" onClick={handleExit}>← Exit</button>
        </div>
      </div>

      {/* Balloon canvas */}
      <div ref={canvasRef} className="balloon-pop-game__canvas" />

      {/* Gaze cursor */}
      <div
        className={`balloon-pop-game__cursor${onBalloon ? ' on-balloon' : ''}`}
        style={{ left: gazePos.x, top: gazePos.y }}
        aria-hidden="true"
      />

      {/* Time progress bar */}
      <div className="balloon-pop-game__progress-bar-wrap">
        <div className="balloon-pop-game__progress-bar" style={{ width: `${progressPct}%` }} />
      </div>

      {/* Pause overlay */}
      {paused && !gameOver && (
        <div className="balloon-pop-game__pause-banner">
          <div className="balloon-pop-game__pause-text">⏸ Paused<br /><span style={{ fontSize: '1.5rem' }}>Click ▶ to resume</span></div>
        </div>
      )}

      {/* Game over overlay */}
      {gameOver && (
        <div className="balloon-pop-game__overlay">
          <div className="balloon-pop-game__result-card">
            <span className="balloon-pop-game__result-emoji">
              {score >= 50 ? '🏆' : score >= 25 ? '⭐' : '🎈'}
            </span>
            <div className="balloon-pop-game__result-title">
              {score >= 50 ? 'Amazing!' : score >= 25 ? 'Great job!' : 'Well done!'}
            </div>
            <div className="balloon-pop-game__result-subtitle">You reached Level {level}</div>
            <div className="balloon-pop-game__result-score">{score} pts</div>
            <div className="balloon-pop-game__result-btns">
              <button className="balloon-pop-game__result-btn primary" onClick={handleRestart}>
                🎈 Play Again
              </button>
              <button className="balloon-pop-game__result-btn secondary" onClick={handleExit}>
                🏠 Exit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
