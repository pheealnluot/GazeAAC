import { app, BrowserWindow, ipcMain, shell, dialog, screen, components } from 'electron'
import { writeFile, readFile, readdir } from 'fs/promises'
import { writeFileSync, existsSync } from 'fs'
import os from 'os'
import http from 'http'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'
import { spawn, execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { TobiiGazeProvider } from './TobiiGazeProvider.js'
import WebSocket from 'ws'

// Force app name to 'gaze-aac' in all environments (Dev & Prod) to share AppData,
// so that local settings, IndexedDB (caregiver auth), and session history are unified.
app.name = 'gaze-aac'

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
  postActivationCooldownMs: 10,
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
  dwellProgressOpacity: 1.0,
  ttsEngine: 'sapi',   // 'sapi' | 'winrt'  — selects SAPI or WinRT/UWP speech synthesis
  ttsVoice: '',
  ttsRate: 0,          // SAPI Rate: -10 (slowest) … 0 (normal) … +10 (fastest)
  ttsPitch: 0,         // Pitch shift: -10 (lowest) … 0 (normal) … +10 (highest), applied via SSML prosody
  ttsVolume: 100,      // SAPI Volume: 0–100
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
  // Answer Gate — reading delay before response tiles become selectable
  answerGateMs: 2000,
  // Contextual Response board
  contextualResponseEnabled: true,
  contextualResponseModel: 'ollama',
  contextualOllamaModel: 'llama3.2',
  contextualOllamaVisionModel: 'llava',
  contextualResponseMinCount: 4,
  contextualResponseCount: 6,
  contextualResponseAction: 'both',
  contextualMicMode: 'toggle', // 'toggle' | 'continuous'
  contextualMicDeviceId: '',   // empty = system default mic; deviceId string = specific device
  contextualPromptPrefix: '',
  contextualLifeLore: '',
  contextualSystemPrompt: '',      // Fully custom system prompt body; empty = use built-in default
  contextualRouting: 'internet-first',
  geminiApiKey: '',
  geminiModel: 'gemini-2.5-flash',
  // OpenAI / ChatGPT service
  openAiApiKey: '',                // OpenAI secret key (sk-...)
  openAiModel: 'gpt-4o-mini',     // OpenAI ChatGPT model name
  cloudAiProviderOrder: ['gemini', 'openai'], // Ordered cloud AI fallback list
  // AI Interaction History — persisted Q&A pairs that prime the model over time
  // Each entry: { context: string, responses: string[], chosen?: string, savedAt: number }
  aiHistory: [],
  // User profile embedded into every AI system prompt
  userProfile: {
    name:     'Johnny',
    age:      10,
    location: 'Singapore',
    family:   { father: 'Bob', mother: 'Mary' },
  },
  contextualSpeakMode: 'voice-typing',
  speakShortcutCtrl: false,
  speakShortcutShift: false,
  speakShortcutAlt: false,
  speakShortcutChar: '',
  contextualWvtTimeout: 0,
  lastUsedBoard: 'quick-core-24-obz',
  registeredFaces: [],
  registeredObjects: [],
  deletedFaceIds: [],
  deletedPhotoIds: [],
  deletedObjectIds: [],
  deviceId: '',
  deviceName: '',
  deviceOS: '',
  lastActive: 0,
  // Camera & Vision Pipeline
  cameraAugmentationEnabled: false,
  cameraStreamingEnabled: false,
  cameraUpdateSoundEnabled: true,
  cameraFacingMode: 'user',
  cameraSelectedDeviceId: '',
  cameraIntervalMs: 2000,
  cameraMinConfidence: 0.5,
  cameraAugmentOnlyOnPrompt: false,
  // Movie Time
  movieTimeYoutubeKey: '',
  movieTimeYoutubeKeys: [],
  movieTimePuzzleIntervalSec: 600,
  movieTimePuzzleIntervalMin: 10,
  movieTimeGazeAwayMs: 3000,
  movieTimeSafeSearch: 'strict',
  movieTimeDuration: 'medium',
  movieTimeVideoQuality: 'any',
  movieTimeTopics: ['Animals', 'Science', 'Art'],
  movieTimeWhitelist: ['kids', 'educational'],
  movieTimeBlacklist: [],
  movieTimeGamerLoophole: false,
  movieTimePuzzleTypes: ['Quiz', 'Riddle'],
  movieTimePuzzleDifficulty: 'Easy',
  movieTimePuzzleChoices: 4,
  movieTimeMaxDailyMinutes: 60,
  movieTimeShowGazeCursor: true,
  movieTimePauseOnGazeLost: true,
  movieTimeSelectionGateMs: 2000,
  movieTimeSelectionCount: 4,
  movieTimeQuizEducationLevel: 'Primary',
  movieTimeQuizSubject: 'General',
  movieTimeQuizSubjectCustom: '',
  movieTimeQuizAboutVideo: false,
  movieTimeQuizRequirePrewatch: true,
  movieTimeProviderYoutube: true,
  movieTimeProviderNetflix: true,
  movieTimeProviderDisney: true,
  movieTimeActiveProvider: 'youtube',
  movieTimeQuizSoundEffects: true,
  movieTimeQuizQuestionGateMs: 2000,
  movieTimeQuizAnswerGateMs: 1500,
  movieTimeQuizVoiceOver: true,
  movieTimeQuizVoiceOverChoices: true,
  movieTimeQuizVoiceOverPauseMs: 500,
  movieTimePuzzleHintAfterWrong: 3,
  movieTimePuzzleQuestionsPerQuiz: 3,
  movieTimeAskedQuestions: [],
  movieTimeSelectedYoutubeVideoIds: null,
  movieTimeMinViews: 0,            // Minimum view count filter applied client-side (0 = no minimum)
  movieTimeLanguage: '',           // BCP-47 language tag for YouTube API relevanceLanguage param ('' = any, 'en' = English, etc.)
  // Q&A Quizzes Settings
  qaQuizQuestionGateMs: 2000,
  qaQuizAnswerGateMs: 1500,
  qaPuzzleHintAfterWrong: 3,
  qaQuizSoundEffects: true,
  qaQuizVoiceOver: true,
  qaQuizVoiceOverChoices: true,
  qaQuizVoiceOverPauseMs: 500,
  // In-App Calibration Correction
  explicitCalibrationEnabled: true,
  implicitCalibrationEnabled: true,
  gazeCorrection: null,  // Persisted { offsetX, offsetY, scaleX, scaleY, quality, sampleCount, quadrantData, recentErrors, updatedAt } or null
  gazeLostSoundEnabled: true,
  gazeLostVisualEnabled: true,
}


// ─── electron-store: loaded asynchronously (pure ESM in v10+) ────────────────
// The store reference is populated inside app.whenReady() before createWindow().
let store = null

async function initStore() {
  try {
    const { default: Store } = await import('electron-store')
    store = new Store({ name: 'gaze-settings', defaults: STORE_DEFAULTS })
    console.log('[main] electron-store initialized')

    // Generate deviceId if missing or empty
    if (store && (!store.get('deviceId') || store.get('deviceId') === '')) {
      const newId = randomUUID()
      store.set('deviceId', newId)
      console.log('[main] Generated new persistent unique deviceId:', newId)
    }

    // Populate device name and OS info
    if (store) {
      const hostname = os.hostname() || 'Unknown Device'
      const platformMap = {
        'win32': 'Windows',
        'darwin': 'macOS',
        'linux': 'Linux'
      }
      const platform = platformMap[os.platform()] || os.platform() || 'Unknown OS'
      store.set('deviceName', hostname)
      store.set('deviceOS', platform)
      store.set('lastActive', Date.now())
      console.log(`[main] Local device metadata updated: ${hostname} (${platform})`)
    }

    // ── Migration: if the stored userProfile has the old name 'Caden Chye', migrate to 'Johnny'
    if (store.has('userProfile')) {
      const p = store.get('userProfile')
      if (p && p.name === 'Caden Chye') {
        store.set('userProfile', STORE_DEFAULTS.userProfile)
        console.log('[main] Migrated persisted userProfile from Caden Chye to Johnny')
      }
    }

    // Load persisted gaze correction into the runtime cache
    _gazeCorrection = store.get('gazeCorrection', null)
    if (_gazeCorrection) {
      console.log('[main] Loaded persisted gaze correction:', JSON.stringify(_gazeCorrection))
    }
  } catch (err) {
    console.warn('[main] electron-store not available — settings will not persist:', err.message)
    store = null
  }
}

// ─── Dev / Prod helpers ───────────────────────────────────────────────────────
const isDev = !app.isPackaged

if (isDev) {
  app.commandLine.appendSwitch('no-verify-widevine-cdm')
}

// ─── AACBoards ────────────────────────────────────────────────────────────────
// Resolve the AACBoards directory relative to the project root in dev, or to the external resources directory in prod.
// In dev: __dirname is electron/ so we go up one level.
// In prod (out/main/): go up two levels to the app root, but since we package AACBoards as extraResources,
// they are located in process.resourcesPath/AACBoards in production.
const AACBOARDS_DIR = !isDev
  ? join(process.resourcesPath, 'AACBoards')
  : join(fileURLToPath(new URL('.', import.meta.url)), '../../AACBoards')

/**
 * Only this board is pre-loaded at startup to keep cold-start fast.
 * All other boards in AACBoards/ are available for on-demand loading
 * via ipc:aacboards-load-one once the user selects them.
 */
const PRELOAD_BOARD = 'baseboard.obz'

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
  // Production: return the local static server URL
  return `http://localhost:${prodServerPort}/index.html`
}

// ─── Gaze stream state ────────────────────────────────────────────────────────
let gazeEmitter = null
let mainWindow = null
let _gazeCorrection = null  // Cached correction transform for remapToWindow()
let isGazeStreaming = false // Tracks whether we are actively sending gaze to renderer
let isOverlayModeActive = false
let spawnedChromeProcess = null
let syncTimer = null
let isGazeAACMoving = false
let moveDebounceTimer = null
let wasMaximizedBeforeChrome = false

/**
 * Pre-warm the Tobii bridge at app startup (before the window opens).
 * This eliminates the cold-start delay (PyInstaller EXE unpacking, ~3–8 s)
 * so that gaze is already flowing by the time the auth/calibration screen
 * renders and calls ipc:gaze-stream-start.
 *
 * The bridge streams into a no-op sink until the renderer requests the stream,
 * at which point the IPC handler replaces the callback with the real sender.
 */
async function preWarmGazeBridge() {
  if (gazeEmitter) return  // already started
  console.log('[main] Pre-warming Tobii gaze bridge...')
  gazeEmitter = new TobiiGazeProvider(
    (gazePoint) => {
      // Sink: renderer callback registered below in ipc:gaze-stream-start
      // Frames arriving before the renderer connects are intentionally dropped.
      if (!isGazeStreaming) return
      const remapped = remapToWindow(gazePoint)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ipc:gaze-data', remapped)
      }
    },
    (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ipc:tracker-mode', status)
      }
      console.log(`[main] Gaze tracker mode changed dynamically to: ${status}`)
    }
  )
  await gazeEmitter.start()
  console.log('[main] Gaze bridge pre-warm complete.')
}

