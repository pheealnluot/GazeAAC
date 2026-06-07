import { KalmanFilter } from './KalmanFilter.js'
import { DwellTimer } from './DwellTimer.js'

/**
 * TelemetryRouter – Central gaze processing pipeline.
 *
 * Data flow:
 *   window.gazeAPI (IPC)
 *     └─▶ KalmanFilter  (smooth jitter)
 *           └─▶ HitTest  (map filtered coords → cellId)
 *                 └─▶ DwellTimer  (accumulate on-target time)
 *                       └─▶ onDwell callback  (activate cell)
 *
 * Additionally, the router emits normalized GazeEvents on a simple
 * listener bus so components can render a real-time gaze cursor.
 *
 * Milestone 3 — Exponential Decay Dropout Engine:
 *   When the tracker reports `valid = false` (blink / dropout), the router
 *   applies exponential decay to the accumulated dwell progress rather than
 *   resetting it to zero. The decay follows:
 *
 *     retainedProgress = lastProgress × e^(-ln2 / decayHalfLifeMs × elapsed)
 *
 *   A hard reset only fires after `maxDropoutMs` of continuous invalidity.
 *   This allows users to blink without losing their dwell intent.
 *
 * Watchdog — Stream Stuck / Not Captured Recovery:
 *   If no gaze frame arrives within WATCHDOG_TIMEOUT_MS, the router
 *   automatically restarts the IPC stream. The back-off interval doubles
 *   with each consecutive failure, capped at MAX_RETRY_INTERVAL_MS.
 */

// ── Watchdog configuration ────────────────────────────────────────────────────
/** ms of silence before declaring the stream stuck and triggering a restart. */
const WATCHDOG_TIMEOUT_MS     = 5_000
/** Initial wait before the first retry attempt. */
const INITIAL_RETRY_DELAY_MS  = 2_000
/** Exponential back-off ceiling. */
const MAX_RETRY_INTERVAL_MS   = 30_000
/** Maximum number of consecutive restart attempts (0 = unlimited). */
const MAX_RETRY_ATTEMPTS      = 10
export class TelemetryRouter {
  /**
   * @param {{\n   *   filterOptions?:            ConstructorParameters<typeof KalmanFilter>[0],
   *   dwellMs?:                  number,
   *   decayHalfLifeMs?:          number,   ← M3: decay half-life during dropout (ms)
   *   maxDropoutMs?:             number,   ← M3: hard-reset ceiling (ms)
   *   postActivationCooldownMs?: number,   ← cooldown: gaze must leave cell for this long before re-dwell
   *   onDwell:                   (cellId: string) => void,
   *   onGaze?:                   (event: GazeEvent) => void,
   *   onRawGaze?:                (gazePoint: { x, y, valid, timestamp }) => void,
   * }} options
   *
   * GazeEvent shape:
   *   { x: number, y: number, filtered: { x, y }, cellId: string|null,
   *     timestamp: number, dwellProgress: number }
   */
  constructor({
    filterOptions = {},
    dwellMs = 800,
    decayHalfLifeMs = 200,
    maxDropoutMs = 500,
    postActivationCooldownMs = 10,
    isContextualGateLocked = null,
    isMouseMode = null,
    onDwell,
    onGaze,
    onRawGaze,
    onPresenceChange
  } = {}) {
    this._filter = new KalmanFilter(filterOptions)
    this._dwellTimer = new DwellTimer({ dwellMs, onDwell: (cellId) => this._onDwellInternal(cellId) })
    this._decayHalfLifeMs = decayHalfLifeMs
    this._maxDropoutMs = maxDropoutMs
    this._postActivationCooldownMs = postActivationCooldownMs
    this._isContextualGateLocked = isContextualGateLocked
    this._isMouseMode = isMouseMode
    this._onDwellExternal = onDwell
    this._onGaze = onGaze ?? null
    this._onRawGaze = onRawGaze ?? null
    this._onPresenceChange = onPresenceChange ?? null

    // Gaze presence & stability tracking state
    this._dwellPoints = []
    this._recentPresence = []
    this._isPresent = false
    this._lastPresenceEmitTime = 0

    // Post-activation cooldown state
    // After a cell fires, gaze must leave it for _postActivationCooldownMs before
    // the same cell can accumulate dwell again.
    this._lastActivatedCellId  = null  // cell that most recently fired
    this._lastActivatedTime    = null  // wall-clock ms when it fired
    this._leftActivatedCellAt  = null  // timestamp when gaze first moved off the activated cell

    // HitTest registry: set externally via registerGrid()
    this._cells = []           // Array<{ id, x0, y0, x1, y1 }> in normalized coords

    // Dropout / decay state
    this._dropoutStartTime = null   // timestamp when validity first went false
    this._lastValidTimestamp = null
    this._lastFilteredPos = null
    this._lastDwellProgress = 0     // progress snapshot at dropout onset

    // Off-cell decay state
    this._offCellStartTime = null

    // Flag set by _onDwellInternal during the same synchronous tick() call.
    // Lets _handleRaw emit dwellProgress=1 on the exact activation frame,
    // even if handleActivate resets the timer before getProgress() is called.
    this._dwellFiredThisTick = false

    // Stream subscription handle
    this._running = false

    // Board-active guard — when false, hit-testing and dwell are frozen.
    // The gaze cursor continues to update so the overlay still renders.
    this._paused = false

    // ── Watchdog state ──────────────────────────────────────────────────────
    this._watchdogTimer      = null   // setInterval handle
    this._lastFrameAt        = null   // Date.now() of the most recent received frame
    this._retryAttempts      = 0      // consecutive restart attempts
    this._retryDelay         = INITIAL_RETRY_DELAY_MS  // current back-off delay
    this._retryTimeout       = null   // setTimeout handle for a pending restart
  }

