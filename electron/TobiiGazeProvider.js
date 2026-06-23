/**
 * TobiiGazeProvider — Gaze data adapter with graceful SDK fallback.
 *
 * Strategy (Python WebSocket Bridge):
 *   1. First, try to connect to an EXISTING bridge on ws://127.0.0.1:7070.
 *      If a bridge from a previous session is still alive (within IDLE_TIMEOUT)
 *      we reuse it immediately — no kill, no respawn, no TIME_WAIT delay.
 *   2. If no existing bridge is reachable, kill any stale process, wait for
 *      the port to clear, then spawn bin/tobii_bridge.exe (pre-built PyInstaller
 *      EXE — no Python installation required).
 *   3. Connect via WebSocket and forward gaze frames to the onData callback.
 *   4. If the bridge fails entirely, fall back to mouse hover mode.
 *
 * The public interface:
 *   constructor(onData, onStatusChange)
 *   start()  → async
 *   stop()
 *   static isAvailable()  – true when real tracker is streaming
 *
 * GazePoint schema:
 *   { x: number, y: number, timestamp: number, valid: boolean }
 *   x, y – normalized [0, 1], origin top-left
 */

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

// Standalone production EXE path (dev: bin/, prod: resourcesPath/bin/)
const _bridgeExePath = isDev
  ? resolve(__thisDir, '..', '..', 'bin', 'tobii_bridge.exe')
  : join(process.resourcesPath, 'bin', 'tobii_bridge.exe')

// Python bridge path (fallback when EXE is not present)
const _bridgePyPath = isDev
  ? resolve(__thisDir, '..', '..', 'electron', 'tobii_bridge.py')
  : join(process.resourcesPath, 'electron', 'tobii_bridge.py')

// ─── Configuration ────────────────────────────────────────────────────────────

const WS_URL        = 'ws://127.0.0.1:7070'
const RECONNECT_MAX = 3  // max silent reconnect attempts on drop

// ─── SDK availability flag ────────────────────────────────────────────────────

let _sdkAvailable = false

// ─── Provider class ───────────────────────────────────────────────────────────

export class TobiiGazeProvider {
  /**
   * @param {(gazePoint: { x: number, y: number, timestamp: number, valid: boolean }) => void} onData
   * @param {(status: 'tobii' | 'mouse') => void} [onStatusChange]
   */
  constructor(onData, onStatusChange) {
    this._onData         = onData
    this._onStatusChange = onStatusChange
    this._running        = false
    this._impl           = null
  }

  /** @returns {boolean} Whether the real Tobii hardware is streaming. */
  static isAvailable() {
    return _sdkAvailable
  }

