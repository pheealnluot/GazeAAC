import { app, BrowserWindow, ipcMain, shell, dialog, screen } from 'electron'
import { writeFile, readFile, readdir } from 'fs/promises'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { TobiiGazeProvider } from './TobiiGazeProvider.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/** Default settings schema — mirrors GazeSettingsContext DEFAULT_SETTINGS.
 *  IMPORTANT: every key that the renderer may persist via ipc:settings-set MUST
 *  appear here, otherwise the allowlist check in ipc:settings-set will silently
 *  reject the write and the setting will revert to its default on next launch.
 */
const STORE_DEFAULTS = {
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
  cursorSize: 20,               // gaze cursor diameter in px
  cursorShape: 'circle',        // 'circle' | 'crosshair' | 'ring' | 'dot' | 'diamond'
  feedbackPattern: 'ring-pulse',
  unmaskedBoxSize: '1x',        // '1x' | '2x' | '3x' | 'full'
  // M4
  showIcons: true,
  speakOnWord: true,
  autoReturnHome: true,
  autoReturnFromSubPage: true,  // LAMP WFL motor planning: auto-return to home after sub-page selection
  // M5
  caregiverPin: '0000',         // 4-digit PIN protecting the Caregiver Panel
  customVocabIds: [],           // Stage 1 custom cell IDs; empty → use hardcoded 4-word default
  sessionLog: [],               // Array of SessionRecord objects (capped at 90)
  boardEdits: {},               // Delta edits keyed as "fileName:boardId:btnId" → ButtonPatch
  // M6 — Settings revamp
  aiSuggestions: false,
  selectedBorderColor: '#00c8ff',
  gridOpacity: 1.0,
  dwellProgressStyle: 'circle',
  dwellProgressPosition: 'center',
  ttsVoice: '',
  // Board settings
  fontScale: 2.0,
  symbolScale: 2.0,
  symbolOnTop: false,
  gridFontColor: '#ffffff',
  // Navigation click sound
  navClickSound: false,
  navClickVolume: 0.35,
  navClickTone: 'soft',
  // Input method — true means mouse hover drives dwell when no eye tracker is found
  mouseHoverMode: true,
  // Contextual Response board
  contextualResponseEnabled: false,
  contextualResponseModel: 'ollama',
  contextualOllamaModel: 'llama3.2',
  contextualOllamaVisionModel: 'llava',
  contextualResponseCount: 3,
  contextualResponseAction: 'both',
  // Life Lore, Prompt Prefix & System Prompt
  contextualPromptPrefix: `You are an AAC assistant generating responses on behalf of [User Name], a [Age]-year-old child who lives in [Location]. Father is [Father] and Mother is [Mother]. You will speak as the voice of the [User Name].
Your job is to suggest between 2 and [Max] short, natural, age-appropriate communication phrases that [User Name] might actually say.
Vary the responses: mix single words, short phrases, full sentences, questions, and expressions.
Return ONLY a valid JSON array of strings — no explanation, no markdown, no extra text.
Example: ["I want to play!", "Can we call Daddy?", "Not now, please"]
Prioritize the usefulness of the responses.
If the question presents choices, ensure the responses contain the choices to allow the user to select them. For example, if the question is for CHOICE A OR CHOICE B, the response should at least include 1) CHOICE A, 2) CHOICE B, 3) BOTH, 4) NONE.`,
  contextualLifeLore: '',
  contextualSystemPrompt: '',      // Fully custom system prompt body; empty = use built-in default
  // AI Interaction History — persisted Q&A pairs that prime the model over time
  // Each entry: { context: string, responses: string[], chosen?: string, savedAt: number }
  aiHistory: [],
  // User profile embedded into every AI system prompt
  userProfile: {
    name:     'Caden Chye',
    age:      9,
    location: 'Singapore',
    family:   { father: 'James', mother: 'Venus' },
  },
}


// ─── electron-store: loaded asynchronously (pure ESM in v10+) ────────────────
// The store reference is populated inside app.whenReady() before createWindow().
let store = null

async function initStore() {
  try {
    const { default: Store } = await import('electron-store')
    store = new Store({ name: 'gaze-settings', defaults: STORE_DEFAULTS })
    console.log('[main] electron-store initialized')
  } catch (err) {
    console.warn('[main] electron-store not available — settings will not persist:', err.message)
    store = null
  }
}