  // ─── Internal dwell callback (wraps external onDwell with cooldown book-keeping) ─
  _onDwellInternal(cellId) {
    // Mark that dwell fired during this tick BEFORE calling the external handler.
    // handleActivate will call _dwellTimer.reset() synchronously, so
    // getProgress() would return 0 if we checked after tick() returns.
    // _handleRaw reads this flag to emit dwellProgress=1 on the activation frame.
    this._dwellFiredThisTick = true
    this._lastActivatedCellId = cellId
    this._lastActivatedTime   = performance.now()
    this._leftActivatedCellAt = null   // gaze is still ON the cell at fire time

    // Calculate dwell stability metrics (standard deviation of gaze coordinates during dwell)
    let stdDev = 0
    const pts = this._dwellPoints
    if (pts.length > 1) {
      const meanX = pts.reduce((sum, p) => sum + p.x, 0) / pts.length
      const meanY = pts.reduce((sum, p) => sum + p.y, 0) / pts.length
      const varX = pts.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0) / pts.length
      const varY = pts.reduce((sum, p) => sum + (p.y - meanY) ** 2, 0) / pts.length
      stdDev = Math.sqrt(varX + varY)
    }

    this._onDwellExternal?.(cellId, { stdDev })
    this._dwellPoints = [] // clear after firing
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Register the interactive grid cells for hit-testing.
   * Each cell is described in normalized viewport coordinates [0, 1].
   *
   * @param {Array<{ id: string, x0: number, y0: number, x1: number, y1: number }>} cells
   */
  registerGrid(cells) {
    this._cells = cells
  }

  /**
   * Start processing gaze data from window.gazeAPI.
   * Installs a watchdog that detects a stuck / absent stream and restarts it.
   */
  start() {
    if (this._running) return
    this._running = true

    if (typeof window === 'undefined' || !window.gazeAPI) {
      console.warn('[TelemetryRouter] window.gazeAPI not available – running in headless mode')
      return
    }

    this._lastFrameAt = Date.now()
    window.gazeAPI.startStream((gazePoint) => {
      // Stamp the wall-clock arrival time of every frame so the watchdog knows
      // the stream is alive.  The frame itself is then processed normally.
      this._lastFrameAt = Date.now()
      this._handleRaw(gazePoint)
    })
    this._startWatchdog()
    console.log('[TelemetryRouter] Started – listening on gazeAPI stream (watchdog armed)')
  }

  /**
   * Stop the gaze stream and clean up.
   */
  stop() {
    if (!this._running) return
    this._running = false

    this._stopWatchdog()

    if (typeof window !== 'undefined' && window.gazeAPI) {
      window.gazeAPI.stopStream()
    }

    this._dwellTimer.reset()
    this._paused = false
    console.log('[TelemetryRouter] Stopped')
  }

