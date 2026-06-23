import { useState, useEffect, useRef, useCallback } from 'react'
import { TelemetryRouter } from '@engine/TelemetryRouter'
import { GazeCalibrationEngine } from '@engine/GazeCalibrationEngine'
import { SessionLogger } from '@engine/SessionLogger'
import { SyncAdapter } from '@engine/SyncAdapter'
import { FirebaseSyncAdapter } from '@engine/FirebaseSyncAdapter'

// Initialize Firebase Sync Adapter at startup
SyncAdapter.setAdapter(new FirebaseSyncAdapter())
import { useGazeSettings } from '@context/GazeSettingsContext'
import { useVocabulary, NAV_VERB_PAGES } from '@context/VocabularyContext'
import { usePhrase } from '@context/PhraseContext'
import { AACBoardProvider, useAACBoards } from '@context/AACBoardContext'
import { boardModelToCells } from '@engine/OBFParser'
import { AuthScreen } from '@components/AuthScreen'
import { signOutCaregiver } from '@engine/firebase'
import { CalibrationScreen } from '@components/CalibrationScreen'
import { HomeLanding } from '@components/HomeLanding'
import { MovieTime } from '@components/MovieTime'
import { GamesHub } from '@components/GamesHub'
import { PeppaBusGame } from '@components/PeppaBusGame'
import { BalloonPopGame } from '@components/BalloonPopGame'
import QAGame from '@components/QAGame'
import { GridRenderer } from '@components/GridRenderer'
import { GazeFeedbackOverlay } from '@components/GazeFeedbackOverlay'
import { SettingsModal } from '@components/SettingsModal'
import { PhraseBar } from '@components/PhraseBar'
import { TopBar } from '@components/TopBar'
import { NavBreadcrumb } from '@components/NavBreadcrumb'
import { CaregiverPanel } from '@components/CaregiverPanel'
import { BoardSelector } from '@components/BoardSelector'
import { BoardEditor } from '@components/BoardEditor'
import { ContextWindow } from '@components/ContextWindow'
import { ContextualResponseGrid } from '@components/ContextualResponseGrid'
import { useCameraVision } from '@context/CameraVisionContext'
import { useGazeHeatmap } from '@context/GazeHeatmapContext'
import { GazeHeatmapOverlay } from '@components/GazeHeatmapOverlay'
import './App.css'

/**
 * Returns a human-readable string describing the active gaze source.
 */
function getTobiiStatusText(mode) {
  if (mode === 'tobii') return 'Tobii SDK @ real-time'
  if (mode === 'mouse') return 'Mouse hover mode'
  return 'No eye tracker'
}

/**
 * Play a subtle warning chime using Web Audio API when gaze is lost.
 */
function playWarningChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gainNode = ctx.createGain()

    osc.connect(gainNode)
    gainNode.connect(ctx.destination)

    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(330, ctx.currentTime) // E4
    osc.frequency.linearRampToValueAtTime(220, ctx.currentTime + 0.2) // A3

    gainNode.gain.setValueAtTime(0.001, ctx.currentTime)
    gainNode.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.05)
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)

    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.3)
    osc.onended = () => ctx.close()
  } catch (_) {}
}


/**
 * LiveVideoStream — Shows the active live webcam feed with face
 * and object detection overlays mapped to a mirrored canvas.
 */
function LiveVideoStream({ active }) {
  const { cameraStream, visionData } = useCameraVision()
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const animRef = useRef(null)

  useEffect(() => {
    if (videoRef.current) {
      if (active && cameraStream) {
        videoRef.current.srcObject = cameraStream
        videoRef.current.play().catch(err => {
          console.warn('[LiveVideoStream] Failed to play video stream:', err)
        })
      } else {
        videoRef.current.srcObject = null
      }
    }
  }, [active, cameraStream])

  useEffect(() => {
    let cancelled = false

    function draw() {
      if (cancelled) return
      const video = videoRef.current
      const canvas = canvasRef.current
      if (active && video && canvas && video.readyState >= 2) {
        const ctx = canvas.getContext('2d')
        if (canvas.width !== video.videoWidth) {
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height)

        // Draw flipped video frame (for mirrored camera feed)
        ctx.save()
        ctx.translate(canvas.width, 0)
        ctx.scale(-1, 1)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        ctx.restore()

        // Draw custom emerald/green overlay for verified registered faces
        if (visionData?.people) {
          visionData.people.forEach(p => {
            const box = p.box
            if (box) {
              // Mirror the box.x coordinate for the flipped rendering:
              const x = canvas.width - box.x - box.width

              ctx.strokeStyle = '#10B981' // emerald
              ctx.lineWidth = 3
              ctx.shadowColor = 'rgba(16, 185, 129, 0.4)'
              ctx.shadowBlur = 8
              ctx.strokeRect(x, box.y, box.width, box.height)
              ctx.shadowBlur = 0

              ctx.fillStyle = '#10B981'
              ctx.font = 'bold 12px Inter, sans-serif'
              const text = `${p.name} (${p.expression})`
              const tw = ctx.measureText(text).width
              ctx.fillRect(x, box.y > 20 ? box.y - 18 : box.y, tw + 8, 16)

              ctx.fillStyle = '#ffffff'
              ctx.fillText(text, x + 4, box.y > 20 ? box.y - 6 : box.y + 12)
            }
          })
        }

        // Draw COCO-SSD standard objects (vibrant amber overlay)
        if (visionData?.objects) {
          visionData.objects.forEach(obj => {
            const box = obj.box
            if (box) {
              // Mirror the box.x coordinate for the flipped rendering:
              const x = canvas.width - box.x - box.width

              ctx.strokeStyle = '#f59e0b' // amber
              ctx.lineWidth = 2
              ctx.strokeRect(x, box.y, box.width, box.height)

              ctx.fillStyle = '#f59e0b'
              ctx.font = '11px Inter, sans-serif'
              const text = `${obj.label} (${Math.round(obj.confidence * 100)}%)`
              const tw = ctx.measureText(text).width
              ctx.fillRect(x, box.y > 16 ? box.y - 15 : box.y, tw + 6, 14)

              ctx.fillStyle = '#000000'
              ctx.fillText(text, x + 3, box.y > 16 ? box.y - 4 : box.y + 10)
            }
          })
        }
      }
      animRef.current = requestAnimationFrame(draw)
    }

    if (active) {
      animRef.current = requestAnimationFrame(draw)
    }

    return () => {
      cancelled = true
      if (animRef.current) cancelAnimationFrame(animRef.current)
    }
  }, [active, visionData])

  return (
    <div className={`app__video-stream-container${active ? ' app__video-stream-container--active' : ''}`}>
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        style={{ display: 'none' }}
      />
      <canvas
        ref={canvasRef}
        className="app__video-stream-canvas"
      />
      <div className="app__video-stream-badge">📹 Live HUD</div>
    </div>
  )
}


/**
 * App – Top-level application shell.
 *
 * State machine:
 *   'calibration' → 'aac'
 *
 * Responsibilities:
 *   1. Lifecycle-manage the TelemetryRouter (start on mount, stop on unmount).
 *   2. Register the active vocabulary grid with the router for hit-testing.
 *   3. Pass real-time GazeEvents and dwell progress down to GridRenderer.
 *   4. Route cell activations:
 *        - Navigation verbs (PLAY, EAT, …) → VocabularyContext.navigateTo()
 *        - HOME utility cell               → VocabularyContext.goHome()
 *        - DEL utility cell                → PhraseContext.deleteWord()
 *        - CLR utility cell                → PhraseContext.clearPhrase()
 *        - All other active cells          → PhraseContext.pushWord() + speak()
 *   5. Render the frameless window title-bar controls + NavBreadcrumb (M4).
 *   6. Render the GazeFeedbackOverlay (M3) and SettingsModal (M3).
 *   7. Render the PhraseBar (M4) in place of the old flat speech buffer.
 */