// ─── Dev / Prod helpers ───────────────────────────────────────────────────────
const isDev = !app.isPackaged

// ─── AACBoards ────────────────────────────────────────────────────────────────
// Resolve the AACBoards directory relative to the project root.
// In dev: __dirname is electron/ so we go up one level.
// In prod (out/main/): go up two levels to the app root.
// electron-vite always compiles main → out/main/index.js (dev AND prod).
// So import.meta.url always points inside out/main/; go up two levels to reach the project root.
const _projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../')
const AACBOARDS_DIR = join(_projectRoot, 'AACBoards')

/**
 * Only this board is pre-loaded at startup to keep cold-start fast.
 * All other boards in AACBoards/ are available for on-demand loading
 * via ipc:aacboards-load-one once the user selects them.
 */
const PRELOAD_BOARD = 'quick-core-24.obz'

/** Cache: fileName → { fileName, buffer: Array<number> } for boards already in memory */
const _aacBoardCache = new Map()

/** Sorted list of every .obz / .obf file discovered in AACBoards/ (no buffers) */
let _aacBoardManifest = []

/**
 * Scan the AACBoards directory to build _aacBoardManifest, then pre-load
 * only PRELOAD_BOARD into _aacBoardCache.
 */
async function loadAACBoards() {
  try {
    const entries = await readdir(AACBOARDS_DIR)
    // Accept both .obz (ZIP bundle) and .obf (single-board JSON)
    _aacBoardManifest = entries
      .filter(f => { const ext = extname(f).toLowerCase(); return ext === '.obz' || ext === '.obf' })
      .sort()

    // Pre-load only the default board
    if (_aacBoardManifest.includes(PRELOAD_BOARD)) {
      try {
        const buf = await readFile(join(AACBOARDS_DIR, PRELOAD_BOARD))
        _aacBoardCache.set(PRELOAD_BOARD, { fileName: PRELOAD_BOARD, buffer: Array.from(buf) })
        console.log(`[main] AACBoards: pre-loaded "${PRELOAD_BOARD}" (${(buf.length / 1024 / 1024).toFixed(1)} MB)`)
      } catch (fileErr) {
        console.warn(`[main] AACBoards: could not pre-load "${PRELOAD_BOARD}":`, fileErr.message)
      }
    } else {
      console.warn(`[main] AACBoards: default board "${PRELOAD_BOARD}" not found in AACBoards/`)
    }

    console.log(`[main] AACBoards: ${_aacBoardManifest.length} board(s) available (${_aacBoardCache.size} pre-loaded)`)
  } catch (err) {
    console.warn('[main] AACBoards directory not found or unreadable:', err.message)
    _aacBoardManifest = []
  }
}


/**
 * Resolve the renderer URL (Vite dev server in dev, built file in prod).
 * electron-vite 2.x injects ELECTRON_RENDERER_URL in development mode.
 */
function resolveRendererUrl() {
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    return process.env['ELECTRON_RENDERER_URL']
  }
  // Production: renderer root is src/, output goes to out/renderer/index.html
  // From out/main/index.js, the relative path to renderer is ../renderer/index.html
  return join(__dirname, '../renderer/index.html')
}

// ─── Gaze stream state ────────────────────────────────────────────────────────
let gazeEmitter = null
let mainWindow = null

// ─── Window factory ──────────────────────────────────────────────────────────
function createWindow() {
  // electron-vite compiles main.js → out/main/index.js
  // preload.js → out/preload/index.mjs (one level up, then into preload/)
  const preloadPath = join(__dirname, '../preload/index.mjs')

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,               // Frameless – app renders its own chrome
    backgroundColor: '#0d0f14', // Matches design token --color-bg-base
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,   // Security: renderer cannot access Node APIs directly
      nodeIntegration: false,   // Security: no Node in renderer
      sandbox: false            // Required for Electron preload to use require()
    },
    show: false                 // Show only after 'ready-to-show' to prevent flash
  })

  // Open DevTools in development — opened early (before page load) so any
  // startup crash or render error is captured in the console immediately.
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  const url = resolveRendererUrl()
  if (url.startsWith('http')) {
    mainWindow.loadURL(url)
  } else {
    mainWindow.loadFile(url)
  }

  // Graceful show: prevents white flash on startup.
  // Safety timeout: if ready-to-show never fires (e.g. renderer crash on
  // startup), force-show the window after 4 s so the user isn't left with
  // a completely invisible / black window and no feedback.
  let _shown = false
  const _safetyTimer = setTimeout(() => {
    if (!_shown) {
      _shown = true
      console.warn('[main] ready-to-show timeout — force-showing window (possible renderer crash)')
      mainWindow.show()
    }
  }, 4000)

  mainWindow.once('ready-to-show', () => {
    clearTimeout(_safetyTimer)
    _shown = true
    mainWindow.show()
  })

  // Handle external links (open in OS browser, not Electron window)
  mainWindow.webContents.setWindowOpenHandler(({ url: externalUrl }) => {
    shell.openExternal(externalUrl)
    return { action: 'deny' }
  })

  // Invalidate the remap geometry cache whenever the window moves or resizes
  // so remapToWindow() always uses accurate coordinates.
  mainWindow.on('move',   _invalidateRemapCache)
  mainWindow.on('resize', _invalidateRemapCache)
}


