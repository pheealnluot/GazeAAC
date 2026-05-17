/**
 * DwellTimer – Tracks cumulative on-target gaze dwell time.
 *
 * The dwell model works as follows:
 *  1. Each call to `tick(cellId, timestamp)` accumulates time while the gaze
 *     remains on the same `cellId`.
 *  2. When a different `cellId` is ticked, the accumulator resets.
 *  3. When `dwellMs` is reached, the `onDwell` callback fires and the timer
 *     auto-resets to prevent repeated activation during sustained fixation.
 *
 * Milestone 3 — Exponential Decay Dropout Engine:
 *   Instead of a hard reset on blink/dropout, TelemetryRouter calls
 *   `applyDecay(retainedProgress)` to shift the entry baseline forward, so
 *   the accumulated progress is partially preserved. This prevents false
 *   misfires while keeping dwell intent alive through involuntary blinks.
 *
 * Clinical note: Typical AAC dwell windows range from 500 ms (fast users) to
 * 2000 ms (users with motor uncertainty). Default is 800 ms.
 */
export class DwellTimer {
  /**
   * @param {{
   *   dwellMs?: number,
   *   onDwell: (cellId: string) => void
   * }} options
   */
  constructor({ dwellMs = 800, onDwell }) {
    if (typeof onDwell !== 'function') {
      throw new Error('DwellTimer: onDwell callback is required')
    }

    this.dwellMs = dwellMs
    this._onDwell = onDwell

    this._currentCellId = null
    this._entryTime = null
    this._fired = false // prevents repeated fires during sustained dwell
  }

  /**
   * Process the latest gaze position.
   *
   * @param {string|null} cellId   – ID of the cell currently under gaze, or
   *                                 null if gaze is not over any active cell.
   * @param {number}      timestamp – Current time in ms (e.g., Date.now()).
   */
  tick(cellId, timestamp) {
    if (cellId === null) {
      // Gaze is not on any cell — handled externally by TelemetryRouter cushion
      return
    }

    if (cellId !== this._currentCellId) {
      // Gaze moved to a new cell — reset accumulator
      this._currentCellId = cellId
      this._entryTime = timestamp
      this._fired = false
      return
    }

    if (this._fired) return // Already activated — wait for explicit reset

    const elapsed = timestamp - this._entryTime
    if (elapsed >= this.dwellMs) {
      this._fired = true
      this._onDwell(cellId)
    }
  }

  /**
   * Returns dwell progress as a value in [0, 1] for the current cell.
   * Useful for driving the dwell-ring animation in GazeButton.
   *
   * @param {string|null} cellId
   * @param {number} timestamp
   * @returns {number} Progress in [0, 1]
   */
  getProgress(cellId, timestamp) {
    if (cellId !== this._currentCellId || this._entryTime === null) return 0
    if (this._fired) return 1
    return Math.min((timestamp - this._entryTime) / this.dwellMs, 1)
  }

  /**
   * Fully reset dwell state (e.g., after a tracking dropout or activation).
   */
  reset() {
    this._currentCellId = null
    this._entryTime = null
    this._fired = false
  }

  /**
   * Update the dwell threshold at runtime (e.g., from settings panel).
   * @param {number} ms
   */
  setDwellMs(ms) {
    this.dwellMs = ms
    this.reset()
  }

  /**
   * Partially preserve dwell progress during a tracking dropout (e.g., blink).
   *
   * Instead of calling `reset()` (which zeroes progress), TelemetryRouter
   * calls this with a decayed progress value. The `_entryTime` baseline is
   * shifted forward so that the *apparent* elapsed time equals:
   *   retainedProgress × dwellMs
   *
   * This means if gaze returns quickly, the user only needs to make up the
   * *remaining* dwell time rather than starting over from zero.
   *
   * @param {number} retainedProgress – Progress to preserve, clamped to [0, 1].
   * @param {number} now              – Current timestamp (ms).
   */
  applyDecay(retainedProgress, now) {
    if (this._currentCellId === null || this._fired) return
    const clamped = Math.max(0, Math.min(1, retainedProgress))
    // Shift entry time so elapsed = retainedProgress × dwellMs
    this._entryTime = now - clamped * this.dwellMs
  }

  /**
   * The cell ID currently being dwelled on, or null.
   * Exposed so TelemetryRouter can inspect the active cell during dropouts.
   * @type {string|null}
   */
  get currentCellId() {
    return this._currentCellId
  }
}
