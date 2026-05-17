import { createPortal } from 'react-dom'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useGazeSettings } from '@context/GazeSettingsContext'
import { useVocabulary } from '@context/VocabularyContext'
import { useAACBoards } from '@context/AACBoardContext'
import { BoardEditor } from './BoardEditor'
import { GazeAccuracyTest } from './GazeAccuracyTest'
import './SettingsModal.css'

const PANEL_META = {
  eye:   { icon: '👁',  title: 'Eye Tracker Settings',  theme: 'eye'   },
  aac:   { icon: '🗣',  title: 'AAC Settings',           theme: 'aac'   },
  board: { icon: '📋',  title: 'Board Settings',         theme: 'board' },
}

export function SettingsModal({ open, onClose, initialPanel = 'eye', gazeRef = null }) {
  const { settings, updateSetting, updateSettings, resetSettings } = useGazeSettings()
  const { setStage } = useVocabulary()
  // activePanel is set once when the modal opens; it does NOT change while open
  const [activePanel, setActivePanel] = useState(initialPanel)

  useEffect(() => {
    if (open) setActivePanel(initialPanel)
  }, [open, initialPanel])

  if (!open) return null

  const handleReset = async () => {
    if (window.confirm('Reset all settings to factory defaults?')) await resetSettings()
  }

  const meta = PANEL_META[activePanel] ?? PANEL_META.eye

  const modal = (
    <div
      className={`sm__backdrop sm__backdrop--${meta.theme}`}
      role="dialog"
      aria-modal="true"
      aria-label={meta.title}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={`sm${activePanel === 'board' ? ' sm--fullscreen' : ''}`}>
        {/* ── Header ── */}
        <header className={`sm__header sm__header--${meta.theme}`}>
          <span className="sm__title-icon">{meta.icon}</span>
          <h2 className="sm__title">{meta.title}</h2>
          <button className="sm__close" aria-label="Close settings" onClick={onClose}>✕</button>
        </header>

        {/* ── Scrollable body — only shows the active panel's content ── */}
        <div className="sm__body">
          {activePanel === 'eye' && (
            <EyeTrackerPanel
              settings={settings}
              updateSetting={updateSetting}
              updateSettings={updateSettings}
              gazeRef={gazeRef}
            />
          )}
          {activePanel === 'aac' && (
            <AACPanel
              settings={settings}
              updateSetting={updateSetting}
              setStage={setStage}
            />
          )}
          {activePanel === 'board' && (
            <BoardPanel
              settings={settings}
              updateSetting={updateSetting}
              setStage={setStage}
            />
          )}
        </div>

        {/* ── Footer ── */}
        <footer className="sm__footer">
          <button className="sm__reset" onClick={handleReset}>↺ Reset to Defaults</button>
          <button className="sm__done" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

// ─── Panel 1: Eye Tracker ─────────────────────────────────────────────────────

function EyeTrackerPanel({ settings, updateSetting, updateSettings, gazeRef }) {
  const [advOpen, setAdvOpen] = useState(false)
  const [showAccuracyTest, setShowAccuracyTest] = useState(false)

  return (
    <div className="sm-panel__sections">
      {/* ── Accuracy Test trigger ───────────────────────────────────────── */}
      <div className="sm-accuracy-banner">
        <div className="sm-accuracy-banner__left">
          <span className="sm-accuracy-banner__icon">🎯</span>
          <div>
            <span className="sm-accuracy-banner__title">Gaze Accuracy Test</span>
            <span className="sm-accuracy-banner__desc">5-point validation — measures how accurately the tracker maps gaze across the screen</span>
          </div>
        </div>
        <button
          id="btn-run-accuracy-test"
          className="sm-btn sm-btn--accent"
          onClick={() => setShowAccuracyTest(true)}
        >
          ▶ Run Test
        </button>
      </div>

      <GazeAccuracyTest
        open={showAccuracyTest}
        onClose={() => setShowAccuracyTest(false)}
        gazeRef={gazeRef}
        dwellMs={settings.dwellMs}
      />

      {/* Basic — Dwell */}
      <SectionLabel>Dwell Timing</SectionLabel>
      <Row name="Dwell Threshold" hint="Time to hold gaze for activation">
        <input id="slider-dwell" type="range" className="sm-slider" min={300} max={2500} step={50}
          value={settings.dwellMs} onChange={e => updateSetting('dwellMs', Number(e.target.value))} />
        <Val>{settings.dwellMs} ms</Val>
      </Row>

      {/* Dropout */}
      <SectionLabel>Dropout Recovery</SectionLabel>
      <Row name="Decay Half-Life" hint="Speed of progress decay during blinks">
        <input id="slider-decay" type="range" className="sm-slider" min={50} max={500} step={25}
          value={settings.decayHalfLifeMs} onChange={e => updateSetting('decayHalfLifeMs', Number(e.target.value))} />
        <Val>{settings.decayHalfLifeMs} ms</Val>
      </Row>
      <Row name="Max Dropout Window" hint="Hard-reset ceiling for sustained dropout">
        <input id="slider-max-dropout" type="range" className="sm-slider" min={200} max={1500} step={50}
          value={settings.maxDropoutMs} onChange={e => updateSetting('maxDropoutMs', Number(e.target.value))} />
        <Val>{settings.maxDropoutMs} ms</Val>
      </Row>

      {/* Feedback Pattern */}
      <SectionLabel>Ocular Feedback Pattern</SectionLabel>
      <div className="sm-cards" role="radiogroup" aria-label="Feedback pattern">
        {PATTERNS.map(p => (
          <button key={p.id} role="radio" aria-checked={settings.feedbackPattern === p.id}
            className={`sm-card ${settings.feedbackPattern === p.id ? 'sm-card--active' : ''}`}
            onClick={() => updateSetting('feedbackPattern', p.id)}>
            <div className="sm-card__icon">{p.icon}</div>
            <span className="sm-card__name">{p.name}</span>
            <span className="sm-card__desc">{p.desc}</span>
            <span className="sm-card__dot" aria-hidden="true" />
          </button>
        ))}
      </div>

      {/* Gaze Cursor */}
      <SectionLabel>Gaze Cursor</SectionLabel>
      <Row name="Show Cursor" hint="Real-time gaze position indicator">
        <Toggle id="toggle-cursor" checked={settings.showGazeCursor}
          onChange={e => updateSetting('showGazeCursor', e.target.checked)} />
      </Row>
      {settings.showGazeCursor && (
        <>
          {/* ── Cursor Size & Shape picker ─────────────────────────────── */}
          <SectionLabel sub>Cursor Size &amp; Shape</SectionLabel>
          <div className="sm-cursor-picker" role="group" aria-label="Cursor size and shape">
            {CURSOR_SHAPES.map(shape => (
              CURSOR_SIZES.map(size => (
                <button
                  key={`${shape.id}-${size.id}`}
                  className={`sm-cursor-card ${
                    settings.cursorShape === shape.id && settings.cursorSize === size.px
                      ? 'sm-cursor-card--active' : ''
                  }`}
                  onClick={() => updateSettings({ cursorShape: shape.id, cursorSize: size.px })}
                  title={`${shape.name} · ${size.label}`}
                  aria-pressed={settings.cursorShape === shape.id && settings.cursorSize === size.px}
                >
                  <CursorPreview shape={shape.id} sizePx={size.px} color={settings.cursorColor} />
                  <span className="sm-cursor-card__label">{shape.name}</span>
                  <span className="sm-cursor-card__size">{size.label}</span>
                </button>
              ))
            ))}
          </div>

          <Row name="Cursor Colour" hint="Colour of the gaze dot overlay">
            <input id="picker-cursor-color" type="color" className="sm-color"
              value={rgbaToHex(settings.cursorColor)}
              onChange={e => updateSetting('cursorColor', e.target.value)} />
            <span className="sm-color-label">{settings.cursorColor}</span>
          </Row>
        </>
      )}

      {/* Advanced sub-accordion */}
      <div className="sm-adv">
        <button className="sm-adv__trigger" aria-expanded={advOpen} onClick={() => setAdvOpen(v => !v)}>
          <span>🔬</span>
          <span className="sm-adv__label">Advanced — Kalman / Saccade</span>
          <span className="sm-adv__badge">Noise &amp; Smoothing</span>
          <span>{advOpen ? '▴' : '▾'}</span>
        </button>
        {advOpen && (
          <div className="sm-adv__body">
            <p className="sm-hint-text">Fine-tune the Kalman smoother. Higher Process Noise = more agile. Lower Measurement Noise = less smoothing lag. Saccade Threshold = jump that snaps the filter.</p>
            <div className="sm-cards sm-cards--3" role="group" aria-label="Kalman presets">
              {KALMAN_PRESETS.map(p => (
                <button key={p.id}
                  className={`sm-card sm-card--sm ${
                    settings.processNoise === p.processNoise &&
                    settings.measurementNoise === p.measurementNoise &&
                    settings.saccadeThreshold === p.saccadeThreshold ? 'sm-card--active sm-card--green' : ''
                  }`}
                  onClick={() => updateSettings({ processNoise: p.processNoise, measurementNoise: p.measurementNoise, saccadeThreshold: p.saccadeThreshold })}>
                  <div className="sm-card__icon">{p.icon}</div>
                  <span className="sm-card__name">{p.name}</span>
                  <span className="sm-card__desc">{p.desc}</span>
                </button>
              ))}
            </div>
            <Row name="Process Noise (Q)" hint="Higher = more agile cell-crossing">
              <input id="slider-process-noise" type="range" className="sm-slider sm-slider--green" min={0.001} max={0.05} step={0.001}
                value={settings.processNoise ?? 0.012} onChange={e => updateSetting('processNoise', Number(e.target.value))} />
              <Val>{(settings.processNoise ?? 0.012).toFixed(3)}</Val>
            </Row>
            <Row name="Measurement Noise (R)" hint="Lower = trust raw sensor more">
              <input id="slider-measurement-noise" type="range" className="sm-slider sm-slider--green" min={0.01} max={0.30} step={0.005}
                value={settings.measurementNoise ?? 0.07} onChange={e => updateSetting('measurementNoise', Number(e.target.value))} />
              <Val>{(settings.measurementNoise ?? 0.07).toFixed(3)}</Val>
            </Row>
            <Row name="Saccade Threshold" hint="Jump distance [0–1] that resets filter">
              <input id="slider-saccade" type="range" className="sm-slider sm-slider--green" min={0.03} max={0.35} step={0.01}
                value={settings.saccadeThreshold ?? 0.10} onChange={e => updateSetting('saccadeThreshold', Number(e.target.value))} />
              <Val>{(settings.saccadeThreshold ?? 0.10).toFixed(2)}</Val>
            </Row>
            <div className="sm-ratio">
              <span className="sm-ratio__label">R/Q ratio (smoothing strength):</span>
              <span className={`sm-ratio__val ${(() => {
                const r = (settings.measurementNoise ?? 0.07) / (settings.processNoise ?? 0.012)
                return r > 10 ? 'sm-ratio__val--warn' : r > 5 ? 'sm-ratio__val--ok' : 'sm-ratio__val--good'
              })()}`}>
                {((settings.measurementNoise ?? 0.07) / (settings.processNoise ?? 0.012)).toFixed(1)} : 1
                {(() => {
                  const r = (settings.measurementNoise ?? 0.07) / (settings.processNoise ?? 0.012)
                  return r > 10 ? ' ⚠️ heavy smoothing' : r > 5 ? ' ✅ moderate' : ' ⚡ agile'
                })()}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Panel 2: AAC Settings ───────────────────────────────────────────────────

function AACPanel({ settings, updateSetting }) {
  const [voices, setVoices] = useState([])

  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis?.getVoices() ?? [])
    load()
    window.speechSynthesis?.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load)
  }, [])

  return (
    <div className="sm-panel__sections">
      {/* AI */}
      <SectionLabel>AI &amp; Contextual</SectionLabel>
      <Row name="AI Contextual Suggestions" hint="Predictive word suggestions based on context (coming soon)">
        <Toggle id="toggle-ai" checked={settings.aiSuggestions ?? false}
          onChange={e => updateSetting('aiSuggestions', e.target.checked)} />
        <span className="sm-badge-coming">Soon</span>
      </Row>

      {/* Cell Display */}
      <SectionLabel>Cell Display</SectionLabel>
      <Row name="Show Cell Icons" hint="Display emoji symbols on vocabulary buttons">
        <Toggle id="toggle-icons" checked={settings.showIcons ?? true}
          onChange={e => updateSetting('showIcons', e.target.checked)} />
      </Row>
      <SectionLabel sub>Unmasked Cell Hit-Box Size</SectionLabel>
      <div className="sm-cards sm-cards--4" role="radiogroup" aria-label="Hit-box size">
        {HITBOX_SIZES.map(h => (
          <button key={h.id} role="radio" aria-checked={settings.unmaskedBoxSize === h.id}
            className={`sm-card sm-card--amber ${settings.unmaskedBoxSize === h.id ? 'sm-card--active' : ''}`}
            onClick={() => updateSetting('unmaskedBoxSize', h.id)}>
            <div className="sm-card__icon">{h.icon}</div>
            <span className="sm-card__name">{h.name}</span>
            <span className="sm-card__desc">{h.desc}</span>
            <span className="sm-card__dot" aria-hidden="true" />
          </button>
        ))}
      </div>
      <Row name="Selected Border Colour" hint="Border highlight colour shown during dwell activation">
        <input id="picker-border-color" type="color" className="sm-color"
          value={rgbaToHex(settings.selectedBorderColor ?? '#00c8ff')}
          onChange={e => updateSetting('selectedBorderColor', e.target.value)} />
        <span className="sm-color-label">{settings.selectedBorderColor ?? '#00c8ff'}</span>
      </Row>
      <Row name="Grid Transparency" hint="Overall opacity of the vocabulary grid panel">
        <input id="slider-opacity" type="range" className="sm-slider" min={0.3} max={1.0} step={0.05}
          value={settings.gridOpacity ?? 1.0} onChange={e => updateSetting('gridOpacity', Number(e.target.value))} />
        <Val>{Math.round((settings.gridOpacity ?? 1.0) * 100)}%</Val>
      </Row>

      {/* Dwell Progress */}
      <SectionLabel>Dwell Progress Indicator</SectionLabel>
      <SectionLabel sub>Style</SectionLabel>
      <div className="sm-cards sm-cards--2" role="radiogroup" aria-label="Dwell progress style">
        {DWELL_STYLES.map(d => (
          <button key={d.id} role="radio" aria-checked={settings.dwellProgressStyle === d.id}
            className={`sm-card sm-card--violet ${settings.dwellProgressStyle === d.id ? 'sm-card--active' : ''}`}
            onClick={() => updateSetting('dwellProgressStyle', d.id)}>
            <div className="sm-card__icon">{d.icon}</div>
            <span className="sm-card__name">{d.name}</span>
            <span className="sm-card__desc">{d.desc}</span>
            <span className="sm-card__dot" aria-hidden="true" />
          </button>
        ))}
      </div>
      <SectionLabel sub>Position within Cell</SectionLabel>
      <div className="sm-cards sm-cards--3" role="radiogroup" aria-label="Dwell progress position">
        {DWELL_POSITIONS.map(p => (
          <button key={p.id} role="radio" aria-checked={settings.dwellProgressPosition === p.id}
            className={`sm-card sm-card--sm sm-card--violet ${settings.dwellProgressPosition === p.id ? 'sm-card--active' : ''}`}
            onClick={() => updateSetting('dwellProgressPosition', p.id)}>
            <div className="sm-card__icon">{p.icon}</div>
            <span className="sm-card__name">{p.name}</span>
            <span className="sm-card__dot" aria-hidden="true" />
          </button>
        ))}
      </div>

      {/* Voice */}
      <SectionLabel>Voice &amp; Speech</SectionLabel>
      <Row name="Voice" hint="Text-to-speech voice for word output">
        <select
          id="select-tts-voice"
          className="sm-select"
          value={settings.ttsVoice ?? ''}
          onChange={e => updateSetting('ttsVoice', e.target.value)}
        >
          <option value="">System Default</option>
          {voices.map(v => (
            <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
          ))}
        </select>
      </Row>
      <Row name="Speak On Each Word" hint="Speak immediately when a word is activated">
        <Toggle id="toggle-speak" checked={settings.speakOnWord ?? true}
          onChange={e => updateSetting('speakOnWord', e.target.checked)} />
      </Row>
      <Row name="Auto-Return Home on Clear" hint="Return to root vocabulary when phrase is cleared">
        <Toggle id="toggle-return-home" checked={settings.autoReturnHome ?? true}
          onChange={e => updateSetting('autoReturnHome', e.target.checked)} />
      </Row>
      <Row name="Auto-Return After Sub-Page" hint="Return to home grid after selecting from a sub-page (LAMP motor planning)">
        <Toggle id="toggle-return-subpage" checked={settings.autoReturnFromSubPage ?? true}
          onChange={e => updateSetting('autoReturnFromSubPage', e.target.checked)} />
      </Row>
    </div>
  )
}


// ─── Panel 3: Board Settings ──────────────────────────────────────────────────

function BoardPanel({ settings, updateSetting, setStage }) {
  const { library, isLoading, activeLibraryId, selectBoard, activeBoardSet } = useAACBoards()
  const { importOBZFile, exportBoards } = useVocabulary()
  const [subScreen, setSubScreen]   = useState(null)  // null | 'boards'
  const [editingId, setEditingId]   = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [importing, setImporting]   = useState(false)
  const [importMsg, setImportMsg]   = useState(null)
  const [exporting, setExporting]   = useState(false)
  const fileInputRef = useRef(null)

  const activeEntry = library.find(e => e.id === activeLibraryId) ?? null

  // ── OBF-native vocab picker ────────────────────────────────────────────────
  // Read buttons from the active board's root page instead of lamp_84.json
  const obfCells = useMemo(() => {
    if (!activeBoardSet || !activeEntry?.rootId) return []
    const board = activeBoardSet.boards?.get(activeEntry.rootId)
    if (!board) return []
    const cells = []
    const order = board.order ?? []
    for (let r = 0; r < order.length; r++) {
      const row = order[r] ?? []
      for (let c = 0; c < row.length; c++) {
        const btnId = row[c]
        const btn   = btnId ? board.buttonMap?.get(btnId) : null
        cells.push({
          id:    btnId ?? `empty-${r}-${c}`,
          label: btn?.label ?? '',
          bg:    btn?.background_color ?? null,
          fg:    btn?.foreground_color ?? null,
          imageUrl: resolveImageUrl(btn, board),
          hasLink: !!btn?.load_board,
          row: r, col: c,
        })
      }
    }
    return cells
  }, [activeBoardSet, activeEntry])

  const obfCols = useMemo(() => {
    if (!activeBoardSet || !activeEntry?.rootId) return 1
    const board = activeBoardSet.boards?.get(activeEntry.rootId)
    return board?.order?.[0]?.length ?? 1
  }, [activeBoardSet, activeEntry])

  const [vocabSelected, setVocabSelected] = useState(() =>
    new Set(settings.customVocabIds?.length > 0 ? settings.customVocabIds : [])
  )
  const [vocabSaved, setVocabSaved] = useState(false)

  const toggleVocabCell = useCallback((id, hasLabel) => {
    if (!hasLabel) return
    setVocabSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
    setVocabSaved(false)
  }, [])

  const handleVocabSave = () => {
    updateSetting('customVocabIds', [...vocabSelected])
    setVocabSaved(true)
    setTimeout(() => setVocabSaved(false), 2000)
  }
  // ──────────────────────────────────────────────────────────────────────────

  const handleFiles = useCallback(async (files) => {
    if (!files?.length) return
    const file = files[0]
    const ext = file.name.split('.').pop().toLowerCase()
    if (ext !== 'obz' && ext !== 'obf') {
      setImportMsg({ type: 'error', text: `Unsupported file type: .${ext} — use .obz or .obf` })
      return
    }
    setImporting(true); setImportMsg(null)
    try {
      await importOBZFile(file)
      setImportMsg({ type: 'success', text: `✓ Imported "${file.name}" successfully!` })
    } catch (err) {
      setImportMsg({ type: 'error', text: `Import failed: ${err.message}` })
    } finally { setImporting(false) }
  }, [importOBZFile])

  // ── Sub-screen: Manage Boards ──────────────────────────────────────────────
  if (subScreen === 'boards') {
    return (
      <div className="sm-panel__sections sm-subscreen">
        <BoardEditor open={!!editingId} libraryId={editingId} onClose={() => setEditingId(null)} />
        <div className="sm-subscreen__header">
          <button className="sm-subscreen__back" onClick={() => { setSubScreen(null); setImportMsg(null) }}>← Back</button>
          <span className="sm-subscreen__title">Manage Boards</span>
        </div>
        {isLoading && <div className="sm-loading"><div className="sm-spinner" />Loading boards…</div>}
        {!isLoading && library.length > 0 && (
          <div className="sm-board-list">
            {library.map(entry => (
              <div key={entry.id} className={`sm-board-row ${entry.id === activeLibraryId ? 'sm-board-row--active' : ''}`}>
                <div className="sm-board-info">
                  <span className="sm-board-name">{entry.name}</span>
                  <span className="sm-board-meta">
                    {entry.loaded ? `${entry.columns}×${entry.rows} · ${entry.buttonCount} buttons` : <span style={{ color: 'hsl(38,70%,55%)' }}>Not yet loaded</span>}
                    {entry.id === activeLibraryId && <span className="sm-badge-active">✓ Active</span>}
                  </span>
                  <span className="sm-board-file">{entry.fileName}</span>
                </div>
                <div className="sm-board-actions">
                  <button className={`sm-btn ${entry.id === activeLibraryId ? 'sm-btn--outline' : ''}`} onClick={() => selectBoard(entry.id)} disabled={entry.id === activeLibraryId}>
                    {entry.id === activeLibraryId ? '✓ Selected' : entry.loaded ? '▶ Select' : '⬇ Load & Select'}
                  </button>
                  <button className="sm-btn sm-btn--outline" onClick={() => setEditingId(entry.id)} disabled={!entry.loaded}>✏ Edit</button>
                </div>
              </div>
            ))}
          </div>
        )}
        {!isLoading && library.length === 0 && <p className="sm-empty">No boards found — import one below.</p>}
        <SectionLabel sub>Upload a Board (.obz / .obf)</SectionLabel>
        <div
          className={`sm-dropzone ${isDragging ? 'sm-dropzone--over' : ''} ${importing ? 'sm-dropzone--loading' : ''}`}
          onDrop={e => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files) }}
          onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          role="button" tabIndex={0}
          aria-label="Drop .obz or .obf file, or click to browse"
          onClick={() => !importing && fileInputRef.current?.click()}
          onKeyDown={e => e.key === 'Enter' && fileInputRef.current?.click()}
        >
          <input ref={fileInputRef} type="file" accept=".obz,.obf" style={{ display: 'none' }} onChange={e => handleFiles(e.target.files)} />
          {importing ? <div className="sm-spinner" aria-label="Importing…" /> : <>
            <span className="sm-dropzone__icon">📂</span>
            <span className="sm-dropzone__primary">{isDragging ? 'Release to import' : 'Drop .obz / .obf here'}</span>
            <span className="sm-dropzone__secondary">or click to browse files</span>
          </>}
        </div>
        {importMsg && <div className={`sm-import-msg sm-import-msg--${importMsg.type}`} role="alert">{importMsg.text}</div>}
        <div className="sm-board-export">
          <button className="sm-btn" onClick={async () => { setExporting(true); try { await exportBoards() } finally { setExporting(false) } }} disabled={exporting}>
            {exporting ? '⏳ Exporting…' : '⬇ Export .obz'}
          </button>
        </div>
      </div>
    )
  }

  // ── Main screen ────────────────────────────────────────────────────────────
  return (
    <div className="sm-panel__sections">
      <BoardEditor open={!!editingId} libraryId={editingId} onClose={() => setEditingId(null)} />

      {/* ── 1. Board Selection ── */}
      <SectionLabel>Board Selection</SectionLabel>
      {activeEntry ? (
        <div className="sm-active-board-row">
          <span className="sm-active-board-icon">📋</span>
          <div className="sm-active-board-info">
            <span className="sm-active-board-name">{activeEntry.name}</span>
            <span className="sm-active-board-meta">
              {activeEntry.loaded
                ? `${activeEntry.columns}×${activeEntry.rows} · ${activeEntry.buttonCount} buttons · ${activeEntry.fileName}`
                : activeEntry.fileName}
            </span>
          </div>
          <button className="sm-btn sm-btn--outline" onClick={() => setEditingId(activeEntry.id)} disabled={!activeEntry.loaded}>
            ✏ Edit Board
          </button>
        </div>
      ) : (
        <div className="sm-active-board-row sm-active-board-row--empty">
          <span style={{ opacity: .5 }}>📦</span>
          <span style={{ fontSize: '.82rem', color: 'var(--color-text-secondary)' }}>No board selected</span>
        </div>
      )}
      <button className="sm-manage-boards-btn" onClick={() => setSubScreen('boards')}>
        <span className="sm-manage-boards-btn__icon">🗂</span>
        <span className="sm-manage-boards-btn__label">Manage Boards</span>
        <span className="sm-manage-boards-btn__meta">{library.length > 0 ? `${library.length} board${library.length !== 1 ? 's' : ''} available — add, remove or import` : 'Add or import boards (.obz / .obf)'}</span>
        <span className="sm-manage-boards-btn__arrow">→</span>
      </button>

      {/* ── 2. Label & Symbol Scale (above vocab grid for live preview) ── */}
      <SectionLabel>Label &amp; Symbol Scale</SectionLabel>
      <Row name="Label Scale" hint="Scales button text labels — reflected live in the grid">
        <input id="slider-font-scale" type="range" className="sm-slider" min={0.5} max={5.0} step={0.05}
          value={settings.fontScale ?? 2.0}
          onChange={e => updateSetting('fontScale', Number(e.target.value))} />
        <Val>{Math.round((settings.fontScale ?? 2.0) * 100)}%</Val>
      </Row>
      <Row name="Symbol Scale" hint="Scales symbols/images independently of text">
        <input id="slider-symbol-scale" type="range" className="sm-slider" min={0.5} max={5.0} step={0.05}
          value={settings.symbolScale ?? 2.0}
          onChange={e => updateSetting('symbolScale', Number(e.target.value))} />
        <Val>{Math.round((settings.symbolScale ?? 2.0) * 100)}%</Val>
      </Row>
      <div className="sm-font-scale-preview">
        <span style={{ fontSize: `calc(${settings.fontScale ?? 2.0} * 0.75rem)` }}>Small</span>
        <span style={{ fontSize: `calc(${settings.fontScale ?? 2.0} * 1rem)`, fontWeight: 700 }}>Normal</span>
        <span style={{ fontSize: `calc(${settings.fontScale ?? 2.0} * 1.25rem)`, fontWeight: 800 }}>Large</span>
      </div>

      {/* ── Symbol Position ── */}
      <SectionLabel>Symbol Position</SectionLabel>
      <div className="sm-cards sm-cards--2" role="radiogroup" aria-label="Symbol position">
        {[
          { id: false, name: 'Text on Top', icon: '🔤', desc: 'Label above the symbol (default)' },
          { id: true,  name: 'Symbol on Top', icon: '🖼', desc: 'Symbol/image above the label' },
        ].map(opt => (
          <button key={String(opt.id)} role="radio"
            aria-checked={(settings.symbolOnTop ?? false) === opt.id}
            className={`sm-card sm-card--amber ${(settings.symbolOnTop ?? false) === opt.id ? 'sm-card--active' : ''}`}
            onClick={() => updateSetting('symbolOnTop', opt.id)}>
            <div className="sm-card__icon">{opt.icon}</div>
            <span className="sm-card__name">{opt.name}</span>
            <span className="sm-card__desc">{opt.desc}</span>
            <span className="sm-card__dot" aria-hidden="true" />
          </button>
        ))}
      </div>

      {/* ── 3. Default Text Colour ── */}
      <SectionLabel>Default Text Colour</SectionLabel>
      <Row name="Grid Font Colour" hint="Fallback colour for button labels when the board file doesn't define one">
        <input id="picker-grid-font-color" type="color" className="sm-color"
          value={settings.gridFontColor ?? '#ffffff'}
          onChange={e => updateSetting('gridFontColor', e.target.value)} />
        <span className="sm-color-label">{settings.gridFontColor ?? '#ffffff'}</span>
      </Row>

      {/* ── 4. Custom Vocabulary (full-size OBF grid) ── */}
      <SectionLabel>Custom Vocabulary</SectionLabel>
      <p className="sm-hint-text">
        Select which buttons appear when the learner is in <strong>Custom Vocab</strong> mode.
        Cells display their actual board colours and symbols. Tap to toggle; ✓ = included.
      </p>
      {obfCells.length === 0 ? (
        <p className="sm-empty">Load a board above to configure custom vocabulary.</p>
      ) : (
        <>
          <div className="sm-vocab-toolbar">
            <span className="sm-vocab-count">{vocabSelected.size} / {obfCells.filter(c => c.label).length} cells selected</span>
            <button className="sm-btn sm-btn--outline sm-btn--xs" onClick={() => { setVocabSelected(new Set(obfCells.filter(c => c.label).map(c => c.id))); setVocabSaved(false) }}>Select All</button>
            <button className="sm-btn sm-btn--outline sm-btn--xs" onClick={() => { setVocabSelected(new Set()); setVocabSaved(false) }}>Clear All</button>
            <button className={`sm-btn sm-btn--xs ${vocabSaved ? 'sm-btn--success' : ''}`} onClick={handleVocabSave}>{vocabSaved ? '✓ Saved!' : '💾 Save'}</button>
          </div>
          <div
            className="sm-vocab-grid"
            style={{
              '--vocab-cols': obfCols,
              '--vocab-font-scale': settings.fontScale ?? 2.0,
              '--vocab-symbol-scale': settings.symbolScale ?? 2.0,
              '--vocab-font-color': settings.gridFontColor ?? '#ffffff',
            }}
            role="grid"
            aria-label="Custom vocabulary cell picker"
          >
            {obfCells.map(cell => {
              const isEmpty = !cell.label
              const isSel   = vocabSelected.has(cell.id)
              return (
                <button
                  key={cell.id}
                  className={[
                    'sm-vocab-cell',
                    isEmpty   ? 'sm-vocab-cell--empty'    : '',
                    isSel     ? 'sm-vocab-cell--selected' : 'sm-vocab-cell--inactive',
                    cell.hasLink ? 'sm-vocab-cell--link' : '',
                  ].filter(Boolean).join(' ')}
                  style={{
                    background: cell.bg ?? undefined,
                    color: cell.fg ?? 'var(--vocab-font-color)',
                    borderColor: cell.hasLink ? 'hsl(38,60%,45%)' : undefined,
                  }}
                  onClick={() => toggleVocabCell(cell.id, !!cell.label)}
                  title={cell.label ? `${cell.label}${cell.hasLink ? ' (links to sub-page)' : ''}` : '(empty)'}
                  aria-pressed={isSel}
                  disabled={isEmpty}
                  tabIndex={isEmpty ? -1 : 0}
                >
                  {cell.imageUrl && <img src={cell.imageUrl} className="sm-vocab-cell__img" alt="" aria-hidden="true" style={{ transform: `scale(var(--vocab-symbol-scale, 1))`, transformOrigin: 'center top' }} />}
                  <span className="sm-vocab-cell__label">{cell.label}</span>
                  {isSel && <span className="sm-vocab-cell__check" aria-hidden="true">✓</span>}
                  {cell.hasLink && <span className="sm-vocab-cell__link-badge">🔗</span>}
                  {!isSel && !isEmpty && <span className="sm-vocab-cell__dim" aria-hidden="true" />}
                </button>
              )
            })}
          </div>
        </>
      )}

      {/* ── 5. Board Preview ── */}
      <SectionLabel>Board Preview</SectionLabel>
      <OBFBoardPreview entry={activeEntry} boardSet={activeBoardSet} />
    </div>
  )
}