// ─── IPC Handlers ─────────────────────────────────────────────────────────────

/**
 * ipc:gaze-stream-start
 * Starts TobiiGazeProvider (real Tobii SDK if available, MockGazeEmitter otherwise).
 * Forwards each GazePoint to the renderer via webContents.send.
 * Also sends the tracker mode string so the renderer's status bar is accurate.
 */
ipcMain.on('ipc:gaze-stream-start', async (event) => {
  if (gazeEmitter) return // Already running

  gazeEmitter = new TobiiGazeProvider((gazePoint) => {
    // gazePoint: { x: number, y: number, timestamp: number, valid: boolean }
    // x, y are normalized to the FULL screen [0,1] (Tobii SDK screen coords).
    // We remap them to be normalized to the APP WINDOW [0,1] so that the
    // gaze dot and hit-boxes are accurate regardless of window position/size.
    const remapped = remapToWindow(gazePoint)
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.send('ipc:gaze-data', remapped)
    }
  })

  // start() is async — it spawns the Python bridge and awaits WS connection
  await gazeEmitter.start()

  // Inform the renderer which tracker source is active (resolved after start)
  const trackerMode = TobiiGazeProvider.isAvailable() ? 'tobii' : 'mouse'
  if (event.sender && !event.sender.isDestroyed()) {
    event.sender.send('ipc:tracker-mode', trackerMode)
  }

  console.log(`[main] Gaze stream started via TobiiGazeProvider (mode: ${trackerMode})`)
})

/**
 * ipc:gaze-stream-stop
 * Stops the emitter and clears the reference.
 */
ipcMain.on('ipc:gaze-stream-stop', () => {
  if (gazeEmitter) {
    gazeEmitter.stop()
    gazeEmitter = null
    console.log('[main] Gaze stream stopped')
  }
})

// ─── Native TTS via persistent PowerShell + Windows SAPI ────────────────────
//
// Running TTS from the renderer via window.speechSynthesis blocks the renderer's
// main JS thread on Windows Chromium, freezing IPC gaze callbacks for 50-200 ms
// on every word activation.  Instead we keep a persistent PowerShell process
// in the main process and call SpeakAsync() — which runs on a .NET background
// thread and returns immediately, leaving both the main process and renderer
// completely unblocked.

let _ttsPs = null   // persistent PowerShell child process

function _ensureTtsProcess() {
  if (_ttsPs && !_ttsPs.killed) return

  _ttsPs = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  })
  _ttsPs.on('error', (e) => { console.warn('[TTS] PowerShell error:', e.message); _ttsPs = null })
  _ttsPs.on('exit',  ()  => { _ttsPs = null })

  // Pre-load the assembly and create the synthesizer object.
  // SpeakAsync queues utterances; SpeakAsyncCancelAll() clears pending ones.
  _ttsPs.stdin.write('Add-Type -AssemblyName System.Speech\r\n')
  _ttsPs.stdin.write('$tts = New-Object System.Speech.Synthesis.SpeechSynthesizer\r\n')
  _ttsPs.stdin.write('$tts.Rate = 1\r\n')   // slightly faster than default
  console.log('[TTS] Native SAPI process started')
}