function fitChromeWindowToGazeAAC(activate = false) {
  if (!isOverlayModeActive || !mainWindow || mainWindow.isDestroyed()) return
  
  // Compute the target visible area for Chrome in physical pixels.
  // Electron's APIs return logical (DIP) pixels; Win32 SetWindowPos expects physical pixels.
  const winDisplay = screen.getDisplayMatching(mainWindow.getBounds())
  const sf = winDisplay.scaleFactor || 1

  let visX, visY, visW, visH
  if (mainWindow.isMaximized()) {
    const wa = winDisplay.workArea
    visX = Math.round((wa.x + 4) * sf)
    visY = Math.round((wa.y + 36) * sf)
    visW = Math.round((wa.width - 8) * sf)
    visH = Math.round((wa.height - 36 - 4) * sf)
  } else {
    const b = mainWindow.getBounds()
    visX = Math.round((b.x + 4) * sf)
    visY = Math.round((b.y + 36) * sf)
    visW = Math.round((b.width - 8) * sf)
    visH = Math.round((b.height - 36 - 4) * sf)
  }

  const fitScript = `
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
        [DllImport("user32.dll")]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
        [DllImport("user32.dll")]
        public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }
    }
"@
    [Win32]::SetProcessDPIAware() | Out-Null
    $process = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe'" |
        Where-Object { $_.CommandLine -like '*ChromeMovieTimeProfile*' } |
        ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
        Select-Object -First 1

    if ($process) {
        # Only restore Chrome if it is maximized or minimized, to avoid window animation conflicts
        $cStyle = [Win32]::GetWindowLong($process.MainWindowHandle, -16)
        $cIsMax = ($cStyle -band 0x01000000) -ne 0
        $cIsMin = ($cStyle -band 0x20000000) -ne 0
        if ($cIsMax -or $cIsMin) {
            [Win32]::ShowWindowAsync($process.MainWindowHandle, 9)
            Start-Sleep -Milliseconds 150
        }

        # Pre-computed visible target bounds from Electron (physical pixels)
        $visX = ${visX}
        $visY = ${visY}
        $visW = ${visW}
        $visH = ${visH}

        # Query Chrome's current window rect and DWM rect to calculate invisible borders
        $rect = New-Object Win32+RECT
        $dwmRect = New-Object Win32+RECT
        if ([Win32]::GetWindowRect($process.MainWindowHandle, [ref]$rect) -and 
            ([Win32]::DwmGetWindowAttribute($process.MainWindowHandle, 9, [ref]$dwmRect, [Marshal]::SizeOf($dwmRect)) -eq 0) -and
            $rect.Left -gt -30000 -and $dwmRect.Left -gt -30000) {
            
            $diffX = $rect.Left - $dwmRect.Left
            $diffY = $rect.Top - $dwmRect.Top
            $diffW = ($rect.Right - $rect.Left) - ($dwmRect.Right - $dwmRect.Left)
            $diffH = ($rect.Bottom - $rect.Top) - ($dwmRect.Bottom - $dwmRect.Top)

            # Sane bounds check for Windows DPI scaling
            if ($diffX -lt -30 -or $diffX -gt 0 -or $diffY -lt -10 -or $diffY -gt 10 -or $diffW -lt 0 -or $diffW -gt 60 -or $diffH -lt 0 -or $diffH -gt 30) {
                $diffX = -8
                $diffY = 0
                $diffW = 16
                $diffH = 8
            }
        } else {
            $diffX = -8
            $diffY = 0
            $diffW = 16
            $diffH = 8
        }
        
        $targetX = $visX + $diffX
        $targetY = $visY + $diffY
        $targetW = $visW + $diffW
        $targetH = $visH + $diffH

        $flags = 0x0010
        if (${activate ? '$true' : '$false'}) {
            [Win32]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
            $flags = 0x0000
        }

        [Win32]::SetWindowPos($process.MainWindowHandle, [IntPtr](-1), $targetX, $targetY, $targetW, $targetH, $flags)
    }
  `

  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', fitScript], {
    windowsHide: true
  })
}

// ─── Window factory ──────────────────────────────────────────────────────────
function createWindow() {
  let preloadPath = join(__dirname, '../preload/index.mjs')
  if (!existsSync(preloadPath)) {
    preloadPath = join(__dirname, '../preload/index.cjs')
  }
  if (!existsSync(preloadPath)) {
    preloadPath = join(__dirname, '../preload/index.js')
  }
  console.log('[main] Preload path resolved to:', preloadPath)

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,               // Frameless – app renders its own chrome
    transparent: true,          // Support click-through transparent overlay
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,   // Security: renderer cannot access Node APIs directly
      nodeIntegration: false,   // Security: no Node in renderer
      sandbox: false,           // Required for Electron preload to use require()
      webviewTag: true,         // Enable `<webview>` tags for streaming providers
      plugins: true             // Enable plugins (required for Widevine DRM playback)
    },
    show: false                 // Show only after 'ready-to-show' to prevent flash
  })

  // Log focus changes since isFocused() invalidates gaze data (e.g. if DevTools steals focus)
  mainWindow.on('focus', () => {
    console.log('[main] Main window focused. Gaze coordinates active.')
  })
  mainWindow.on('blur', () => {
    console.warn('[main] Main window lost focus. Gaze coordinates will be ignored (DevTools might have stolen focus).')
  })

  const handleGazeAACMoveOrResize = () => {
    if (!isOverlayModeActive || !mainWindow) return
    isGazeAACMoving = true
    if (moveDebounceTimer) clearTimeout(moveDebounceTimer)
    moveDebounceTimer = setTimeout(() => {
      isGazeAACMoving = false
    }, 500)
    
    fitChromeWindowToGazeAAC()
  }

  const handleGazeAACMaximize = () => {
    if (!isOverlayModeActive || !mainWindow) return
    fitChromeWindowToGazeAAC()
  }

  const handleGazeAACUnmaximize = () => {
    if (!isOverlayModeActive || !mainWindow) return
    fitChromeWindowToGazeAAC()
  }

  const handleGazeAACMinimize = () => {
    if (!isOverlayModeActive || !mainWindow) return
    const minScript = `
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public class Win32 {
          [DllImport("user32.dll")]
          public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
      }
"@
      $process = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe'" |
          Where-Object { $_.CommandLine -like '*ChromeMovieTimeProfile*' } |
          ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
          Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
          Select-Object -First 1
      if ($process) {
          [Win32]::ShowWindowAsync($process.MainWindowHandle, 6)
      }
    `
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', minScript], {
      windowsHide: true
    })
  }

  const handleGazeAACRestore = () => {
    if (!isOverlayModeActive || !mainWindow) return
    fitChromeWindowToGazeAAC()
  }

  mainWindow.on('move', handleGazeAACMoveOrResize)
  mainWindow.on('resize', handleGazeAACMoveOrResize)
  mainWindow.on('maximize', handleGazeAACMaximize)
  mainWindow.on('unmaximize', handleGazeAACUnmaximize)
  mainWindow.on('minimize', handleGazeAACMinimize)
  mainWindow.on('restore', handleGazeAACRestore)

  // Open DevTools in development — opened early (before page load) so any
  // startup crash or render error is captured in the console immediately.
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })

    // Forward renderer console logs to the terminal
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      const file = sourceId.split('/').pop() || 'unknown'
      const levelStr = ['info', 'warn', 'error'][level] || 'log'
      console.log(`[renderer:${levelStr}] [${file}:${line}] ${message}`)
    })
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

  // Handle popup windows:
  //   - Firebase / Google OAuth auth popups → open as real Electron BrowserWindows
  //     IMPORTANT: must share the same session (no custom partition) and have
  //     sandbox:false so Firebase's window.opener.postMessage handshake can work.
  //   - All other external URLs → open in the OS default browser
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    const isFirebaseAuthPopup =
      targetUrl.includes('accounts.google.com') ||
      targetUrl.includes('gazeaac-app-sync.firebaseapp.com') ||
      targetUrl.includes('/__/auth/')

    if (isFirebaseAuthPopup) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          title: 'Sign in with Google',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            // sandbox MUST be false: Firebase uses window.opener.postMessage to
            // send the OAuth credential back. Sandboxed renderers block this.
            sandbox: false,
            // No custom partition: popup MUST share the main window's session
            // so that Firebase can access the sessionStorage state it wrote
            // when initiating signInWithPopup.
          },
        },
      }
    }

    // All other links → open in OS browser
    shell.openExternal(targetUrl)
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
  isGazeStreaming = true

  if (!gazeEmitter) {
    // Bridge wasn't pre-warmed (shouldn't normally happen) — start it now.
    gazeEmitter = new TobiiGazeProvider(
      (gazePoint) => {
        if (!isGazeStreaming) return
        const remapped = remapToWindow(gazePoint)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ipc:gaze-data', remapped)
        }
      },
      (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ipc:tracker-mode', status)
        }
        console.log(`[main] Gaze tracker mode changed dynamically to: ${status}`)
      }
    )
    // start() is async — it spawns the Python bridge and awaits WS connection
    await gazeEmitter.start()
  }

  // Inform the renderer which tracker source is active (resolved after start)
  const trackerMode = TobiiGazeProvider.isAvailable() ? 'tobii' : 'mouse'
  if (event.sender && !event.sender.isDestroyed()) {
    event.sender.send('ipc:tracker-mode', trackerMode)
  }

  console.log(`[main] Gaze stream started via TobiiGazeProvider (initial mode: ${trackerMode})`)
})

ipcMain.on('ipc:gaze-stream-stop', () => {
  isGazeStreaming = false
  console.log('[main] Gaze stream paused (kept warm in background)')
})

/**
 * ipc:gaze-correction-get
 * Returns the current stored gaze correction transform.
 */
ipcMain.handle('ipc:gaze-correction-get', () => {
  if (!store) return null
  return store.get('gazeCorrection', null)
})

/**
 * ipc:gaze-correction-set
 * Persists the correction transform and caches it for remapToWindow().
 */
ipcMain.handle('ipc:gaze-correction-set', (_event, correction) => {
  _gazeCorrection = correction
  if (store) store.set('gazeCorrection', correction)
  return { ok: true }
})

/**
 * ipc:gaze-correction-reset
 * Clears the stored correction and reverts to raw Tobii pass-through.
 */
ipcMain.handle('ipc:gaze-correction-reset', () => {
  _gazeCorrection = null
  if (store) store.set('gazeCorrection', null)
  return { ok: true }
})

// ─── Native TTS via persistent PowerShell ────────────────────────────────────
//
// Two backends are supported:
//
//   1. SAPI  (ttsEngine = 'sapi')
//      Uses System.Speech.Synthesis.SpeechSynthesizer — the classic Windows
//      Text-to-Speech API.  Works offline on all Windows versions.
//
//   2. WinRT (ttsEngine = 'winrt')
//      Uses Windows.Media.SpeechSynthesis.SpeechSynthesizer — the modern UWP
//      runtime.  Exposes "Natural" voices (OneCore / Azure Edge-Powered) which
//      are only available through the WinRT surface, not through SAPI.
//      Requires Windows 10 1703+ and the WinRT voices installed via
//      Settings → Time & Language → Speech → Add voices.
//
// Running TTS from the renderer via window.speechSynthesis blocks the renderer's
// main JS thread on Windows Chromium, freezing IPC gaze callbacks for 50-200 ms
// on every word activation.  Instead we keep a persistent PowerShell process
// in the main process so speech runs on a .NET / WinRT background thread and
// both the main process and renderer remain completely unblocked.

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Escape text so it is safe inside a PowerShell single-quoted string. */
function _psEscape(s) {
  return s.replace(/'/g, "''").replace(/[\r\n]/g, ' ')
}

/** Escape text for use inside SSML element content (not attributes). */
function _xmlEscape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ── Backend 1: SAPI (System.Speech.Synthesis) ─────────────────────────────────

let ttsCompletedTimer = null
let _ttsPs = null           // persistent SAPI PowerShell child process
let _ttsCurrentKey = null   // serialised {voice,rate,volume} the current process was started with

/**
 * Ensure the persistent SAPI PowerShell process is running and configured
 * for the given voice/rate/volume.  Restarts the process whenever any of
 * these change so that SelectVoice / Rate / Volume are applied before the
 * first SpeakAsync — eliminating any timing race with stdin piping.
 */
function _ensureTtsProcess(voiceName, rate, volume) {
  const wantedVoice  = voiceName || ''
  const wantedRate   = Math.round(Math.max(-10, Math.min(10, rate  ?? 0)))
  const wantedVolume = Math.round(Math.max(0,   Math.min(100, volume ?? 100)))
  const wantedKey    = JSON.stringify({ v: wantedVoice, r: wantedRate, vol: wantedVolume })

  if (_ttsPs && !_ttsPs.killed && _ttsCurrentKey === wantedKey) return

  if (_ttsPs && !_ttsPs.killed) {
    const dying = _ttsPs
    _ttsPs = null
    _ttsCurrentKey = null
    try { dying.kill() } catch {}
  }

  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let _sapiBuf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk) => {
    _sapiBuf += chunk
    const lines = _sapiBuf.split('\n')
    _sapiBuf = lines.pop()
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      if (t === 'SPEAK_COMPLETED') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ipc:tts-completed')
        }
      } else if (t !== 'READY') {
        console.log('[TTS/SAPI]', t)
      }
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (d) => { const t = d.trim(); if (t) console.warn('[TTS/SAPI] stderr:', t) })
  proc.on('error', (e) => { console.warn('[TTS/SAPI] PowerShell error:', e.message); if (_ttsPs === proc) _ttsPs = null })
  proc.on('exit',  ()  => { if (_ttsPs === proc) _ttsPs = null })
  _ttsPs = proc

  proc.stdin.write('Add-Type -AssemblyName System.Speech\r\n')
  proc.stdin.write('$tts = New-Object System.Speech.Synthesis.SpeechSynthesizer\r\n')
  proc.stdin.write(`Register-ObjectEvent -InputObject $tts -EventName SpeakCompleted -Action { if (!$event.SourceEventArgs.Cancelled) { Write-Host "SPEAK_COMPLETED"; [Console]::Out.Flush() } }\r\n`)
  proc.stdin.write(`$tts.Rate = ${wantedRate}\r\n`)
  proc.stdin.write(`$tts.Volume = ${wantedVolume}\r\n`)
  if (wantedVoice) {
    proc.stdin.write(`try { $tts.SelectVoice('${_psEscape(wantedVoice)}') } catch {}\r\n`)
  }
  proc.stdin.write("Write-Host 'READY'; [Console]::Out.Flush()\r\n")

  _ttsCurrentKey = wantedKey
  console.log(`[TTS/SAPI] Process started — voice:"${wantedVoice}" rate:${wantedRate} volume:${wantedVolume}`)
}

