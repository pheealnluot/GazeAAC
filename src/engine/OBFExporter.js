/**
 * OBFExporter.js — Serialize GazeAAC board state back to OBF / .obz format
 *
 * Exports:
 *   boardsToOBZ(boardSet)  → Promise<Uint8Array>   (ZIP binary for download)
 *   boardToOBFJson(board)  → object                (raw OBF JSON object)
 */

import { zipSync, strToU8 } from 'fflate'

/**
 * Package a BoardSet (Map<id, BoardModel>) into a valid .obz ZIP binary.
 *
 * @param {{boards: Map<string, BoardModel>, rootId: string, manifest: object}} boardSet
 * @returns {Uint8Array}
 */
export function boardsToOBZ(boardSet) {
  const { boards, rootId } = boardSet

  const files = {}

  // Build manifest
  const boardPaths = {}
  for (const [id] of boards) {
    boardPaths[id] = id === rootId ? 'manifest_root.obf' : `boards/${id}.obf`
  }

  const manifest = {
    format: 'open-board-0.1',
    root:   boardPaths[rootId] ?? 'manifest_root.obf',
    paths:  { boards: boardPaths, images: {}, sounds: {} }
  }

  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))

  for (const [id, board] of boards) {
    const filename = boardPaths[id]
    const json = boardModelToOBFJson(board)
    files[filename] = strToU8(JSON.stringify(json, null, 2))
  }

  return zipSync(files, { level: 6 })
}

/**
 * Convert a BoardModel back into a raw OBF JSON object.
 * Note: BoardModels already store the original OBF data in buttonMap,
 * so this is mostly a reshape operation.
 *
 * @param {BoardModel} board
 * @returns {object}
 */
export function boardModelToOBFJson(board) {
  const buttons = []
  const images  = []

  for (const [, btn] of board.buttonMap) {
    buttons.push(btn)
    if (btn.image_id) {
      const img = board.imageMap?.get(btn.image_id)
      if (img) images.push(img)
    }
  }

  const obf = {
    format:      'open-board-0.1',
    id:          board.id,
    locale:      'en',
    name:        board.name,
    grid: {
      rows:    board.rows,
      columns: board.columns,
      order:   board.order
    },
    buttons,
    images,
    sounds: []
  }

  if (board.autoReturnHome)  obf.ext_gazeaac_auto_return_home = true
  if (board.stage2Cells?.length) obf.ext_gazeaac_stage_2_cells = board.stage2Cells
  if (board.stage1Default?.length) obf.ext_gazeaac_stage_1_default = board.stage1Default

  return obf
}

/**
 * Trigger a file download of a .obz binary in the browser.
 *
 * @param {Uint8Array} data
 * @param {string} filename
 */
export function downloadOBZ(data, filename = 'gazeaac-boards.obz') {
  const blob = new Blob([data], { type: 'application/zip' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
