import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useGazeSettings, mergeUniqueListsById, mergeDeletedLists, mergeSettingsLists } from '@context/GazeSettingsContext'
import { useGazeHeatmap } from '@context/GazeHeatmapContext'
import { signOutCaregiver } from '../engine/firebase'
import { SyncAdapter } from '../engine/SyncAdapter'
import './CaregiverPanel.css'

/** Format a unix-ms timestamp as a relative string, e.g. "3 minutes ago" */
function _relTime(ts) {
  if (!ts) return 'Never'
  const diffMs = Date.now() - ts
  const s = Math.round(diffMs / 1000)
  if (s < 60)  return 'just now'
  const m = Math.round(s / 60)
  if (m < 60)  return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7)   return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

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
export function CaregiverPanel({ open, onClose, onShowLogin }) {
  const [activeTab, setActiveTab] = useState('history')

  if (!open) return null

  const panel = (
    <div className="cp__backdrop" role="dialog" aria-modal="true" aria-label="User Settings">
      <div className="cp">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <header className="cp__header">
          <span className="cp__header-icon">⚙️</span>
          <h2 className="cp__title">User Settings</h2>
          <button className="cp__close" onClick={onClose} aria-label="Close user settings">✕</button>
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
          {activeTab === 'heatmap' && <HeatmapTab onClose={onClose} />}
          {activeTab === 'pin'     && <PinTab onClose={onClose} />}
          {activeTab === 'sync'    && <SyncTab onShowLogin={onShowLogin} />}
        </div>

      </div>
    </div>
  )

  return createPortal(panel, document.body)
}

// ─── Tab definitions ──────────────────────────────────────────────────────────

const TABS = [
  { id: 'history', icon: '📊',  label: 'Session History' },
  { id: 'heatmap', icon: '🔥',  label: 'Gaze Heatmap' },
  { id: 'pin',     icon: '🔑',  label: 'Access PIN' },
  { id: 'sync',    icon: '☁️',  label: 'Cloud Sync' }
]


// ─── Tab 1: Session History ───────────────────────────────────────────────────