// ─── OBF Board Preview ────────────────────────────────────────────────────────
// Full grid with OBF background_color, border_color, symbols/images, load_board links

function OBFBoardPreview({ entry, boardSet }) {
  const { cells, cols, rows } = useMemo(() => {
    if (!boardSet || !entry?.rootId) return { cells: [], cols: 0, rows: 0 }
    const board = boardSet.boards?.get(entry.rootId)
    if (!board) return { cells: [], cols: 0, rows: 0 }

    const order  = board.order ?? []
    const nRows  = order.length
    const nCols  = order[0]?.length ?? 0
    const result = []

    for (let r = 0; r < nRows; r++) {
      const row = order[r] ?? []
      for (let c = 0; c < nCols; c++) {
        const btnId = row[c]
        const btn   = btnId ? board.buttonMap?.get(btnId) : null
        result.push({
          id:       btnId ?? `e-${r}-${c}`,
          label:    btn?.label ?? '',
          bg:       btn?.background_color ?? null,
          border:   btn?.border_color ?? null,
          fg:       btn?.foreground_color ?? null,
          imageUrl: resolveImageUrl(btn, board),
          hasLink:  !!btn?.load_board,
          isEmpty:  !btn?.label,
        })
      }
    }
    return { cells: result, cols: nCols, rows: nRows }
  }, [entry, boardSet])

  if (!entry) {
    return (
      <div className="sm-board-preview sm-board-preview--empty">
        <span className="sm-board-preview__icon">📋</span>
        <span className="sm-board-preview__msg">No board selected — choose one from the list above</span>
      </div>
    )
  }

  if (!entry.loaded || !boardSet) {
    return (
      <div className="sm-board-preview sm-board-preview--empty">
        <span className="sm-board-preview__icon">📦</span>
        <div>
          <div className="sm-board-preview__name">{entry.name}</div>
          <div className="sm-board-preview__msg">Select this board to preview its layout</div>
        </div>
      </div>
    )
  }

  return (
    <div className="sm-board-preview">
      <div className="sm-board-preview__header">
        <span className="sm-board-preview__badge">📋 Active Board</span>
        <span className="sm-board-preview__name">{entry.name}</span>
        <span className="sm-board-preview__dim">{entry.columns}×{entry.rows} · {entry.buttonCount} buttons · {entry.fileName}</span>
      </div>
      <div
        className="sm-board-preview__grid sm-board-preview__grid--full"
        style={{ '--prev-cols': cols }}
        aria-label={`Preview of ${entry.name}`}
      >
        {cells.map((cell, i) => (
          <div
            key={`${cell.id}-${i}`}
            className={[
              'sm-board-preview__cell',
              cell.isEmpty ? 'sm-board-preview__cell--empty' : '',
              cell.hasLink ? 'sm-board-preview__cell--link' : '',
            ].filter(Boolean).join(' ')}
            style={{
              background:   cell.bg     ?? undefined,
              borderColor:  cell.border ?? undefined,
              color:        cell.fg     ?? undefined,
            }}
            title={cell.label || undefined}
          >
            {cell.imageUrl && (
              <img src={cell.imageUrl} className="sm-board-preview__cell-img" alt="" aria-hidden="true" />
            )}
            <span className="sm-board-preview__cell-label">{cell.label}</span>
            {cell.hasLink && <span className="sm-board-preview__cell-link" title="Links to sub-page">🔗</span>}
          </div>
        ))}
      </div>
    </div>
  )
}