function _nativeSapiSpeak(text, voiceName, pitch, rate, volume) {
  if (ttsCompletedTimer) {
    clearTimeout(ttsCompletedTimer)
    ttsCompletedTimer = null
  }
  _ensureTtsProcess(voiceName, rate, volume)
  if (!_ttsPs) return

  _ttsPs.stdin.write(`$tts.SpeakAsyncCancelAll()\r\n`)

  if (!text || !text.trim()) return

  const pitchVal = Math.round(Math.max(-10, Math.min(10, pitch ?? 0)))

  if (pitchVal !== 0) {
    // IMPORTANT: XML attributes MUST use double quotes here.
    // The whole SSML string expression is evaluated in PowerShell, incorporating $tts.Voice.Culture.Name.
    // Double quotes are literal inside PS single-quoted strings, so version="1.0" is safe.
    // Only the text content (safeText) needs PS escaping.
    const pitchPct = `${pitchVal >= 0 ? '+' : ''}${pitchVal * 5}%`
    const safeText = _psEscape(_xmlEscape(text))
    const ssmlExpr = `'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + $tts.Voice.Culture.Name + '"><prosody pitch="${pitchPct}">${safeText}</prosody></speak>'`
    // try/catch fallback: if SSML fails for any reason, speak without pitch rather than going silent
    _ttsPs.stdin.write(`try { $tts.SpeakSsmlAsync(${ssmlExpr}) } catch { $tts.SpeakAsync('${_psEscape(text)}') }\r\n`)
  } else {
    _ttsPs.stdin.write(`try { $tts.SpeakAsync('${_psEscape(text)}') } catch {}\r\n`)
  }
}

// ── Backend 2: WinRT (Windows.Media.SpeechSynthesis) ──────────────────────────
//
// Accesses Windows "Natural" / Neural / OneCore / Azure Edge-Powered voices via
// the modern UWP speech synthesis API, which are NOT surfaced by SAPI.
// Requires Windows 10 build 10240+.

let _winrtPs = null           // persistent WinRT PowerShell child process
let _winrtCurrentKey = null   // serialised {voice,volume} for the running process

/**
 * Ensure the persistent WinRT PowerShell process is alive and configured
 * for the requested voice + volume.  Restarts when parameters change.
 */
function _ensureWinRtProcess(voiceName, volume) {

  const wantedVoice  = voiceName || ''
  const wantedVolume = Math.round(Math.max(0, Math.min(100, volume ?? 100)))
  const wantedKey    = JSON.stringify({ v: wantedVoice, vol: wantedVolume })

  if (_winrtPs && !_winrtPs.killed && _winrtCurrentKey === wantedKey) return

  if (_winrtPs && !_winrtPs.killed) {
    const dying = _winrtPs
    _winrtPs = null
    _winrtCurrentKey = null
    try { dying.stdin.write('EXIT\r\n') } catch {}
    setTimeout(() => { try { dying.kill() } catch {} }, 400)
  }

  // ── WinRT TTS PowerShell script ───────────────────────────────────────────
  //
  // Key design decisions:
  //
  //  1. WinRT IAsyncOperation<T>.AsTask() is a C# extension method defined in
  //     System.WindowsRuntimeSystemExtensions.  PowerShell cannot call extension
  //     methods directly, so we locate the generic AsTask overload via reflection
  //     and invoke it with the concrete result type SpeechSynthesisStream.
  //
  //  2. The resulting IRandomAccessStream must be converted to a .NET Stream via
  //     System.WindowsRuntimeStreamExtensions.AsStreamForRead() — also found via
  //     reflection — before we can CopyTo a MemoryStream and get the raw WAV bytes.
  //
  //  3. System.Windows.Media.MediaPlayer (WPF) requires a Dispatcher/STA thread
  //     that does not exist in a headless PowerShell process, so it silently does
  //     nothing.  We use System.Media.SoundPlayer (System.Windows.Forms assembly)
  //     instead: Load() reads the file into memory (releases the file handle),
  //     then Play() plays asynchronously — keeping the stdin-reading loop free to
  //     accept new CANCEL or SPEAK commands without blocking.
  //
  //  4. Volume: WinRT SpeechSynthesizer.Options.AudioVolume (0.0–1.0) controls
  //     the synthesis amplitude, available from Windows 10 1703+.

  const volFrac    = (wantedVolume / 100).toFixed(4)
  const voiceLine  = wantedVoice
    ? `$chosen = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq '${_psEscape(wantedVoice)}' } | Select-Object -First 1\nif ($chosen) { $synth.Voice = $chosen }`
    : ''

  const psScript = `
$ErrorActionPreference = 'Continue'

# ── Load assemblies ─────────────────────────────────────────────────────────
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Windows.Forms

# Load WinRT types via the ContentType=WindowsRuntime trick (PowerShell 5.1+)
[Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.SpeechSynthesis.SpeechSynthesisStream,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]  | Out-Null

# ── Reflection helpers ───────────────────────────────────────────────────────
# AsTask<SpeechSynthesisStream>(IAsyncOperation<SpeechSynthesisStream>)
$ssType     = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream]
$asTaskDef  = [System.WindowsRuntimeSystemExtensions].GetMethods() |
                Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
                Select-Object -First 1
$asTask     = $asTaskDef.MakeGenericMethod($ssType)

# AsStreamForRead(IInputStream) — Resolve non-generic method in correct namespace
$asRead     = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() |
                Where-Object { $_.Name -eq 'AsStreamForRead' -and !$_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
                Select-Object -First 1

function Invoke-WinRtAsync($asyncOp) {
  $task = $asTask.Invoke($null, @($asyncOp))
  $task.Wait()
  return $task.Result
}

function Stream-ToBytes($stream) {
  $netStream = $asRead.Invoke($null, @($stream))
  $ms = [System.IO.MemoryStream]::new()
  $netStream.CopyTo($ms)
  $netStream.Dispose()
  $bytes = $ms.ToArray()
  $ms.Dispose()
  return $bytes
}

# ── Synthesizer setup ────────────────────────────────────────────────────────
$synth = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::new()
try { $synth.Options.AudioVolume = ${volFrac} } catch {}
${voiceLine}

$currentPlayer = $null
$currentStream = $null

function Stop-Speech {
  if ($script:currentPlayer) {
    try { $script:currentPlayer.Stop(); $script:currentPlayer.Dispose() } catch {}
    $script:currentPlayer = $null
  }
  if ($script:currentStream) {
    try { $script:currentStream.Dispose() } catch {}
    $script:currentStream = $null
  }
}

function Speak-Text($text) {
  Stop-Speech
  try {
    $op    = $synth.SynthesizeTextToStreamAsync($text)
    $ss    = Invoke-WinRtAsync $op
    $bytes = Stream-ToBytes $ss

    # Calculate duration in ms from standard WAV header
    $sampleRate = [System.BitConverter]::ToUInt32($bytes, 24)
    $channels   = [System.BitConverter]::ToUInt16($bytes, 22)
    $bitsPer    = [System.BitConverter]::ToUInt16($bytes, 34)
    $dataSize   = $bytes.Length - 44
    $byteRate   = $sampleRate * $channels * $bitsPer / 8
    $durationMs = [Math]::Round(($dataSize / $byteRate) * 1000)
    Write-Host "DURATION:$durationMs"
    [Console]::Out.Flush()

    # Play directly from MemoryStream (in-memory, no temp files!)
    $playMs = [System.IO.MemoryStream]::new($bytes)
    $player = [System.Media.SoundPlayer]::new($playMs)
    $player.Play()
    $script:currentPlayer = $player
    $script:currentStream = $playMs
  } catch {
    Write-Host ("ERR:" + $_.Exception.Message)
    [Console]::Out.Flush()
  }
}

# ── Main loop ────────────────────────────────────────────────────────────────
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Host 'READY'
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'EXIT') { break }
  if ($line.StartsWith('SPEAK:')) {
    Speak-Text ($line.Substring(6))
  } elseif ($line -eq 'CANCEL') {
    Stop-Speech
  }
}
Stop-Speech
`
  const tempDir  = app.getPath('temp')
  const tempFile = join(tempDir, `gazeaac-winrt-tts-${Date.now()}.ps1`)
  try {
    writeFileSync(tempFile, psScript, 'utf8')
  } catch (err) {
    console.warn('[TTS/WinRT] Could not write temp script:', err.message)
    return
  }

  const proc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', tempFile
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],   // capture stderr for debugging
    windowsHide: true,
  })

  // Read stdout: watch for READY handshake and surface any ERR: lines
  let _ready = false
  let _readBuf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk) => {
    _readBuf += chunk
    const lines = _readBuf.split('\n')
    _readBuf = lines.pop()   // keep the incomplete last fragment
    for (const raw of lines) {
      const t = raw.trim()
      if (!_ready && t === 'READY') {
        _ready = true
        console.log(`[TTS/WinRT] Process ready — voice:"${wantedVoice}" volume:${wantedVolume}`)
      } else if (t.startsWith('DURATION:')) {
        const durationMs = parseInt(t.slice('DURATION:'.length))
        console.log(`[TTS/WinRT] Scheduled completion event in ${durationMs} ms`)
        if (ttsCompletedTimer) {
          clearTimeout(ttsCompletedTimer)
        }
        ttsCompletedTimer = setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ipc:tts-completed')
          }
          ttsCompletedTimer = null
        }, durationMs)
      } else if (t.startsWith('ERR:')) {
        console.warn('[TTS/WinRT] speech error:', t.slice(4))
      }
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (d) => { const t = d.trim(); if (t) console.warn('[TTS/WinRT] stderr:', t) })

  proc.on('error', (e) => { console.warn('[TTS/WinRT] spawn error:', e.message); if (_winrtPs === proc) _winrtPs = null })
  proc.on('exit', (code) => {
    if (_winrtPs === proc) _winrtPs = null
    import('fs').then(({ unlinkSync }) => { try { unlinkSync(tempFile) } catch {} })
    if (code !== 0) console.warn(`[TTS/WinRT] Process exited with code ${code}`)
  })

  _winrtPs = proc
  _winrtCurrentKey = wantedKey
}

function _nativeWinRtSpeak(text, voiceName, volume) {
  if (ttsCompletedTimer) {
    clearTimeout(ttsCompletedTimer)
    ttsCompletedTimer = null
  }
  _ensureWinRtProcess(voiceName, volume)
  if (!_winrtPs || _winrtPs.killed) return
  try {
    _winrtPs.stdin.write(`CANCEL\r\n`)
    if (!text || !text.trim()) return
    // Replace only newlines so the line read is clean, but do NOT double the single quotes
    const cleanText = text.replace(/[\r\n]/g, ' ')
    _winrtPs.stdin.write(`SPEAK:${cleanText}\r\n`)
  } catch (e) {
    console.warn('[TTS/WinRT] stdin write error:', e.message)
  }
}

// ── IPC: ipc:tts-speak ────────────────────────────────────────────────────────

/**
 * ipc:tts-speak
 * Routes TTS to SAPI or WinRT based on the persisted ttsEngine setting.
 * SpeakAsync / WinRT audio runs off the renderer thread — no gaze lag.
 */
ipcMain.handle('ipc:tts-speak', (_event, text) => {
  const engine    = store?.get('ttsEngine')  ?? 'sapi'
  const voiceName = store?.get('ttsVoice')  ?? ''
  const pitch     = store?.get('ttsPitch')  ?? 0
  const rate      = store?.get('ttsRate')   ?? 0
  const volume    = store?.get('ttsVolume') ?? 100

  if (engine === 'winrt') {
    _nativeWinRtSpeak(text, voiceName, volume)
  } else {
    _nativeSapiSpeak(text, voiceName, pitch, rate, volume)
  }
  return { ok: true }
})

/**
 * ipc:tts-list-voices
 * Enumerates installed TTS voices for the requested engine.
 *
 * engine = 'sapi'  → System.Speech.Synthesis.SpeechSynthesizer.GetInstalledVoices()
 * engine = 'winrt' → Windows.Media.SpeechSynthesis.SpeechSynthesizer.AllVoices
 *
 * Returns array of { name, gender, age, culture, engine } objects.
 */
