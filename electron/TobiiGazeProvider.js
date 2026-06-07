/**
 * TobiiGazeProvider — Gaze data adapter with graceful SDK fallback.
 *
 * Strategy (Python WebSocket Bridge):
 *   1. Spawn `electron/tobii_bridge.py` as a child Python process.
 *      The script uses ctypes against the installed tobii_stream_engine.dll
 *      (no pip package required — just the Tobii Experience app on Windows).
 *   2. Connect to the bridge's WebSocket server at ws://127.0.0.1:7070.
 *   3. Forward each incoming JSON gaze frame to the onData callback.
 *   4. If the bridge fails to start or the connection drops, fall back to
 *      MockGazeEmitter transparently.
 *
 * The public interface is identical to MockGazeEmitter:
 *   constructor(onData)   – onData: (GazePoint) => void
 *   start()
 *   stop()
 *   static isAvailable()  – true after a real tracker connection is confirmed
 *
 * GazePoint schema:
 *   { x: number, y: number, timestamp: number, valid: boolean }
 *   x, y – normalized [0, 1], origin top-left
 */

// MockGazeEmitter import removed — mouse hover mode is the designated fallback
import { app }             from 'electron'
import { spawn, execSync } from 'child_process'
import { existsSync }      from 'fs'
import { join, resolve }   from 'path'
import { fileURLToPath }   from 'url'
import WebSocket           from 'ws'

// __thisDir resolves to the COMPILED file's directory (out/main/ in dev/prod).
// We navigate two levels up to reach the project root, then into electron/.
// This is stable regardless of how electron-vite sets up app.getAppPath().
const __thisDir = fileURLToPath(new URL('.', import.meta.url))
const isDev = !app.isPackaged

// Standalone production EXE path and production/development bridge python path
const _bridgeExePath = isDev
  ? resolve(__thisDir, '..', '..', 'bin', 'tobii_bridge.exe')
  : join(process.resourcesPath, 'bin', 'tobii_bridge.exe')

const _bridgePyPath = isDev
  ? resolve(__thisDir, '..', '..', 'electron', 'tobii_bridge.py')
  : join(process.resourcesPath, 'electron', 'tobii_bridge.py')

// ─── Configuration ────────────────────────────────────────────────────────────

const WS_URL          = 'ws://127.0.0.1:7070'
const RECONNECT_MAX   = 3       // max silent reconnect attempts on drop

// Python executable: prefer system python
// The bridge now works with any Python ≥ 3.7 (only uses ctypes + websockets)
const PYTHON_EXE = (() => {
  return process.platform === 'win32' ? 'py' : 'python3'
})()

const PYTHON_ARGS_PREFIX = []

// ─── SDK availability flag ────────────────────────────────────────────────────

let _sdkAvailable = false

// ─── Provider class ───────────────────────────────────────────────────────────

export class TobiiGazeProvider {
  /**
   * @param {(gazePoint: { x: number, y: number, timestamp: number, valid: boolean }) => void} onData
   * @param {(status: 'tobii' | 'mouse') => void} [onStatusChange]
   */
  constructor(onData, onStatusChange) {
    this._onData  = onData
    this._onStatusChange = onStatusChange
    this._running = false
    this._impl    = null
  }

  /** @returns {boolean} Whether the real Tobii hardware is streaming. */
  static isAvailable() {
    return _sdkAvailable
  }

  async start() {
    if (this._running) return
    this._running = true

    // Try the real Python bridge first
    const bridge = new TobiiBridgeImpl(this._onData, this._onStatusChange)
    const ok = await bridge.start()

    if (ok) {
      _sdkAvailable = true
      this._impl = bridge
      console.log('[TobiiGazeProvider] Started using real Tobii hardware (Python bridge)')
    } else {
      bridge.stop()
      _sdkAvailable = false
      this._impl = null  // No mock — renderer will use mouse hover mode instead
      console.log('[TobiiGazeProvider] Bridge unavailable — staying idle (mouse hover mode will take over)')
    }
  }

  stop() {
    if (!this._running) return
    this._running = false
    if (this._impl) {
      this._impl.stop()
      this._impl = null
    }
    _sdkAvailable = false
    console.log('[TobiiGazeProvider] Stopped')
  }
}

// ─── Real Tobii Bridge implementation ────────────────────────────────────────

class TobiiBridgeImpl {
  constructor(onData, onStatusChange) {
    this._onData      = onData
    this._onStatusChange = onStatusChange
    this._proc        = null   // child_process
    this._ws          = null   // WebSocket client
    this._reconnects  = 0
    this._stopping    = false
  }

