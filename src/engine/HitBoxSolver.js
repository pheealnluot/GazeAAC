/**
 * HitBoxSolver — Constraint-solver for LAMP grid hit-box expansion.
 *
 * Replaces the greedy right-then-down algorithm from Milestone 1 with a
 * maximal-rectangle approach that correctly handles arbitrary masking
 * configurations: L-shapes, islands, split corridors, etc.
 *
 * Algorithm overview (three passes):
 *   1. Build an "availability grid": avail[r][c] = true if the cell at (r,c)
 *      is masked (inactive) and therefore claimable by an adjacent active cell.
 *   2. For each active cell, compute the maximal axis-aligned rectangle that:
 *        a. Has the active cell as its top-left corner.
 *        b. Contains only claimable (masked) space beyond the active cell itself.
 *        c. Does not cross the boundary of another active cell.
 *      This uses the classic O(cols) stack-based histogram algorithm per row.
 *   3. Sort active cells by rectangle area (descending). Assign spans greedily
 *      from largest to smallest, marking claimed cells as unavailable so
 *      subsequent smaller claims cannot overlap.
 *
 * The Geometric Anchor Rule (VOCABULARY_ENGINE §2.1) is preserved:
 *   The solver only ever expands a cell's span rightward from baseCol and
 *   downward from baseRow — the top-left of every span is always the cell's
 *   own (baseRow, baseCol).
 *
 * @module HitBoxSolver
 */

/**
 * Solve span assignments for all cells in a 12×7 LAMP grid.
 *
 * @param {Array<{
 *   id: string,
 *   baseRow: number,
 *   baseCol: number,
 *   active: boolean
 * }>} cells — Full 84-cell array (active + masked).
 *
 * @param {number} COLS — Grid column count (12).
 * @param {number} ROWS — Grid row count (7).
 *
 * @param {number} [maxSpanMultiplier=Infinity]
 *   Maximum span in each axis expressed as a multiple of the native 1×1 cell.
 *   Pass 2 for "2×" mode, 3 for "3×" mode, Infinity (default) for full expansion.
 *
 * @returns {Map<string, { spanCols: number, spanRows: number }>}
 *   Map from cell id → computed span. Every cell gets an entry;
 *   masked cells always get { spanCols: 1, spanRows: 1 }.
 */
