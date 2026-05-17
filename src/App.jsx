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
import './App.css'

/**
 * Returns a human-readable string describing the active gaze source.
 * The preload bridge exposes window.gazeAPI.trackerMode ('tobii' | 'mock')
 * once the main process has probed the SDK. Falls back gracefully.
 */
function TobiiStatus() {
  const mode = window.gazeAPI?.trackerMode
  if (mode === 'tobii') return 'Tobii SDK @ real-time'
  return 'mock @ 60 Hz'
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
    // ── TopBar button routing (dwell from TopBar) ───────────────────────────
    if (cellId === 'topbar-home')      { goHome(); return }
    if (cellId === 'topbar-back')      { goBack(); return }
    if (cellId === 'topbar-backspace') { deleteWord(); return }
    if (cellId === 'topbar-clear')     { clearPhrase(); speak('Cleared'); return }

    const cell = activeCells.find(c => c.id === cellId)
    if (!cell) return

    // Reset the dwell timer immediately so gaze is responsive right after
    // activation — no lag waiting for the user to move off the cell.
    routerRef.current?._dwellTimer.reset()

    // ── OBF action routing ──────────────────────────────────────────────────
    // cell.action is set by OBFParser from ext_gazeaac_action
    if (cell.action === 'clear' || (cell.category === 'utility' && cell.label === 'CLEAR')) {
      clearPhrase()
      speak('Cleared')
      if (settings.autoReturnHome) goHome()
      return
    }
    if (cell.action === 'home' || (cell.category === 'utility' && cell.label === 'HOME')) {
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
  }, [activeCells, speak, pushWord, clearPhrase, speakPhrase, navigateTo, goHome, activePage, rootBoardId, settings.autoReturnHome, settings.speakOnWord, settings.autoReturnFromSubPage])

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
  // Keep a stable ref so the router-startup effect can trigger measurement
  // without needing handleGridMeasured in its own dep array.
  const measureTriggerRef = useRef(null)

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
        setGazeState(prev => {
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
      <main className="app__main">

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

            {/* Vocabulary grid */}
            <GridRenderer
              gazeState={gazeState}
              onActivate={handleActivate}
              onGridMeasured={handleGridMeasured}
              onMeasureTriggerReady={(fn) => { measureTriggerRef.current = fn }}
            />
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
