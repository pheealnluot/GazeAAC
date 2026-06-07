import { useEffect, useRef, useState } from 'react'
import './PeppaBusGame.css'

/**
 * PeppaBusGame — Peppa Pig bus game, ported from EduGaze.
 *
 * The bus moves across three lanes (controlled by mouse/gaze Y position).
 * Peppa's friends walk across the road; steering into them picks them up.
 * Hazards (banana peels, mud, water) subtract points and trigger animations.
 * Collect [target] friends to win!
 *
 * Controls:
 *   - Move cursor/gaze UP/DOWN to switch lanes
 *   - The bus automatically moves right-to-left
 *
 * @param {Function} onBack - called when the user exits
 */
export function PeppaBusGame({ onBack }) {
  const [score, setScore] = useState(0)
  const [target, setTarget] = useState(12)
  const [muted, setMuted] = useState(false)
  const [paused, setPaused] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showWin, setShowWin] = useState(false)
  const [musicStyle, setMusicStyle] = useState('instrumental')
  const [busSpeed, setBusSpeed] = useState('normal')
  const [charFreq, setCharFreq] = useState('medium')
  const [hazardFreq, setHazardFreq] = useState('medium')
  const [gameSpeed, setGameSpeed] = useState(0.8)

  // Refs to access mutable state inside RAF/setInterval callbacks without stale closures
  const pausedRef       = useRef(false)
  const mutedRef        = useRef(false)
  const scoreRef        = useRef(0)
  const targetRef       = useRef(12)
  const gameSpeedRef    = useRef(0.8)
  const busSpeedRef     = useRef('normal')
  const charFreqRef     = useRef('medium')
  const hazardFreqRef   = useRef('medium')
  const busLaneRef      = useRef(1)
  const busXRef         = useRef(0)
  const targetXRef      = useRef(0)
  const roadXRef        = useRef(0)
  const skylineXRef     = useRef(0)
  const lastTimeRef     = useRef(0)
  const loopGenRef      = useRef(0)
  const rafRef          = useRef(null)
  const intervalsRef    = useRef([])
  const audioRef        = useRef(null)
  const collectedRef    = useRef([])
  const lanesBoundsRef  = useRef([])
  const winHandlerRef   = useRef(null)
  const winShownRef     = useRef(false)

  // Sync mutable refs with React state
  useEffect(() => { pausedRef.current = paused }, [paused])
  useEffect(() => { mutedRef.current = muted }, [muted])
  useEffect(() => { gameSpeedRef.current = gameSpeed }, [gameSpeed])
  useEffect(() => { busSpeedRef.current = busSpeed }, [busSpeed])
  useEffect(() => { charFreqRef.current = charFreq }, [charFreq])
  useEffect(() => { hazardFreqRef.current = hazardFreq }, [hazardFreq])
  useEffect(() => { targetRef.current = target }, [target])

  // ── Audio helpers ──────────────────────────────────────────────────────────
  const startTheme = (style) => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    const src = (style || musicStyle) === 'instrumental'
      ? '/assets/peppa/theme_nolyrics.mp3'
      : '/assets/peppa/thememusic.mp3'
    const audio = new Audio(src)
    audio.loop = true
    audio.muted = mutedRef.current
    audio.play().catch(() => {})
    audioRef.current = audio
  }

  const stopTheme = () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current = null
    }
  }

  const playSound = (src) => {
    if (mutedRef.current) return
    const a = new Audio(src)
    a.currentTime = 0
    a.play().catch(() => {})
  }

  // ── Game helpers ───────────────────────────────────────────────────────────
  const getBusMoveSpeed = () => {
    const map = { 'very-slow': 1, 'slow': 2, 'normal': 4, 'fast': 8, 'very-fast': 14 }
    return map[busSpeedRef.current] || 4
  }

  const getCharInterval = () => {
    const map = { 'low': 4000, 'medium': 2000, 'high': 1000 }
    return map[charFreqRef.current] || 2000
  }

  const getHazardInterval = () => {
    const map = { 'none': Infinity, 'low': 6000, 'medium': 4000, 'high': 2000 }
    return map[hazardFreqRef.current] || 4000
  }

  const triggerBusAnim = (cls, duration) => {
    const bus = document.getElementById('peppa-bus')
    if (!bus) return
    bus.classList.remove('animate-bus-jump', 'animate-bus-shake', 'animate-bus-slide')
    void bus.offsetWidth
    bus.classList.add(cls)
    setTimeout(() => bus.classList.remove(cls), duration)
  }

  const setBusLane = (lane) => {
    if (busLaneRef.current === lane) return
    busLaneRef.current = lane
    const bus = document.getElementById('peppa-bus')
    if (bus) {
      const laneTops = ['24.6%', '55.7%', '95.9%']
      bus.style.top = laneTops[lane]
      bus.style.zIndex = 50 + lane
    }
  }

  const computeLaneBounds = () => {
    const lanes = document.querySelectorAll('.peppa-lane')
    const vp = document.getElementById('peppa-game-viewport')
    if (!vp || !lanes.length) return
    const vpRect = vp.getBoundingClientRect()
    lanesBoundsRef.current = []
    lanes.forEach(lane => {
      const r = lane.getBoundingClientRect()
      lanesBoundsRef.current.push({ top: r.top - vpRect.top, bottom: r.bottom - vpRect.top })
    })
  }

  // ── Mouse/gaze handler ────────────────────────────────────────────────────
  const handleMouseMove = (e) => {
    if (pausedRef.current) return
    const vp = document.getElementById('peppa-game-viewport')
    if (!vp) return
    const rect = vp.getBoundingClientRect()
    const mouseY = e.clientY - rect.top
    targetXRef.current = e.clientX

    let lane = -1
    for (let i = 0; i < lanesBoundsRef.current.length; i++) {
      const b = lanesBoundsRef.current[i]
      if (mouseY >= b.top && mouseY < b.bottom) { lane = i; break }
    }
    if (lane >= 0) setBusLane(lane)
  }

  // ── Win game ──────────────────────────────────────────────────────────────
  const winGame = () => {
    pausedRef.current = true
    if (audioRef.current) audioRef.current.pause()
    playSound('/assets/peppa/win.mp3')

    const vp = document.getElementById('peppa-game-viewport')
    const bus = document.getElementById('peppa-bus')
    if (vp) vp.classList.add('peppa-game-paused')
    if (bus) bus.classList.add('victory-hero')

    // Show collected friends parade
    setTimeout(() => {
      const victoryLayer = document.getElementById('peppa-victory-layer')
      if (!victoryLayer) return
      const friends = collectedRef.current
      if (!friends.length) return
      const padding = 5
      const total = 100 - padding * 2
      const step = friends.length > 1 ? total / (friends.length - 1) : 0
      friends.forEach((idx, i) => {
        const f = document.createElement('div')
        f.className = 'peppa-celebration-friend'
        f.style.backgroundImage = `url('/assets/peppa/friend${idx}.png')`
        const xPct = friends.length > 1 ? padding + i * step : 50
        f.style.left = `${xPct}%`
        f.style.top = '8%'
        f.style.transform = 'translateX(-50%) translateY(40px) scale(0)'
        f.style.opacity = '0'
        f.style.transition = `transform 0.6s cubic-bezier(0.175,0.885,0.32,1.275) ${i * 100}ms, opacity 0.4s ease ${i * 100}ms`
        victoryLayer.appendChild(f)
        requestAnimationFrame(() => requestAnimationFrame(() => {
          f.style.transform = 'translateX(-50%) translateY(0) scale(1)'
          f.style.opacity = '1'
        }))
      })
    }, 800)

    // Show win overlay on next click/key
    const showOverlay = () => {
      if (!winShownRef.current) {
        winShownRef.current = true
        setShowWin(true)
      }
      document.removeEventListener('keydown', showOverlay)
      document.removeEventListener('click', showOverlay)
      winHandlerRef.current = null
    }
    setTimeout(() => {
      winHandlerRef.current = showOverlay
      document.addEventListener('keydown', showOverlay)
      document.addEventListener('click', showOverlay)
    }, 1200)
  }

  // ── Spawn friend ──────────────────────────────────────────────────────────
  const spawnFriend = (currentMode) => {
    const layer = document.getElementById('peppa-friends-layer')
    if (!layer) return
    const friend = document.createElement('div')
    const lane = Math.floor(Math.random() * 3)
    const laneTops = ['-9%', '23%', '61%']
    const friendIdx = Math.floor(Math.random() * 10) + 1
    friend.className = 'peppa-friend'
    friend.style.backgroundImage = `url('/assets/peppa/friend${friendIdx}.png')`
    friend.style.right = '-300px'
    friend.style.top = laneTops[lane]
    friend.style.zIndex = 40 + lane
    layer.appendChild(friend)

    let pos = -300, collected = false, lt = performance.now()
    function move(time) {
      if (pausedRef.current) { lt = performance.now(); requestAnimationFrame(move); return }
      if (collected) return
      const dt = (time - lt) / 1000; lt = time
      pos += 750 * gameSpeedRef.current * dt
      friend.style.right = pos + 'px'

      if (lane === busLaneRef.current) {
        const bus = document.getElementById('peppa-bus')
        if (bus) {
          const bR = bus.getBoundingClientRect(), fR = friend.getBoundingClientRect()
          if (fR.left < bR.right - 20 && fR.right > bR.left + 40) {
            collected = true
            friend.style.transition = 'all 0.5s cubic-bezier(0.4,0,0.2,1)'
            friend.style.transform = 'rotateX(-45deg) scale(0.1) translate(300px,-600px)'
            friend.style.opacity = '0'
            scoreRef.current++
            collectedRef.current.push(friendIdx)
            setScore(scoreRef.current)
            triggerBusAnim('animate-bus-jump', 500)
            playSound('/assets/peppa/slide.mp3')
            if (scoreRef.current >= targetRef.current) setTimeout(winGame, 500)
            setTimeout(() => friend.remove(), 500)
            return
          }
        }
      }
      if (pos < 4000) requestAnimationFrame(move); else friend.remove()
    }
    requestAnimationFrame(move)
  }

  // ── Spawn hazard ──────────────────────────────────────────────────────────
  const spawnHazard = () => {
    if (hazardFreqRef.current === 'none') return
    const layer = document.getElementById('peppa-friends-layer')
    if (!layer) return
    const hazard = document.createElement('div')
    const lane = Math.floor(Math.random() * 3)
    const types = ['banana', 'mud', 'water']
    const type = types[Math.floor(Math.random() * types.length)]
    hazard.className = `peppa-hazard ${type}`
    const laneTops = ['15%', '43%', '78%']
    hazard.style.right = '-200px'
    hazard.style.top = laneTops[lane]
    layer.appendChild(hazard)

    let pos = -200, triggered = false, lt = performance.now()
    function move(time) {
      if (pausedRef.current) { lt = performance.now(); requestAnimationFrame(move); return }
      if (triggered) return
      const dt = (time - lt) / 1000; lt = time
      pos += 750 * gameSpeedRef.current * dt
      hazard.style.right = pos + 'px'

      if (lane === busLaneRef.current) {
        const bus = document.getElementById('peppa-bus')
        if (bus) {
          const bR = bus.getBoundingClientRect(), hR = hazard.getBoundingClientRect()
          if (hR.left < bR.right - 100 && hR.right > bR.left + 60) {
            triggered = true
            scoreRef.current = Math.max(0, scoreRef.current - 1)
            setScore(scoreRef.current)
            handleHazardCollision(type)
            hazard.style.opacity = '0'
            setTimeout(() => hazard.remove(), 500)
            return
          }
        }
      }
      if (pos < 4000) requestAnimationFrame(move); else hazard.remove()
    }
    requestAnimationFrame(move)
  }

  const handleHazardCollision = (type) => {
    const soundFile = type === 'banana' ? '/assets/peppa/bananapeel.mp3' : '/assets/peppa/splash.mp3'
    playSound(soundFile)

    const origSpeed = gameSpeedRef.current
    gameSpeedRef.current = origSpeed * 0.35
    if (type === 'banana') {
      triggerBusAnim('animate-bus-slide', 600)
    }
    triggerBusAnim('animate-bus-shake', 1200)
    setTimeout(() => { gameSpeedRef.current = origSpeed }, 2000)

    // Screen splash particles
    const bus = document.getElementById('peppa-bus')
    if (!bus || type === 'banana') return
    const isWater = type === 'water'
    const particleClass = isWater ? 'water-particle' : 'mud-particle'
    const splatClass    = isWater ? 'water-edge-splat' : 'mud-edge-splat'
    const bRect = bus.getBoundingClientRect()
    for (let i = 0; i < 10; i++) {
      const p = document.createElement('div')
      p.className = particleClass
      p.style.left = (bRect.left + bRect.width / 2) + 'px'
      p.style.top  = (bRect.top + bRect.height / 2) + 'px'
      p.style.setProperty('--tx', `${(Math.random() - 0.5) * 400}px`)
      p.style.setProperty('--ty', `${-Math.random() * 250}px`)
      document.body.appendChild(p)
      setTimeout(() => p.remove(), 600)
    }
    const container = document.getElementById('peppa-mud-splash-container')
    if (container) {
      const locs = [
        { top: '5%', left: '5%' }, { top: '5%', right: '5%' },
        { bottom: '15%', left: '2%' }, { bottom: '10%', right: '8%' }
      ]
      locs.forEach(loc => {
        const splat = document.createElement('div')
        splat.className = splatClass
        Object.assign(splat.style, loc)
        splat.style.transform = `scale(${0.6 + Math.random()}) rotate(${Math.random() * 360}deg)`
        container.appendChild(splat)
        setTimeout(() => splat.classList.add('show'), 10)
        setTimeout(() => { splat.classList.remove('show'); setTimeout(() => splat.remove(), 1000) }, 2000)
      })
    }
  }

  // ── Spawn decoration ──────────────────────────────────────────────────────
  const spawnDecoration = () => {
    const layer = document.getElementById('peppa-decorations-layer')
    if (!layer) return
    const deco = document.createElement('div')
    deco.className = `peppa-decoration ${Math.random() > 0.5 ? 'peppa-tree' : 'peppa-lamp'}`
    layer.appendChild(deco)
    let pos = -300; deco.style.right = pos + 'px'
    let lt = performance.now()
    function move(time) {
      if (pausedRef.current) { lt = performance.now(); requestAnimationFrame(move); return }
      const dt = (time - lt) / 1000; lt = time
      pos += 750 * gameSpeedRef.current * dt
      deco.style.right = pos + 'px'
      if (pos < 3500) requestAnimationFrame(move); else deco.remove()
    }
    requestAnimationFrame(move)
  }

  // ── Stop game ─────────────────────────────────────────────────────────────
  const stopGame = () => {
    intervalsRef.current.forEach(id => { clearInterval(id); clearTimeout(id) })
    intervalsRef.current = []
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    stopTheme()
    const layer = document.getElementById('peppa-friends-layer')
    if (layer) layer.innerHTML = ''
    const victoryLayer = document.getElementById('peppa-victory-layer')
    if (victoryLayer) victoryLayer.innerHTML = ''
    if (winHandlerRef.current) {
      document.removeEventListener('keydown', winHandlerRef.current)
      document.removeEventListener('click', winHandlerRef.current)
      winHandlerRef.current = null
    }
  }

  // ── Start game ─────────────────────────────────────────────────────────────
  const startGame = () => {
    stopGame()
    pausedRef.current = false
    winShownRef.current = false
    scoreRef.current = 0
    collectedRef.current = []
    setScore(0)
    setShowWin(false)
    setPaused(false)

    const vp = document.getElementById('peppa-game-viewport')
    if (vp) vp.classList.remove('peppa-game-paused')
    const bus = document.getElementById('peppa-bus')
    if (bus) bus.classList.remove('victory-hero')

    busLaneRef.current = 1
    const vw = window.innerWidth
    busXRef.current = vw * 0.45
    targetXRef.current = vw * 0.45
    roadXRef.current = 0
    skylineXRef.current = 0
    lastTimeRef.current = 0
    const myGen = ++loopGenRef.current

    setBusLane(1)
    requestAnimationFrame(() => computeLaneBounds())
    startTheme(musicStyle)

    // Cache DOM
    const lanes = document.querySelectorAll('.peppa-lane')
    const sidewalks = document.querySelectorAll('.peppa-sidewalk')
    const skylines = document.querySelectorAll('.peppa-skyline')

    // Main RAF loop
    function peppaMove(ts) {
      if (myGen !== loopGenRef.current) return
      if (pausedRef.current) {
        lastTimeRef.current = 0
        rafRef.current = requestAnimationFrame(peppaMove)
        return
      }
      if (!lastTimeRef.current) lastTimeRef.current = ts
      const dt = Math.min(0.1, (ts - lastTimeRef.current) / 1000)
      lastTimeRef.current = ts

      const busEl = document.getElementById('peppa-bus')
      if (!busEl) return

      // World scrolling
      roadXRef.current += 750 * gameSpeedRef.current * dt
      skylineXRef.current += (750 / 10) * gameSpeedRef.current * dt
      roadXRef.current %= 600

      lanes.forEach(m => m.style.setProperty('--road-x', `-${roadXRef.current}px`))
      sidewalks.forEach(s => s.style.backgroundPosition = `-${roadXRef.current}px 0`)
      skylines.forEach(s => s.style.backgroundPosition = `-${skylineXRef.current}px 0`)

      // Bus horizontal movement
      const minX = vw * 0.25, maxX = vw * 0.60
      const clampedTarget = Math.max(minX, Math.min(maxX, targetXRef.current))
      const dist = clampedTarget - busXRef.current
      const spd = getBusMoveSpeed() * gameSpeedRef.current
      if (Math.abs(dist) > spd) busXRef.current += Math.sign(dist) * spd
      else busXRef.current = clampedTarget
      busEl.style.left = (busXRef.current + vw * 0.25) + 'px'

      rafRef.current = requestAnimationFrame(peppaMove)
    }
    rafRef.current = requestAnimationFrame(peppaMove)

    // Spawn intervals
    const friendInt = setInterval(() => {
      if (!pausedRef.current && Math.random() > 0.4) spawnFriend()
    }, getCharInterval())
    intervalsRef.current.push(friendInt)

    const decoInt = setInterval(() => {
      if (!pausedRef.current && Math.random() > 0.3) spawnDecoration()
    }, 1500)
    intervalsRef.current.push(decoInt)

    const hazInt = setInterval(() => {
      if (!pausedRef.current && Math.random() > 0.4) spawnHazard()
    }, getHazardInterval())
    intervalsRef.current.push(hazInt)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  useEffect(() => {
    startGame()
    window.addEventListener('mousemove', handleMouseMove)
    const handleResize = () => computeLaneBounds()
    window.addEventListener('resize', handleResize)
    return () => {
      stopGame()
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('resize', handleResize)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pause toggle ───────────────────────────────────────────────────────────
  const togglePause = () => {
    const next = !pausedRef.current
    pausedRef.current = next
    setPaused(next)
    const vp = document.getElementById('peppa-game-viewport')
    if (vp) vp.classList.toggle('peppa-game-paused', next)
    if (audioRef.current) {
      if (next) audioRef.current.pause()
      else audioRef.current.play().catch(() => {})
    }
  }

  // ── Mute toggle ───────────────────────────────────────────────────────────
  const toggleMute = () => {
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)
    if (audioRef.current) audioRef.current.muted = next
  }

  // ── Restart ───────────────────────────────────────────────────────────────
  const restart = () => {
    setShowWin(false)
    startGame()
  }

  // ── Exit ──────────────────────────────────────────────────────────────────
  const handleExit = () => {
    stopGame()
    onBack()
  }

  // ── Settings apply ────────────────────────────────────────────────────────
  const applySettings = () => {
    setShowSettings(false)
    if (audioRef.current) {
      audioRef.current.pause()
      startTheme(musicStyle)
    }
  }

  return (
    <div id="peppa-game-viewport">
      {/* SVG filter for sticker border effect */}
      <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden="true">
        <filter id="sticker-border-peppa" x="-20%" y="-20%" width="140%" height="140%">
          <feMorphology in="SourceAlpha" result="dilated" operator="dilate" radius="2" />
          <feFlood floodColor="white" result="white" />
          <feComposite in="white" in2="dilated" operator="in" result="outline" />
          <feMerge>
            <feMergeNode in="outline" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </svg>

      {/* Skylines */}
      <div className="peppa-skyline" />
      <div className="peppa-skyline" />

      {/* Mud splash container */}
      <div id="peppa-mud-splash-container" style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 2000 }} />

      {/* Victory celebration layer */}
      <div id="peppa-victory-layer" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 60000 }} />

      {/* Road & lanes */}
      <div className="peppa-road">
        <div className="peppa-sidewalk" />
        <div className="peppa-lane peppa-lane-0"><span className="peppa-lane-text">LANE 1</span></div>
        <div className="peppa-lane peppa-lane-1"><span className="peppa-lane-text">LANE 2</span></div>
        <div className="peppa-lane peppa-lane-2"><span className="peppa-lane-text">LANE 3</span></div>
        <div id="peppa-bus" className="peppa-bus" />
        <div id="peppa-friends-layer" style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d' }} />
      </div>

      {/* Decorations layer */}
      <div id="peppa-decorations-layer" style={{ position: 'absolute', top: '28%', left: 0, width: '100%', height: '40px', pointerEvents: 'none', zIndex: 9, overflow: 'visible' }} />

      {/* Hover visualizer (debug) */}
      <div id="peppa-hover-visualizer">
        <div id="hover-zone-0" />
        <div id="hover-zone-1" className="hover-zone" />
        <div id="hover-zone-2" className="hover-zone" />
        <div id="hover-zone-3" className="hover-zone" />
      </div>

      {/* Score display */}
      <div className="peppa-friends-count">
        <img src="/assets/peppa/friend1.png" alt="Friend" />
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
          <span style={{ fontSize: '1.875rem', fontWeight: 900 }}>{score}</span>
          <span style={{ color: '#94a3b8', fontSize: '0.875rem', fontWeight: 700 }}>/ {target}</span>
        </div>
      </div>

      {/* Game controls */}
      <div className="peppa-game-controls">
        {/* Settings */}
        <button id="btn-peppa-settings" className="peppa-btn-control" onClick={() => setShowSettings(true)} title="Settings">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>

        {/* Mute */}
        <button id="btn-peppa-mute" className="peppa-btn-control" onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
          {muted ? (
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          ) : (
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            </svg>
          )}
        </button>

        {/* Pause */}
        <button id="btn-peppa-pause" className="peppa-btn-control" onClick={togglePause} title={paused ? 'Resume' : 'Pause'}>
          {paused ? (
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ) : (
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
        </button>

        {/* Exit */}
        <button className="peppa-btn-control exit-btn" onClick={handleExit}>Exit</button>
      </div>

      {/* Settings overlay */}
      {showSettings && (
        <div className="peppa-settings-overlay show">
          <div className="peppa-settings-panel">
            <h2>Game Settings</h2>

            <div className="peppa-settings-row">
              <label>
                <span>Game Speed</span>
                <span>{gameSpeed.toFixed(1)}x</span>
              </label>
              <input type="range" min="0.1" max="2.0" step="0.1" value={gameSpeed}
                onChange={e => { const v = parseFloat(e.target.value); setGameSpeed(v); gameSpeedRef.current = v }} />
            </div>

            <div className="peppa-settings-row">
              <label>
                <span>Game Goal</span>
                <span style={{ color: '#10b981' }}>{target}</span>
              </label>
              <input type="range" min="5" max="50" step="1" value={target}
                onChange={e => { const v = parseInt(e.target.value); setTarget(v); targetRef.current = v }} />
            </div>

            <div className="peppa-settings-row">
              <label><span>Music Style</span></label>
              <div className="peppa-settings-btns">
                {['vocal', 'instrumental'].map(s => (
                  <button key={s} className={`peppa-settings-btn${musicStyle === s ? ' active' : ''}`}
                    onClick={() => setMusicStyle(s)}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="peppa-settings-row">
              <label><span>Bus Move Speed</span></label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 6, marginTop: 8 }}>
                {['very-slow', 'slow', 'normal', 'fast', 'very-fast'].map(s => (
                  <button key={s} className={`peppa-settings-btn${busSpeed === s ? ' active' : ''}`}
                    style={{ fontSize: '0.65rem' }}
                    onClick={() => { setBusSpeed(s); busSpeedRef.current = s }}>
                    {s.replace('-', ' ')}
                  </button>
                ))}
              </div>
            </div>

            <div className="peppa-settings-row">
              <label><span>Hazards</span></label>
              <div className="peppa-settings-btns" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
                {['none', 'low', 'medium', 'high'].map(s => (
                  <button key={s} className={`peppa-settings-btn${hazardFreq === s ? ' active' : ''}`}
                    onClick={() => { setHazardFreq(s); hazardFreqRef.current = s }}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <button className="peppa-settings-close" onClick={applySettings}>✓ Done</button>
          </div>
        </div>
      )}

      {/* Win overlay */}
      <div className={`peppa-win-overlay${showWin ? ' show' : ''}`}>
        <div className="peppa-win-card">
          <div className="peppa-victory-badge">🏆</div>
          <div className="peppa-win-title">You did it!</div>
          <div className="peppa-win-subtitle">Peppa collected all {score} friends! 🐷</div>
          <div className="peppa-win-btns">
            <button className="peppa-win-btn peppa-win-btn--primary" onClick={restart}>🔄 Play Again</button>
            <button className="peppa-win-btn peppa-win-btn--secondary" onClick={handleExit}>🏠 Exit</button>
          </div>
        </div>
      </div>
    </div>
  )
}
