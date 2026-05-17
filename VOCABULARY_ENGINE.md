### 3. `VOCABULARY_ENGINE.md`

```markdown
# LAMP Word Layout & Masking Engine

This file defines the logical structural rules for the 84-button master matrix ($12 \times 7$ grid layout) and outlines the programmatic implementation of the vocabulary unmasking engine.

---

## 1. Static Layout Matrix Matrix Mapping

The core grid is locked to 84 spaces. A word's primary address string is immutable to allow long-term motor planning pathways to build.

┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
R1 │ I │   │   │   │   │   │   │   │   │YES│   │CLR│  (Pronouns Left,
R2 │YOU│   │WNT│   │   │   │   │   │   │   │   │   │   Verbs Mid-Left,
R3 │   │   │   │EAT│   │   │   │   │   │STP│MORE   │   Modifiers Right)
└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
C1  C2  C3  C4  C5  C6  C7  C8  C9 C10 C11 C12


### 1.1. Structural Column Block Anchors
*   **Columns 1 - 2 (Pronouns & Interrogatives):** Anchors primary subjects (`I`, `YOU`, `HE`, `SHE`, `WHAT`, `WHO`).
*   **Columns 3 - 5 (Action Verbs / Core Drivers):** Anchors primary physical transitions (`WANT`, `EAT`, `GO`, `MAKE`, `PLAY`, `SEE`).
*   **Columns 6 - 8 (Spatial Elements & Descriptions):** Anchors modifiers and relative vectors (`UP`, `DOWN`, `IN`, `OUT`, `BIG`, `LITTLE`).
*   **Columns 9 - 11 (Social Dynamics & Core Modifiers):** Anchors interactive tools (`YES`, `NO`, `STOP`, `MORE`, `PLEASE`).
*   **Column 12 (Global System Utilities):** Contains non-spoken macros (`CLEAR WINDOW`, `DELETE WORD`, `SETTINGS GEAR`).

---

## 2. Vocabulary Masking & Hit-Box Scaling Mechanics

During initial training configurations, the majority of the 84 blocks are hidden (masked). To increase tracking success rates, unmasked cells expand their borders to fill adjacent masked cells.

STAGE 1 (Custom Vocab): HIGHLY MASKED (Expanded Hit-Boxes)
┌──────────────────────────────────────┬──────────────────────────────────────┐
│                                      │                                      │
│                WANT                  │                 STOP                 │
│         (Visual Center: C3, R2)      │         (Visual Center: C10, R3)     │
│         [Spans Columns 1 to 6]       │         [Spans Columns 7 to 12]      │
│                                      │                                      │
└──────────────────────────────────────┴──────────────────────────────────────┘

STAGE 3 (1-Hit): FULL VOCABULARY UNMASKED (Native Resolution)
┌──────┬──────┬──────┬──────┬──────┬───┬───┬───┬───┬──────┬──────┬────────────┐
│  I   │ LIKE │ WANT │  GO  │ MAKE │...│...│...│...│ STOP │ MORE │   CLEAR    │
└──────┴──────┴──────┴──────┴──────┴───┴───┴───┴───┴──────┴──────┴────────────┘


### 2.1. Layout Expansion Rules
1.  Every cell object has an immutable base descriptor tracking its native coordinates: `baseRow` and `baseCol`.
2.  The UI computation engine checks the state of neighboring grid blocks (`active: true / false`).
3.  If an unmasked cell is bordered by inactive masked cells, the layout manager applies an expanded CSS grid span (`grid-column-end` / `grid-row-end`) or absolute percentage dimensions to stretch its interactive boundaries over the empty space.
4.  **The Geometric Anchor Rule:** Regardless of the calculated visual button size, the visual text label and icon center point remain anchored to the native coordinates $(baseCol, baseRow)$ to protect motor planning development.

---

## 3. Sequential Transition Chains

Vocabulary processing follows standard clinical 3-tier menu progressions:

### Custom Vocab List (Stage 1)
*   The grid displays a caregiver-curated subset of core terms. 
*   Activating any cell immediately generates vocal text-to-speech output. No sub-menus are triggered.

### 2-Hit (Stage 2)
*   Selecting a primary verb navigates to its Level-2 sub-page, exposing related nouns (e.g., selecting `EAT` transitions to a food nouns page with items like `APPLE`, `SANDWICH`, etc.).
*   The user selects the sub-page word to complete the utterance — two hits total.

### 1-Hit (Stage 3)
*   **One press = one spoken word.** All 82 vocabulary cells are visible on the home grid.
*   No sub-pages are required; every word is accessible with a single dwell activation.
*   Motor planning is built through consistent, spatially stable cell positions.