// ─── Image URL resolver (mirrors OBFParser.boardModelToCells logic) ──────────
// Raw OBF button objects have image_id, NOT imageUrl.
// imageUrl is derived by combining board.imageMap + board._imageBlobs.
function resolveImageUrl(btn, board) {
  if (!btn?.image_id) return null
  const img = board.imageMap?.get(btn.image_id)
  if (!img) return null
  const imageBlobs = board._imageBlobs ?? new Map()
  const blobPath = img.path ?? img.url
  if (blobPath && imageBlobs.has(blobPath)) return imageBlobs.get(blobPath)
  if (img.data) {
    const mimeType = img.content_type ?? 'image/png'
    return `data:${mimeType};base64,${img.data}`
  }
  if (img.url) return img.url
  return null
}

// ─── Shared micro-components ──────────────────────────────────────────────────

function SectionLabel({ children, sub }) {
  return <span className={`sm-section-label ${sub ? 'sm-section-label--sub' : ''}`}>{children}</span>
}

function Row({ name, hint, children }) {
  return (
    <div className="sm-row">
      <div className="sm-row__name">
        {name}
        {hint && <span className="sm-row__hint">{hint}</span>}
      </div>
      <div className="sm-row__control">{children}</div>
    </div>
  )
}

function Val({ children }) {
  return <span className="sm-val">{children}</span>
}

