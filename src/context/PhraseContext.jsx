import { createContext, useContext, useState, useCallback, useMemo } from 'react'

/**
 * PhraseContext — Milestone 4
 *
 * Manages the sentence construction buffer as an ordered array of word tokens.
 * Decoupled from App state so the PhraseBar component can read and write it
 * without prop-drilling.
 *
 * API:
 *   words          – Array<{ word: string, cellId: string }>
 *   phraseText     – Computed joined string for TTS / display (e.g. "I WANT EAT")
 *   pushWord(word, cellId) – Append a word token
 *   deleteWord()           – Remove the last token (DEL cell action)
 *   clearPhrase()          – Reset the buffer to empty (CLR cell action)
 *   speakPhrase()          – Speak the full phraseText via Web Speech API
 */

const PhraseContext = createContext(null)

export function PhraseProvider({ children }) {
  const [words, setWords] = useState([]) // Array<{ word: string, cellId: string }>

  // Computed joined display string
  const phraseText = useMemo(() => words.map(t => t.word).join(' '), [words])

  /** Append a word token to the phrase buffer. */
  const pushWord = useCallback((word, cellId) => {
    setWords(prev => [...prev, { word, cellId }])
  }, [])

  /** Remove the last word token (backspace). */
  const deleteWord = useCallback(() => {
    setWords(prev => prev.slice(0, -1))
  }, [])

  /** Clear the entire phrase buffer. */
  const clearPhrase = useCallback(() => {
    setWords([])
  }, [])

  /**
   * Speak the full constructed phrase via the Web Speech API.
   * Falls back gracefully if speechSynthesis is unavailable.
   */
  const speakPhrase = useCallback(() => {
    const text = words.map(t => t.word).join(' ')
    if (!text) return

    if ('speechSynthesis' in window) {
      // Cancel any currently-speaking utterance first
      window.speechSynthesis.cancel()
      const utter = new SpeechSynthesisUtterance(text)
      utter.rate = 0.9
      utter.pitch = 1.05
      window.speechSynthesis.speak(utter)
    }

    // Also notify main process (future native TTS hook)
    window.gazeAPI?.speak(text)
  }, [words])

  return (
    <PhraseContext.Provider value={{
      words,
      phraseText,
      pushWord,
      deleteWord,
      clearPhrase,
      speakPhrase
    }}>
      {children}
    </PhraseContext.Provider>
  )
}

/**
 * Hook to consume PhraseContext.
 * Throws if used outside of PhraseProvider.
 */
export function usePhrase() {
  const ctx = useContext(PhraseContext)
  if (!ctx) throw new Error('usePhrase must be used within PhraseProvider')
  return ctx
}
