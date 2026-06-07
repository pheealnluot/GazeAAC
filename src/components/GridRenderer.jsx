import { useMemo, useRef, useEffect, useCallback } from 'react'
import { useVocabulary } from '@context/VocabularyContext'
import { useGazeSettings } from '@context/GazeSettingsContext'
import { useAACBoards } from '@context/AACBoardContext'
import { solveHitBoxes } from '@engine/HitBoxSolver'
import { GazeButton } from './GazeButton'
import './GridRenderer.css'

/**
 * GridRenderer – Renders the 12×7 LAMP vocabulary grid.
 *
 * Milestone 2 upgrades:
 *   1. Hit-box span assignment uses HitBoxSolver (constraint-solver) instead
 *      of the M1 greedy right-then-down algorithm.
 *   2. After every layout paint (and on window resize), the renderer measures
 *      each GazeButton's actual pixel rect via getBoundingClientRect() and
 *      emits normalized [0,1] cell boundaries to the parent via onGridMeasured.
 *      This gives TelemetryRouter pixel-accurate hit boxes regardless of margins,
 *      speech bars, or any other layout offsets.
 *
 * Props:
 *   gazeState       {{ cellId: string|null, dwellProgress: number }}
 *   onActivate      (cellId: string) => void
 *   onGridMeasured  (cells: NormalizedCell[]) => void   ← NEW in M2
 *
 * NormalizedCell:
 *   { id: string, x0: number, y0: number, x1: number, y1: number }
 *   All coordinates in [0, 1], relative to window.innerWidth / window.innerHeight.
 */
