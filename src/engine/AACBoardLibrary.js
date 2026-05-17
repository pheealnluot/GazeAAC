/**
 * AACBoardLibrary.js
 *
 * Loads all pre-loaded .obz boards received from the Electron main process
 * (via `window.gazeAPI.aacBoards.getAll()`), decompresses each ZIP, parses
 * the OBF boards, and extracts image/sound assets as blob: URLs.
 *
 * Exports:
 *   loadAACBoardLibrary()  → Promise<LibraryEntry[]>
 *   applyBoardEdits(cells, edits, editKeyPrefix)  → CellObject[]
 *   makeEditKey(fileName, boardId, btnId)  → string
 *
 * LibraryEntry:
 * {
 *   id:          string        unique stable id (sanitised fileName)
 *   fileName:    string        e.g. "communikate-20.obz"
 *   name:        string        root board display name
 *   rows:        number
 *   columns:     number
 *   buttonCount: number
 *   rootId:      string
 *   boardSet:    BoardSet      fully parsed, images/sounds as blob: URLs
 * }
 */

import { unzipSync, strFromU8 } from 'fflate'
import { parseOBF } from './OBFParser.js'

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the directory manifest (file names only, no buffers) from the main
 * process.  This is very fast — the main process only does a readdir() at
 * startup and returns a plain string array.
 *
 * @returns {Promise<Array<{ fileName: string, cached: boolean }>>}
 */
export async function listAACBoards() {
  if (!window.gazeAPI?.aacBoards?.list) return []
  try {
    return await window.gazeAPI.aacBoards.list()
  } catch (err) {
    console.error('[AACBoardLibrary] listAACBoards IPC failed:', err)
    return []
  }
}

/**
 * Load, parse and return a single LibraryEntry for the given fileName.
 * On the first call the main process reads the file from disk; subsequent
 * calls are served from the in-process cache (near-instant).
 *
 * @param {string} fileName  e.g. "communikate-20.obz"
 * @returns {Promise<LibraryEntry>}
 */
export async function loadSingleBoard(fileName) {
  if (!window.gazeAPI?.aacBoards?.loadOne) {
    throw new Error('[AACBoardLibrary] gazeAPI.aacBoards.loadOne not available')
  }
  const { fileName: fn, buffer } = await window.gazeAPI.aacBoards.loadOne(fileName)
  const entry = fn.toLowerCase().endsWith('.obf')
    ? _parseObfEntry(fn, buffer)
    : _parseEntry(fn, buffer)
  console.log(`[AACBoardLibrary] Parsed "${fn}": root="${entry.rootId}", ${entry.buttonCount} buttons`)
  return entry
}

/**
 * Fetch all boards that are already in memory (pre-loaded + previously
 * on-demand loaded), parse them, and return a sorted LibraryEntry array.
 *
 * This is called once at startup and will only contain the pre-loaded default
 * board unless the user has previously triggered an on-demand load.
 *
 * In browser dev-mode (no Electron) this returns an empty array gracefully.
 *
 * @returns {Promise<LibraryEntry[]>}
 */
export async function loadAACBoardLibrary() {
  if (!window.gazeAPI?.aacBoards) {
    console.warn('[AACBoardLibrary] gazeAPI.aacBoards not available — running without pre-loaded boards')
    return []
  }

  let rawList
  try {
    rawList = await window.gazeAPI.aacBoards.getAll()
  } catch (err) {
    console.error('[AACBoardLibrary] IPC call failed:', err)
    return []
  }

  const entries = []
  for (const { fileName, buffer } of rawList) {
    try {
      const entry = fileName.toLowerCase().endsWith('.obf')
        ? _parseObfEntry(fileName, buffer)
        : _parseEntry(fileName, buffer)
      entries.push(entry)
      console.log(`[AACBoardLibrary] Parsed "${fileName}": root="${entry.rootId}", ${entry.buttonCount} buttons`)
    } catch (err) {
      console.warn(`[AACBoardLibrary] Failed to parse "${fileName}":`, err.message)
    }
  }

  // Sort alphabetically by display name
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}


/**
 * Apply stored board edit patches over a CellObject array.
 *
 * @param {CellObject[]} cells
 * @param {Record<string,object>} edits   The full boardEdits map from store
 * @param {string} editKeyPrefix          e.g. "communikate-20.obz:root-board-id"
 * @returns {CellObject[]}
 */
export function applyBoardEdits(cells, edits, editKeyPrefix) {
  if (!edits || Object.keys(edits).length === 0) return cells
  return cells.map(cell => {
    const btnId = cell._btnId
    if (!btnId) return cell
    const key = `${editKeyPrefix}:${btnId}`
    const patch = edits[key]
    if (!patch) return cell
    return _mergePatch(cell, patch)
  })
}

/**
 * Build a stable edit key for a specific button.
 * @param {string} fileName  e.g. "communikate-20.obz"
 * @param {string} boardId   OBF board id
 * @param {string} btnId     OBF button id
 * @returns {string}
 */
