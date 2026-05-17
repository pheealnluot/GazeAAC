// @refresh reset
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef
} from 'react'
import {
  loadAACBoardLibrary,
  loadSingleBoard,
  listAACBoards,
  applyBoardEdits,
  makeEditKey
} from '@engine/AACBoardLibrary'

/**
 * AACBoardContext — Board library management with lazy on-demand loading.
 *
 * Startup behaviour:
 *   1. `listAACBoards()` fetches just file names from the main process (fast,
 *      no file I/O beyond the already-completed readdir).
 *   2. `loadAACBoardLibrary()` parses only the boards already in memory —
 *      at startup that is just `quick-core-24.obz`.
 *   3. The context combines both into a unified `library` array where
 *      un-loaded entries have `loaded: false` and no `boardSet`.
 *
 * On-demand loading:
 *   - When the user calls `selectBoard(id)` for an unloaded board, the context
 *     fetches it via `loadSingleBoard(fileName)`, parses it, and merges the
 *     resulting LibraryEntry into `library` before switching the active board.
 *
 * Provides:
 *   library           LibraryEntry[]  — all entries (loaded + stubs)
 *   isLoading         boolean
 *   loadingBoardId    string|null     — id of a board currently being loaded
 *   activeLibraryId   string|null     — which entry is selected
 *   activeBoardSet    BoardSet|null   — the selected board's BoardSet
 *   boardEdits        Record<string,ButtonPatch>  — all persisted edits
 *   selectBoard(id)   — switch active board (loads from disk if needed)
 *   saveButtonEdit(fileName, boardId, btnId, patch)  — persist delta
 *   resetButtonEdit(fileName, boardId, btnId)        — clear delta
 *   resetAllEdits()   — clear everything
 *   applyEdits(cells, fileName, boardId)  — merge edit deltas into CellObject[]
 */

const AACBoardContext = createContext(null)

/** Build a stable id from a fileName — mirrors AACBoardLibrary._toId() */
function _toId(fileName) {
  return fileName.replace(/[^a-z0-9]/gi, '-').toLowerCase()
}

