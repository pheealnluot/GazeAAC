/**
 * GazeCalibrationEngine.js
 *
 * Pure JavaScript calibration correction engine for an eye-gaze AAC application.
 *
 * This engine computes a 4-parameter correction transform (offsetX, offsetY, scaleX, scaleY)
 * that is applied on top of the Tobii hardware calibration to reduce residual gaze error.
 *
 * The correction formula is:
 *   corrected_x = (raw_x - offsetX) * scaleX
 *   corrected_y = (raw_y - offsetY) * scaleY
 *
 * Two calibration modes are supported:
 *
 * 1. **Explicit Calibration** — A batch of N sample pairs (observed, target) collected from
 *    a structured 5-point calibration exercise. Per-axis simple linear regression is used to
 *    solve for scale and intercept: `target = scale * observed + intercept`. The correction
 *    parameters are then derived as `offset = -intercept / scale`.
 *
 * 2. **Implicit Calibration** — Individual samples contributed by dwell activations during
 *    normal usage. The screen is divided into 4 spatial quadrants, each maintaining a running
 *    exponential moving average (alpha = 0.15) of the gaze error vector. Outlier samples
 *    (error > 0.15 normalized distance) are rejected. A minimum of 5 total samples across
 *    at least 2 distinct quadrants is required before any correction is applied. Per-quadrant
 *    offsets are blended into a global correction weighted by sample count, and spatial spread
 *    of quadrant offsets informs scale estimation.
 *
 * Quality is tracked via a circular buffer of the most recent 20 sample errors. The quality
 * score maps mean error to a 0–1 range (0.08 normalized distance → 0, 0 → 1). Quality
 * levels are: 'good' (>0.7), 'fair' (0.4–0.7), 'poor' (<0.4), or 'learning' (<5 samples).
 *
 * The engine is fully serializable via toJSON()/fromJSON() for persistence across sessions.
 *
 * No DOM, React, or IPC dependencies — pure math.
 */

/**
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ observed: Point, target: Point }} CalibrationSample
 * @typedef {{ offsetX: number, offsetY: number, scaleX: number, scaleY: number }} CorrectionTransform
 * @typedef {{ errorAvgX: number, errorAvgY: number, count: number }} QuadrantData
 */

/** Maximum number of recent errors kept for quality scoring */
const QUALITY_BUFFER_SIZE = 20;

/** Exponential moving average alpha for implicit calibration */
const IMPLICIT_ALPHA = 0.15;

/** Maximum error magnitude (normalized) before a sample is rejected as an outlier */
const OUTLIER_THRESHOLD = 0.15;

/** Minimum total samples required before implicit correction is applied */
const MIN_IMPLICIT_SAMPLES = 5;

/** Minimum distinct quadrants required before implicit correction is applied */
const MIN_IMPLICIT_QUADRANTS = 2;

/** Error distance at which quality reaches 0 */
const QUALITY_ZERO_DISTANCE = 0.08;

/** Quality level thresholds */
const QUALITY_GOOD_THRESHOLD = 0.7;
const QUALITY_FAIR_THRESHOLD = 0.4;

/** Minimum sample count before quality level can be anything other than 'learning' */
const QUALITY_MIN_SAMPLES = 5;

/** Small epsilon to guard against division by zero */
const EPSILON = 1e-12;

export class GazeCalibrationEngine {
  constructor() {
    /** @type {CorrectionTransform} */
    this._correction = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

    /** @type {CorrectionTransform} Explicit baseline calibration to track drift */
    this._explicitCorrection = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

    /** @type {number} Total number of qualifying samples received */
    this._sampleCount = 0;

    /**
     * Per-quadrant running statistics for implicit calibration.
     * Index: 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right
     * @type {QuadrantData[]}
     */
    this._quadrants = [
      { errorAvgX: 0, errorAvgY: 0, count: 0 },
      { errorAvgX: 0, errorAvgY: 0, count: 0 },
      { errorAvgX: 0, errorAvgY: 0, count: 0 },
      { errorAvgX: 0, errorAvgY: 0, count: 0 },
    ];

    /**
     * Circular buffer of recent sample errors (Euclidean distance, normalized coords).
     * @type {number[]}
     */
    this._recentErrors = [];

    /** @type {number} Write index for the circular error buffer */
    this._errorIndex = 0;

    /** @type {boolean} Whether explicit calibration has been applied */
    this._hasExplicit = false;
  }

