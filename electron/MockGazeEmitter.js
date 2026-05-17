/**
 * MockGazeEmitter – Development-mode synthetic gaze data generator.
 *
 * Emits GazePoint objects at ~60 Hz using sinusoidal motion to simulate
 * realistic eye-tracking trajectories across a 1280×800 viewport.
 *
 * Replace this class with the real Tobii SDK adapter in Milestone 2.
 *
 * GazePoint schema:
 *   { x: number, y: number, timestamp: number, valid: boolean }
 *
 *   x, y  – normalized coordinates in [0, 1] (origin = top-left)
 *   timestamp – performance.now()-equivalent millisecond counter
 *   valid – whether the tracker has a confident lock on the eye
 */
export class MockGazeEmitter {
  /**
   * @param {(gazePoint: { x: number, y: number, timestamp: number, valid: boolean }) => void} onData
   */
  constructor(onData) {
    this._onData = onData
    this._intervalId = null
    this._startTime = null
    this._lostLockProbability = 0.005 // 0.5% chance of dropout per frame
  }

  start() {
    if (this._intervalId !== null) return
    this._startTime = Date.now()

    this._intervalId = setInterval(() => {
      const elapsed = (Date.now() - this._startTime) / 1000 // seconds

      // Lissajous figure – realistic saccade-like motion
      const x = 0.5 + 0.38 * Math.sin(2.3 * elapsed + 0.4)
      const y = 0.5 + 0.32 * Math.sin(1.7 * elapsed)

      // Simulate brief tracking loss (dropout)
      const valid = Math.random() > this._lostLockProbability

      this._onData({
        x: parseFloat(x.toFixed(4)),
        y: parseFloat(y.toFixed(4)),
        timestamp: Date.now(),
        valid
      })
    }, 1000 / 60) // ~16.67 ms ≈ 60 Hz
  }

  stop() {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId)
      this._intervalId = null
    }
  }
}
