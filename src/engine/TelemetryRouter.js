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
 */
export class TelemetryRouter {
  /**
   * @param {{\n   *   filterOptions?:            ConstructorParameters<typeof KalmanFilter>[0],
   *   dwellMs?:                  number,
   *   decayHalfLifeMs?:          number,   ← M3: decay half-life during dropout (ms)
   *   maxDropoutMs?:             number,   ← M3: hard-reset ceiling (ms)
   *   postActivationCooldownMs?: number,   ← cooldown: gaze must leave cell for this long before re-dwell
   *   onDwell:                   (cellId: string) => void,
   *   onGaze?:                   (event: GazeEvent) => void,
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
    onDwell,
    onGaze
  } = {}) {
    this._filter = new KalmanFilter(filterOptions)
    this._dwellTimer = new DwellTimer({ dwellMs, onDwell: (cellId) => this._onDwellInternal(cellId) })
    this._decayHalfLifeMs = decayHalfLifeMs
    this._maxDropoutMs = maxDropoutMs
    this._postActivationCooldownMs = postActivationCooldownMs
    this._onDwellExternal = onDwell
    this._onGaze = onGaze ?? null

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

    // Flag set by _onDwellInternal during the same synchronous tick() call.
    // Lets _handleRaw emit dwellProgress=1 on the exact activation frame,
    // even if handleActivate resets the timer before getProgress() is called.
    this._dwellFiredThisTick = false

    // Stream subscription handle
    this._running = false

    // Board-active guard — when false, hit-testing and dwell are frozen.
    // The gaze cursor continues to update so the overlay still renders.
    this._paused = false
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
    this._onDwellExternal?.(cellId)
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
   */
  start() {
    if (this._running) return
    this._running = true

    if (typeof window === 'undefined' || !window.gazeAPI) {
      console.warn('[TelemetryRouter] window.gazeAPI not available – running in headless mode')
      return
    }

    window.gazeAPI.startStream((gazePoint) => this._handleRaw(gazePoint))
    console.log('[TelemetryRouter] Started – listening on gazeAPI stream')
  }

  /**
   * Stop the gaze stream and clean up.
   */
  stop() {
    if (!this._running) return
    this._running = false

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
    console.log('[TelemetryRouter] Resumed – dwell active')
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

  // ─── Private: pipeline stages ───────────────────────────────────────────────

  /**
   * @private
   * Entry point for each raw GazePoint from the IPC stream.
   * @param {{ x: number, y: number, timestamp: number, valid: boolean }} gazePoint
   */
  _handleRaw(gazePoint) {
    const { x, y, timestamp, valid } = gazePoint

    // When paused, still filter for cursor rendering but skip hit-test + dwell.
    if (this._paused) {
      if (valid) {
        const filtered = this._filter.filter(x, y)
        this._lastFilteredPos = filtered
        if (this._onGaze) {
          this._onGaze({ raw: { x, y }, filtered, cellId: null, timestamp, dwellProgress: 0 })
        }
      }
      return
    }

    if (!valid) {
      this._handleDropout(timestamp)
      return
    }

    // Valid frame — clear dropout state
    this._dropoutStartTime = null
    this._lastValidTimestamp = timestamp

    // Stage 1: Kalman smoothing
    const filtered = this._filter.filter(x, y)
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

    // Stage 3: Dwell accumulation
    // Reset the per-tick fire flag before calling tick() so _onDwellInternal
    // can set it if the threshold is crossed on this exact frame.
    this._dwellFiredThisTick = false
    this._dwellTimer.tick(cellId, timestamp)

    // If _onDwellInternal fired during tick(), emit 1.0 so the ring visually
    // completes for this frame — even though handleActivate has already called
    // _dwellTimer.reset(), which would make getProgress() return 0.
    const dwellProgress = this._dwellFiredThisTick
      ? 1
      : this._dwellTimer.getProgress(cellId, timestamp)

    this._lastDwellProgress = dwellProgress

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