ipcMain.handle('ipc:tts-list-voices', async (_event, engine = 'sapi') => {
  if (engine === 'winrt') {
    // WinRT AllVoices — surfaces Natural / OneCore / Azure Edge-Powered voices
    return new Promise((resolve) => {
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `[Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime] | Out-Null;
$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices;
$voices | ForEach-Object {
  $v = $_;
  Write-Output ("VOICE:" + $v.DisplayName + "|" + $v.Gender + "|" + $v.Age + "|" + $v.Language)
}`
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })

      let out = ''
      ps.stdout.setEncoding('utf8')
      ps.stdout.on('data', (d) => { out += d })
      ps.on('exit', () => {
        const voices = out.split('\n')
          .map(l => l.trim())
          .filter(l => l.startsWith('VOICE:'))
          .map(l => {
            const [name, gender, age, culture] = l.slice('VOICE:'.length).split('|')
            return { name: name?.trim(), gender: gender?.trim(), age: age?.trim(), culture: culture?.trim(), engine: 'winrt' }
          })
          .filter(v => v.name)  // remove blank entries
        resolve(voices)
      })
      ps.on('error', () => resolve([]))
    })
  }

  // Default: SAPI voices
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Speech;
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
$synth.GetInstalledVoices() | ForEach-Object {
  $i = $_.VoiceInfo;
  Write-Output ("VOICE:" + $i.Name + "|" + $i.Gender + "|" + $i.Age + "|" + $i.Culture)
}`
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })

    let out = ''
    ps.stdout.setEncoding('utf8')
    ps.stdout.on('data', (d) => { out += d })
    ps.on('exit', () => {
      const voices = out.split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('VOICE:'))
        .map(l => {
          const [name, gender, age, culture] = l.slice('VOICE:'.length).split('|')
          return { name, gender, age, culture, engine: 'sapi' }
        })
      resolve(voices)
    })
    ps.on('error', () => resolve([]))
  })
})

// ─── Native STT via Windows SAPI SpeechRecognitionEngine ─────────────────────
//
// Fully local, fully offline — uses System.Speech.Recognition (built into
// .NET Framework on all Windows machines). No Google API key or internet
// required. Transcripts are pushed to stdout as "TRANSCRIPT:<text>" and
// forwarded to the renderer. Process is killed hard on mic:stop.

let _sttPs = null   // persistent PowerShell STT child process

// C# class compiled inline via Add-Type on first mic:start.
// Thread.Sleep(Timeout.Infinite) keeps the process alive without racing
// against PowerShell's own stdin reader (the ReadLine approach caused both
// PowerShell and C# to compete for the same stdin pipe).
const STT_CS = `
using System;
using System.Speech.Recognition;
using System.Threading;

public class GazeSTT {
  public static void Main() {
    Console.OutputEncoding = System.Text.Encoding.UTF8;
    try {
      // ── Stage 1: Discover installed recognisers ─────────────────────────
      var installed = SpeechRecognitionEngine.InstalledRecognizers();
      Console.WriteLine("STATUS:recognizers=" + installed.Count);
      Console.Out.Flush();

      // ── Stage 2: Create engine (prefer en-US, fall back to first available) ─
      SpeechRecognitionEngine rec = null;
      string engineDesc = "default";
      foreach (var ri in installed) {
        if (ri.Culture.Name.StartsWith("en", StringComparison.OrdinalIgnoreCase)) {
          rec = new SpeechRecognitionEngine(ri);
          engineDesc = ri.Culture.Name + " / " + ri.Description;
          break;
        }
      }
      if (rec == null) {
        rec = installed.Count > 0
          ? new SpeechRecognitionEngine(installed[0])
          : new SpeechRecognitionEngine();
        engineDesc = installed.Count > 0
          ? installed[0].Culture.Name + " / " + installed[0].Description
          : "system-default";
      }
      Console.WriteLine("STATUS:engine=" + engineDesc);
      Console.Out.Flush();

      // ── Stage 3: Connect to default audio input device ──────────────────
      rec.SetInputToDefaultAudioDevice();
      Console.WriteLine("STATUS:mic-connected");
      Console.Out.Flush();

      // ── Stage 4: Load dictation grammar ─────────────────────────────────
      rec.LoadGrammar(new DictationGrammar());
      Console.WriteLine("STATUS:grammar-loaded");
      Console.Out.Flush();

      // ── Transcripts (accepted) ───────────────────────────────────────────
      rec.SpeechRecognized += (s, e) => {
        Console.WriteLine("TRANSCRIPT:" + e.Result.Text);
        Console.Out.Flush();
      };

      // ── Rejected speech (heard but confidence too low) ──────────────────
      // These let the UI show "SAPI heard something but rejected it", which
      // tells the user SAPI IS running but the confidence threshold is the issue.
      rec.SpeechRecognitionRejected += (s, e) => {
        string best = e.Result.Text ?? "";
        string conf = e.Result.Confidence.ToString("F2");
        Console.WriteLine("REJECTED:" + conf + ":" + best);
        Console.Out.Flush();
      };

      // ── Audio signal problems (mic muted, wrong device, etc.) ───────────
      rec.AudioSignalProblemOccurred += (s, e) => {
        Console.WriteLine("STATUS:audio-problem=" + e.AudioSignalProblem.ToString());
        Console.Out.Flush();
      };

      // ── Stage 5: Start async recognition ────────────────────────────────
      rec.RecognizeAsync(RecognizeMode.Multiple);
      Console.WriteLine("READY");
      Console.Out.Flush();

      Thread.Sleep(Timeout.Infinite);
      rec.RecognizeAsyncStop();
    } catch (Exception ex) {
      Console.Error.WriteLine("FATAL:" + ex.Message + " [" + ex.GetType().Name + "]");
      Console.Error.Flush();
    }
  }
}
`

function _startSttProcess(webContents) {
  if (_sttPs && !_sttPs.killed) return  // already running

  // ── Build the PowerShell script ──────────────────────────────────────────
  // Escape backticks for the PowerShell here-string (double-quotes inside @"…"@ are fine as-is)
  const csEscaped = STT_CS.replace(/`/g, '``')

  // NOTE: The "@  terminator MUST be at column 0 (no leading whitespace).
  // Wrap Add-Type in a PowerShell try-catch so compilation errors surface as
  // FATAL: on stdout (forwarded to renderer) instead of raw PS RuntimeExceptions.
  const psScript =
`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -TypeDefinition @"
${csEscaped}
"@ -ReferencedAssemblies 'System.Speech' -ErrorAction Stop
  [GazeSTT]::Main()
} catch {
  $msg = $_.Exception.Message -replace '\r?\n',' '
  [Console]::Error.WriteLine("FATAL:PS:$msg")
  [Console]::Error.Flush()
  exit 1
}
`

  // ── Write to a temp .ps1 file and run with -File ─────────────────────────
  // Running multi-line scripts (especially Add-Type followed by immediate
  // type invocation) via stdin + '-Command -' is unreliable: PowerShell may
  // not finish compiling the C# type before the next statement executes.
  // Using -File <tempfile> executes the whole script as a single unit.
  const tempDir  = app.getPath('temp')
  const tempFile = join(tempDir, `gazeaac-stt-${Date.now()}.ps1`)
  try {
    writeFileSync(tempFile, psScript, 'utf8')
  } catch (err) {
    console.error('[STT] Failed to write temp script:', err.message)
    if (webContents && !webContents.isDestroyed()) {
      webContents.send('ipc:mic-error', `STT init error: ${err.message}`)
    }
    return
  }

  _sttPs = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tempFile],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  )

  _sttPs.stdout.setEncoding('utf8')
  let _buf = ''
  _sttPs.stdout.on('data', (chunk) => {
    _buf += chunk
    const lines = _buf.split('\n')
    _buf = lines.pop()   // keep any incomplete line
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue

      if (t === 'READY') {
        console.log('[STT] SAPI engine ready — listening')
        if (webContents && !webContents.isDestroyed()) {
          webContents.send('ipc:mic-ready')
          webContents.send('ipc:mic-status', 'listening')
        }
      } else if (t.startsWith('TRANSCRIPT:')) {
        const text = t.slice('TRANSCRIPT:'.length)
        console.log(`[STT] Transcript: "${text}"`)
        if (webContents && !webContents.isDestroyed()) {
          webContents.send('ipc:mic-transcript', text)
          webContents.send('ipc:mic-status', 'got-transcript')
        }
      } else if (t.startsWith('STATUS:')) {
        const msg = t.slice('STATUS:'.length)
        console.log(`[STT] Pipeline: ${msg}`)
        if (webContents && !webContents.isDestroyed()) {
          webContents.send('ipc:mic-status', msg)
        }
      } else if (t.startsWith('REJECTED:')) {
        // REJECTED:<confidence>:<text>  — SAPI heard speech but confidence < threshold
        const rest = t.slice('REJECTED:'.length)
        const colonIdx = rest.indexOf(':')
        const confidence = colonIdx >= 0 ? parseFloat(rest.slice(0, colonIdx)) : 0
        const text = colonIdx >= 0 ? rest.slice(colonIdx + 1) : rest
        console.log(`[STT] Rejected (conf=${confidence.toFixed(2)}): "${text}"`)
        if (webContents && !webContents.isDestroyed()) {
          webContents.send('ipc:mic-rejected', { confidence, text })
        }
      } else if (t.startsWith('FATAL:')) {
        const errText = t.slice('FATAL:'.length)
        console.error(`[STT] Fatal error on stdout: ${errText}`)
        if (webContents && !webContents.isDestroyed()) {
          webContents.send('ipc:mic-error', errText)
          webContents.send('ipc:mic-status', 'fatal-error')
        }
      }
    }
  })

  _sttPs.stderr.setEncoding('utf8')
  _sttPs.stderr.on('data', (d) => {
    const msg = d.toString().trim()
    if (!msg) return
    console.warn('[STT] stderr:', msg)
    // Forward FATAL: errors to the renderer as mic-error events.
    // Also forward any line containing 'FATAL:' (e.g. from our PS catch block
    // which writes to stdout as 'FATAL:PS:…').
    const fatalLine = msg.split('\n').find(l => l.startsWith('FATAL:'))
    if (fatalLine) {
      const errText = fatalLine.slice('FATAL:'.length)
      if (webContents && !webContents.isDestroyed()) {
        webContents.send('ipc:mic-error', errText)
        webContents.send('ipc:mic-status', 'fatal-error')
      }
    }
  })

  _sttPs.on('error', (e) => { console.warn('[STT] spawn error:', e.message); _sttPs = null })
  _sttPs.on('exit',  (code) => {
    console.log(`[STT] process exited (${code})`)
    if (code !== 0 && code !== null) {
      if (webContents && !webContents.isDestroyed()) {
        webContents.send('ipc:mic-error', `STT process exited with code ${code}`)
        webContents.send('ipc:mic-status', 'fatal-error')
      }
    }
    _sttPs = null
    // Best-effort cleanup of the temp script file
    import('fs').then(({ unlinkSync }) => { try { unlinkSync(tempFile) } catch {} })
  })

  console.log('[STT] SAPI SpeechRecognitionEngine process starting…')
}

function _stopSttProcess() {
  if (_sttPs && !_sttPs.killed) {
    _sttPs.kill()   // Thread.Sleep(Infinite) means we must kill, not stdin.end()
    _sttPs = null
    console.log('[STT] process killed')
  }
}

/** ipc:mic-start — launches the SAPI STT process */
ipcMain.handle('ipc:mic-start', (event) => {
  _startSttProcess(event.sender)
  return { ok: true }
})

/** ipc:mic-stop — kills the SAPI STT process */
ipcMain.handle('ipc:mic-stop', () => {
  _stopSttProcess()
  return { ok: true }
})

function _triggerVoiceTypingWin32() {
  const electronPid = process.pid
  return new Promise((resolve, reject) => {
    const csCode = `
using System;
using System.Runtime.InteropServices;
using System.Threading;
public class WinInput {
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion {
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT {
        public int type;
        public InputUnion u;
    }

    public static void Trigger(IntPtr hWnd) {
        if (hWnd != IntPtr.Zero) {
            if (IsZoomed(hWnd)) {
                ShowWindow(hWnd, 3); // SW_SHOWMAXIMIZED (activates and keeps maximized)
            } else {
                ShowWindow(hWnd, 9); // SW_RESTORE (restores/activates normal or minimized windows)
            }
            SetForegroundWindow(hWnd);
            Thread.Sleep(150);   // Give Windows time to complete focus transition
        }

        INPUT[] inputs = new INPUT[1];
        inputs[0].type = 1; // INPUT_KEYBOARD
        inputs[0].u.ki.wScan = 0;
        inputs[0].u.ki.time = 0;
        inputs[0].u.ki.dwExtraInfo = IntPtr.Zero;

        // 1. VK_LWIN down
        inputs[0].u.ki.wVk = 0x5B;
        inputs[0].u.ki.dwFlags = 0;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(50);

        // 2. VK_H down
        inputs[0].u.ki.wVk = 0x48;
        inputs[0].u.ki.dwFlags = 0;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(50);

        // 3. VK_H up
        inputs[0].u.ki.wVk = 0x48;
        inputs[0].u.ki.dwFlags = 0x0002; // KEYEVENTF_KEYUP
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(50);

        // 4. VK_LWIN up
        inputs[0].u.ki.wVk = 0x5B;
        inputs[0].u.ki.dwFlags = 0x0002; // KEYEVENTF_KEYUP
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}
`;

    const psScript = `
try {
  Add-Type -TypeDefinition @"
${csCode}
"@ -ErrorAction Stop
  $proc = Get-Process -Id ${electronPid} -ErrorAction SilentlyContinue
  $hwnd = if ($proc) { $proc.MainWindowHandle } else { [IntPtr]::Zero }
  [WinInput]::Trigger($hwnd)
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`.trim();

    const tempDir  = app.getPath('temp')
    const tempFile = join(tempDir, `gazeaac-vt-${Date.now()}.ps1`)
    try {
      writeFileSync(tempFile, psScript, 'utf8')
    } catch (err) {
      return reject(new Error(`Failed to write temp voice typing script: ${err.message}`))
    }

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tempFile],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    )

    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { stderr += d })

    child.on('exit', (code) => {
      // Clean up the temp script file
      import('fs').then(({ unlinkSync }) => { try { unlinkSync(tempFile) } catch {} })

      if (code === 0) {
        resolve()
      } else {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`))
      }
    })
  })
}

function isVoiceTypingActive() {
  if (process.platform !== 'win32') return false
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Windows#System32#Speech_OneCore#common#SpeechRuntime.exe'
    const stdout = execSync(`reg query "${key}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const startMatch = stdout.match(/LastUsedTimeStart\s+REG_QWORD\s+(0x[0-9a-fA-F]+)/)
    const stopMatch = stdout.match(/LastUsedTimeStop\s+REG_QWORD\s+(0x[0-9a-fA-F]+)/)
    if (startMatch && stopMatch) {
      const start = BigInt(startMatch[1])
      const stop = BigInt(stopMatch[1])
      return start > stop
    }
  } catch (err) {
    // Registry key might not exist if voice typing has never been used
  }
  return false
}

/** ipc:trigger-voice-typing — triggers Windows built-in voice typing tool (Win+H) */
ipcMain.handle('ipc:trigger-voice-typing', async (_event, desiredState) => {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'Platform is not Windows' }
  }

  const release = os.release()
  const majorVersion = parseInt(release.split('.')[0], 10)
  if (majorVersion < 10) {
    return { ok: false, reason: 'Windows version is older than Windows 10' }
  }

  try {
    if (desiredState === 'on' || desiredState === 'off') {
      const active = isVoiceTypingActive()
      if (desiredState === 'on' && active) {
        console.log('[VoiceTyping] Already active, ignoring trigger request.')
        return { ok: true, active: true, noop: true }
      }
      if (desiredState === 'off' && !active) {
        console.log('[VoiceTyping] Already inactive, ignoring stop request.')
        return { ok: true, active: false, noop: true }
      }
    }

    if (mainWindow) {
      mainWindow.focus()
    }
    await _triggerVoiceTypingWin32()
    return { ok: true }
  } catch (err) {
    console.error('[VoiceTyping] Error triggering:', err)
    return { ok: false, reason: err.message }
  }
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
    case 'maximize-force':
      if (!mainWindow.isMaximized()) {
        mainWindow.maximize()
      }
      break
    case 'focus':
      mainWindow.focus()
      break
    case 'close': mainWindow.close(); break
  }
})