function Toggle({ id, checked, onChange }) {
  return (
    <label className="sm-toggle" aria-label={id}>
      <input id={id} type="checkbox" checked={checked} onChange={onChange} />
      <span className="sm-toggle__track" />
    </label>
  )
}

/**
 * CursorPreview — renders a small SVG of the cursor shape at the given size
 * using the live cursorColor from settings.
 */
function CursorPreview({ shape, sizePx, color }) {
  // Canvas is always 54×54 px; the cursor shape is scaled to sizePx
  const S = 54
  const half = S / 2
  const r = sizePx / 2          // cursor radius
  const stroke = color
  const fill   = color

  switch (shape) {
    case 'circle':
      return (
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} aria-hidden="true" className="sm-cursor-preview">
          <circle cx={half} cy={half} r={r} fill={fill} opacity={0.75} filter="url(#blur-sm)" />
          <circle cx={half} cy={half} r={r} fill={fill} opacity={0.55} />
        </svg>
      )
    case 'ring':
      return (
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} aria-hidden="true" className="sm-cursor-preview">
          <circle cx={half} cy={half} r={r} fill="none" stroke={stroke} strokeWidth={Math.max(2, r * 0.35)} opacity={0.85} />
          <circle cx={half} cy={half} r={2.5} fill={fill} opacity={0.9} />
        </svg>
      )
    case 'dot':
      return (
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} aria-hidden="true" className="sm-cursor-preview">
          <circle cx={half} cy={half} r={Math.max(3, r * 0.5)} fill={fill} opacity={0.9} />
        </svg>
      )
    case 'crosshair': {
      const arm = r + 6
      const gap = 4
      return (
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} aria-hidden="true" className="sm-cursor-preview">
          {/* Horizontal line with centre gap */}
          <line x1={half - arm} y1={half} x2={half - gap} y2={half} stroke={stroke} strokeWidth={2} strokeLinecap="round" opacity={0.9} />
          <line x1={half + gap} y1={half} x2={half + arm} y2={half} stroke={stroke} strokeWidth={2} strokeLinecap="round" opacity={0.9} />
          {/* Vertical line with centre gap */}
          <line x1={half} y1={half - arm} x2={half} y2={half - gap} stroke={stroke} strokeWidth={2} strokeLinecap="round" opacity={0.9} />
          <line x1={half} y1={half + gap} x2={half} y2={half + arm} stroke={stroke} strokeWidth={2} strokeLinecap="round" opacity={0.9} />
          <circle cx={half} cy={half} r={2.5} fill={fill} opacity={0.9} />
        </svg>
      )
    }
    case 'diamond': {
      const d = r
      const pts = `${half},${half - d} ${half + d},${half} ${half},${half + d} ${half - d},${half}`
      return (
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} aria-hidden="true" className="sm-cursor-preview">
          <polygon points={pts} fill={fill} opacity={0.75} />
          <polygon points={pts} fill="none" stroke={stroke} strokeWidth={1.5} opacity={0.9} />
        </svg>
      )
    }
    default:
      return (
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} aria-hidden="true" className="sm-cursor-preview">
          <circle cx={half} cy={half} r={r} fill={fill} opacity={0.75} />
        </svg>
      )
  }
}

