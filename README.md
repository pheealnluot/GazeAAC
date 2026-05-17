# GazeAAC: Intelligent, High-Tolerance Eye-Gaze Assisted Communication

GazeAAC is an open-source, ultra-low-latency desktop assistive communication platform built with Electron, React.js, and Node.js. It is engineered specifically for children with severe physical challenges—such as weak neck, head, and trunk control resulting from Cerebral Palsy—to restore fluid, predictive speech capabilities.

## 1. Core Principles & Philosophy

*   **Motor-Plan Consistency (LAMP Method):** Every vocabulary word is anchored to an unalterable spatial coordinate on an 84-button matrix ($12 \times 7$). Buttons never shift dynamically across folders, allowing the user to build reflexive spatial muscle memory over time.
*   **Decoupled Layout Hit-Boxes:** To mitigate the physical fatigue of targeting tiny cells with an eye tracker, GazeAAC dynamically expands the physical hit-boxes of unmasked buttons into surrounding empty space during early training stages.
*   **Offline-First & Local Acceleration:** Speech generation, telemetry smoothing, and contextual probability highlighting execute entirely on the local device edge to guarantee zero internet dependency and maintain conversational rendering latencies under 250ms.

---

## 2. Project Roadmap & Milestones

- [ ] **Milestone 1: Hardware Abstraction & Core Loop**
    - Establish the native Electron wrapper with Node-API hooks to ingest raw data streams from the Tobii Eye Tracker 5.
- [ ] **Milestone 2: Hybrid Dynamic Grid Matrix**
    - Build the React layout manager capable of reading the master 84-button coordinate array and applying proximity-based hit-box expansions.
- [ ] **Milestone 3: Ocular Feedback & Cushioning Engine**
    - Code the switchable feedback visualizer (Patterns A, B, C) and implement the exponential decay logic for accidental tracking dropouts.
- [ ] **Milestone 4: LAMP Sequencing & Lexicon Engine**
    - Build the 3-screen transitional grid engine to handle category, modifier, and terminal noun speech execution layers.
- [ ] **Milestone 5: Cloud Synchronization & Caregiver Panel**
    - Establish local disk state persistence utilizing `tauri-plugin-store` / `electron-store` mirrors, connected to an offline-first background Firebase sync for remote configuration management.

---

## 3. Repository Directory Architecture

Ensure your development workspace tracks this structural layout:
```text
├── .github/workflows/
├── src/
│   ├── components/       # GazeButton, GridRenderer, CalibrationScreen
│   ├── context/          # GazeSettingsContext, VocabularyContext
│   ├── engine/           # KalmanFilter, DwellTimer, TelemetryRouter
│   └── main.jsx
├── public/
├── main.js               # Electron main application entry window shell
├── package.json
├── ARCHITECTURE.md       # Hardware layer and animation specifications
└── VOCABULARY_ENGINE.md  # 84-grid mapping rules and layout states