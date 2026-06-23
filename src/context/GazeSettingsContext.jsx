import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { subscribeToAuth, auth } from '../engine/firebase'
import { SyncAdapter } from '../engine/SyncAdapter'

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
  ttsEngine: 'sapi',             // 'sapi' | 'winrt' — TTS backend (SAPI = legacy, WinRT = Natural/Neural voices)
  ttsRate: 0,                    // SAPI Rate: -10 (slowest) … 0 (normal) … +10 (fastest)
  ttsPitch: 0,                   // Pitch shift: -10 (lowest) … 0 (normal) … +10 (highest), applied via SSML prosody
  ttsVolume: 100,                // SAPI Volume: 0–100
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
  answerGateMs: 2000,             // 0 = off; 1–30000 ms = gate duration per tile
  // Contextual Response board
  contextualResponseEnabled: true,   // Show the Contextual Response board mode
  contextualResponseModel: 'ollama',  // AI backend: 'ollama' | 'window-ai'
  contextualOllamaModel: 'llama3.2',  // Ollama text model name
  contextualOllamaVisionModel: 'llava', // Ollama vision model (used when image captured)
  contextualResponseMinCount: 4,      // Min suggestions the AI must generate (slider: 2–9)
  contextualResponseCount: 6,         // Max suggestions the AI may generate (slider: 2–9)
  contextualResponseAction: 'both',   // On selection: 'speak' | 'push' | 'both'
  contextualMicMode: 'toggle',        // 'toggle' | 'continuous'
  contextualPromptPrefix: '',
  contextualLifeLore: '',             // Background facts about the user (injected as context data)
  contextualSystemPrompt: '',         // Fully custom system prompt body; empty = use built-in default
  contextualRouting: 'internet-first', // AI Routing Strategy: 'internet-first' | 'local-only'
  geminiApiKey: '',                   // Cloud Gemini API Key
  geminiModel: 'gemini-2.5-flash',    // Cloud Gemini model
  cloudAiProviderOrder: ['gemini', 'openai'], // Ordered cloud AI fallback list: try each in order
  openAiApiKey: '',                   // OpenAI secret key (sk-...)
  openAiModel: 'gpt-4o-mini',         // OpenAI ChatGPT model name
  contextualSpeakMode: 'voice-typing', // Speak input method: 'voice-typing' | 'sapi'
  contextualWvtTimeout: 0,             // Auto-off delay for WVT in seconds (0 = off)
  contextualMicDeviceId: '',          // empty = system default mic; deviceId string = specific device
  speakShortcutCtrl: false,           // Modifiers for Speak shortcut
  speakShortcutShift: false,
  speakShortcutAlt: false,
  speakShortcutChar: '',              // Character for Speak shortcut
  lastUsedBoard: 'quick-core-24-obz',
  // Camera & Vision Pipeline
  cameraAugmentationEnabled: false,    // Option to turn on/off camera context augmentation
  cameraStreamingEnabled: false,       // Option to turn on/off live video streaming in contextual mode
  cameraUpdateSoundEnabled: true,      // Option to play a sound on camera detection loop refresh
  cameraFacingMode: 'user',           // 'user' (front) | 'environment' (rear)
  cameraSelectedDeviceId: '',         // Empty = default camera, or specific deviceId string
  cameraIntervalMs: 2000,             // Frame processing loop interval (ms)
  cameraMinConfidence: 0.5,           // Vision detection confidence threshold
  cameraAugmentOnlyOnPrompt: false,   // Only augment with camera data when explicitly prompted
  registeredFaces: [],                // Biometric face profiles: Array<{ id, name, descriptor: number[], addedAt }>
  registeredObjects: [],              // Registered objects/scenes: Array<{ id, label, descriptor: number[], addedAt, type: 'object'|'scene' }>
  deletedFaceIds: [],
  deletedPhotoIds: [],
  deletedObjectIds: [],
  deviceId: '',                       // Local device persistent identifier
  deviceName: '',                     // Local device Hostname
  deviceOS: '',                       // Local device Operating System
  lastActive: 0,                      // Device last active timestamp (ms)
  // Movie Time
  movieTimeYoutubeKey: '',            // YouTube Data API v3 key (legacy single key — migrated to movieTimeYoutubeKeys on load)
  movieTimeYoutubeKeys: [],           // Array of { key, label } objects — tried in order, rotates on quota exceeded
  movieTimeProviderYoutube: true,     // Enable YouTube streaming provider option
  movieTimeProviderNetflix: true,     // Enable Netflix streaming provider option
  movieTimeProviderDisney: true,      // Enable Disney+ streaming provider option
  movieTimeActiveProvider: 'youtube', // Default active streaming provider
  movieTimePuzzleIntervalSec: 600,    // Seconds between periodic puzzles (1s–3600s, 0=Unlimited)
  movieTimePuzzleIntervalMin: 10,     // Legacy: minutes between puzzles — kept for migration only
  movieTimeGazeAwayMs: 3000,          // Gaze-away threshold before auto-pause (ms)
  movieTimeSafeSearch: 'strict',      // 'none' | 'moderate' | 'strict'
  movieTimeDuration: 'medium',        // 'any' | 'short' | 'medium' | 'long'
  movieTimeVideoQuality: 'any',       // 'any' | 'hd' | 'fhd' | '4k'
  movieTimeTopics: ['Animals', 'Science', 'Art'], // Selected topic tags
  movieTimeWhitelist: ['kids', 'educational'],    // Keyword whitelist chips
  movieTimeBlacklist: [],             // Keyword blacklist chips
  movieTimeGamerLoophole: false,      // Include high-quality fan creations
  movieTimePuzzleTypes: ['Quiz', 'Riddle'],  // 'Quiz'|'Word Puzzle'|'Math'|'Memory'|'Riddle'
  movieTimePuzzleDifficulty: 'Easy',  // 'Easy' | 'Medium' | 'Hard'
  movieTimePuzzleChoices: 4,          // Number of answer choices (2–4)
  movieTimeMaxDailyMinutes: 60,       // Max daily watch time in minutes (10–720; 720=Unlimited)
  movieTimeShowGazeCursor: true,      // Show eye gaze cursor while in Movie Time (if false, hides cursor when movie is playing)
  movieTimePauseOnGazeLost: true,     // Automatically pause video when eye gaze is not detected completely (eyes closed or gaze lost)
  movieTimeSelectionGateMs: 2000,     // ms user must view movie selection grid before dwell-select is enabled (0 = instant)
  movieTimeSelectionCount: 4,         // Number of video options presented for selection (2–9)
  // Movie Time – Quiz Settings
  movieTimeQuizEducationLevel: 'Primary',  // 'Pre-K' | 'Primary' | 'Secondary' | 'Adult'
  movieTimeQuizSubject: 'General',         // Predefined subject for AI question generation
  movieTimeQuizSubjectCustom: '',          // Free-text override; if set, used instead of movieTimeQuizSubject
  movieTimeQuizAboutVideo: false,          // Quiz questions directly related to video content/transcript
  movieTimeQuizRequirePrewatch: true,      // Require a quiz to start before video playback (default: true)
  movieTimeQuizSoundEffects: true,         // Play Web Audio tones on correct / wrong answer
  movieTimeQuizQuestionGateMs: 2000,       // ms to show question before answers appear (0 = instant)
  movieTimeQuizAnswerGateMs: 1500,         // ms after answers appear before dwell selection is enabled (0 = instant)
  movieTimeQuizVoiceOver: true,            // TTS reads question aloud when overlay appears
  movieTimeQuizVoiceOverChoices: true,     // TTS also reads each answer choice after the question
  movieTimeQuizVoiceOverPauseMs: 500,      // Delay between voice-over readings (ms)
  movieTimePuzzleHintAfterWrong: 3,        // Show hint on correct answer after this many wrong attempts (0 = disabled)
  movieTimePuzzleQuestionsPerQuiz: 3,      // Number of questions generated per quiz session (1–10)
  movieTimeAskedQuestions: [],             // Array of question strings asked to prevent repetition and sync to cloud
  movieTimeSelectedYoutubeVideoIds: null,  // Array of string IDs of selected curated YouTube videos; null = all selected by default
  movieTimeMinViews: 0,                    // Minimum view count filter applied client-side after stats fetch (0 = no minimum)
  movieTimeLanguage: '',                   // BCP-47 language tag for relevanceLanguage YouTube API param ('' = any, 'en' = English, etc.)
  // Q&A Quizzes Settings
  qaQuizQuestionGateMs: 2000,              // ms to show question before answers appear (0 = instant)
  qaQuizAnswerGateMs: 1500,                // ms after answers appear before dwell selection is enabled (0 = instant)
  qaPuzzleHintAfterWrong: 3,               // Show hint on correct answer after this many wrong attempts (0 = disabled)
  qaQuizSoundEffects: true,                // Play Web Audio tones on correct / wrong answer
  qaQuizVoiceOver: true,                   // TTS reads question aloud when overlay appears
  qaQuizVoiceOverChoices: true,            // TTS also reads each answer choice after the question
  qaQuizVoiceOverPauseMs: 500,             // Delay between voice-over readings (ms)
  // In-App Calibration Correction
  explicitCalibrationEnabled: true,       // Show 5-point calibration exercise at startup
  implicitCalibrationEnabled: true,       // Silently learn from dwell activations to improve accuracy
  gazeCorrection: null,                   // Persisted { offsetX, offsetY, scaleX, scaleY, quality, sampleCount, quadrantData, recentErrors, updatedAt } or null
  gazeLostSoundEnabled: true,             // Play alert chime when eye gaze signal is lost
  gazeLostVisualEnabled: true,            // Show floating warning banner when eye gaze signal is lost
}

