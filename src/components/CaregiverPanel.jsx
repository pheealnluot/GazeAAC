import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useGazeSettings } from '@context/GazeSettingsContext'
import './CaregiverPanel.css'

/**
 * CaregiverPanel — Milestone 5
 *
 * Full-screen caregiver configuration panel with two tabs:
 *
 *   Tab 1 – Session History
 *     SVG bar chart (last 14 days), summary stats, and CSV export.
 *
 *   Tab 2 – Access PIN
 *     Change the 4-digit caregiver PIN.
 *
 * Note: Custom Vocabulary and Board (OBF) settings have moved to
 * Board Settings (⚙ Settings → Board Settings).
 *
 * Props:
 *   open    {boolean}    – Whether the panel is visible
 *   onClose {() => void} – Called when the user closes the panel
 */
export function CaregiverPanel({ open, onClose }) {
  const [activeTab, setActiveTab] = useState('history')

  if (!open) return null

  const panel = (
    <div className="cp__backdrop" role="dialog" aria-modal="true" aria-label="Caregiver Panel">
      <div className="cp">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <header className="cp__header">
          <span className="cp__header-icon">👩‍⚕️</span>
          <h2 className="cp__title">Caregiver Panel</h2>
          <button className="cp__close" onClick={onClose} aria-label="Close caregiver panel">✕</button>
        </header>

        {/* ── Tab Bar ─────────────────────────────────────────────────── */}
        <nav className="cp__tabs" role="tablist">
          {TABS.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={activeTab === t.id}
              className={`cp__tab ${activeTab === t.id ? 'cp__tab--active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              <span className="cp__tab-icon">{t.icon}</span>
              <span className="cp__tab-label">{t.label}</span>
            </button>
          ))}
        </nav>

        {/* ── Tab Content ─────────────────────────────────────────────── */}
        <div className="cp__body">
          {activeTab === 'history' && <HistoryTab />}
          {activeTab === 'pin'     && <PinTab onClose={onClose} />}
        </div>

      </div>
    </div>
  )

  return createPortal(panel, document.body)
}

// ─── Tab definitions ──────────────────────────────────────────────────────────

const TABS = [
  { id: 'history', icon: '📊',  label: 'Session History' },
  { id: 'pin',     icon: '🔑',  label: 'Access PIN' }
]


// ─── Tab 1: Session History ───────────────────────────────────────────────────


function HistoryTab() {
  const [log, setLog]         = useState(null)
  const [loading, setLoading] = useState(true)
  const [cleared, setCleared] = useState(false)

  useEffect(() => {
    window.gazeAPI?.sessions?.getAll()
      .then(data => { setLog(data ?? []); setLoading(false) })
      .catch(() => { setLog([]); setLoading(false) })
    // In browser dev mode (no Electron) use mock data
    if (!window.gazeAPI?.sessions) {
      setLog(MOCK_LOG)
      setLoading(false)
    }
  }, [cleared])

  const handleClear = async () => {
    if (!window.confirm('Clear all session history? This cannot be undone.')) return
    await window.gazeAPI?.sessions?.clear()
    setLog([])
    setCleared(c => !c)
  }

  const handleExport = async () => {
    if (!log || log.length === 0) return
    const header = 'date,wordActivations,abandonedDwells,dwellAccuracyPct,stageUsed,durationSec,topWords'
    const rows = log.map(r =>
      [r.date, r.wordActivations, r.abandonedDwells, r.dwellAccuracyPct,
       r.stageUsed, r.durationSec, (r.topWords ?? []).join('|')].join(',')
    )
    const csv = [header, ...rows].join('\n')
    const result = await window.gazeAPI?.sessions?.exportCsv(csv)
    if (result?.ok) {
      console.log('[CaregiverPanel] CSV exported to:', result.filePath)
    }
  }

  if (loading) {
    return <div className="cp-history__loading">Loading session data…</div>
  }

  // Aggregate last 14 days
  const today = new Date()
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today)
    d.setDate(d.getDate() - (13 - i))
    return d.toISOString().slice(0, 10)
  })

  const byDate = {}
  ;(log ?? []).forEach(r => {
    if (!byDate[r.date]) byDate[r.date] = { activations: 0, sessions: 0 }
    byDate[r.date].activations += r.wordActivations ?? 0
    byDate[r.date].sessions    += 1
  })

  const dayData = days.map(d => ({
    date: d,
    label: d.slice(5), // MM-DD
    activations: byDate[d]?.activations ?? 0,
    sessions:    byDate[d]?.sessions    ?? 0
  }))

  const maxAct = Math.max(...dayData.map(d => d.activations), 1)
  const totalActivations = (log ?? []).reduce((s, r) => s + (r.wordActivations ?? 0), 0)
  const totalSessions    = (log ?? []).length
  const avgAccuracy      = totalSessions > 0
    ? Math.round((log ?? []).reduce((s, r) => s + (r.dwellAccuracyPct ?? 100), 0) / totalSessions)
    : 0

  // Top words across all sessions
  const wordFreq = {}
  ;(log ?? []).forEach(r => {
    ;(r.topWords ?? []).forEach(w => { wordFreq[w] = (wordFreq[w] ?? 0) + 1 })
  })
  const topWords = Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)

  return (
    <div className="cp-history">
      {/* Summary stats */}
      <div className="cp-history__stats">
        <StatCard icon="💬" value={totalActivations} label="Total Word Activations" />
        <StatCard icon="📅" value={totalSessions}    label="Total Sessions" />
        <StatCard icon="🎯" value={`${avgAccuracy}%`} label="Avg. Dwell Accuracy" />
      </div>

      {/* SVG Bar Chart */}
      <div className="cp-history__chart-wrap">
        <h3 className="cp-history__chart-title">Word Activations — Last 14 Days</h3>
        <svg
          className="cp-history__chart"
          viewBox={`0 0 ${14 * 52} 160`}
          preserveAspectRatio="none"
          aria-label="Bar chart of word activations per day"
          role="img"
        >
          {dayData.map((d, i) => {
            const barH = maxAct > 0 ? (d.activations / maxAct) * 120 : 0
            const x = i * 52 + 4
            const y = 130 - barH
            return (
              <g key={d.date}>
                <rect
                  x={x} y={y}
                  width={44} height={barH > 0 ? barH : 2}
                  rx={4}
                  className={`cp-chart__bar ${d.activations > 0 ? 'cp-chart__bar--active' : 'cp-chart__bar--zero'}`}
                >
                  <title>{d.date}: {d.activations} words</title>
                </rect>
                <text
                  x={x + 22} y={148}
                  className="cp-chart__label"
                  textAnchor="middle"
                  fontSize="8"
                >{d.label}</text>
                {d.activations > 0 && (
                  <text
                    x={x + 22} y={y - 3}
                    className="cp-chart__value"
                    textAnchor="middle"
                    fontSize="8"
                  >{d.activations}</text>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      {/* Top words */}
      {topWords.length > 0 && (
        <div className="cp-history__top-words">
          <h3 className="cp-history__section-title">Most Used Words</h3>
          <div className="cp-history__word-chips">
            {topWords.map(([word, count]) => (
              <span key={word} className="cp-history__word-chip">
                {word} <span className="cp-history__word-count">{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="cp-history__actions">
        <button
          className="cp-vocab__btn"
          onClick={handleExport}
          disabled={!log || log.length === 0}
          title="Export session history as CSV"
        >⬇ Export CSV</button>
        <button
          className="cp-vocab__btn cp-vocab__btn--danger"
          onClick={handleClear}
          disabled={!log || log.length === 0}
        >🗑 Clear History</button>
      </div>
    </div>
  )
}

function StatCard({ icon, value, label }) {
  return (
    <div className="cp-stat">
      <span className="cp-stat__icon">{icon}</span>
      <span className="cp-stat__value">{value}</span>
      <span className="cp-stat__label">{label}</span>
    </div>
  )
}

// ─── Tab 2: Access PIN ────────────────────────────────────────────────────────

function PinTab({ onClose }) {
  const { settings, updateSetting } = useGazeSettings()
  const [current, setCurrent]   = useState('')
  const [newPin, setNewPin]     = useState('')
  const [confirm, setConfirm]   = useState('')
  const [msg, setMsg]           = useState(null)

  const handleSave = () => {
    if (current !== (settings.caregiverPin ?? '0000')) {
      setMsg({ type: 'error', text: 'Current PIN is incorrect.' })
      return
    }
    if (!/^\d{4}$/.test(newPin)) {
      setMsg({ type: 'error', text: 'New PIN must be exactly 4 digits.' })
      return
    }
    if (newPin !== confirm) {
      setMsg({ type: 'error', text: 'New PIN and confirmation do not match.' })
      return
    }
    updateSetting('caregiverPin', newPin)
    setMsg({ type: 'success', text: 'PIN updated successfully. You will need the new PIN next time.' })
    setCurrent(''); setNewPin(''); setConfirm('')
    setTimeout(() => { setMsg(null); onClose?.() }, 2000)
  }

  return (
    <div className="cp-pin">
      <div className="cp-pin__icon">🔑</div>
      <h3 className="cp-pin__title">Change Access PIN</h3>
      <p className="cp-pin__desc">The PIN protects the Caregiver Panel from accidental access.</p>

      <div className="cp-pin__form">
        <label className="cp-pin__label">
          Current PIN
          <input
            type="password"
            inputMode="numeric"
            maxLength={4}
            className="cp-pin__input"
            value={current}
            onChange={e => { setCurrent(e.target.value.replace(/\D/g, '')); setMsg(null) }}
            placeholder="••••"
          />
        </label>
        <label className="cp-pin__label">
          New PIN (4 digits)
          <input
            type="password"
            inputMode="numeric"
            maxLength={4}
            className="cp-pin__input"
            value={newPin}
            onChange={e => { setNewPin(e.target.value.replace(/\D/g, '')); setMsg(null) }}
            placeholder="••••"
          />
        </label>
        <label className="cp-pin__label">
          Confirm New PIN
          <input
            type="password"
            inputMode="numeric"
            maxLength={4}
            className="cp-pin__input"
            value={confirm}
            onChange={e => { setConfirm(e.target.value.replace(/\D/g, '')); setMsg(null) }}
            placeholder="••••"
          />
        </label>

        {msg && (
          <p className={`cp-pin__msg cp-pin__msg--${msg.type}`}>{msg.text}</p>
        )}

        <button
          className="cp-vocab__btn cp-vocab__btn--save"
          onClick={handleSave}
          style={{ alignSelf: 'flex-start', marginTop: '0.5rem' }}
        >
          Update PIN
        </button>
      </div>
    </div>
  )
}

// ─── Mock data (browser dev mode without Electron) ───────────────────────────

const MOCK_LOG = Array.from({ length: 14 }, (_, i) => {
  const d = new Date()
  d.setDate(d.getDate() - i)
  return {
    date:             d.toISOString().slice(0, 10),
    wordActivations:  Math.floor(Math.random() * 60) + 5,
    abandonedDwells:  Math.floor(Math.random() * 15),
    dwellAccuracyPct: Math.floor(Math.random() * 30) + 70,
    stageUsed:        i < 5 ? 3 : 2,
    durationSec:      Math.floor(Math.random() * 900) + 120,
    topWords:         ['WANT', 'EAT', 'GO', 'DRINK', 'MORE'].slice(0, 3)
  }
})