  /**
   * Update the dwell threshold at runtime.
   * @param {number} ms
   */
  setDwellMs(ms) {
    this._dwellTimer.setDwellMs(ms)
  }

  /**
   * Update the decay half-life at runtime.
   * @param {number} ms
   */
  setDecayHalfLifeMs(ms) {
    this._decayHalfLifeMs = ms
  }

  /**
   * Update the maximum dropout window at runtime.
   * @param {number} ms
   */
  setMaxDropoutMs(ms) {
    this._maxDropoutMs = ms
  }

  /**
   * Update the post-activation cooldown window at runtime.
   * @param {number} ms
   */
  setPostActivationCooldownMs(ms) {
    this._postActivationCooldownMs = ms
  }

  /**
   * Pause dwell accumulation and hit-testing while keeping the gaze cursor live.
   * Call this whenever a modal / settings page covers the board.
   */
  pause() {
    if (this._paused) return
    this._paused = true
    this._dwellTimer.reset()   // discard any in-flight dwell so no phantom activation
    this._dropoutStartTime = null
    this._offCellStartTime = null
    this._lastDwellProgress = 0
    this._dwellPoints = []
    console.log('[TelemetryRouter] Paused – dwell frozen')
  }

  /**
   * Resume normal hit-testing and dwell accumulation.
   * Call this when the board is visible and interactive again.
   */
  resume() {
    if (!this._paused) return
    this._paused = false
    this._dwellTimer.reset()   // fresh slate so no accumulated phantom dwell
    this._dropoutStartTime = null
    this._offCellStartTime = null
    this._lastDwellProgress = 0
    this._dwellPoints = []
    this._lastFrameAt = Date.now()  // Reset watchdog clock for a fresh grace period
    console.log('[TelemetryRouter] Resumed – dwell active')
  }

  /**
   * Immediately reconnect the gaze stream, resetting the watchdog back-off
   * state so the retry fires without any delay.  Call this from the UI when
   * the user explicitly requests a stream refresh (e.g. eye tracker was
   * unplugged and re-plugged, or the stream failed to start on launch).
   *
   * Safe to call at any time — no-ops gracefully if the router is stopped or
   * window.gazeAPI is unavailable.
   */
  reconnect() {
    if (!this._running) return
    if (typeof window === 'undefined' || !window.gazeAPI) return

    console.log('[TelemetryRouter] Manual reconnect requested — restarting gaze stream')

    // Reset back-off counters so the restart fires immediately (delay = 0).
    this._retryAttempts = 0
    this._retryDelay    = 0

    // Cancel any in-flight watchdog retry before we call _restartStream,
    // which itself calls _stopWatchdog() → safe to call twice.
    this._stopWatchdog()
    this._restartStream()
  }

  /**
   * Update Kalman filter parameters at runtime.
   * Patches the live filter instance; no restart required.
   *
   * @param {{ processNoise?: number, measurementNoise?: number, saccadeThreshold?: number }} opts
   */
  setFilterOptions({ processNoise, measurementNoise, saccadeThreshold } = {}) {
    if (processNoise     !== undefined) this._filter.Q                = processNoise
    if (measurementNoise !== undefined) this._filter.R                = measurementNoise
    if (saccadeThreshold !== undefined) this._filter.saccadeThreshold = saccadeThreshold
  }

  // ─── Private: watchdog ──────────────────────────────────────────────────────

  /**
   * @private
   * Start the periodic watchdog that checks whether gaze frames are arriving.
   */
  _startWatchdog() {
    this._stopWatchdog()  // safety: clear any previous interval
    this._lastFrameAt = Date.now()  // grace period starts now

    this._watchdogTimer = setInterval(() => {
      if (!this._running) return
      if (this._paused) return  // Skip watchdog checks while paused (e.g. when calibration or settings is active)

      const silenceMs = Date.now() - (this._lastFrameAt ?? 0)
      if (silenceMs < WATCHDOG_TIMEOUT_MS) return  // stream is healthy

      // In mouse hover mode the IPC stream carries no frames by design —
      // the App feeds synthetic frames via _handleRaw() directly from
      // the mousemove poll.  Don't treat this as a stuck stream.
      if (this._isMouseMode?.() === true) return

      // Stream appears stuck – attempt a restart
      if (MAX_RETRY_ATTEMPTS > 0 && this._retryAttempts >= MAX_RETRY_ATTEMPTS) {
        console.warn(
          `[TelemetryRouter] Watchdog: reached max retry attempts (${MAX_RETRY_ATTEMPTS}). Giving up.`
        )
        this._stopWatchdog()
        return
      }

      this._retryAttempts++
      console.warn(
        `[TelemetryRouter] Watchdog: no gaze frame for ${Math.round(silenceMs / 1000)} s ` +
        `— restarting stream (attempt ${this._retryAttempts}, ` +
        `next retry in ${this._retryDelay / 1000} s)`
      )

      // Stop watchdog temporarily to prevent overlapping restarts
      this._stopWatchdog()
      this._restartStream()
    }, WATCHDOG_TIMEOUT_MS)
  }