const GazeSettingsContext = createContext(null)

/**
 * Merges two lists of objects containing 'id' fields.
 * If an item exists in both lists, properties are merged.
 * If it represents a face profile, reference photos are recursively merged.
 */
export function mergeUniqueListsById(listA, listB) {
  const a = Array.isArray(listA) ? listA : []
  const b = Array.isArray(listB) ? listB : []

  const map = new Map()
  
  a.forEach(item => {
    if (item && item.id) {
      map.set(item.id, item)
    }
  })

  b.forEach(item => {
    if (item && item.id) {
      const existing = map.get(item.id)
      if (existing) {
        let photos = existing.photos || []
        if (item.photos && item.photos.length > 0) {
          photos = mergeUniqueListsById(existing.photos, item.photos)
        }
        map.set(item.id, { ...existing, ...item, photos })
      } else {
        map.set(item.id, item)
      }
    }
  })

  return Array.from(map.values())
}

export function mergeDeletedLists(listA, listB) {
  const a = Array.isArray(listA) ? listA : []
  const b = Array.isArray(listB) ? listB : []

  const map = new Map()

  a.forEach(item => {
    if (item && item.id) {
      map.set(item.id, item)
    }
  })

  b.forEach(item => {
    if (item && item.id) {
      const existing = map.get(item.id)
      if (existing) {
        const latestDeletedAt = Math.max(existing.deletedAt || 0, item.deletedAt || 0)
        map.set(item.id, { ...existing, ...item, deletedAt: latestDeletedAt })
      } else {
        map.set(item.id, item)
      }
    }
  })

  return Array.from(map.values())
}