// ─── Static data ──────────────────────────────────────────────────────────────

const KALMAN_PRESETS = [
  { id: 'smooth',   name: 'Smooth',   icon: '🌊', desc: 'Heavy jitter reduction',        processNoise: 0.006, measurementNoise: 0.12, saccadeThreshold: 0.15 },
  { id: 'balanced', name: 'Balanced', icon: '⚖️', desc: 'Recommended — fast saccades',   processNoise: 0.012, measurementNoise: 0.07, saccadeThreshold: 0.10 },
  { id: 'agile',    name: 'Agile',    icon: '⚡', desc: 'Minimal lag — raw-ish tracking', processNoise: 0.025, measurementNoise: 0.04, saccadeThreshold: 0.07 }
]

const PATTERNS = [
  { id: 'ring-pulse', name: 'Ring Pulse', icon: '◎',  desc: 'SVG arc ring fills as dwell accumulates' },
  { id: 'spotlight',  name: 'Spotlight',  icon: '🔦', desc: 'Vignette narrows on the gaze point' },
  { id: 'heat-trail', name: 'Heat Trail', icon: '🌡', desc: 'Thermal particle trail follows gaze' },
  { id: 'border',     name: 'Border',     icon: '⬚',  desc: 'Glowing cell border + discreet dot' }
]

