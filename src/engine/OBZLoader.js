/**
 * OBZLoader.js — Open Board Format ZIP (.obz) loader
 *
 * An .obz file is a ZIP archive containing:
 *   manifest.json  — board index (maps board id → filename path)
 *   *.obf          — individual board JSON files
 *   images/        — raster / SVG assets (optional)
 *   sounds/        — audio assets (optional)
 *
 * This module handles both:
 *   1. .obz   File objects (drag-and-drop import)
 *   2. Static bundles fetched from public/vocabulary/obf/ at startup
 *
 * Exports:
 *   loadOBZFile(file: File)           → Promise<BoardSet>
 *   loadOBZFromUrl(url: string)       → Promise<BoardSet>
 *   loadOBFFromUrl(url: string)       → Promise<BoardModel>
 *   loadManifestBundle(manifestUrl)   → Promise<BoardSet>
 *
 * BoardSet:
 * {
 *   manifest:  { root: string, paths: { boards: Record<id,filename> } }
 *   boards:    Map<boardId, BoardModel>
 *   rootId:    string   — ID of the root/home board
 * }
 */

import { unzipSync, strFromU8 } from 'fflate'
import { parseOBF } from './OBFParser.js'

// ─── .obz File import ─────────────────────────────────────────────────────────

/**
 * Load a .obz File object (from <input type="file"> or drag-drop).
 * Returns a fully parsed BoardSet ready for VocabularyContext.
 *
 * @param {File} file
 * @returns {Promise<BoardSet>}
 */
export async function loadOBZFile(file) {
  const buffer = await file.arrayBuffer()
  return _parseOBZBuffer(new Uint8Array(buffer))
}

/**
 * Fetch and parse a .obz file from a URL.
 *
 * @param {string} url
 * @returns {Promise<BoardSet>}
 */
export async function loadOBZFromUrl(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`[OBZLoader] HTTP ${res.status} fetching ${url}`)
  const buffer = await res.arrayBuffer()
  return _parseOBZBuffer(new Uint8Array(buffer))
}

// ─── Individual .obf fetch ────────────────────────────────────────────────────

/**
 * Fetch and parse a single .obf JSON file from a URL.
 *
 * @param {string} url
 * @returns {Promise<BoardModel>}
 */
export async function loadOBFFromUrl(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`[OBZLoader] HTTP ${res.status} fetching ${url}`)
  const json = await res.json()
  return parseOBF(json)
}

// ─── Manifest-based bundle loader (public/vocabulary/obf/) ───────────────────

/**
 * Load the GazeAAC native OBF bundle from the public directory.
 * Fetches manifest.json first, then lazily fetches individual .obf files
 * on demand (only root board is fetched eagerly; sub-pages are deferred).
 *
 * @param {string} manifestUrl  e.g. '/vocabulary/obf/manifest.json'
 * @returns {Promise<BoardSet>}
 */
export async function loadManifestBundle(manifestUrl) {
  const baseUrl = manifestUrl.replace(/\/[^/]+$/, '/')  // directory prefix

  // Fetch manifest
  const manifestRes = await fetch(manifestUrl)
  if (!manifestRes.ok) throw new Error(`[OBZLoader] Cannot load manifest: ${manifestUrl}`)
  const manifest = await manifestRes.json()

  const rootFilename = manifest.root ?? 'lamp_home.obf'
  const rootUrl      = baseUrl + rootFilename

  // Eager-load the root board
  const rootBoard = await loadOBFFromUrl(rootUrl)
  const boards    = new Map([[rootBoard.id, rootBoard]])

  // Identify root id from manifest or fall back to fetched board's id
  const rootId = rootBoard.id

  // Build a deferred loader for sub-pages (returns existing if already loaded)
  const boardPaths = manifest.paths?.boards ?? {}
  const loader = {
    manifest,
    boards,
    rootId,
    baseUrl,
    boardPaths,
    /**
     * Lazily fetch and cache a board by its OBF id.
     * @param {string} boardId
     * @returns {Promise<BoardModel>}
     */
    async getBoard(boardId) {
      if (boards.has(boardId)) return boards.get(boardId)
      const filename = boardPaths[boardId]
      if (!filename) {
        console.warn(`[OBZLoader] No path for board id: "${boardId}"`)
        return null
      }
      const board = await loadOBFFromUrl(baseUrl + filename)
      boards.set(boardId, board)
      return board
    }
  }

  return loader
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _parseOBZBuffer(uint8) {
  // Decompress ZIP
  let files
  try {
    files = unzipSync(uint8)
  } catch (e) {
    throw new Error(`[OBZLoader] Failed to unzip: ${e.message}`)
  }

  // Read manifest
  const manifestBytes = files['manifest.json']
  if (!manifestBytes) throw new Error('[OBZLoader] .obz has no manifest.json')
  const manifest = JSON.parse(strFromU8(manifestBytes))

  const rootFilename = manifest.root
  const boardPaths   = manifest.paths?.boards ?? {}

  // Parse all boards eagerly (they're already in memory from the ZIP)
  const boards = new Map()
  for (const [boardId, filename] of Object.entries(boardPaths)) {
    const bytes = files[filename]
    if (!bytes) { console.warn(`[OBZLoader] Missing file in .obz: ${filename}`); continue }
    const json  = JSON.parse(strFromU8(bytes))
    const board = parseOBF(json)
    boards.set(boardId, board)
  }

  // Also parse root board if not already included in boardPaths
  if (rootFilename && !Object.values(boardPaths).includes(rootFilename)) {
    const bytes = files[rootFilename]
    if (bytes) {
      const board = parseOBF(JSON.parse(strFromU8(bytes)))
      boards.set(board.id, board)
    }
  }

  // Determine root id
  let rootId = null
  if (rootFilename) {
    // Find which board corresponds to the root filename
    for (const [id, filename] of Object.entries(boardPaths)) {
      if (filename === rootFilename) { rootId = id; break }
    }
    // If not in boardPaths, look up from boards map
    if (!rootId) {
      for (const [id, board] of boards) {
        if (board.id) { rootId = board.id; break }
      }
    }
  }
  if (!rootId && boards.size > 0) rootId = boards.keys().next().value

  return {
    manifest,
    boards,
    rootId,
    boardPaths,
    async getBoard(boardId) {
      return boards.get(boardId) ?? null
    }
  }
}
