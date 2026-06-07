import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef
} from 'react'
import { useGazeSettings } from './GazeSettingsContext'
import { parseOBF, boardModelToCells, applyStage } from '@engine/OBFParser'
import { loadManifestBundle, loadOBZFile, loadOBFFromUrl } from '@engine/OBZLoader'
import { boardsToOBZ, downloadOBZ } from '@engine/OBFExporter'
import { useAACBoards } from './AACBoardContext'

/**
 * VocabularyContext — Milestone 6: OBF (Open Board Format) native
 *
 * The vocabulary system is now fully OBF-compliant:
 *
 *   • On startup, the LAMP WFL boards are loaded from
 *     public/vocabulary/obf/manifest.json (OBF JSON files generated from the
 *     legacy lamp_84.json + lamp_pages.json sources).
 *
 *   • Caregivers can import any .obf or .obz file from the Caregiver Panel.
 *     The imported boards replace the active board set for the session
 *     (persisted via electron-store on next save).
 *
 *   • Navigation follows OBF load_board links (button.loadBoardId) instead of
 *     the legacy NAV_VERB_PAGES lookup table.
 *
 *   • Stage masking reads ext_gazeaac_stage_2_cells and
 *     ext_gazeaac_stage_1_default from the home board's OBF metadata.
 *
 * Backward-compatibility note:
 *   NAV_VERB_PAGES and PAGE_META are still exported so that App.jsx and
 *   NavBreadcrumb.jsx continue to compile without changes. They are derived
 *   dynamically from the loaded board set rather than being hardcoded.
 *
 * Context value shape:
 * {
 *   cells        CellObject[]    full 12×7 (or board-sized) cell list
 *   activeCells  CellObject[]    cells where active === true
 *   stage        1|2|3
 *   activePage   string          OBF board id, 'home' = root board
 *   cols         number          grid column count (from active board)
 *   rows         number          grid row count (from active board)
 *   isLoading    boolean
 *   loadError    string|null
 *   // Actions
 *   unmaskCell(id)
 *   maskCell(id)
 *   setStage(n)
 *   resetGrid()
 *   navigateTo(boardId)        follows an OBF load_board link
 *   goHome()
 *   importOBZFile(File)        → Promise<void>   drag-drop import
 *   importOBFUrl(url)          → Promise<void>   URL import
 *   exportBoards()             → Promise<void>   download .obz
 *   boardSet                   the live BoardSet loader
 * }
 */

// ─── Legacy compatibility exports ─────────────────────────────────────────────

/**
 * NAV_VERB_PAGES — derived at runtime from loaded boards.
 * Exported for backward compatibility with App.jsx / NavBreadcrumb.
 * Populated once the home board is loaded.
 */
export const NAV_VERB_PAGES = {}

/**
 * PAGE_META — icon + label for each sub-page, derived at runtime.
 * Exported for NavBreadcrumb.jsx.
 */
export const PAGE_META = {
  home: { label: 'Home', icon: '🏠' }
}

// ─── Manifest URL ─────────────────────────────────────────────────────────────
const MANIFEST_URL = '/vocabulary/obf/manifest.json'
const HOME_BOARD_ID = 'lamp-home'

// ─── Context ──────────────────────────────────────────────────────────────────
const VocabularyContext = createContext(null)

