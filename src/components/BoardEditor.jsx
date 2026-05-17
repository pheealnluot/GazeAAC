import { useState, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useAACBoards } from '@context/AACBoardContext'
import { boardModelToCells } from '@engine/OBFParser'
import './BoardEditor.css'

/**
 * BoardEditor — Full-screen editor for a single AAC board entry.
 *
 * Shows all buttons in a mini grid. Clicking a button cell opens a
 * ButtonEditPanel on the right with fields for every OBF visual attribute.
 *
 * Props:
 *   open         {boolean}
 *   libraryId    {string|null}    — which LibraryEntry to edit
 *   onClose      {() => void}
 */
export function BoardEditor({ open, libraryId, onClose }) {
  const { library, boardEdits, saveButtonEdit, resetButtonEdit } = useAACBoards()

  const [selectedBtnId, setSelectedBtnId] = useState(null)
  const [pendingEdits, setPendingEdits]   = useState({})  // btnId → patch
  const [saveMsg, setSaveMsg]             = useState(null)

  const entry = library.find(e => e.id === libraryId)

  // Get the root board model
  const rootBoard = useMemo(() => {
    if (!entry) return null
    return entry.boardSet?.boards?.get(entry.rootId) ?? null
  }, [entry])

  // Build all cells for the mini grid (no stage masking — show everything)
  const allCells = useMemo(() => {
    if (!rootBoard) return []
    const cells = boardModelToCells(rootBoard)
    return cells.map(c => ({ ...c, active: !!c.label }))
  }, [rootBoard])

  // Selected cell with persisted + pending edits merged
  const selectedCell = useMemo(() => {
    if (!selectedBtnId || !entry) return null
    const baseCell = allCells.find(c => c._btnId === selectedBtnId) ?? null
    if (!baseCell) return null
    const editKey = `${entry.fileName}:${entry.rootId}:${selectedBtnId}`
    const persisted = boardEdits[editKey] ?? {}
    const pending   = pendingEdits[selectedBtnId] ?? {}
    return { ...baseCell, ...persisted, ...pending }
  }, [selectedBtnId, allCells, boardEdits, pendingEdits, entry])

  const handleCellClick = useCallback((btnId) => {
    setSelectedBtnId(prev => prev === btnId ? null : btnId)
  }, [])

  const handlePatchChange = useCallback((btnId, field, value) => {
    setPendingEdits(prev => ({
      ...prev,
      [btnId]: { ...(prev[btnId] ?? {}), [field]: value }
    }))
  }, [])

  const handleSave = async () => {
    if (!entry || Object.keys(pendingEdits).length === 0) return
    setSaveMsg(null)
    try {
      for (const [btnId, patch] of Object.entries(pendingEdits)) {
        await saveButtonEdit(entry.fileName, entry.rootId, btnId, patch)
      }
      setPendingEdits({})
      setSaveMsg({ type: 'success', text: `✓ ${Object.keys(pendingEdits).length} button edit(s) saved!` })
      setTimeout(() => setSaveMsg(null), 2500)
    } catch (err) {
      setSaveMsg({ type: 'error', text: `Save failed: ${err.message}` })
    }
  }

  const handleReset = async (btnId) => {
    if (!entry) return
    await resetButtonEdit(entry.fileName, entry.rootId, btnId)
    setPendingEdits(prev => {
      const next = { ...prev }
      delete next[btnId]
      return next
    })
  }

  if (!open || !entry) return null

  const cols = rootBoard?.columns ?? 12
  const rows = rootBoard?.rows ?? 7
  const pendingCount = Object.keys(pendingEdits).length

  const overlay = (
    <div className="bed__backdrop" role="dialog" aria-modal="true" aria-label="Edit AAC Board">
      <div className="bed">

        {/* ── Header ───────────────────────────────────────────────────── */}
        <header className="bed__header">
          <div className="bed__header-left">
            <span className="bed__header-icon" aria-hidden="true">✏️</span>
            <div>
              <h2 className="bed__title">Edit Board: {entry.name}</h2>
              <p className="bed__subtitle">{entry.fileName} · {cols}×{rows} · {entry.buttonCount} buttons</p>
            </div>
          </div>
          <div className="bed__header-actions">
            {pendingCount > 0 && (
              <button className="bed__save-btn" onClick={handleSave}>
                💾 Save {pendingCount} Change{pendingCount !== 1 ? 's' : ''}
              </button>
            )}
            <button className="bed__close" onClick={onClose} aria-label="Close editor">✕</button>
          </div>
        </header>

        {saveMsg && (
          <div className={`bed__msg bed__msg--${saveMsg.type}`} role="alert">
            {saveMsg.text}
          </div>
        )}

        {/* ── Body ─────────────────────────────────────────────────────── */}
        <div className="bed__body">

          {/* Mini grid */}
          <div className="bed__grid-panel">
            <p className="bed__grid-hint">Click a button cell to edit it</p>
            <div
              className="bed__mini-grid"
              style={{ '--bed-cols': cols, '--bed-rows': rows }}
            >
              {allCells.map(cell => {
                const isSelected  = cell._btnId === selectedBtnId
                const editKey     = entry ? `${entry.fileName}:${entry.rootId}:${cell._btnId}` : null
                const hasPersistedEdit = editKey && boardEdits[editKey] !== undefined
                const hasPendingEdit  = cell._btnId && pendingEdits[cell._btnId] !== undefined

                // Merge edits for colour preview
                const persisted = editKey ? (boardEdits[editKey] ?? {}) : {}
                const pending   = cell._btnId ? (pendingEdits[cell._btnId] ?? {}) : {}
                const merged    = { ...cell, ...persisted, ...pending }

                return (
                  <button
                    key={cell.id}
                    className={[
                      'bed__cell',
                      !cell.label  ? 'bed__cell--empty'    : '',
                      isSelected   ? 'bed__cell--selected' : '',
                      hasPersistedEdit || hasPendingEdit ? 'bed__cell--edited' : ''
                    ].filter(Boolean).join(' ')}
                    style={{
                      ...(merged.backgroundColor ? { backgroundColor: merged.backgroundColor } : {}),
                      ...(merged.borderColor     ? { borderColor: merged.borderColor } : {}),
                      ...(merged.textColor       ? { color: merged.textColor } : {}),
                    }}
                    onClick={() => cell.label && handleCellClick(cell._btnId)}
                    disabled={!cell.label}
                    title={cell.label || 'empty'}
                    aria-pressed={isSelected}
                  >
                    {merged.imageUrl && (
                      <img
                        className="bed__cell-img"
                        src={merged.imageUrl}
                        alt=""
                        aria-hidden="true"
                      />
                    )}
                    {!merged.imageUrl && merged.icon && (
                      <span className="bed__cell-icon" aria-hidden="true">{merged.icon}</span>
                    )}
                    <span className="bed__cell-label">
                      {_applyCapitalisation(merged.label, merged.capitalisation)}
                    </span>
                    {(hasPersistedEdit || hasPendingEdit) && (
                      <span className="bed__cell-edit-dot" aria-hidden="true" />
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Edit panel */}
          <div className="bed__edit-panel">
            {!selectedCell ? (
              <div className="bed__edit-placeholder">
                <span aria-hidden="true">👆</span>
                <p>Select a button cell to edit its properties</p>
              </div>
            ) : (
              <ButtonEditPanel
                cell={selectedCell}
                hasPendingEdit={!!pendingEdits[selectedBtnId]}
                hasPersistedEdit={!!(entry && boardEdits[`${entry.fileName}:${entry.rootId}:${selectedBtnId}`])}
                onPatchChange={(field, value) => handlePatchChange(selectedBtnId, field, value)}
                onReset={() => handleReset(selectedBtnId)}
              />
            )}
          </div>

        </div>
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}

// ─── ButtonEditPanel ──────────────────────────────────────────────────────────

function ButtonEditPanel({ cell, hasPendingEdit, hasPersistedEdit, onPatchChange, onReset }) {
  const hasAnyEdit = hasPendingEdit || hasPersistedEdit

  return (
    <div className="bep">
      <div className="bep__header">
        <h3 className="bep__title">
          Button: <span className="bep__btn-label">{cell.label || '(empty)'}</span>
        </h3>
        {hasAnyEdit && (
          <button className="bep__reset" onClick={onReset} title="Reset to original OBF values">
            ↺ Reset
          </button>
        )}
      </div>

      {/* Preview */}
      <div
        className="bep__preview"
        style={{
          backgroundColor: cell.backgroundColor ?? undefined,
          borderColor:     cell.borderColor     ?? undefined,
          color:           cell.textColor        ?? undefined,
        }}
      >
        {cell.imageUrl && (
          <img className="bep__preview-img" src={cell.imageUrl} alt="" aria-hidden="true" />
        )}
        {!cell.imageUrl && cell.icon && (
          <span className="bep__preview-icon" aria-hidden="true">{cell.icon}</span>
        )}
        <span className="bep__preview-label">
          {_applyCapitalisation(cell.label, cell.capitalisation)}
        </span>
      </div>

      <div className="bep__fields">

        {/* Label */}
        <label className="bep__field">
          <span className="bep__field-label">Label</span>
          <input
            type="text"
            className="bep__input"
            value={cell.label ?? ''}
            onChange={e => onPatchChange('label', e.target.value)}
          />
        </label>

        {/* Capitalisation */}
        <label className="bep__field">
          <span className="bep__field-label">Capitalisation</span>
          <select
            className="bep__select"
            value={cell.capitalisation ?? 'as-is'}
            onChange={e => onPatchChange('capitalisation', e.target.value === 'as-is' ? null : e.target.value)}
          >
            <option value="as-is">As-Is</option>
            <option value="upper">UPPERCASE</option>
            <option value="lower">lowercase</option>
            <option value="title">Title Case</option>
          </select>
        </label>

        {/* Background colour */}
        <div className="bep__field bep__field--colour">
          <span className="bep__field-label">Background Colour</span>
          <div className="bep__colour-row">
            <input
              type="color"
              className="bep__colour-input"
              value={cell.backgroundColor ?? '#1a1d2e'}
              onChange={e => onPatchChange('backgroundColor', e.target.value)}
            />
            <input
              type="text"
              className="bep__input bep__input--colour-text"
              value={cell.backgroundColor ?? ''}
              placeholder="e.g. #ff6b35 or rgb(255,107,53)"
              onChange={e => onPatchChange('backgroundColor', e.target.value || null)}
            />
            {cell.backgroundColor && (
              <button className="bep__clear-btn" onClick={() => onPatchChange('backgroundColor', null)}>✕</button>
            )}
          </div>
        </div>

        {/* Border colour */}
        <div className="bep__field bep__field--colour">
          <span className="bep__field-label">Border Colour</span>
          <div className="bep__colour-row">
            <input
              type="color"
              className="bep__colour-input"
              value={cell.borderColor ?? '#334155'}
              onChange={e => onPatchChange('borderColor', e.target.value)}
            />
            <input
              type="text"
              className="bep__input bep__input--colour-text"
              value={cell.borderColor ?? ''}
              placeholder="e.g. #38bdf8"
              onChange={e => onPatchChange('borderColor', e.target.value || null)}
            />
            {cell.borderColor && (
              <button className="bep__clear-btn" onClick={() => onPatchChange('borderColor', null)}>✕</button>
            )}
          </div>
        </div>

        {/* Text colour */}
        <div className="bep__field bep__field--colour">
          <span className="bep__field-label">Text Colour</span>
          <div className="bep__colour-row">
            <input
              type="color"
              className="bep__colour-input"
              value={cell.textColor ?? '#ffffff'}
              onChange={e => onPatchChange('textColor', e.target.value)}
            />
            <input
              type="text"
              className="bep__input bep__input--colour-text"
              value={cell.textColor ?? ''}
              placeholder="e.g. #f0f9ff"
              onChange={e => onPatchChange('textColor', e.target.value || null)}
            />
            {cell.textColor && (
              <button className="bep__clear-btn" onClick={() => onPatchChange('textColor', null)}>✕</button>
            )}
          </div>
        </div>

        {/* Symbol / image */}
        <div className="bep__field">
          <span className="bep__field-label">Symbol / Image</span>
          {cell.imageUrl ? (
            <div className="bep__image-row">
              <img className="bep__image-preview" src={cell.imageUrl} alt={cell.label} />
              <button
                className="bep__clear-btn bep__clear-btn--image"
                onClick={() => onPatchChange('imageUrl', null)}
              >
                ✕ Remove
              </button>
            </div>
          ) : (
            <div className="bep__image-row bep__image-row--empty">
              <span className="bep__no-image">{cell.icon ? cell.icon : '—'}</span>
              <label className="bep__upload-btn">
                📁 Upload image
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    const url = URL.createObjectURL(file)
                    onPatchChange('imageUrl', url)
                  }}
                />
              </label>
            </div>
          )}
        </div>

        {/* Sound */}
        <div className="bep__field">
          <span className="bep__field-label">Sound on Activation</span>
          {cell.soundUrl ? (
            <div className="bep__sound-row">
              <audio controls className="bep__audio" src={cell.soundUrl} />
              <button
                className="bep__clear-btn"
                onClick={() => onPatchChange('soundUrl', null)}
              >
                ✕
              </button>
            </div>
          ) : (
            <label className="bep__upload-btn">
              🔊 Upload audio
              <input
                type="file"
                accept="audio/*"
                style={{ display: 'none' }}
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  const url = URL.createObjectURL(file)
                  onPatchChange('soundUrl', url)
                }}
              />
            </label>
          )}
        </div>

        {/* Navigation — Links to Board */}
        <div className="bep__field">
          <span className="bep__field-label">Links to Board (load_board)</span>
          <p className="bep__field-hint">
            When set, activating this button navigates to the specified board instead of speaking a word.
            Enter a board ID from the current board set (e.g. <code>want</code>, <code>1_403</code>).
          </p>
          <div className="bep__colour-row">
            <input
              type="text"
              className="bep__input"
              value={cell.loadBoardId ?? ''}
              placeholder="Board ID (leave empty for vocabulary word)"
              onChange={e => onPatchChange('loadBoardId', e.target.value || null)}
            />
            {cell.loadBoardId && (
              <button className="bep__clear-btn" onClick={() => onPatchChange('loadBoardId', null)}>✕</button>
            )}
          </div>
          {cell.loadBoardId && (
            <p className="bep__field-note bep__field-note--info">
              🔗 This button currently navigates to: <strong>{cell.loadBoardId}</strong>
            </p>
          )}
        </div>

      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _applyCapitalisation(label, mode) {
  if (!label) return label
  switch (mode) {
    case 'upper': return label.toUpperCase()
    case 'lower': return label.toLowerCase()
    case 'title': return label.replace(/\b\w/g, c => c.toUpperCase())
    default:      return label
  }
}