function _nativeSpeak(text) {
  _ensureTtsProcess()
  if (!_ttsPs) return
  // Escape single quotes for PowerShell string literal
  const safe = text.replace(/'/g, "''").replace(/[\r\n]/g, ' ')
  // Cancel any queued speech so rapid word selections don't pile up
  _ttsPs.stdin.write(`$tts.SpeakAsyncCancelAll()\r\n`)
  _ttsPs.stdin.write(`$tts.SpeakAsync('${safe}')\r\n`)
}

/**
 * ipc:tts-speak
 * Triggers native Windows SAPI TTS from the main process.
 * SpeakAsync() is non-blocking — TTS runs on a .NET background thread.
 * The renderer no longer calls window.speechSynthesis at all, eliminating
 * the main-thread freeze that caused gaze lag during word activation.
 */
ipcMain.handle('ipc:tts-speak', (_event, text) => {
  _nativeSpeak(text)
  return { ok: true }
})

/**
 * ipc:window-control
 * Handles frameless window actions (minimize, maximize, close).
 */
ipcMain.on('ipc:window-control', (_event, action) => {
  if (!mainWindow) return
  switch (action) {
    case 'minimize': mainWindow.minimize(); break
    case 'maximize':
      mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
      break
    case 'close': mainWindow.close(); break
  }
})

// ─── Settings IPC Handlers (electron-store) ───────────────────────────────────

/**
 * ipc:settings-get
 * Returns the full settings object from persistent store.
 * Falls back to STORE_DEFAULTS if electron-store is unavailable.
 */
ipcMain.handle('ipc:settings-get', () => {
  return store ? store.store : STORE_DEFAULTS
})

/**
 * ipc:settings-set
 * Persists a single setting key-value pair to the store.
 * @param {string} key   – Setting key (e.g. 'dwellMs')
 * @param {*}      value – New value
 */
ipcMain.handle('ipc:settings-set', (_event, key, value) => {
  if (store && Object.prototype.hasOwnProperty.call(STORE_DEFAULTS, key)) {
    store.set(key, value)
    return { ok: true }
  }
  return { ok: false, reason: 'unknown key or store unavailable' }
})

/**
 * ipc:settings-reset
 * Clears the store and restores all defaults.
 */
ipcMain.handle('ipc:settings-reset', () => {
  if (store) {
    store.clear()
    return STORE_DEFAULTS
  }
  return STORE_DEFAULTS
})

// ─── Session Log IPC Handlers (M5) ────────────────────────────────────────────

/**
 * ipc:session-log-append
 * Appends one SessionRecord to the persistent log (capped at 90 entries).
 * SessionRecord shape: { date: string, wordActivations: number,
 *   abandonedDwells: number, stageUsed: number, topWords: string[] }
 */
ipcMain.handle('ipc:session-log-append', (_event, record) => {
  if (!store) return { ok: false }
  const log = store.get('sessionLog', [])
  log.push({ ...record, savedAt: Date.now() })
  // Keep only the most recent 90 session records
  const trimmed = log.slice(-90)
  store.set('sessionLog', trimmed)
  return { ok: true, total: trimmed.length }
})

/**
 * ipc:session-log-get
 * Returns the full session log array.
 */
ipcMain.handle('ipc:session-log-get', () => {
  return store ? store.get('sessionLog', []) : []
})

/**
 * ipc:session-log-clear
 * Wipes the session log.
 */
ipcMain.handle('ipc:session-log-clear', () => {
  if (store) {
    store.set('sessionLog', [])
    return { ok: true }
  }
  return { ok: false }
})

// ─── AI History IPC Handlers ──────────────────────────────────────────────────
// Stores context+response pairs so the model learns Caden's communication
// patterns over time. Capped at 200 entries (≈ 3–6 months of daily use).

/**
 * ipc:ai-history-append
 * Save one context → responses interaction to the persistent history log.
 * @param {{ context: string, responses: string[], chosen?: string }} entry
 */
ipcMain.handle('ipc:ai-history-append', (_event, entry) => {
  if (!store) return { ok: false }
  const history = store.get('aiHistory', [])
  history.push({ ...entry, savedAt: Date.now() })
  const trimmed = history.slice(-200) // keep most-recent 200
  store.set('aiHistory', trimmed)
  return { ok: true, total: trimmed.length }
})

/**
 * ipc:ai-history-get
 * Returns the full interaction history array.
 */
ipcMain.handle('ipc:ai-history-get', () => {
  return store ? store.get('aiHistory', []) : []
})

/**
 * ipc:ai-history-clear
 * Wipes the AI interaction history (useful for privacy / reset).
 */
ipcMain.handle('ipc:ai-history-clear', () => {
  if (store) {
    store.set('aiHistory', [])
    return { ok: true }
  }
  return { ok: false }
})

/**
 * ipc:ai-history-delete
 * Removes a single history entry identified by its savedAt timestamp.
 * @param {number} savedAt — The savedAt timestamp of the entry to remove
 */
ipcMain.handle('ipc:ai-history-delete', (_event, savedAt) => {
  if (!store) return { ok: false }
  const history = store.get('aiHistory', [])
  const filtered = history.filter(h => h.savedAt !== savedAt)
  store.set('aiHistory', filtered)
  return { ok: true, total: filtered.length }
})

/**
 * ipc:ai-history-record-choice
 * Appends a chosen response text to the most recent history entry.
 * Supports multiple choices per context (chosen is stored as string[]).
 * @param {string} chosenText — The text the user selected
 */
ipcMain.handle('ipc:ai-history-record-choice', (_event, chosenText) => {
  if (!store) return { ok: false }
  const history = store.get('aiHistory', [])
  if (!history.length) return { ok: false, reason: 'no history' }
  const last = history[history.length - 1]
  const current = Array.isArray(last.chosen) ? last.chosen
    : (last.chosen ? [last.chosen] : [])
  if (!current.includes(chosenText)) current.push(chosenText)
  last.chosen = current
  store.set('aiHistory', history)
  return { ok: true }
})

/**
 * ipc:user-profile-get
 * Returns the stored user profile for Caden (or the defaults).
 */
ipcMain.handle('ipc:user-profile-get', () => {
  return store ? store.get('userProfile', STORE_DEFAULTS.userProfile) : STORE_DEFAULTS.userProfile
})

/**
 * ipc:user-profile-set
 * Persists updates to Caden's profile (name, age, family, location).
 * @param {object} profile – Partial or full profile object
 */
ipcMain.handle('ipc:user-profile-set', (_event, profile) => {
  if (!store) return { ok: false }
  const current = store.get('userProfile', STORE_DEFAULTS.userProfile)
  const updated = { ...current, ...profile }
  store.set('userProfile', updated)
  return { ok: true, profile: updated }
})

/**
 * ipc:session-export-csv
 * Opens a save-file dialog and writes the session log as a CSV.
 */
ipcMain.handle('ipc:session-export-csv', async (_event, csvContent) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Session History',
    defaultPath: `gazeaac-sessions-${new Date().toISOString().slice(0,10)}.csv`,
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  })
  if (canceled || !filePath) return { ok: false, reason: 'canceled' }
  try {
    await writeFile(filePath, csvContent, 'utf-8')
    return { ok: true, filePath }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
})