export function VocabularyProvider({ children }) {
  const { settings } = useGazeSettings()
  const customVocabIds = settings.customVocabIds ?? []

  // AACBoardContext — provides the selected pre-loaded library board set
  // We use a try/catch because VocabularyProvider might be mounted before
  // AACBoardProvider in some test scenarios, though in normal operation they
  // are always co-mounted.
  let aacBoardCtx = null
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    aacBoardCtx = useAACBoards()
  } catch {
    // Not wrapped in AACBoardProvider — fall through to default LAMP manifest
  }
  const externalBoardSet = aacBoardCtx?.activeBoardSet ?? null
  const activeLibraryEntry = aacBoardCtx?.library?.find(
    e => e.id === aacBoardCtx?.activeLibraryId
  ) ?? null

  // ── Board set state ────────────────────────────────────────────────────────
  // boardSetRef holds the live BoardSet loader (with async getBoard()).
  // We use a ref so navigation callbacks don't need it in their dep arrays.
  const boardSetRef = useRef(null)

  const [stage, setStageState] = useState(settings.stage ?? 1)
  const [activeBoardId, setActiveBoardId] = useState(HOME_BOARD_ID)
  const [cells, setCells] = useState([])
  const [cols, setCols] = useState(12)
  const [rows, setRows] = useState(7)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  // Navigation history stack for goBack()
  const navHistoryRef = useRef([])  // array of boardIds, most-recent last

  // activePage is derived from activeBoardId for NavBreadcrumb compat
  // 'home' when on the root board (any root, not just LAMP), otherwise the board id
  // rootBoardId is the actual root of the currently active board set.
  const rootBoardId = boardSetRef.current?.rootId ?? HOME_BOARD_ID
  const activePage = (activeBoardId === rootBoardId || activeBoardId === HOME_BOARD_ID) ? 'home' : activeBoardId

  // ── Load OBF manifest on mount ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    // If an external board set is selected from the library, skip the manifest
    if (externalBoardSet) {
      ;(async () => {
        const rootBoard = await externalBoardSet.getBoard(externalBoardSet.rootId)
        if (!rootBoard || cancelled) return
        boardSetRef.current = externalBoardSet
        _populateLegacyMaps(externalBoardSet)
        const rawCells = boardModelToCells(rootBoard)
        const staged   = applyStage(rawCells, stage, customVocabIds)
        setCells(staged)
        setCols(rootBoard.columns)
        setRows(rootBoard.rows)
        setActiveBoardId(externalBoardSet.rootId)
        setIsLoading(false)
        console.log(`[VocabularyContext] Library board loaded: "${rootBoard.name}" (${rootBoard.columns}×${rootBoard.rows})`)
      })()
      return () => { cancelled = true }
    }

    loadManifestBundle(MANIFEST_URL)
      .then(async (boardSet) => {
        if (cancelled) return
        boardSetRef.current = boardSet

        // Populate NAV_VERB_PAGES and PAGE_META from the loaded boards
        _populateLegacyMaps(boardSet)

        // Load root board and apply initial stage
        const homeBoard = await boardSet.getBoard(HOME_BOARD_ID)
        if (!homeBoard || cancelled) return

        const rawCells = boardModelToCells(homeBoard)
        const staged   = applyStage(rawCells, stage, customVocabIds)
        setCells(staged)
        setCols(homeBoard.columns)
        setRows(homeBoard.rows)
        setIsLoading(false)
        console.log(`[VocabularyContext] OBF home board loaded — ${homeBoard.buttons?.size ?? homeBoard.buttonMap?.size} buttons`)
      })
      .catch((err) => {
        if (cancelled) return
        console.warn('[VocabularyContext] Failed to load OBF manifest, using fallback:', err)
        _loadFallback(stage, customVocabIds, setCells, setCols, setRows, setIsLoading, setLoadError)
      })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalBoardSet])

  // ── Navigate to a board by OBF id ─────────────────────────────────────────
  const navigateTo = useCallback(async (boardId) => {
    const boardSet = boardSetRef.current
    if (!boardSet) {
      console.warn('[VocabularyContext] navigateTo called before board set loaded')
      return
    }

    // Resolve 'home' alias
    const targetId = (boardId === 'home') ? HOME_BOARD_ID : boardId

    const board = await boardSet.getBoard(targetId)
    if (!board) {
      console.warn(`[VocabularyContext] Board not found: "${targetId}"`)
      return
    }

    const rawCells = boardModelToCells(board)
    // Sub-pages show all cells (no stage masking on sub-pages)
    const staged   = rawCells.map(c => ({ ...c, active: !!c.label }))
    // Push current board onto history before navigating
    setActiveBoardId(prev => {
      navHistoryRef.current = [...navHistoryRef.current, prev]
      return targetId
    })
    setCells(staged)
    setCols(board.columns)
    setRows(board.rows)
    console.log(`[VocabularyContext] Navigated to board: "${targetId}" (${board.columns}×${board.rows})`)
  }, [])

  // ── Go back one board in the navigation history ───────────────────────────
  const goBack = useCallback(async () => {
    const boardSet = boardSetRef.current
    if (!boardSet) return

    const history = navHistoryRef.current
    if (history.length === 0) {
      // No history — fall back to home
      const homeId = boardSet.rootId ?? HOME_BOARD_ID
      const homeBoard = await boardSet.getBoard(homeId)
      if (!homeBoard) return
      const rawCells = boardModelToCells(homeBoard)
      const staged   = applyStage(rawCells, stage, customVocabIds)
      setCells(staged)
      setCols(homeBoard.columns)
      setRows(homeBoard.rows)
      setActiveBoardId(homeId)
      return
    }

    // Pop the last board from history
    const prevId = history[history.length - 1]
    navHistoryRef.current = history.slice(0, -1)

    const homeId = boardSet.rootId ?? HOME_BOARD_ID
    const isHome = prevId === homeId || prevId === HOME_BOARD_ID

    const board = await boardSet.getBoard(isHome ? homeId : prevId)
    if (!board) return

    const rawCells = boardModelToCells(board)
    const staged   = isHome
      ? applyStage(rawCells, stage, customVocabIds)
      : rawCells.map(c => ({ ...c, active: !!c.label }))
    setCells(staged)
    setCols(board.columns)
    setRows(board.rows)
    setActiveBoardId(isHome ? homeId : prevId)
    console.log(`[VocabularyContext] goBack → "${prevId}"`)
  }, [stage, customVocabIds])

  // ── Return to home board ───────────────────────────────────────────────────
  const goHome = useCallback(async () => {
    const boardSet = boardSetRef.current
    if (!boardSet) return

    // Use the actual root id of the active board set — NOT the hardcoded
    // 'lamp-home' constant, which only exists in the LAMP WFL manifest bundle.
    // External OBZ boards (Quick Core 24, CommuniKate, etc.) have their own
    // root ids (e.g. '1_403'). Falling back to HOME_BOARD_ID covers the LAMP
    // manifest case where rootId may not be set yet.
    const homeId = boardSet.rootId ?? HOME_BOARD_ID
    const homeBoard = await boardSet.getBoard(homeId)
    if (!homeBoard) {
      console.warn(`[VocabularyContext] goHome: root board "${homeId}" not found`)
      return
    }

    const rawCells = boardModelToCells(homeBoard)
    const staged   = applyStage(rawCells, stage, customVocabIds)
    setCells(staged)
    setCols(homeBoard.columns)
    setRows(homeBoard.rows)
    setActiveBoardId(homeId)
    navHistoryRef.current = []  // clear history on explicit home navigation
    console.log(`[VocabularyContext] Returned to home board ("${homeId}")`)
  }, [stage, customVocabIds])

  // ── Stage changes ──────────────────────────────────────────────────────────
  const setStage = useCallback(async (n) => {
    const boardSet = boardSetRef.current
    setStageState(n)

    // Re-apply masking to home board (use dynamic rootId, not hardcoded constant)
    const homeId = boardSet?.rootId ?? HOME_BOARD_ID
    const isOnHome = activeBoardId === homeId || activeBoardId === HOME_BOARD_ID
    if (isOnHome && boardSet) {
      const homeBoard = await boardSet.getBoard(homeId)
      if (homeBoard) {
        const rawCells = boardModelToCells(homeBoard)
        setCells(applyStage(rawCells, n, customVocabIds))
      }
    } else {
      // On sub-pages, stage only applies when returning home
      setCells(prev => applyStage(prev, n, customVocabIds))
    }
    setActiveBoardId(homeId)
  }, [activeBoardId, customVocabIds])

  const resetGrid = useCallback(() => setStage(1), [setStage])

  // ── Re-apply stage masking when customVocabIds changes ────────────────────
  // This fires when the caregiver saves a new custom vocabulary selection in
  // Board Settings, so the grid reflects the change immediately (without the
  // user having to press Home first).
  useEffect(() => {
    const boardSet = boardSetRef.current
    if (!boardSet) return

    const homeId = boardSet.rootId ?? HOME_BOARD_ID
    const isOnHome = activeBoardId === homeId || activeBoardId === HOME_BOARD_ID
    if (!isOnHome) return  // don't re-mask sub-pages

    ;(async () => {
      const homeBoard = await boardSet.getBoard(homeId)
      if (!homeBoard) return
      const rawCells = boardModelToCells(homeBoard)
      setCells(applyStage(rawCells, stage, customVocabIds))
    })()
  // customVocabIds identity changes only when the array contents change (new ref from updateSetting)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customVocabIds])

  // ── Cell-level mask overrides ──────────────────────────────────────────────
  const unmaskCell = useCallback((id) => {
    setCells(prev => prev.map(c => c.id === id ? { ...c, active: true } : c))
  }, [])

  const maskCell = useCallback((id) => {
    setCells(prev => prev.map(c => c.id === id ? { ...c, active: false } : c))
  }, [])

  // ── OBZ / OBF import ──────────────────────────────────────────────────────
  const importOBZFile = useCallback(async (file) => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const newBoardSet = await loadOBZFile(file)
      boardSetRef.current = newBoardSet
      _populateLegacyMaps(newBoardSet)

      const rootBoard = await newBoardSet.getBoard(newBoardSet.rootId)
      if (!rootBoard) throw new Error('Root board not found in imported .obz')

      const rawCells = boardModelToCells(rootBoard)
      const staged   = applyStage(rawCells, stage, customVocabIds)
      setCells(staged)
      setCols(rootBoard.columns)
      setRows(rootBoard.rows)
      setActiveBoardId(newBoardSet.rootId)
      setIsLoading(false)
      console.log(`[VocabularyContext] Imported .obz: ${newBoardSet.boards.size} boards, root="${newBoardSet.rootId}"`)
    } catch (err) {
      setLoadError(err.message)
      setIsLoading(false)
      console.error('[VocabularyContext] .obz import failed:', err)
    }
  }, [stage, customVocabIds])

  const importOBFUrl = useCallback(async (url) => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const board = await loadOBFFromUrl(url)
      // Single-board import: create a minimal board set
      const singleSet = {
        manifest: { root: `${board.id}.obf`, paths: { boards: { [board.id]: `${board.id}.obf` } } },
        boards: new Map([[board.id, board]]),
        rootId: board.id,
        boardPaths: { [board.id]: `${board.id}.obf` },
        async getBoard(id) { return this.boards.get(id) ?? null }
      }
      boardSetRef.current = singleSet
      _populateLegacyMaps(singleSet)

      const rawCells = boardModelToCells(board)
      const staged   = applyStage(rawCells, stage, customVocabIds)
      setCells(staged)
      setCols(board.columns)
      setRows(board.rows)
      setActiveBoardId(board.id)
      setIsLoading(false)
    } catch (err) {
      setLoadError(err.message)
      setIsLoading(false)
    }
  }, [stage, customVocabIds])

  // ── OBZ export ────────────────────────────────────────────────────────────
  const exportBoards = useCallback(async () => {
    const boardSet = boardSetRef.current
    if (!boardSet) return
    try {
      const { boardsToOBZ, downloadOBZ } = await import('@engine/OBFExporter')
      const zip = boardsToOBZ(boardSet)
      downloadOBZ(zip, 'gazeaac-boards.obz')
    } catch (err) {
      console.error('[VocabularyContext] Export failed:', err)
    }
  }, [])

  // ── Derived ───────────────────────────────────────────────────────────────
  const activeCells = useMemo(() => cells.filter(c => c.active), [cells])

  return (
    <VocabularyContext.Provider value={{
      cells,
      activeCells,
      stage,
      activePage,
      rootBoardId,
      cols,
      rows,
      isLoading,
      loadError,
      unmaskCell,
      maskCell,
      setStage,
      resetGrid,
      navigateTo,
      goBack,
      goHome,
      importOBZFile,
      importOBFUrl,
      exportBoards,
      get boardSet() { return boardSetRef.current }
    }}>
      {children}
    </VocabularyContext.Provider>
  )
}

