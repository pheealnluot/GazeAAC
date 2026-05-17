/**
 * OBFParser.js — Open Board Format parser
 *
 * Pure utility functions with no side-effects.
 *
 * Exports:
 *   parseOBF(json)            → BoardModel
 *   boardModelToCells(board)  → CellObject[]   (GazeAAC internal format)
 *
 * OBF spec: https://www.openboardformat.org/docs
 *
 * BoardModel:
 * {
 *   id:       string
 *   name:     string
 *   rows:     number
 *   columns:  number
 *   buttonMap: Map<string, OBFButton>   keyed by button id
 *   order:    (string|null)[][]         grid.order from spec
 *   autoReturnHome: boolean             ext_gazeaac_auto_return_home
 *   stage2Cells:    string[]            ext_gazeaac_stage_2_cells (button ids)
 *   stage1Default:  string[]            ext_gazeaac_stage_1_default (button ids)
 * }
 *
 * CellObject (GazeAAC internal):
 * {
 *   id:              string   "r{row}c{col}"
 *   label:           string
 *   icon:            string|null    emoji or null
 *   category:        string
 *   baseRow:         number   1-indexed
 *   baseCol:         number   1-indexed
 *   active:          boolean  (set by caller based on stage)
 *   action:          string|null  'clear' | 'home' | null
 *   loadBoardId:     string|null  board id to navigate to
 *   addVocalization: boolean      ext_coughdrop_add_vocalization — speak label when navigating
 *   // OBF visual parameters (all nullable)
 *   backgroundColor: string|null  e.g. "rgb(255,200,0)"
 *   borderColor:     string|null
 *   textColor:       string|null
 *   capitalisation:  'as-is'|'upper'|'lower'|'title'|null
 *   imageUrl:        string|null  blob: or data: URL for raster image/SVG
 *   soundUrl:        string|null  blob: URL for audio asset
 * }
 */

/**
 * Parse a raw OBF JSON object into a normalised BoardModel.
 *
 * @param {object} json - Parsed OBF JSON (already JSON.parse'd)
 * @returns {BoardModel}
 */
export function parseOBF(json) {
  if (!json || json.format !== 'open-board-0.1') {
    console.warn('[OBFParser] Unexpected format field:', json?.format)
  }

  const grid    = json.grid ?? { rows: 7, columns: 12, order: [] }
  const rows    = grid.rows    ?? 7
  const columns = grid.columns ?? 12
  const order   = grid.order   ?? []

  // Build button lookup map
  const buttonMap = new Map()
  for (const btn of (json.buttons ?? [])) {
    if (btn?.id) buttonMap.set(btn.id, btn)
  }

  // Build image lookup map (id → image object)
  const imageMap = new Map()
  for (const img of (json.images ?? [])) {
    if (img?.id) imageMap.set(img.id, img)
  }

  return {
    id:            json.id   ?? 'unknown-board',
    name:          json.name ?? 'Unnamed Board',
    rows,
    columns,
    buttonMap,
    imageMap,
    order,
    autoReturnHome: json.ext_gazeaac_auto_return_home ?? false,
    stage2Cells:   json.ext_gazeaac_stage_2_cells   ?? [],
    stage1Default: json.ext_gazeaac_stage_1_default ?? [],
  }
}

/**
 * Convert a BoardModel to an array of CellObjects (GazeAAC internal format).
 *
 * Active state is NOT set here — the caller (VocabularyContext) applies stage
 * masking after this function returns.
 *
 * @param {BoardModel} board
 * @returns {CellObject[]}
 */