  /**
   * @private
   * Clear the watchdog interval and any pending retry timeout.
   */
  _stopWatchdog() {
    if (this._watchdogTimer !== null) {
      clearInterval(this._watchdogTimer)
      this._watchdogTimer = null
    }
    if (this._retryTimeout !== null) {
      clearTimeout(this._retryTimeout)
      this._retryTimeout = null
    }
  }

  /**
   * @private
   * Tear down and restart the IPC stream after _retryDelay ms.
   */
  _restartStream() {
    if (!this._running) return
    if (typeof window === 'undefined' || !window.gazeAPI) return

    // Stop the existing IPC stream
    try { window.gazeAPI.stopStream() } catch (_) {}

    // Schedule the reconnect after the back-off delay
    this._retryTimeout = setTimeout(() => {
      this._retryTimeout = null
      if (!this._running) return  // router was stopped while we were waiting

      console.log(
        `[TelemetryRouter] Watchdog: reconnecting gaze stream (attempt ${this._retryAttempts})…`
      )

      this._lastFrameAt = Date.now()  // reset frame clock before restart
      window.gazeAPI.startStream((gazePoint) => {
        // On the first frame after a retry, reset back-off state
        if (this._retryAttempts > 0) {
          console.log('[TelemetryRouter] Watchdog: gaze stream restored after retry')
          this._retryAttempts = 0
          this._retryDelay    = INITIAL_RETRY_DELAY_MS
        }
        this._lastFrameAt = Date.now()
        this._handleRaw(gazePoint)
      })

      // Re-arm the watchdog — if frames don't arrive within the timeout the
      // next restart will be scheduled with an increased back-off delay.
      // Guard against _retryDelay = 0 (set by reconnect()) so the watchdog
      // still backs off correctly after a manual restart.
      const nextDelay = this._retryDelay === 0 ? INITIAL_RETRY_DELAY_MS : this._retryDelay
      this._retryDelay = Math.min(nextDelay * 2, MAX_RETRY_INTERVAL_MS)
      this._startWatchdog()
    }, this._retryDelay)
  }

  // ─── Private: pipeline stages ───────────────────────────────────────────────