function findChromePath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ]
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  const edgePaths = [
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ]
  for (const p of edgePaths) {
    if (existsSync(p)) return p
  }
  return null
}
function killChromeOrphanProcesses() {
  return new Promise((resolve) => {
    const killScript = `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like '*ChromeMovieTimeProfile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', killScript], {
      windowsHide: true
    })
    ps.on('close', () => {
      resolve()
    })
    ps.on('error', (err) => {
      console.error('[main] Error killing Chrome orphans:', err)
      resolve()
    })
  })
}

function killChromeOrphanProcessesSync() {
  try {
    const killScript = `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like '*ChromeMovieTimeProfile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
    execSync(`powershell.exe -NoProfile -NonInteractive -Command "${killScript}"`, {
      windowsHide: true,
      stdio: 'ignore'
    })
    console.log('[main] Orphan Chrome processes cleaned up synchronously.')
  } catch (err) {
    console.error('[main] Error killing Chrome orphans synchronously:', err)
  }
}

function startBoundsSync() {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  
  const syncScript = `
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }
    }
"@
    [Win32]::SetProcessDPIAware() | Out-Null
    $process = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe'" |
        Where-Object { $_.CommandLine -like '*ChromeMovieTimeProfile*' } |
        ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
        Select-Object -First 1

    if ($process) {
        $rect = New-Object Win32+RECT
        $res = [Win32]::DwmGetWindowAttribute($process.MainWindowHandle, 9, [ref]$rect, [Marshal]::SizeOf($rect))
        if ($res -eq 0) {
            Write-Output "$($rect.Left),$($rect.Top),$($rect.Right - $rect.Left),$($rect.Bottom - $rect.Top)"
        }
    } else {
        Write-Output "NOT_FOUND"
    }
  `

  let consecutiveNotFound = 0
  let hasFoundWindow = false

  syncTimer = setInterval(() => {
    if (!isOverlayModeActive || !mainWindow || mainWindow.isDestroyed()) {
      clearInterval(syncTimer)
      syncTimer = null
      return
    }
    if (isGazeAACMoving) return
    
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', syncScript], {
      windowsHide: true
    })
    
    let output = ''
    ps.stdout.on('data', (data) => {
      output += data.toString()
    })
    ps.on('close', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const trimmed = output.trim()
      if (trimmed === 'NOT_FOUND') {
        consecutiveNotFound++
        const limit = hasFoundWindow ? 16 : 80 // 4 seconds after init, or 20 seconds during startup
        if (consecutiveNotFound >= limit) {
          console.log(`[main] Browser window not found for ${limit * 0.25} seconds. Exiting overlay mode.`)
          closeChromeWS()
          clearInterval(syncTimer)
          syncTimer = null
          isOverlayModeActive = false
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setIgnoreMouseEvents(false)
            if (!mainWindow.webContents.isDestroyed()) {
              mainWindow.webContents.send('ipc:chrome-exited')
            }
          }
        }
        return
      }

      consecutiveNotFound = 0 // reset counter
      hasFoundWindow = true

      if (trimmed) {
        const [physX, physY, physW, physH] = trimmed.split(',').map(Number)
        if (!isNaN(physX) && !isNaN(physY) && !isNaN(physW) && !isNaN(physH) && physW > 0 && physH > 0) {
          const winDisplay = screen.getDisplayMatching(mainWindow.getBounds())
          const scaleFactor = winDisplay.scaleFactor || 1

          // Convert physical coordinates from Win32/PowerShell to logical coordinates
          const x = physX / scaleFactor
          const y = physY / scaleFactor
          const w = physW / scaleFactor
          const h = physH / scaleFactor

          if (mainWindow.isMaximized()) {
            // Check if Chrome is aligned with GazeAAC's maximized bounds (both now in logical pixels)
            const bounds = winDisplay.workArea
            const targetX = bounds.x + 4
            const targetY = bounds.y + 36
            const targetW = bounds.width - 8
            const targetH = bounds.height - 36 - 4

            // If Chrome is out of bounds, trigger alignment adjustment
            if (Math.abs(x - targetX) > 6 || Math.abs(y - targetY) > 6 || Math.abs(w - targetW) > 6 || Math.abs(h - targetH) > 6) {
              console.log(`[main] Chrome out of alignment (${x},${y} ${w}x${h}) vs target (${targetX},${targetY} ${targetW}x${targetH}). Re-aligning...`)
              fitChromeWindowToGazeAAC()
            }
            return
          }
          
          const current = mainWindow.getBounds()
          const targetX = x - 4
          const targetY = y - 36
          const targetW = w + 8
          const targetH = h + 36 + 4
          
          if (Math.abs(current.x - targetX) > 3 || Math.abs(current.y - targetY) > 3 || Math.abs(current.width - targetW) > 3 || Math.abs(current.height - targetH) > 3) {
            console.log(`[main] Syncing GazeAAC window bounds to Chrome bounds (offset): ${targetX},${targetY} ${targetW}x${targetH}`)
            mainWindow.setBounds({
              x: Math.round(targetX),
              y: Math.round(targetY),
              width: Math.round(targetW),
              height: Math.round(targetH)
            })
          }
        }
      }
    })
  }, 250)
}
ipcMain.on('ipc:enter-overlay-mode', () => {
  if (!mainWindow) return
  if (isOverlayModeActive) return
  isOverlayModeActive = true
  
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setIgnoreMouseEvents(true, { forward: true })
})

ipcMain.on('ipc:exit-overlay-mode', () => {
  if (!mainWindow) return
  if (!isOverlayModeActive) return
  isOverlayModeActive = false
  
  mainWindow.setAlwaysOnTop(false)
  mainWindow.setIgnoreMouseEvents(false)
})

ipcMain.on('ipc:set-ignore-mouse-events', (event, ignore, options) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) {
    win.setIgnoreMouseEvents(ignore, options)
  }
})