function HistoryTab() {
  const [log, setLog]         = useState(null)
  const [loading, setLoading] = useState(true)
  const [cleared, setCleared] = useState(false)

  useEffect(() => {
    if (window.gazeAPI?.sessions) {
      window.gazeAPI.sessions.getAll()
        .then(data => { setLog(data ?? []); setLoading(false) })
        .catch(() => { setLog([]); setLoading(false) })
    } else {
      // Local localStorage fallback
      let localSessions = []
      try {
        const existing = localStorage.getItem('gaze_session_log')
        if (existing) localSessions = JSON.parse(existing)
      } catch (e) {}

      // If they are not logged in, just show local sessions or fallback to mock data if empty
      const adapter = SyncAdapter.getInstance()
      if (!adapter.userId) {
        setLog(localSessions.length > 0 ? localSessions : MOCK_LOG)
        setLoading(false)
      } else {
        // If logged in, fetch remote sessions and merge
        adapter.pullSessionLog()
          .then(remoteSessions => {
            if (remoteSessions && remoteSessions.length > 0) {
              const mergedMap = new Map()
              localSessions.forEach(s => mergedMap.set(s.savedAt || s.date, s))
              remoteSessions.forEach(s => mergedMap.set(s.savedAt || s.date, s))
              const mergedArray = Array.from(mergedMap.values()).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))
              
              localStorage.setItem('gaze_session_log', JSON.stringify(mergedArray.slice(-90)))
              setLog(mergedArray)
            } else {
              setLog(localSessions)
            }
            setLoading(false)
          })
          .catch(() => {
            setLog(localSessions)
            setLoading(false)
          })
      }
    }
  }, [cleared])

  const handleClear = async () => {
    if (!window.confirm('Clear all session history? This cannot be undone.')) return
    if (window.gazeAPI?.sessions) {
      await window.gazeAPI.sessions.clear()
    } else {
      localStorage.removeItem('gaze_session_log')
    }
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
    
    if (window.gazeAPI?.sessions) {
      const result = await window.gazeAPI.sessions.exportCsv(csv)
      if (result?.ok) {
        console.log('[CaregiverPanel] CSV exported to:', result.filePath)
      }
    } else {
      // Browser download fallback
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.setAttribute('href', url)
      link.setAttribute('download', `gazeaac-sessions-${new Date().toISOString().slice(0, 10)}.csv`)
      link.style.visibility = 'hidden'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
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

// ─── Tab 3: Cloud Sync ──────────────────────────────────────────────────────────

function SyncTab({ onShowLogin }) {
  const { currentUser, settings, updateSettings } = useGazeSettings()
  const [syncing, setSyncing] = useState(false)
  const [statusMsg, setStatusMsg] = useState(null)
  const [errorMsg, setErrorMsg] = useState(null)

  // Device list states
  const [devices, setDevices] = useState([])
  const [loadingDevices, setLoadingDevices] = useState(false)

  const reloadDevices = async () => {
    if (!currentUser) return
    setLoadingDevices(true)
    try {
      const adapter = SyncAdapter.getInstance()
      if (adapter.getAvailableDevices) {
        const list = await adapter.getAvailableDevices(settings.deviceId)
        setDevices(list)
      }
    } catch (err) {
      console.warn('[SyncTab] Failed to load devices:', err)
    } finally {
      setLoadingDevices(false)
    }
  }

  useEffect(() => {
    if (currentUser) {
      reloadDevices()
    } else {
      setDevices([])
    }
  }, [currentUser, settings.deviceId])

  const handleSignOut = async () => {
    setStatusMsg(null)
    setErrorMsg(null)
    setSyncing(true)
    try {
      await signOutCaregiver()
      setStatusMsg('Signed out. The login screen will appear next time you restart GazeAAC.')
    } catch (err) {
      setErrorMsg(err.message || 'Logout failed.')
    } finally {
      setSyncing(false)
    }
  }

  const handleForceSync = async () => {
    setStatusMsg(null)
    setErrorMsg(null)
    setSyncing(true)
    try {
      const adapter = SyncAdapter.getInstance()
      setStatusMsg('Starting manual cloud synchronization...')

      // 1. Settings
      const remoteSettings = await adapter.pullSettings(settings.deviceId)
      let currentMergedSettings = { ...settings }
      if (remoteSettings) {
        currentMergedSettings = { ...settings, ...remoteSettings }
        
        // Merge deleted lists first
        currentMergedSettings.deletedFaceIds = mergeDeletedLists(settings.deletedFaceIds, remoteSettings.deletedFaceIds)
        currentMergedSettings.deletedPhotoIds = mergeDeletedLists(settings.deletedPhotoIds, remoteSettings.deletedPhotoIds)
        currentMergedSettings.deletedObjectIds = mergeDeletedLists(settings.deletedObjectIds, remoteSettings.deletedObjectIds)

        currentMergedSettings.registeredFaces = mergeSettingsLists(
          settings.registeredFaces, 
          remoteSettings.registeredFaces, 
          currentMergedSettings.deletedFaceIds, 
          currentMergedSettings.deletedPhotoIds
        )
        currentMergedSettings.registeredObjects = mergeSettingsLists(
          settings.registeredObjects, 
          remoteSettings.registeredObjects, 
          currentMergedSettings.deletedObjectIds, 
          []
        )
        updateSettings(currentMergedSettings)
        await adapter.pushSettings(currentMergedSettings, settings.deviceId)
      } else {
        await adapter.pushSettings(settings, settings.deviceId)
      }

      // 2. Profile
      if (adapter.pullUserProfile) {
        const remoteProfile = await adapter.pullUserProfile()
        const localProfile = await window.gazeAPI?.userProfile?.get()
        if (remoteProfile) {
          const mergedProfile = { ...localProfile, ...remoteProfile }
          await window.gazeAPI?.userProfile?.set(mergedProfile)
          await adapter.pushUserProfile(mergedProfile)
        } else if (localProfile) {
          await adapter.pushUserProfile(localProfile)
        }
      }

      // 3. Board edits
      if (adapter.pullBoardEdits) {
        const remoteEdits = await adapter.pullBoardEdits()
        const localEdits = await window.gazeAPI?.boardEdits?.getAll()
        if (remoteEdits) {
          const mergedEdits = { ...localEdits, ...remoteEdits }
          await window.gazeAPI?.settings?.set('boardEdits', mergedEdits)
          await adapter.pushBoardEdits(mergedEdits)
        } else if (localEdits && Object.keys(localEdits).length > 0) {
          await adapter.pushBoardEdits(localEdits)
        }
      }

      // 4. AI history
      if (adapter.pullAIHistory) {
        const remoteHistory = await adapter.pullAIHistory()
        const localHistory = await window.gazeAPI?.aiHistory?.getAll() ?? []
        if (remoteHistory && remoteHistory.length > 0) {
          const mergedMap = new Map()
          localHistory.forEach(h => mergedMap.set(h.savedAt, h))
          remoteHistory.forEach(h => mergedMap.set(h.savedAt, h))
          const mergedHistory = Array.from(mergedMap.values()).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))
          await window.gazeAPI?.settings?.set('aiHistory', mergedHistory)
          await adapter.pushAIHistory(mergedHistory)
        } else if (localHistory.length > 0) {
          await adapter.pushAIHistory(localHistory)
        }
      }

      // 5. Sessions
      const remoteSessions = await adapter.pullSessionLog()
      let localSessions = []
      if (window.gazeAPI?.sessions) {
        localSessions = await window.gazeAPI.sessions.getAll() ?? []
      } else {
        try {
          const existing = localStorage.getItem('gaze_session_log')
          if (existing) localSessions = JSON.parse(existing)
        } catch (e) {}
      }

      if (remoteSessions && remoteSessions.length > 0) {
        const mergedMap = new Map()
        localSessions.forEach(s => mergedMap.set(s.savedAt || s.date, s))
        remoteSessions.forEach(s => mergedMap.set(s.savedAt || s.date, s))
        const mergedArray = Array.from(mergedMap.values()).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))
        
        if (window.gazeAPI?.settings) {
          await window.gazeAPI.settings.set('sessionLog', mergedArray.slice(-90))
        } else {
          localStorage.setItem('gaze_session_log', JSON.stringify(mergedArray.slice(-90)))
        }
        await adapter.pushSessionLog(mergedArray)
      } else if (localSessions.length > 0) {
        await adapter.pushSessionLog(localSessions)
      }

      setStatusMsg('Manual cloud sync completed successfully!')
      
      // Reload devices on sync completion
      await reloadDevices()
    } catch (err) {
      setErrorMsg(`Manual sync failed: ${err.message}`)
    } finally {
      setSyncing(false)
    }
  }

  // ── Authenticated state ───────────────────────────────────────────────────
  if (currentUser) {
    const displayName = currentUser.displayName || currentUser.email?.split('@')[0] || 'Caregiver'
    const avatarChar  = (currentUser.displayName?.[0] || currentUser.email?.[0] || '?').toUpperCase()

    return (
      <div className="cp-sync">
        <h3 className="cp-sync__title">Cloud Synchronization</h3>
        <p className="cp-sync__desc">
          GazeAAC Cloud persistence is active. Your settings, Gemini API key, board configurations,
          AI history, and session logs are securely synced across devices.
        </p>

        <div className="cp-sync__card">
          <div className="cp-sync__profile">
            <div className="cp-sync__avatar-circle">{avatarChar}</div>
            <div className="cp-sync__info">
              <span className="cp-sync__email-label">{displayName}</span>
              <strong className="cp-sync__email">{currentUser.email}</strong>
            </div>
          </div>

          <div className="cp-sync__status-badge">
            <span className="cp-sync__status-dot cp-sync__status-dot--active"></span>
            Cloud Sync Enabled
          </div>
        </div>

        <div className="cp-sync__biometrics-status">
          <span className="cp-sync__biometrics-icon">🧬</span>
          <div className="cp-sync__biometrics-info">
            <strong className="cp-sync__biometrics-title">Synced Biometrics Status</strong>
            <span className="cp-sync__biometrics-desc">
              <strong>{settings.registeredFaces?.length || 0} Face Profiles</strong> and{' '}
              <strong>{settings.registeredObjects?.length || 0} Custom Objects / Locations</strong> are fully synced to the cloud and available on all connected devices.
            </span>
          </div>
        </div>

        {/* Synced Biometrics Profile List */}
        {settings.registeredFaces && settings.registeredFaces.length > 0 && (
          <div className="cp-sync__biometrics-list-section">
            <h4 className="cp-sync__sub-title">Synced Caregiver Profiles</h4>
            <p className="cp-sync__desc-sm">
              The following registered profiles are available across all synchronized devices:
            </p>
            <div className="cp-sync__biometrics-list">
              {settings.registeredFaces.map(face => {
                const photosCount = face.photos?.length || 0
                return (
                  <div key={face.id} className="cp-biometrics-card">
                    <div className="cp-biometrics-card__left">
                      <span className="cp-biometrics-card__avatar">👤</span>
                      <div className="cp-biometrics-card__info">
                        <span className="cp-biometrics-card__name">{face.name}</span>
                        <span className="cp-biometrics-card__meta">
                          Added {_relTime(face.addedAt)}{face.addedByDevice ? ` on ${face.addedByDevice}` : ''}
                        </span>
                      </div>
                    </div>
                    <div className="cp-biometrics-card__badge-wrap">
                      <span className={`cp-biometrics-badge ${photosCount > 0 ? 'cp-biometrics-badge--active' : 'cp-biometrics-badge--empty'}`}>
                        📸 {photosCount} {photosCount === 1 ? 'photo' : 'photos'}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Registered Devices */}
        <div className="cp-sync__devices-section">
          <h4 className="cp-sync__sub-title">Registered Devices</h4>
          <p className="cp-sync__desc-sm">
            All devices connected and synchronized to your account:
          </p>

          {loadingDevices ? (
            <div className="cp-sync__loading-devices">
              <span className="cp-sync__spinner-sm"></span> Loading synced devices...
            </div>
          ) : devices.length === 0 ? (
            <div className="cp-sync__no-devices">No synced devices found.</div>
          ) : (
            <div className="cp-sync__device-list">
              {devices.map(dev => (
                <div key={dev.deviceId} className={`cp-device-card ${dev.isCurrent ? 'cp-device-card--current' : ''}`}>
                  <div className="cp-device-card__left">
                    <span className="cp-device-card__icon">
                      {dev.deviceOS.toLowerCase().includes('win') ? '🖥️' : dev.deviceOS.toLowerCase().includes('mac') ? '💻' : '📱'}
                    </span>
                    <div className="cp-device-card__info">
                      <div className="cp-device-card__name-row">
                        <span className="cp-device-card__name">{dev.deviceName}</span>
                        {dev.isCurrent && <span className="cp-device-badge cp-device-badge--current">Current</span>}
                        {!dev.isCurrent && <span className="cp-device-badge cp-device-badge--synced">Active</span>}
                      </div>
                      <span className="cp-device-card__os">{dev.deviceOS} · ID: {dev.deviceId.slice(0, 8)}...</span>
                      <span className="cp-device-card__activity">Last active: {_relTime(dev.lastActive)}</span>
                    </div>
                  </div>
                  {/* Usage Patterns */}
                  <div className="cp-device-card__usage">
                    <span className="cp-device-card__usage-title">Usage Config</span>
                    <div className="cp-device-card__usage-grid">
                      <span className="cp-device-card__usage-item">🎯 Dwell: {dev.dwellMs ?? 800}ms</span>
                      <span className="cp-device-card__usage-item">🗣️ Voice: {dev.ttsEngine === 'winrt' ? 'WinRT' : 'SAPI'}</span>
                      <span className="cp-device-card__usage-item">📋 Stage: {dev.stage ?? 3}</span>
                      <span className="cp-device-card__usage-item">🖱️ Input: {dev.mouseHoverMode ? 'Mouse' : 'Gaze'}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {statusMsg && <div className="cp-sync__alert cp-sync__alert--success">{statusMsg}</div>}
        {errorMsg  && <div className="cp-sync__alert cp-sync__alert--error">{errorMsg}</div>}

        {/* ── Cloud Settings Dashboard ────────────────────────────────── */}
        <div className="cp-sync__settings-dashboard">
          <h4 className="cp-sync__sub-title">☁️ Cloud-Synced Settings</h4>
          <p className="cp-sync__desc-sm">
            These settings are stored in Firebase and automatically applied on all signed-in devices.
          </p>

          {/* Group: AI Services */}
          <div className="cp-sync__settings-group">
            <div className="cp-sync__settings-group-header">
              <span className="cp-sync__settings-group-icon">🤖</span>
              <span className="cp-sync__settings-group-title">AI Services &amp; API Keys</span>
            </div>
            <div className="cp-sync__settings-rows">
              {/* Gemini */}
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Gemini API Key</span>
                <span className={`cp-sync__setting-value ${(settings.geminiApiKey ?? '').trim() ? 'cp-sync__setting-value--ok' : 'cp-sync__setting-value--empty'}`}>
                  {(settings.geminiApiKey ?? '').trim()
                    ? `✓ Set (…${settings.geminiApiKey.slice(-6)})`
                    : '— Not configured'}
                </span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Gemini Model</span>
                <span className="cp-sync__setting-value">{settings.geminiModel || 'gemini-2.5-flash'}</span>
              </div>
              {/* OpenAI */}
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">OpenAI (ChatGPT) API Key</span>
                <span className={`cp-sync__setting-value ${(settings.openAiApiKey ?? '').trim() ? 'cp-sync__setting-value--ok' : 'cp-sync__setting-value--empty'}`}>
                  {(settings.openAiApiKey ?? '').trim()
                    ? `✓ Set (…${settings.openAiApiKey.slice(-6)})`
                    : '— Not configured'}
                </span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">OpenAI Model</span>
                <span className="cp-sync__setting-value">{settings.openAiModel || 'gpt-4o-mini'}</span>
              </div>
              {/* Provider Order */}
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">AI Provider Priority</span>
                <span className="cp-sync__setting-value">
                  {(settings.cloudAiProviderOrder ?? ['gemini', 'openai'])
                    .map((p, i) => `${i + 1}. ${p.charAt(0).toUpperCase() + p.slice(1)}`)
                    .join(' → ')}
                </span>
              </div>
              {/* Routing */}
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">AI Routing Strategy</span>
                <span className="cp-sync__setting-value">
                  {settings.contextualRouting === 'local-only' ? '🏠 Local Only' : '🌐 Internet First'}
                </span>
              </div>
            </div>
          </div>

          {/* Group: Contextual Response */}
          <div className="cp-sync__settings-group">
            <div className="cp-sync__settings-group-header">
              <span className="cp-sync__settings-group-icon">💬</span>
              <span className="cp-sync__settings-group-title">Contextual Response Board</span>
            </div>
            <div className="cp-sync__settings-rows">
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Contextual Board</span>
                <span className={`cp-sync__setting-value ${settings.contextualResponseEnabled ? 'cp-sync__setting-value--ok' : 'cp-sync__setting-value--off'}`}>
                  {settings.contextualResponseEnabled ? '✓ Enabled' : '✗ Disabled'}
                </span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">AI Backend</span>
                <span className="cp-sync__setting-value">
                  {settings.contextualResponseModel === 'ollama' ? `Ollama (${settings.contextualOllamaModel || 'llama3.2'})` : 'Window AI'}
                </span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Suggestion Range</span>
                <span className="cp-sync__setting-value">
                  {settings.contextualResponseMinCount ?? 4}–{settings.contextualResponseCount ?? 6} suggestions
                </span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">On Selection</span>
                <span className="cp-sync__setting-value">
                  {({ speak: '🔊 Speak', push: '📝 Push to bar', both: '🔊📝 Speak &amp; Push' })[settings.contextualResponseAction ?? 'both'] ?? 'Both'}
                </span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Answer Gate Delay</span>
                <span className="cp-sync__setting-value">
                  {(settings.answerGateMs ?? 0) === 0 ? 'Off' : `${settings.answerGateMs}ms`}
                </span>
              </div>
              {(settings.contextualLifeLore ?? '').trim() && (
                <div className="cp-sync__setting-row cp-sync__setting-row--multiline">
                  <span className="cp-sync__setting-label">Life Context (Lore)</span>
                  <span className="cp-sync__setting-value cp-sync__setting-value--lore">
                    {settings.contextualLifeLore.length > 80
                      ? settings.contextualLifeLore.slice(0, 80) + '…'
                      : settings.contextualLifeLore}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Group: Movie Time */}
          <div className="cp-sync__settings-group">
            <div className="cp-sync__settings-group-header">
              <span className="cp-sync__settings-group-icon">🎬</span>
              <span className="cp-sync__settings-group-title">Movie Time</span>
            </div>
            <div className="cp-sync__settings-rows">
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">YouTube API Keys</span>
                <span className={`cp-sync__setting-value ${(settings.movieTimeYoutubeKeys ?? []).length > 0 ? 'cp-sync__setting-value--ok' : 'cp-sync__setting-value--empty'}`}>
                  {(settings.movieTimeYoutubeKeys ?? []).length > 0
                    ? `✓ ${settings.movieTimeYoutubeKeys.length} key(s) configured`
                    : '— No API keys'}
                </span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Safe Search</span>
                <span className="cp-sync__setting-value">
                  {({ strict: '🛡️ Strict', moderate: '⚠️ Moderate', none: '🔓 None' })[settings.movieTimeSafeSearch ?? 'strict']}
                </span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Language</span>
                <span className="cp-sync__setting-value">{settings.movieTimeLanguage || 'en'}</span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Sort By</span>
                <span className="cp-sync__setting-value">
                  {(settings.movieTimePopularOrder ?? true) ? '📈 Most Popular' : '🕐 Recent'}
                </span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Max Daily Watch</span>
                <span className="cp-sync__setting-value">
                  {(settings.movieTimeMaxDailyMinutes ?? 60) >= 720 ? 'Unlimited' : `${settings.movieTimeMaxDailyMinutes ?? 60} min`}
                </span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Quiz Difficulty</span>
                <span className="cp-sync__setting-value">{settings.movieTimePuzzleDifficulty || 'Easy'}</span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Questions Per Quiz</span>
                <span className="cp-sync__setting-value">{settings.movieTimePuzzleQuestionsPerQuiz ?? 3}</span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Auto-Pause on Gaze Lost</span>
                <span className={`cp-sync__setting-value ${(settings.movieTimePauseOnGazeLost ?? true) ? 'cp-sync__setting-value--ok' : 'cp-sync__setting-value--off'}`}>
                  {(settings.movieTimePauseOnGazeLost ?? true) ? '✓ On' : '✗ Off'}
                </span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Topics</span>
                <span className="cp-sync__setting-value">
                  {(settings.movieTimeTopics ?? []).join(', ') || 'Any'}
                </span>
              </div>
            </div>
          </div>

          {/* Group: AAC & Board */}
          <div className="cp-sync__settings-group">
            <div className="cp-sync__settings-group-header">
              <span className="cp-sync__settings-group-icon">📋</span>
              <span className="cp-sync__settings-group-title">AAC Board &amp; Vocabulary</span>
            </div>
            <div className="cp-sync__settings-rows">
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Vocabulary Stage</span>
                <span className="cp-sync__setting-value">Stage {settings.stage ?? 3}</span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Custom Vocab Words</span>
                <span className="cp-sync__setting-value">
                  {(settings.customVocabIds ?? []).length} word(s)
                </span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Font Scale</span>
                <span className="cp-sync__setting-value">{settings.fontScale ?? 2.0}×</span>
              </div>
              <div className="cp-sync__setting-row">
                <span className="cp-sync__setting-label">Auto-Return Home</span>
                <span className={`cp-sync__setting-value ${(settings.autoReturnHome ?? true) ? 'cp-sync__setting-value--ok' : 'cp-sync__setting-value--off'}`}>
                  {(settings.autoReturnHome ?? true) ? '✓ On' : '✗ Off'}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="cp-sync__actions">
          <button
            className="cp-vocab__btn cp-vocab__btn--save cp-sync__btn"
            onClick={handleForceSync}
            disabled={syncing}
          >
            {syncing ? 'Syncing...' : '🔄 Sync Now'}
          </button>
          <button
            className="cp-vocab__btn cp-sync__btn-secondary"
            onClick={handleSignOut}
            disabled={syncing}
          >
            Sign Out
          </button>
        </div>
      </div>
    )
  }

  // ── Guest / not logged in state ───────────────────────────────────────────
  return (
    <div className="cp-sync">
      <h3 className="cp-sync__title">Cloud Synchronization</h3>
      <p className="cp-sync__desc">
        You are currently in <strong>Guest Mode</strong>. Settings, your Gemini API key, and session
        history are stored locally only.
      </p>

      <div className="cp-sync__guest-card">
        <div className="cp-sync__guest-icon">☁️</div>
        <div className="cp-sync__guest-body">
          <span className="cp-sync__guest-title">Sign in to unlock Cloud Sync</span>
          <span className="cp-sync__guest-desc">
            Sign in with email or Google to back up your settings, Gemini API key,
            and session history across devices.
          </span>
        </div>
      </div>

      <div className="cp-sync__biometrics-status cp-sync__biometrics-status--guest">
        <span className="cp-sync__biometrics-icon">⚠️</span>
        <div className="cp-sync__biometrics-info">
          <strong className="cp-sync__biometrics-title">Local Biometrics Profile</strong>
          <span className="cp-sync__biometrics-desc">
            <strong>{settings.registeredFaces?.length || 0} Face Profiles</strong> and{' '}
            <strong>{settings.registeredObjects?.length || 0} Custom Objects / Locations</strong> are stored locally only. Sign in to synchronize them to the cloud.
          </span>
        </div>
      </div>

      {/* Local Biometrics Profile List */}
      {settings.registeredFaces && settings.registeredFaces.length > 0 && (
        <div className="cp-sync__biometrics-list-section">
          <h4 className="cp-sync__sub-title">Local Caregiver Profiles</h4>
          <p className="cp-sync__desc-sm">
            The following profiles are currently stored offline on this device:
          </p>
          <div className="cp-sync__biometrics-list">
            {settings.registeredFaces.map(face => {
              const photosCount = face.photos?.length || 0
              return (
                <div key={face.id} className="cp-biometrics-card">
                  <div className="cp-biometrics-card__left">
                    <span className="cp-biometrics-card__avatar">👤</span>
                    <div className="cp-biometrics-card__info">
                      <span className="cp-biometrics-card__name">{face.name}</span>
                      <span className="cp-biometrics-card__meta">
                        Added {_relTime(face.addedAt)}{face.addedByDevice ? ` on ${face.addedByDevice}` : ''}
                      </span>
                    </div>
                  </div>
                  <div className="cp-biometrics-card__badge-wrap">
                    <span className={`cp-biometrics-badge ${photosCount > 0 ? 'cp-biometrics-badge--active' : 'cp-biometrics-badge--empty'}`}>
                      📸 {photosCount} {photosCount === 1 ? 'photo' : 'photos'}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {onShowLogin && (
        <button
          id="cp-sync-signin-btn"
          className="cp-btn cp-btn--primary cp-sync__btn"
          onClick={onShowLogin}
        >
          🔐 Sign In / Create Account
        </button>
      )}

      {/* Local Device Info */}
      <div className="cp-sync__devices-section">
        <h4 className="cp-sync__sub-title">Local Device Profile</h4>
        <div className="cp-device-card cp-device-card--local">
          <div className="cp-device-card__left">
            <span className="cp-device-card__icon">
              {(settings.deviceOS ?? '').toLowerCase().includes('win') ? '🖥️' : (settings.deviceOS ?? '').toLowerCase().includes('mac') ? '💻' : '📱'}
            </span>
            <div className="cp-device-card__info">
              <div className="cp-device-card__name-row">
                <span className="cp-device-card__name">{settings.deviceName || 'Local PC'}</span>
                <span className="cp-device-badge cp-device-badge--local">Local</span>
              </div>
              <span className="cp-device-card__os">{settings.deviceOS || 'Unknown OS'} · ID: {(settings.deviceId || '').slice(0, 8)}...</span>
              <span className="cp-device-card__activity">Logged In: No (Guest Mode)</span>
            </div>
          </div>
          <div className="cp-device-card__usage">
            <span className="cp-device-card__usage-title">Usage Config</span>
            <div className="cp-device-card__usage-grid">
              <span className="cp-device-card__usage-item">🎯 Dwell: {settings.dwellMs ?? 800}ms</span>
              <span className="cp-device-card__usage-item">🗣️ Voice: {settings.ttsEngine === 'winrt' ? 'WinRT' : 'SAPI'}</span>
              <span className="cp-device-card__usage-item">📋 Stage: {settings.stage ?? 3}</span>
              <span className="cp-device-card__usage-item">🖱️ Input: {settings.mouseHoverMode ? 'Mouse' : 'Gaze'}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="cp-sync__features">
        {[
          { icon: '🔑', text: 'Gemini & OpenAI API keys synced across devices' },
          { icon: '🤖', text: 'AI service configuration & provider order backed up' },
          { icon: '💬', text: 'Contextual response settings synced' },
          { icon: '🎬', text: 'Movie Time preferences & quiz settings synced' },
          { icon: '⚙️', text: 'AAC board, vocabulary & visual settings backed up' },
          { icon: '📊', text: 'Session history preserved across installs' },
        ].map((f, i) => (
          <div key={i} className="cp-sync__feature-row">
            <span>{f.icon}</span>
            <span>{f.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function drawMockup(ctx, width, height, mode) {
  ctx.fillStyle = '#0d0f16'
  ctx.fillRect(0, 0, width, height)
  
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)'
  ctx.lineWidth = 2
  
  if (mode === 'aac') {
    // Draw a 6x4 grid of buttons
    const cols = 6
    const rows = 4
    const cw = width / cols
    const ch = height / rows
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.strokeRect(c * cw + 4, r * ch + 4, cw - 8, ch - 8)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.02)'
        ctx.fillRect(c * cw + 4, r * ch + 4, cw - 8, ch - 8)
      }
    }
  } else if (mode === 'movie') {
    // Draw video player area + sidebar
    // Left video player (70% width)
    ctx.strokeRect(10, 10, width * 0.7 - 15, height - 20)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)'
    ctx.fillRect(10, 10, width * 0.7 - 15, height - 20)
    
    // Right sidebar items
    const sbX = width * 0.7 + 5
    const sbW = width * 0.3 - 15
    const itemH = (height - 30) / 3
    for (let i = 0; i < 3; i++) {
      ctx.strokeRect(sbX, 10 + i * (itemH + 5), sbW, itemH)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.02)'
      ctx.fillRect(sbX, 10 + i * (itemH + 5), sbW, itemH)
    }
  } else if (mode === 'games') {
    // Center circle (balloon pop)
    ctx.beginPath()
    ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.35, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)'
    ctx.fill()
    
    // Game hub cards (left & right buttons)
    ctx.strokeRect(15, 15, 100, 50)
    ctx.strokeRect(width - 115, 15, 100, 50)
  }
}

function HeatmapTab({ onClose }) {
  const { heatmapData, clearHeatmap, analyzeBlindSpots, toggleHeatmapOverlay } = useGazeHeatmap()
  const [selectedMode, setSelectedMode] = useState('aac')
  const previewCanvasRef = useRef(null)

  const points = heatmapData[selectedMode] || []
  const analysis = analyzeBlindSpots(selectedMode)

  useEffect(() => {
    const canvas = previewCanvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const width = 450
    const height = 300
    canvas.width = width
    canvas.height = height

    // 1. Draw wireframe mockup
    drawMockup(ctx, width, height, selectedMode)

    if (points.length === 0) {
      // Draw "No data" message in the center
      ctx.fillStyle = 'rgba(136, 153, 170, 0.5)'
      ctx.font = '14px Inter, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('No gaze data recorded yet.', width / 2, height / 2)
      return
    }

    // 2. Draw raw heat points in grayscale (temporary accumulation)
    const heatCanvas = document.createElement('canvas')
    heatCanvas.width = width
    heatCanvas.height = height
    const heatCtx = heatCanvas.getContext('2d')
    
    heatCtx.globalCompositeOperation = 'screen'
    const radius = 25 // smaller radius for preview
    
    points.forEach(p => {
      const px = p.x * width
      const py = p.y * height
      
      const grad = heatCtx.createRadialGradient(px, py, 0, px, py, radius)
      grad.addColorStop(0, 'rgba(0, 0, 0, 0.22)')
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
      
      heatCtx.fillStyle = grad
      heatCtx.beginPath()
      heatCtx.arc(px, py, radius, 0, Math.PI * 2)
      heatCtx.fill()
    })

    // 3. Colorize and blend with the wireframe background
    try {
      const imgData = heatCtx.getImageData(0, 0, width, height)
      const data = imgData.data

      const tempCanvas = document.createElement('canvas')
      tempCanvas.width = 256
      tempCanvas.height = 1
      const tempCtx = tempCanvas.getContext('2d')
      const gradient = tempCtx.createLinearGradient(0, 0, 256, 0)
      gradient.addColorStop(0.0, 'rgba(0, 0, 255, 0)')
      gradient.addColorStop(0.25, 'rgba(0, 0, 255, 0.45)')
      gradient.addColorStop(0.45, 'rgba(0, 255, 255, 0.65)')
      gradient.addColorStop(0.68, 'rgba(0, 255, 0, 0.8)')
      gradient.addColorStop(0.88, 'rgba(255, 255, 0, 0.9)')
      gradient.addColorStop(1.0, 'rgba(255, 0, 0, 0.95)')
      tempCtx.fillStyle = gradient
      tempCtx.fillRect(0, 0, 256, 1)
      const rampData = tempCtx.getImageData(0, 0, 256, 1).data

      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3]
        if (alpha > 0) {
          const rampIndex = alpha * 4
          data[i]     = rampData[rampIndex]
          data[i + 1] = rampData[rampIndex + 1]
          data[i + 2] = rampData[rampIndex + 2]
          data[i + 3] = rampData[rampIndex + 3]
        }
      }
      
      heatCtx.globalCompositeOperation = 'source-over'
      heatCtx.putImageData(imgData, 0, 0)

      ctx.drawImage(heatCanvas, 0, 0)
    } catch (e) {
      console.error('[CaregiverPanel] Error colorizing preview canvas:', e)
    }
  }, [selectedMode, points])

  const handleLaunchOverlay = () => {
    onClose?.()
    toggleHeatmapOverlay()
  }

  const handleClear = () => {
    const modeLabels = {
      aac: 'AAC Board',
      movie: 'Movie Time',
      games: 'Games'
    }
    if (window.confirm(`Clear all recorded eye gaze data for ${modeLabels[selectedMode] || selectedMode}?`)) {
      clearHeatmap(selectedMode)
    }
  }

  const getQuadrantStatusClass = (pct) => {
    if (pct < 8) return 'cp-quadrant--blind'
    if (pct < 15) return 'cp-quadrant--low'
    return 'cp-quadrant--good'
  }

  const getQuadrantLabel = (pct) => {
    if (pct < 8) return 'Blind Spot'
    if (pct < 15) return 'Low Attention'
    return 'Good Attention'
  }

  return (
    <div className="cp-heatmap">
      <div className="cp-heatmap__header">
        <p className="cp-vocab__desc">
          Analyze Johnny's eye-gaze distribution. This helps detect visual field neglect or blind spots so you can optimize button layouts.
        </p>
        <div className="cp-heatmap__mode-selector">
          {[
            { id: 'aac', label: '🗣️ AAC Board' },
            { id: 'movie', label: '🎬 Movie Time' },
            { id: 'games', label: '🎮 Games' }
          ].map(m => (
            <button
              key={m.id}
              className={`cp-heatmap__mode-btn ${selectedMode === m.id ? 'cp-heatmap__mode-btn--active' : ''}`}
              onClick={() => setSelectedMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="cp-heatmap__container">
        {/* Left Column: Canvas Preview */}
        <div className="cp-heatmap__preview-panel">
          <div className="cp-heatmap__canvas-container">
            <canvas ref={previewCanvasRef} className="cp-heatmap__canvas" />
            <div className="cp-heatmap__canvas-badge">Layout Wireframe Mockup</div>
          </div>
          <div className="cp-heatmap__canvas-actions">
            <button className="cp-vocab__btn cp-vocab__btn--save cp-heatmap__action-btn" onClick={handleLaunchOverlay}>
              🔥 View Overlay on Live Screen
            </button>
            <button 
              className="cp-vocab__btn cp-vocab__btn--danger cp-heatmap__action-btn" 
              onClick={handleClear} 
              disabled={points.length === 0}
            >
              🗑️ Clear Category Data
            </button>
          </div>
        </div>

        {/* Right Column: Quantitative & Qualitative Analysis */}
        <div className="cp-heatmap__analysis-panel">
          <h3 className="cp-history__chart-title">Attention Profile</h3>
          
          <div className="cp-heatmap__quick-stats">
            <div className="cp-heatmap__stat-row">
              <span>Recorded Gaze Samples:</span>
              <strong>{points.length} / 3000</strong>
            </div>
            <div className="cp-heatmap__stat-row">
              <span>Status:</span>
              <strong className={analysis.hasData ? 'status--active' : 'status--empty'}>
                {analysis.hasData ? 'Analysis Ready' : 'Need More Data'}
              </strong>
            </div>
          </div>

          <h4 className="cp-heatmap__section-subtitle">Screen Quadrant Breakdown</h4>
          <div className="cp-heatmap__quadrants-grid">
            {[
              { id: 'tl', name: 'Top-Left', pct: analysis.quadrants.tl },
              { id: 'tr', name: 'Top-Right', pct: analysis.quadrants.tr },
              { id: 'bl', name: 'Bottom-Left', pct: analysis.quadrants.bl },
              { id: 'br', name: 'Bottom-Right', pct: analysis.quadrants.br }
            ].map(q => (
              <div key={q.id} className={`cp-quadrant ${getQuadrantStatusClass(q.pct)}`}>
                <span className="cp-quadrant__name">{q.name}</span>
                <span className="cp-quadrant__val">{q.pct}%</span>
                <span className="cp-quadrant__badge">{getQuadrantLabel(q.pct)}</span>
              </div>
            ))}
          </div>

          <div className="cp-heatmap__recommendations">
            <h4 className="cp-heatmap__section-subtitle">Caregiver Recommendations</h4>
            <div className={`cp-heatmap__alert ${analysis.blindSpots.length > 0 ? 'cp-heatmap__alert--warning' : 'cp-heatmap__alert--success'}`}>
              <span className="cp-heatmap__alert-icon">
                {analysis.blindSpots.length > 0 ? '⚠️' : '✅'}
              </span>
              <p className="cp-heatmap__alert-text">{analysis.recommendations}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