// ─── AACBoards IPC Handlers ──────────────────────────────────────────────────

/**
 * ipc:aacboards-list
 * Returns the sorted array of file names present in AACBoards/ (no buffers).
 * Also indicates which ones are already cached in memory.
 * Shape: Array<{ fileName: string, cached: boolean }>
 */
ipcMain.handle('ipc:aacboards-list', () => {
  return _aacBoardManifest.map(fileName => ({
    fileName,
    cached: _aacBoardCache.has(fileName),
  }))
})

/**
 * ipc:aacboards-get-all
 * Returns the pre-loaded / already-cached list of { fileName, buffer } objects.
 * Only boards that have already been loaded into memory are included.
 * buffer is an Array<number> (Uint8Array serialised via Array.from).
 */
ipcMain.handle('ipc:aacboards-get-all', () => {
  return Array.from(_aacBoardCache.values())
})

/**
 * ipc:aacboards-load-one
 * Loads a single board file on demand (called when the user selects a board
 * that has not yet been cached). Returns { fileName, buffer } or throws.
 * Subsequent calls for the same file are served instantly from the cache.
 */
ipcMain.handle('ipc:aacboards-load-one', async (_event, fileName) => {
  // Validate: only files from the scanned manifest are allowed
  if (!_aacBoardManifest.includes(fileName)) {
    throw new Error(`[main] AACBoards: "${fileName}" is not in the board manifest`)
  }
  // Serve from cache if already loaded
  if (_aacBoardCache.has(fileName)) {
    return _aacBoardCache.get(fileName)
  }
  // Read from disk and cache for future requests
  const buf = await readFile(join(AACBOARDS_DIR, fileName))
  const entry = { fileName, buffer: Array.from(buf) }
  _aacBoardCache.set(fileName, entry)
  console.log(`[main] AACBoards: on-demand loaded "${fileName}" (${(buf.length / 1024 / 1024).toFixed(1)} MB)`)
  return entry
})

