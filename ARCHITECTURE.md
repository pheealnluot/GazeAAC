---

### 2. `ARCHITECTURE.md`

```markdown
# Architectural Specification & Hardware Pipelines

This document guides the technical implementation of the eye-gaze data ingestion, coordinate calculation, and UI animation loops within the Electron native container.

---

## 1. Hardware Abstraction Layer (HAL) & Input Processing

GazeAAC isolates eye-tracking telemetry streams from the standard operating system cursor to lock down the interface and avoid accidental Windows gesture triggers.

[Tobii Eye Tracker 5]
│  (Raw Normalized Coordinates Stream @ 60Hz-90Hz)
▼
[Electron Main Process] ──► Normalizes coordinates to screen bounds (e.g., 1920x1080)
│
▼
[Spatial Filter Worker] ──► Applies Kalman Filter & Target Hysteresis Padding
│
▼
[React Render Layer]    ──► Evaluates active button bounds & updates Dwell Time


### 1.1. Telemetry Ingestion Options
*   **Prototyping Pipeline:** The frontend UI tracks coordinate tracking pointers utilizing standard Web Pointer Events (`onPointerOver`, `onPointerOut`) driven by external OS emulators like **Mill Mouse**.
*   **Production Native Pipeline:** The Electron core loads native Node-API bindings directly linking to the **Tobii Stream Engine C SDK**, ingesting absolute screen percentages ($0.0$ to $1.0$).

### 1.2. Spatial Smoothing Filter
To account for head tremors and torso slouching, raw coordinate pairs $(x_t, y_t)$ pass through a rolling low-pass filter or Kalman array.
*   **Target Hysteresis Padding:** When the filtered gaze enters an active button bounding box, an internal pixel padding buffer expands the boundary limits outward by a configurable parameter (default: 35px). The coordinate must exit this expanded buffer to break focus, preventing flicker on target borders.

---

## 2. Dwell Timing & Ocular Cushioning Logic

### 2.1. Mathematical Accumulation Loop
The system evaluates selections using an adjustable accumulator loop. If tracking drops out due to an involuntary muscle spasm, the progress meter enters a "cushioned cooldown" state instead of clearing instantly.

IF (Gaze inside bounds + Hysteresis Padding) {
CurrentDwellProgress += TimeDelta;
} ELSE {
Execute Cooldown Delay Timer (e.g., 250ms);
IF (Gaze fails to re-enter within delay) {
CurrentDwellProgress -= (TimeDelta * DecayRateMultiplier);
}
}
Clamp(CurrentDwellProgress, 0, BaseDwellTimeMs);


### 2.2. Configuration & Parameter Tuning Schema
All timing layers are adjustable through a globally available React Context layer mapping this JSON structure:

```json
{
  "gazeFilterEngine": {
    "baseDwellTimeMs": 1200,
    "cushioningCooldownDelayMs": 250,
    "decayRateMultiplier": 1.5,
    "hysteresisPaddingPixels": 35
  },
  "visualFeedback": {
    "activePattern": "PATTERN_A_RADIAL_CLOCK",
    "themeColorHex": "#10B981"
  }
}