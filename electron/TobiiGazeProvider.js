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

import { MockGazeEmitter } from './MockGazeEmitter.js'
import { spawn }           from 'child_process'
import { join, resolve }   from 'path'
import { fileURLToPath }   from 'url'
import WebSocket           from 'ws'

// __thisDir resolves to the COMPILED file's directory (out/main/ in dev/prod).
// We navigate two levels up to reach the project root, then into electron/.
// This is stable regardless of how electron-vite sets up app.getAppPath().
const __thisDir = fileURLToPath(new URL('.', import.meta.url))
const _bridgePyPath = resolve(__thisDir, '..', '..', 'electron', 'tobii_bridge.py')

// ─── Configuration ────────────────────────────────────────────────────────────

const WS_URL          = 'ws://127.0.0.1:7070'
const CONNECT_TIMEOUT = 5_000   // ms to wait for bridge WS to become ready
const STARTUP_DELAY   = 2_000   // ms to give Python process time to bind port
const RECONNECT_MAX   = 3       // max silent reconnect attempts on drop

// Python executable: prefer 3.9 (tobii DLL works), fall back to system python
// The bridge now works with any Python ≥ 3.7 (only uses ctypes + websockets)
const PYTHON_EXE = (() => {
  // Try python launcher 3.9, 3.10, then fallback to bare 'python'
  return process.platform === 'win32' ? 'py' : 'python3'
})()

const PYTHON_ARGS_PREFIX = process.platform === 'win32' ? ['-3.9'] : []

// ─── SDK availability flag ────────────────────────────────────────────────────

let _sdkAvailable = false

// ─── Provider class ───────────────────────────────────────────────────────────

export class TobiiGazeProvider {
  /**
   * @param {(gazePoint: { x: number, y: number, timestamp: number, valid: boolean }) => void} onData
   */
  constructor(onData) {
    this._onData  = onData
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
    const bridge = new TobiiBridgeImpl(this._onData)
    const ok = await bridge.start()

    if (ok) {
      _sdkAvailable = true
      this._impl = bridge
      console.log('[TobiiGazeProvider] Started using real Tobii hardware (Python bridge)')
    } else {
      _sdkAvailable = false
      this._impl = new MockGazeEmitter(this._onData)
      this._impl.start()
      console.log('[TobiiGazeProvider] Started using MockGazeEmitter (bridge unavailable)')
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
  constructor(onData) {
    this._onData      = onData
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
        spawn('cmd', ['/c', 'for /f "tokens=5" %a in (\'netstat -ano ^| findstr :7070\') do taskkill /F /PID %a'], {
          stdio: 'ignore', windowsHide: true, shell: false
        })
        await _sleep(400)  // give OS time to release the port
      } catch (_) {}
    }

    // ── Spawn the Python process ─────────────────────────────────────────────
    const args = [...PYTHON_ARGS_PREFIX, bridgePath]
    console.log(`[TobiiBridgeImpl] Spawning: ${PYTHON_EXE} ${args.join(' ')}`)

    try {
      this._proc = spawn(PYTHON_EXE, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      console.warn('[TobiiBridgeImpl] Failed to spawn Python process:', err.message)
      return false
    }

    this._proc.stdout.on('data', (d) => {
      const lines = d.toString().trim().split('\n')
      lines.forEach(l => console.log('[tobii_bridge]', l.trim()))
    })
    this._proc.stderr.on('data', (d) => {
      const lines = d.toString().trim().split('\n')
      lines.forEach(l => console.warn('[tobii_bridge:err]', l.trim()))
    })
    this._proc.on('exit', (code) => {
      console.log(`[TobiiBridgeImpl] Python process exited (code ${code})`)
      if (!this._stopping) {
        // Unexpected exit — revert to mock by marking unavailable
        _sdkAvailable = false
      }
    })

    // ── Wait for the bridge to bind its port ─────────────────────────────────
    await _sleep(STARTUP_DELAY)

    // ── Connect WebSocket client ──────────────────────────────────────────────
    const connected = await this._connect()
    return connected
  }

  async _connect() {
    return new Promise((resolve) => {
      if (this._stopping) { resolve(false); return }

      const ws = new WebSocket(WS_URL)
      const timer = setTimeout(() => {
        ws.terminate()
        console.warn('[TobiiBridgeImpl] WebSocket connection timed out')
        resolve(false)
      }, CONNECT_TIMEOUT)

      ws.on('open', () => {
        clearTimeout(timer)
        console.log('[TobiiBridgeImpl] WebSocket connected to bridge')
        this._ws = ws
        this._reconnects = 0
        resolve(true)
      })

      ws.on('message', (raw) => {
        try {
          const gp = JSON.parse(raw)
          // gp: { x, y, timestamp, valid }
          this._onData({
            x:         Number(gp.x),
            y:         Number(gp.y),
            timestamp: Number(gp.timestamp),
            valid:     Boolean(gp.valid),
          })
        } catch (_) { /* malformed frame — ignore */ }
      })

      ws.on('error', (err) => {
        clearTimeout(timer)
        console.warn('[TobiiBridgeImpl] WebSocket error:', err.message)
        resolve(false)
      })

      ws.on('close', () => {
        if (!this._stopping && this._reconnects < RECONNECT_MAX) {
          this._reconnects++
          console.log(`[TobiiBridgeImpl] WS closed — reconnect attempt ${this._reconnects}`)
          setTimeout(() => this._connect(), 1000)
        }
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