export function boardModelToCells(board) {
  const { rows, columns, order, buttonMap, stage2Cells, stage1Default } = board

  // Blob asset maps (set by AACBoardLibrary after ZIP extraction)
  const imageBlobs = board._imageBlobs ?? new Map()
  const soundBlobs = board._soundBlobs ?? new Map()

  // Build a quick lookup: buttonId → { row, col } (1-indexed)
  // We walk the order grid to determine position.
  const posMap = new Map()  // btnId → {row, col}
  for (let r = 0; r < rows; r++) {
    const rowArr = order[r] ?? []
    for (let c = 0; c < columns; c++) {
      const btnId = rowArr[c]
      if (btnId) posMap.set(btnId, { row: r + 1, col: c + 1 })
    }
  }

  // Sets for fast stage-membership lookup
  const stage2Set = new Set(stage2Cells)
  const stage1Set = new Set(stage1Default)

  const cells = []

  for (let row = 1; row <= rows; row++) {
    for (let col = 1; col <= columns; col++) {
      const cellId = `r${row}c${col}`
      const btnId  = order[row - 1]?.[col - 1] ?? null
      const btn    = btnId ? buttonMap.get(btnId) : null

      // ── Icon resolution ────────────────────────────────────────────────────
      // Priority: ext_gazeaac_icon emoji > symbol.filename emoji > null
      let icon = null
      if (btn?.ext_gazeaac_icon) {
        icon = btn.ext_gazeaac_icon
      } else if (btn?.image_id) {
        const img = board.imageMap?.get(btn.image_id)
        if (img?.symbol?.set === 'emoji') icon = img.symbol.filename
        else if (img?.data) icon = null  // raster — not an emoji
      }

      // ── Raster image URL resolution ────────────────────────────────────────
      // 1. Blob URL from AACBoardLibrary ZIP extraction
      // 2. Inline base64 data URI from OBF image object
      // 3. External URL from OBF image object
      let imageUrl = null
      if (btn?.image_id) {
        const img = board.imageMap?.get(btn.image_id)
        if (img) {
          // Try blob: URL from ZIP extraction (path key)
          const blobPath = img.path ?? img.url
          if (blobPath && imageBlobs.has(blobPath)) {
            imageUrl = imageBlobs.get(blobPath)
          } else if (img.data) {
            // Inline base64
            const mimeType = img.content_type ?? 'image/png'
            imageUrl = `data:${mimeType};base64,${img.data}`
          } else if (img.url) {
            imageUrl = img.url
          }
        }
      }

      // ── Sound URL resolution ───────────────────────────────────────────────
      let soundUrl = null
      if (btn?.sound_id) {
        const snd = board.soundMap?.get(btn.sound_id)
        if (snd) {
          const blobPath = snd.path ?? snd.url
          if (blobPath && soundBlobs.has(blobPath)) {
            soundUrl = soundBlobs.get(blobPath)
          } else if (snd.data) {
            const mimeType = snd.content_type ?? 'audio/mpeg'
            soundUrl = `data:${mimeType};base64,${snd.data}`
          } else if (snd.url) {
            soundUrl = snd.url
          }
        }
      }

      const category = btn?.ext_gazeaac_category ?? (btn ? 'noun' : 'empty')

      // ── Action type ────────────────────────────────────────────────────────
      let action = btn?.ext_gazeaac_action ?? null
      // NOTE: Home detection via load_board.id is NOT done here because the root
      // board ID varies per board set (e.g. 'lamp-home' for LAMP, '1_403' for
      // Quick Core 24). App.jsx compares loadBoardId against boardSet.rootId at
      // runtime to detect home-return navigation correctly for any board set.

      // ── OBF visual parameters ──────────────────────────────────────────────
      const backgroundColor = btn?.background_color ?? null
      const borderColor     = btn?.border_color     ?? null
      const textColor       = btn?.text_color       ?? null
      // capitalisation: from OBF ext field or default 'as-is'
      const capitalisation  = btn?.ext_gazeaac_capitalisation ?? null

      cells.push({
        id:              cellId,
        label:           btn?.label     ?? '',
        icon,
        category,
        baseRow:         row,
        baseCol:         col,
        active:          false,        // caller sets this via applyStage()
        action,
        loadBoardId:     btn?.load_board?.id ?? null,
        // ext_coughdrop_add_vocalization — true means speak label when navigating.
        // Absent (or false) on silent-navigation buttons like the root "it" pronoun;
        // present on speak-and-navigate verb buttons like "want".
        addVocalization: btn?.ext_coughdrop_add_vocalization ?? false,
        // OBF visual parameters
        backgroundColor,
        borderColor,
        textColor,
        capitalisation,
        imageUrl,
        soundUrl,
        // Expose raw button id for stage mask lookups and edit delta keying
        _btnId:      btnId ?? null,
        _stage2:     btnId ? stage2Set.has(btnId) : false,
        _stage1:     btnId ? stage1Set.has(btnId) : false,
      })
    }
  }

  return cells
}

/**
 * Apply stage masking to an array of CellObjects produced by boardModelToCells().
 *
 * Stage 1 — Custom Vocab List:
 *   Uses customVocabIds (array of 'r{row}c{col}' cell IDs) or falls back to
 *   the board's ext_gazeaac_stage_1_default list.
 *
 * Stage 2 — Core vocabulary (~19 words + verb sub-pages):
 *   Uses the board's ext_gazeaac_stage_2_cells list.
 *
 * Stage 3 — Full vocabulary:
 *   All non-empty cells active.
 *
 * @param {CellObject[]} cells
 * @param {number} stage  1 | 2 | 3
 * @param {string[]} customVocabIds  Cell IDs (e.g. ['r5c3', 'r4c10'])
 * @returns {CellObject[]}  New array with active flags set
 */
export function applyStage(cells, stage, customVocabIds = []) {
  let activeSet

  if (stage === 1) {
    const ids = customVocabIds.length > 0
      ? customVocabIds
      : cells.filter(c => c._stage1).map(c => c._btnId ?? c.id)
    activeSet = new Set(ids)
    return cells.map(c => ({ ...c, active: activeSet.has(c.id) || (c._btnId != null && activeSet.has(c._btnId)) }))
  }

  if (stage === 2) {
    return cells.map(c => ({ ...c, active: c._stage2 }))
  }

  // Stage 3 — all non-empty
  return cells.map(c => ({ ...c, active: !!c.label }))
}
