import { contextBridge, ipcRenderer } from 'electron'

/**
 * GazeAAC Preload Script
 *
 * Exposes a minimal, security-scoped API surface to the renderer via
 * contextBridge. The renderer CANNOT access Node.js or Electron APIs directly.
 *
 * API shape (available as `window.gazeAPI` in the renderer):
 *
 *   gazeAPI.startStream(callback)  – Begin receiving GazePoint objects.
 *   gazeAPI.stopStream()           – Stop the gaze stream.
 *   gazeAPI.speak(text)            – Request TTS output for a string.
 *   gazeAPI.windowControl(action)  – Minimize / maximize / close the window.
 *   gazeAPI.onStreamStateChange(cb)– Notified when stream starts or stops.
 *   gazeAPI.trackerMode            – 'tobii' | 'mock' (set after stream start)
 */

// Internal cleanup reference so we can remove the listener on stopStream()
let _gazeDataListener = null

// Tracker mode is updated by the main process once the stream starts
let _trackerMode = 'mock'
ipcRenderer.on('ipc:tracker-mode', (_event, mode) => {
  _trackerMode = mode
})

contextBridge.exposeInMainWorld('gazeAPI', {
  /**
   * Retrieve the current app version from package.json.
   * @returns {Promise<string>}
   */
  getVersion() {
    return ipcRenderer.invoke('ipc:get-app-version')
  },

  /**
   * Start the gaze data stream.
   * @param {(gazePoint: { x: number, y: number, timestamp: number, valid: boolean }) => void} callback
   */
  startStream(callback) {
    // Remove any previously registered listener to avoid duplicates
    if (_gazeDataListener) {
      ipcRenderer.removeListener('ipc:gaze-data', _gazeDataListener)
    }

    _gazeDataListener = (_event, gazePoint) => callback(gazePoint)
    ipcRenderer.on('ipc:gaze-data', _gazeDataListener)
    ipcRenderer.send('ipc:gaze-stream-start')
  },

  /**
   * Register a callback for tracker mode changes.
   * Returns an unsubscribe function.
   * @param {(mode: 'tobii'|'mouse'|'mock') => void} callback
   */
  onTrackerModeChange(callback) {
    const handler = (_event, mode) => callback(mode)
    ipcRenderer.on('ipc:tracker-mode', handler)
    return () => ipcRenderer.removeListener('ipc:tracker-mode', handler)
  },

  /**
   * Stop the gaze data stream and clean up the listener.
   */
  stopStream() {
    ipcRenderer.send('ipc:gaze-stream-stop')
    if (_gazeDataListener) {
      ipcRenderer.removeListener('ipc:gaze-data', _gazeDataListener)
      _gazeDataListener = null
    }
  },

  /**
   * Request text-to-speech for the provided string.
   * Phase 1: main process acks, renderer handles utterance via Web Speech API.
   * @param {string} text
   * @returns {Promise<{ ok: boolean }>}
   */
  speak(text) {
    return ipcRenderer.invoke('ipc:tts-speak', text)
  },

  /**
   * Register a callback for TTS completed events.
   * Returns an unsubscribe function.
   * @param {() => void} callback
   */
  onTtsCompleted(callback) {
    const handler = (_event) => callback()
    ipcRenderer.on('ipc:tts-completed', handler)
    return () => ipcRenderer.removeListener('ipc:tts-completed', handler)
  },

  /**
   * Native TTS utilities.
   */
  tts: {
    /**
     * Enumerate installed Windows SAPI voices.
     * Returns an array of { name, gender, age, culture, engine } objects.
     * @returns {Promise<Array<{ name: string, gender: string, age: string, culture: string, engine: string }>>}
     */
    listVoices() {
      return ipcRenderer.invoke('ipc:tts-list-voices', 'sapi')
    },

    /**
     * Enumerate installed voices for the given TTS engine.
     * engine: 'sapi' | 'winrt'
     * 'winrt' surfaces Natural / OneCore / Azure Edge-Powered voices.
     * @param {'sapi'|'winrt'} engine
     * @returns {Promise<Array<{ name: string, gender: string, age: string, culture: string, engine: string }>>}
     */
    listVoicesByEngine(engine) {
      return ipcRenderer.invoke('ipc:tts-list-voices', engine)
    }
  },

  /**
   * Control the frameless window.
   * @param {'minimize'|'maximize'|'close'} action
   */
  windowControl(action) {
    ipcRenderer.send('ipc:window-control', action)
  },

  /**
   * The active gaze source: 'tobii' when the real Tobii SDK is running,
   * 'mock' when using MockGazeEmitter. Updated after ipc:gaze-stream-start.
   * @type {'tobii' | 'mock'}
   */
  get trackerMode() {
    return _trackerMode
  },

  /**
   * Persistent settings store (backed by electron-store in the main process).
   * All read/write operations are async IPC invoke calls.
   */
  settings: {
    /**
     * Retrieve the full settings object from the persistent store.
     * @returns {Promise<Record<string, unknown>>}
     */
    getAll() {
      return ipcRenderer.invoke('ipc:settings-get')
    },

    /**
     * Persist a single key-value pair to the store.
     * @param {string} key
     * @param {*} value
     * @returns {Promise<{ ok: boolean }>}
     */
    set(key, value) {
      return ipcRenderer.invoke('ipc:settings-set', key, value)
    },

    /**
     * Reset all settings to factory defaults.
     * @returns {Promise<Record<string, unknown>>} – The restored defaults
     */
    reset() {
      return ipcRenderer.invoke('ipc:settings-reset')
    }
  },

  /**
   * M5: Session log persistence.
   * All operations are async IPC invoke calls backed by electron-store.
   */
  sessions: {
    /**
     * Append one SessionRecord to the persistent log.
     * @param {{ date: string, wordActivations: number, abandonedDwells: number, stageUsed: number, topWords: string[] }} record
     */
    log(record) {
      return ipcRenderer.invoke('ipc:session-log-append', record)
    },

    /** Retrieve the full session log array. */
    getAll() {
      return ipcRenderer.invoke('ipc:session-log-get')
    },

    /** Clear the entire session log. */
    clear() {
      return ipcRenderer.invoke('ipc:session-log-clear')
    },

    /**
     * Open a save-file dialog and write csvContent to the chosen path.
     * @param {string} csvContent
     */
    exportCsv(csvContent) {
      return ipcRenderer.invoke('ipc:session-export-csv', csvContent)
    }
  },

  /**
   * AAC board library (from AACBoards/*.obz on disk).
   * Only the default board is pre-loaded at startup; others are loaded on demand.
   */
  aacBoards: {
    /**
     * List all board files available in AACBoards/ (no buffers — fast).
     * @returns {Promise<Array<{ fileName: string, cached: boolean }>>}
     */
    list() {
      return ipcRenderer.invoke('ipc:aacboards-list')
    },

    /**
     * Load a single board file on demand.
     * Returns immediately from cache on subsequent calls for the same file.
     * @param {string} fileName  e.g. "communikate-20.obz"
     * @returns {Promise<{ fileName: string, buffer: number[] }>}
     */
    loadOne(fileName) {
      return ipcRenderer.invoke('ipc:aacboards-load-one', fileName)
    },

    /**
     * Retrieve all boards currently in memory (pre-loaded + any on-demand loaded).
     * @returns {Promise<Array<{ fileName: string, buffer: number[] }>>}
     */
    getAll() {
      return ipcRenderer.invoke('ipc:aacboards-get-all')
    }
  },

  /**
   * Per-button board edit deltas (backed by electron-store).
   * editKey format: "fileName:boardId:btnId"
   */
  boardEdits: {
    /** Retrieve all stored edit patches. */
    getAll() {
      return ipcRenderer.invoke('ipc:board-edits-get')
    },
    /**
     * Merge a patch into the stored delta for a specific button.
     * Pass patch=null to reset the button to its original OBF values.
     * @param {string} editKey   e.g. "communikate-20.obz:board1:btn_42"
     * @param {object|null} patch  Partial ButtonPatch or null to reset.
     */
    set(editKey, patch) {
      return ipcRenderer.invoke('ipc:board-edits-set', editKey, patch)
    },
    /** Wipe all board edits (factory reset). */
    clearAll() {
      return ipcRenderer.invoke('ipc:board-edits-clear-all')
    }
  },

  /**
   * AI Interaction History — persists context → response pairs so the model
   * learns Johnny's communication patterns over time.
   * Backed by electron-store, capped at 200 entries.
   */
  aiHistory: {
    /**
     * Append one context → responses interaction to the persistent log.
     * @param {{ context: string, responses: string[], chosen?: string }} entry
     * @returns {Promise<{ ok: boolean, total: number }>}
     */
    append(entry) {
      return ipcRenderer.invoke('ipc:ai-history-append', entry)
    },

    /**
     * Retrieve the full AI interaction history array.
     * @returns {Promise<Array<{ context: string, responses: string[], chosen?: string[], savedAt: number }>>}
     */
    getAll() {
      return ipcRenderer.invoke('ipc:ai-history-get')
    },

    /**
     * Clear all stored AI interaction history.
     * @returns {Promise<{ ok: boolean }>}
     */
    clear() {
      return ipcRenderer.invoke('ipc:ai-history-clear')
    },

    /**
     * Delete a single history entry by its savedAt timestamp.
     * @param {number} savedAt
     * @returns {Promise<{ ok: boolean, total: number }>}
     */
    delete(savedAt) {
      return ipcRenderer.invoke('ipc:ai-history-delete', savedAt)
    },

    /**
     * Record a chosen response on the most recent history entry.
     * Multiple choices per context are supported (stored as string[]).
     * @param {string} chosenText
     * @returns {Promise<{ ok: boolean }>}
     */
    recordChoice(chosenText) {
      return ipcRenderer.invoke('ipc:ai-history-record-choice', chosenText)
    }
  },

  /**
   * Johnny's user profile — stored persistently and injected into every
   * AI system prompt so responses stay age-appropriate and personalised.
   */
  userProfile: {
    /**
     * Retrieve the stored user profile.
     * @returns {Promise<{ name: string, age: number, location: string, family: { father: string, mother: string } }>}
     */
    get() {
      return ipcRenderer.invoke('ipc:user-profile-get')
    },

    /**
     * Persist updates to the user profile.
     * @param {object} profile  Partial or full profile object
     * @returns {Promise<{ ok: boolean, profile: object }>}
     */
    set(profile) {
      return ipcRenderer.invoke('ipc:user-profile-set', profile)
    }
  },

  /**
   * In-app gaze calibration correction — a lightweight offset+scale
   * transform applied on top of Tobii's hardware calibration.
   * Persisted in electron-store across sessions.
   */
  gazeCorrection: {
    /** Retrieve the stored correction transform. */
    get() {
      return ipcRenderer.invoke('ipc:gaze-correction-get')
    },
    /** Persist a new correction transform. */
    set(correction) {
      return ipcRenderer.invoke('ipc:gaze-correction-set', correction)
    },
    /** Clear the correction (revert to raw Tobii pass-through). */
    reset() {
      return ipcRenderer.invoke('ipc:gaze-correction-reset')
    },
    /** Clear the correction (alias for reset). */
    clear() {
      return ipcRenderer.invoke('ipc:gaze-correction-reset')
    },
  },

  /**
   * Native Windows SAPI speech-to-text.
   * Works fully offline via System.Speech.Recognition in a PowerShell child process.
   */
  mic: {
    /** Start the SAPI STT engine. Transcripts are delivered via onTranscript(). */
    start() {
      return ipcRenderer.invoke('ipc:mic-start')
    },
    /** Stop the SAPI STT engine. */
    stop() {
      return ipcRenderer.invoke('ipc:mic-stop')
    },
    /** Trigger Windows Voice Typing (Win+H) */
    triggerVoiceTyping(desiredState) {
      return ipcRenderer.invoke('ipc:trigger-voice-typing', desiredState)
    },
    /**
     * Register a callback for incoming transcript strings.
     * Returns an unsubscribe function.
     * @param {(text: string) => void} callback
     */
    onTranscript(callback) {
      const handler = (_event, text) => callback(text)
      ipcRenderer.on('ipc:mic-transcript', handler)
      return () => ipcRenderer.removeListener('ipc:mic-transcript', handler)
    },
    /** Called once when the SAPI engine finishes compiling and is ready to listen. */
    onReady(callback) {
      ipcRenderer.once('ipc:mic-ready', () => callback())
    },
    /**
     * Register a callback for STT errors.
     * @param {(msg: string) => void} callback
     */
    onError(callback) {
      const handler = (_event, msg) => callback(msg)
      ipcRenderer.on('ipc:mic-error', handler)
      return () => ipcRenderer.removeListener('ipc:mic-error', handler)
    },
    /**
     * Pipeline stage updates: 'recognizers=N', 'engine=…', 'mic-connected',
     * 'grammar-loaded', 'listening', 'got-transcript', 'audio-problem=…'
     * @param {(stage: string) => void} callback
     */
    onStatus(callback) {
      const handler = (_event, stage) => callback(stage)
      ipcRenderer.on('ipc:mic-status', handler)
      return () => ipcRenderer.removeListener('ipc:mic-status', handler)
    },
    /**
     * SAPI heard speech but confidence was below the acceptance threshold.
     * Useful for diagnosing "SAPI runs but produces no transcripts" situations.
     * @param {(data: { confidence: number, text: string }) => void} callback
     */
    onRejected(callback) {
      const handler = (_event, data) => callback(data)
      ipcRenderer.on('ipc:mic-rejected', handler)
      return () => ipcRenderer.removeListener('ipc:mic-rejected', handler)
    }
  },
  wifi: {
    getWifiUploadUrl() {
      return ipcRenderer.invoke('ipc:get-wifi-upload-url')
    },
    onMobilePhotoUploaded(callback) {
      const handler = (_event, data) => callback(data)
      ipcRenderer.on('ipc:mobile-photo-uploaded', handler)
      return () => ipcRenderer.removeListener('ipc:mobile-photo-uploaded', handler)
    }
  },
  fetchUrl(url) {
    return ipcRenderer.invoke('ipc:fetch-url', url)
  }
})