  // ---------------------------------------------------------------------------
  // Explicit Calibration
  // ---------------------------------------------------------------------------

  /**
   * Compute correction from a batch of calibration sample pairs.
   *
   * Uses per-axis simple linear regression: `target = scale * observed + intercept`.
   * The resulting correction transform is applied as:
   *   `corrected = (raw - offset) * scale`
   * where `offset = -intercept / scale`.
   *
   * @param {CalibrationSample[]} samples - Array of { observed: {x,y}, target: {x,y} }
   */
  computeExplicitCorrection(samples) {
    if (!Array.isArray(samples) || samples.length < 2) {
      return;
    }

    // Filter out any samples with non-finite values
    const valid = samples.filter(
      (s) =>
        s &&
        s.observed &&
        s.target &&
        isFinite(s.observed.x) &&
        isFinite(s.observed.y) &&
        isFinite(s.target.x) &&
        isFinite(s.target.y)
    );

    if (valid.length < 2) {
      return;
    }

    const regX = GazeCalibrationEngine._linearRegression(
      valid.map((s) => s.observed.x),
      valid.map((s) => s.target.x)
    );

    const regY = GazeCalibrationEngine._linearRegression(
      valid.map((s) => s.observed.y),
      valid.map((s) => s.target.y)
    );

    // target = scale * observed + intercept
    // corrected = scale * raw + intercept
    // corrected = (raw - offset) * scale  =>  offset = -intercept / scale
    const scaleX = GazeCalibrationEngine._safeScale(regX.slope);
    const scaleY = GazeCalibrationEngine._safeScale(regY.slope);
    const offsetX = -regX.intercept / scaleX;
    const offsetY = -regY.intercept / scaleY;

    this._correction = {
      offsetX: isFinite(offsetX) ? offsetX : 0,
      offsetY: isFinite(offsetY) ? offsetY : 0,
      scaleX,
      scaleY,
    };

    this._explicitCorrection = { ...this._correction };

    this._hasExplicit = true;
    this._sampleCount = valid.length;

    // Populate quality buffer with residual errors from the calibration set
    this._recentErrors = [];
    this._errorIndex = 0;
    for (const s of valid) {
      const corrected = this.apply(s.observed.x, s.observed.y);
      const dx = corrected.x - s.target.x;
      const dy = corrected.y - s.target.y;
      const err = Math.sqrt(dx * dx + dy * dy);
      this._pushError(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Implicit Calibration
  // ---------------------------------------------------------------------------

  /**
   * Add a single implicit sample from a dwell activation and update the running correction.
   *
   * The sample is assigned to a spatial quadrant based on the target position. An exponential
   * moving average tracks per-quadrant error. Outlier samples are rejected. Once enough data
   * is collected across enough quadrants, the global correction is recomputed.
   *
   * @param {{ x: number, y: number }} observed - Where the user was actually looking (normalized 0–1)
   * @param {{ x: number, y: number }} target   - Where the activation actually was (normalized 0–1)
   */
  addImplicitSample(observed, target) {
    if (
      !observed ||
      !target ||
      !isFinite(observed.x) ||
      !isFinite(observed.y) ||
      !isFinite(target.x) ||
      !isFinite(target.y)
    ) {
      return;
    }

    const errorX = observed.x - target.x;
    const errorY = observed.y - target.y;
    const errorMag = Math.sqrt(errorX * errorX + errorY * errorY);

    // Outlier rejection
    if (errorMag > OUTLIER_THRESHOLD) {
      return;
    }

    // Determine quadrant (0 = TL, 1 = TR, 2 = BL, 3 = BR)
    const qi = GazeCalibrationEngine._quadrantIndex(target.x, target.y);
    const q = this._quadrants[qi];

    // Exponential moving average update
    if (q.count === 0) {
      q.errorAvgX = errorX;
      q.errorAvgY = errorY;
    } else {
      q.errorAvgX = IMPLICIT_ALPHA * errorX + (1 - IMPLICIT_ALPHA) * q.errorAvgX;
      q.errorAvgY = IMPLICIT_ALPHA * errorY + (1 - IMPLICIT_ALPHA) * q.errorAvgY;
    }
    q.count++;
    this._sampleCount++;

    // Track quality
    this._pushError(errorMag);

    // Check minimum gate
    const distinctQuadrants = this._quadrants.filter((qd) => qd.count > 0).length;
    const totalSamples = this._quadrants.reduce((sum, qd) => sum + qd.count, 0);

    if (totalSamples < MIN_IMPLICIT_SAMPLES || distinctQuadrants < MIN_IMPLICIT_QUADRANTS) {
      return;
    }

    // Recompute global correction from quadrant data
    this._recomputeImplicitCorrection();
  }

  // ---------------------------------------------------------------------------
  // Correction Transform
  // ---------------------------------------------------------------------------

  /**
   * Returns the current correction transform, or null if no calibration data is available.
   * @returns {CorrectionTransform | null}
   */
  getCorrection() {
    if (this._sampleCount === 0) {
      return null;
    }
    return { ...this._correction };
  }

  /**
   * Apply the current correction to a raw normalized gaze point.
   *
   * @param {number} rawX - Raw normalized X coordinate (0–1)
   * @param {number} rawY - Raw normalized Y coordinate (0–1)
   * @returns {{ x: number, y: number }} Corrected point
   */
  apply(rawX, rawY) {
    if (!isFinite(rawX) || !isFinite(rawY)) {
      return { x: rawX, y: rawY };
    }

    const { offsetX, offsetY, scaleX, scaleY } = this._correction;
    return {
      x: (rawX - offsetX) * scaleX,
      y: (rawY - offsetY) * scaleY,
    };
  }

  // ---------------------------------------------------------------------------
  // Quality
  // ---------------------------------------------------------------------------

  /**
   * Returns a quality score between 0 and 1 based on recent sample errors.
   * 0 means very poor accuracy (mean error ≥ 0.08 normalized), 1 means perfect.
   *
   * @returns {number}
   */
  getQuality() {
    if (this._recentErrors.length === 0) {
      return 0;
    }
    const mean =
      this._recentErrors.reduce((sum, e) => sum + e, 0) / this._recentErrors.length;
    return GazeCalibrationEngine._clamp(1 - mean / QUALITY_ZERO_DISTANCE, 0, 1);
  }

  /**
   * Returns a human-readable quality level.
   * @returns {'good' | 'fair' | 'poor' | 'learning'}
   */
  getQualityLevel() {
    if (this._sampleCount < QUALITY_MIN_SAMPLES) {
      return 'learning';
    }
    const q = this.getQuality();
    if (q > QUALITY_GOOD_THRESHOLD) return 'good';
    if (q >= QUALITY_FAIR_THRESHOLD) return 'fair';
    return 'poor';
  }

  /**
   * Returns estimated calibration drift in normalized screen coordinates.
   * Drift is calculated as the change in offset between the current correction
   * (which may be updated by implicit calibration) and the baseline explicit correction.
   *
   * @returns {{ dx: number, dy: number, distance: number }}
   */
  getDrift() {
    if (!this._hasExplicit && this._explicitCorrection.offsetX === 0 && this._explicitCorrection.offsetY === 0) {
      // If we don't have explicit baseline parameters, drift is relative to identity (0,0)
      return {
        dx: this._correction.offsetX,
        dy: this._correction.offsetY,
        distance: Math.sqrt(this._correction.offsetX * this._correction.offsetX + this._correction.offsetY * this._correction.offsetY),
      };
    }
    const dx = this._correction.offsetX - this._explicitCorrection.offsetX;
    const dy = this._correction.offsetY - this._explicitCorrection.offsetY;
    return {
      dx,
      dy,
      distance: Math.sqrt(dx * dx + dy * dy),
    };
  }

  /**
   * Returns the total number of qualifying samples collected.
   * @returns {number}
   */
  get sampleCount() {
    return this._sampleCount;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Returns a JSON-serializable snapshot of the engine state.
   * @returns {object}
   */
  toJSON() {
    return {
      offsetX: this._correction.offsetX,
      offsetY: this._correction.offsetY,
      scaleX: this._correction.scaleX,
      scaleY: this._correction.scaleY,
      explicitOffsetX: this._explicitCorrection.offsetX,
      explicitOffsetY: this._explicitCorrection.offsetY,
      explicitScaleX: this._explicitCorrection.scaleX,
      explicitScaleY: this._explicitCorrection.scaleY,
      quality: this.getQuality(),
      sampleCount: this._sampleCount,
      quadrantData: this._quadrants.map((q) => ({ ...q })),
      recentErrors: [...this._recentErrors],
      errorIndex: this._errorIndex,
      hasExplicit: this._hasExplicit,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Restores the engine state from a previously serialized object.
   * @param {object} data - Object produced by toJSON()
   */
  fromJSON(data) {
    if (!data || typeof data !== 'object') {
      return;
    }

    this._correction = {
      offsetX: GazeCalibrationEngine._finiteOr(data.offsetX, 0),
      offsetY: GazeCalibrationEngine._finiteOr(data.offsetY, 0),
      scaleX: GazeCalibrationEngine._finiteOr(data.scaleX, 1),
      scaleY: GazeCalibrationEngine._finiteOr(data.scaleY, 1),
    };

    this._explicitCorrection = {
      offsetX: GazeCalibrationEngine._finiteOr(data.explicitOffsetX ?? data.offsetX, 0),
      offsetY: GazeCalibrationEngine._finiteOr(data.explicitOffsetY ?? data.offsetY, 0),
      scaleX: GazeCalibrationEngine._finiteOr(data.explicitScaleX ?? data.scaleX, 1),
      scaleY: GazeCalibrationEngine._finiteOr(data.explicitScaleY ?? data.scaleY, 1),
    };

    this._sampleCount = GazeCalibrationEngine._finiteOr(data.sampleCount, 0);
    this._hasExplicit = !!data.hasExplicit;

    if (Array.isArray(data.quadrantData) && data.quadrantData.length === 4) {
      this._quadrants = data.quadrantData.map((q) => ({
        errorAvgX: GazeCalibrationEngine._finiteOr(q?.errorAvgX, 0),
        errorAvgY: GazeCalibrationEngine._finiteOr(q?.errorAvgY, 0),
        count: GazeCalibrationEngine._finiteOr(q?.count, 0),
      }));
    }

    if (Array.isArray(data.recentErrors)) {
      this._recentErrors = data.recentErrors
        .slice(0, QUALITY_BUFFER_SIZE)
        .filter((e) => isFinite(e));
      this._errorIndex = GazeCalibrationEngine._finiteOr(
        data.errorIndex,
        this._recentErrors.length % QUALITY_BUFFER_SIZE
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  /**
   * Clears all calibration data and returns to the identity transform.
   */
  reset() {
    this._correction = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    this._explicitCorrection = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    this._sampleCount = 0;
    this._quadrants = [
      { errorAvgX: 0, errorAvgY: 0, count: 0 },
      { errorAvgX: 0, errorAvgY: 0, count: 0 },
      { errorAvgX: 0, errorAvgY: 0, count: 0 },
      { errorAvgX: 0, errorAvgY: 0, count: 0 },
    ];
    this._recentErrors = [];
    this._errorIndex = 0;
    this._hasExplicit = false;
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Push an error value into the circular quality buffer.
   * @param {number} error
   * @private
   */
  _pushError(error) {
    if (this._recentErrors.length < QUALITY_BUFFER_SIZE) {
      this._recentErrors.push(error);
    } else {
      this._recentErrors[this._errorIndex] = error;
    }
    this._errorIndex = (this._errorIndex + 1) % QUALITY_BUFFER_SIZE;
  }

  /**
   * Recompute the global implicit correction from per-quadrant running averages.
   *
   * Global offset is a weighted mean of quadrant error averages (weighted by count).
   * Scale is estimated from the spatial spread of quadrant offsets — if opposite corners
   * have diverging errors, that signals a scale mismatch.
   * @private
   */
  _recomputeImplicitCorrection() {
    const active = this._quadrants.filter((q) => q.count > 0);
    const totalCount = active.reduce((sum, q) => sum + q.count, 0);

    if (totalCount === 0) {
      return;
    }

    // Weighted mean of error (= offset to subtract from raw)
    let weightedErrX = 0;
    let weightedErrY = 0;
    for (const q of active) {
      const w = q.count / totalCount;
      weightedErrX += q.errorAvgX * w;
      weightedErrY += q.errorAvgY * w;
    }

    // Estimate scale from spatial spread of quadrant offsets.
    // If the error in the left half differs from the right half, there is an X-scale issue.
    // Similarly for top vs bottom → Y-scale.
    let scaleX = 1;
    let scaleY = 1;

    const left = this._quadrants.filter((_, i) => i === 0 || i === 2).filter((q) => q.count > 0);
    const right = this._quadrants.filter((_, i) => i === 1 || i === 3).filter((q) => q.count > 0);
    const top = this._quadrants.filter((_, i) => i === 0 || i === 1).filter((q) => q.count > 0);
    const bottom = this._quadrants.filter((_, i) => i === 2 || i === 3).filter((q) => q.count > 0);

    if (left.length > 0 && right.length > 0) {
      const leftAvgErrX = left.reduce((s, q) => s + q.errorAvgX, 0) / left.length;
      const rightAvgErrX = right.reduce((s, q) => s + q.errorAvgX, 0) / right.length;
      // If right error > left error, observed points are spread too wide → scale down
      const spread = rightAvgErrX - leftAvgErrX;
      // The spread represents the difference in error across roughly half the screen (0.5).
      // A positive spread means observed drifts right on the right side → need to compress.
      // scale adjustment: 1 / (1 + spread) — clamped for safety.
      const rawScale = 1 / (1 + spread);
      scaleX = GazeCalibrationEngine._clamp(
        isFinite(rawScale) ? rawScale : 1,
        0.8,
        1.2
      );
    }

    if (top.length > 0 && bottom.length > 0) {
      const topAvgErrY = top.reduce((s, q) => s + q.errorAvgY, 0) / top.length;
      const bottomAvgErrY = bottom.reduce((s, q) => s + q.errorAvgY, 0) / bottom.length;
      const spread = bottomAvgErrY - topAvgErrY;
      const rawScale = 1 / (1 + spread);
      scaleY = GazeCalibrationEngine._clamp(
        isFinite(rawScale) ? rawScale : 1,
        0.8,
        1.2
      );
    }

    this._correction = {
      offsetX: isFinite(weightedErrX) ? weightedErrX : 0,
      offsetY: isFinite(weightedErrY) ? weightedErrY : 0,
      scaleX,
      scaleY,
    };
  }

  /**
   * Determine quadrant index for a target position.
   * 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right
   *
   * @param {number} x - Target X (0–1)
   * @param {number} y - Target Y (0–1)
   * @returns {number}
   * @private
   * @static
   */
  static _quadrantIndex(x, y) {
    const col = x >= 0.5 ? 1 : 0;
    const row = y >= 0.5 ? 1 : 0;
    return row * 2 + col;
  }

  /**
   * Simple linear regression: finds slope and intercept for `y = slope * x + intercept`.
   *
   * @param {number[]} xs - Independent variable values
   * @param {number[]} ys - Dependent variable values
   * @returns {{ slope: number, intercept: number }}
   * @private
   * @static
   */
  static _linearRegression(xs, ys) {
    const n = xs.length;
    if (n === 0) {
      return { slope: 1, intercept: 0 };
    }

    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumXY = 0;

    for (let i = 0; i < n; i++) {
      sumX += xs[i];
      sumY += ys[i];
      sumXX += xs[i] * xs[i];
      sumXY += xs[i] * ys[i];
    }

    const denom = n * sumXX - sumX * sumX;

    if (Math.abs(denom) < EPSILON) {
      // All X values are identical — can't fit a slope, return identity
      const meanY = sumY / n;
      const meanX = sumX / n;
      return { slope: 1, intercept: meanY - meanX };
    }

    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    return {
      slope: isFinite(slope) ? slope : 1,
      intercept: isFinite(intercept) ? intercept : 0,
    };
  }

  /**
   * Clamp a value to [min, max].
   *
   * @param {number} val
   * @param {number} min
   * @param {number} max
   * @returns {number}
   * @private
   * @static
   */
  static _clamp(val, min, max) {
    if (!isFinite(val)) return (min + max) / 2;
    return Math.min(Math.max(val, min), max);
  }

  /**
   * Return value if finite, otherwise fallback.
   *
   * @param {*} val
   * @param {number} fallback
   * @returns {number}
   * @private
   * @static
   */
  static _finiteOr(val, fallback) {
    return typeof val === 'number' && isFinite(val) ? val : fallback;
  }

  /**
   * Ensure a scale value is finite and within a reasonable range.
   *
   * @param {number} scale
   * @returns {number}
   * @private
   * @static
   */
  static _safeScale(scale) {
    if (!isFinite(scale) || Math.abs(scale) < EPSILON) {
      return 1;
    }
    // Clamp to prevent extreme corrections
    return GazeCalibrationEngine._clamp(scale, 0.5, 2.0);
  }
}
