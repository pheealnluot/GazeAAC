import { useState, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useAACBoards } from '@context/AACBoardContext'
import './BoardSelector.css'

/**
 * BoardSelector — Full-screen overlay for choosing a pre-loaded AAC board.
 *
 * Shows only the **root (main) board** of each .obz file.
 * Linked sub-boards are never surfaced here.
 *
 * Props:
 *   open        {boolean}
 *   onClose     {() => void}
 *   onEdit      {(libraryId: string) => void}  — open BoardEditor for this entry
 */
export function BoardSelector({ open, onClose, onEdit }) {
  const { library, isLoading, loadingBoardId, activeLibraryId, selectBoard } = useAACBoards()
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return library
    return library.filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.fileName.toLowerCase().includes(q)
    )
  }, [library, search])

  if (!open) return null

  const handleSelect = async (id) => {
    await selectBoard(id)  // may load from disk first
    onClose()
  }

  const overlay = (
    <div className="bsel__backdrop" role="dialog" aria-modal="true" aria-label="Select AAC Board">
      <div className="bsel">
        {/* Header */}
        <header className="bsel__header">
          <div className="bsel__header-left">
            <span className="bsel__header-icon" aria-hidden="true">📋</span>
            <div>
              <h2 className="bsel__title">AAC Board Library</h2>
              <p className="bsel__subtitle">Select a pre-loaded board to use on the grid</p>
            </div>
          </div>
          <button className="bsel__close" onClick={onClose} aria-label="Close board selector">✕</button>
        </header>

        {/* Search */}
        <div className="bsel__search-row">
          <div className="bsel__search-wrap">
            <span className="bsel__search-icon" aria-hidden="true">🔍</span>
            <input
              className="bsel__search"
              type="text"
              placeholder="Search boards…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Search boards"
            />
            {search && (
              <button className="bsel__search-clear" onClick={() => setSearch('')} aria-label="Clear search">✕</button>
            )}
          </div>
          <span className="bsel__count">{filtered.length} board{filtered.length !== 1 ? 's' : ''}</span>
        </div>

        {/* Board grid */}
        <div className="bsel__body">
          {isLoading && (
            <div className="bsel__loading">
              <div className="bsel__spinner" />
              <span>Loading board library…</span>
            </div>
          )}

          {!isLoading && filtered.length === 0 && (
            <div className="bsel__empty">
              {library.length === 0
                ? 'No boards found in AACBoards/ directory.'
                : 'No boards match your search.'}
            </div>
          )}

          {!isLoading && filtered.length > 0 && (
            <div className="bsel__grid">
              {filtered.map(entry => (
                <BoardCard
                  key={entry.id}
                  entry={entry}
                  isActive={entry.id === activeLibraryId}
                  isLoadingThis={entry.id === loadingBoardId}
                  onSelect={() => handleSelect(entry.id)}
                  onEdit={() => { onEdit?.(entry.id); onClose() }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}

// ─── Board Card ───────────────────────────────────────────────────────────────

function BoardCard({ entry, isActive, isLoadingThis, onSelect, onEdit }) {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let interval;
    if (isLoadingThis) {
      setProgress(0);
      interval = setInterval(() => {
        setProgress(p => {
          // Asymptotic progress: quickly up to 80, then slower
          if (p < 50) return p + Math.floor(Math.random() * 15) + 5;
          if (p < 80) return p + Math.floor(Math.random() * 5) + 2;
          if (p < 95) return p + 1;
          return p;
        });
      }, 200);
    } else {
      setProgress(100);
    }
    return () => clearInterval(interval);
  }, [isLoadingThis]);
  // Sample the first few buttons from the root board for the thumbnail
  const thumbCells = useMemo(() => {
    const board = entry.boardSet?.boards?.get(entry.rootId)
    if (!board) return []
    const cells = []
    const order = board.order ?? []
    for (let r = 0; r < Math.min(3, order.length); r++) {
      const row = order[r] ?? []
      for (let c = 0; c < Math.min(6, row.length); c++) {
        const btnId = row[c]
        const btn = btnId ? board.buttonMap.get(btnId) : null
        if (btn?.label) {
          cells.push({
            id: btnId,
            label: btn.label,
            bg: btn.background_color ?? null
          })
        }
      }
    }
    return cells.slice(0, 12)
  }, [entry])

  return (
    <div
      className={`bsel__card ${isActive ? 'bsel__card--active' : ''}`}
      role="article"
    >
      {isActive && <div className="bsel__active-badge">✓ Active</div>}

      {/* Thumbnail */}
      <div className="bsel__thumb" aria-hidden="true">
        {isLoadingThis ? (
          <div className="bsel__thumb-loading">
            <div className="bsel__spinner" />
            <span>Loading…</span>
          </div>
        ) : thumbCells.length > 0 ? (
          <div className="bsel__thumb-grid">
            {thumbCells.map((cell, i) => (
              <div
                key={i}
                className="bsel__thumb-cell"
                style={cell.bg ? { backgroundColor: cell.bg } : undefined}
                title={cell.label}
              >
                {cell.label.slice(0, 6)}
              </div>
            ))}
          </div>
        ) : (
          <div className="bsel__thumb-placeholder">
            {entry.loaded ? '📋' : '📦'}
            {!entry.loaded && <span className="bsel__not-loaded-hint">Click to load</span>}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="bsel__card-body">
        <h3 className="bsel__card-name">{entry.name}</h3>
        <p className="bsel__card-meta">
          {entry.loaded
            ? `${entry.columns}×${entry.rows} · ${entry.buttonCount} buttons`
            : <span className="bsel__not-loaded-tag">Not yet loaded</span>
          }
        </p>
        <p className="bsel__card-file">{entry.fileName}</p>
      </div>

      {/* Actions */}
      <div className="bsel__card-actions">
        <button
          className={`bsel__btn ${isActive ? 'bsel__btn--active' : 'bsel__btn--primary'} ${isLoadingThis ? 'bsel__btn--loading' : ''}`}
          onClick={onSelect}
          disabled={isLoadingThis}
          aria-label={`Select board ${entry.name}`}
          style={isLoadingThis ? { '--progress': `${progress}%` } : undefined}
        >
          {isLoadingThis ? (
            <div className="bsel__loading-content">
              <span>⏳ Loading…</span>
              <span className="bsel__counter">{progress}%</span>
            </div>
          ) : isActive ? '✓ Selected' : entry.loaded ? '▶ Select' : '⬇ Load & Select'}
        </button>
        <button
          className="bsel__btn bsel__btn--outline"
          onClick={onEdit}
          disabled={!entry.loaded || isLoadingThis}
          aria-label={`Edit board ${entry.name}`}
        >
          ✏ Edit
        </button>
      </div>
    </div>
  )
}