export function App() {
  const { settings, updateSetting, currentUser } = useGazeSettings()
  const { activeCells, setStage, isLoading: vocabLoading, navigateTo, goHome, goBack, activePage, rootBoardId } = useVocabulary()
  const { pushWord, deleteWord, clearPhrase, speakPhrase } = usePhrase()
  const { recordPoint, showOverlay, toggleHeatmapOverlay } = useGazeHeatmap()

  // ── Auth flow: 'auth' → 'calibration' → 'aac' ──────────────────────────────
  // 'auth'        = AuthScreen visible (before calibration)
  // 'calibration' = Calibration screen (gaze setup)
  // 'aac'         = Main AAC board
  const [mode, setMode] = useState('auth') // starts at auth screen
  const [gameId, setGameId] = useState(null) // 'peppa' | 'balloon'
  const [isOverlayActive, setIsOverlayActive] = useState(false) // transparent overlay mode active
  const [isQuizActive, setIsQuizActive] = useState(false) // whether a quiz is currently active
  const [isHoveringTitlebar, setIsHoveringTitlebar] = useState(false) // whether mouse is over titlebar
  const [appTitlebarQuizInfo, setAppTitlebarQuizInfo] = useState(null) // titlebar quiz/countdown state
  const [isAppFocused, setIsAppFocused] = useState(document.hasFocus()) // whether the window has focus
  // Active tracker mode: 'tobii' | 'mouse'
  const [trackerMode, setTrackerMode] = useState(window.gazeAPI?.trackerMode ?? 'mouse')
  // Dwell/hit-test state — only cellId and dwellProgress trigger re-renders
  const [gazeState, setGazeState] = useState({ cellId: null, dwellProgress: 0 })
  // Cursor position is written directly to the DOM to avoid a React render
  // cycle on every gaze frame (~60 Hz). This eliminates the single biggest
  // source of perceived gaze lag.
  const gazeCursorRef      = useRef(null)   // ref to the cursor <div>
  const gazeFilteredRef    = useRef(null)   // last filtered pos for overlay props
  const gazeOverlayMoveRef = useRef(null)   // set by GazeFeedbackOverlay; called every frame
                                            // to update overlay position without React re-render

  // ── Unified gaze: mode-specific dispatch refs ────────────────────────────────
  // These refs let child components (HomeLanding, MovieTime) plug their dwell
  // handlers and receive raw gaze data without owning the IPC stream.
  const modeRef            = useRef(mode)     // stable ref to current mode
  const homeDwellRef       = useRef(null)     // HomeLanding writes its dwell handler here
  const gamesDwellRef      = useRef(null)     // GamesHub writes its dwell handler here
  const movieDwellRef      = useRef(null)     // MovieTime writes its dwell handler here
  const qaDwellRef         = useRef(null)     // QAGame writes its dwell handler here
  const movieRawGazeRef    = useRef(null)     // receives raw {x,y,valid} for gaze-away detection
  const movieCursorStyleRef = useRef(null)    // MovieTime controls cursor visibility per phase

  const [statusMsg, setStatusMsg] = useState('Awaiting gaze stream… 0 s')
  const gazeWaitStartRef  = useRef(Date.now())   // timestamp when we began waiting
  const gazeWaitTimerRef  = useRef(null)          // interval handle for the counter

  // Settings modal + which panel to open
  const [showSettings, setShowSettings] = useState(false)
  const [settingsPanel, setSettingsPanel] = useState('eye')

  const openSettings = (panel) => { setSettingsPanel(panel); setShowSettings(true) }

  // M5: caregiver panel + gear popover
  const [showCaregiverPanel, setShowCaregiverPanel] = useState(false)
  const [showGearPopover, setShowGearPopover]   = useState(false)
  const gearContainerRef = useRef(null)

  useEffect(() => {
    if (!showGearPopover) return
    const handleOutsideClick = (e) => {
      if (gearContainerRef.current && !gearContainerRef.current.contains(e.target)) {
        setShowGearPopover(false)
      }
    }
    document.addEventListener('click', handleOutsideClick)
    return () => {
      document.removeEventListener('click', handleOutsideClick)
    }
  }, [showGearPopover])

  // Contextual Response board state
  const [contextualResponses, setContextualResponses]   = useState([])
  const [contextualActiveModel, setContextualActiveModel] = useState(null)
  const [contextualFallbackReason, setContextualFallbackReason] = useState(null)

  // Single Reply mode — when enabled, selecting a response locks all other tiles
  const [singleReplyMode, setSingleReplyMode] = useState(false)
  const [lockedResponseIdx, setLockedResponseIdx] = useState(-1) // -1 = none locked

  // Manual gate pending — true when answerGateMs===-1 AND responses arrived but not yet proceeded
  const [manualGatePending, setManualGatePending] = useState(false)
  // Ref mirror so handleActivate always reads the live value (avoids stale closure in dwell path)
  const manualGatePendingRef = useRef(false)

  // BaseBoard — compact vocabulary board shown in contextual mode
  const [baseBoardEnabled, setBaseBoardEnabled] = useState(false)
  const [baseBoardCells, setBaseBoardCells] = useState([])
  const [baseBoardCols, setBaseBoardCols] = useState(12)
  const [baseBoardRows, setBaseBoardRows] = useState(7)
  const [baseBoardLoading, setBaseBoardLoading] = useState(true)

  // Board library & editor (M7)
  const [showBoardSelector, setShowBoardSelector] = useState(false)
  const [boardEditorId, setBoardEditorId]         = useState(null)

  const [inputFocused, setInputFocused] = useState(false)

  const [appVersion, setAppVersion] = useState('0.2.6')

  // ── In-App Calibration Correction ──────────────────────────────────────────
  const calibrationEngineRef = useRef(null)
  const [gazeQualityLevel, setGazeQualityLevel] = useState('none')  // 'good'|'fair'|'poor'|'learning'|'none'
  const [gazeQualityPct, setGazeQualityPct] = useState(0)
  const [isGazePresent, setIsGazePresent] = useState(false)
  const [gazePresencePct, setGazePresencePct] = useState(0)
  const [gazeDriftPct, setGazeDriftPct] = useState(0)
  const [gazeDriftPx, setGazeDriftPx] = useState(0)
  const [gazeAccuracyPct, setGazeAccuracyPct] = useState(0)
  const [showGazeHUD, setShowGazeHUD] = useState(false)
  const implicitSampleCountRef = useRef(0)  // tracks activations for periodic persist

  // Initialize calibration engine on mount
  useEffect(() => {
    calibrationEngineRef.current = new GazeCalibrationEngine()
  }, [])

  // Keep GazeCalibrationEngine synced when settings.gazeCorrection changes (e.g. from cloud sync or manual settings load)
  useEffect(() => {
    const engine = calibrationEngineRef.current
    if (engine) {
      const corr = settings.gazeCorrection
      if (corr) {
        engine.fromJSON(corr)
        setGazeQualityLevel(engine.getQualityLevel())
        setGazeQualityPct(Math.round(engine.getQuality() * 100))
        
        // Calculate drift and accuracy
        const drift = engine.getDrift()
        setGazeDriftPct(Math.round(drift.distance * 100))
        setGazeDriftPx(Math.round(drift.distance * Math.sqrt(window.innerWidth * window.innerWidth + window.innerHeight * window.innerHeight)))
        setGazeAccuracyPct(Math.round(engine.getQuality() * 100))
      } else {
        engine.reset()
        setGazeQualityLevel('none')
        setGazeQualityPct(0)
        setGazeDriftPct(0)
        setGazeDriftPx(0)
        setGazeAccuracyPct(0)
      }
    }
  }, [settings.gazeCorrection])

  useEffect(() => {
    if (window.gazeAPI?.getVersion) {
      window.gazeAPI.getVersion().then(setAppVersion).catch(err => {
        console.warn('Failed to fetch app version via gazeAPI:', err)
      })
    }
  }, [])

  // Warning sound on gaze loss
  useEffect(() => {
    if (mode === 'auth' || mode === 'calibration') return
    if (settings.mouseHoverMode) return
    if (settings.gazeLostSoundEnabled === false) return
    
    if (!isGazePresent) {
      playWarningChime()
      console.log('[App] Signal loss warning chime played.')
    }
  }, [isGazePresent, mode, settings.mouseHoverMode, settings.gazeLostSoundEnabled])


  // Listen for dynamic eye-tracker connect/disconnect events
  useEffect(() => {
    if (!window.gazeAPI?.onTrackerModeChange) return
    const unsub = window.gazeAPI.onTrackerModeChange((newMode) => {
      setTrackerMode(newMode)
      setStatusMsg(`Gaze stream active (${getTobiiStatusText(newMode)})`)
      console.log(`[App] Gaze tracker mode updated to: ${newMode}`)
    })
    return unsub
  }, [])

  // Track if any text input, textarea, or contenteditable element has focus in the document
  useEffect(() => {
    const handleFocusChange = () => {
      const active = document.activeElement
      const isInput = active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.isContentEditable
      )
      setInputFocused(!!isInput)
    }

    document.addEventListener('focusin', handleFocusChange)
    document.addEventListener('focusout', handleFocusChange)
    
    // Initial check
    handleFocusChange()

    return () => {
      document.removeEventListener('focusin', handleFocusChange)
      document.removeEventListener('focusout', handleFocusChange)
    }
  }, [])

  // Keyboard shortcut to toggle heatmap overlay: Ctrl+Shift+H
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        toggleHeatmapOverlay()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleHeatmapOverlay])

  const routerRef           = useRef(null)
  const sessionRef          = useRef(null)  // M5: SessionLogger instance
  const contextualGateUnlockedRef = useRef(true)
  // Imperative handle: ContextualResponseGrid exposes its gate-unlock function
  // here so the Proceed button can trigger the visual unlock + chime together.
  const gateUnlockTriggerRef = useRef(null)
  // Imperative handle: ContextualResponseGrid exposes its gate-lock function
  // here so the Lock button can trigger the visual lock together.
  const gateLockTriggerRef = useRef(null)
  // Stable ref wrapper so the TelemetryRouter never needs to restart
  // when activeCells or other handleActivate dependencies change.
  const handleActivateRef   = useRef(null)
  // Refs for measuring grids and TopBar buttons (multi-grid support)
  const topBarMeasureRef    = useRef(null)  // set by TopBar via onMeasureReady
  
  const vocabGridCellsRef   = useRef([])
  const aiGridCellsRef      = useRef([])
  const baseBoardGridCellsRef = useRef([])

  const vocabMeasureTriggerRef = useRef(null)
  const aiMeasureTriggerRef = useRef(null)
  const baseBoardMeasureTriggerRef = useRef(null)

  // ── Waiting-for-gaze counter ───────────────────────────────────────────────
  // Shows elapsed seconds in the status bar while mode === 'calibration'.
  // When the mode flips to 'aac' the counter clears itself and the router
  // effect below stamps the final "established in X s" message.
  useEffect(() => {
    if (mode !== 'calibration') return

    // Reset the start time every time we enter calibration.
    gazeWaitStartRef.current = Date.now()
    setStatusMsg('Awaiting gaze stream… 0 s')

    gazeWaitTimerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - gazeWaitStartRef.current) / 1000)
      setStatusMsg(`Awaiting gaze stream… ${elapsed} s`)
    }, 1000)

    return () => {
      clearInterval(gazeWaitTimerRef.current)
      gazeWaitTimerRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // ── Raw gaze stream — started immediately so CalibrationScreen gets data ────
  // This subscribes to ipc:gaze-data before the TelemetryRouter starts.
  // preload.js deduplicates the IPC listener on each startStream() call, so
  // when the router later calls startStream() it replaces this raw handler
  // cleanly. We keep our own ref so we can stop on unmount.
  const gazeStreamAcquiredRef = useRef(false) // one-shot: true after first valid point
  useEffect(() => {
    if (!window.gazeAPI) return

    // In calibration mode we just need raw position — no dwell processing.
    // The unified TelemetryRouter handles all interactive modes (home, movie,
    // aac), so we only need the raw stream for auth/calibration.
    if (mode === 'aac' || mode === 'movie' || mode === 'home' || mode === 'games') return

    // Reset acquisition flag whenever we (re-)enter calibration.
    gazeStreamAcquiredRef.current = false

    window.gazeAPI.startStream((gp) => {
      // Calibration: GPU-composited transform, zero layout cost
      if (gp.x == null || gp.valid === false) {
        const el = gazeCursorRef.current
        if (el) el.style.display = 'none'
        setIsGazePresent(false)
        gazeFilteredRef.current = null
        return
      }

      setIsGazePresent(true)
      setGazePresencePct(100)

      // ── One-shot: stop counter on first valid gaze point ─────────────────
      if (!gazeStreamAcquiredRef.current) {
        gazeStreamAcquiredRef.current = true
        clearInterval(gazeWaitTimerRef.current)
        gazeWaitTimerRef.current = null
        const elapsedS = Math.floor((Date.now() - gazeWaitStartRef.current) / 1000)
        setStatusMsg(`Gaze stream established in ${elapsedS} s`)
      }

      const el = gazeCursorRef.current
      if (el) {
        const px = gp.x * window.innerWidth
        const py = gp.y * window.innerHeight
        el.style.transform = `translate(${px}px, ${py}px)`
        el.style.display = 'block'
      }
      // Keep overlay in sync even during calibration
      gazeOverlayMoveRef.current?.({ x: gp.x, y: gp.y })
      gazeFilteredRef.current = { x: gp.x, y: gp.y, timestamp: gp.timestamp || Date.now() }
    })

    return () => {
      // Don't stop the stream on unmount — the mode transition to 'aac'
      // will cause the router to call startStream() which replaces the listener.
      // Only stop if we're truly unmounting while still in calibration.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // ── Speak helper — delegates entirely to native SAPI in the main process ─────
  //
  // window.speechSynthesis.speak() blocks the renderer's main JS thread on
  // Windows Chromium for 50-200 ms per utterance, freezing IPC gaze callbacks
  // and causing visible cursor lag.  All TTS is now handled by the main process
  // via a persistent PowerShell + SAPI child process (see electron/main.js).
  // SpeakAsync() runs on a .NET background thread — zero impact on the renderer.
  const speak = useCallback((text) => {
    // Basic echo cancellation: estimate TTS duration (75ms/char + 1s buffer)
    window.__ttsEndTime = Date.now() + text.length * 75 + 1000
    window.gazeAPI?.speak(text)   // IPC → main process → PowerShell SpeakAsync()
  }, [])

  // ── Navigation click sound helper ─────────────────────────────────────────
  // Synthesises a short, discreet audio cue using the Web Audio API whenever
  // a non-word button fires (Home, Back, Backspace, Clear, sub-page nav).
  // Runs entirely in the renderer — zero IPC cost.
  const audioCtxRef = useRef(null)
  const playNavClick = useCallback(() => {
    if (!settings.navClickSound) return
    // Lazy-create AudioContext on first use (respects browser autoplay policy)
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      try { audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)() }
      catch { return }
    }
    const ctx = audioCtxRef.current
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})

    const vol    = settings.navClickVolume ?? 0.35
    const tone   = settings.navClickTone  ?? 'soft'
    const now    = ctx.currentTime

    const gain = ctx.createGain()
    gain.connect(ctx.destination)

    if (tone === 'soft') {
      // Sine chime: 880 Hz, 120 ms fade-out
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, now)
      osc.frequency.exponentialRampToValueAtTime(660, now + 0.08)
      gain.gain.setValueAtTime(vol * 0.6, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)
      osc.connect(gain)
      osc.start(now)
      osc.stop(now + 0.13)
    } else if (tone === 'tick') {
      // White-noise burst filtered to a sharp click: 20 ms
      const bufSize = Math.floor(ctx.sampleRate * 0.02)
      const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1)
      const src = ctx.createBufferSource()
      src.buffer = buf
      const filter = ctx.createBiquadFilter()
      filter.type = 'highpass'
      filter.frequency.value = 4000
      src.connect(filter)
      filter.connect(gain)
      gain.gain.setValueAtTime(vol * 0.9, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.02)
      src.start(now)
    } else if (tone === 'pop') {
      // Short square + rapid pitch drop: 1200 → 400 Hz, 60 ms
      const osc = ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.setValueAtTime(1200, now)
      osc.frequency.exponentialRampToValueAtTime(400, now + 0.04)
      gain.gain.setValueAtTime(vol * 0.5, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06)
      osc.connect(gain)
      osc.start(now)
      osc.stop(now + 0.07)
    }
  }, [settings.navClickSound, settings.navClickVolume, settings.navClickTone])

  // Synthesises a clean, sharp digital click sound for successful dwell activations.
  const playGenericClick = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      try { audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)() }
      catch { return }
    }
    const ctx = audioCtxRef.current
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})

    const now  = ctx.currentTime
    const gain = ctx.createGain()
    gain.connect(ctx.destination)

    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(1200, now)
    osc.frequency.exponentialRampToValueAtTime(120, now + 0.04)

    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(0.2, now + 0.003)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04)

    osc.connect(gain)
    osc.start(now)
    osc.stop(now + 0.05)
  }, [])

  // Plays a cell's custom prescribed sound URL.
  const playCellSound = useCallback((soundUrl) => {
    if (!soundUrl) return
    try {
      const audio = new Audio(soundUrl)
      audio.preload = 'auto'
      audio.play().catch(e => console.warn('[App] Failed to play cell soundUrl:', e))
    } catch (e) {
      console.warn('[App] Error playing cell soundUrl:', e)
    }
  }, [])



  // ── M5: SessionLogger lifecycle ────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'aac') return
    const logger = new SessionLogger()
    sessionRef.current = logger
    return () => {
      logger.flush()
      sessionRef.current = null
    }
  }, [mode])

  // ── Cell activation handler ────────────────────────────────────────────────
  /**
   * Handles all cell dwell activations from TelemetryRouter.
   *
   * Routing priority (OBF-native):
   *   1. Utility actions  — cell.action ('clear' | 'home') or category === 'utility'
   *   2. Board navigation — cell.loadBoardId (OBF load_board link)
   *   3. Regular vocabulary words → push to phrase + optional immediate speak
   */
  const handleActivate = useCallback((cellId, isDwell = false) => {
    // ── Contextual Response tile routing ────────────────────────────────────
    if (cellId.startsWith('ctx-r')) {
      const idx = parseInt(cellId.replace('ctx-r', ''), 10)
      const text = contextualResponses[idx]
      if (!text) return
      // Single Reply mode: if another tile is already locked, ignore activation
      if (singleReplyMode && lockedResponseIdx !== -1 && lockedResponseIdx !== idx) return
      routerRef.current?._dwellTimer?.reset()
      
      if (isDwell) playGenericClick()

      const action = settings.contextualResponseAction ?? 'both'
      if (action === 'push' || action === 'both') pushWord(text, cellId)
      if (action === 'speak' || action === 'both') speak(text)
      sessionRef.current?.recordActivation(text)
      // Record which response was chosen (supports multiple per context)
      window.gazeAPI?.aiHistory?.recordChoice?.(text).catch(
        e => console.warn('[App] Failed to record AI history choice:', e)
      )
      // Single Reply mode: lock this tile after selection
      if (singleReplyMode) setLockedResponseIdx(idx)
      return
    }

    // ── TopBar button routing (dwell from TopBar) ───────────────────────────
    if (cellId === 'topbar-home' || cellId === 'topbar-back' ||
        cellId === 'topbar-backspace' || cellId === 'topbar-clear' ||
        cellId === 'topbar-speak' || cellId === 'topbar-action') {
      routerRef.current?._dwellTimer.reset()
      
      if (isDwell) {
        playGenericClick()
      } else {
        if (cellId === 'topbar-home' || cellId === 'topbar-back' ||
            cellId === 'topbar-backspace' || cellId === 'topbar-clear') {
          playNavClick()
        }
      }

      if (cellId === 'topbar-home')      { goHome(); return }
      if (cellId === 'topbar-back')      { goBack(); return }
      if (cellId === 'topbar-backspace') { deleteWord(); return }
      if (cellId === 'topbar-clear')     { clearPhrase(); speak('Cleared'); return }
      if (cellId === 'topbar-speak')     { speakPhrase(); return }
      if (cellId === 'topbar-action') {
        // 'proceed' mode: unlock the Manual AnswerGate
        // Use manualGatePendingRef (always live) rather than the stale closure value
        if (manualGatePendingRef.current) {
          manualGatePendingRef.current = false
          setManualGatePending(false)
          contextualGateUnlockedRef.current = true
          // Also update the grid's visual gate state and play the chime
          // (mirrors what the click-based onActionClick handler does)
          gateUnlockTriggerRef.current?.()
        } else if (settings.contextualResponseEnabled && (settings.answerGateMs ?? 0) === -1 && contextualResponses.length > 0) {
          // 'lock' mode: relock the Manual AnswerGate
          gateLockTriggerRef.current?.()
        }
        // 'again' mode: reset Single Reply lock so all tiles are selectable again
        if (singleReplyMode && lockedResponseIdx !== -1) {
          setLockedResponseIdx(-1)
        }
        return
      }
    }


    let cell = null
    if (cellId.startsWith('base-')) {
      const realCellId = cellId.replace('base-', '')
      cell = baseBoardCells.find(c => c.id === realCellId)
    } else {
      cell = activeCells.find(c => c.id === cellId)
    }
    if (!cell) return

    // Reset the dwell timer immediately so gaze is responsive right after
    // activation — no lag waiting for the user to move off the cell.
    routerRef.current?._dwellTimer.reset()

    // Play dwell sound feedback (clicks/mouse-clicks are handled by the GazeButton's onClick, which plays soundUrl)
    if (isDwell) {
      if (cell.soundUrl) {
        playCellSound(cell.soundUrl)
      } else {
        playGenericClick()
      }
    }

    // ── OBF action routing ──────────────────────────────────────────────────
    // cell.action is set by OBFParser from ext_gazeaac_action
    if (cell.action === 'clear' || (cell.category === 'utility' && cell.label === 'CLEAR')) {
      if (!isDwell) playNavClick()
      clearPhrase()
      speak('Cleared')
      if (settings.autoReturnHome) goHome()
      return
    }
    if (cell.action === 'home' || (cell.category === 'utility' && cell.label === 'HOME')) {
      if (!isDwell) playNavClick()
      goHome()
      return
    }

    // ── Legacy utility cells (END, ABC) ────────────────────────────────────
    if (cell.category === 'utility') {
      if (cell.label === 'END')  { speakPhrase(); return }
      if (cell.label === 'ABC')  { openSettings('eye'); return }
      return
    }

    // ── OBF board navigation (load_board link) ──────────────────────────────
    // Works both from the home board (verb → sub-page) and from sub-pages
    // that have cross-links.
    // Per OBF spec, ext_coughdrop_add_vocalization controls whether the button
    // label is spoken when navigating. Verb buttons (e.g. "want") carry this
    // flag → speak + navigate. Silent pronoun shortcuts (e.g. root "it") do
    // not carry this flag → navigate only, no speech here. The word "it" is
    // only spoken when the user selects the plain vocabulary button on the
    // "it" sub-board (which has no load_board and falls through to pushWord).
    // If the target IS the root board, call goHome() so stage masking is
    // reapplied correctly (e.g. Core 24 "it" on a sub-page links back to root).
    if (cell.loadBoardId) {
      if (!isDwell) playNavClick()
      if (cell.addVocalization) speak(cell.label)
      if (cell.loadBoardId === rootBoardId) {
        goHome()
      } else {
        navigateTo(cell.loadBoardId)
      }
      return
    }

    // ── Legacy NAV_VERB_PAGES fallback (legacy JSON mode only) ──────────────
    // In OBF mode cells have loadBoardId set; this only fires in fallback mode.
    const legacyPageId = activePage === 'home' ? NAV_VERB_PAGES[cell.label.toUpperCase()] : null
    if (legacyPageId) {
      speak(cell.label)
      navigateTo(legacyPageId)
      return
    }

    // ── Regular vocabulary word ─────────────────────────────────────────────
    pushWord(cell.label, cellId)
    if (settings.speakOnWord) speak(cell.label)
    // M5: record activation in session logger
    sessionRef.current?.recordActivation(cell.label)

    // ── LAMP WFL motor planning: auto-return to home after sub-page selection
    if (activePage !== 'home' && cell.category !== 'utility' && settings.autoReturnFromSubPage) {
      setTimeout(() => goHome(), 350)
    }
  }, [activeCells, baseBoardCells, speak, playNavClick, playGenericClick, playCellSound, pushWord, clearPhrase, speakPhrase, navigateTo, goHome, goBack, deleteWord, activePage, rootBoardId, settings.autoReturnHome, settings.speakOnWord, settings.autoReturnFromSubPage, contextualResponses, settings.contextualResponseAction, singleReplyMode, lockedResponseIdx, setLockedResponseIdx])

  // Keep the ref in sync with the latest handleActivate without triggering
  // any effects that depend on the router. This is the pattern that prevents
  // the router from restarting every time vocabulary state changes.
  handleActivateRef.current = handleActivate

  // ── Load BaseBoard (baseboard.obz) for AI mode ─────────────────────────────
  const { library, applyEdits } = useAACBoards()

  useEffect(() => {
    const entry = library.find(e => e.fileName === 'baseboard.obz')
    if (!entry) return

    if (!entry.loaded) {
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        setBaseBoardLoading(true)
        const board = await entry.boardSet.getBoard(entry.rootId)
        if (!board || cancelled) return
        
        let rawCells = boardModelToCells(board)
        rawCells = applyEdits(rawCells, entry.fileName, entry.rootId)
        
        // BaseBoard always shows all cells active (no stage masking)
        const staged = rawCells.map(c => ({ ...c, active: !!c.label }))
        
        setBaseBoardCells(staged)
        setBaseBoardCols(board.columns)
        setBaseBoardRows(board.rows)
        setBaseBoardLoading(false)
        console.log(`[App] BaseBoard loaded successfully: "${board.name}" (${board.columns}×${board.rows})`)
      } catch (err) {
        console.error('[App] Failed to load BaseBoard:', err)
        setBaseBoardLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [library, applyEdits])

  // ── Grid measurement → TelemetryRouter registration ───────────────────────
  const updateRouterGrid = useCallback(() => {
    if (!routerRef.current) return

    const topBarCells = topBarMeasureRef.current?.() ?? []
    let allCells = [...topBarCells]

    if (settings.contextualResponseEnabled) {
      allCells = [...allCells, ...aiGridCellsRef.current]
      if (baseBoardEnabled) {
        allCells = [...allCells, ...baseBoardGridCellsRef.current]
      }
    } else {
      allCells = [...allCells, ...vocabGridCellsRef.current]
    }

    routerRef.current.registerGrid(allCells)
    console.log(`[App] TelemetryRouter.registerGrid() updated with ${allCells.length} total cells (AI: ${settings.contextualResponseEnabled}, BaseBoard: ${baseBoardEnabled})`)
  }, [settings.contextualResponseEnabled, baseBoardEnabled])

  // Sync grid registration immediately on layout mode or base board toggle change
  useEffect(() => {
    updateRouterGrid()
  }, [updateRouterGrid])

  const handleVocabGridMeasured = useCallback((measured) => {
    vocabGridCellsRef.current = measured
    updateRouterGrid()
  }, [updateRouterGrid])

  const handleAiGridMeasured = useCallback((measured) => {
    aiGridCellsRef.current = measured
    updateRouterGrid()
  }, [updateRouterGrid])

  const handleBaseBoardGridMeasured = useCallback((measured) => {
    baseBoardGridCellsRef.current = measured
    updateRouterGrid()
  }, [updateRouterGrid])

  // ── TelemetryRouter lifecycle ──────────────────────────────────────────────
  //
  // UNIFIED: The router now runs for ALL interactive modes (home, movie, aac, games),
  // not just aac. Each mode registers its own hit targets via registerGrid().
  // The onDwell callback dispatches to the active mode's handler via refs.
  //
  // IMPORTANT: `settings` is intentionally omitted from this effect's dep array.
  // Individual effects below patch dwellMs / decayHalfLifeMs / maxDropoutMs at
  // runtime via the router's setter methods — no teardown needed.
  //
  // Including `settings` here was the root cause of a bug where closing the
  // Settings Modal restarted the router with an empty cell registry, causing
  // gaze dwell to silently stop working until a click re-triggered grid
  // measurement in GridRenderer.

  const setScreenDwellClickEnabled = useCallback((active, onScreenDwellClick) => {
    routerRef.current?.setScreenDwellClickEnabled(active, onScreenDwellClick)
  }, [])

  // Keep modeRef in sync so callbacks always read fresh mode
  useEffect(() => {
    modeRef.current = mode
    if (mode === 'calibration' && gazeCursorRef.current) {
      gazeCursorRef.current.style.display = 'none'
    }
    if (mode !== 'movie') {
      setIsOverlayActive(false)
      window.gazeAPI?.exitOverlayMode?.()
      window.gazeAPI?.closeChrome?.()
    }
  }, [mode])

  useEffect(() => {
    // Only skip for auth/calibration — those use raw cursor tracking
    if (mode === 'auth' || mode === 'calibration') return

    const router = new TelemetryRouter({
      filterOptions: {
        processNoise:     settings.processNoise,
        measurementNoise: settings.measurementNoise,
        saccadeThreshold: settings.saccadeThreshold
      },
      dwellMs: settings.dwellMs,
      decayHalfLifeMs: settings.decayHalfLifeMs,
      maxDropoutMs: settings.maxDropoutMs,
      postActivationCooldownMs: settings.postActivationCooldownMs,
      isContextualGateLocked: () => {
        // Only applies in AAC mode
        if (modeRef.current !== 'aac') return false
        const ms = settings.answerGateMs
        if (ms === -1) return !contextualGateUnlockedRef.current
        return ms > 0 && !contextualGateUnlockedRef.current
      },
      isMouseMode: () => settings.mouseHoverMode,

      // ── Presence callback ────────────────────────────────────────────────
      onPresenceChange: (isPresent, presenceRate) => {
        setIsGazePresent(isPresent)
        setGazePresencePct(Math.round(presenceRate * 100))
      },

      // ── Unified onDwell: dispatch to active mode's handler via refs ──────
      onDwell: (cellId, metrics) => {
        const m = modeRef.current
        if (m === 'aac') {
          handleActivateRef.current?.(cellId, true)
          // Implicit calibration sampling (AAC only)
          if (settings.implicitCalibrationEnabled && calibrationEngineRef.current) {
            const cells = routerRef.current?._cells
            const cell = cells?.find(c => c.id === cellId)
            const gaze = gazeFilteredRef.current
            if (cell && gaze) {
              const targetX = (cell.x0 + cell.x1) / 2
              const targetY = (cell.y0 + cell.y1) / 2

              // Dwell Stability Filter: only add implicit sample if gaze SD is low
              const maxDwellStdDev = 0.035
              if (!metrics || metrics.stdDev < maxDwellStdDev) {
                calibrationEngineRef.current.addImplicitSample(
                  { x: gaze.x, y: gaze.y },
                  { x: targetX, y: targetY }
                )
                const engine = calibrationEngineRef.current
                setGazeQualityLevel(engine.getQualityLevel())
                setGazeQualityPct(Math.round(engine.getQuality() * 100))

                // Recalculate drift and accuracy metrics
                const drift = engine.getDrift()
                setGazeDriftPct(Math.round(drift.distance * 100))
                setGazeDriftPx(Math.round(drift.distance * Math.sqrt(window.innerWidth * window.innerWidth + window.innerHeight * window.innerHeight)))
                setGazeAccuracyPct(Math.round(engine.getQuality() * 100))

                implicitSampleCountRef.current++
                if (implicitSampleCountRef.current % 5 === 0) {
                  const correction = engine.toJSON()
                  window.gazeAPI?.gazeCorrection?.set(correction)
                  updateSetting('gazeCorrection', correction)
                }
              } else {
                console.log(`[Implicit Calibration] Discarded sample due to high jitter (stdDev: ${metrics.stdDev.toFixed(4)})`)
              }
            }
          }
        } else if (m === 'home') {
          homeDwellRef.current?.(cellId)
        } else if (m === 'movie') {
          movieDwellRef.current?.(cellId)
        } else if (m === 'games') {
          gamesDwellRef.current?.(cellId)
        } else if (m === 'qa') {
          qaDwellRef.current?.(cellId)
        }
      },

      // ── Unified onGaze: cursor + overlay + gazeState ──────────────────────
      onGaze: (event) => {
        const m = modeRef.current

        // ── Cursor positioning (all modes) ────────────────────────────────────
        const el = gazeCursorRef.current
        if (el) {
          const pos = event.raw
          if (pos) {
            const px = pos.x * window.innerWidth
            const py = pos.y * window.innerHeight
            el.style.transform = `translate(${px}px, ${py}px)`

            // Cursor visibility: mode-specific logic
            if (m === 'aac') {
              const hide = !settings.showGazeCursor || settings.feedbackPattern === 'border'
              el.style.display = hide ? 'none' : 'block'
            } else if (m === 'movie') {
              // MovieTime controls visibility via movieCursorStyleRef
              const shouldHide = movieCursorStyleRef.current?.shouldHide
              el.style.display = shouldHide ? 'none' : 'block'
            } else {
              el.style.display = 'block'
            }
          } else {
            el.style.display = 'none'
          }
        }

        // ── Overlay update (AAC mode only) ───────────────────────────────────
        if (m === 'aac') {
          const overlayPos = event.filtered ?? event.raw
          if (overlayPos) gazeOverlayMoveRef.current?.(overlayPos)
        }

        gazeFilteredRef.current = event.filtered
          ? { ...event.filtered, timestamp: event.timestamp || Date.now() }
          : null

        // ── Heatmap coordinate recording (AAC, Movie, Games) ──────────────────
        const pt = event.filtered ?? event.raw
        if (pt && pt.x != null && pt.y != null) {
          if (m === 'aac' || m === 'movie' || m === 'games') {
            recordPoint(m, pt.x, pt.y)
          }
        }

        // ── Throttled state update (all modes) ──────────────────────────────
        setGazeState(prev => {
          if (event.dwellProgress === 1) {
            return { cellId: event.cellId, dwellProgress: 1 }
          }
          if (prev.cellId === event.cellId &&
              Math.abs(prev.dwellProgress - event.dwellProgress) < 0.02) {
            return prev
          }
          return { cellId: event.cellId, dwellProgress: event.dwellProgress }
        })
      },

      // ── Raw gaze forwarding for MovieTime gaze-away detection ─────────────
      onRawGaze: (gazePoint) => {
        if (modeRef.current === 'movie') {
          movieRawGazeRef.current?.(gazePoint)
        }
      }
    })

    router.start()
    routerRef.current = router

    // Immediately re-populate the grid registry so that gaze frames arriving
    // right after startup can hit-test against the already-rendered cells.
    if (mode === 'aac') {
      requestAnimationFrame(() => {
        vocabMeasureTriggerRef.current?.()
        aiMeasureTriggerRef.current?.()
        baseBoardMeasureTriggerRef.current?.()
      })
    }

    // Stamp how long we waited for the stream to be established.
    const elapsedS = Math.floor((Date.now() - gazeWaitStartRef.current) / 1000)
    setStatusMsg(
      vocabLoading
        ? 'Loading vocabulary…'
        : `Gaze stream established in ${elapsedS} s`
    )

    return () => {
      router.stop()
      routerRef.current = null
      setStatusMsg('Gaze stream stopped')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])  // ← intentionally omit handleActivate — the ref wrapper keeps it live

  // ── Update dwell threshold at runtime without restarting router ────────────
  useEffect(() => {
    routerRef.current?.setDwellMs(settings.dwellMs)
  }, [settings.dwellMs])

  // ── Update decay params at runtime ────────────────────────────────────────
  useEffect(() => {
    routerRef.current?.setDecayHalfLifeMs(settings.decayHalfLifeMs)
  }, [settings.decayHalfLifeMs])

  useEffect(() => {
    routerRef.current?.setMaxDropoutMs(settings.maxDropoutMs)
  }, [settings.maxDropoutMs])

  // ── Update Kalman filter params at runtime (no router restart needed) ─────
  useEffect(() => {
    routerRef.current?.setFilterOptions({ processNoise: settings.processNoise })
  }, [settings.processNoise])

  useEffect(() => {
    routerRef.current?.setFilterOptions({ measurementNoise: settings.measurementNoise })
  }, [settings.measurementNoise])

  useEffect(() => {
    routerRef.current?.setFilterOptions({ saccadeThreshold: settings.saccadeThreshold })
  }, [settings.saccadeThreshold])

  // ── Update post-activation cooldown at runtime ─────────────────────────────
  useEffect(() => {
    routerRef.current?.setPostActivationCooldownMs(settings.postActivationCooldownMs)
  }, [settings.postActivationCooldownMs])


  // ── Mouse Hover Mode — feeds mouse position into TelemetryRouter as synthetic gaze ──
  //
  // When mouseHoverMode is enabled, we track the last known cursor position via
  // mousemove and then POLL at ~60 Hz via setInterval, injecting a synthetic gaze
  // frame on every tick — even when the mouse is stationary.
  //
  // WHY: The browser's mousemove event only fires when the pointer physically moves.
  // A stationary mouse produces zero events, so DwellTimer.tick() is never called
  // and dwell progress freezes. By polling the last known position continuously we
  // mirror the behaviour of the Tobii IPC stream, which emits frames at ~60–90 Hz
  // regardless of whether the user's gaze is moving or still.
  //
  // The eye-tracker IPC stream is NOT stopped — if real gaze data arrives it still
  // flows through. Setting mouseHoverMode = false re-enables pure gaze.
  useEffect(() => {
    if (mode === 'auth' || mode === 'calibration') return
    if (!settings.mouseHoverMode) return

    const router = routerRef.current
    if (!router) return

    // Last known normalised cursor position. null until first mousemove.
    let lastPos = null
    let insideWindow = true

    const handleMouseMove = (e) => {
      insideWindow = true
      lastPos = {
        x: e.clientX / window.innerWidth,
        y: e.clientY / window.innerHeight,
      }
    }

    // Mouse leave → mark as outside so the poll loop emits dropout frames
    // until the cursor returns. This lets dwell decay cleanly when the user
    // moves to another app or the OS taskbar.
    const handleMouseLeave = () => {
      insideWindow = false
    }

    const handleMouseEnter = () => {
      insideWindow = true
    }

    // Polling loop — injects a frame at ~60 Hz using the last known position.
    // This is what makes dwell progress while the mouse is stationary.
    const pollInterval = setInterval(() => {
      const ts = performance.now()
      if (!insideWindow || lastPos === null || !document.hasFocus()) {
        // Cursor is outside the window or app is not focused — emit a dropout so dwell decays.
        router._handleRaw({ x: 0, y: 0, timestamp: ts, valid: false })
      } else {
        router._handleRaw({ ...lastPos, timestamp: ts, valid: true })
      }
    }, 16) // ~60 Hz — matches typical eye-tracker sample rate

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseleave', handleMouseLeave)
    window.addEventListener('mouseenter', handleMouseEnter)

    console.log('[App] Mouse Hover Mode active — polling at ~60 Hz via TelemetryRouter')

    return () => {
      clearInterval(pollInterval)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseleave', handleMouseLeave)
      window.removeEventListener('mouseenter', handleMouseEnter)
      console.log('[App] Mouse Hover Mode deactivated')
    }
  }, [mode, settings.mouseHoverMode])

  // ── Apply cursor size & shape to the DOM element ──────────────────────────
  // Runs outside the hot-path so there is zero cost per gaze frame.
  useEffect(() => {
    const el = gazeCursorRef.current
    if (!el) return
    const sz    = settings.cursorSize  ?? 20
    const shape = settings.cursorShape ?? 'circle'
    const color = settings.cursorColor
    // Reset all shape-specific properties so no stale style bleeds across changes
    Object.assign(el.style, {
      width:        `${sz}px`,
      height:       `${sz}px`,
      background:   color,
      border:       'none',
      borderRadius: '50%',
      boxShadow:    `0 0 12px 4px currentColor`,
      filter:       'blur(2px)',
      rotate:       '0deg',
    })
    switch (shape) {
      case 'circle':
        // default — filled circle with blur glow
        break
      case 'ring':
        el.style.background   = 'transparent'
        el.style.border       = `${Math.max(2, sz * 0.18)}px solid ${color}`
        el.style.filter       = 'none'
        el.style.boxShadow    = `0 0 10px 2px ${color}`
        break
      case 'dot': {
        const ds = Math.max(6, sz * 0.55)
        el.style.width        = `${ds}px`
        el.style.height       = `${ds}px`
        el.style.filter       = 'none'
        el.style.boxShadow    = `0 0 8px 3px ${color}`
        break
      }
      case 'crosshair': {
        // Thin vertical bar + box-shadow horizontal arms = CSS crosshair
        const arm  = sz + 10
        const thin = 2
        el.style.width        = `${thin}px`
        el.style.height       = `${arm}px`
        el.style.borderRadius = '1px'
        el.style.filter       = 'none'
        el.style.boxShadow    = [
          `${arm / 2}px 0 0 0 ${color}`,
          `-${arm / 2}px 0 0 0 ${color}`,
          `0 0 8px 2px ${color}`,
        ].join(', ')
        break
      }
      case 'diamond':
        el.style.borderRadius = '3px'
        el.style.rotate       = '45deg'
        el.style.filter       = 'none'
        el.style.boxShadow    = `0 0 10px 2px ${color}`
        break
      default:
        break
    }
  }, [settings.cursorSize, settings.cursorShape, settings.cursorColor])


  // ── Update status bar when vocab loads ────────────────────────────────────
  useEffect(() => {
    if (mode === 'aac' && !vocabLoading) {
      const elapsedS = Math.floor((Date.now() - gazeWaitStartRef.current) / 1000)
      setStatusMsg(`Gaze stream established in ${elapsedS} s`)
    }
  }, [vocabLoading, mode])

  // ── Pause gaze dwell when any overlay covers the board or when typing ──
  // Settings Modal, PIN Gate, and Caregiver Panel all obscure the grid.
  // We also pause when the user is actively typing in a text field or textarea
  // to prevent accidental gaze dwell activations from firing.
  // The gaze cursor dot keeps rendering so cursor feedback is still visible.
  useEffect(() => {
    if (!routerRef.current) return
    const boardBlocked = showSettings || showCaregiverPanel || showBoardSelector || !!boardEditorId || inputFocused
    if (boardBlocked) {
      routerRef.current.pause()
      setStatusMsg(inputFocused ? 'Gaze paused (typing...)' : 'Gaze paused (overlay active)')
    } else {
      // Only resume if the app window is actually focused — if another app is
      // covering GazeAAC, the focus-loss effect already paused the router and
      // will resume it when focus returns, not here.
      if (document.hasFocus()) {
        routerRef.current.resume()
        setStatusMsg(`Gaze stream active (${getTobiiStatusText(trackerMode)})`)
      }
    }
  }, [showSettings, showCaregiverPanel, showBoardSelector, boardEditorId, inputFocused, trackerMode])

  // ── Pause gaze dwell when the app window loses OS focus ───────────────────
  // If another application is covering GazeAAC (e.g. brought to the foreground),
  // the Electron renderer fires a window 'blur' event. We pause the router so
  // no accidental dwell can accumulate through an occluding window.
  // We also pause on the Page Visibility API ('visibilitychange') for robustness.
  // The overlay-pause effect above already handles in-app modals — this effect
  // exclusively handles OS-level window occlusion / focus loss.
  useEffect(() => {
    if (mode === 'auth' || mode === 'calibration') return

    if (!isOverlayActive && !document.hasFocus()) {
      if (routerRef.current && !routerRef.current._paused) {
        routerRef.current.pause()
        setStatusMsg('Gaze paused (app not focused)')
        console.log('[App] Overlay inactive & not focused — pausing gaze on setup')
      }
    }

    const handleWindowBlur = () => {
      setIsAppFocused(false)
      if (!routerRef.current) return
      // If overlay is active, do not pause the router on blur (Chrome is focused, but user is choosing questions)
      if (isOverlayActive) {
        console.log('[App] Window lost OS focus but overlay is active — keeping gaze active')
        return
      }
      // Don't double-pause if already paused by the overlay effect
      if (routerRef.current._paused) return
      routerRef.current.pause()
      setStatusMsg('Gaze paused (app not focused)')
      console.log('[App] Window lost OS focus — gaze dwell paused')
    }

    const handleWindowFocus = () => {
      setIsAppFocused(true)
      if (!routerRef.current) return
      // Only resume if no in-app overlay is covering the board
      const boardBlocked = showSettings || showCaregiverPanel
      if (boardBlocked) return
      routerRef.current.resume()
      setStatusMsg(`Gaze stream active (${getTobiiStatusText(trackerMode)})`)
      console.log('[App] Window regained OS focus — gaze dwell resumed')
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        handleWindowBlur()
      } else {
        handleWindowFocus()
      }
    }

    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('focus', handleWindowFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('focus', handleWindowFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [mode, showSettings, showCaregiverPanel, trackerMode, isOverlayActive])

  // ── Dynamic mouse-ignore toggle for transparent overlay mode ──────────────
  useEffect(() => {
    if (!window.gazeAPI?.setIgnoreMouseEvents) return

    const shouldIgnore = isOverlayActive &&
      !isQuizActive &&
      !isHoveringTitlebar &&
      !showSettings &&
      !showCaregiverPanel &&
      !showGearPopover &&
      !showBoardSelector &&
      !boardEditorId &&
      !showGazeHUD

    if (shouldIgnore) {
      window.gazeAPI.setIgnoreMouseEvents(true, { forward: true })
    } else {
      window.gazeAPI.setIgnoreMouseEvents(false)
    }
  }, [
    isOverlayActive,
    isQuizActive,
    isHoveringTitlebar,
    showSettings,
    showCaregiverPanel,
    showGearPopover,
    showBoardSelector,
    boardEditorId,
    showGazeHUD
  ])

  // ── Status bar: reflect Mouse Hover Mode ──────────────────────────────────
  useEffect(() => {
    if (mode !== 'aac') return
    if (showSettings || showCaregiverPanel) return  // overlay message takes priority
    if (settings.mouseHoverMode) {
      const isRealTracker = trackerMode === 'tobii'
      setStatusMsg(isRealTracker
        ? 'Mouse Hover Mode active (alongside eye tracker)'
        : 'Mouse hover active — no eye tracker detected')
    }
  }, [mode, settings.mouseHoverMode, showSettings, showCaregiverPanel, trackerMode])

  // Clear contextual response states when contextual mode is turned off;
  // clear the phrase bar (words field) when contextual mode is turned on.
  useEffect(() => {
    if (settings.contextualResponseEnabled) {
      clearPhrase()
    } else {
      setContextualResponses([])
      setContextualActiveModel(null)
      setContextualFallbackReason(null)
    }
  }, [settings.contextualResponseEnabled]) // eslint-disable-line react-hooks/exhaustive-deps


  return (
    <div className={`app${isOverlayActive ? ' app--transparent' : ''}${isOverlayActive && !isAppFocused ? ' app--transparent-blurred' : ''}`}>
      {/* ── Frameless title bar ────────────────────────────────────────── */}
      <header
        className="app__titlebar"
        data-electron-drag
        onMouseDown={() => {
          window.gazeAPI?.windowControl?.('focus')
        }}
        onMouseEnter={() => setIsHoveringTitlebar(true)}
        onMouseLeave={() => setIsHoveringTitlebar(false)}
      >
        <div
          className="app__titlebar-brand"
          onDoubleClick={() => {
            if (mode !== 'auth' && mode !== 'calibration') { setMode('home'); setGameId(null) }
          }}
          title={mode !== 'auth' && mode !== 'calibration' ? 'Double-click to go to landing page' : undefined}
          style={{ cursor: mode !== 'auth' && mode !== 'calibration' ? 'pointer' : undefined }}
        >
          <span className="app__titlebar-logo">GazeAAC</span>
          {appVersion && <span className="app__titlebar-version">v{appVersion}</span>}
        </div>

        {/* M4: Navigation breadcrumb (only visible in AAC mode) */}
        {mode === 'aac' && (
          <div className="app__titlebar-nav">
            <NavBreadcrumb />

            {/* ── Mode toggle: Board ↔ AI Contextual ─────────────── */}
            <button
              id="titlebar-mode-toggle"
              className={`app__mode-toggle ${settings.contextualResponseEnabled ? 'app__mode-toggle--contextual' : 'app__mode-toggle--board'}`}
              aria-label={settings.contextualResponseEnabled ? 'Switch to Regular Board mode' : 'Switch to Contextual Response mode'}
              title={settings.contextualResponseEnabled ? 'AI Contextual mode — click for Board' : 'Board mode — click for AI Contextual'}
              onClick={() => updateSetting('contextualResponseEnabled', !settings.contextualResponseEnabled)}
            >
              <span className="app__mode-toggle-track">
                <span className="app__mode-toggle-thumb" />
              </span>
              <span className="app__mode-toggle-labels">
                <span className="app__mode-toggle-label app__mode-toggle-label--board">Board</span>
                <span className="app__mode-toggle-label app__mode-toggle-label--ctx">AI</span>
              </span>
            </button>

            {/* ── BaseBoard toggle (only visible in AI/contextual mode) ── */}
            {settings.contextualResponseEnabled && (
              <button
                id="titlebar-baseboard-toggle"
                className={`app__mode-toggle app__baseboard-toggle ${baseBoardEnabled ? 'app__baseboard-toggle--on' : 'app__baseboard-toggle--off'}`}
                aria-label={baseBoardEnabled ? 'Hide BaseBoard' : 'Show BaseBoard'}
                title={baseBoardEnabled ? 'BaseBoard on — click to hide' : 'BaseBoard off — click to show'}
                onClick={() => setBaseBoardEnabled(v => !v)}
              >
                <span className="app__mode-toggle-track">
                  <span className="app__mode-toggle-thumb" />
                </span>
                <span className="app__mode-toggle-labels">
                  <span className="app__mode-toggle-label app__mode-toggle-label--base">Base</span>
                  <span className="app__mode-toggle-label app__mode-toggle-label--base2">Board</span>
                </span>
              </button>
            )}

            {/* ── Single Reply toggle (only visible in AI/contextual mode) ── */}
            {settings.contextualResponseEnabled && (
              <button
                id="titlebar-singlereply-toggle"
                className={`app__mode-toggle app__singlereply-toggle ${singleReplyMode ? 'app__singlereply-toggle--on' : 'app__singlereply-toggle--off'}`}
                aria-label={singleReplyMode ? 'Single Reply mode on — click to disable' : 'Single Reply mode off — click to enable'}
                title={singleReplyMode ? 'Single Reply on — one selection locks others' : 'Single Reply off — click to enable'}
                onClick={() => { setSingleReplyMode(v => !v); setLockedResponseIdx(-1) }}
              >
                <span className="app__mode-toggle-track">
                  <span className="app__mode-toggle-thumb" />
                </span>
                <span className="app__mode-toggle-labels">
                  <span className="app__mode-toggle-label app__mode-toggle-label--sr1">Single</span>
                  <span className="app__mode-toggle-label app__mode-toggle-label--sr2">Reply</span>
                </span>
              </button>
            )}

            {/* ── AnswerGate quick toggle (only visible in AI/contextual mode) ── */}
            {settings.contextualResponseEnabled && (
              <button
                id="titlebar-answergate-toggle"
                className={`app__mode-toggle app__answergate-toggle ${
                  (settings.answerGateMs ?? 0) === -1
                    ? 'app__answergate-toggle--manual'
                    : 'app__answergate-toggle--timer'
                }`}
                aria-label={
                  (settings.answerGateMs ?? 0) === -1
                    ? 'Answer Gate: Manual — click for Timer'
                    : 'Answer Gate: Timer — click for Manual'
                }
                title={
                  (settings.answerGateMs ?? 0) === -1
                    ? 'Gate: Manual — Proceed button required'
                    : `Gate: Timer (${(settings.answerGateMs ?? 0) === 0 ? 'Off' : ((settings.answerGateMs ?? 0) / 1000).toFixed(1) + ' s'}) — click for Manual`
                }
                onClick={() => {
                  if ((settings.answerGateMs ?? 0) === -1) {
                    // Switch to timer mode — restore a 2 s default
                    updateSetting('answerGateMs', 2000)
                    setManualGatePending(false)
                    contextualGateUnlockedRef.current = true
                  } else {
                    // Switch to manual mode
                    updateSetting('answerGateMs', -1)
                  }
                }}
              >
                <span className="app__mode-toggle-track">
                  <span className="app__mode-toggle-thumb" />
                </span>
                <span className="app__mode-toggle-labels">
                  <span className="app__mode-toggle-label app__mode-toggle-label--gate1">Gate</span>
                  <span className="app__mode-toggle-label app__mode-toggle-label--gate2">
                    {(settings.answerGateMs ?? 0) === -1 ? 'Manual' : 'Timer'}
                  </span>
                </span>
              </button>
            )}

            {/* ── Video Augmentation quick toggle (only visible in AI/contextual mode) ── */}
            {settings.contextualResponseEnabled && (
              <button
                id="titlebar-videoaugmentation-toggle"
                className={`app__mode-toggle app__videoaugmentation-toggle ${
                  settings.cameraAugmentationEnabled
                    ? 'app__videoaugmentation-toggle--on'
                    : 'app__videoaugmentation-toggle--off'
                }`}
                aria-label={
                  settings.cameraAugmentationEnabled
                    ? 'Video Augmentation: On — click to disable'
                    : 'Video Augmentation: Off — click to enable'
                }
                title={
                  settings.cameraAugmentationEnabled
                    ? 'Video Augmentation: On — click to disable'
                    : 'Video Augmentation: Off — click to enable'
                }
                onClick={() => updateSetting('cameraAugmentationEnabled', !settings.cameraAugmentationEnabled)}
              >
                <span className="app__mode-toggle-track">
                  <span className="app__mode-toggle-thumb" />
                </span>
                <span className="app__mode-toggle-labels">
                  <span className="app__mode-toggle-label app__mode-toggle-label--va1">Video</span>
                  <span className="app__mode-toggle-label app__mode-toggle-label--va2">Aug</span>
                </span>
              </button>
            )}
          </div>
        )}

        {contextualFallbackReason && (
          <div
            className="app__titlebar-fallback-alert"
            title={`Internet model failed, fell back to ${
              contextualActiveModel === 'fallback' ? 'default phrases'
              : contextualActiveModel === 'gemini-nano' ? 'Gemini Nano'
              : contextualActiveModel?.startsWith?.('gemini-cloud/') ? `Gemini Cloud (${contextualActiveModel.replace('gemini-cloud/', '')})`
              : `llama (${contextualActiveModel?.replace?.('ollama/', '') || 'local model'})`
            }: ${contextualFallbackReason}\n\nClick to copy full error details.`}
            onClick={() => {
              navigator.clipboard.writeText(contextualFallbackReason)
              alert(`Internet model failed, fell back to local model.\n\nError details:\n${contextualFallbackReason}\n\n(Copied to clipboard)`)
            }}
          >
            <span className="app__titlebar-fallback-icon">⚠️</span>
            <span className="app__titlebar-fallback-text">
              Internet model failed: {contextualFallbackReason}
            </span>
          </div>
        )}

        {/* Gaze quality indicator — visible across all gaze-active modes */}
        {mode !== 'auth' && (
          <div style={{ position: 'relative' }}>
            <button
              className={`app__gaze-quality app__gaze-quality--${gazeQualityLevel} app__gaze-quality--interactive`}
              onClick={() => setShowGazeHUD(prev => !prev)}
              aria-label="Toggle gaze diagnostics HUD"
              title="Gaze Diagnostics"
            >
              <span className="app__gaze-quality-dot" />
              <span className="app__gaze-quality-text">
                {gazeQualityLevel === 'none' ? '—'
                  : gazeQualityLevel === 'learning' ? 'Learning…'
                  : gazeQualityLevel.charAt(0).toUpperCase() + gazeQualityLevel.slice(1)}
              </span>
            </button>

            {showGazeHUD && (
              <div
                className="app__gaze-quality-hud"
                onMouseLeave={() => setShowGazeHUD(false)}
              >
                <div className="hud-header">
                  <span className="hud-title">Gaze Health Diagnostics</span>
                  <button className="hud-close-btn" onClick={() => setShowGazeHUD(false)}>✕</button>
                </div>
                
                <div className="hud-metrics-grid">
                  <div className="hud-metric-card">
                    <span className="metric-label">Signal Presence</span>
                    <span className="metric-value">{gazePresencePct}%</span>
                    <div className="metric-progress-track">
                      <div className="metric-progress-fill" style={{ width: `${gazePresencePct}%`, background: gazePresencePct > 80 ? 'var(--color-success)' : gazePresencePct > 40 ? 'var(--color-warning)' : 'var(--color-danger)' }} />
                    </div>
                  </div>
                  
                  <div className="hud-metric-card">
                    <span className="metric-label">Drift Displacement</span>
                    <span className="metric-value">{gazeDriftPx} px ({gazeDriftPct}%)</span>
                    <div className="metric-progress-track">
                      <div className="metric-progress-fill" style={{ width: `${Math.min(100, gazeDriftPct * 5)}%`, background: gazeDriftPct < 5 ? 'var(--color-success)' : gazeDriftPct < 15 ? 'var(--color-warning)' : 'var(--color-danger)' }} />
                    </div>
                  </div>

                  <div className="hud-metric-card">
                    <span className="metric-label">Tracking Accuracy</span>
                    <span className="metric-value">{gazeAccuracyPct}%</span>
                    <div className="metric-progress-track">
                      <div className="metric-progress-fill" style={{ width: `${gazeAccuracyPct}%`, background: gazeAccuracyPct > 80 ? 'var(--color-success)' : gazeAccuracyPct > 50 ? 'var(--color-warning)' : 'var(--color-danger)' }} />
                    </div>
                  </div>

                  <div className="hud-metric-card">
                    <span className="metric-label">Input Source</span>
                    <span className="metric-value text-capitalize">{getTobiiStatusText(trackerMode)}</span>
                  </div>
                </div>

                <div className="hud-tips-box">
                  <span className="tips-title">💡 Caregiver Troubleshooting Tips</span>
                  <ul className="tips-list">
                    {gazePresencePct < 85 && (
                      <>
                        <li>Adjust user position (50-70cm from screen).</li>
                        <li>Clean the tracker glass lens with a soft cloth.</li>
                        <li>Verify the Tobii tracker USB connection.</li>
                      </>
                    )}
                    {gazePresencePct >= 85 && (gazeQualityLevel === 'poor' || gazeDriftPct > 10) && (
                      <>
                        <li>Recalibrate the tracker for better accuracy.</li>
                        <li>Ask the user to hold their head steady.</li>
                        <li>Minimize glare or direct sunlight on the tracker.</li>
                      </>
                    )}
                    {gazePresencePct >= 85 && gazeQualityLevel === 'none' && (
                      <li>Please perform a 5-point explicit calibration.</li>
                    )}
                    {gazePresencePct >= 85 && gazeQualityLevel !== 'poor' && gazeQualityLevel !== 'none' && (
                      <li>Everything looks healthy! Keep using the board normally.</li>
                    )}
                  </ul>
                </div>

                <div className="hud-actions">
                  <button
                    className="hud-action-btn hud-action-btn--primary"
                    onClick={() => {
                      setMode('calibration')
                      setShowGazeHUD(false)
                    }}
                  >
                    🎯 Recalibrate
                  </button>
                  <button
                    className="hud-action-btn hud-action-btn--secondary"
                    onClick={() => {
                      if (calibrationEngineRef.current) {
                        calibrationEngineRef.current.reset()
                        updateSetting('gazeCorrection', null)
                        setGazeQualityLevel('none')
                        setGazeQualityPct(0)
                        setGazeDriftPct(0)
                        setGazeDriftPx(0)
                        setGazeAccuracyPct(0)
                      }
                      setShowGazeHUD(false)
                    }}
                  >
                    🗑️ Clear Calibration
                  </button>
                  <button
                    className="hud-action-btn hud-action-btn--secondary"
                    onClick={() => {
                      updateSetting('implicitCalibrationEnabled', !settings.implicitCalibrationEnabled)
                    }}
                  >
                    {settings.implicitCalibrationEnabled ? '⏸️ Pause Auto-Adjust' : '▶️ Resume Auto-Adjust'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}


        {mode === 'aac' && <div className="app__titlebar-status">{statusMsg}</div>}
        <div className="app__titlebar-controls">
          {/* 🔥 Heatmap Toggle Button */}
          {(mode === 'aac' || mode === 'movie' || mode === 'games') && (
            <button
              id="btn-toggle-heatmap"
              className={`titlebar-btn titlebar-btn--heatmap${showOverlay ? ' titlebar-btn--heatmap-active' : ''}`}
              aria-label="Toggle gaze heatmap overlay"
              title="Toggle Gaze Heatmap Overlay (Ctrl+Shift+H)"
              onClick={toggleHeatmapOverlay}
            >
              🔥
            </button>
          )}

          {/* Quiz Countdown button (Movie mode only) */}
          {mode === 'movie' && appTitlebarQuizInfo && (
            <button
              className={`titlebar-btn titlebar-btn--quiz-countdown${appTitlebarQuizInfo.nextPuzzleConfirm ? ' titlebar-btn--quiz-countdown--primed' : ''}`}
              onClick={appTitlebarQuizInfo.onQuizButtonClick}
              title={appTitlebarQuizInfo.nextPuzzleConfirm ? 'Click again to start the puzzle now' : 'Click to start the next puzzle early'}
            >
              {appTitlebarQuizInfo.nextPuzzleConfirm ? '▶ Start puzzle' : appTitlebarQuizInfo.puzzleTimerText}
            </button>
          )}

          {/* Gear opens a mini popover — 3 settings + caregiver panel */}
          {(mode === 'aac' || mode === 'movie') && (
            <div 
              ref={gearContainerRef}
              style={{ position: 'relative' }}
            >
              <button
                id="btn-open-settings"
                className="titlebar-btn titlebar-btn--settings"
                aria-label="Open settings"
                title="Settings"
                onClick={() => setShowGearPopover(v => !v)}
              >⚙</button>

              {showGearPopover && (
                <div
                  className="app__gear-popover"
                  role="menu"
                  style={{ background: '#1a1d28', opacity: 1 }}
                >
                  <button
                    className="app__gear-popover-item"
                    role="menuitem"
                    onClick={() => { openSettings('eye'); setShowGearPopover(false) }}
                  >
                    👁 Eye Tracker Settings
                  </button>
                  <button
                    className="app__gear-popover-item"
                    role="menuitem"
                    onClick={() => { openSettings('aac'); setShowGearPopover(false) }}
                  >
                    🗣 AAC Settings
                  </button>
                  <button
                    className="app__gear-popover-item"
                    role="menuitem"
                    onClick={() => { openSettings('board'); setShowGearPopover(false) }}
                  >
                    📋 Board Settings
                  </button>
                  <button
                    className="app__gear-popover-item"
                    role="menuitem"
                    onClick={() => { openSettings('contextual'); setShowGearPopover(false) }}
                  >
                    🧠 Contextual Response
                  </button>
                  <button
                    className="app__gear-popover-item"
                    role="menuitem"
                    onClick={() => { openSettings('camera'); setShowGearPopover(false) }}
                  >
                    📷 Camera &amp; Vision
                  </button>
                  <button
                    className="app__gear-popover-item"
                    role="menuitem"
                    onClick={() => { openSettings('movietime'); setShowGearPopover(false) }}
                  >
                    🎬 Movie Time
                  </button>
                  <button
                    className="app__gear-popover-item"
                    role="menuitem"
                    onClick={() => { toggleHeatmapOverlay(); setShowGearPopover(false) }}
                  >
                    🔥 Toggle Heatmap Overlay
                  </button>
                  <div className="app__gear-popover-divider" />
                  <button
                    className="app__gear-popover-item"
                    role="menuitem"
                    onClick={() => { setShowCaregiverPanel(true); setShowGearPopover(false) }}
                  >
                    ⚙️ User Settings
                  </button>
                  <div className="app__gear-popover-divider" />
                  {currentUser ? (
                    <button
                      id="btn-sign-out"
                      className="app__gear-popover-item app__gear-popover-item--signout"
                      role="menuitem"
                      onClick={async () => {
                        setShowGearPopover(false)
                        try { await signOutCaregiver() } catch (_) {}
                        setMode('auth')
                      }}
                    >
                      🚪 Sign Out
                    </button>
                  ) : (
                    <button
                      id="btn-sign-in"
                      className="app__gear-popover-item app__gear-popover-item--signin"
                      role="menuitem"
                      onClick={() => { setShowGearPopover(false); setMode('auth') }}
                    >
                      🔐 Sign In
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <button
            className="titlebar-btn titlebar-btn--minimize"
            aria-label="Minimize"
            onClick={() => window.gazeAPI?.windowControl('minimize')}
          >─</button>
          <button
            className="titlebar-btn titlebar-btn--maximize"
            aria-label="Maximize"
            onClick={() => window.gazeAPI?.windowControl('maximize')}
          >□</button>
          <button
            className="titlebar-btn titlebar-btn--close"
            aria-label="Close"
            onClick={() => {
              window.gazeAPI?.windowControl?.('close')
            }}
          >✕</button>
        </div>
      </header>

      {/* ── Eyes Lost slide-down banner ────────────────────────────────── */}
      {mode !== 'auth' && mode !== 'calibration' && !isGazePresent && !settings.mouseHoverMode && settings.gazeLostVisualEnabled !== false && (
        <div className="app__eyes-lost-banner">
          <span className="app__eyes-lost-icon">👀</span>
          <span className="app__eyes-lost-text">Eyes Lost — Adjust Position</span>
        </div>
      )}

      {/* ── Main content area ─────────────────────────────────────────── */}
      <main className={[

        'app__main',
        settings.contextualResponseEnabled ? 'app__main--contextual' : '',
        settings.contextualResponseEnabled && baseBoardEnabled ? 'app__main--contextual--baseboard' : '',
        settings.contextualResponseEnabled && settings.cameraAugmentationEnabled && settings.cameraStreamingEnabled ? 'app__main--stream-active' : '',
      ].filter(Boolean).join(' ')}>

        {/* Global gaze cursor — always rendered; position updated via direct DOM
             mutation in onGaze/startStream callbacks so no React render cycle
             stands between the gaze sample and the pixel moving on screen.
             Size/shape/color are applied by the cursorSize+cursorShape effect above. */}
        <div
          ref={gazeCursorRef}
          className="app__gaze-cursor"
          style={{ display: 'none', background: settings.cursorColor }}
          aria-hidden="true"
        />

        <GazeHeatmapOverlay active={showOverlay} mode={mode === 'home' ? 'aac' : mode} />

        {mode === 'auth' && (
          <AuthScreen
            onAuthenticated={() => setMode('calibration')}
            onGuest={() => setMode('calibration')}
            gazeRef={gazeFilteredRef}
            dwellMs={settings.dwellMs}
          />
        )}

        {mode === 'calibration' && (
          <CalibrationScreen
            onComplete={(correctionData) => {
              // If correction data was computed, persist it and update engine
              if (correctionData && calibrationEngineRef.current) {
                calibrationEngineRef.current.fromJSON(correctionData)
                setGazeQualityLevel(calibrationEngineRef.current.getQualityLevel())
                setGazeQualityPct(Math.round(calibrationEngineRef.current.getQuality() * 100))
                updateSetting('gazeCorrection', correctionData)
              }
              setStage(1)
              setMode('home')
            }}
            gazeRef={gazeFilteredRef}
            dwellMs={settings.dwellMs}
            enabled={settings.explicitCalibrationEnabled}
          />
        )}

        {mode === 'home' && (
          <HomeLanding
            onSelectAAC={() => setMode('aac')}
            onSelectMovie={() => setMode('movie')}
            onSelectGames={() => setMode('games')}
            onSelectQA={() => setMode('qa')}
            onOpenSettings={openSettings}
            onOpenCaregiver={() => setShowCaregiverPanel(true)}
            gazeCursorRef={gazeCursorRef}
            registerHitTargets={(cells) => routerRef.current?.registerGrid(cells)}
            gazeState={gazeState}
            onDwellRef={homeDwellRef}
          />
        )}

        {mode === 'movie' && (
          <MovieTime
            onBack={() => setMode('home')}
            onOpenSettings={openSettings}
            gazeCursorRef={gazeCursorRef}
            gazeBlocked={showSettings}
            registerHitTargets={(cells) => routerRef.current?.registerGrid(cells)}
            gazeState={gazeState}
            onDwellRef={movieDwellRef}
            rawGazeRef={movieRawGazeRef}
            cursorStyleRef={movieCursorStyleRef}
            onSetOverlayActive={setIsOverlayActive}
            onSetQuizActive={setIsQuizActive}
            setScreenDwellClickEnabled={setScreenDwellClickEnabled}
            setAppTitlebarQuizInfo={setAppTitlebarQuizInfo}
          />
        )}

        {mode === 'games' && !gameId && (
          <GamesHub
            onBack={() => setMode('home')}
            onSelectGame={(id) => setGameId(id)}
            gazeCursorRef={gazeCursorRef}
            registerHitTargets={(cells) => routerRef.current?.registerGrid(cells)}
            gazeState={gazeState}
            onDwellRef={gamesDwellRef}
          />
        )}

        {mode === 'qa' && (
          <QAGame
            onBack={() => setMode('home')}
            registerHitTargets={(cells) => routerRef.current?.registerGrid(cells)}
            gazeState={gazeState}
            onDwellRef={qaDwellRef}
            onOpenSettings={openSettings}
          />
        )}

        {mode === 'games' && gameId === 'peppa' && (
          <PeppaBusGame
            onBack={() => setGameId(null)}
          />
        )}

        {mode === 'games' && gameId === 'balloon' && (
          <BalloonPopGame
            onBack={() => setGameId(null)}
          />
        )}

        {mode === 'aac' && (
          <>
            {/* ── Contextual Response context window (above TopBar) ── */}
            {settings.contextualResponseEnabled && (
              <>
                <LiveVideoStream
                  active={!!(settings.cameraAugmentationEnabled && settings.cameraStreamingEnabled)}
                />
                <ContextWindow
                  onResponsesGenerated={({ responses, activeModel, fallbackReason }) => {
                    setContextualResponses(responses)
                    setContextualActiveModel(activeModel)
                    setContextualFallbackReason(fallbackReason)
                    // New responses: unlock Single Reply so all tiles are selectable again
                    setLockedResponseIdx(-1)
                  }}
                  count={settings.contextualResponseCount ?? 9}
                  minCount={settings.contextualResponseMinCount ?? 2}
                  backend={settings.contextualResponseModel ?? 'ollama'}
                  ollamaModel={settings.contextualOllamaModel ?? 'llama3.2'}
                  ollamaVisionModel={settings.contextualOllamaVisionModel ?? 'llava'}
                  promptPrefix={settings.contextualPromptPrefix ?? ''}
                  lifeLore={settings.contextualLifeLore ?? ''}
                  systemPrompt={settings.contextualSystemPrompt ?? ''}
                  micMode={settings.contextualMicMode ?? 'toggle'}
                  micDeviceId={settings.contextualMicDeviceId ?? ''}
                  routing={settings.contextualRouting ?? 'local-only'}
                  geminiApiKey={settings.geminiApiKey ?? ''}
                  geminiModel={settings.geminiModel ?? 'gemini-2.5-flash'}
                  openAiApiKey={settings.openAiApiKey ?? ''}
                  openAiModel={settings.openAiModel ?? 'gpt-4o-mini'}
                  cloudAiProviderOrder={settings.cloudAiProviderOrder ?? ['gemini', 'openai']}
                  speakMode={settings.contextualSpeakMode ?? 'voice-typing'}
                  contextualWvtTimeout={settings.contextualWvtTimeout ?? 0}
                  speakShortcutCtrl={settings.speakShortcutCtrl ?? false}
                  speakShortcutShift={settings.speakShortcutShift ?? false}
                  speakShortcutAlt={settings.speakShortcutAlt ?? false}
                  speakShortcutChar={settings.speakShortcutChar ?? ''}
                />
              </>
            )}

            {/* TopBar: Home/Back/Phrase/Backspace/Clear/Sidebar */}
            <TopBar
              topBarGazeState={{
                cellId: gazeState.cellId,
                dwellProgress: gazeState.dwellProgress,
              }}
              onMeasureReady={(fn) => { topBarMeasureRef.current = fn }}
              dwellRingOpacity={settings.dwellProgressOpacity ?? 1.0}
              singleReplyLocked={singleReplyMode && lockedResponseIdx !== -1}
              actionMode={
                manualGatePending                                                         ? 'proceed' :
                (settings.contextualResponseEnabled && settings.answerGateMs === -1 && contextualResponses.length > 0) ? 'lock' :
                (singleReplyMode && lockedResponseIdx !== -1)                             ? 'again'   :
                'default'
              }
              onAgain={() => { playNavClick(); setLockedResponseIdx(-1) }}
              onBackspace={() => { playNavClick(); deleteWord() }}
              onClear={() => { playNavClick(); clearPhrase(); speak('Cleared') }}
              onActionClick={() => {
                if (manualGatePendingRef.current) {
                  manualGatePendingRef.current = false
                  setManualGatePending(false)
                  contextualGateUnlockedRef.current = true
                  // Also update the grid's visual gate state and play the chime
                  gateUnlockTriggerRef.current?.()
                }
              }}
              onLockClick={() => {
                gateLockTriggerRef.current?.()
              }}
              onSidebarItemClick={(id) => {
                // Future: handle Yes/No, Inflections/Keyboard, Social, Alert
                console.log('[TopBar] sidebar item:', id)
              }}
            />

            {/* ── BaseBoard: compact vocabulary board row in contextual mode ── */}
            {settings.contextualResponseEnabled && baseBoardEnabled && (
              <div className="app__baseboard-row">
                <GridRenderer
                  cellIdPrefix="base-"
                  gazeState={gazeState}
                  onActivate={handleActivate}
                  onGridMeasured={handleBaseBoardGridMeasured}
                  onMeasureTriggerReady={(fn) => { baseBoardMeasureTriggerRef.current = fn }}
                  cells={baseBoardCells}
                  cols={baseBoardCols}
                  rows={baseBoardRows}
                  isLoading={baseBoardLoading}
                />
              </div>
            )}

            {/* M3: Ocular Feedback Overlay — rendered above grid, below modal */}
            <GazeFeedbackOverlay
              pattern={settings.feedbackPattern}
              gazePos={gazeFilteredRef.current}
              dwellProgress={gazeState.dwellProgress}
              cellId={gazeState.cellId}
              cursorColor={settings.cursorColor}
              positionCallbackRef={gazeOverlayMoveRef}
            />

            {/* Gaze cursor dot is now rendered globally above — hidden here in AAC mode
                when feedbackPattern owns the cursor, or when showGazeCursor is off */}

            {/* Vocabulary grid OR contextual response tiles */}
            {settings.contextualResponseEnabled ? (
              <ContextualResponseGrid
                responses={contextualResponses}
                gazeState={gazeState}
                onActivate={handleActivate}
                onGridMeasured={handleAiGridMeasured}
                onMeasureTriggerReady={(fn) => { aiMeasureTriggerRef.current = fn }}
                onGateUnlockedChange={(unlocked) => {
                  contextualGateUnlockedRef.current = unlocked
                }}
                onManualGatePending={(pending) => {
                  manualGatePendingRef.current = pending
                  setManualGatePending(pending)
                  // When gate is pending, ensure router knows it's locked
                  if (pending) contextualGateUnlockedRef.current = false
                }}
                onUnlockTriggerReady={(fn) => { gateUnlockTriggerRef.current = fn }}
                onLockTriggerReady={(fn) => { gateLockTriggerRef.current = fn }}
                singleReplyMode={singleReplyMode}
                lockedResponseIdx={lockedResponseIdx}
                onResetSingleReplyLock={() => setLockedResponseIdx(-1)}
              />
            ) : (
              <GridRenderer
                gazeState={gazeState}
                onActivate={handleActivate}
                onGridMeasured={handleVocabGridMeasured}
                onMeasureTriggerReady={(fn) => { vocabMeasureTriggerRef.current = fn }}
              />
            )}
          </>
        )}
      </main>

      {/* Settings Modal */}
      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        initialPanel={settingsPanel}
        gazeRef={gazeFilteredRef}
        routerRef={routerRef}
        appVersion={appVersion}
      />

      {/* M5: Caregiver Panel */}
      <CaregiverPanel
        open={showCaregiverPanel}
        onClose={() => setShowCaregiverPanel(false)}
        onShowLogin={() => { setShowCaregiverPanel(false); setMode('auth') }}
      />

      {/* M7: Board Library Selector */}
      <BoardSelector
        open={showBoardSelector}
        onClose={() => setShowBoardSelector(false)}
        onEdit={(libraryId) => {
          setBoardEditorId(libraryId)
          setShowBoardSelector(false)
        }}
      />

      {/* M7: Board Editor */}
      <BoardEditor
        open={!!boardEditorId}
        libraryId={boardEditorId}
        onClose={() => setBoardEditorId(null)}
      />
    </div>
  )
}