export function mergeSettingsLists(localList, remoteList, deletedList, deletedPhotoIds) {
  const local = Array.isArray(localList) ? localList : []
  const remote = Array.isArray(remoteList) ? remoteList : []
  const deleted = Array.isArray(deletedList) ? deletedList : []
  const deletedPhotos = Array.isArray(deletedPhotoIds) ? deletedPhotoIds : []

  const map = new Map()

  local.forEach(item => {
    if (item && item.id) {
      map.set(item.id, item)
    }
  })

  remote.forEach(item => {
    if (item && item.id) {
      const existing = map.get(item.id)
      if (existing) {
        let photos = existing.photos || []
        if (item.photos && item.photos.length > 0) {
          photos = mergeSettingsLists(existing.photos, item.photos, deletedPhotos, [])
        }
        map.set(item.id, { ...existing, ...item, photos })
      } else {
        map.set(item.id, item)
      }
    }
  })

  return Array.from(map.values()).filter(item => {
    const deletion = deleted.find(d => d.id === item.id)
    if (deletion) {
      const addedAt = item.addedAt || 0
      if (deletion.deletedAt >= addedAt) {
        return false
      }
    }

    if (item.photos) {
      item.photos = item.photos.filter(photo => {
        const photoDeletion = deletedPhotos.find(dp => dp.id === photo.id)
        if (photoDeletion) {
          const photoAddedAt = photo.addedAt || 0
          if (photoDeletion.deletedAt >= photoAddedAt) {
            return false
          }
        }
        return true
      })
    }

    return true
  })
}

const sortQuizzes = (list) => {
  if (!Array.isArray(list)) return []
  return [...list].sort((a, b) => {
    const orderA = a && a.order !== undefined ? a.order : (a?.createdAt || 0);
    const orderB = b && b.order !== undefined ? b.order : (b?.createdAt || 0);
    if (orderA !== orderB) return orderA - orderB;
    const timeA = a?.createdAt || 0;
    const timeB = b?.createdAt || 0;
    if (timeA !== timeB) return timeA - timeB;
    return (a?.id || '').localeCompare(b?.id || '');
  });
};

