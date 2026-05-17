import { useRef, useEffect } from 'react'
import { usePhrase } from '@context/PhraseContext'
import './PhraseBar.css'

/**
 * PhraseBar — Milestone 4
 *
 * Displays the current sentence construction buffer as an animated row of
 * word chips. Replaces the flat `app__speech-bar` div from M1–M3.
 *
 * Features:
 *   • Each word token renders as a chip with a slide-in animation
 *   • The most recently added chip pulses with a brief glow
 *   • A ▶ Speak button speaks the full sentence via PhraseContext.speakPhrase()
 *   • The bar is hidden when the phrase is empty
 *
 * This component is pointer-events aware (caregivers can click it); gaze
 * dwell on the ▶ button is handled via the standard onClick path since the
 * button lives outside the grid hit-test zone.
 */
export function PhraseBar() {
  const { words, phraseText, speakPhrase, deleteWord, clearPhrase } = usePhrase()
  const chipsEndRef = useRef(null)

  // Auto-scroll to the latest chip whenever words changes
  useEffect(() => {
    chipsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [words])


  return (
    <div
      className="phrase-bar"
      role="status"
      aria-live="polite"
      aria-label={words.length === 0 ? 'Phrase bar empty' : `Phrase: ${phraseText}`}
    >
      {/* Word chip strip */}
      <div className="phrase-bar__chips" aria-hidden="true">
        {words.length === 0 ? (
          <span className="phrase-bar__placeholder">Select words to build a sentence…</span>
        ) : (
          words.map((token, idx) => (
            <span
              key={`${token.cellId}-${idx}`}
              className={[
                'phrase-chip',
                idx === words.length - 1 ? 'phrase-chip--new' : ''
              ].join(' ').trim()}
            >
              {token.word}
            </span>
          ))
        )}
        <span ref={chipsEndRef} className="phrase-bar__scroll-anchor" />
      </div>

      {/* Action buttons */}
      <div className="phrase-bar__actions">
        <button
          className="phrase-bar__btn phrase-bar__btn--speak"
          aria-label="Speak phrase"
          title={phraseText}
          onClick={speakPhrase}
        >
          ▶
        </button>
        <button
          className="phrase-bar__btn phrase-bar__btn--delete"
          aria-label="Delete last word"
          onClick={deleteWord}
        >
          ⌫
        </button>
        <button
          className="phrase-bar__btn phrase-bar__btn--clear"
          aria-label="Clear phrase"
          onClick={clearPhrase}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
