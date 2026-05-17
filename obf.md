# Eye-Gaze AAC Platform Project Specification

## Project Overview
This project details the implementation of a modular web application designed to facilitate Augmentative and Alternative Communication (AAC) and educational assessments using eye-gaze technology. The platform features robust communication board management, enabling the seamless import, processing, and rendering of open-standard layouts while dynamically optimizing interaction methods based on board configurations.

---

## Technical Architecture

### Frontend (React.js)
* **Eye-Gaze Optimization:** UI components are modularized specifically for eye-gaze usability. Buttons utilize target-expansion CSS bounding boxes and distinct visual feedback states (progress rings for dwell-based selection, immediate highlight states for 1-hit selection).
* **Dynamic Grid Rendering:** A layout system maps the parsed `grid` properties from the OBF JSON directly to CSS Grid templates, maintaining the precise spatial design of the original board creator.

### Backend & Infrastructure (Node.js & Firebase)
* **File Processing:** A Node.js service handles the decompression of uploaded `.obz` files, parsing the internal manifest and standardizing the JSON schema.
* **Data Persistence:** Parsed board structures are stored within Firebase Firestore collections for real-time syncing.
* **Asset Storage:** Extracted symbols, images, and audio files are automatically uploaded to Firebase Cloud Storage, returning secure URLs that are then injected back into the board's operational JSON structure.

---

## Core Specifications

### 1. OBF (Open Board Format) Integration
The system fully implements data ingestion based on the official [Open Board Format (OBF) Specification](https://docs.google.com/document/d/1KpC82nQc8RscgYZWKQo-y_LlKSwd8VsuvhnjrIve2f4/edit?tab=t.0#heading=h.k4v7aa46bhlw).
* **Parser Module:** Utility functions to extract board definitions, unique identifiers, grid dimensions, button mappings, and localized strings.
* **Asset Decompression:** Automatic extraction and hosting of associated raster graphics, SVG icons, and audio payloads packaged within `.obz` zipped bundles.

### 2. Standardized Board Library Ingestion
The application includes an automated ingestion pipeline to pre-load baseline reference configurations from the [Open Board Format Examples](https://www.openboardformat.org/examples).
* **Seeding Script:** A backend task fetches the standard `.obz` bundles (including CommuniKate and other core templates), runs them through the decompression utility, and registers them directly to the database.
* **Immediate Utility:** Provides end-users and clinicians with immediate access to proven layouts without requiring manual layout assembly on setup.

### 3. Adaptive Selection Modeling (1-Hit vs. Dwell)
The eye-gaze interaction model adapts dynamically based on the specific board's target audience and layout density.
* **Metadata Evaluation:** During OBF import, the configuration schema is parsed to detect execution flags. The platform reads custom root-level parameters or extensions within the OBF structure to determine the default choice.
* **1-Hit Mode (Hover-to-Click):** Triggered automatically for specific target profiles (such as simplified quiz interfaces, educational assessment modules, or sparse grids). Selection registers the instant the gaze vector intersects the button's active boundary. This maximizes speed and eliminates the physical fatigue of prolonged looking.
* **Dwell Mode:** The fallback mechanism for high-density vocabulary matrices. It requires sustained gaze tracking within a target box for a customizable duration (e.g., 400ms–800ms) to trigger a selection, mitigating unintended activations ("the Midas touch" effect).