  /**
   * @private
   * Entry point for each raw GazePoint from the IPC stream.
   * @param {{ x: number, y: number, timestamp: number, valid: boolean }} gazePoint
   */
  _handleRaw(gazePoint) {
    // Fire raw callback before any processing — used for gaze-away detection
    // in MovieTime (checking whether gaze is on the YouTube player).
    this._onRawGaze?.(gazePoint)

    const { x, y, timestamp, valid } = gazePoint
    const isMouse = this._isMouseMode?.() === true

    // Track presence in sliding window (only for real Tobii mode)
    if (!isMouse) {
      const now = Date.now()
      this._recentPresence.push({ timestamp: now, valid })
      while (this._recentPresence.length > 0 && now - this._recentPresence[0].timestamp > 3000) {
        this._recentPresence.shift()
      }

      // Calculate presence rate
      const validCount = this._recentPresence.filter(p => p.valid).length
      const presenceRate = this._recentPresence.length > 0 ? (validCount / this._recentPresence.length) : 0

      // Determine instant presence (with a 200ms blink cushion)
      let isPresent = valid
      if (valid) {
        this._lastValidTimestamp = timestamp
      } else if (this._lastValidTimestamp !== null && timestamp - this._lastValidTimestamp < 200) {
        isPresent = true
      }

      if (this._isPresent !== isPresent) {
        this._isPresent = isPresent
        this._onPresenceChange?.(this._isPresent, presenceRate)
      } else if (now - this._lastPresenceEmitTime > 1000) {
        this._lastPresenceEmitTime = now
        this._onPresenceChange?.(this._isPresent, presenceRate)
      }
    } else {
      // In mouse mode, presence is always 100% and present
      if (!this._isPresent) {
        this._isPresent = true
        this._onPresenceChange?.(true, 1.0)
      }
    }

    // When paused, still filter for cursor rendering but skip hit-test + dwell.
    if (this._paused) {
      if (valid) {
        const filtered = isMouse ? { x, y } : this._filter.filter(x, y)
        this._lastFilteredPos = filtered
        if (this._onGaze) {
          this._onGaze({ raw: { x, y }, filtered, cellId: null, timestamp, dwellProgress: 0 })
        }
      }
      return
    }

    if (!valid) {
      if (isMouse) {
        this._dwellTimer.reset()
        this._dropoutStartTime = null
        this._lastDwellProgress = 0
        if (this._onGaze) {
          this._onGaze({
            raw: null,
            filtered: null,
            cellId: null,
            timestamp,
            dwellProgress: 0
          })
        }
      } else {
        this._handleDropout(timestamp)
      }
      return
    }

    // Valid frame — clear dropout state
    this._dropoutStartTime = null
    this._lastValidTimestamp = timestamp

    // Stage 1: Kalman smoothing (bypass in mouse mode for zero-lag precision)
    const filtered = isMouse ? { x, y } : this._filter.filter(x, y)
    this._lastFilteredPos = filtered

    // Stage 2: Hit-test – find which cell the filtered gaze falls within
    const rawCellId = this._hitTest(filtered.x, filtered.y)

    // Stage 2b: Post-activation cooldown gate.
    // After a cell fires, gaze must move off that cell for at least
    // _postActivationCooldownMs before the same cell can accumulate dwell again.
    let cellId = rawCellId
    if (this._lastActivatedCellId !== null) {
      if (rawCellId !== this._lastActivatedCellId) {
        // Gaze has moved OFF the activated cell
        if (this._leftActivatedCellAt === null) {
          // Record the first moment gaze left the cell
          this._leftActivatedCellAt = timestamp
        }
        const awayMs = timestamp - this._leftActivatedCellAt
        if (awayMs >= this._postActivationCooldownMs) {
          // Cooldown satisfied — clear the lock
          this._lastActivatedCellId = null
          this._leftActivatedCellAt = null
        }
        // cellId is a different cell (or null) — allow normal dwell on it
      } else {
        // Gaze is still ON the activated cell — suppress dwell accumulation
        this._leftActivatedCellAt = null   // reset "away" timer; gaze came back
        cellId = null
      }
    }

    // Stage 2c: Contextual Response gate check
    // If the cell is a contextual response tile and the gate is active and locked,
    // we suppress dwell progress accumulation (treat it as null/off-target).
    // We also reset the active dwell timer if we are currently dwelling on a response tile.
    if (this._isContextualGateLocked?.()) {
      if (cellId && cellId.startsWith('ctx-r')) {
        cellId = null
      }
      if (this._dwellTimer.currentCellId && this._dwellTimer.currentCellId.startsWith('ctx-r')) {
        this._dwellTimer.reset()
        this._offCellStartTime = null
        this._lastDwellProgress = 0
      }
    }

    // Clear dwell points if the target cell changed
    if (cellId !== this._dwellTimer.currentCellId) {
      this._dwellPoints = [];
    }

    if (cellId !== null && filtered) {
      this._dwellPoints.push({ x: filtered.x, y: filtered.y });
    }

    // Stage 3: Dwell accumulation
    // Reset the per-tick fire flag before calling tick() so _onDwellInternal
    // can set it if the threshold is crossed on this exact frame.
    this._dwellFiredThisTick = false

    if (cellId === null) {
      // Off-cell decay logic
      if (this._dwellTimer.currentCellId !== null) {
        if (isMouse) {
          // In mouse mode, instantly reset progress when leaving cell
          this._dwellTimer.reset()
          this._offCellStartTime = null
          this._lastDwellProgress = 0
        } else {
          if (this._offCellStartTime === null) {
            this._offCellStartTime = timestamp
          }
          const offCellElapsed = timestamp - this._offCellStartTime
          if (offCellElapsed >= this._maxDropoutMs) {
            this._dwellTimer.reset()
            this._offCellStartTime = null
            this._lastDwellProgress = 0
          } else {
            const decayFactor = Math.exp((-Math.LN2 / this._decayHalfLifeMs) * offCellElapsed)
            const retainedProgress = this._lastDwellProgress * decayFactor
            this._dwellTimer.applyDecay(retainedProgress, timestamp)
          }
        }
      }
    } else {
      // Back on-cell — clear off-cell tracking
      this._offCellStartTime = null
      this._dwellTimer.tick(cellId, timestamp)
    }

    // If _onDwellInternal fired during tick(), emit 1.0 so the ring visually
    // completes for this frame.
    let dwellProgress = 0
    if (this._dwellFiredThisTick) {
      dwellProgress = 1
    } else if (cellId === null) {
      if (this._dwellTimer.currentCellId !== null && this._offCellStartTime !== null && !isMouse) {
        const offCellElapsed = timestamp - this._offCellStartTime
        const decayFactor = Math.exp((-Math.LN2 / this._decayHalfLifeMs) * offCellElapsed)
        dwellProgress = this._lastDwellProgress * decayFactor
      } else {
        dwellProgress = 0
      }
    } else {
      dwellProgress = this._dwellTimer.getProgress(cellId, timestamp)
    }

    if (cellId !== null) {
      this._lastDwellProgress = dwellProgress
    } else if (this._dwellTimer.currentCellId === null) {
      this._lastDwellProgress = 0
    }

    // Stage 4: Emit GazeEvent to listeners (e.g., cursor overlay)
    if (this._onGaze) {
      this._onGaze({
        raw: { x, y },
        filtered,
        cellId: rawCellId,   // always report raw hit for cursor/highlight rendering
        timestamp,
        dwellProgress
      })
    }
  }

