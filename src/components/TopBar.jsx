import { useState, useRef, useEffect } from 'react'
import { usePhrase } from '@context/PhraseContext'
import { useVocabulary } from '@context/VocabularyContext'
import './TopBar.css'

/**
 * TopBar — Main AAC grid top bar (replaces PhraseBar)
 *
 * Layout (left → right):
 *   [🏠 Home] [← Back]  [... word chips phrase bar ...]  [⌫] [✕]  [≡ Sidebar]
 *
 * Sidebar (toggleable panel on the right side) shows:
 *   Yes/No | Inflections/Keyboard | Social | Alert
 */
export function TopBar({ onSidebarItemClick }) {
  const { words, phraseText, speakPhrase, deleteWord, clearPhrase } = usePhrase()
  const { goHome, goBack, activePage } = useVocabulary()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const chipsEndRef = useRef(null)

  // Auto-scroll to latest chip
  useEffect(() => {
    chipsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [words])

  const isAtHome = activePage === 'home'

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
    <div className="top-bar" role="banner">
      {/* ── Left nav buttons ─────────────────────────────────── */}
      <div className="top-bar__nav">
        <button
          id="top-bar-home"
          className="top-bar__nav-btn top-bar__nav-btn--home"
          aria-label="Go to home board"
          title="Home"
          onClick={goHome}
        >
          <span className="top-bar__nav-icon" aria-hidden="true">🏠</span>
          <span className="top-bar__nav-label">Home</span>
        </button>

        <button
          id="top-bar-back"
          className={[
            'top-bar__nav-btn top-bar__nav-btn--back',
            isAtHome ? 'top-bar__nav-btn--disabled' : ''
          ].join(' ').trim()}
          aria-label="Go back to previous board"
          title="Back"
          onClick={goBack}
          disabled={isAtHome}
        >
          <span className="top-bar__nav-icon" aria-hidden="true">←</span>
          <span className="top-bar__nav-label">Back</span>
        </button>
      </div>

      {/* ── Phrase / word-chip bar ────────────────────────────── */}
      <button
        className="top-bar__phrase"
        aria-label={words.length === 0 ? 'Phrase bar empty — activate words to speak' : `Speak phrase: ${phraseText}`}
        title={phraseText || 'Phrase bar'}
        onClick={speakPhrase}
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
        {words.length > 0 && (
          <span className="top-bar__speak-hint" aria-hidden="true">▶ Speak</span>
        )}
      </button>

      {/* ── Action buttons (backspace + clear) ───────────────── */}
      <div className="top-bar__actions">
        <button
          id="top-bar-backspace"
          className="top-bar__action-btn top-bar__action-btn--delete"
          aria-label="Delete last word"
          title="Backspace"
          onClick={deleteWord}
        >
          <span aria-hidden="true">⌫</span>
        </button>
        <button
          id="top-bar-clear"
          className="top-bar__action-btn top-bar__action-btn--clear"
          aria-label="Clear all words"
          title="Clear"
          onClick={clearPhrase}
        >
          <span aria-hidden="true">✕</span>
        </button>
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