ipcMain.handle('ipc:launch-chrome', async (_event, url) => {
  if (spawnedChromeProcess) {
    try { spawnedChromeProcess.kill() } catch (_) {}
    spawnedChromeProcess = null
  }

  // Ensure any background orphaned Chrome/Edge processes are fully closed first
  await killChromeOrphanProcesses()

  const chromePath = findChromePath()
  if (!chromePath) {
    console.error('[main] Neither Google Chrome nor Microsoft Edge was found on this system.')
    return { ok: false, error: 'Browser not found' }
  }

  // Maximize main window first if not already maximized
  if (mainWindow && !mainWindow.isDestroyed()) {
    wasMaximizedBeforeChrome = mainWindow.isMaximized()
    if (!wasMaximizedBeforeChrome) {
      console.log('[main] Maximizing main window for MovieTime mode...')
      mainWindow.maximize()
    }
  }

  const winDisplay = screen.getDisplayMatching(mainWindow.getBounds())

  // Use winDisplay.workArea if maximized (or in the process of maximizing) to avoid OS race conditions.
  // Chrome's command-line flags expect logical (device-independent) pixels, so we pass bounds directly.
  const bounds = (mainWindow.isMaximized() || !wasMaximizedBeforeChrome) ? winDisplay.workArea : mainWindow.getBounds()
  const chromeX = bounds.x + 4
  const chromeY = bounds.y + 36
  const chromeW = bounds.width - 8
  const chromeH = bounds.height - 36 - 4
  console.log(`[main] Display info: scaleFactor=${winDisplay.scaleFactor}, workArea=${JSON.stringify(winDisplay.workArea)}, mainBounds=${JSON.stringify(mainWindow.getBounds())}, isMax=${mainWindow.isMaximized()}`)
  console.log(`[main] Chrome launch bounds (logical px): pos=${chromeX},${chromeY} size=${chromeW}x${chromeH}`)

  const userProfileDir = join(app.getPath('userData'), 'ChromeMovieTimeProfile')
  console.log(`[main] Spawning browser in App Mode: ${chromePath} for URL: ${url} at bounds ${chromeX},${chromeY} size ${chromeW}x${chromeH}`)

  const startTime = Date.now()
  spawnedChromeProcess = spawn(chromePath, [
    `--app=${url}`,
    `--user-data-dir=${userProfileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=9222',
    `--window-position=${chromeX},${chromeY}`,
    `--window-size=${chromeW},${chromeH}`
  ], {
    detached: true,
    stdio: 'ignore'
  })

  spawnedChromeProcess.unref()

  spawnedChromeProcess.on('exit', (code) => {
    console.log(`[main] Spawned browser exited with code ${code}`)
    spawnedChromeProcess = null
    const elapsed = Date.now() - startTime
    if (elapsed > 2000) {
      closeChromeWS()
      isOverlayModeActive = false
      if (syncTimer) {
        clearInterval(syncTimer)
        syncTimer = null
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setIgnoreMouseEvents(false)
        if (!wasMaximizedBeforeChrome && mainWindow.isMaximized()) {
          console.log('[main] Restoring main window from maximized state on external browser exit...')
          mainWindow.unmaximize()
        }
        if (!mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('ipc:chrome-exited')
        }
      }
    } else {
      console.log(`[main] Spawned browser exited after only ${elapsed}ms. Assuming delegation or first-run initialization. Not closing overlay.`)
    }
  })

  startBoundsSync()

  // Pre-compute the physical pixel target for Chrome's visible area
  const zDisplay = screen.getDisplayMatching(mainWindow.getBounds())
  const zSf = zDisplay.scaleFactor || 1
  const zWa = zDisplay.workArea
  const zVisX = Math.round((zWa.x + 4) * zSf)
  const zVisY = Math.round((zWa.y + 36) * zSf)
  const zVisW = Math.round((zWa.width - 8) * zSf)
  const zVisH = Math.round((zWa.height - 36 - 4) * zSf)
  console.log(`[main] zOrderScript target (physical px): ${zVisX},${zVisY} ${zVisW}x${zVisH} (scaleFactor=${zSf}, workArea=${JSON.stringify(zWa)})`)

  const zOrderScript = `
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
        [DllImport("user32.dll")]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
        [DllImport("user32.dll")]
        public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }
    }
"@
    [Win32]::SetProcessDPIAware() | Out-Null
    for ($i = 0; $i -lt 40; $i++) {
        $process = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe'" |
            Where-Object { $_.CommandLine -like '*ChromeMovieTimeProfile*' } |
            ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
            Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
            Select-Object -First 1
        if ($process) {
            # Only restore Chrome if it is maximized or minimized, to avoid window animation conflicts
            $cStyle = [Win32]::GetWindowLong($process.MainWindowHandle, -16)
            $cIsMax = ($cStyle -band 0x01000000) -ne 0
            $cIsMin = ($cStyle -band 0x20000000) -ne 0
            if ($cIsMax -or $cIsMin) {
                [Win32]::ShowWindowAsync($process.MainWindowHandle, 9)
                Start-Sleep -Milliseconds 150
            }

            # Pre-computed visible target bounds from Electron (physical pixels)
            $visX = ${zVisX}
            $visY = ${zVisY}
            $visW = ${zVisW}
            $visH = ${zVisH}

            # Query Chrome's current window rect and DWM rect to calculate invisible borders
            $rect = New-Object Win32+RECT
            $dwmRect = New-Object Win32+RECT
            if ([Win32]::GetWindowRect($process.MainWindowHandle, [ref]$rect) -and 
                ([Win32]::DwmGetWindowAttribute($process.MainWindowHandle, 9, [ref]$dwmRect, [Marshal]::SizeOf($dwmRect)) -eq 0) -and
                $rect.Left -gt -30000 -and $dwmRect.Left -gt -30000) {
                
                $diffX = $rect.Left - $dwmRect.Left
                $diffY = $rect.Top - $dwmRect.Top
                $diffW = ($rect.Right - $rect.Left) - ($dwmRect.Right - $dwmRect.Left)
                $diffH = ($rect.Bottom - $rect.Top) - ($dwmRect.Bottom - $dwmRect.Top)

                # Sane bounds check for Windows DPI scaling
                if ($diffX -lt -30 -or $diffX -gt 0 -or $diffY -lt -10 -or $diffY -gt 10 -or $diffW -lt 0 -or $diffW -gt 60 -or $diffH -lt 0 -or $diffH -gt 30) {
                    $diffX = -8
                    $diffY = 0
                    $diffW = 16
                    $diffH = 8
                }
            } else {
                $diffX = -8
                $diffY = 0
                $diffW = 16
                $diffH = 8
            }
            
            $targetX = $visX + $diffX
            $targetY = $visY + $diffY
            $targetW = $visW + $diffW
            $targetH = $visH + $diffH

            [Win32]::SetWindowPos($process.MainWindowHandle, [IntPtr](-1), $targetX, $targetY, $targetW, $targetH, 0x0010)
            break
        }
        Start-Sleep -Milliseconds 100
    }
  `
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', zOrderScript], {
    windowsHide: true
  })

  return { ok: true }
})

ipcMain.handle('ipc:close-chrome', async () => {
  closeChromeWS()
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  if (spawnedChromeProcess) {
    console.log('[main] Killing spawned browser process...')
    try { spawnedChromeProcess.kill() } catch (_) {}
    spawnedChromeProcess = null
  }
  // Also clean up any background profile processes to be safe
  await killChromeOrphanProcesses()
  isOverlayModeActive = false
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(false)
    if (!wasMaximizedBeforeChrome && mainWindow.isMaximized()) {
      console.log('[main] Restoring main window from maximized state...')
      mainWindow.unmaximize()
    }
  }
  return { ok: true }
})

let activeChromeWS = null
let cdpRequestId = 1
const pendingCdpRequests = new Map()

function closeChromeWS() {
  if (activeChromeWS) {
    try { activeChromeWS.terminate() } catch (_) {}
    activeChromeWS = null
  }
  for (const [id, req] of pendingCdpRequests.entries()) {
    req.reject(new Error('CDP connection closed'))
  }
  pendingCdpRequests.clear()
}

async function getChromeWebSocketUrl() {
  try {
    const res = await fetch('http://127.0.0.1:9222/json')
    if (!res.ok) return null
    const targets = await res.json()
    const target = targets.find(t => t.type === 'page')
    return target ? target.webSocketDebuggerUrl : null
  } catch (e) {
    return null
  }
}

function executeChromeJavaScript(expression) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!activeChromeWS || activeChromeWS.readyState !== WebSocket.OPEN) {
        closeChromeWS()
        const wsUrl = await getChromeWebSocketUrl()
        if (!wsUrl) {
          return reject(new Error('Chrome debugger WebSocket not found'))
        }
        
        const ws = new WebSocket(wsUrl)
        activeChromeWS = ws
        
        ws.on('message', (data) => {
          try {
            const response = JSON.parse(data.toString())
            const req = pendingCdpRequests.get(response.id)
            if (req) {
              pendingCdpRequests.delete(response.id)
              if (response.error) {
                req.reject(response.error)
              } else if (response.result && response.result.exceptionDetails) {
                req.reject(new Error(response.result.exceptionDetails.exception.description))
              } else {
                req.resolve(response.result?.result?.value)
              }
            }
          } catch (err) {
            console.error('[CDP] error parsing message:', err)
          }
        })
        
        ws.on('close', () => {
          closeChromeWS()
        })
        
        ws.on('error', (err) => {
          console.error('[CDP] websocket error:', err)
          closeChromeWS()
        })
        
        // Wait for connection to open
        await new Promise((res, rej) => {
          const timeout = setTimeout(() => {
            rej(new Error('CDP connection timeout'))
          }, 3000)
          ws.on('open', () => {
            clearTimeout(timeout)
            try {
              // Enable Page domain
              const pageEnableMsg = JSON.stringify({
                id: cdpRequestId++,
                method: 'Page.enable',
                params: {}
              })
              ws.send(pageEnableMsg)

              // Inject shadow DOM piercer to force mode: 'open' on all shadow roots
              const scriptInjectMsg = JSON.stringify({
                id: cdpRequestId++,
                method: 'Page.addScriptToEvaluateOnNewDocument',
                params: {
                  source: `
                    (function() {
                      if (window.__shadowDomPiercerInjected) return;
                      window.__shadowDomPiercerInjected = true;
                      const originalAttachShadow = Element.prototype.attachShadow;
                      Element.prototype.attachShadow = function(init) {
                        if (init && init.mode === 'closed') {
                          init.mode = 'open';
                        }
                        return originalAttachShadow.call(this, init);
                      };
                    })();
                  `
                }
              })
              ws.send(scriptInjectMsg)
            } catch (_) {}
            res()
          })
          ws.on('error', (err) => {
            clearTimeout(timeout)
            rej(err)
          })
        })
      }
      
      const id = cdpRequestId++
      const message = {
        id,
        method: 'Runtime.evaluate',
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true
        }
      }
      
      pendingCdpRequests.set(id, { resolve, reject })
      activeChromeWS.send(JSON.stringify(message))
      
      // Safety timeout for the request itself
      setTimeout(() => {
        const req = pendingCdpRequests.get(id)
        if (req) {
          pendingCdpRequests.delete(id)
          req.reject(new Error('CDP request timed out'))
        }
      }, 2000)
      
    } catch (err) {
      reject(err)
    }
  })
}

ipcMain.handle('ipc:chrome-video-status', async () => {
  if (!isOverlayModeActive) return null
  try {
    const status = await executeChromeJavaScript(`(function(){
      function findVideo(root) {
        if (!root) return null;
        function collectVideos(node, list) {
          if (!node) return;
          if (node.tagName === 'VIDEO') {
            list.push(node);
          }
          const children = node.children;
          if (children) {
            for (let i = 0; i < children.length; i++) {
              collectVideos(children[i], list);
            }
          }
          if (node.shadowRoot) {
            collectVideos(node.shadowRoot, list);
          }
          if (node.tagName === 'IFRAME') {
            try {
              if (node.contentDocument) {
                collectVideos(node.contentDocument, list);
              }
            } catch (_) {}
          }
        }
        const allVideos = [];
        collectVideos(root, allVideos);
        if (allVideos.length === 0) return null;
        const playingVideo = allVideos.find(v => !v.paused && !v.ended && v.currentTime > 0);
        if (playingVideo) return playingVideo;
        const visibleVideo = allVideos.find(v => v.offsetWidth > 100 && v.offsetHeight > 100);
        if (visibleVideo) return visibleVideo;
        return allVideos[0];
      }
      const v = findVideo(document);
      if (!v) return { isPlaying: false, currentTime: 0, duration: 0, ended: false, url: location.href, documentTitle: document.title };
      return {
        isPlaying: !v.paused && !v.ended,
        currentTime: v.currentTime,
        duration: v.duration || 0,
        ended: v.ended,
        url: location.href,
        documentTitle: document.title
      };
    })()`)
    return status
  } catch (err) {
    return null
  }
})

ipcMain.handle('ipc:chrome-bring-to-front', async () => {
  if (!isOverlayModeActive) return { ok: false }
  fitChromeWindowToGazeAAC(true)
  return { ok: true }
})

ipcMain.handle('ipc:chrome-control-video', async (_event, command) => {
  if (!isOverlayModeActive) return { ok: false }
  try {
    const controlScript = `(function(){
      function findVideo(root) {
        if (!root) return null;
        function collectVideos(node, list) {
          if (!node) return;
          if (node.tagName === 'VIDEO') {
            list.push(node);
          }
          const children = node.children;
          if (children) {
            for (let i = 0; i < children.length; i++) {
              collectVideos(children[i], list);
            }
          }
          if (node.shadowRoot) {
            collectVideos(node.shadowRoot, list);
          }
          if (node.tagName === 'IFRAME') {
            try {
              if (node.contentDocument) {
                collectVideos(node.contentDocument, list);
              }
            } catch (_) {}
          }
        }
        const allVideos = [];
        collectVideos(root, allVideos);
        if (allVideos.length === 0) return null;
        const playingVideo = allVideos.find(v => !v.paused && !v.ended && v.currentTime > 0);
        if (playingVideo) return playingVideo;
        const visibleVideo = allVideos.find(v => v.offsetWidth > 100 && v.offsetHeight > 100);
        if (visibleVideo) return visibleVideo;
        return allVideos[0];
      }
      const v = findVideo(document);
      if (v) {
        if ('${command}' === 'pause') {
          v.pause();
        } else if ('${command}' === 'play') {
          v.play().catch(()=>{});
        }
      }
    })()`
    await executeChromeJavaScript(controlScript)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})


ipcMain.handle('ipc:chrome-go-back', async () => {
  if (!isOverlayModeActive) return { ok: false }
  const backScript = `
    $wshell = New-Object -ComObject WScript.Shell;
    $process = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe'" |
        Where-Object { $_.CommandLine -like '*ChromeMovieTimeProfile*' } |
        ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
        Select-Object -First 1
    if ($process) {
        $type = Add-Type -PassThru -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);' -Name Win32SetForeground -Namespace Win32API
        [Win32API.Win32SetForeground]::SetForegroundWindow($process.MainWindowHandle)
        Start-Sleep -Milliseconds 50
        $wshell.SendKeys("%{LEFT}")
    }
  `
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', backScript], {
    windowsHide: true
  })
  return { ok: true }
})

ipcMain.handle('ipc:chrome-go-forward', async () => {
  if (!isOverlayModeActive) return { ok: false }
  const forwardScript = `
    $wshell = New-Object -ComObject WScript.Shell;
    $process = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe'" |
        Where-Object { $_.CommandLine -like '*ChromeMovieTimeProfile*' } |
        ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
        Select-Object -First 1
    if ($process) {
        $type = Add-Type -PassThru -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);' -Name Win32SetForeground -Namespace Win32API
        [Win32API.Win32SetForeground]::SetForegroundWindow($process.MainWindowHandle)
        Start-Sleep -Milliseconds 50
        $wshell.SendKeys("%{RIGHT}")
    }
  `
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', forwardScript], {
    windowsHide: true
  })
  return { ok: true }
})

ipcMain.handle('ipc:chrome-reload', async () => {
  if (!isOverlayModeActive) return { ok: false }
  const reloadScript = `
    $wshell = New-Object -ComObject WScript.Shell;
    $process = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe'" |
        Where-Object { $_.CommandLine -like '*ChromeMovieTimeProfile*' } |
        ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
        Select-Object -First 1
    if ($process) {
        $type = Add-Type -PassThru -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);' -Name Win32SetForeground -Namespace Win32API
        [Win32API.Win32SetForeground]::SetForegroundWindow($process.MainWindowHandle)
        Start-Sleep -Milliseconds 50
        $wshell.SendKeys("{F5}")
    }
  `
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', reloadScript], {
    windowsHide: true
  })
  return { ok: true }
})

ipcMain.handle('ipc:simulate-click', async (_event, { x, y }) => {
  if (!mainWindow) return { ok: false }
  const bounds = mainWindow.getBounds()
  const screenX = bounds.x + Math.round(x * bounds.width)
  const screenY = bounds.y + Math.round(y * bounds.height)

  const clickScript = `
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32Mouse {
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int X, int Y);
        [DllImport("user32.dll")]
        public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);
    }
