import { useState, useEffect, useRef, useCallback } from 'react'
import { TelemetryRouter } from '@engine/TelemetryRouter'
import { SessionLogger } from '@engine/SessionLogger'
import { useGazeSettings } from '@context/GazeSettingsContext'
import { useVocabulary, NAV_VERB_PAGES } from '@context/VocabularyContext'
import { usePhrase } from '@context/PhraseContext'
import { AACBoardProvider } from '@context/AACBoardContext'
import { CalibrationScreen } from '@components/CalibrationScreen'
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
import './App.css'

/**
 * Returns a human-readable string describing the active gaze source.
 * The preload bridge exposes window.gazeAPI.trackerMode ('tobii' | 'mock')
 * once the main process has probed the SDK. Falls back gracefully.
 */
function TobiiStatus() {
  const mode = window.gazeAPI?.trackerMode
  if (mode === 'tobii') return 'Tobii SDK @ real-time'
  if (mode === 'mouse') return 'Mouse hover mode'
  return 'No eye tracker'
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
  const { settings } = useGazeSettings()
  const { activeCells, setStage, isLoading: vocabLoading, navigateTo, goHome, goBack, activePage, rootBoardId } = useVocabulary()
  const { pushWord, deleteWord, clearPhrase, speakPhrase } = usePhrase()

  const [mode, setMode] = useState('calibration') // 'calibration' | 'aac'
  // Dwell/hit-test state — only cellId and dwellProgress trigger re-renders
  const [gazeState, setGazeState] = useState({ cellId: null, dwellProgress: 0 })
  // Cursor position is written directly to the DOM to avoid a React render
  // cycle on every gaze frame (~60 Hz). This eliminates the single biggest
  // source of perceived gaze lag.
  const gazeCursorRef      = useRef(null)   // ref to the cursor <div>
  const gazeFilteredRef    = useRef(null)   // last filtered pos for overlay props
  const gazeOverlayMoveRef = useRef(null)   // set by GazeFeedbackOverlay; called every frame
                                            // to update overlay position without React re-render
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

  // Contextual Response board state
  const [contextualResponses, setContextualResponses]   = useState([])
  const [contextualActiveModel, setContextualActiveModel] = useState(null)

  // Board library & editor (M7)
  const [showBoardSelector, setShowBoardSelector] = useState(false)
  const [boardEditorId, setBoardEditorId]         = useState(null)

  const routerRef           = useRef(null)
  const sessionRef          = useRef(null)  // M5: SessionLogger instance
  // Stable ref wrapper so the TelemetryRouter never needs to restart
  // when activeCells or other handleActivate dependencies change.
  const handleActivateRef   = useRef(null)
  // Refs for measuring both grid cells and TopBar buttons
  const measureTriggerRef   = useRef(null)
  const topBarMeasureRef    = useRef(null)  // set by TopBar via onMeasureReady
  // Store the latest grid cell measurements so we can merge them with TopBar
  const gridCellsRef        = useRef([])

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
  //
  // On the FIRST valid gaze point we stop the waiting counter and stamp the
  // "Gaze stream established in X s" message — the stream is acquired well
  // before the user finishes the 9-point calibration sequence.
  const gazeStreamAcquiredRef = useRef(false) // one-shot: true after first valid point
  useEffect(() => {
    if (!window.gazeAPI) return

    // In calibration mode we just need raw position — no dwell processing.
    // The router's startStream() in AAC mode will take over automatically.
    if (mode === 'aac') return  // router owns the stream in AAC mode

    // Reset acquisition flag whenever we (re-)enter calibration.
    gazeStreamAcquiredRef.current = false

    window.gazeAPI.startStream((gp) => {
      // Calibration: GPU-composited transform, zero layout cost
      if (gp.x == null) return

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
      gazeFilteredRef.current = { x: gp.x, y: gp.y }
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
  const handleActivate = useCallback((cellId) => {
    // ── Contextual Response tile routing ────────────────────────────────────
    if (cellId.startsWith('ctx-r')) {
      const idx = parseInt(cellId.replace('ctx-r', ''), 10)
      const text = contextualResponses[idx]
      if (!text) return
      routerRef.current?._dwellTimer?.reset()
      const action = settings.contextualResponseAction ?? 'both'
      if (action === 'push' || action === 'both') pushWord(text, cellId)
      if (action === 'speak' || action === 'both') speak(text)
      sessionRef.current?.recordActivation(text)
      // Record which response was chosen (supports multiple per context)
      window.gazeAPI?.aiHistory?.recordChoice?.(text).catch(
        e => console.warn('[App] Failed to record AI history choice:', e)
      )
      return
    }

    // ── TopBar button routing (dwell from TopBar) ───────────────────────────
    if (cellId === 'topbar-home' || cellId === 'topbar-back' ||
        cellId === 'topbar-backspace' || cellId === 'topbar-clear' ||
        cellId === 'topbar-speak') {
      routerRef.current?._dwellTimer.reset()
      if (cellId === 'topbar-home')      { playNavClick(); goHome(); return }
      if (cellId === 'topbar-back')      { playNavClick(); goBack(); return }
      if (cellId === 'topbar-backspace') { playNavClick(); deleteWord(); return }
      if (cellId === 'topbar-clear')     { playNavClick(); clearPhrase(); speak('Cleared'); return }
      if (cellId === 'topbar-speak')     { speakPhrase(); return }
    }


    const cell = activeCells.find(c => c.id === cellId)
    if (!cell) return

    // Reset the dwell timer immediately so gaze is responsive right after
    // activation — no lag waiting for the user to move off the cell.
    routerRef.current?._dwellTimer.reset()

    // ── OBF action routing ──────────────────────────────────────────────────
    // cell.action is set by OBFParser from ext_gazeaac_action
    if (cell.action === 'clear' || (cell.category === 'utility' && cell.label === 'CLEAR')) {
      playNavClick()
      clearPhrase()
      speak('Cleared')
      if (settings.autoReturnHome) goHome()
      return
    }
    if (cell.action === 'home' || (cell.category === 'utility' && cell.label === 'HOME')) {
      playNavClick()
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
      playNavClick()
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
  }, [activeCells, speak, playNavClick, pushWord, clearPhrase, speakPhrase, navigateTo, goHome, goBack, deleteWord, activePage, rootBoardId, settings.autoReturnHome, settings.speakOnWord, settings.autoReturnFromSubPage, contextualResponses, settings.contextualResponseAction])

  // Keep the ref in sync with the latest handleActivate without triggering
  // any effects that depend on the router. This is the pattern that prevents
  // the router from restarting every time vocabulary state changes.
  handleActivateRef.current = handleActivate

  // ── Grid measurement → TelemetryRouter registration ───────────────────────
  /**
   * Called by GridRenderer after every DOM layout paint (and on resize).
   * Receives pixel-accurate normalized cell boundaries from getBoundingClientRect.
   * Forwards directly to the live router — no fractional approximations.
   *
   * @param {Array<{ id: string, x0: number, y0: number, x1: number, y1: number }>} measured
   */
  const handleGridMeasured = useCallback((measured) => {
    // Merge grid cells with TopBar button cells so the router
    // can hit-test both vocabularly cells AND top-bar buttons.
    gridCellsRef.current = measured
    const topBarCells = topBarMeasureRef.current?.() ?? []
    const allCells = [...measured, ...topBarCells]
    if (routerRef.current) {
      routerRef.current.registerGrid(allCells)
      console.log(`[App] TelemetryRouter.registerGrid() updated with ${measured.length} grid + ${topBarCells.length} topbar cells`)
    }
  }, [])

  // ── TelemetryRouter lifecycle ──────────────────────────────────────────────
  //
  // IMPORTANT: `settings` is intentionally omitted from this effect's dep array.
  // Individual effects below patch dwellMs / decayHalfLifeMs / maxDropoutMs at
  // runtime via the router's setter methods — no teardown needed.
  //
  // Including `settings` here was the root cause of a bug where closing the
  // Settings Modal restarted the router with an empty cell registry, causing
  // gaze dwell to silently stop working until a click re-triggered grid
  // measurement in GridRenderer.
  useEffect(() => {
    if (mode !== 'aac') return

    const router = new TelemetryRouter({
      filterOptions: {
        processNoise:     settings.processNoise,
        measurementNoise: settings.measurementNoise,
        saccadeThreshold: settings.saccadeThreshold
      },
      dwellMs: settings.dwellMs,
      decayHalfLifeMs: settings.decayHalfLifeMs,   // M3
      maxDropoutMs: settings.maxDropoutMs,           // M3
      postActivationCooldownMs: settings.postActivationCooldownMs,
      // Use a stable wrapper so the router NEVER restarts when activeCells
      // or other handleActivate deps change — the ref is always up-to-date.
      onDwell: (cellId) => handleActivateRef.current?.(cellId),
      onGaze: (event) => {
        // ── Hot path: GPU-composited cursor, zero layout cost ─────────────────
        const el = gazeCursorRef.current
        if (el) {
          const pos = event.raw
          if (pos) {
            const px = pos.x * window.innerWidth
            const py = pos.y * window.innerHeight
            el.style.transform = `translate(${px}px, ${py}px)`
            const hide = mode === 'aac' &&
              (!settings.showGazeCursor || settings.feedbackPattern === 'border')
            el.style.display = hide ? 'none' : 'block'
          } else {
            el.style.display = 'none'
          }
        }
        // Update overlay position on every frame — works on masked AND unmasked
        // cells. gazeOverlayMoveRef is populated by GazeFeedbackOverlay and bypasses
        // the React render cycle entirely (same pattern as the cursor).
        const overlayPos = event.filtered ?? event.raw
        if (overlayPos) gazeOverlayMoveRef.current?.(overlayPos)
        gazeFilteredRef.current = event.filtered

        // ── State update: throttled to ~22/sec instead of 90/sec ─────────────
        // Threshold 0.02 cuts GazeFeedbackOverlay re-renders by ~75%.
        // IMPORTANT: always let dwellProgress===1 (the activation frame) through
        // so the dwell ring visually completes before the timer resets.
        setGazeState(prev => {
          if (event.dwellProgress === 1) {
            // Activation frame — always render so the ring reaches 100%
            return { cellId: event.cellId, dwellProgress: 1 }
          }
          if (prev.cellId === event.cellId &&
              Math.abs(prev.dwellProgress - event.dwellProgress) < 0.02) {
            return prev
          }
          return { cellId: event.cellId, dwellProgress: event.dwellProgress }
        })
      }

    })

    router.start()
    routerRef.current = router

    // Immediately re-populate the grid registry so that gaze frames arriving
    // right after startup can hit-test against the already-rendered cells.
    // measureTriggerRef.current is wired up by GridRenderer via a callback ref.
    requestAnimationFrame(() => {
      measureTriggerRef.current?.()
    })

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
    if (mode !== 'aac') return
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
      if (!insideWindow || lastPos === null) {
        // Cursor is outside the window — emit a dropout so dwell decays.
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

  // ── Pause gaze dwell when any overlay covers the board ────────────────────
  // Settings Modal, PIN Gate, and Caregiver Panel all obscure the grid.
  // We pause the router so no phantom activations fire while the user
  // (or caregiver) interacts with these pages.  The gaze cursor dot
  // keeps rendering so the overlay can still show cursor feedback.
  useEffect(() => {
    if (!routerRef.current) return
    const boardBlocked = showSettings || showCaregiverPanel
    if (boardBlocked) {
      routerRef.current.pause()
      setStatusMsg('Gaze paused (overlay active)')
    } else {
      routerRef.current.resume()
      setStatusMsg(`Gaze stream active (${TobiiStatus()})`)
    }
  }, [showSettings, showCaregiverPanel, showBoardSelector, boardEditorId])

  // ── Status bar: reflect Mouse Hover Mode ──────────────────────────────────
  useEffect(() => {
    if (mode !== 'aac') return
    if (showSettings || showCaregiverPanel) return  // overlay message takes priority
    if (settings.mouseHoverMode) {
      const isRealTracker = window.gazeAPI?.trackerMode === 'tobii'
      setStatusMsg(isRealTracker
        ? 'Mouse Hover Mode active (alongside eye tracker)'
        : 'Mouse hover active — no eye tracker detected')
    }
  }, [mode, settings.mouseHoverMode, showSettings, showCaregiverPanel])


  return (
    <div className="app">
      {/* ── Frameless title bar ────────────────────────────────────────── */}
      <header className="app__titlebar" data-electron-drag>
        <div className="app__titlebar-logo">GazeAAC</div>

        {/* M4: Navigation breadcrumb (only visible in AAC mode) */}
        {mode === 'aac' && (
          <div className="app__titlebar-nav">
            <NavBreadcrumb />
          </div>
        )}

        <div className="app__titlebar-status">{statusMsg}</div>
        <div className="app__titlebar-controls">
          {/* Gear opens a mini popover — 3 settings + caregiver panel */}
          <div style={{ position: 'relative' }}>
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
                onMouseLeave={() => setShowGearPopover(false)}
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
                <div className="app__gear-popover-divider" />
                <button
                  className="app__gear-popover-item"
                  role="menuitem"
                  onClick={() => { setShowCaregiverPanel(true); setShowGearPopover(false) }}
                >
                  👩‍⚕️ Caregiver Panel
                </button>
              </div>
            )}
          </div>

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
            onClick={() => window.gazeAPI?.windowControl('close')}
          >✕</button>
        </div>
      </header>

      {/* ── Main content area ─────────────────────────────────────────── */}
      <main className={`app__main${settings.contextualResponseEnabled ? ' app__main--contextual' : ''}`}>

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

        {mode === 'calibration' && (
          <CalibrationScreen
            onComplete={() => {
              setStage(1)
              setMode('aac')
            }}
            gazeRef={gazeFilteredRef}
            dwellMs={settings.dwellMs}
          />
        )}

        {mode === 'aac' && (
          <>
            {/* ── Contextual Response context window (above TopBar) ── */}
            {settings.contextualResponseEnabled && (
              <ContextWindow
                onResponsesGenerated={({ responses, activeModel }) => {
                  setContextualResponses(responses)
                  setContextualActiveModel(activeModel)
                }}
                count={settings.contextualResponseCount ?? 9}
                minCount={settings.contextualResponseMinCount ?? 2}
                backend={settings.contextualResponseModel ?? 'ollama'}
                ollamaModel={settings.contextualOllamaModel ?? 'llama3.2'}
                ollamaVisionModel={settings.contextualOllamaVisionModel ?? 'llava'}
                promptPrefix={settings.contextualPromptPrefix ?? ''}
                lifeLore={settings.contextualLifeLore ?? ''}
                systemPrompt={settings.contextualSystemPrompt ?? ''}
              />
            )}

            {/* TopBar: Home/Back/Phrase/Backspace/Clear/Sidebar */}
            <TopBar
              topBarGazeState={{
                cellId: gazeState.cellId,
                dwellProgress: gazeState.dwellProgress,
              }}
              onMeasureReady={(fn) => { topBarMeasureRef.current = fn }}
              dwellRingOpacity={settings.dwellProgressOpacity ?? 1.0}
              onSidebarItemClick={(id) => {
                // Future: handle Yes/No, Inflections/Keyboard, Social, Alert
                console.log('[TopBar] sidebar item:', id)
              }}
            />

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
                onGridMeasured={handleGridMeasured}
                onMeasureTriggerReady={(fn) => { measureTriggerRef.current = fn }}
              />
            ) : (
              <GridRenderer
                gazeState={gazeState}
                onActivate={handleActivate}
                onGridMeasured={handleGridMeasured}
                onMeasureTriggerReady={(fn) => { measureTriggerRef.current = fn }}
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
      />

      {/* M5: Caregiver Panel */}
      <CaregiverPanel
        open={showCaregiverPanel}
        onClose={() => setShowCaregiverPanel(false)}
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
