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
 *   dwellMs                  – Dwell activation threshold (default 800 ms)
 *   dropoutCushionMs         – Legacy blink recovery window (unused in M3 decay engine)
 *   decayHalfLifeMs          – Exponential decay half-life during dropout (default 200 ms)
 *   maxDropoutMs             – Hard-reset ceiling after continuous dropout (default 500 ms)
 *   postActivationCooldownMs – After a cell fires, gaze must leave that cell for this
 *                              many ms before dwell can restart on it. Prevents accidental
 *                              re-activation when gaze stays or returns to the same box.
 *                              (default 10 ms)
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
 *
 * Navigation sound additions:
 *   navClickSound     – Play a discreet click sound when any non-word button fires
 *                       (Home, Back, Backspace, Clear, layer-1 nav cells). (default false)
 *   navClickVolume    – Volume of the navigation click sound (0.0–1.0, default 0.35)
 *   navClickTone      – Timbre of the click: 'soft' | 'tick' | 'pop' (default 'soft')
 *
 * Input method additions:
 *   mouseHoverMode    – Use mouse cursor position as a proxy gaze input (for Mill Mouse
 *                       or any setup where direct eye-gaze hardware is unavailable).
 *                       When enabled, the mouse cursor drives dwell activation instead
 *                       of the eye-tracker stream. (default false)
 *
 * Answer Gate:
 *   answerGateMs      – When > 0, newly generated response tiles are rendered as
 *                       unselectable. Each tile requires the user to hover/gaze on it
 *                       for this many ms before it unlocks for selection. A horizontal
 *                       progress bar on the tile fills during hover to show progress.
 *                       0 = gate disabled (tiles are immediately selectable). (default 0)
 */

export const DEFAULT_SETTINGS = {
  dwellMs: 800,
  dropoutCushionMs: 120,
  decayHalfLifeMs: 200,
  maxDropoutMs: 500,
  postActivationCooldownMs: 10,
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
  // Navigation click sound
  navClickSound: false,          // Play a discreet click for nav/utility button activations
  navClickVolume: 0.35,          // Volume of the navigation click (0.0–1.0)
  navClickTone: 'soft',          // Timbre: 'soft' | 'tick' | 'pop'
  // Input method
  mouseHoverMode: true,
  // Answer Gate — reading delay before response tiles become selectable
  answerGateMs: 0,             // 0 = off; 1–30000 ms = gate duration per tile
  // Contextual Response board
  contextualResponseEnabled: false,   // Show the Contextual Response board mode
  contextualResponseModel: 'ollama',  // AI backend: 'ollama' | 'window-ai'
  contextualOllamaModel: 'llama3.2',  // Ollama text model name
  contextualOllamaVisionModel: 'llava', // Ollama vision model (used when image captured)
  contextualResponseMinCount: 2,      // Min suggestions the AI must generate (slider: 2–9)
  contextualResponseCount: 9,         // Max suggestions the AI may generate (slider: 2–9)
  contextualResponseAction: 'both',   // On selection: 'speak' | 'push' | 'both'
  // Life Lore, Prompt Prefix & System Prompt
  contextualPromptPrefix: `You are an AAC assistant generating responses on behalf of [User Name], a [Age]-year-old child who lives in [Location]. Father is [Father] and Mother is [Mother]. You will speak as the voice of the [User Name].
Your job is to suggest between 2 and [Max] short, natural, age-appropriate communication phrases that [User Name] might actually say.
Vary the responses: mix single words, short phrases, full sentences, questions, and expressions.
Return ONLY a valid JSON array of strings — no explanation, no markdown, no extra text.
Example: ["I want to play!", "Can we call Daddy?", "Not now, please"]
Prioritize the usefulness of the responses.
If the question presents choices, ensure the responses contain the choices to allow the user to select them. For example, if the question is for CHOICE A OR CHOICE B, the response should at least include 1) CHOICE A, 2) CHOICE B, 3) BOTH, 4) NONE.`,
  contextualLifeLore: '',             // Background facts about the user (injected as context data)
  contextualSystemPrompt: '',         // Fully custom system prompt body; empty = use built-in default
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
        // ── Migration: if the stored promptPrefix is still the old empty string,
        //    replace it with the new default so users don't have to manually reset.
        const migrated = { ...stored }
        if (!migrated.contextualPromptPrefix) {
          migrated.contextualPromptPrefix = DEFAULT_SETTINGS.contextualPromptPrefix
          // Write the corrected value back to the store immediately
          api.set('contextualPromptPrefix', migrated.contextualPromptPrefix).catch(() => {})
          console.log('[GazeSettingsContext] Migrated empty contextualPromptPrefix → new default')
        }
        // Merge stored values over defaults (forward-compat: new keys use defaults)
        setSettings(prev => ({ ...prev, ...migrated }))
        console.log('[GazeSettingsContext] Hydrated from electron-store:', migrated)
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
