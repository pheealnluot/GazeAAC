import { useState, useRef, useEffect } from 'react'
import { usePhrase } from '@context/PhraseContext'
import { useVocabulary } from '@context/VocabularyContext'
import { useGazeSettings } from '@context/GazeSettingsContext'
import './TopBar.css'

/**
 * TopBar — Main AAC grid top bar (replaces PhraseBar)
 *
 * Layout (left → right):
 *   [🏠 Home] [← Back]  [... word chips phrase bar ...]  [⌫] [✕]  [≡ Sidebar]
 *
 * Sidebar (toggleable panel on the right side) shows:
 *   Yes/No | Inflections/Keyboard | Social | Alert
 *
 * Dwell support:
 *   Each nav and action button carries a data-cell-id attribute so the
 *   TelemetryRouter can hit-test them alongside the vocabulary grid.
 *   App.jsx measures their bounding rects and registers them with the router,
 *   then feeds back topBarGazeState = { cellId, dwellProgress } so we can
 *   render the progress ring without any React render on every gaze frame.
 */
export function TopBar({ onSidebarItemClick, topBarGazeState = {}, onMeasureReady, dwellRingOpacity = 1.0 }) {
  const { words, phraseText, speakPhrase, deleteWord, clearPhrase } = usePhrase()
  const { goHome, goBack, activePage } = useVocabulary()
  const { settings } = useGazeSettings()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const chipsEndRef = useRef(null)
  const barRef = useRef(null)

  // Auto-scroll to latest chip
  useEffect(() => {
    chipsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [words])

  // Expose measurement function to parent (App.jsx)
  useEffect(() => {
    if (!onMeasureReady) return
    onMeasureReady(() => {
      if (!barRef.current) return []
      const buttons = barRef.current.querySelectorAll('[data-cell-id]')
      const vw = window.innerWidth
      const vh = window.innerHeight
      const cells = []
      buttons.forEach(el => {
        const id = el.getAttribute('data-cell-id')
        if (!id) return
        const rect = el.getBoundingClientRect()
        cells.push({
          id,
          x0: rect.left   / vw,
          y0: rect.top    / vh,
          x1: rect.right  / vw,
          y1: rect.bottom / vh,
        })
      })
      return cells
    })
  }, [onMeasureReady])

  const isAtHome = activePage === 'home'
  const { cellId: gazedId, dwellProgress = 0 } = topBarGazeState

  const opacity = dwellRingOpacity

  const sidebarItems = [
    { id: 'yesno',      label: 'Yes/No',      emoji: '✅', color: 'hsl(145 60% 45%)' },
    { id: 'inflections',label: 'Inflections',  emoji: '🧍', color: 'hsl(200 70% 50%)' },
    { id: 'keyboard',   label: 'Keyboard',     emoji: '⌨️', color: 'hsl(220 60% 55%)' },
    { id: 'social',     label: 'Social',       emoji: '👋', color: 'hsl(35 90% 55%)' },
    { id: 'alert',      label: 'Alert',        emoji: '🔔', color: 'hsl(0 75% 55%)' },
  ]

  const handleSidebarItem = (id) => {
    setSidebarOpen(false)
    onSidebarItemClick?.(id)
  }

  return (
    <div className="top-bar" role="banner" ref={barRef}>
      {/* ── Left nav button group ─────────────────────────────── */}
      <div className="top-bar__nav">
        <DwellNavButton
          id="topbar-home"
          className="top-bar__nav-btn top-bar__nav-btn--home"
          aria-label="Go to home board"
          title="Home"
          onClick={goHome}
          isGazed={gazedId === 'topbar-home'}
          dwellProgress={gazedId === 'topbar-home' ? dwellProgress : 0}
          opacity={opacity}
        >
          <span className="top-bar__nav-icon" aria-hidden="true">🏠</span>
          <span className="top-bar__nav-label">Home</span>
        </DwellNavButton>

        <DwellNavButton
          id="topbar-back"
          className={[
            'top-bar__nav-btn top-bar__nav-btn--back',
            isAtHome ? 'top-bar__nav-btn--disabled' : ''
          ].join(' ').trim()}
          aria-label="Go back to previous board"
          title="Back"
          onClick={goBack}
          disabled={isAtHome}
          isGazed={gazedId === 'topbar-back'}
          dwellProgress={gazedId === 'topbar-back' ? dwellProgress : 0}
          opacity={opacity}
        >
          <span className="top-bar__nav-icon" aria-hidden="true">←</span>
          <span className="top-bar__nav-label">Back</span>
        </DwellNavButton>
      </div>

      {/* ── Phrase / word-chip bar ────────────────────────────── */}
      <div
        className="top-bar__phrase"
        aria-label={words.length === 0 ? 'Phrase bar empty' : phraseText}
        aria-live="polite"
      >
        <div className="top-bar__chips" aria-hidden="true">
          {words.length === 0 ? (
            <span className="top-bar__placeholder">Select words to build a sentence…</span>
          ) : (
            words.map((token, idx) => (
              <span
                key={`${token.cellId}-${idx}`}
                className={[
                  'top-bar__chip',
                  idx === words.length - 1 ? 'top-bar__chip--new' : ''
                ].join(' ').trim()}
              >
                {token.word}
              </span>
            ))
          )}
          <span ref={chipsEndRef} className="top-bar__scroll-anchor" />
        </div>
      </div>

      {/* ── Speak button ──────────────────────────────────────── */}
      <DwellNavButton
        id="topbar-speak"
        className="top-bar__nav-btn top-bar__nav-btn--speak"
        aria-label="Speak phrase"
        title="Speak"
        onClick={speakPhrase}
        isGazed={gazedId === 'topbar-speak'}
        dwellProgress={gazedId === 'topbar-speak' ? dwellProgress : 0}
        opacity={opacity}
      >
        <span className="top-bar__nav-icon" aria-hidden="true">▶</span>
        <span className="top-bar__nav-label">Speak</span>
      </DwellNavButton>

      {/* ── Action buttons (backspace + clear) ───────────────── */}
      <div className="top-bar__actions">
        <DwellNavButton
          id="topbar-backspace"
          className="top-bar__action-btn top-bar__action-btn--delete"
          aria-label="Delete last word"
          title="Backspace"
          onClick={deleteWord}
          isGazed={gazedId === 'topbar-backspace'}
          dwellProgress={gazedId === 'topbar-backspace' ? dwellProgress : 0}
          opacity={opacity}
        >
          <span aria-hidden="true">⌫</span>
        </DwellNavButton>
        <DwellNavButton
          id="topbar-clear"
          className="top-bar__action-btn top-bar__action-btn--clear"
          aria-label="Clear all words"
          title="Clear"
          onClick={clearPhrase}
          isGazed={gazedId === 'topbar-clear'}
          dwellProgress={gazedId === 'topbar-clear' ? dwellProgress : 0}
          opacity={opacity}
        >
          <span aria-hidden="true">✕</span>
        </DwellNavButton>
      </div>

      {/* ── Sidebar toggle ─────────────────────────────────────── */}
      <div className="top-bar__sidebar-wrap">
        <button
          id="top-bar-sidebar"
          className={['top-bar__sidebar-btn', sidebarOpen ? 'top-bar__sidebar-btn--open' : ''].join(' ').trim()}
          aria-label="Toggle sidebar"
          aria-expanded={sidebarOpen}
          title="Sidebar"
          onClick={() => setSidebarOpen(v => !v)}
        >
          <span aria-hidden="true">≡</span>
          <span className="top-bar__nav-label">Sidebar</span>
        </button>

        {sidebarOpen && (
          <div className="top-bar__sidebar" role="menu" aria-label="Quick access sidebar">
            <button
              className="top-bar__sidebar-close"
              aria-label="Close sidebar"
              onClick={() => setSidebarOpen(false)}
            >
              × Hide
            </button>
            {sidebarItems.map(item => (
              <button
                key={item.id}
                id={`sidebar-item-${item.id}`}
                className="top-bar__sidebar-item"
                role="menuitem"
                style={{ '--item-color': item.color }}
                onClick={() => handleSidebarItem(item.id)}
              >
                <span className="top-bar__sidebar-item-emoji" aria-hidden="true">
                  {item.emoji}
                </span>
                <span className="top-bar__sidebar-item-label">{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * DwellNavButton — A TopBar button that renders an SVG dwell progress ring
 * centered on itself, similar to GazeButton's ring.
 */
function DwellNavButton({ id, className, 'aria-label': ariaLabel, title, onClick, disabled, children, isGazed, dwellProgress, opacity }) {
  const circumference = 2 * Math.PI * 38   // r=38 in a 100x100 viewBox
  const dashOffset    = circumference * (1 - (dwellProgress ?? 0))

  return (
    <button
      id={id}
      data-cell-id={id}
      data-gazed={isGazed ? 'true' : 'false'}
      className={className}
      aria-label={ariaLabel}
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{ '--topbar-ring-opacity': isGazed ? opacity : 0 }}
    >
      {/* Centered dwell ring SVG */}
      <svg
        className="top-bar__dwell-ring"
        viewBox="0 0 100 100"
        aria-hidden="true"
        style={{
          opacity: isGazed ? opacity : 0,
          transition: 'opacity 0.15s ease',
        }}
      >
        <circle
          className="top-bar__dwell-ring-track"
          cx="50" cy="50" r="38"
          fill="none"
          strokeWidth="4"
        />
        <circle
          className="top-bar__dwell-ring-arc"
          cx="50" cy="50" r="38"
          fill="none"
          strokeWidth="4"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform="rotate(-90 50 50)"
        />
      </svg>
      {children}
    </button>
  )
}
