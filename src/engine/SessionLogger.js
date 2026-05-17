/**
 * SessionLogger — Milestone 5
 *
 * Tracks in-session activity metrics and flushes a SessionRecord to the
 * persistent store (via gazeAPI.sessions.log) when the session ends.
 *
 * Metrics tracked per session:
 *   wordActivations  – total cell dwell activations (non-utility)
 *   abandonedDwells  – dwell attempts that were interrupted before completion
 *   stageUsed        – the highest stage number seen during the session
 *   topWords         – up to 5 most-activated cell labels
 *
 * Usage:
 *   const logger = new SessionLogger()
 *   logger.recordActivation('WANT')     // on each cell fire
 *   logger.recordAbandoned()            // on each dwell interrupt
 *   logger.setStage(3)                  // when stage changes
 *   await logger.flush()                // persist the session record
 *
 * SessionRecord shape (stored in electron-store):
 * {
 *   date:             string   – ISO date string 'YYYY-MM-DD'
 *   wordActivations:  number
 *   abandonedDwells:  number
 *   dwellAccuracyPct: number   – wordActivations / (wordActivations + abandonedDwells) * 100
 *   stageUsed:        number
 *   topWords:         string[] – up to 5 most frequent labels
 *   durationSec:      number   – session duration in seconds
 *   savedAt:          number   – timestamp added by main process
 * }
 */
export class SessionLogger {
  constructor() {
    this._startTime = Date.now()
    this._wordActivations = 0
    this._abandonedDwells = 0
    this._maxStage = 1
    /** @type {Map<string, number>} */
    this._wordFreq = new Map()
    this._flushed = false

    // Auto-flush on page/window unload
    this._unloadHandler = () => { this.flush() }
    window.addEventListener('beforeunload', this._unloadHandler)
  }

  /**
   * Record a successful word activation.
   * @param {string} label – The cell label (e.g. 'WANT', 'EAT')
   */
  recordActivation(label) {
    this._wordActivations++
    if (label) {
      this._wordFreq.set(label, (this._wordFreq.get(label) ?? 0) + 1)
    }
  }

  /**
   * Record a dwell that was interrupted before completion (gaze moved away).
   */
  recordAbandoned() {
    this._abandonedDwells++
  }

  /**
   * Update the highest stage number seen during this session.
   * @param {number} stage
   */
  setStage(stage) {
    if (stage > this._maxStage) this._maxStage = stage
  }

  /**
   * Compute the top-N most frequently activated word labels.
   * @param {number} n
   * @returns {string[]}
   */
  topWords(n = 5) {
    return [...this._wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([label]) => label)
  }

  /**
   * Build the SessionRecord object without persisting it.
   * @returns {object}
   */
  buildRecord() {
    const total = this._wordActivations + this._abandonedDwells
    const dwellAccuracyPct = total > 0
      ? Math.round((this._wordActivations / total) * 100)
      : 100

    return {
      date:             new Date().toISOString().slice(0, 10),
      wordActivations:  this._wordActivations,
      abandonedDwells:  this._abandonedDwells,
      dwellAccuracyPct,
      stageUsed:        this._maxStage,
      topWords:         this.topWords(5),
      durationSec:      Math.round((Date.now() - this._startTime) / 1000)
    }
  }

  /**
   * Persist the session record to electron-store via the IPC bridge.
   * Safe to call multiple times — only flushes once.
   * @returns {Promise<void>}
   */
  async flush() {
    if (this._flushed) return
    if (this._wordActivations === 0) return // skip empty sessions

    this._flushed = true
    window.removeEventListener('beforeunload', this._unloadHandler)

    const record = this.buildRecord()
    try {
      await window.gazeAPI?.sessions?.log(record)
      console.log('[SessionLogger] Session record flushed:', record)
    } catch (err) {
      console.warn('[SessionLogger] Failed to flush session record:', err)
    }
  }

  /** Tear down event listeners without flushing (e.g. during HMR). */
  destroy() {
    window.removeEventListener('beforeunload', this._unloadHandler)
  }
}