export function makeEditKey(fileName, boardId, btnId) {
  return `${fileName}:${boardId}:${btnId}`
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/**
 * Parse a single .obf (plain JSON, no ZIP) into a LibraryEntry.
 * There is no manifest; the single file IS the root board.
 */
function _parseObfEntry(fileName, buffer) {
  const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const decoder = new TextDecoder()
  const json = JSON.parse(decoder.decode(uint8))
  const board = parseOBF(json)
  const boardId = board.id ?? _toId(fileName)

  const imageBlobs = new Map()
  const soundBlobs = new Map()

  const boards = new Map()
  boards.set(boardId, board)

  const boardSet = {
    manifest: { root: fileName, paths: { boards: { [boardId]: fileName } } },
    boards,
    rootId: boardId,
    boardPaths: { [boardId]: fileName },
    _imageBlobs: imageBlobs,
    _soundBlobs: soundBlobs,
    async getBoard(id) { return boards.get(id) ?? null }
  }

  return {
    id:          _toId(fileName),
    fileName,
    name:        board.name ?? fileName.replace(/\.obf$/i, ''),
    rows:        board.rows    ?? 0,
    columns:     board.columns ?? 0,
    buttonCount: board.buttonMap?.size ?? 0,
    rootId:      boardId,
    boardSet
  }
}

function _parseEntry(fileName, buffer) {
  const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)

  // Decompress ZIP
  let files
  try {
    files = unzipSync(uint8)
  } catch (e) {
    throw new Error(`Failed to unzip "${fileName}": ${e.message}`)
  }

  // Read manifest
  const manifestBytes = files['manifest.json']
  if (!manifestBytes) throw new Error(`"${fileName}" has no manifest.json`)
  const manifest = JSON.parse(strFromU8(manifestBytes))

  const rootFilename = manifest.root
  const boardPaths   = manifest.paths?.boards ?? {}

  // Extract all image assets as blob: URLs
  const imageBlobs = _extractBlobs(files, 'images/')
  // Extract all sound assets as blob: URLs
  const soundBlobs = _extractBlobs(files, 'sounds/')

  // Parse all boards eagerly
  const boards = new Map()
  for (const [boardId, filename] of Object.entries(boardPaths)) {
    const bytes = files[filename]
    if (!bytes) { console.warn(`[AACBoardLibrary] Missing file: ${filename}`); continue }
    const json  = JSON.parse(strFromU8(bytes))
    const board = parseOBF(json)
    // Attach blob maps to each board model
    board._imageBlobs = imageBlobs
    board._soundBlobs = soundBlobs
    boards.set(boardId, board)
  }

  // Also handle root if not in boardPaths
  if (rootFilename && !Object.values(boardPaths).includes(rootFilename)) {
    const bytes = files[rootFilename]
    if (bytes) {
      const board = parseOBF(JSON.parse(strFromU8(bytes)))
      board._imageBlobs = imageBlobs
      board._soundBlobs = soundBlobs
      boards.set(board.id, board)
    }
  }

  // Determine root id
  let rootId = null
  for (const [id, filename] of Object.entries(boardPaths)) {
    if (filename === rootFilename) { rootId = id; break }
  }
  if (!rootId && boards.size > 0) rootId = boards.keys().next().value

  const rootBoard = boards.get(rootId)

  // Build the BoardSet object compatible with VocabularyContext
  const boardSet = {
    manifest,
    boards,
    rootId,
    boardPaths,
    _imageBlobs: imageBlobs,
    _soundBlobs: soundBlobs,
    async getBoard(boardId) {
      return boards.get(boardId) ?? null
    }
  }

  return {
    id:          _toId(fileName),
    fileName,
    name:        rootBoard?.name ?? fileName.replace(/\.obz$/i, ''),
    rows:        rootBoard?.rows    ?? 0,
    columns:     rootBoard?.columns ?? 0,
    buttonCount: rootBoard?.buttonMap?.size ?? 0,
    rootId,
    boardSet
  }
}

/**
 * Extract all files under a given path prefix from the ZIP as blob: URLs.
 * Returns a Map<relativeFilename, blobUrl>.
 */
function _extractBlobs(files, prefix) {
  const map = new Map()
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith(prefix)) continue
    const relName = path.slice(prefix.length)
    if (!relName) continue
    const mime = _guessMime(relName)
    const blob = new Blob([bytes], { type: mime })
    map.set(relName, URL.createObjectURL(blob))
    // Also map the full path for lookup by `path` key
    map.set(path, map.get(relName))
  }
  return map
}

function _guessMime(filename) {
  const ext = filename.split('.').pop()?.toLowerCase()
  const mimes = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4'
  }
  return mimes[ext] ?? 'application/octet-stream'
}

function _toId(fileName) {
  return fileName.replace(/[^a-z0-9]/gi, '-').toLowerCase()
}

/**
 * Merge a ButtonPatch over a CellObject.
 * Only defined patch fields are applied; undefined/null fields leave the cell unchanged.
 */
function _mergePatch(cell, patch) {
  const merged = { ...cell }
  if (patch.label        !== undefined) merged.label        = patch.label
  if (patch.icon         !== undefined) merged.icon         = patch.icon
  if (patch.imageUrl     !== undefined) merged.imageUrl     = patch.imageUrl
  if (patch.soundUrl     !== undefined) merged.soundUrl     = patch.soundUrl
  if (patch.backgroundColor !== undefined) merged.backgroundColor = patch.backgroundColor
  if (patch.borderColor  !== undefined) merged.borderColor  = patch.borderColor
  if (patch.textColor    !== undefined) merged.textColor    = patch.textColor
  if (patch.capitalisation !== undefined) merged.capitalisation = patch.capitalisation
  return merged
}