const CURSOR_SHAPES = [
  { id: 'circle',    name: 'Circle'    },
  { id: 'ring',      name: 'Ring'      },
  { id: 'dot',       name: 'Dot'       },
  { id: 'crosshair', name: 'Crosshair' },
  { id: 'diamond',   name: 'Diamond'   },
]

const CURSOR_SIZES = [
  { id: 'sm',  px: 12, label: 'S' },
  { id: 'md',  px: 22, label: 'M' },
  { id: 'lg',  px: 36, label: 'L' },
]

const HITBOX_SIZES = [
  { id: '1x',   name: '1×',   icon: '◻', desc: 'Native cell only' },
  { id: '2x',   name: '2×',   icon: '◾', desc: 'Up to 2× native, centered' },
  { id: '3x',   name: '3×',   icon: '◼', desc: 'Up to 3× native, centered' },
  { id: 'full', name: 'Full', icon: '⬛', desc: 'Fill all adjacent empty space' }
]

const DWELL_STYLES = [
  { id: 'circle', name: 'Circle', icon: '◎', desc: 'SVG arc ring fills radially' },
  { id: 'bar',    name: 'Bar',    icon: '▬', desc: 'Horizontal fill bar' }
]

const DWELL_POSITIONS = [
  { id: 'top',    name: 'Top',    icon: '⬆' },
  { id: 'center', name: 'Center', icon: '⊙' },
  { id: 'bottom', name: 'Bottom', icon: '⬇' }
]



// ─── Utilities ────────────────────────────────────────────────────────────────

function rgbaToHex(colorStr) {
  if (!colorStr) return '#00c8ff'
  if (colorStr.startsWith('#')) return colorStr.slice(0, 7)
  const m = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (m) return '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('')
  return '#00c8ff'
}