export function useVocabulary() {
  const ctx = useContext(VocabularyContext)
  if (!ctx) throw new Error('useVocabulary must be used within VocabularyProvider')
  return ctx
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Populate the legacy NAV_VERB_PAGES and PAGE_META exports from the loaded
 * board set. These are mutated in-place so that existing import sites pick up
 * the values without a module reload.
 */
function _populateLegacyMaps(boardSet) {
  // Clear existing entries
  for (const k of Object.keys(NAV_VERB_PAGES)) delete NAV_VERB_PAGES[k]
  // Keep home
  PAGE_META['home'] = { label: 'Home', icon: '🏠' }

  // For each non-home board in the set, we expose its id as a "page" so that
  // NavBreadcrumb can show a label for it.
  const boards = boardSet.boards instanceof Map ? boardSet.boards : new Map()
  for (const [boardId, board] of boards) {
    if (boardId === 'lamp-home' || boardId === HOME_BOARD_ID) continue

    // Derive a short page key from the board id (strip "lamp-" prefix)
    const pageKey = boardId.replace(/^lamp-/, '')
    const name    = board.name ?? boardId

    // Populate PAGE_META
    PAGE_META[pageKey] = {
      label: board.name?.replace(/^LAMP WFL — /, '') ?? pageKey,
      icon:  _guessPageIcon(pageKey)
    }
    PAGE_META[boardId] = PAGE_META[pageKey]

    // NAV_VERB_PAGES: upper-case label → board id
    // This is only needed for backward compat in App.jsx's handleActivate
    // (the OBF native path uses cell.loadBoardId directly).
    NAV_VERB_PAGES[pageKey.toUpperCase()] = boardId
  }
}

/** Emoji icon guesses for well-known LAMP page keys */
function _guessPageIcon(pageKey) {
  const icons = {
    eat:'🍽',drink:'🥤',go:'🏃',play:'🎮',make:'🛠',look:'👀',
    talk:'💬',come:'🐾',love:'❤️',color:'🎨',time:'⏰',like:'😊',
    want:'🤲',feel:'💭',have:'🤲',read:'📖',work:'💼',do:'⚡',
    get:'🖐',hear:'👂',think:'🤔',live:'🏠',find:'🔍',need:'❗',
    watch:'📺',sit:'🪑',sleep:'😴'
  }
  return icons[pageKey] ?? '📋'
}

/**
 * Emergency fallback: load legacy JSON imports if the OBF manifest fetch fails
 * (e.g. in tests or when public/vocabulary/obf/ hasn't been generated yet).
 */
async function _loadFallback(stage, customVocabIds, setCells, setCols, setRows, setIsLoading, setLoadError) {
  try {
    const [lamp84Mod, lampPagesMod] = await Promise.all([
      import('../vocabulary/lamp_84.json'),
      import('../vocabulary/lamp_pages.json')
    ])
    const lamp84    = lamp84Mod.default
    const _lampPages = lampPagesMod.default  // eslint-disable-line no-unused-vars

    // Build cells from legacy format
    const COLS = 12
    const ROWS = 7
    const STAGE_2_ACTIVE = new Set([
      'r1c1','r1c5','r1c6','r1c8','r2c1','r3c1','r4c1','r5c2','r6c1',
      'r2c5','r4c10','r4c12','r5c12','r5c3','r5c8','r7c5','r7c9','r5c10','r7c1'
    ])

    let activeSet
    if (stage === 1) {
      const ids = customVocabIds.length > 0 ? customVocabIds : ['r5c3','r4c10','r4c12','r7c1']
      activeSet = new Set(ids)
    } else if (stage === 2) {
      activeSet = STAGE_2_ACTIVE
    } else {
      activeSet = new Set(Object.keys(lamp84).filter(id => lamp84[id]?.label !== ''))
    }

    const cells = []
    for (let row = 1; row <= ROWS; row++) {
      for (let col = 1; col <= COLS; col++) {
        const id    = `r${row}c${col}`
        const entry = lamp84[id]
        cells.push({
          id,
          label:       entry?.label    ?? '',
          icon:        entry?.icon     ?? null,
          category:    entry?.category ?? 'empty',
          baseRow:     row,
          baseCol:     col,
          active:      activeSet.has(id),
          action:      entry?.category === 'utility' ? entry.label.toLowerCase() : null,
          loadBoardId: null
        })
      }
    }

    // Populate legacy NAV_VERB_PAGES from hardcoded list
    const NAV_MAP = {
      'PLAY':'play','LIKE':'like','WORK':'work','HAVE':'have','FEEL':'feel',
      'READ':'read','WANT':'want','COME':'come','DO':'do','GO':'go','GET':'get',
      'LOOK':'look','HEAR':'hear','THINK':'think','LIVE':'live','LOVE':'love',
      'TALK':'talk','SIT':'sit','EAT':'eat','FIND':'find','MAKE':'make',
      'NEED':'need','DRINK':'drink','WATCH':'watch','SLEEP':'sleep',
      'COLOR':'color','TIME':'time'
    }
    for (const [k,v] of Object.entries(NAV_MAP)) {
      NAV_VERB_PAGES[k] = `lamp-${v}`
    }

    setCells(cells)
    setCols(COLS)
    setRows(ROWS)
    setIsLoading(false)
    setLoadError('OBF manifest not found — using legacy vocabulary (run: node scripts/generate_obf.mjs)')
    console.warn('[VocabularyContext] Using legacy JSON fallback — OBF files may not be in public/vocabulary/obf/')
  } catch (err) {
    setIsLoading(false)
    setLoadError(`Failed to load vocabulary: ${err.message}`)
  }
}