  /**
   * Spawn tobii_bridge.py and wait for the WebSocket to be ready.
   * @returns {Promise<boolean>} true if connected, false on failure.
   */
  async start() {
    const bridgePath = _bridgePyPath

    // ── Kill any stale bridge from a previous dev session ────────────────────
    // On Windows, taskkill terminates any python.exe holding port 7070.
    // Errors are silently ignored (process may not exist).
    if (process.platform === 'win32') {
      try {
        // Kill by process name first (very reliable for packaged exe)
        try {
          execSync('taskkill /F /IM tobii_bridge.exe', { stdio: 'ignore', windowsHide: true })
        } catch (_) {}

        // Kill any process holding port 7070 (covers dev/python mode)
        // CRITICAL: We only target the LISTENING process to avoid matching Electron client sockets and self-killing!
        try {
          execSync('for /f "tokens=5" %a in (\'netstat -ano ^| findstr :7070 ^| findstr LISTENING\') do taskkill /F /PID %a', { stdio: 'ignore', windowsHide: true })
        } catch (_) {}

        await _sleep(500)  // give OS time to release the port
      } catch (_) {}
    }

    // ── Determine executable and arguments ───────────────────────────────────
    let exeExists = false
    if (_bridgeExePath) {
      try {
        exeExists = existsSync(_bridgeExePath)
      } catch (_) {}
    }

    let spawnExe = PYTHON_EXE
    let spawnArgs = [...PYTHON_ARGS_PREFIX, bridgePath]

    if (exeExists) {
      spawnExe = _bridgeExePath
      spawnArgs = []
      console.log(`[TobiiBridgeImpl] Standalone production EXE detected. Spawning: ${spawnExe}`)
    } else {
      console.log(`[TobiiBridgeImpl] Spawning via Python environment: ${spawnExe} ${spawnArgs.join(' ')}`)
    }

    // ── Spawn the bridge process ─────────────────────────────────────────────
    try {
      this._proc = spawn(spawnExe, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this._proc.on('error', (err) => {
        console.warn('[TobiiBridgeImpl] Failed to spawn bridge process asynchronously:', err.message)
        _sdkAvailable = false
        if (this._onStatusChange) {
          this._onStatusChange('mouse')
        }
      })
    } catch (err) {
      console.warn('[TobiiBridgeImpl] Failed to spawn bridge process synchronously:', err.message)
      return false
    }

    if (this._proc.stdout) {
      this._proc.stdout.on('data', (d) => {
        const lines = d.toString().trim().split('\n')
        lines.forEach(l => console.log('[tobii_bridge]', l.trim()))
      })
    }
    if (this._proc.stderr) {
      this._proc.stderr.on('data', (d) => {
        const lines = d.toString().trim().split('\n')
        lines.forEach(l => console.warn('[tobii_bridge:err]', l.trim()))
      })
    }
    this._proc.on('exit', (code) => {
      console.log(`[TobiiBridgeImpl] Python process exited (code ${code})`)
      if (!this._stopping) {
        // Unexpected exit — revert to mock by marking unavailable
        _sdkAvailable = false
      }
    })

    // ── Connect WebSocket client with retry ──────────────────────────────────
    // In production, PyInstaller standalone EXE can take several seconds to unpack
    // and start up. We poll repeatedly for up to 20 seconds.
    const connected = await this._connectWithRetry()
    return connected
  }

  async _connectWithRetry() {
    const maxAttempts = 40
    const retryInterval = 500
    console.log(`[TobiiBridgeImpl] Connecting to WebSocket bridge at ${WS_URL} (max 20s)...`)

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this._stopping) break
      const ok = await this._connectOnce()
      if (ok) {
        return true
      }
      if (attempt < maxAttempts) {
        await _sleep(retryInterval)
      }
    }
    console.warn('[TobiiBridgeImpl] Failed to connect to WebSocket bridge after all attempts')
    return false
  }

  async _connectOnce() {
    return new Promise((resolve) => {
      if (this._stopping) { resolve(false); return }

      const ws = new WebSocket(WS_URL)
      
      const cleanUp = () => {
        ws.removeAllListeners('open')
        ws.removeAllListeners('error')
        ws.removeAllListeners('close')
        ws.removeAllListeners('message')
      }

      ws.on('open', () => {
        // Clean up temporary startup listeners
        ws.removeAllListeners('open')
        ws.removeAllListeners('error')

        console.log('[TobiiBridgeImpl] WebSocket connected to bridge successfully')
        this._ws = ws
        this._reconnects = 0

        // Attach persistent runtime listeners
        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw)
            if (msg.status !== undefined) {
              const isConnected = msg.status === 'connected'
              _sdkAvailable = isConnected
              if (this._onStatusChange) {
                this._onStatusChange(isConnected ? 'tobii' : 'mouse')
              }
              return
            }
            this._onData({
              x:         Number(msg.x),
              y:         Number(msg.y),
              timestamp: Number(msg.timestamp),
              valid:     Boolean(msg.valid),
            })
          } catch (_) { /* malformed frame — ignore */ }
        })

        ws.on('error', (err) => {
          console.warn('[TobiiBridgeImpl] WebSocket error:', err.message)
        })

        ws.on('close', () => {
          if (!this._stopping && this._reconnects < RECONNECT_MAX) {
            this._reconnects++
            console.log(`[TobiiBridgeImpl] WS closed unexpectedly — reconnect attempt ${this._reconnects}`)
            setTimeout(() => {
              if (!this._stopping) {
                this._connectWithRetry()
              }
            }, 1000)
          }
        })

        resolve(true)
      })

      ws.on('error', () => {
        ws.terminate()
        cleanUp()
        resolve(false)
      })
    })
  }

  stop() {
    this._stopping = true

    if (this._ws) {
      try { this._ws.close() } catch (_) {}
      this._ws = null
    }

    if (this._proc) {
      try { this._proc.kill('SIGTERM') } catch (_) {}
      // Give it a moment then force-kill
      setTimeout(() => {
        try { this._proc.kill('SIGKILL') } catch (_) {}
      }, 2000)
      this._proc = null
    }
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