export function GazeSettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [storeReady, setStoreReady] = useState(false)
  const [currentUser, setCurrentUser] = useState(null)
  const [isInitialSyncCompleted, setIsInitialSyncCompleted] = useState(false)
  const [quizzes, setQuizzes] = useState([])

  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  // ── Hydrate quizzes from localStorage on mount ────────────────────────────
  useEffect(() => {
    const raw = localStorage.getItem('gazeaac_quizzes')
    if (raw) {
      try {
        setQuizzes(sortQuizzes(JSON.parse(raw)))
      } catch (_) {
        setQuizzes([])
      }
    } else {
      const defaults = [
        {
          id: 'default-animals',
          name: 'Animals Quiz',
          dwellTimeMs: 2000,
          questions: [
            {
              question: 'Which animal is known as the King of the Jungle?',
              answers: [
                { id: 'a', text: 'Elephant' },
                { id: 'b', text: 'Tiger' },
                { id: 'c', text: 'Lion' },
                { id: 'd', text: 'Giraffe' }
              ],
              correctId: 'c'
            },
            {
              question: 'Which of these animals can fly?',
              answers: [
                { id: 'a', text: 'Penguin' },
                { id: 'b', text: 'Bat' },
                { id: 'c', text: 'Kangaroo' },
                { id: 'd', text: 'Ostrich' }
              ],
              correctId: 'b'
            },
            {
              question: 'What is a baby dog called?',
              answers: [
                { id: 'a', text: 'Kitten' },
                { id: 'b', text: 'Puppy' },
                { id: 'c', text: 'Cub' },
                { id: 'd', text: 'Calf' }
              ],
              correctId: 'b'
            }
          ]
        },
        {
          id: 'default-math',
          name: 'Shapes & Colors',
          dwellTimeMs: 2000,
          questions: [
            {
              question: 'How many sides does a triangle have?',
              answers: [
                { id: 'a', text: '2 sides' },
                { id: 'b', text: '3 sides' },
                { id: 'c', text: '4 sides' },
                { id: 'd', text: '5 sides' }
              ],
              correctId: 'b'
            },
            {
              question: 'What shape is a standard soccer ball?',
              answers: [
                { id: 'a', text: 'Circle' },
                { id: 'b', text: 'Sphere' },
                { id: 'c', text: 'Square' },
                { id: 'd', text: 'Cube' }
              ],
              correctId: 'b'
            }
          ]
        }
      ]
      localStorage.setItem('gazeaac_quizzes', JSON.stringify(defaults))
      setQuizzes(defaults)
    }
  }, [])

  const saveQuizzes = useCallback((updatedQuizzes) => {
    setQuizzes(updatedQuizzes)
    localStorage.setItem('gazeaac_quizzes', JSON.stringify(updatedQuizzes))
    // Persist to electron-store so quizzes survive app restarts
    window.gazeAPI?.settings?.set('quizzes', updatedQuizzes).catch(() => {})
    const uid = currentUser?.uid
    if (uid) {
      const adapter = SyncAdapter.getInstance()
      adapter.pushQuizzes(updatedQuizzes)
    }
  }, [currentUser])

  const deleteQuizLocally = useCallback((quizId) => {
    setQuizzes(prev => {
      const filtered = prev.filter(q => q.id !== quizId)
      localStorage.setItem('gazeaac_quizzes', JSON.stringify(filtered))
      const uid = currentUser?.uid
      if (uid) {
        const adapter = SyncAdapter.getInstance()
        adapter.deleteQuiz(quizId)
      }
      return filtered
    })
  }, [currentUser])

  // ── Hydrate from electron-store on mount ──────────────────────────────────
  useEffect(() => {
    const api = window.gazeAPI?.settings
    if (!api) {
      // Running in browser dev mode without electron — use defaults and populate fallback device metadata
      let webId = localStorage.getItem('gaze_deviceId')
      if (!webId) {
        webId = 'web_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now().toString(36)
        localStorage.setItem('gaze_deviceId', webId)
      }

      let webName = localStorage.getItem('gaze_deviceName')
      if (!webName) {
        const ua = navigator.userAgent
        let browser = 'Browser'
        if (ua.includes('Firefox')) browser = 'Firefox'
        else if (ua.includes('Chrome')) browser = 'Chrome'
        else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari'
        else if (ua.includes('Edge')) browser = 'Edge'
        webName = `${browser} Client`
        localStorage.setItem('gaze_deviceName', webName)
      }

      let webOS = localStorage.getItem('gaze_deviceOS')
      if (!webOS) {
        const ua = navigator.userAgent
        let os = 'Unknown OS'
        if (ua.includes('Windows')) os = 'Windows'
        else if (ua.includes('Macintosh')) os = 'macOS'
        else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS'
        else if (ua.includes('Android')) os = 'Android'
        else if (ua.includes('Linux')) os = 'Linux'
        webOS = os
        localStorage.setItem('gaze_deviceOS', webOS)
      }

      setSettings(prev => ({
        ...prev,
        deviceId: webId,
        deviceName: webName,
        deviceOS: webOS,
        lastActive: Date.now()
      }))
      setStoreReady(true)
      return
    }

    api.getAll().then((stored) => {
      if (stored && typeof stored === 'object') {
        // ── Migration: if the stored promptPrefix contains the old default text,
        //    migrate it to empty string so it doesn't redundantly prepended to the system prompt.
        const migrated = { ...stored }
        if (migrated.contextualPromptPrefix && migrated.contextualPromptPrefix.includes('You are an AAC assistant generating responses on behalf of')) {
          migrated.contextualPromptPrefix = ''
          // Write the corrected value back to the store immediately
          api.set('contextualPromptPrefix', '').catch(() => {})
          console.log('[GazeSettingsContext] Migrated old long contextualPromptPrefix → empty default')
        }
        // ── Migration: promote legacy single movieTimeYoutubeKey into the new array ──
        if (migrated.movieTimeYoutubeKey?.trim() && (!migrated.movieTimeYoutubeKeys || migrated.movieTimeYoutubeKeys.length === 0)) {
          migrated.movieTimeYoutubeKeys = [{ key: migrated.movieTimeYoutubeKey.trim(), label: 'Key 1' }]
          api.set('movieTimeYoutubeKeys', migrated.movieTimeYoutubeKeys).catch(() => {})
          console.log('[GazeSettingsContext] Migrated movieTimeYoutubeKey → movieTimeYoutubeKeys[0]')
        }
        // Merge stored values over defaults (forward-compat: new keys use defaults)
        // Force video augmentation AND camera streaming off on every startup to
        // improve startup time and prevent automatic webcam activation;
        // user must manually re-enable these each session.
        migrated.cameraAugmentationEnabled = false
        migrated.cameraStreamingEnabled = false
        setSettings(prev => ({ ...prev, ...migrated }))
        // Persist the forced-off state back to store so it stays consistent
        api.set('cameraAugmentationEnabled', false).catch(() => {})
        api.set('cameraStreamingEnabled', false).catch(() => {})
        console.log('[GazeSettingsContext] Hydrated from electron-store (camera features forced off at startup):', migrated)
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
    setSettings(prev => {
      const merged = { ...prev, ...patch }
      
      // Merge deleted lists first
      if (patch.deletedFaceIds) {
        merged.deletedFaceIds = mergeDeletedLists(prev.deletedFaceIds, patch.deletedFaceIds)
      }
      if (patch.deletedPhotoIds) {
        merged.deletedPhotoIds = mergeDeletedLists(prev.deletedPhotoIds, patch.deletedPhotoIds)
      }
      if (patch.deletedObjectIds) {
        merged.deletedObjectIds = mergeDeletedLists(prev.deletedObjectIds, patch.deletedObjectIds)
      }

      // Merge and filter registered faces and objects
      if (prev.registeredFaces && patch.registeredFaces) {
        merged.registeredFaces = mergeSettingsLists(
          prev.registeredFaces, 
          patch.registeredFaces, 
          merged.deletedFaceIds, 
          merged.deletedPhotoIds
        )
      } else if (patch.registeredFaces) {
        merged.registeredFaces = mergeSettingsLists(
          [], 
          patch.registeredFaces, 
          merged.deletedFaceIds, 
          merged.deletedPhotoIds
        )
      }
      
      if (prev.registeredObjects && patch.registeredObjects) {
        merged.registeredObjects = mergeSettingsLists(
          prev.registeredObjects, 
          patch.registeredObjects, 
          merged.deletedObjectIds, 
          []
        )
      } else if (patch.registeredObjects) {
        merged.registeredObjects = mergeSettingsLists(
          [], 
          patch.registeredObjects, 
          merged.deletedObjectIds, 
          []
        )
      }

      Promise.resolve().then(() => {
        Object.entries(merged).forEach(([key, value]) => {
          if (patch[key] !== undefined || 
              key === 'registeredFaces' || 
              key === 'registeredObjects' ||
              key === 'deletedFaceIds' ||
              key === 'deletedPhotoIds' ||
              key === 'deletedObjectIds') {
            persistKey(key, value)
          }
        })
      })

      return merged
    })
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

  // ── Debounced Cloud Sync: push settings whenever they change (and logged in) ────
  useEffect(() => {
    const uid = currentUser?.uid
    if (!uid || !storeReady || !isInitialSyncCompleted) return

    const timer = setTimeout(() => {
      const adapter = SyncAdapter.getInstance()
      adapter.pushSettings(settings, settings.deviceId)
    }, 1500) // 1.5s debounce to protect Firestore quotas

    return () => clearTimeout(timer)
  }, [settings, currentUser, storeReady, isInitialSyncCompleted])

  // ── Firebase Auth & Cloud Sync Merging ─────────────────────────────────────
  useEffect(() => {
    if (!storeReady) return

    const unsubscribe = subscribeToAuth(async (user) => {
      setCurrentUser(user)
      if (user) {
        console.log('[GazeSettingsContext] Caregiver connected:', user.email)
        const adapter = SyncAdapter.getInstance()

        if (typeof adapter.migrateUidToEmailIfNeeded === 'function') {
          try {
            await adapter.migrateUidToEmailIfNeeded(user)
          } catch (mErr) {
            console.warn('[GazeSettingsContext] Migration failed or skipped:', mErr)
          }
        }

        const currentSettings = settingsRef.current

        // 1. Sync & Hydrate Settings
        try {
          const remoteSettings = await adapter.pullSettings(currentSettings.deviceId)
          if (remoteSettings) {
            const merged = { ...currentSettings, ...remoteSettings }
            
            // Merge deleted lists first
            merged.deletedFaceIds = mergeDeletedLists(currentSettings.deletedFaceIds, remoteSettings.deletedFaceIds)
            merged.deletedPhotoIds = mergeDeletedLists(currentSettings.deletedPhotoIds, remoteSettings.deletedPhotoIds)
            merged.deletedObjectIds = mergeDeletedLists(currentSettings.deletedObjectIds, remoteSettings.deletedObjectIds)

            // Intelligent merge to prevent data loss when remote data is empty/outdated
            merged.registeredFaces = mergeSettingsLists(
              currentSettings.registeredFaces, 
              remoteSettings.registeredFaces, 
              merged.deletedFaceIds, 
              merged.deletedPhotoIds
            )
            merged.registeredObjects = mergeSettingsLists(
              currentSettings.registeredObjects, 
              remoteSettings.registeredObjects, 
              merged.deletedObjectIds, 
              []
            )

            // Write-through to electron-store
            Object.entries(merged).forEach(([k, v]) => {
              if (remoteSettings[k] !== undefined || 
                  k === 'registeredFaces' || 
                  k === 'registeredObjects' ||
                  k === 'deletedFaceIds' ||
                  k === 'deletedPhotoIds' ||
                  k === 'deletedObjectIds') {
                window.gazeAPI?.settings?.set(k, v).catch(() => {})
              }
            })
            // Force video augmentation and camera streaming off even after cloud sync,
            // to prevent remote settings from re-enabling the webcam at startup.
            merged.cameraAugmentationEnabled = false
            merged.cameraStreamingEnabled = false

            setSettings(merged)
            console.log('[GazeSettingsContext] Remote settings synced & local hydrated (camera features forced off)')
            
            // Seed back the merged settings to the cloud immediately to prevent local offline additions from being lost
            await adapter.pushSettings(merged, currentSettings.deviceId)
            console.log('[GazeSettingsContext] Merged local settings successfully seeded back to remote database')

            // Defer setting sync completed to the next tick so the settings state update is fully committed first!
            setTimeout(() => {
              setIsInitialSyncCompleted(true)
            }, 100)
          } else {
            // First run on new cloud account: seed remote database
            await adapter.pushSettings(currentSettings, currentSettings.deviceId)
            setIsInitialSyncCompleted(true)
          }
        } catch (err) {
          console.warn('[GazeSettingsContext] Error during settings pull sync:', err)
          setIsInitialSyncCompleted(true)
        }

        // 2. Sync User Profile
        try {
          const remoteProfile = await adapter.pullUserProfile()
          const localProfile = await window.gazeAPI?.userProfile?.get()
          if (remoteProfile) {
            const mergedProfile = { ...localProfile, ...remoteProfile }
            await window.gazeAPI?.userProfile?.set(mergedProfile)
            await adapter.pushUserProfile(mergedProfile)
            console.log('[GazeSettingsContext] Remote user profile hydration complete (merged)')
          } else if (localProfile) {
            await adapter.pushUserProfile(localProfile)
          }
        } catch (err) {
          console.warn('[GazeSettingsContext] Error syncing user profile:', err)
        }

        // 3. Sync Board Edits
        try {
          const remoteEdits = await adapter.pullBoardEdits()
          const localEdits = await window.gazeAPI?.boardEdits?.getAll()
          if (remoteEdits) {
            const mergedEdits = { ...localEdits, ...remoteEdits }
            await window.gazeAPI?.settings?.set('boardEdits', mergedEdits)
            await adapter.pushBoardEdits(mergedEdits)
            console.log('[GazeSettingsContext] Remote board edits hydration complete (merged)')
          } else if (localEdits && Object.keys(localEdits).length > 0) {
            await adapter.pushBoardEdits(localEdits)
          }
        } catch (err) {
          console.warn('[GazeSettingsContext] Error syncing board edits:', err)
        }

        // 4. Sync AI History
        try {
          const remoteHistory = await adapter.pullAIHistory()
          const localHistory = await window.gazeAPI?.aiHistory?.getAll() ?? []
          if (remoteHistory && remoteHistory.length > 0) {
            const mergedMap = new Map()
            localHistory.forEach(h => mergedMap.set(h.savedAt, h))
            remoteHistory.forEach(h => mergedMap.set(h.savedAt, h))
            const mergedHistory = Array.from(mergedMap.values()).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))

            await window.gazeAPI?.settings?.set('aiHistory', mergedHistory)
            await adapter.pushAIHistory(mergedHistory)
            console.log('[GazeSettingsContext] Remote AI history hydration complete (merged)')
          } else if (localHistory.length > 0) {
            await adapter.pushAIHistory(localHistory)
          }
        } catch (err) {
          console.warn('[GazeSettingsContext] Error syncing AI history:', err)
        }

        // 5. Sync Session History
        try {
          const remoteSessions = await adapter.pullSessionLog()
          const localSessions = await window.gazeAPI?.sessions?.getAll() ?? []

          if (remoteSessions && remoteSessions.length > 0) {
            const mergedMap = new Map()
            localSessions.forEach(s => mergedMap.set(s.savedAt || s.date, s))
            remoteSessions.forEach(s => mergedMap.set(s.savedAt || s.date, s))
            const mergedArray = Array.from(mergedMap.values()).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))

            await window.gazeAPI?.settings?.set('sessionLog', mergedArray.slice(-90))
            await adapter.pushSessionLog(mergedArray)
            console.log('[GazeSettingsContext] Remote session logs merged & synced')
          } else if (localSessions.length > 0) {
            await adapter.pushSessionLog(localSessions)
          }
        } catch (err) {
          console.warn('[GazeSettingsContext] Error syncing session history:', err)
        }

        // 6. Initial Quiz Sync (one-shot pull to seed local state before real-time listener starts)
        try {
          const remoteQuizzes = await adapter.pullQuizzes()
          const localQuizzesRaw = localStorage.getItem('gazeaac_quizzes')
          let localQuizzes = []
          try { if (localQuizzesRaw) localQuizzes = JSON.parse(localQuizzesRaw) } catch (_) {}

          if (remoteQuizzes && remoteQuizzes.length > 0) {
            // Merge: prefer the version with the higher updatedAt timestamp
            const mergedMap = new Map()
            localQuizzes.forEach(q => { if (q && q.id) mergedMap.set(q.id, q) })
            remoteQuizzes.forEach(q => {
              if (q && q.id) {
                const existing = mergedMap.get(q.id)
                if (!existing || (q.updatedAt || 0) >= (existing.updatedAt || 0)) {
                  mergedMap.set(q.id, q)
                }
              }
            })
            const sortedQuizzes = sortQuizzes(Array.from(mergedMap.values()))

            localStorage.setItem('gazeaac_quizzes', JSON.stringify(sortedQuizzes))
            window.gazeAPI?.settings?.set('quizzes', sortedQuizzes).catch(() => {})
            setQuizzes(sortedQuizzes)
            console.log('[GazeSettingsContext] Remote quizzes synced & merged')
          } else if (localQuizzes.length > 0) {
            await adapter.pushQuizzes(localQuizzes)
          }
        } catch (err) {
          console.warn('[GazeSettingsContext] Error syncing quizzes:', err)
        }
      } else {
        console.log('[GazeSettingsContext] Caregiver disconnected')
        setIsInitialSyncCompleted(false)
      }
    })

    return unsubscribe
  }, [storeReady])

  // ── Real-time Quiz Listener ─────────────────────────────────────────────────
  // Subscribes to Firestore onSnapshot so any quiz change from the web console
  // or another device is reflected in the app instantly without a restart.
  useEffect(() => {
    if (!currentUser?.email && !currentUser?.uid) return
    const adapter = SyncAdapter.getInstance()
    if (typeof adapter.subscribeToQuizzes !== 'function') return

    const unsub = adapter.subscribeToQuizzes((remoteQuizzes) => {
      if (!remoteQuizzes || remoteQuizzes.length === 0) return
      // Merge snapshot with current local state, preferring newer updatedAt
      setQuizzes(prev => {
        const mergedMap = new Map()
        prev.forEach(q => { if (q && q.id) mergedMap.set(q.id, q) })
        remoteQuizzes.forEach(q => {
          if (q && q.id) {
            const existing = mergedMap.get(q.id)
            if (!existing || (q.updatedAt || 0) >= (existing.updatedAt || 0)) {
              mergedMap.set(q.id, q)
            }
          }
        })
        const sorted = sortQuizzes(Array.from(mergedMap.values()))
        localStorage.setItem('gazeaac_quizzes', JSON.stringify(sorted))
        window.gazeAPI?.settings?.set('quizzes', sorted).catch(() => {})
        return sorted
      })
    })

    return () => {
      if (typeof unsub === 'function') unsub()
    }
  }, [currentUser?.email, currentUser?.uid])

  // ── Automatic Background Sync on Reconnection ───────────────────────────────
  useEffect(() => {
    const handleOnline = async () => {
      const uid = currentUser?.uid
      if (!uid || !storeReady || !isInitialSyncCompleted) return

      console.log('[GazeSettingsContext] Network back online. Triggering automatic cloud sync...')
      const adapter = SyncAdapter.getInstance()
      const currentSettings = settingsRef.current

      try {
        // 1. Settings pull, merge, and seed-back
        const remoteSettings = await adapter.pullSettings(currentSettings.deviceId)
        if (remoteSettings) {
          const merged = { ...currentSettings, ...remoteSettings }
          
          merged.deletedFaceIds = mergeDeletedLists(currentSettings.deletedFaceIds, remoteSettings.deletedFaceIds)
          merged.deletedPhotoIds = mergeDeletedLists(currentSettings.deletedPhotoIds, remoteSettings.deletedPhotoIds)
          merged.deletedObjectIds = mergeDeletedLists(currentSettings.deletedObjectIds, remoteSettings.deletedObjectIds)

          merged.registeredFaces = mergeSettingsLists(
            currentSettings.registeredFaces, 
            remoteSettings.registeredFaces, 
            merged.deletedFaceIds, 
            merged.deletedPhotoIds
          )
          merged.registeredObjects = mergeSettingsLists(
            currentSettings.registeredObjects, 
            remoteSettings.registeredObjects, 
            merged.deletedObjectIds, 
            []
          )

          // Write-through to electron-store
          Object.entries(merged).forEach(([k, v]) => {
            if (remoteSettings[k] !== undefined || 
                k === 'registeredFaces' || 
                k === 'registeredObjects' ||
                k === 'deletedFaceIds' ||
                k === 'deletedPhotoIds' ||
                k === 'deletedObjectIds') {
              window.gazeAPI?.settings?.set(k, v).catch(() => {})
            }
          })
          
          // Force camera features off at startup/sync to prevent unwanted activation
          merged.cameraAugmentationEnabled = false
          merged.cameraStreamingEnabled = false

          setSettings(merged)
          await adapter.pushSettings(merged, currentSettings.deviceId)
          console.log('[GazeSettingsContext] Settings synced successfully after reconnect')
        }

        // 2. Sync User Profile
        const remoteProfile = await adapter.pullUserProfile()
        const localProfile = await window.gazeAPI?.userProfile?.get()
        if (remoteProfile) {
          const mergedProfile = { ...localProfile, ...remoteProfile }
          await window.gazeAPI?.userProfile?.set(mergedProfile)
          await adapter.pushUserProfile(mergedProfile)
        } else if (localProfile) {
          await adapter.pushUserProfile(localProfile)
        }

        // 3. Sync Board Edits
        const remoteEdits = await adapter.pullBoardEdits()
        const localEdits = await window.gazeAPI?.boardEdits?.getAll()
        if (remoteEdits) {
          const mergedEdits = { ...localEdits, ...remoteEdits }
          await window.gazeAPI?.settings?.set('boardEdits', mergedEdits)
          await adapter.pushBoardEdits(mergedEdits)
        } else if (localEdits && Object.keys(localEdits).length > 0) {
          await adapter.pushBoardEdits(localEdits)
        }

        // 4. Sync AI History
        const remoteHistory = await adapter.pullAIHistory()
        const localHistory = await window.gazeAPI?.aiHistory?.getAll() ?? []
        if (remoteHistory && remoteHistory.length > 0) {
          const mergedMap = new Map()
          localHistory.forEach(h => mergedMap.set(h.savedAt, h))
          remoteHistory.forEach(h => mergedMap.set(h.savedAt, h))
          const mergedHistory = Array.from(mergedMap.values()).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))

          await window.gazeAPI?.settings?.set('aiHistory', mergedHistory)
          await adapter.pushAIHistory(mergedHistory)
        } else if (localHistory.length > 0) {
          await adapter.pushAIHistory(localHistory)
        }

        // 5. Sync Session History
        const remoteSessions = await adapter.pullSessionLog()
        const localSessions = await window.gazeAPI?.sessions?.getAll() ?? []
        if (remoteSessions && remoteSessions.length > 0) {
          const mergedMap = new Map()
          localSessions.forEach(s => mergedMap.set(s.savedAt || s.date, s))
          remoteSessions.forEach(s => mergedMap.set(s.savedAt || s.date, s))
          const mergedArray = Array.from(mergedMap.values()).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))

          await window.gazeAPI?.settings?.set('sessionLog', mergedArray.slice(-90))
          await adapter.pushSessionLog(mergedArray)
        } else if (localSessions.length > 0) {
          await adapter.pushSessionLog(localSessions)
        }

        // 6. Sync Quizzes (background reconnect — real-time listener handles live updates)
        const remoteQuizzes = await adapter.pullQuizzes()
        const localQuizzesRaw = localStorage.getItem('gazeaac_quizzes')
        let localQuizzes = []
        try { if (localQuizzesRaw) localQuizzes = JSON.parse(localQuizzesRaw) } catch (_) {}
        if (remoteQuizzes && remoteQuizzes.length > 0) {
          // Merge: prefer the version with the higher updatedAt timestamp
          const mergedMap = new Map()
          localQuizzes.forEach(q => { if (q && q.id) mergedMap.set(q.id, q) })
          remoteQuizzes.forEach(q => {
            if (q && q.id) {
              const existing = mergedMap.get(q.id)
              if (!existing || (q.updatedAt || 0) >= (existing.updatedAt || 0)) {
                mergedMap.set(q.id, q)
              }
            }
          })
          const sortedQuizzes = sortQuizzes(Array.from(mergedMap.values()))

          localStorage.setItem('gazeaac_quizzes', JSON.stringify(sortedQuizzes))
          window.gazeAPI?.settings?.set('quizzes', sortedQuizzes).catch(() => {})
          setQuizzes(sortedQuizzes)
          await adapter.pushQuizzes(sortedQuizzes)
        } else if (localQuizzes.length > 0) {
          await adapter.pushQuizzes(localQuizzes)
        }

        console.log('[GazeSettingsContext] Background catch-up sync completed successfully')
      } catch (err) {
        console.warn('[GazeSettingsContext] Error during background catch-up sync:', err)
      }
    }

    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [currentUser, storeReady, isInitialSyncCompleted])

  return (
    <GazeSettingsContext.Provider
      value={{ settings, updateSetting, updateSettings, resetSettings, storeReady, currentUser, quizzes, saveQuizzes, deleteQuizLocally }}
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
