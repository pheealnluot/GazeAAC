/**
 * KalmanFilter – 2-D position smoother for raw eye-tracker coordinates.
 *
 * Implements a scalar (decoupled X/Y) Kalman filter to reduce jitter in the
 * raw gaze stream while preserving fast, intentional saccades.
 *
 * Tuning guidance:
 *   processNoise (Q)       – How much the "true" gaze position is expected to
 *                            move between samples. Higher = more responsive,
 *                            more jitter allowed through.
 *   measurementNoise (R)   – How noisy the sensor readings are. Higher = heavier
 *                            smoothing, slower response to fast movements.
 *   saccadeThreshold       – Euclidean distance (normalized [0,1]) beyond which
 *                            the filter is seeded to the new measurement instead
 *                            of tracking through intermediate states. This
 *                            eliminates lag when the eye jumps between cells.
 *                            Typical cell width on a 12-column grid ≈ 0.083.
 *                            A threshold of ~0.10 catches inter-cell saccades
 *                            while ignoring within-cell jitter.
 *
 * Typical starting values for a Tobii Eye Tracker 5 at 60 Hz:
 *   processNoise:     0.012   (raised from 0.008 for faster cell-crossing)
 *   measurementNoise: 0.07    (lowered from 0.1  for better saccade tracking)
 *   saccadeThreshold: 0.10
 *
 * Reference: Welch & Bishop, "An Introduction to the Kalman Filter", 2006.
 */
export class KalmanFilter {
  /**
   * @param {{
   *   processNoise?:     number,
   *   measurementNoise?: number,
   *   saccadeThreshold?: number
   * }} options
   */
  constructor({
    processNoise     = 0.012,
    measurementNoise = 0.07,
    saccadeThreshold = 0.10
  } = {}) {
    this.Q = processNoise
    this.R = measurementNoise
    this.saccadeThreshold = saccadeThreshold

    // State for X axis
    this._xEstimate = 0.5
    this._xErrorCovariance = 1

    // State for Y axis
    this._yEstimate = 0.5
    this._yErrorCovariance = 1
  }

  /**
   * Process a new raw gaze measurement and return the filtered position.
   *
   * @param {number} rawX – Raw normalized X coordinate [0, 1]
   * @param {number} rawY – Raw normalized Y coordinate [0, 1]
   * @returns {{ x: number, y: number }} Filtered coordinates [0, 1]
   */
  filter(rawX, rawY) {
    // Saccade detection: if the eye jumps farther than the threshold in one
    // frame, snap the filter to the new position immediately rather than
    // slowly tracking through all the cells in between (which causes lag).
    const dx = rawX - this._xEstimate
    const dy = rawY - this._yEstimate
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist > this.saccadeThreshold) {
      this.reset(rawX, rawY)
    }

    return {
      x: this._filterAxis(rawX, '_xEstimate', '_xErrorCovariance'),
      y: this._filterAxis(rawY, '_yEstimate', '_yErrorCovariance')
    }
  }

  /**
   * @private
   * One-dimensional Kalman step for a single axis.
   */
  _filterAxis(measurement, estimateKey, covarianceKey) {
    // Prediction step
    const predictedCovariance = this[covarianceKey] + this.Q

    // Update step
    const kalmanGain = predictedCovariance / (predictedCovariance + this.R)
    const updatedEstimate = this[estimateKey] + kalmanGain * (measurement - this[estimateKey])
    const updatedCovariance = (1 - kalmanGain) * predictedCovariance

    this[estimateKey] = updatedEstimate
    this[covarianceKey] = updatedCovariance

    return updatedEstimate
  }

  /**
   * Reset filter state (e.g., after a long tracking dropout).
   * @param {number} x – Seed position X [0, 1]
   * @param {number} y – Seed position Y [0, 1]
   */
  reset(x = 0.5, y = 0.5) {
    this._xEstimate = x
    this._yEstimate = y
    this._xErrorCovariance = 1
    this._yErrorCovariance = 1
  }
}