  /**
   * @private
   * Handle an invalid (dropout / blink) frame using exponential decay.
   * Instead of resetting dwell progress to zero immediately, we decay it
   * smoothly over `maxDropoutMs` using a configurable half-life.
   *
   * @param {number} timestamp – Current time in ms.
   */
  _handleDropout(timestamp) {
    this._offCellStartTime = null

    // First invalid frame — record onset
    if (this._dropoutStartTime === null) {
      this._dropoutStartTime = timestamp
    }

    const dropoutElapsed = timestamp - this._dropoutStartTime

    if (dropoutElapsed >= this._maxDropoutMs) {
      // Exceeded the hard ceiling — fully reset
      this._dwellTimer.reset()
      this._dropoutStartTime = null
      this._lastDwellProgress = 0
      this._dwellPoints = []

      // Emit a null-gaze event so the cursor disappears
      if (this._onGaze && this._lastFilteredPos) {
        this._onGaze({
          raw: null,
          filtered: null,
          cellId: null,
          timestamp,
          dwellProgress: 0
        })
      }
      return
    }

    // Within the decay window — apply exponential decay to retained progress
    // Formula: retained = lastProgress × e^(-ln2 / halfLife × elapsed)
    const decayFactor = Math.exp(
      (-Math.LN2 / this._decayHalfLifeMs) * dropoutElapsed
    )
    const retainedProgress = this._lastDwellProgress * decayFactor

    // Apply decayed progress to the timer (shifts _entryTime baseline)
    this._dwellTimer.applyDecay(retainedProgress, timestamp)

    // Emit a gaze event with decayed progress so the feedback overlay animates smoothly
    if (this._onGaze && this._lastFilteredPos) {
      this._onGaze({
        raw: null,
        filtered: this._lastFilteredPos, // hold last position during blink
        cellId: this._dwellTimer.currentCellId,
        timestamp,
        dwellProgress: retainedProgress
      })
    }
  }

  /**
   * @private
   * Map normalized (fx, fy) coordinates to a registered cell ID.
   * Returns null if no cell matches.
   *
   * @param {number} fx – Filtered X [0, 1]
   * @param {number} fy – Filtered Y [0, 1]
   * @returns {string|null}
   */
  _hitTest(fx, fy) {
    for (const cell of this._cells) {
      if (fx >= cell.x0 && fx <= cell.x1 && fy >= cell.y0 && fy <= cell.y1) {
        return cell.id
      }
    }
    return null
  }
}
