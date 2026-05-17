import { createContext, useContext, useState, useCallback, useEffect } from 'react'

/**
 * GazeSettingsContext
 *
 * Provides runtime-configurable parameters for the gaze engine and UI.
 * Milestone 3: Settings are now persisted to electron-store via the
 * gazeAPI.settings IPC bridge. On mount, the context hydrates from the
 * persistent store; every change is written back asynchronously.
 *
 * Available settings:
 *   dwellMs           – Dwell activation threshold (default 800 ms)
 *   dropoutCushionMs  – Legacy blink recovery window (unused in M3 decay engine)
 *   decayHalfLifeMs   – Exponential decay half-life during dropout (default 200 ms)
 *   maxDropoutMs      – Hard-reset ceiling after continuous dropout (default 500 ms)
 *   processNoise      – Kalman Q parameter (default 0.012)
 *   measurementNoise  – Kalman R parameter (default 0.07)
 *   saccadeThreshold  – Normalised jump distance [0–1] that triggers Kalman
 *                       reset instead of tracking through intermediate states.
 *                       0.10 = one cell width on a 10-column grid.
 *   stage             – Vocabulary masking stage (1 = most masked, 3 = full)
 *   showGazeCursor    – Whether to render the real-time gaze cursor overlay
 *   cursorColor       – CSS color for the gaze cursor
 *   cursorSize        – Diameter of the gaze cursor in px (default 20)
 *   cursorShape       – Shape of the gaze cursor: 'circle' | 'crosshair' | 'ring' | 'dot' | 'diamond'
 *   feedbackPattern   – Ocular feedback pattern ('ring-pulse' | 'spotlight' | 'heat-trail')
 *   unmaskedBoxSize   – Max hit-box expansion for unmasked cells:
 *                         'full' = all adjacent space (default)
 *                         '2x'   = up to 2× the native cell width/height, centered
 *                         '3x'   = up to 3× the native cell width/height, centered
 *
 * Milestone 4 additions:
 *   showIcons         – Whether to render emoji icons on grid cells (default true)
 *   speakOnWord       – Speak each word immediately on activation (default true)
 *   autoReturnHome    – Return to root page automatically after CLR (default true)
 *   autoReturnFromSubPage – Auto-return to home after any 2nd-level noun selection, per LAMP WFL motor planning principle (default true)
 *
 * Milestone 5 additions:
 *   caregiverPin      – 4-digit PIN string protecting the Caregiver Panel (default '0000')
 *   customVocabIds    – Array of cell ID strings for Stage 1 Custom Vocab List (default [])
 */

export const DEFAULT_SETTINGS = {
  dwellMs: 800,
  dropoutCushionMs: 120,
  decayHalfLifeMs: 200,
  maxDropoutMs: 500,
  processNoise: 0.012,
  measurementNoise: 0.07,
  saccadeThreshold: 0.10,
  stage: 3,
  showGazeCursor: true,
  cursorColor: 'rgba(0, 200, 255, 0.7)',
  cursorSize: 20,                // gaze cursor diameter in px
  cursorShape: 'circle',         // 'circle' | 'crosshair' | 'ring' | 'dot' | 'diamond'
  feedbackPattern: 'ring-pulse',
  unmaskedBoxSize: '1x',  // '1x' | '2x' | '3x' | 'full'
  // M4
  showIcons: true,               // render emoji icons on grid cells
  speakOnWord: true,             // speak each word immediately on activation
  autoReturnHome: true,          // return to root page automatically after CLR
  autoReturnFromSubPage: true,   // auto-return home after 2nd-level noun selection
  // M5
  caregiverPin: '0000',          // 4-digit PIN protecting the Caregiver Panel
  customVocabIds: [],            // Stage 1 custom cell IDs; empty → use hardcoded 4-word default
  // M6 — Settings revamp
  aiSuggestions: false,          // AI contextual word prediction (UI stub — future integration)
  selectedBorderColor: '#00c8ff', // highlight border colour shown during dwell
  gridOpacity: 1.0,              // 0.3–1.0 overall grid panel transparency
  dwellProgressStyle: 'circle',  // 'circle' | 'bar'
  dwellProgressPosition: 'center', // 'top' | 'center' | 'bottom'
  dwellProgressOpacity: 1.0,    // 0.1–1.0 opacity of the dwell progress ring/bar
  ttsVoice: '',                  // SpeechSynthesisVoice.name; '' = system default
  // Board settings
  fontScale: 2.0,                // Relative font size multiplier for the vocabulary grid (0.5–5.0)
  symbolScale: 2.0,              // Relative symbol/image size multiplier (0.5–5.0)
  symbolOnTop: false,            // When true, symbol/image appears above the text label
  gridFontColor: '#ffffff',      // Default text colour for grid buttons (overridden by OBF foreground_color)
}

const GazeSettingsContext = createContext(null)

export function GazeSettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [storeReady, setStoreReady] = useState(false)

  // ── Hydrate from electron-store on mount ──────────────────────────────────
  useEffect(() => {
    const api = window.gazeAPI?.settings
    if (!api) {
      // Running in browser dev mode without electron — use defaults
      setStoreReady(true)
      return
    }

    api.getAll().then((stored) => {
      if (stored && typeof stored === 'object') {
        // Merge stored values over defaults (forward-compat: new keys use defaults)
        setSettings(prev => ({ ...prev, ...stored }))
        console.log('[GazeSettingsContext] Hydrated from electron-store:', stored)
      }
      setStoreReady(true)
    }).catch((err) => {
      console.warn('[GazeSettingsContext] Could not load settings from store:', err)
      setStoreReady(true)
    })
  }, [])

  // ── Write-through: persist every change to electron-store ─────────────────
  const persistKey = useCallback((key, value) => {
    window.gazeAPI?.settings?.set(key, value).catch(err => {
      console.warn(`[GazeSettingsContext] Failed to persist "${key}":`, err)
    })
  }, [])

  const updateSetting = useCallback((key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }))
    persistKey(key, value)
  }, [persistKey])

  const updateSettings = useCallback((patch) => {
    setSettings(prev => ({ ...prev, ...patch }))
    Object.entries(patch).forEach(([key, value]) => persistKey(key, value))
  }, [persistKey])

  const resetSettings = useCallback(async () => {
    const api = window.gazeAPI?.settings
    if (api) {
      const defaults = await api.reset()
      setSettings(defaults && typeof defaults === 'object' ? defaults : DEFAULT_SETTINGS)
    } else {
      setSettings(DEFAULT_SETTINGS)
    }
  }, [])

  return (
    <GazeSettingsContext.Provider
      value={{ settings, updateSetting, updateSettings, resetSettings, storeReady }}
    >
      {children}
    </GazeSettingsContext.Provider>
  )
}

/**
 * Hook to consume GazeSettingsContext.
 * Throws if used outside of GazeSettingsProvider.
 */
export function useGazeSettings() {
  const ctx = useContext(GazeSettingsContext)
  if (!ctx) throw new Error('useGazeSettings must be used within GazeSettingsProvider')
  return ctx
}