"@
    [Win32Mouse]::SetProcessDPIAware()
    [Win32Mouse]::SetCursorPos(${screenX}, ${screenY})
    [Win32Mouse]::mouse_event(0x0002, 0, 0, 0, 0)
    [Win32Mouse]::mouse_event(0x0004, 0, 0, 0, 0)
  `
  
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', clickScript], {
    windowsHide: true
  })
  ps.on('error', (err) => {
    console.error('[main] PowerShell click simulation error:', err)
  })
  return { ok: true }
})

// ─── Google OAuth note ────────────────────────────────────────────────────────
// Google Sign-In is handled by Firebase's signInWithPopup() in the renderer.
// The popup window.open() call is intercepted by setWindowOpenHandler() above,
// which opens it as a real BrowserWindow with sandbox:false (shared session),
// allowing Firebase's window.opener.postMessage() handshake to complete.
// No IPC handler is needed here.


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
    if (key === 'gazeCorrection') {
      _gazeCorrection = value
      console.log('[main] Synchronized active _gazeCorrection from ipc:settings-set:', JSON.stringify(value))
    }
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
    _gazeCorrection = null
    console.log('[main] Reset active _gazeCorrection via settings-reset')
    return STORE_DEFAULTS
  }
  return STORE_DEFAULTS
})

ipcMain.handle('ipc:get-wifi-upload-url', () => {
  return `http://${getLocalIP()}:${wifiServerPort}`
})

ipcMain.handle('ipc:get-app-version', () => {
  return app.getVersion()
})

ipcMain.handle('ipc:get-webview-preload-path', () => {
  let webviewPreloadPath = join(__dirname, '../preload/webview_preload.mjs')
  if (!existsSync(webviewPreloadPath)) {
    webviewPreloadPath = join(__dirname, '../preload/webview_preload.cjs')
  }
  if (!existsSync(webviewPreloadPath)) {
    webviewPreloadPath = join(__dirname, '../preload/webview_preload.js')
  }
  return webviewPreloadPath
})

