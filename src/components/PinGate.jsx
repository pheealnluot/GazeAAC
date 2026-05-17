import { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useGazeSettings } from '@context/GazeSettingsContext'
import './PinGate.css'

/**
 * PinGate — Milestone 5
 *
 * A full-screen numeric PIN overlay that guards the Caregiver Panel.
 * Rendered as a React portal (above all other content).
 *
 * The correct PIN is read from GazeSettingsContext (`caregiverPin`, default '0000').
 * On correct PIN → calls onUnlocked(). On wrong PIN → shake animation + attempt counter.
 * After 5 wrong attempts the gate shows a 30-second cooldown.
 *
 * Props:
 *   open         {boolean}    – Whether the gate is visible
 *   onUnlocked   {() => void} – Called on successful PIN entry
 *   onCancel     {() => void} – Called when the user dismisses without unlocking
 */
export function PinGate({ open, onUnlocked, onCancel }) {
  const { settings } = useGazeSettings()

  const [digits, setDigits] = useState(['', '', '', ''])
  const [error, setError] = useState(false)
  const [attempts, setAttempts] = useState(0)
  const [cooldown, setCooldown] = useState(0) // seconds remaining

  // Reset state whenever the gate opens
  useEffect(() => {
    if (open) {
      setDigits(['', '', '', ''])
      setError(false)
    }
  }, [open])

  // Cooldown countdown
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  const handleDigit = useCallback((d) => {
    if (cooldown > 0) return
    setDigits(prev => {
      const next = [...prev]
      const idx = next.findIndex(v => v === '')
      if (idx === -1) return prev
      next[idx] = d
      return next
    })
    setError(false)
  }, [cooldown])

  const handleBackspace = useCallback(() => {
    setDigits(prev => {
      const next = [...prev]
      for (let i = 3; i >= 0; i--) {
        if (next[i] !== '') { next[i] = ''; break }
      }
      return next
    })
    setError(false)
  }, [])

  const handleSubmit = useCallback(() => {
    const entered = digits.join('')
    if (entered.length < 4) return

    const correct = settings.caregiverPin ?? '0000'
    if (entered === correct) {
      setAttempts(0)
      onUnlocked?.()
    } else {
      const next = attempts + 1
      setAttempts(next)
      setError(true)
      setDigits(['', '', '', ''])
      if (next >= 5) {
        setCooldown(30)
      }
    }
  }, [digits, settings.caregiverPin, attempts, onUnlocked])

  // Auto-submit when 4 digits are filled
  useEffect(() => {
    if (digits.every(d => d !== '')) {
      handleSubmit()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits])

  // Keyboard support
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (e.key >= '0' && e.key <= '9') handleDigit(e.key)
      else if (e.key === 'Backspace') handleBackspace()
      else if (e.key === 'Escape') onCancel?.()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, handleDigit, handleBackspace, onCancel])

  if (!open) return null

  const KEYS = [
    ['1','2','3'],
    ['4','5','6'],
    ['7','8','9'],
    [null,'0','⌫']
  ]

  const gate = (
    <div className="pin-gate__backdrop" role="dialog" aria-modal="true" aria-label="Caregiver PIN">
      <div className={`pin-gate ${error ? 'pin-gate--shake' : ''}`}>

        <button className="pin-gate__cancel" onClick={onCancel} aria-label="Cancel">✕</button>

        <div className="pin-gate__icon">🔐</div>
        <h2 className="pin-gate__title">Caregiver Access</h2>
        <p className="pin-gate__subtitle">Enter your 4-digit PIN to continue</p>

        {/* Digit dots */}
        <div className="pin-gate__dots" aria-label="PIN entry" role="group">
          {digits.map((d, i) => (
            <div
              key={i}
              className={`pin-dot ${d !== '' ? 'pin-dot--filled' : ''}`}
              aria-label={d !== '' ? 'filled' : 'empty'}
            />
          ))}
        </div>

        {/* Error / cooldown message */}
        {cooldown > 0 ? (
          <p className="pin-gate__error pin-gate__error--cooldown">
            Too many attempts — wait {cooldown}s
          </p>
        ) : error ? (
          <p className="pin-gate__error">
            Incorrect PIN {attempts >= 3 ? `(${5 - attempts} attempt${5 - attempts !== 1 ? 's' : ''} left)` : ''}
          </p>
        ) : (
          <p className="pin-gate__hint">Default PIN: 0000</p>
        )}

        {/* Numeric keypad */}
        <div className="pin-gate__keypad">
          {KEYS.map((row, ri) => (
            <div key={ri} className="pin-gate__keypad-row">
              {row.map((key, ci) => (
                key === null ? (
                  <div key={ci} className="pin-gate__key pin-gate__key--empty" />
                ) : key === '⌫' ? (
                  <button
                    key={ci}
                    className="pin-gate__key pin-gate__key--action"
                    onClick={handleBackspace}
                    aria-label="Backspace"
                    disabled={cooldown > 0}
                  >{key}</button>
                ) : (
                  <button
                    key={ci}
                    className="pin-gate__key"
                    onClick={() => handleDigit(key)}
                    aria-label={`Digit ${key}`}
                    disabled={cooldown > 0}
                  >{key}</button>
                )
              ))}
            </div>
          ))}
        </div>

      </div>
    </div>
  )

  return createPortal(gate, document.body)
}