  async start() {
    if (this._running) return
    this._running = true

    const bridge = new TobiiBridgeImpl(this._onData, this._onStatusChange)
    const ok = await bridge.start()

    if (ok) {
      _sdkAvailable = true
      this._impl = bridge
      console.log('[TobiiGazeProvider] Started using real Tobii hardware (Python bridge)')
    } else {
      bridge.stop()
      _sdkAvailable = false
      this._impl = null
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

// ─── Real Tobii Bridge implementation ─────────────────────────────────────────

class TobiiBridgeImpl {
  constructor(onData, onStatusChange) {
    this._onData         = onData
    this._onStatusChange = onStatusChange
    this._proc           = null   // child_process handle (null when reusing existing)
    this._ws             = null   // active WebSocket client
    this._reconnects     = 0
    this._stopping       = false
  }

  /**
   * Start the bridge.
   *
   * Strategy:
   *   1. Try connecting to an already-running bridge (fast path — reuse).
   *   2. If that fails, kill the stale process, wait for the port, spawn fresh.
   *   3. Poll for the new bridge to come up (up to 30 s).
   *
   * @returns {Promise<boolean>} true if connected, false on failure.
   */
  async start() {
    // ── Step 1: try to reuse an existing bridge ──────────────────────────────
    // If a bridge from the previous Electron session is still alive within its
    // IDLE_TIMEOUT window we can connect directly — avoiding the kill → TIME_WAIT
    // → spawn → unpack cycle that delays startup by several seconds.
    console.log('[TobiiBridgeImpl] Checking for an existing bridge on ' + WS_URL + '...')
    const reused = await this._connectOnce()
    if (reused) {
      console.log('[TobiiBridgeImpl] Reused existing bridge process — instant gaze startup.')
      return true
    }

    // ── Step 2: kill any stale / failed bridge process ───────────────────────
    if (process.platform === 'win32') {
      try {
        // Kill by name first (covers the packaged EXE case)
        try {
          execSync('taskkill /F /IM tobii_bridge.exe', { stdio: 'ignore', windowsHide: true })
        } catch (_) {}

        // Also kill whatever PID is LISTENING on port 7070 (Python dev mode)
        try {
          execSync(
            'for /f "tokens=5" %a in (\'netstat -ano ^| findstr :7070 ^| findstr LISTENING\') do taskkill /F /PID %a',
            { stdio: 'ignore', windowsHide: true }
          )
        } catch (_) {}

        // Wait for the OS to release the port (TIME_WAIT usually clears fast
        // once the LISTENING side is gone, but give it a generous buffer).
        console.log('[TobiiBridgeImpl] Waiting for port 7070 to clear...')
        await _sleep(2000)
      } catch (_) {}
    }

    // ── Step 3: spawn a fresh bridge ─────────────────────────────────────────
    let exeExists = false
    try { exeExists = existsSync(_bridgeExePath) } catch (_) {}

    let spawnExe, spawnArgs
    if (exeExists) {
      spawnExe  = _bridgeExePath
      spawnArgs = []
      console.log('[TobiiBridgeImpl] Spawning standalone EXE: ' + spawnExe)
    } else {
      // Fallback: try Python interpreter
      const pyExe = process.platform === 'win32' ? 'py' : 'python3'
      spawnExe  = pyExe
      spawnArgs = [_bridgePyPath]
      console.log('[TobiiBridgeImpl] EXE not found. Trying Python: ' + spawnExe + ' ' + _bridgePyPath)
    }

    try {
      this._proc = spawn(spawnExe, spawnArgs, {
        stdio:       ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached:    false,
      })

      this._proc.on('error', (err) => {
        console.warn('[TobiiBridgeImpl] Spawn error:', err.message)
        _sdkAvailable = false
        if (this._onStatusChange) this._onStatusChange('mouse')
      })

      if (this._proc.stdout) {
        this._proc.stdout.on('data', (d) => {
          d.toString().trim().split('\n').forEach(l => console.log('[tobii_bridge]', l.trim()))
        })
      }
      if (this._proc.stderr) {
        this._proc.stderr.on('data', (d) => {
          d.toString().trim().split('\n').forEach(l => console.warn('[tobii_bridge:err]', l.trim()))
        })
      }
      this._proc.on('exit', (code) => {
        console.log('[TobiiBridgeImpl] Bridge process exited (code ' + code + ')')
        if (!this._stopping) _sdkAvailable = false
      })
    } catch (err) {
      console.warn('[TobiiBridgeImpl] Failed to spawn bridge:', err.message)
      return false
    }

    // ── Step 4: wait for the new bridge's WebSocket server ───────────────────
    const connected = await this._connectWithRetry()
    return connected
  }

  // ─── WebSocket connection logic ─────────────────────────────────────────────

  /**
   * Poll ws://127.0.0.1:7070 every 500 ms for up to 30 seconds.
   */
  async _connectWithRetry() {
    const maxAttempts   = 60   // 30 s total — handles PyInstaller cold-start
    const retryInterval = 500
    console.log('[TobiiBridgeImpl] Connecting to ' + WS_URL + ' (up to 30 s)...')

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this._stopping) break
      const ok = await this._connectOnce()
      if (ok) return true
      if (attempt < maxAttempts) await _sleep(retryInterval)
    }

    console.warn('[TobiiBridgeImpl] Could not connect to bridge after 30 s')
    return false
  }

  /**
   * Single non-blocking connection attempt.
   * Resolves true on 'open', false on 'error'.
   */
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
        ws.removeAllListeners('open')
        ws.removeAllListeners('error')

        console.log('[TobiiBridgeImpl] WebSocket connected to bridge')
        this._ws = ws
        this._reconnects = 0

        // Persistent runtime listeners
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
            console.log('[TobiiBridgeImpl] WS closed — reconnect attempt ' + this._reconnects)
            setTimeout(() => {
              if (!this._stopping) this._connectWithRetry()
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

    // We do NOT kill the bridge process here to avoid TIME_WAIT port conflicts on restart.
    // Since we closed the WebSocket client, the bridge will detect that there are no
    // connected clients and exit automatically after its 8-second idle timeout.
    // We destroy stdout/stderr streams and unref the process so Electron's event loop
    // is not held open, allowing the app to close immediately and cleanly.
    if (this._proc) {
      try {
        if (this._proc.stdout) this._proc.stdout.destroy()
        if (this._proc.stderr) this._proc.stderr.destroy()
        this._proc.unref()
      } catch (_) {}
      this._proc = null
    }
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