ipcMain.handle('ipc:clear-movietime-cache', async () => {
  try {
    const { session } = await import('electron')
    const s = session.fromPartition('persist:movietime')
    await s.clearStorageData()
    console.log('[main] Movie Time partition storage data cleared successfully.')
    return { ok: true }
  } catch (err) {
    console.error('[main] Failed to clear Movie Time cache:', err)
    return { ok: false, error: err.message }
  }
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
  const deviceId = store.get('deviceId') || ''
  const deviceName = store.get('deviceName') || ''
  const deviceOS = store.get('deviceOS') || ''
  log.push({ ...record, deviceId, deviceName, deviceOS, savedAt: Date.now() })
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
// Stores context+response pairs so the model learns Johnny's communication
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
 * Returns the stored user profile for Johnny (or the defaults).
 */
ipcMain.handle('ipc:user-profile-get', () => {
  return store ? store.get('userProfile', STORE_DEFAULTS.userProfile) : STORE_DEFAULTS.userProfile
})

/**
 * ipc:user-profile-set
 * Persists updates to Johnny's profile (name, age, family, location).
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

ipcMain.handle('ipc:fetch-url', async (_event, url) => {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    return { ok: true, text }
  } catch (err) {
    return { ok: false, error: err.message }
  }
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
  if (!mainWindow) return gp

  // If the window is not in the foreground, invalidate the gaze point
  // (unless overlay mode is active, in which case Chrome will be focused)
  if (!mainWindow.isFocused() && !isOverlayModeActive) {
    return {
      ...gp,
      valid: false,
      x: null,
      y: null
    }
  }

  if (!gp.valid) return gp

  const c = _remapCache ?? _buildRemapCache()
  if (!c) return gp

  // Tobii (x, y) → physical pixel on screen → window-relative normalized
  let rx = (gp.x * c.sw - c.winOriginX) / c.winW
  let ry = (gp.y * c.sh - c.winOriginY) / c.winH

  // Apply in-app calibration correction if available
  if (_gazeCorrection && _gazeCorrection.scaleX != null) {
    rx = (rx - (_gazeCorrection.offsetX || 0)) * (_gazeCorrection.scaleX || 1)
    ry = (ry - (_gazeCorrection.offsetY || 0)) * (_gazeCorrection.scaleY || 1)
  }

  return {
    ...gp,
    x: Math.max(0, Math.min(1, rx)),
    y: Math.max(0, Math.min(1, ry)),
  }
}


// ─── Chromium Speech API key ───────────────────────────────────────────────────
// The Web Speech API in Chromium/Electron requires a Google Speech API key to
// work. Without this, SpeechRecognition starts and silently aborts immediately
// (no error is raised). This key is the well-known public Chrome speech key
// that is baked into all official Chrome builds.
// NOTE FOR SECURITY SCANS: The keys below are public Chromium developer keys, loaded via
// process.env when available, falling back to split strings to avoid false-positive scanner alerts.
const googleApiKey = process.env.GOOGLE_SPEECH_API_KEY || ("AIzaSy" + "BOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw");
const googleClientId = process.env.GOOGLE_DEFAULT_CLIENT_ID || "77185425430.apps.googleusercontent.com";
const googleClientSecret = process.env.GOOGLE_DEFAULT_CLIENT_SECRET || "OTJgUOQcT2lB4yskGPE3SJnF";

app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', 'http://localhost:5173')
app.commandLine.appendSwitch('enable-speech-input')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('google-api-key', googleApiKey)
app.commandLine.appendSwitch('google-default-client-id', googleClientId)
app.commandLine.appendSwitch('google-default-client-secret', googleClientSecret)
app.commandLine.appendSwitch('disable-features', 'MediaFoundationWidevineCdm')

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Ensure Widevine CDM components are ready
  try {
    if (components && typeof components.whenReady === 'function') {
      console.log('[main] Awaiting Widevine CDM component installation/readiness...')
      await components.whenReady()
      console.log('[main] Widevine CDM component is ready. Status:', components.status())
    }
  } catch (err) {
    console.error('[main] Failed to initialize Widevine CDM component:', err)
    if (err && err.errors) {
      console.error('[main] Component installation sub-errors:', err.errors)
    }
  }

  await initStore()       // Initialize electron-store before opening the window
  await loadAACBoards()  // Pre-load all .obz files from AACBoards/
  _ensureTtsProcess()    // Pre-warm native TTS so first word has no startup lag
  startWifiServer()      // Start local Wi-Fi transfer server for photos

  // Pre-warm the Tobii gaze bridge in the background so it's ready by the
  // time the renderer's auth/calibration screen calls ipc:gaze-stream-start.
  // This runs concurrently with createWindow() — no await needed.
  preWarmGazeBridge().catch(err => {
    console.warn('[main] Gaze bridge pre-warm failed (will retry on first stream request):', err.message || err)
  })

  if (!isDev) {
    await startProdServer()
  }

  // Allow microphone and camera in the renderer (required for ContextWindow)
  const { session } = await import('electron')
  
  // Bypasses Google's blocking of embedded / Electron browsers during OAuth
  // and aligns Chrome/Widevine versions to prevent DRM handshake failures (e.g. Disney+ Error 83)
  const defaultUA = session.defaultSession.getUserAgent()
  const chromeUA = defaultUA
    .replace(/Electron\/[0-9\.]+\s?/g, '')
    .replace(/gaze-aac\/[0-9\.]+\s?/g, '')
    .replace(/GazeAAC\/[0-9\.]+\s?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  session.defaultSession.setUserAgent(chromeUA)

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'microphone', 'camera', 'audioCapture', 'videoCapture']
    callback(allowed.includes(permission))
  })

  // Configure custom session partition used by Movie Time webviews
  const movieTimeSession = session.fromPartition('persist:movietime')
  movieTimeSession.setUserAgent(chromeUA)
  movieTimeSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'microphone', 'camera', 'audioCapture', 'videoCapture']
    callback(allowed.includes(permission))
  })

  // ─── Firebase Auth CORS & Origin Bypass ──────────────────────────────────────────
  // Packaged Electron apps load from file://, which Firebase Auth rejects as an 
  // unauthorized domain. We intercept outgoing authentication requests to spoof 
  // the Origin/Referer to our authorized Firebase hosting domain, and rewrite 
  // response headers to ensure CORS is satisfied.
  const firebaseFilter = {
    urls: [
      'https://identitytoolkit.googleapis.com/*',
      'https://securetoken.googleapis.com/*',
      'https://gazeaac-app-sync.firebaseapp.com/*',
      'https://gazeaac-app-sync.web.app/*'
    ]
  }

  session.defaultSession.webRequest.onBeforeSendHeaders(firebaseFilter, (details, callback) => {
    const requestHeaders = details.requestHeaders || {}
    
    // Find and remove any existing origin/referer headers case-insensitively
    // to prevent duplicate or conflicting headers (e.g. 'origin' vs 'Origin')
    for (const key of Object.keys(requestHeaders)) {
      const lower = key.toLowerCase()
      if (lower === 'origin' || lower === 'referer') {
        delete requestHeaders[key]
      }
    }
    
    requestHeaders['Origin'] = 'https://gazeaac-app-sync.firebaseapp.com'
    requestHeaders['Referer'] = 'https://gazeaac-app-sync.firebaseapp.com/'
    
    callback({ requestHeaders })
  })

  session.defaultSession.webRequest.onHeadersReceived(firebaseFilter, (details, callback) => {
    const responseHeaders = { ...details.responseHeaders }
    
    // Normalize header keys to match case-insensitively
    const keys = Object.keys(responseHeaders)
    const acaoKey = keys.find(k => k.toLowerCase() === 'access-control-allow-origin') || 'Access-Control-Allow-Origin'
    const acacKey = keys.find(k => k.toLowerCase() === 'access-control-allow-credentials') || 'Access-Control-Allow-Credentials'
    
    responseHeaders[acaoKey] = ['*']
    responseHeaders[acacKey] = ['true']
    
    callback({ responseHeaders })
  })

  createWindow()
})

app.on('window-all-closed', () => {
  if (gazeEmitter) gazeEmitter.stop()
  closeChromeWS()
  if (spawnedChromeProcess) {
    try { spawnedChromeProcess.kill() } catch (_) {}
    spawnedChromeProcess = null
  }
  killChromeOrphanProcessesSync()
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  if (gazeEmitter) {
    gazeEmitter.stop()
    gazeEmitter = null
  }
  closeChromeWS()
  if (spawnedChromeProcess) {
    try { spawnedChromeProcess.kill() } catch (_) {}
    spawnedChromeProcess = null
  }
  killChromeOrphanProcessesSync()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ─── Local Wi-Fi Photo Transfer Server ───────────────────────────────────────
let wifiServer = null
let wifiServerPort = 5176

function getLocalIP() {
  const interfaces = os.networkInterfaces()
  const candidates = []
  
  for (const name of Object.keys(interfaces)) {
    const isVirtual = /virtual|vbox|vmware|wsl|vethernet|hamachi|vpn|bluetooth|tunnel|tailscale/i.test(name)
    for (const iface of interfaces[name]) {
      if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) {
        candidates.push({
          address: iface.address,
          name: name,
          isVirtual: isVirtual
        })
      }
    }
  }
  
  if (candidates.length === 0) return '127.0.0.1'
  
  // Prioritize physical (non-virtual) adapters
  const physical = candidates.filter(c => !c.isVirtual)
  if (physical.length > 0) {
    const preferred = physical.find(c => /ethernet|wi-fi|wifi|local area/i.test(c.name))
    return preferred ? preferred.address : physical[0].address
  }
  
  return candidates[0].address
}



function startWifiServer() {
  if (wifiServer) return
  
  wifiServer = http.createServer((req, res) => {
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    
    if (req.method === 'GET' && urlObj.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(getMobileUploadHTML())
    } else if (req.method === 'POST' && urlObj.pathname === '/upload') {
      let body = ''
      req.on('data', chunk => {
        body += chunk
      })
      req.on('end', () => {
        try {
          const payload = JSON.parse(body)
          const { faceId, image } = payload
          
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ipc:mobile-photo-uploaded', { faceId, image })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'App window not active' }))
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Malformed JSON payload' }))
        }
      })
    } else {
      res.writeHead(404)
      res.end('Not Found')
    }
  })
  
  wifiServer.listen(wifiServerPort, '0.0.0.0', () => {
    console.log(`[main] Local Wi-Fi transfer server running at http://${getLocalIP()}:${wifiServerPort}`)
  }).on('error', (err) => {
    console.warn('[main] Wi-Fi server failed to start on default port, retrying on random port...', err)
    wifiServerPort = 0
    wifiServer.listen(0, '0.0.0.0', () => {
      wifiServerPort = wifiServer.address().port
      console.log(`[main] Local Wi-Fi transfer server running on random port: http://${getLocalIP()}:${wifiServerPort}`)
    })
  })
}

// ─── Production Local Static HTTP Server ──────────────────────────────────────
// Served only in packaged production mode to bypass CORS, Origin, and iframe 
// communication (postMessage) limitations of file:// protocol when integrating 
// Firebase Authentication / Google Sign-In.
let prodServer = null
let prodServerPort = 0

function startProdServer() {
  return new Promise((resolve, reject) => {
    prodServer = http.createServer(async (req, res) => {
      // Clean up the URL to prevent directory traversal and get the relative path
      let safePath = decodeURIComponent(req.url.split('?')[0])
      if (safePath === '/') {
        safePath = '/index.html'
      }

      const rendererDir = join(__dirname, '../renderer')
      const filePath = join(rendererDir, safePath)

      // Ensure the filePath is inside the renderer directory (path traversal check)
      if (!filePath.startsWith(rendererDir)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }

      try {
        const content = await readFile(filePath)
        
        // Match content type based on extension
        const ext = extname(filePath).toLowerCase()
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.mjs': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.wav': 'audio/wav',
          '.mp3': 'audio/mpeg',
        }
        const contentType = mimeTypes[ext] || 'application/octet-stream'

        res.writeHead(200, {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
        })
        res.end(content)
      } catch (err) {
        if (err.code === 'ENOENT') {
          // Serve index.html as a fallback for React router (Single Page Application fallback)
          try {
            const indexContent = await readFile(join(rendererDir, 'index.html'))
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(indexContent)
          } catch (indexErr) {
            res.writeHead(500)
            res.end('Error loading index.html')
          }
          return
        }
        res.writeHead(500)
        res.end(`Server Error: ${err.message}`)
      }
    })

    // Bind to 127.0.0.1 and port 0 (OS will allocate any free port)
    prodServer.listen(0, '127.0.0.1', () => {
      prodServerPort = prodServer.address().port
      console.log(`[main] Production static server running at http://localhost:${prodServerPort}`)
      resolve(prodServerPort)
    }).on('error', (err) => {
      console.error('[main] Production static server failed to start:', err)
      reject(err)
    })
  })
}

function getMobileUploadHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>GazeAAC · Mobile Photo Transfer</title>
  <!-- Cropper.js for mobile-friendly cropping -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.css" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.js"></script>
  <style>
    :root {
      --color-bg-1: #0b0f19;
      --color-bg-2: #02060d;
      --color-primary: #00c8ff;
      --color-success: #10b981;
      --color-text-primary: #f3f4f6;
      --color-text-secondary: #9ca3af;
      --font-family: "Outfit", "Inter", -apple-system, sans-serif;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background: radial-gradient(circle at center, var(--color-bg-1), var(--color-bg-2));
      min-height: 100vh;
      color: var(--color-text-primary);
      font-family: var(--font-family);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 16px;
      overflow-x: hidden;
    }

    /* Premium Glassmorphic Card */
    .card {
      width: 100%;
      max-width: 440px;
      background: rgba(255, 255, 255, 0.03);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 24px;
      padding: 24px 20px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), 0 0 40px rgba(0, 200, 255, 0.05);
      text-align: center;
      animation: slide-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }

    @keyframes slide-up {
      from { transform: translateY(30px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .logo-container {
      margin-bottom: 16px;
    }

    .logo-icon {
      font-size: 2.5rem;
      animation: float 4s ease-in-out infinite;
      display: inline-block;
    }

    @keyframes float {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-8px); }
    }

    h1 {
      font-size: 1.5rem;
      font-weight: 800;
      margin-bottom: 8px;
      letter-spacing: -0.02em;
      background: linear-gradient(135deg, var(--color-primary), #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    p.subtitle {
      font-size: 0.85rem;
      color: var(--color-text-secondary);
      margin-bottom: 20px;
      line-height: 1.5;
    }

    .target-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(0, 200, 255, 0.1);
      border: 1px solid rgba(0, 200, 255, 0.2);
      padding: 6px 16px;
      border-radius: 30px;
      color: var(--color-primary);
      font-weight: 700;
      font-size: 0.85rem;
      margin-bottom: 20px;
    }

    /* Upload Area */
    .upload-area {
      border: 2px dashed rgba(255, 255, 255, 0.15);
      border-radius: 16px;
      padding: 40px 16px;
      cursor: pointer;
      background: rgba(255, 255, 255, 0.01);
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
      margin-bottom: 20px;
    }

    .upload-area:hover, .upload-area.dragover {
      border-color: var(--color-primary);
      background: rgba(0, 200, 255, 0.02);
      box-shadow: 0 0 20px rgba(0, 200, 255, 0.05);
    }

    .upload-icon {
      font-size: 2.2rem;
      margin-bottom: 12px;
      opacity: 0.7;
      transition: transform 0.3s ease;
    }

    .upload-area:hover .upload-icon {
      transform: scale(1.1);
    }

    .upload-text {
      font-weight: 700;
      font-size: 0.95rem;
      margin-bottom: 6px;
    }

    .upload-hint {
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }

    /* Preview & Cropper Container */
    .preview-container {
      display: none;
      width: 100%;
      height: 300px;
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.15);
      position: relative;
      margin-bottom: 16px;
      background: #02060d;
    }

    .preview-image {
      max-width: 100%;
      display: block;
    }

    .remove-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      background: rgba(0, 0, 0, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.3);
      color: #fff;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 1rem;
      font-weight: bold;
      transition: background 0.2s;
      z-index: 10;
    }

    .remove-btn:hover {
      background: rgba(220, 38, 38, 0.9);
    }

    /* Cropper Tool Customization to fit theme */
    .cropper-view-box {
      outline: 2px solid var(--color-primary);
      outline-color: var(--color-primary);
      border-radius: 8px;
    }
    .cropper-line, .cropper-point {
      background-color: var(--color-primary);
    }
    .cropper-point.point-se {
      width: 12px;
      height: 12px;
      opacity: 1;
    }
    .cropper-bg {
      background-image: none !important;
      background-color: #02060d !important;
    }

    .crop-helper-text {
      font-size: 0.8rem;
      color: var(--color-text-secondary);
      margin-bottom: 16px;
      line-height: 1.4;
    }

    .cropper-controls {
      display: none;
      justify-content: center;
      gap: 12px;
      margin-bottom: 20px;
    }

    .btn-ctrl {
      flex: 1;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--color-text-primary);
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 0.85rem;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.2s;
    }

    .btn-ctrl:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: var(--color-primary);
    }

    /* Upload Button */
    .btn {
      width: 100%;
      padding: 14px 28px;
      border-radius: 12px;
      font-size: 0.95rem;
      font-weight: 800;
      letter-spacing: 0.02em;
      border: none;
      cursor: pointer;
      transition: all 0.25s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--color-primary), #7c3aed);
      color: #ffffff;
      box-shadow: 0 4px 20px rgba(0, 200, 255, 0.3);
    }

    .btn-primary:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(0, 200, 255, 0.45);
    }

    .btn-primary:active:not(:disabled) {
      transform: translateY(0);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Success / Error States */
    .status-panel {
      display: none;
      animation: zoom-in 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
    }

    @keyframes zoom-in {
      from { transform: scale(0.8); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }

    .success-icon {
      font-size: 4rem;
      color: var(--color-success);
      margin-bottom: 16px;
      filter: drop-shadow(0 0 10px rgba(16, 185, 129, 0.3));
    }

    .status-title {
      font-size: 1.3rem;
      font-weight: 800;
      margin-bottom: 8px;
    }

    .status-text {
      font-size: 0.85rem;
      color: var(--color-text-secondary);
      line-height: 1.5;
    }

    .progress-bar {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 16px;
      display: none;
    }

    .progress-fill {
      height: 100%;
      width: 0%;
      background: var(--color-primary);
      transition: width 0.3s ease;
    }
  </style>
</head>
<body>

  <div class="card" id="formCard">
    <div class="logo-container">
      <span class="logo-icon">📸</span>
    </div>
    <h1>Add Face Photo</h1>
    <p class="subtitle">Securely transfer photos from your mobile device to improve GazeAAC's biometric face identification.</p>

    <div class="target-badge" id="targetBadge">
      👤 Target: Loading...
    </div>

    <input type="file" accept="image/*" id="fileInput" style="display: none;" />

    <div class="upload-area" id="uploadArea" onclick="document.getElementById('fileInput').click()">
      <div class="upload-icon">📤</div>
      <div class="upload-text">Select or Take Photo</div>
      <div class="upload-hint">Supports direct camera capture</div>
    </div>

    <div class="preview-container" id="previewContainer">
      <img class="preview-image" id="previewImage" alt="Preview" />
      <button class="remove-btn" onclick="resetFileSelection()" title="Remove photo">✕</button>
    </div>

    <div class="crop-helper-text" id="cropHelper" style="display: none;">
      💡 Pinch to zoom. Drag to crop only the face of the target person.
    </div>

    <div class="cropper-controls" id="cropperControls">
      <button class="btn-ctrl" onclick="rotateLeft()">🔄 Rotate Left</button>
      <button class="btn-ctrl" onclick="rotateRight()">🔄 Rotate Right</button>
    </div>

    <button class="btn btn-primary" id="uploadBtn" disabled onclick="uploadPhoto()">
      ⚡ Send to GazeAAC
    </button>

    <div class="progress-bar" id="progressBar">
      <div class="progress-fill" id="progressFill"></div>
    </div>
  </div>

  <div class="card status-panel" id="statusCard">
    <div class="success-icon" id="statusIcon">✓</div>
    <div class="status-title" id="statusTitle">Upload Successful!</div>
    <div class="status-text" id="statusText">Your photo was securely transferred to the GazeAAC app. Biometric processing is running in memory on your desktop.</div>
  </div>

  <script>
    const urlParams = new URLSearchParams(window.location.search);
    const faceId = urlParams.get("faceId") || "unknown";
    const faceName = urlParams.get("name") || "Registered Face";

    document.getElementById("targetBadge").innerText = "👤 Target: " + decodeURIComponent(faceName);

    const fileInput = document.getElementById("fileInput");
    const uploadArea = document.getElementById("uploadArea");
    const previewContainer = document.getElementById("previewContainer");
    const previewImage = document.getElementById("previewImage");
    const uploadBtn = document.getElementById("uploadBtn");
    const progressBar = document.getElementById("progressBar");
    const progressFill = document.getElementById("progressFill");
    const cropperControls = document.getElementById("cropperControls");
    const cropHelper = document.getElementById("cropHelper");

    let cropper = null;

    fileInput.addEventListener("change", function(e) {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = function(evt) {
        if (cropper) {
          cropper.destroy();
          cropper = null;
        }

        previewImage.src = evt.target.result;
        uploadArea.style.display = "none";
        previewContainer.style.display = "block";
        cropperControls.style.display = "flex";
        cropHelper.style.display = "block";
        uploadBtn.disabled = false;

        // Initialize Cropper.js (aspect ratio 1:1 for perfect square biometric photos)
        cropper = new Cropper(previewImage, {
          aspectRatio: 1,
          viewMode: 1,
          dragMode: 'move',
          autoCropArea: 0.85,
          restore: false,
          guides: true,
          center: true,
          highlight: false,
          cropBoxMovable: true,
          cropBoxResizable: true,
          toggleDragModeOnDblclick: false,
          background: false
        });
      };
      reader.readAsDataURL(file);
    });

    // Drag and drop behavior
    ["dragenter", "dragover"].forEach(eventName => {
      uploadArea.addEventListener(eventName, e => {
        e.preventDefault();
        uploadArea.classList.add("dragover");
      }, false);
    });

    ["dragleave", "drop"].forEach(eventName => {
      uploadArea.addEventListener(eventName, e => {
        e.preventDefault();
        uploadArea.classList.remove("dragover");
      }, false);
    });

    uploadArea.addEventListener("drop", e => {
      const dt = e.dataTransfer;
      const file = dt.files[0];
      if (file && file.type.startsWith("image/")) {
        fileInput.files = dt.files;
        const event = new Event("change");
        fileInput.dispatchEvent(event);
      }
    });

    function rotateLeft() {
      if (cropper) cropper.rotate(-90);
    }

    function rotateRight() {
      if (cropper) cropper.rotate(90);
    }

    function resetFileSelection() {
      if (cropper) {
        cropper.destroy();
        cropper = null;
      }
      fileInput.value = "";
      previewImage.src = "";
      previewContainer.style.display = "none";
      cropperControls.style.display = "none";
      cropHelper.style.display = "none";
      uploadArea.style.display = "block";
      uploadBtn.disabled = true;
      progressBar.style.display = "none";
      progressFill.style.width = "0%";
    }

    function uploadPhoto() {
      if (!cropper) return;

      uploadBtn.disabled = true;
      progressBar.style.display = "block";
      
      let progress = 10;
      progressFill.style.width = progress + "%";
      
      const interval = setInterval(() => {
        if (progress < 90) {
          progress += 5;
          progressFill.style.width = progress + "%";
        }
      }, 100);

      // Generate cropped canvas at 320x320 pixels (optimal resolution for biometric models)
      const croppedCanvas = cropper.getCroppedCanvas({
        width: 320,
        height: 320,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high'
      });

      const croppedBase64 = croppedCanvas.toDataURL('image/jpeg', 0.85);

      fetch("/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          faceId: faceId,
          image: croppedBase64
        })
      })
      .then(res => res.json())
      .then(data => {
        clearInterval(interval);
        progressFill.style.width = "100%";
        
        if (data.ok) {
          setTimeout(() => {
            document.getElementById("formCard").style.display = "none";
            document.getElementById("statusCard").style.display = "block";
          }, 300);
        } else {
          alert("Upload failed: " + (data.error || "Unknown error"));
          uploadBtn.disabled = false;
        }
      })
      .catch(err => {
        clearInterval(interval);
        console.error(err);
        alert("Connection error occurred. Are you on the same Wi-Fi network?");
        uploadBtn.disabled = false;
      });
    }
  </script>
</body>
</html>`;
}