export function AACBoardProvider({ children }) {
  const [library, setLibrary]                 = useState([])
  const [isLoading, setIsLoading]             = useState(true)
  const [loadingBoardId, setLoadingBoardId]   = useState(null)
  const [activeLibraryId, setActiveLibraryId] = useState(null)
  const [boardEdits, setBoardEdits]           = useState({})

  // Keep a ref so selectBoard() can always see the latest library without
  // stale-closure issues
  const libraryRef = useRef([])
  libraryRef.current = library

  // Load manifest + pre-loaded boards on mount
  useEffect(() => {
    let cancelled = false

    Promise.all([
      listAACBoards(),                                        // fast: file names only
      loadAACBoardLibrary(),                                  // only parses cached boards
      window.gazeAPI?.boardEdits?.getAll?.() ?? Promise.resolve({})
    ]).then(([manifest, parsedEntries, edits]) => {
      if (cancelled) return

      // Build a map of parsed entries keyed by fileName
      const parsedMap = new Map(parsedEntries.map(e => [e.fileName, e]))

      // Merge manifest stubs with parsed entries
      const merged = manifest.map(({ fileName, cached }) => {
        if (parsedMap.has(fileName)) {
          return { ...parsedMap.get(fileName), loaded: true }
        }
        // Stub entry — not yet parsed
        return {
          id:          _toId(fileName),
          fileName,
          name:        fileName.replace(/\.(obz|obf)$/i, '').replace(/[-_]/g, ' '),
          rows:        0,
          columns:     0,
          buttonCount: 0,
          rootId:      null,
          boardSet:    null,
          loaded:      false,
        }
      })

      // Also include any parsed entries that weren't in the manifest
      // (edge case: shouldn't happen, but be safe)
      for (const e of parsedEntries) {
        if (!manifest.some(m => m.fileName === e.fileName)) {
          merged.push({ ...e, loaded: true })
        }
      }

      merged.sort((a, b) => a.name.localeCompare(b.name))

      setLibrary(merged)
      setBoardEdits(edits ?? {})

      // Auto-select first loaded entry (the pre-loaded default)
      const firstLoaded = merged.find(e => e.loaded)
      if (firstLoaded) setActiveLibraryId(firstLoaded.id)

      setIsLoading(false)
      console.log(
        `[AACBoardContext] Library ready: ${merged.length} board(s) available, ` +
        `${merged.filter(e => e.loaded).length} loaded`
      )
    }).catch(err => {
      if (cancelled) return
      console.error('[AACBoardContext] Failed to load library:', err)
      setIsLoading(false)
    })

    return () => { cancelled = true }
  }, [])

  const activeBoardSet = library.find(e => e.id === activeLibraryId)?.boardSet ?? null

  /**
   * Switch the active board. If the board hasn't been loaded yet, fetch it
   * from the main process first (on-demand), then switch.
   */
  const selectBoard = useCallback(async (id) => {
    const current = libraryRef.current
    const entry = current.find(e => e.id === id)
    if (!entry) {
      console.warn(`[AACBoardContext] selectBoard: unknown id "${id}"`)
      return
    }

    // Already loaded — just switch
    if (entry.loaded) {
      setActiveLibraryId(id)
      console.log(`[AACBoardContext] Selected board: "${id}"`)
      return
    }

    // Need to load from disk first
    setLoadingBoardId(id)
    try {
      console.log(`[AACBoardContext] On-demand loading "${entry.fileName}"…`)
      const loaded = await loadSingleBoard(entry.fileName)
      setLibrary(prev => prev.map(e =>
        e.id === id ? { ...loaded, loaded: true } : e
      ))
      setActiveLibraryId(id)
      console.log(`[AACBoardContext] Selected board (loaded on demand): "${id}"`)
    } catch (err) {
      console.error(`[AACBoardContext] Failed to load board "${entry.fileName}":`, err)
    } finally {
      setLoadingBoardId(null)
    }
  }, [])

  const saveButtonEdit = useCallback(async (fileName, boardId, btnId, patch) => {
    const editKey = makeEditKey(fileName, boardId, btnId)
    try {
      await window.gazeAPI?.boardEdits?.set?.(editKey, patch)
    } catch (err) {
      console.warn('[AACBoardContext] Failed to persist edit:', err)
    }
    // Optimistic local update
    setBoardEdits(prev => ({
      ...prev,
      [editKey]: { ...(prev[editKey] ?? {}), ...patch }
    }))
  }, [])

  const resetButtonEdit = useCallback(async (fileName, boardId, btnId) => {
    const editKey = makeEditKey(fileName, boardId, btnId)
    try {
      await window.gazeAPI?.boardEdits?.set?.(editKey, null)
    } catch (err) {
      console.warn('[AACBoardContext] Failed to reset edit:', err)
    }
    setBoardEdits(prev => {
      const next = { ...prev }
      delete next[editKey]
      return next
    })
  }, [])

  const resetAllEdits = useCallback(async () => {
    try {
      await window.gazeAPI?.boardEdits?.clearAll?.()
    } catch (err) {
      console.warn('[AACBoardContext] Failed to clear all edits:', err)
    }
    setBoardEdits({})
  }, [])

  /**
   * Apply stored edit deltas to a CellObject array for a given board.
   * @param {CellObject[]} cells
   * @param {string} fileName  e.g. "communikate-20.obz"
   * @param {string} boardId   OBF board id
   * @returns {CellObject[]}
   */
  const applyEdits = useCallback((cells, fileName, boardId) => {
    const prefix = `${fileName}:${boardId}`
    return applyBoardEdits(cells, boardEdits, prefix)
  }, [boardEdits])

  return (
    <AACBoardContext.Provider value={{
      library,
      isLoading,
      loadingBoardId,
      activeLibraryId,
      activeBoardSet,
      boardEdits,
      selectBoard,
      saveButtonEdit,
      resetButtonEdit,
      resetAllEdits,
      applyEdits
    }}>
      {children}
    </AACBoardContext.Provider>
  )
}

export function useAACBoards() {
  const ctx = useContext(AACBoardContext)
  if (!ctx) throw new Error('useAACBoards must be used within AACBoardProvider')
  return ctx
}