/**
 * ipc:board-edits-get
 * Returns the full boardEdits delta map from the persistent store.
 */
ipcMain.handle('ipc:board-edits-get', () => {
  return store ? store.get('boardEdits', {}) : {}
})

/**
 * ipc:board-edits-set
 * Merges a ButtonPatch into the boardEdits delta for a specific button.
 * editKey format: "fileName:boardId:btnId"
 */
ipcMain.handle('ipc:board-edits-set', (_event, editKey, patch) => {
  if (!store) return { ok: false, reason: 'store unavailable' }
  const edits = store.get('boardEdits', {})
  if (patch === null) {
    delete edits[editKey]
  } else {
    edits[editKey] = { ...(edits[editKey] ?? {}), ...patch }
  }
  store.set('boardEdits', edits)
  return { ok: true }
})

/**
 * ipc:board-edits-clear-all
 * Wipes all board edits (factory reset for board customisations).
 */
ipcMain.handle('ipc:board-edits-clear-all', () => {
  if (store) {
    store.set('boardEdits', {})
    return { ok: true }
  }
  return { ok: false }
})

// ─── Cached remap geometry (invalidated on window move/resize) ───────────────
// getBounds() and getDisplayMatching() are synchronous OS calls. Calling them
// at 90 Hz adds measurable latency to the gaze pipeline. We cache the result
// and only refresh it when the window actually moves or resizes.

let _remapCache = null   // { sf, sw, sh, winOriginX, winOriginY, winW, winH }

function _invalidateRemapCache() { _remapCache = null }

function _buildRemapCache() {
  if (!mainWindow) return null
  const wb      = mainWindow.getBounds()
  const display = screen.getDisplayMatching(wb)
  const sf      = display.scaleFactor || 1
  const sw      = display.bounds.width  * sf
  const sh      = display.bounds.height * sf
  _remapCache = {
    sf,
    sw, sh,
    winOriginX: wb.x * sf,
    winOriginY: wb.y * sf,
    winW:       wb.width  * sf,
    winH:       wb.height * sf,
  }
  return _remapCache
}

/**
 * Remap a raw Tobii gaze point from full-screen normalized coords [0,1] to
 * window-relative normalized coords [0,1].
 *
 * The Tobii SDK always reports (x, y) as fractions of the display resolution
 * (accounting for DPI scaling via scaleFactor). When the Electron window does
 * not fill the whole screen we must translate and scale these into the window's
 * own coordinate space so that:
 *   • The gaze cursor sits exactly where the user is looking.
 *   • Hit-box testing (which uses getBoundingClientRect / window.innerWidth)
 *     lines up with the Tobii stream.
 *
 * @param {{ x: number, y: number, timestamp: number, valid: boolean }} gp
 * @returns {{ x: number, y: number, timestamp: number, valid: boolean }}
 */
function remapToWindow(gp) {
  if (!mainWindow || !gp.valid) return gp

  const c = _remapCache ?? _buildRemapCache()
  if (!c) return gp

  // Tobii (x, y) → physical pixel on screen → window-relative normalized
  const rx = (gp.x * c.sw - c.winOriginX) / c.winW
  const ry = (gp.y * c.sh - c.winOriginY) / c.winH

  return {
    ...gp,
    x: Math.max(0, Math.min(1, rx)),
    y: Math.max(0, Math.min(1, ry)),
  }
}


// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  await initStore()       // Initialize electron-store before opening the window
  await loadAACBoards()  // Pre-load all .obz files from AACBoards/
  _ensureTtsProcess()    // Pre-warm native TTS so first word has no startup lag

  // Allow microphone and camera in the renderer (required for ContextWindow)
  const { session } = await import('electron')
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'microphone', 'camera', 'audioCapture', 'videoCapture']
    callback(allowed.includes(permission))
  })

  createWindow()
})

app.on('window-all-closed', () => {
  if (gazeEmitter) gazeEmitter.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