export function solveHitBoxes(cells, COLS, ROWS, maxSpanMultiplier = Infinity) {
  // ── 1. Build availability grid (1-indexed for readability) ─────────────────
  // avail[r][c] === true  → masked cell, can be claimed
  // avail[r][c] === false → active cell (boundary), cannot be overwritten
  const avail = buildAvailabilityGrid(cells, COLS, ROWS)

  // ── 2. Compute maximal rectangle for every active cell ─────────────────────
  const activeCells = cells.filter(c => c.active)

  const candidates = activeCells.map(cell => {
    const { spanCols, spanRows } = maximalRectangle(cell.baseRow, cell.baseCol, avail, COLS, ROWS)
    return { cell, spanCols, spanRows, area: spanCols * spanRows }
  })

  // ── 3. Sort by area descending, assign spans, mark claimed cells ────────────
  candidates.sort((a, b) => b.area - a.area)

  // Claimed grid: tracks which cells have been assigned to a span already
  const claimed = Array.from({ length: ROWS + 1 }, () =>
    new Array(COLS + 1).fill(false)
  )
  // Mark all active cells as claimed in their own position immediately
  activeCells.forEach(c => { claimed[c.baseRow][c.baseCol] = true })

  const spanMap = new Map()

  for (const { cell, spanCols: maxSC, spanRows: maxSR } of candidates) {
    // Apply the per-axis multiplier cap before solving the constrained span.
    // This keeps the hit-box bounded to n× the native cell size.
    const cappedSC = isFinite(maxSpanMultiplier) ? Math.min(maxSC, maxSpanMultiplier) : maxSC
    const cappedSR = isFinite(maxSpanMultiplier) ? Math.min(maxSR, maxSpanMultiplier) : maxSR

    // Re-compute the actual achievable span given current claimed state
    // (a prior larger-area cell may have already consumed some space)
    const { spanCols, spanRows } = constrainedSpan(
      cell.baseRow, cell.baseCol, cappedSC, cappedSR, claimed, avail, COLS, ROWS
    )

    spanMap.set(cell.id, { spanCols, spanRows })

    // Mark all cells in this span as claimed
    for (let dr = 0; dr < spanRows; dr++) {
      for (let dc = 0; dc < spanCols; dc++) {
        claimed[cell.baseRow + dr][cell.baseCol + dc] = true
      }
    }
  }

  // Masked cells get default 1×1 spans
  cells.forEach(c => {
    if (!c.active && !spanMap.has(c.id)) {
      spanMap.set(c.id, { spanCols: 1, spanRows: 1 })
    }
  })

  return spanMap
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Build a 2-D boolean array (1-indexed) where true = available (masked cell).
 * Active cells are marked false so they act as hard boundaries.
 */
function buildAvailabilityGrid(cells, COLS, ROWS) {
  const grid = Array.from({ length: ROWS + 1 }, () =>
    new Array(COLS + 1).fill(false)
  )
  const activeSet = new Set(cells.filter(c => c.active).map(c => c.id))

  for (let r = 1; r <= ROWS; r++) {
    for (let c = 1; c <= COLS; c++) {
      const id = `r${r}c${c}`
      // A cell is "available to expand into" only when it is masked
      grid[r][c] = !activeSet.has(id)
    }
  }

  return grid
}

/**
 * Compute the maximal rectangle reachable from (startRow, startCol)
 * expanding only rightward and downward through available (masked) cells.
 *
 * The active cell itself is always included (span ≥ 1×1).
 *
 * Uses the histogram approach: for each row below the start, compute how many
 * consecutive available columns exist starting at startCol, then track the
 * minimum width across rows to find the tallest possible rectangle.
 *
 * @returns {{ spanCols: number, spanRows: number }}
 */
function maximalRectangle(startRow, startCol, avail, COLS, ROWS) {
  let bestArea = 1
  let bestSC = 1
  let bestSR = 1

  let minWidth = COLS - startCol + 1 // maximum possible width

  for (let r = startRow; r <= ROWS; r++) {
    if (r > startRow && !avail[r][startCol]) {
      // The cell directly below is another active cell — stop expanding down
      break
    }

    // Count how many consecutive claimable columns exist from startCol
    let width = 0
    for (let c = startCol; c <= COLS; c++) {
      // For the starting row, the active cell itself counts (not "avail")
      const cellOk = (r === startRow && c === startCol) || avail[r][c]
      // Stop if we hit an active cell that isn't our origin
      if (!cellOk) break
      width++
    }

    // Narrow down to the minimum width seen across all rows so far
    minWidth = Math.min(minWidth, width)
    if (minWidth === 0) break

    const height = r - startRow + 1
    const area = minWidth * height

    if (area > bestArea) {
      bestArea = area
      bestSC = minWidth
      bestSR = height
    }
  }

  return { spanCols: bestSC, spanRows: bestSR }
}

/**
 * Given a previously computed (maxSC, maxSR) span, re-verify that no cell
 * in the target rectangle has already been claimed by a higher-priority span.
 * Shrinks the span conservatively (width first, then height).
 *
 * @returns {{ spanCols: number, spanRows: number }}
 */
function constrainedSpan(startRow, startCol, maxSC, maxSR, claimed, avail, COLS, ROWS) {
  let spanCols = 1
  let spanRows = 1

  // Walk row by row, expanding height as long as the full width is free
  for (let dr = 0; dr < maxSR; dr++) {
    const r = startRow + dr
    if (r > ROWS) break

    // Determine the actual claimable width in this row
    let rowWidth = 0
    for (let dc = 0; dc < maxSC; dc++) {
      const c = startCol + dc
      if (c > COLS) break
      const isOrigin = dr === 0 && dc === 0
      const free = isOrigin || (!claimed[r][c] && avail[r][c])
      if (!free) break
      rowWidth++
    }

    if (dr === 0) {
      spanCols = rowWidth // width is locked to row-0 claimable width
    } else {
      // Subsequent rows can only use the minimum of what they offer
      spanCols = Math.min(spanCols, rowWidth)
      if (spanCols === 0) break
    }

    spanRows = dr + 1
  }

  return { spanCols: Math.max(spanCols, 1), spanRows: Math.max(spanRows, 1) }
}
