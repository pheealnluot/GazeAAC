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
  }
})