export function GridRenderer({
  gazeState = {},
  onActivate,
  onGridMeasured,
  onMeasureTriggerReady,
  cells: customCells,
  cols: customCols,
  rows: customRows,
  isLoading: customIsLoading,
  cellIdPrefix = ''
}) {
  const vocab = useVocabulary()
  const { settings } = useGazeSettings()

  const cells = customCells ?? vocab.cells
  const isLoading = customIsLoading ?? vocab.isLoading
  const COLS = customCols ?? vocab.cols ?? 12
  const ROWS = customRows ?? vocab.rows ?? 7

  // Apply board edit deltas (from AACBoardContext) to cells before rendering
  let aacBoardCtx = null
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    aacBoardCtx = useAACBoards()
  } catch { /* not wrapped — ok */ }

  const activeCells = useMemo(() => {
    if (customCells) return customCells
    if (!aacBoardCtx) return cells
    const entry = aacBoardCtx.library.find(e => e.id === aacBoardCtx.activeLibraryId)
    if (!entry) return cells
    return aacBoardCtx.applyEdits(cells, entry.fileName, entry.rootId)
  }, [cells, aacBoardCtx, customCells])

  const gridRef = useRef(null)

  // ── Derive numeric multiplier from setting ─────────────────────────────────
  // 'full' → Infinity (no cap)   '3x' → 3   '2x' → 2   '1x' → 1
  const maxSpanMultiplier = useMemo(() => {
    if (settings.unmaskedBoxSize === '1x') return 1
    if (settings.unmaskedBoxSize === '2x') return 2
    if (settings.unmaskedBoxSize === '3x') return 3
    return Infinity // 'full'
  }, [settings.unmaskedBoxSize])

  // M4: icon visibility setting
  const showIcons = settings.showIcons ?? true

  // ── Constraint-solver: compute spans ──────────────────────────────────────
  const spanMap = useMemo(() => {
    return solveHitBoxes(activeCells, COLS, ROWS, maxSpanMultiplier)
  }, [activeCells, COLS, ROWS, maxSpanMultiplier])

  // ── Layout cells list ──────────────────────────────────────────────────────
  // Tracks which cells have been consumed by a span so placeholders are skipped.
  const { layoutCells } = useMemo(() => {
    const consumed = new Set()
    const layoutCells = []

    for (let row = 1; row <= ROWS; row++) {
      for (let col = 1; col <= COLS; col++) {
        const id = `r${row}c${col}`
        if (consumed.has(id)) continue

        const cell = activeCells.find(c => c.id === id)
        const spans = spanMap.get(id) ?? { spanCols: 1, spanRows: 1 }

        // Mark all cells covered by this span as consumed
        for (let dr = 0; dr < spans.spanRows; dr++) {
          for (let dc = 0; dc < spans.spanCols; dc++) {
            consumed.add(`r${row + dr}c${col + dc}`)
          }
        }

        layoutCells.push({ ...cell, ...spans })
      }
    }

    return { layoutCells }
  }, [activeCells, spanMap, ROWS, COLS])

  // ── DOM measurement: getBoundingClientRect → normalized coords ─────────────
  const measureGrid = useCallback(() => {
    if (!gridRef.current || !onGridMeasured) return

    const buttons = gridRef.current.querySelectorAll('[data-cell-id]')
    if (!buttons.length) return

    const vw = window.innerWidth
    const vh = window.innerHeight

    const normalizedCells = []
    buttons.forEach(el => {
      const id = el.getAttribute('data-cell-id')
      if (!id) return
      const rect = el.getBoundingClientRect()
      normalizedCells.push({
        id,
        x0: rect.left   / vw,
        y0: rect.top    / vh,
        x1: rect.right  / vw,
        y1: rect.bottom / vh
      })
    })

    if (normalizedCells.length > 0) {
      console.log(`[GridRenderer] Measured ${normalizedCells.length} active cells via getBoundingClientRect`)
      onGridMeasured(normalizedCells)
    }
  }, [onGridMeasured])

  // ── ResizeObserver: re-measure on layout changes ───────────────────────────
  useEffect(() => {
    if (!gridRef.current) return

    // Initial measurement after first paint
    // Use a short delay to ensure CSS layout is settled
    const rafId = requestAnimationFrame(() => {
      setTimeout(measureGrid, 0)
    })

    const observer = new ResizeObserver(() => {
      measureGrid()
    })
    observer.observe(gridRef.current)

    // Also re-measure on window resize (catches viewport-level changes)
    window.addEventListener('resize', measureGrid)

    return () => {
      cancelAnimationFrame(rafId)
      observer.disconnect()
      window.removeEventListener('resize', measureGrid)
    }
  }, [measureGrid])

  // ── Expose measureGrid to parent via onMeasureTriggerReady ────────────────
  // This lets App.jsx call measureGrid() right after creating a new router so
  // the cell registry is populated before the first gaze frame arrives.
  useEffect(() => {
    onMeasureTriggerReady?.(measureGrid)
  }, [measureGrid, onMeasureTriggerReady])

  // Re-measure whenever the cell layout changes (stage switch, mask toggle)
  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      setTimeout(measureGrid, 0)
    })
    return () => cancelAnimationFrame(rafId)
  }, [layoutCells, measureGrid])

  const { cellId: gazedCellId, dwellProgress = 0 } = gazeState

  // ── Skeleton loader while lexicon is fetching ──────────────────────────────
  if (isLoading) {
    return (
      <div
        className="grid-renderer grid-renderer--loading"
        role="status"
        aria-label="Loading vocabulary…"
        style={{ '--grid-cols': COLS, '--grid-rows': ROWS }}
      >
        {Array.from({ length: COLS * ROWS }).map((_, i) => (
          <div key={i} className="grid-renderer__skeleton-cell" aria-hidden="true" />
        ))}
      </div>
    )
  }

  return (
    <div
      ref={gridRef}
      className="grid-renderer"
      role="grid"
      aria-label="LAMP Vocabulary Grid"
      style={{
        '--grid-cols': COLS,
        '--grid-rows': ROWS,
        '--board-font-scale': settings.fontScale ?? 1.0,
        '--board-symbol-scale': settings.symbolScale ?? 1.0,
        '--grid-font-color': settings.gridFontColor ?? '#ffffff',
      }}
    >
      {layoutCells.map(cell => {
        // ── Centering anchor for capped spans ─────────────────────────────
        // When the hit-box is larger than 1×1, the expanded button's top-left
        // sits at the native cell position. We want the label & dwell ring to
        // remain visually centered on that native cell — so we pass the fraction
        // of the button width/height where the native cell's center falls.
        //
        // Native cell center within the expanded button:
        //   x = (0.5 cell) / (spanCols cells) = 1/(2*spanCols)  → as percentage
        //   y = (0.5 cell) / (spanRows cells) = 1/(2*spanRows)
        //
        // In 'full' mode all spans can be arbitrary, so we always pass the
        // anchor so the content anchors correctly even for large natural spans.
        const anchorX = 50 / cell.spanCols   // percent from left
        const anchorY = 50 / cell.spanRows   // percent from top
        const prefixedId = `${cellIdPrefix}${cell.id}`

        return (
          <GazeButton
            key={cell.id}
            cellId={prefixedId}
            label={cell.label}
            icon={cell.icon}
            active={cell.active}
            category={cell.category}
            spanCols={cell.spanCols}
            spanRows={cell.spanRows}
            isGazed={prefixedId === gazedCellId}
            dwellProgress={prefixedId === gazedCellId ? dwellProgress : 0}
            onActivate={onActivate}
            contentAnchorX={anchorX}
            contentAnchorY={anchorY}
            showIcons={showIcons}
            backgroundColor={cell.backgroundColor ?? null}
            borderColor={cell.borderColor ?? null}
            textColor={cell.textColor ?? null}
            capitalisation={cell.capitalisation ?? null}
            imageUrl={cell.imageUrl ?? null}
            soundUrl={cell.soundUrl ?? null}
            loadBoardId={cell.loadBoardId ?? null}
            symbolScale={settings.symbolScale ?? 1.0}
            symbolOnTop={settings.symbolOnTop ?? false}
            dwellRingOpacity={settings.dwellProgressOpacity ?? 1.0}
          />
        )
      })}
    </div>
  )
}
