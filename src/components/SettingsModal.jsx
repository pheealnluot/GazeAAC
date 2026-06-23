import { createPortal } from 'react-dom'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useGazeSettings } from '@context/GazeSettingsContext'
import { useVocabulary } from '@context/VocabularyContext'
import { useAACBoards } from '@context/AACBoardContext'
import { BoardEditor } from './BoardEditor'
import { CalibrationScreen } from './CalibrationScreen'
import { checkOllamaAvailable } from '@engine/ContextualResponseEngine'
import { SyncAdapter } from '@engine/SyncAdapter'
import { useCameraVision } from '@context/CameraVisionContext'
import './SettingsModal.css'

/** Format a unix-ms timestamp as a relative string, e.g. "3 minutes ago" */
function _relTime(ts) {
  if (!ts) return ''
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

const PANEL_META = {
  eye:        { icon: '👁',  title: 'Eye Tracker Settings',    theme: 'eye'   },
  aac:        { icon: '🗣',  title: 'AAC Settings',             theme: 'aac'   },
  board:      { icon: '📋',  title: 'Board Settings',           theme: 'board' },
  contextual: { icon: '🧠',  title: 'Contextual Response',      theme: 'eye'   },
  camera:     { icon: '📷',  title: 'Camera & Vision Settings', theme: 'eye'   },
  movietime:  { icon: '🎬',  title: 'Movie Time Settings',      theme: 'aac'   },
  qna:        { icon: '🧩',  title: 'Q&A Settings',             theme: 'aac'   },
}

export function SettingsModal({ open, onClose, initialPanel = 'eye', gazeRef = null, routerRef = null, appVersion = '0.2.6' }) {
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
      <div className={`sm${(activePanel === 'board' || activePanel === 'camera') ? ' sm--fullscreen' : ''}`}>
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
              routerRef={routerRef}
            />
          )}
          {activePanel === 'aac' && (
            <AACPanel
              settings={settings}
              updateSetting={updateSetting}
              updateSettings={updateSettings}
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
          {activePanel === 'contextual' && (
            <ContextualResponsePanel
              settings={settings}
              updateSetting={updateSetting}
            />
          )}
          {activePanel === 'camera' && (
            <CameraPanel
              settings={settings}
              updateSetting={updateSetting}
              updateSettings={updateSettings}
            />
          )}
          {activePanel === 'movietime' && (
            <MovieTimePanel
              settings={settings}
              updateSetting={updateSetting}
              updateSettings={updateSettings}
            />
          )}
          {activePanel === 'qna' && (
            <QNAPanel
              settings={settings}
              updateSetting={updateSetting}
              updateSettings={updateSettings}
            />
          )}
        </div>

        {/* ── Footer ── */}
        <footer className="sm__footer">
          {appVersion && <span className="sm__footer-version">v{appVersion}</span>}
          <button className="sm__reset" onClick={handleReset}>↺ Reset to Defaults</button>
          <button className="sm__done" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

// ─── Panel 1: Eye Tracker ─────────────────────────────────────────────────────

function EyeTrackerPanel({ settings, updateSetting, updateSettings, gazeRef, routerRef }) {
  const [advOpen, setAdvOpen] = useState(false)
  const [showCalibrationExercise, setShowCalibrationExercise] = useState(false)

  // ── Refresh Eye Tracker state ────────────────────────────────────────────
  // 'idle' | 'refreshing' | 'restored' | 'failed'
  const [refreshStatus, setRefreshStatus] = useState('idle')
  const refreshTimerRef = useRef(null)

  const handleRefreshTracker = useCallback(() => {
    const router = routerRef?.current
    if (!router) {
      setRefreshStatus('failed')
      clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => setRefreshStatus('idle'), 3000)
      return
    }
    setRefreshStatus('refreshing')
    router.reconnect()

    // Poll for the first gaze frame arriving after the reconnect request.
    // gazeRef.current is updated on every valid gaze frame by the onGaze
    // callback in App.jsx, so we can detect stream restoration by watching it.
    const startTime = Date.now()
    const prevPos = gazeRef?.current ? { ...gazeRef.current } : null
    const pollId = setInterval(() => {
      const elapsed = Date.now() - startTime
      const pos = gazeRef?.current
      const hasNewFrame = pos && (
        !prevPos ||
        pos.timestamp !== prevPos.timestamp ||
        pos.x !== prevPos.x ||
        pos.y !== prevPos.y
      )
      if (hasNewFrame) {
        clearInterval(pollId)
        setRefreshStatus('restored')
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = setTimeout(() => setRefreshStatus('idle'), 3000)
      } else if (elapsed > 8000) {
        // No frame within 8 s — report failure
        clearInterval(pollId)
        setRefreshStatus('failed')
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = setTimeout(() => setRefreshStatus('idle'), 4000)
      }
    }, 200)

    // Cleanup if the component unmounts while polling
    refreshTimerRef.current = () => {
      clearInterval(pollId)
    }
  }, [routerRef, gazeRef])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (typeof refreshTimerRef.current === 'function') refreshTimerRef.current()
      else clearTimeout(refreshTimerRef.current)
    }
  }, [])

  return (
    <div className="sm-panel__sections">
      {/* ── Calibration Exercise trigger ─────────────────────────────── */}
      <div className="sm-accuracy-banner">
        <div className="sm-accuracy-banner__left">
          <span className="sm-accuracy-banner__icon">🎯</span>
          <div>
            <span className="sm-accuracy-banner__title">Calibration Exercise</span>
            <span className="sm-accuracy-banner__desc">5-point calibration — improves gaze accuracy by computing a correction offset</span>
          </div>
        </div>
        <button
          id="btn-run-calibration-exercise"
          className="sm-btn sm-btn--accent"
          onClick={() => setShowCalibrationExercise(true)}
        >
          ▶ Calibrate
        </button>
      </div>

      {showCalibrationExercise && createPortal(
        <div
          className="sm-calibration-overlay"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100000,
            background: 'var(--color-bg-base, #0c0e14)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <CalibrationScreen
            gazeRef={gazeRef}
            routerRef={routerRef}
            dwellMs={settings.dwellMs}
            enabled={true}
            onComplete={(correctionData) => {
              if (correctionData) {
                // Persist the correction to electron-store and settings context
                window.gazeAPI?.gazeCorrection?.set(correctionData)
                updateSetting('gazeCorrection', correctionData)
              }
              setShowCalibrationExercise(false)
            }}
          />
        </div>,
        document.body
      )}

      {/* ── Refresh Eye Tracker ─────────────────────────────────────────── */}
      <div className={`sm-accuracy-banner sm-refresh-banner${
        refreshStatus === 'restored' ? ' sm-refresh-banner--ok'
        : refreshStatus === 'failed'   ? ' sm-refresh-banner--err'
        : refreshStatus === 'refreshing' ? ' sm-refresh-banner--busy'
        : ''
      }`}>
        <div className="sm-accuracy-banner__left">
          <span className="sm-accuracy-banner__icon">
            {refreshStatus === 'restored' ? '✅'
              : refreshStatus === 'failed' ? '❌'
              : refreshStatus === 'refreshing' ? '🔄'
              : '🔌'}
          </span>
          <div>
            <span className="sm-accuracy-banner__title">Refresh Eye Tracker</span>
            <span className="sm-accuracy-banner__desc">
              {refreshStatus === 'restored'
                ? 'Eye tracker reconnected — gaze stream is live'
                : refreshStatus === 'failed'
                ? 'No gaze frames received — check tracker connection and try again'
                : refreshStatus === 'refreshing'
                ? 'Reconnecting to eye tracker…'
                : 'Re-acquire the eye tracker if it disconnected or failed to load on startup'}
            </span>
          </div>
        </div>
        <button
          id="btn-refresh-eye-tracker"
          className="sm-btn sm-btn--outline"
          disabled={refreshStatus === 'refreshing'}
          onClick={handleRefreshTracker}
        >
          {refreshStatus === 'refreshing' ? '⏳ Connecting…' : '↺ Refresh'}
        </button>
      </div>

      {/* Basic — Dwell */}
      <SectionLabel>Dwell Timing</SectionLabel>
      <Row name="Dwell Threshold" hint="Time to hold gaze for activation">
        <GranularSlider
          id="slider-dwell"
          min={300}
          max={2500}
          step={50}
          value={settings.dwellMs}
          onChange={val => updateSetting('dwellMs', val)}
          unit="ms"
          presets={[
            { value: 300, label: '300 ms (Fast)' },
            { value: 600, label: '600 ms (Normal)' },
            { value: 1000, label: '1000 ms (Deliberate)' },
            { value: 1500, label: '1500 ms (Slow)' },
            { value: 2000, label: '2000 ms (Very Slow)' },
          ]}
        />
      </Row>
      <Row name="Post-Activation Cooldown" hint="After a cell fires, gaze must leave it for this long before the same cell can dwell again. Prevents accidental re-activation.">
        <GranularSlider
          id="slider-post-activation-cooldown"
          min={0}
          max={2000}
          step={10}
          value={settings.postActivationCooldownMs ?? 10}
          onChange={val => updateSetting('postActivationCooldownMs', val)}
          unit="ms"
          presets={[
            { value: 0, label: '0 ms (None)' },
            { value: 100, label: '100 ms (Short)' },
            { value: 300, label: '300 ms (Standard)' },
            { value: 500, label: '500 ms (Medium)' },
            { value: 1000, label: '1000 ms (Long)' },
          ]}
        />
      </Row>

      {/* Dropout */}
      <SectionLabel>Dropout Recovery</SectionLabel>
      <Row name="Decay Half-Life" hint="Speed of progress decay during blinks">
        <GranularSlider
          id="slider-decay"
          min={50}
          max={500}
          step={25}
          value={settings.decayHalfLifeMs}
          onChange={val => updateSetting('decayHalfLifeMs', val)}
          unit="ms"
          presets={[
            { value: 100, label: '100 ms (Fast)' },
            { value: 200, label: '200 ms (Medium)' },
            { value: 300, label: '300 ms (Standard)' },
            { value: 400, label: '400 ms (Slower)' },
          ]}
        />
      </Row>
      <Row name="Max Dropout Window" hint="Hard-reset ceiling for sustained dropout">
        <GranularSlider
          id="slider-max-dropout"
          min={200}
          max={1500}
          step={50}
          value={settings.maxDropoutMs}
          onChange={val => updateSetting('maxDropoutMs', val)}
          unit="ms"
          presets={[
            { value: 250, label: '250 ms (Short)' },
            { value: 500, label: '500 ms (Standard)' },
            { value: 800, label: '800 ms (Medium-Long)' },
            { value: 1200, label: '1200 ms (Extended)' },
          ]}
        />
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
      {/* Gaze Signal Loss Alerts */}
      <SectionLabel>Gaze Signal Loss Alerts</SectionLabel>
      <Row name="Loss Warning Sound" hint="Play warning chime when eye gaze is lost">
        <Toggle
          id="toggle-gaze-lost-sound"
          checked={settings.gazeLostSoundEnabled ?? true}
          onChange={e => updateSetting('gazeLostSoundEnabled', e.target.checked)}
        />
      </Row>
      <Row name="Loss Visual Indicator" hint="Show warning banner when eye gaze is lost">
        <Toggle
          id="toggle-gaze-lost-visual"
          checked={settings.gazeLostVisualEnabled ?? true}
          onChange={e => updateSetting('gazeLostVisualEnabled', e.target.checked)}
        />
      </Row>

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
              <GranularSlider
                id="slider-process-noise"
                className="sm-slider sm-slider--green"
                min={0.001}
                max={0.05}
                step={0.001}
                value={settings.processNoise ?? 0.012}
                onChange={val => updateSetting('processNoise', val)}
                presets={[
                  { value: 0.005, label: '0.005 (Smooth)' },
                  { value: 0.012, label: '0.012 (Standard)' },
                  { value: 0.025, label: '0.025 (Agile)' },
                  { value: 0.040, label: '0.040 (Very Agile)' },
                ]}
              />
            </Row>
            <Row name="Measurement Noise (R)" hint="Lower = trust raw sensor more">
              <GranularSlider
                id="slider-measurement-noise"
                className="sm-slider sm-slider--green"
                min={0.01}
                max={0.30}
                step={0.005}
                value={settings.measurementNoise ?? 0.07}
                onChange={val => updateSetting('measurementNoise', val)}
                presets={[
                  { value: 0.03, label: '0.03 (Raw)' },
                  { value: 0.07, label: '0.07 (Standard)' },
                  { value: 0.15, label: '0.15 (Heavy)' },
                  { value: 0.25, label: '0.25 (Very Heavy)' },
                ]}
              />
            </Row>
            <Row name="Saccade Threshold" hint="Jump distance [0–1] that resets filter">
              <GranularSlider
                id="slider-saccade"
                className="sm-slider sm-slider--green"
                min={0.03}
                max={0.35}
                step={0.01}
                value={settings.saccadeThreshold ?? 0.10}
                onChange={val => updateSetting('saccadeThreshold', val)}
                presets={[
                  { value: 0.05, label: '0.05 (Sensitive)' },
                  { value: 0.10, label: '0.10 (Standard)' },
                  { value: 0.20, label: '0.20 (Coarse)' },
                  { value: 0.30, label: '0.30 (Dull)' },
                ]}
              />
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

      {/* ── In-App Calibration Correction ─────────────────────────────── */}
      <SectionLabel>🎯 In-App Calibration Correction</SectionLabel>
      <Row name="Explicit Calibration" hint="Show 5-point calibration exercise at startup">
        <Toggle
          id="toggle-explicit-calibration"
          checked={settings.explicitCalibrationEnabled ?? true}
          onChange={e => updateSetting('explicitCalibrationEnabled', e.target.checked)}
        />
      </Row>
      <Row name="Implicit Calibration" hint="Silently improve accuracy from every dwell activation">
        <Toggle
          id="toggle-implicit-calibration"
          checked={settings.implicitCalibrationEnabled ?? true}
          onChange={e => updateSetting('implicitCalibrationEnabled', e.target.checked)}
        />
      </Row>
      <div className="sm-implicit-cal-info">
        <div className="sm-implicit-cal-info__header">
          <span className="sm-implicit-cal-info__icon">🧠</span>
          <span className="sm-implicit-cal-info__title">How implicit calibration works</span>
        </div>
        <p className="sm-implicit-cal-info__body">
          Every time you dwell on a cell, the app records where your eyes were <em>actually</em> looking
          versus where the cell was on screen. These error samples are accumulated per screen quadrant
          using an exponential moving average (α&nbsp;=&nbsp;0.15), so recent activations carry more weight.
          Once at least <strong>5 samples</strong> across <strong>2 or more quadrants</strong> have been
          collected, a global offset + scale correction is computed and silently applied to all future
          gaze frames — no interruption to your session.
        </p>
        <div className="sm-implicit-cal-info__pills">
          <span className="sm-implicit-cal-pill sm-implicit-cal-pill--green">✓ No interruption</span>
          <span className="sm-implicit-cal-pill sm-implicit-cal-pill--blue">✓ Gets better over time</span>
          <span className="sm-implicit-cal-pill sm-implicit-cal-pill--amber">⚠ Needs ≥5 dwell samples</span>
        </div>
      </div>

      {/* Calibration Visualization */}
      {(() => {
        const corr = settings.gazeCorrection
        const qualityPct = corr ? Math.round((corr.quality ?? 0) * 100) : 0
        const qualityLevel = !corr ? 'Not calibrated'
          : qualityPct > 70 ? 'Good'
          : qualityPct >= 40 ? 'Fair'
          : 'Poor'
        const sampleCount = corr?.sampleCount ?? 0
        const updatedAt = corr?.updatedAt ?? null
        const qualityColor = !corr ? 'rgba(255,255,255,0.35)'
          : qualityPct > 70 ? '#10B981'
          : qualityPct >= 40 ? '#F59E0B'
          : '#EF4444'
        // Per-quadrant activity heat (quadrantData is an array of {count, errorAvgX, errorAvgY})
        const qData = corr?.quadrantData ?? [null, null, null, null]
        const maxCount = Math.max(1, ...qData.map(q => q?.count ?? 0))
        // 5-point calibration reference positions [cx, cy] in SVG units 0-200 × 0-130
        const refPts = [[100,65],[30,20],[170,20],[30,110],[170,110]]
        // Quadrant centre markers (TL, TR, BL, BR) for quadrant heat
        const quadrantCentres = [[50,42],[150,42],[50,90],[150,90]]
        return (
          <>
            <div className="sm-cal-viz-wrap">
              <svg className="sm-cal-viz" viewBox="0 0 200 130" width="200" height="130">
                {/* Background */}
                <rect x="5" y="5" width="190" height="120" rx="8" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
                {/* Quadrant dividers */}
                <line x1="100" y1="5" x2="100" y2="125" stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="3,3" />
                <line x1="5" y1="65" x2="195" y2="65" stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="3,3" />
                {/* Quadrant activity heat */}
                {quadrantCentres.map(([qx, qy], qi) => {
                  const q = qData[qi]
                  const cnt = q?.count ?? 0
                  if (cnt === 0) return null
                  const intensity = Math.min(0.35, 0.08 + (cnt / maxCount) * 0.27)
                  return (
                    <rect
                      key={`qheat-${qi}`}
                      x={qi % 2 === 0 ? 6 : 101}
                      y={qi < 2 ? 6 : 66}
                      width={94} height={59}
                      rx={6}
                      fill={`rgba(16,185,129,${intensity.toFixed(3)})`}
                    />
                  )
                })}
                {/* Reference target dots (grey) */}
                {refPts.map(([cx,cy], i) => (
                  <circle key={`ref-${i}`} cx={cx} cy={cy} r={4} fill="rgba(180,180,200,0.30)" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
                ))}
                {/* Correction vectors — line from target to where gaze was landing, dot at gaze end */}
                {corr && refPts.map(([cx,cy], i) => {
                  const arrowX = cx + (corr.offsetX || 0) * 200 * 3
                  const arrowY = cy + (corr.offsetY || 0) * 130 * 3
                  const hasMeaningfulOffset = Math.abs(corr.offsetX || 0) > 0.001 || Math.abs(corr.offsetY || 0) > 0.001
                  if (!hasMeaningfulOffset) return null
                  return (
                    <g key={`err-${i}`}>
                      <line x1={cx} y1={cy} x2={arrowX} y2={arrowY} stroke="#ef4444" strokeWidth="1.5" opacity={0.75} />
                      <circle cx={arrowX} cy={arrowY} r={2.5} fill="#ef4444" opacity={0.9} />
                    </g>
                  )
                })}
                {/* Quality badge */}
                <rect x="5" y="5" width="190" height="120" rx="8" fill="none" stroke={qualityColor} strokeWidth="1.5" opacity={corr ? 0.5 : 0.15} />
              </svg>

              {/* Legend */}
              <div className="sm-cal-legend">
                <div className="sm-cal-legend__item">
                  <svg width="14" height="14" viewBox="0 0 14 14">
                    <circle cx="7" cy="7" r="5" fill="rgba(180,180,200,0.30)" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
                  </svg>
                  <span>Reference target</span>
                </div>
                <div className="sm-cal-legend__item">
                  <svg width="14" height="14" viewBox="0 0 14 14">
                    <line x1="2" y1="4" x2="12" y2="10" stroke="#ef4444" strokeWidth="1.5" />
                    <circle cx="12" cy="10" r="2.5" fill="#ef4444" />
                  </svg>
                  <span>Gaze offset (line&nbsp;= correction applied, dot&nbsp;= where eyes landed)</span>
                </div>
                <div className="sm-cal-legend__item">
                  <svg width="14" height="14" viewBox="0 0 14 14">
                    <rect x="1" y="1" width="12" height="12" rx="3" fill="rgba(16,185,129,0.28)" />
                  </svg>
                  <span>Quadrant activity (brighter&nbsp;= more dwell samples)</span>
                </div>
              </div>
            </div>

            {/* Quality Readout */}
            <div className="sm-cal-info">
              <span className="sm-cal-quality" style={{ color: qualityColor }}>
                Quality: {qualityLevel} ({qualityPct}%)
              </span>
              <span className="sm-cal-samples">
                {sampleCount} samples
              </span>
              {updatedAt && (
                <span className="sm-cal-updated">
                  Last updated: {new Date(updatedAt).toLocaleString()}
                </span>
              )}
            </div>
          </>
        )
      })()}

      {/* Action Buttons */}
      <div className="sm-cal-actions">
        <button
          className="sm-cal-btn sm-cal-btn--reset"
          disabled={!settings.gazeCorrection}
          onClick={async () => {
            await window.gazeAPI?.gazeCorrection?.reset()
            updateSetting('gazeCorrection', null)
          }}
        >
          🗑 Reset Correction
        </button>
      </div>
    </div>
  )
}

// ─── Panel 2: AAC Settings ───────────────────────────────────────────────────

function AACPanel({ settings, updateSetting, updateSettings }) {
  const [voices, setVoices] = useState([])
  const [voicesLoading, setVoicesLoading] = useState(false)

  // Load voices for the currently-selected engine (or SAPI if unset)
  const loadVoices = useCallback((engine) => {
    setVoicesLoading(true)
    if (window.gazeAPI?.tts?.listVoicesByEngine) {
      window.gazeAPI.tts.listVoicesByEngine(engine)
        .then(v => {
          setVoices(v.map(x => ({ name: x.name, lang: x.culture ?? x.language ?? '', engine: x.engine ?? engine })))
        })
        .catch(() => setVoices([]))
        .finally(() => setVoicesLoading(false))
    } else if (window.gazeAPI?.tts?.listVoices) {
      // Legacy path — SAPI only
      window.gazeAPI.tts.listVoices()
        .then(sapiVoices => {
          setVoices(sapiVoices.map(v => ({ name: v.name, lang: v.culture ?? '', engine: 'sapi' })))
        })
        .catch(() => setVoices([]))
        .finally(() => setVoicesLoading(false))
    } else {
      // Browser dev mode fallback
      const load = () => {
        setVoices(window.speechSynthesis?.getVoices() ?? [])
        setVoicesLoading(false)
      }
      load()
      window.speechSynthesis?.addEventListener('voiceschanged', load)
    }
  }, [])

  // Reload voices whenever the engine setting changes
  useEffect(() => {
    loadVoices(settings.ttsEngine ?? 'sapi')
  }, [settings.ttsEngine, loadVoices])

  return (
    <div className="sm-panel__sections">
      {/* Input Method */}
      <SectionLabel>Input Method</SectionLabel>
      <div className={`sm-input-method-hero${(settings.mouseHoverMode ?? false) ? ' sm-input-method-hero--active' : ''}`}>
        <div className="sm-input-method-hero__icon">{(settings.mouseHoverMode ?? false) ? '\u{1F5B1}' : '\u{1F441}'}</div>
        <div className="sm-input-method-hero__body">
          <span className="sm-input-method-hero__title">
            {(settings.mouseHoverMode ?? false) ? 'Mouse Hover Mode (Active)' : 'Eye Gaze Mode (Active)'}
          </span>
          <span className="sm-input-method-hero__desc">
            {(settings.mouseHoverMode ?? false)
              ? 'Mouse cursor position drives dwell activation — ideal for Mill Mouse or any head-tracking / switch-access tool that controls the mouse pointer.'
              : 'Eye-tracker stream drives dwell activation via the TelemetryRouter gaze pipeline.'}
          </span>
        </div>
      </div>
      <Row
        name="Mouse Hover Mode"
        hint="Enable when using Mill Mouse (or any head-tracking tool that emulates the mouse) instead of a direct eye-gaze tracker. Mouse cursor position will drive dwell activation."
      >
        <Toggle
          id="toggle-mouse-hover-mode"
          checked={settings.mouseHoverMode ?? false}
          onChange={e => updateSetting('mouseHoverMode', e.target.checked)}
        />
      </Row>
      {(settings.mouseHoverMode ?? false) && (
        <p className="sm-hint-text sm-hint-text--warn">
          Mouse Hover Mode is active. Eye-gaze stream is suppressed - mouse cursor position controls dwell. Disable this when returning to direct eye-gaze hardware.
        </p>
      )}

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
        <GranularSlider
          id="slider-opacity"
          min={30}
          max={100}
          step={5}
          value={Math.round((settings.gridOpacity ?? 1.0) * 100)}
          onChange={val => updateSetting('gridOpacity', val / 100)}
          unit="%"
          presets={[
            { value: 30, label: '30% (Low)' },
            { value: 50, label: '50% (Medium)' },
            { value: 80, label: '80% (High)' },
            { value: 100, label: '100% (Opaque)' },
          ]}
        />
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
      <Row name="Progress Indicator Opacity" hint="Transparency of the dwell ring or bar (0% = invisible, 100% = fully opaque)">
        <GranularSlider
          id="slider-dwell-opacity"
          className="sm-slider sm-slider--violet"
          min={5}
          max={100}
          step={5}
          value={Math.round((settings.dwellProgressOpacity ?? 1.0) * 100)}
          onChange={val => updateSetting('dwellProgressOpacity', val / 100)}
          unit="%"
          presets={[
            { value: 10, label: '10% (Subtle)' },
            { value: 30, label: '30% (Soft)' },
            { value: 60, label: '60% (Medium)' },
            { value: 100, label: '100% (Opaque)' },
          ]}
        />
      </Row>


      {/* Voice & Speech */}
      <SectionLabel>Voice &amp; Speech</SectionLabel>

      {/* TTS Engine selector */}
      <SectionLabel sub>Speech Engine</SectionLabel>
      <div className="sm-cards sm-cards--2" role="radiogroup" aria-label="TTS engine">
        {TTS_ENGINES.map(eng => {
          const active = (settings.ttsEngine ?? 'sapi') === eng.id
          return (
            <button
              key={eng.id}
              role="radio"
              aria-checked={active}
              className={`sm-card sm-card--teal ${active ? 'sm-card--active' : ''}`}
              onClick={() => {
                updateSetting('ttsEngine', eng.id)
                updateSetting('ttsVoice', '')  // reset voice when engine changes
              }}
            >
              <div className="sm-card__icon">{eng.icon}</div>
              <span className="sm-card__name">{eng.name}</span>
              <span className="sm-card__desc">{eng.desc}</span>
              <span className="sm-card__dot" aria-hidden="true" />
            </button>
          )
        })}
      </div>

      {/* WinRT info banner */}
      {(settings.ttsEngine ?? 'sapi') === 'winrt' && (
        <p className="sm-hint-text" style={{ marginTop: '-4px' }}>
          🌟 <strong>WinRT / Natural Voices</strong> — uses Windows.Media.SpeechSynthesis to access
          Neural (Azure Edge-Powered) and OneCore voices. Requires Windows 10 1703+ and voices installed
          via <em>Settings → Time &amp; Language → Speech → Manage voices</em>.
          <br />⚠ Rate and Pitch sliders are not supported by the WinRT engine (volume only).
        </p>
      )}

      {/* Voice Presets — only for SAPI */}
      {(settings.ttsEngine ?? 'sapi') === 'sapi' && (
        <>
          <SectionLabel sub>Voice Presets</SectionLabel>
          <div className="sm-cards sm-cards--4" role="radiogroup" aria-label="Voice preset">
            {VOICE_PRESETS.map(p => {
              const isActive =
                (settings.ttsRate   ?? 0)   === p.rate &&
                (settings.ttsPitch  ?? 0)   === p.pitch &&
                (settings.ttsVolume ?? 100) === p.volume
              return (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={isActive}
                  className={`sm-card sm-card--sm sm-card--teal ${isActive ? 'sm-card--active' : ''}`}
                  onClick={() => updateSettings({ ttsRate: p.rate, ttsPitch: p.pitch, ttsVolume: p.volume })}
                >
                  <div className="sm-card__icon">{p.icon}</div>
                  <span className="sm-card__name">{p.name}</span>
                  <span className="sm-card__desc">{p.desc}</span>
                  <span className="sm-card__dot" aria-hidden="true" />
                </button>
              )
            })}
          </div>
        </>
      )}

      {/* Voice selector */}
      <Row name="Voice" hint="Text-to-speech voice for word output">
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flex: 1 }}>
          <select
            id="select-tts-voice"
            className="sm-select"
            style={{ flex: 1 }}
            value={settings.ttsVoice ?? ''}
            onChange={e => updateSetting('ttsVoice', e.target.value)}
          >
            <option value="">System Default</option>
            {voicesLoading
              ? <option disabled>Loading voices…</option>
              : voices.map(v => (
                  <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
                ))
            }
          </select>
          <button
            className="sm-btn sm-btn--outline sm-btn--xs"
            onClick={() => loadVoices(settings.ttsEngine ?? 'sapi')}
            title="Refresh voice list"
          >
            ↺
          </button>
        </div>
      </Row>

      {/* Rate — SAPI only */}
      {(settings.ttsEngine ?? 'sapi') === 'sapi' && (
        <Row name="Speech Rate" hint="How fast the voice speaks. 0 = normal, negative = slower, positive = faster.">
          <GranularSlider
            id="slider-tts-rate"
            className="sm-slider sm-slider--teal"
            min={-10}
            max={10}
            step={1}
            value={settings.ttsRate ?? 0}
            onChange={val => updateSetting('ttsRate', val)}
            presets={[
              { value: -5, label: 'Slow (-5)' },
              { value: -2, label: 'Relaxed (-2)' },
              { value: 0, label: 'Normal (0)' },
              { value: 2, label: 'Brisk (2)' },
              { value: 5, label: 'Fast (5)' },
            ]}
          />
        </Row>
      )}

      {/* Pitch — SAPI only */}
      {(settings.ttsEngine ?? 'sapi') === 'sapi' && (
        <Row name="Pitch" hint="Raise pitch for a child-like voice, lower it for a deeper adult voice. Applied via SSML prosody.">
          <GranularSlider
            id="slider-tts-pitch"
            className="sm-slider sm-slider--teal"
            min={-10}
            max={10}
            step={1}
            value={settings.ttsPitch ?? 0}
            onChange={val => updateSetting('ttsPitch', val)}
            presets={[
              { value: -4, label: 'Deep (-4)' },
              { value: 0, label: 'Normal (0)' },
              { value: 4, label: 'High (4)' },
              { value: 8, label: 'Child (8)' },
            ]}
          />
        </Row>
      )}

      {/* Volume — always shown */}
      <Row name="Volume" hint="TTS output volume (0 = silent, 100 = full)">
        <GranularSlider
          id="slider-tts-volume"
          className="sm-slider sm-slider--teal"
          min={0}
          max={100}
          step={5}
          value={settings.ttsVolume ?? 100}
          onChange={val => updateSetting('ttsVolume', val)}
          unit="%"
          presets={[
            { value: 20, label: '20% (Quiet)' },
            { value: 50, label: '50% (Medium)' },
            { value: 80, label: '80% (Loud)' },
            { value: 100, label: '100% (Max)' },
          ]}
        />
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

      {/* Navigation Sound */}
      <SectionLabel>Navigation Click Sound</SectionLabel>
      <Row
        name="Enable Click Sound"
        hint="Play a discreet audio cue for Home, Back, Backspace, Clear and sub-page navigation buttons"
      >
        <Toggle id="toggle-nav-click-sound" checked={settings.navClickSound ?? false}
          onChange={e => updateSetting('navClickSound', e.target.checked)} />
      </Row>
      {(settings.navClickSound ?? false) && (
        <>
          <SectionLabel sub>Tone Style</SectionLabel>
          <div className="sm-cards sm-cards--3" role="radiogroup" aria-label="Navigation click tone">
            {NAV_CLICK_TONES.map(t => (
              <button key={t.id} role="radio" aria-checked={settings.navClickTone === t.id}
                className={`sm-card sm-card--sm sm-card--violet ${
                  (settings.navClickTone ?? 'soft') === t.id ? 'sm-card--active' : ''
                }`}
                onClick={() => updateSetting('navClickTone', t.id)}>
                <div className="sm-card__icon">{t.icon}</div>
                <span className="sm-card__name">{t.name}</span>
                <span className="sm-card__desc">{t.desc}</span>
                <span className="sm-card__dot" aria-hidden="true" />
              </button>
            ))}
          </div>
          <Row name="Click Volume" hint="How loud the navigation sound plays">
            <GranularSlider
              id="slider-nav-click-vol"
              className="sm-slider sm-slider--violet"
              min={5}
              max={100}
              step={5}
              value={Math.round((settings.navClickVolume ?? 0.35) * 100)}
              onChange={val => updateSetting('navClickVolume', val / 100)}
              unit="%"
              presets={[
                { value: 10, label: '10% (Soft)' },
                { value: 30, label: '30% (Low)' },
                { value: 60, label: '60% (Medium)' },
                { value: 100, label: '100% (Loud)' },
              ]}
            />
          </Row>
        </>
      )}
    </div>
  )
}


// ─── Panel 4: Contextual Response ─────────────────────────────────────────────

function ContextualResponsePanel({ settings, updateSetting }) {
  const { currentUser } = useGazeSettings()
  const [ollamaStatus, setOllamaStatus] = useState(null) // null | { available, models }
  const [checking, setChecking]         = useState(false)
  const [micDevices, setMicDevices]     = useState([])   // available audio input devices

  // Enumerate audio input devices so the user can pick their mic
  const refreshMicDevices = useCallback(async () => {
    try {
      // Request mic permission first (needed to get device labels on Windows)
      await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()))
      const all = await navigator.mediaDevices.enumerateDevices()
      const inputs = all.filter(d => d.kind === 'audioinput')
      setMicDevices(inputs)
    } catch (err) {
      console.warn('[SettingsModal] Could not enumerate mic devices:', err.message)
      setMicDevices([])
    }
  }, [])

  useEffect(() => { refreshMicDevices() }, [refreshMicDevices])

  // ── User Profile state ────────────────────────────────────────────────────
  const DEFAULT_PROFILE = {
    name:     'Johnny',
    age:      10,
    location: 'Singapore',
    family:   { father: 'Bob', mother: 'Mary' },
  }
  const [profile, setProfile]       = useState(DEFAULT_PROFILE)
  const [profileSaved, setProfileSaved] = useState(false)
  const [profileLoading, setProfileLoading] = useState(true)

  useEffect(() => {
    async function _load() {
      try {
        const p = await window.gazeAPI?.userProfile?.get?.()
        if (p) setProfile({
          name:     p.name     ?? '',
          age:      p.age      ?? '',
          location: p.location ?? '',
          family: {
            father: p.family?.father ?? '',
            mother: p.family?.mother ?? '',
          },
        })
      } catch (e) {
        console.warn('[SettingsModal] Could not load user profile:', e)
      } finally {
        setProfileLoading(false)
      }
    }
    _load()
  }, [])

  const updateProfile = (field, value) => {
    setProfile(prev => ({ ...prev, [field]: value }))
    setProfileSaved(false)
  }
  const updateFamily = (field, value) => {
    setProfile(prev => ({ ...prev, family: { ...prev.family, [field]: value } }))
    setProfileSaved(false)
  }
  const saveProfile = async () => {
    try {
      const payload = {
        name:     profile.name.trim()     || 'User',
        age:      Number(profile.age)     || 0,
        location: profile.location.trim() || 'Unknown',
        family: {
          father: profile.family.father.trim() || '',
          mother: profile.family.mother.trim() || '',
        },
      }
      await window.gazeAPI?.userProfile?.set?.(payload)
      setProfileSaved(true)

      // Immediately push to cloud if logged in
      if (currentUser) {
        const adapter = SyncAdapter.getInstance()
        if (adapter.pushUserProfile) {
          await adapter.pushUserProfile(payload)
          console.log('[SettingsModal] User profile pushed to cloud successfully')
        }
      }

      setTimeout(() => setProfileSaved(false), 2500)
    } catch (e) {
      console.warn('[SettingsModal] Could not save user profile:', e)
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const checkOllama = useCallback(async () => {
    setChecking(true)
    const result = await checkOllamaAvailable()
    setOllamaStatus(result)
    setChecking(false)
  }, [])

  useEffect(() => { checkOllama() }, [checkOllama])

  // ── AI History ────────────────────────────────────────────────────────────
  const [historyEntries, setHistoryEntries] = useState(null) // null = loading
  const [historyClearing, setHistoryClearing] = useState(false)
  const [historyClearedMsg, setHistoryClearedMsg] = useState(false)

  const _loadHistory = useCallback(async () => {
    try {
      const h = await window.gazeAPI?.aiHistory?.getAll?.()
      setHistoryEntries(Array.isArray(h) ? [...h].reverse() : []) // newest first
    } catch {
      setHistoryEntries([])
    }
  }, [])

  useEffect(() => { _loadHistory() }, [_loadHistory])

  const deleteEntry = useCallback(async (savedAt) => {
    try {
      await window.gazeAPI?.aiHistory?.delete?.(savedAt)
      setHistoryEntries(prev => (prev ?? []).filter(e => e.savedAt !== savedAt))
    } catch (e) {
      console.warn('[SettingsModal] Could not delete AI history entry:', e)
    }
  }, [])

  const clearHistory = useCallback(async () => {
    const count = (historyEntries ?? []).length
    if (!window.confirm(`Clear all ${count} AI history entries? This cannot be undone.`)) return
    setHistoryClearing(true)
    try {
      await window.gazeAPI?.aiHistory?.clear?.()
      setHistoryEntries([])
      setHistoryClearedMsg(true)
      setTimeout(() => setHistoryClearedMsg(false), 3000)
    } catch (e) {
      console.warn('[SettingsModal] Could not clear AI history:', e)
    } finally {
      setHistoryClearing(false)
    }
  }, [historyEntries])
  // ─────────────────────────────────────────────────────────────────────────

  const [activeSubTab, setActiveSubTab] = useState('general') // 'general' | 'prompts' | 'model'
  const backend = settings.contextualResponseModel ?? 'ollama'

  return (
    <div className="sm-panel__sections">

      {/* ── Sub-tab switcher ── */}
      <div className="sm-ctx-tabs">
        <button
          type="button"
          className={`sm-ctx-tab ${activeSubTab === 'general' ? 'sm-ctx-tab--active' : ''}`}
          onClick={() => setActiveSubTab('general')}
        >
          📝 General
        </button>
        <button
          type="button"
          className={`sm-ctx-tab ${activeSubTab === 'prompts' ? 'sm-ctx-tab--active' : ''}`}
          onClick={() => setActiveSubTab('prompts')}
        >
          ✍ Prompts
        </button>
        <button
          type="button"
          className={`sm-ctx-tab ${activeSubTab === 'model' ? 'sm-ctx-tab--active' : ''}`}
          onClick={() => setActiveSubTab('model')}
        >
          🤖 AI Model Config
        </button>
      </div>

      {activeSubTab === 'general' && (
        <>
          {/* ── Hero / enable ── */}
          <SectionLabel>Contextual Response Board</SectionLabel>
          <div className="sm-ctx-hero">
            <div className="sm-ctx-hero__icon">🧠</div>
            <div className="sm-ctx-hero__body">
              <span className="sm-ctx-hero__title">AI-Powered Response Suggestions</span>
              <span className="sm-ctx-hero__desc">
                A context window appears above the home bar. Type, speak, or capture an image —
                the AI generates 2–9 gaze-selectable response tiles, choosing the ideal count for the context.
              </span>
            </div>
          </div>
          <Row name="Enable Contextual Response Board" hint="Show context window + AI suggestion tiles above the vocabulary grid">
            <Toggle
              id="toggle-contextual-enabled"
              checked={settings.contextualResponseEnabled ?? false}
              onChange={e => updateSetting('contextualResponseEnabled', e.target.checked)}
            />
          </Row>

          <Row name="Microphone Mode" hint="Walkie-Talkie (Toggle to listen once) vs Continuous (Always listening)">
            <select
              id="select-mic-mode"
              className="sm-select"
              value={settings.contextualMicMode ?? 'toggle'}
              onChange={e => updateSetting('contextualMicMode', e.target.value)}
            >
              <option value="toggle">Toggle (Walkie-Talkie)</option>
              <option value="continuous">Continuous Listening</option>
            </select>
          </Row>

          <Row
            name="Microphone Source"
            hint="Select which audio input device to use for speech capture. Click Refresh to detect newly connected devices."
          >
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flex: 1 }}>
              <select
                id="select-mic-device"
                className="sm-select"
                style={{ flex: 1 }}
                value={settings.contextualMicDeviceId ?? ''}
                onChange={e => updateSetting('contextualMicDeviceId', e.target.value)}
              >
                <option value="">🎤 System Default</option>
                {micDevices.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Microphone ${d.deviceId.slice(0, 8)}…`}
                  </option>
                ))}
              </select>
              <button
                className="sm-btn sm-btn--outline sm-btn--xs"
                onClick={refreshMicDevices}
                title="Re-scan audio devices"
              >
                ↺ Refresh
              </button>
            </div>
          </Row>
          {micDevices.length === 0 && (
            <p className="sm-hint-text" style={{ marginTop: -6 }}>
              No devices listed — click Refresh, or check browser mic permission.
            </p>
          )}

          <Row
            name="Speech Input Method"
            hint="Windows Voice Typing will use Windows dictation tool (Win+H) with fallback to SAPI. SAPI (legacy) directly triggers the local SAPI engine."
          >
            <select
              id="select-speak-mode"
              className="sm-select"
              value={settings.contextualSpeakMode ?? 'voice-typing'}
              onChange={e => updateSetting('contextualSpeakMode', e.target.value)}
            >
              <option value="voice-typing">Speak with Windows Voice Typing</option>
              <option value="sapi">Speak with SAPI (legacy)</option>
            </select>
          </Row>

          {settings.contextualSpeakMode === 'voice-typing' && (
            <Row
              name="Voice Typing Auto-Off Delay"
              hint="Sets the number of seconds before Windows Voice Typing automatically turns off after being triggered by pressing Speak."
            >
              <select
                id="select-wvt-timeout"
                className="sm-select"
                value={settings.contextualWvtTimeout ?? 0}
                onChange={e => updateSetting('contextualWvtTimeout', Number(e.target.value))}
              >
                <option value={0}>Do not turn off automatically</option>
                {Array.from({ length: 60 }, (_, i) => i + 1).map(sec => (
                  <option key={sec} value={sec}>
                    {sec} {sec === 1 ? 'second' : 'seconds'}
                  </option>
                ))}
              </select>
            </Row>
          )}

          <Row
            name="Speech Hotkey"
            hint="Press this keyboard shortcut inside the app to toggle the microphone"
          >
            <div className="sm-shortcut-container">
              <button
                type="button"
                className={`sm-shortcut-btn ${(settings.speakShortcutCtrl ?? false) ? 'sm-shortcut-btn--active' : ''}`}
                onClick={() => updateSetting('speakShortcutCtrl', !(settings.speakShortcutCtrl ?? false))}
              >
                Ctrl
              </button>
              <button
                type="button"
                className={`sm-shortcut-btn ${(settings.speakShortcutShift ?? false) ? 'sm-shortcut-btn--active' : ''}`}
                onClick={() => updateSetting('speakShortcutShift', !(settings.speakShortcutShift ?? false))}
              >
                Shift
              </button>
              <button
                type="button"
                className={`sm-shortcut-btn ${(settings.speakShortcutAlt ?? false) ? 'sm-shortcut-btn--active' : ''}`}
                onClick={() => updateSetting('speakShortcutAlt', !(settings.speakShortcutAlt ?? false))}
              >
                Alt
              </button>
              <select
                className="sm-select sm-shortcut-select"
                value={(/^F[1-5]$/.test(settings.speakShortcutChar ?? '')) ? settings.speakShortcutChar : 'custom'}
                onChange={e => {
                  const val = e.target.value;
                  if (val === 'custom') {
                    updateSetting('speakShortcutChar', '');
                  } else {
                    updateSetting('speakShortcutChar', val);
                  }
                }}
              >
                <option value="custom">Custom Key</option>
                <option value="F1">F1</option>
                <option value="F2">F2</option>
                <option value="F3">F3</option>
                <option value="F4">F4</option>
                <option value="F5">F5</option>
              </select>
              {(!/^F[1-5]$/.test(settings.speakShortcutChar ?? '')) && (
                <input
                  type="text"
                  className="sm-shortcut-char-input"
                  maxLength={1}
                  value={settings.speakShortcutChar ?? ''}
                  onChange={e => {
                    const val = e.target.value.slice(-1);
                    updateSetting('speakShortcutChar', val);
                  }}
                  placeholder="Key"
                />
              )}
            </div>
          </Row>

          {/* ── Response count ── */}
          <SectionLabel>Suggestion Tiles</SectionLabel>
          <Row name="Min Number of Responses" hint="Fewest tiles the AI must always produce (2–9)">
            <GranularSlider
              id="slider-ctx-min-count"
              min={2}
              max={9}
              step={1}
              value={settings.contextualResponseMinCount ?? 2}
              onChange={val => {
                updateSetting('contextualResponseMinCount', val)
                if ((settings.contextualResponseCount ?? 9) < val) {
                  updateSetting('contextualResponseCount', val)
                }
              }}
              presets={[
                { value: 2, label: '2' },
                { value: 4, label: '4' },
                { value: 6, label: '6' },
                { value: 8, label: '8' },
                { value: 9, label: '9' },
              ]}
            />
          </Row>
          <Row name="Max Number of Responses" hint="Upper limit — AI picks the ideal count between min and this number (2–9)">
            <GranularSlider
              id="slider-ctx-count"
              min={2}
              max={9}
              step={1}
              value={settings.contextualResponseCount ?? 9}
              onChange={val => {
                updateSetting('contextualResponseCount', val)
                if ((settings.contextualResponseMinCount ?? 2) > val) {
                  updateSetting('contextualResponseMinCount', val)
                }
              }}
              presets={[
                { value: 2, label: '2' },
                { value: 4, label: '4' },
                { value: 6, label: '6' },
                { value: 8, label: '8' },
                { value: 9, label: '9' },
              ]}
            />
          </Row>

          {/* ── Answer Gate ── */}
          <SectionLabel>Answer Gate — Reading Delay</SectionLabel>
          <AnswerGateSlider
            value={settings.answerGateMs ?? 0}
            onChange={ms => updateSetting('answerGateMs', ms)}
          />

          {/* ── Response action ── */}
          <SectionLabel>When a Response is Selected</SectionLabel>
          <div className="sm-cards sm-cards--3" role="radiogroup" aria-label="Response action on selection">
            {[
              { id: 'speak',     name: 'Speak Only',  icon: '🔊', desc: 'Immediately speak the response via TTS' },
              { id: 'push',      name: 'Add to Bar',  icon: '📝', desc: 'Append to the phrase bar (no auto-speak)' },
              { id: 'both',      name: 'Both',        icon: '✨', desc: 'Speak immediately AND add to phrase bar' },
            ].map(a => (
              <button key={a.id} role="radio" aria-checked={(settings.contextualResponseAction ?? 'both') === a.id}
                className={`sm-card sm-card--sm sm-card--violet ${(settings.contextualResponseAction ?? 'both') === a.id ? 'sm-card--active' : ''}`}
                onClick={() => updateSetting('contextualResponseAction', a.id)}>
                <div className="sm-card__icon">{a.icon}</div>
                <span className="sm-card__name">{a.name}</span>
                <span className="sm-card__desc">{a.desc}</span>
                <span className="sm-card__dot" aria-hidden="true" />
              </button>
            ))}
          </div>
        </>
      )}

      {activeSubTab === 'prompts' && (
        <>
          {/* ── User Profile ── */}
          <SectionLabel>User Profile</SectionLabel>
          <div className="sm-ctx-profile-card">
            <div className="sm-ctx-profile-card__header">
              <span className="sm-ctx-profile-card__icon">👤</span>
              <div className="sm-ctx-profile-card__meta">
                <span className="sm-ctx-profile-card__title">Who is the AAC user?</span>
                <span className="sm-ctx-profile-card__subtitle">
                  This profile is embedded into every AI system prompt so responses
                  are age-appropriate and personally relevant.
                </span>
              </div>
            </div>
            {profileLoading ? (
              <div style={{ padding: '10px 0', opacity: 0.5 }}>Loading profile…</div>
            ) : (
              <div className="sm-ctx-profile-fields">
                <div className="sm-ctx-profile-row">
                  <label className="sm-ctx-profile-label" htmlFor="profile-name">Name</label>
                  <input
                    id="profile-name"
                    type="text"
                    className="sm-text-input sm-ctx-profile-input"
                    value={profile.name}
                    onChange={e => updateProfile('name', e.target.value)}
                    placeholder=""
                    spellCheck={false}
                  />
                </div>
                <div className="sm-ctx-profile-row">
                  <label className="sm-ctx-profile-label" htmlFor="profile-age">Age</label>
                  <input
                    id="profile-age"
                    type="number"
                    className="sm-text-input sm-ctx-profile-input sm-ctx-profile-input--short"
                    value={profile.age}
                    onChange={e => updateProfile('age', e.target.value)}
                    placeholder=""
                    min={1} max={99}
                  />
                </div>
                <div className="sm-ctx-profile-row">
                  <label className="sm-ctx-profile-label" htmlFor="profile-location">Location</label>
                  <input
                    id="profile-location"
                    type="text"
                    className="sm-text-input sm-ctx-profile-input"
                    value={profile.location}
                    onChange={e => updateProfile('location', e.target.value)}
                    placeholder=""
                    spellCheck={false}
                  />
                </div>
                <div className="sm-ctx-profile-row">
                  <label className="sm-ctx-profile-label" htmlFor="profile-father">Father&apos;s Name</label>
                  <input
                    id="profile-father"
                    type="text"
                    className="sm-text-input sm-ctx-profile-input"
                    value={profile.family.father}
                    onChange={e => updateFamily('father', e.target.value)}
                    placeholder=""
                    spellCheck={false}
                  />
                </div>
                <div className="sm-ctx-profile-row">
                  <label className="sm-ctx-profile-label" htmlFor="profile-mother">Mother&apos;s Name</label>
                  <input
                    id="profile-mother"
                    type="text"
                    className="sm-text-input sm-ctx-profile-input"
                    value={profile.family.mother}
                    onChange={e => updateFamily('mother', e.target.value)}
                    placeholder=""
                    spellCheck={false}
                  />
                </div>
                <div className="sm-ctx-profile-footer">
                  <span className="sm-ctx-profile-hint">
                    Changes take effect on the next AI generation
                  </span>
                  <button
                    id="btn-save-profile"
                    className={`sm-btn ${profileSaved ? 'sm-btn--success' : 'sm-btn--accent'}`}
                    onClick={saveProfile}
                  >
                    {profileSaved ? '✓ Saved!' : '💾 Save Profile'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ── Life Lore ── */}
          <SectionLabel>Life Lore — Background Data</SectionLabel>
          <div className="sm-ctx-lore-card">
            <div className="sm-ctx-lore-card__header">
              <span className="sm-ctx-lore-card__icon">📖</span>
              <div className="sm-ctx-lore-card__meta">
                <span className="sm-ctx-lore-card__title">Life Lore</span>
                <span className="sm-ctx-lore-card__subtitle">
                  Persistent background facts about the user — favorites, routines, family, dislikes.
                  The AI reads this as context data; it has no instructions for the AI on its own.
                </span>
              </div>
            </div>
            <textarea
              id="textarea-life-lore"
              className="sm-ctx-textarea sm-ctx-textarea--lore"
              value={settings.contextualLifeLore ?? ''}
              onChange={e => updateSetting('contextualLifeLore', e.target.value)}
              placeholder={`Example:\nFavorites: Minecraft, Lego, spicy noodles, blue\nDislikes: loud noises, puzzles, broccoli\nFamily: Dad James, Mom Venus, baby sister Mia\nSchool: Rosyth School, P4, loves recess & PE\nRoutines: homework at 4 pm, Minecraft after dinner`}
              rows={6}
              spellCheck={false}
            />
            <div className="sm-ctx-textarea-footer">
              <span className="sm-ctx-char-count">{(settings.contextualLifeLore ?? '').length} chars</span>
              <span className="sm-ctx-textarea-hint">Saved automatically · used as data payload in every AI request</span>
            </div>
          </div>

          {/* ── Prompt Prefix ── */}
          <SectionLabel>Prompt Prefix — Request Instructions</SectionLabel>
          <div className="sm-ctx-prefix-card">
            <div className="sm-ctx-prefix-card__header">
              <span className="sm-ctx-prefix-card__icon">⚡</span>
              <div className="sm-ctx-prefix-card__meta">
                <span className="sm-ctx-prefix-card__title">Prompt Prefix</span>
                <span className="sm-ctx-prefix-card__subtitle">
                  Text prepended to every AI request. Use this to define rules, tone, and constraints
                  for the AI. This is the instruction wrapper that controls how the AI behaves.
                </span>
              </div>
            </div>
            <textarea
              id="textarea-prompt-prefix"
              className="sm-ctx-textarea sm-ctx-textarea--prefix"
              value={settings.contextualPromptPrefix ?? ''}
              onChange={e => updateSetting('contextualPromptPrefix', e.target.value)}
              placeholder={`Example:\nAct like a 9-year-old boy. Keep each response to one short sentence.\nOutput only plain text — no emojis, no bullet points.\nUse simple Singapore English. Never say anything scary or adult.`}
              rows={5}
              spellCheck={false}
            />
            <div className="sm-ctx-textarea-footer">
              <span className="sm-ctx-char-count">{(settings.contextualPromptPrefix ?? '').length} chars</span>
              <span className="sm-ctx-textarea-hint">Prepended to every API request · defines AI logic &amp; boundaries</span>
            </div>
          </div>

          {/* ── System Prompt ── */}
          <SectionLabel>System Prompt — AI Core Behaviour</SectionLabel>
          <div className="sm-ctx-sysprompt-card">
            <div className="sm-ctx-sysprompt-card__header">
              <span className="sm-ctx-sysprompt-card__icon">🤖</span>
              <div className="sm-ctx-sysprompt-card__meta">
                <span className="sm-ctx-sysprompt-card__title">Custom System Prompt</span>
                <span className="sm-ctx-sysprompt-card__subtitle">
                  Replaces the built-in AAC assistant instructions entirely. Leave blank to use the
                  default (recommended). The <em>Prompt Prefix</em> above is always prepended, and
                  <em> Life Lore</em> is always appended — regardless of what you put here.
                </span>
              </div>
            </div>
            {!(settings.contextualSystemPrompt ?? '').trim() && (
              <div className="sm-ctx-sysprompt-default">
                <span className="sm-ctx-sysprompt-default__label">Built-in default (currently active):</span>
                <pre className="sm-ctx-sysprompt-default__body">{
`You are an AAC assistant generating responses on behalf of [User Name], a [Age]-year-old child who lives in [Location]. Father is [Father] and Mother is [Mother]. You will speak as the voice of [User Name]. (User Name, Age, Location, and parents are filled from the User Profile above)
Your job is to suggest between [Min] and [Max] short, natural, age-appropriate communication phrases that [User Name] might actually say. This means that you are effectively a Multiple-Choice Question Reformatter. Whenever the user asks you a question, your task is NOT to answer it directly, but to rephrase the response into a list of plausible options that the user can choose from to answer their own question. 
Return ONLY a valid JSON array of strings — no explanation, no markdown, no extra text.
For every question, you must provide a comprehensive set of choices that covers all bases. Follow these strict formatting rules:

1. **Direct Answers:** Include the most direct answers (e.g., "Yes" and "No" for binary questions, the listed choices for choice questions, or specific categories for open questions).
2. **The Uncertainty Buffer:** Always include options for when the responder doesn't know, is unsure, or needs more context (e.g., "Maybe", "I don't know", "It depends").
3. **The 'None of the Above' Buffer:** Always include an option for when the predefined choices don't fit (e.g., "Neither", "Other / Not applicable").
4. **Preference Diversity:** When generating options for open-ended questions about preferences, likes, dislikes, or opinions, do not limit all response options to the single preference stated in the Life Lore. Generate a diverse set of plausible alternatives (e.g., other common dislikes or likes) as distinct choices, while ensuring the preference from the Life Lore is included as one of the responses.
5. **Time-Sensitive Questions (Correct vs Plausible Times):** The current local time is [Current Day], [Current Date], [Current Time]. If the user is asked about the time or if the context asks 'what time is it?' (or similar time-sensitive/quiz questions), you MUST generate a realistic set of choices where:
   - One suggestion is the exact correct current time (e.g., "It is [Current Time]" or "[Current Time]").
   - At least two other suggestions are plausible but incorrect times (e.g., 15-30 minutes earlier or later, or rounded to the next hour/half-hour, such as "12:30" or "11:45" if the correct time is 12:17 AM) to serve as decoy/plausible options for a quiz or choice question.
   - Include options for uncertainty or context (e.g., "I don't know the time", "Is it time to play?").

Example Input: "Are you sick?"
Example Output: 
* Yes
* No
* Maybe / Not sure
* Neither 

If the question presents choices, ensure the responses contain the choices to allow the user to select them. For example, if the question is for CHOICE A, B or C, the response should at least include 1) CHOICE A, 2) CHOICE B, 3) CHOICE C, 4) BOTH, 5) NONE.

When the question is not a strict yes/no or choice question, vary the responses: mix single words, short phrases, full sentences, questions, and expressions.

--- Current Environment Context ---
Current Local Time: [Current Day], [Current Date], [Current Time]
--- End of Environment Context ---`
                }</pre>
                <span className="sm-ctx-sysprompt-default__hint">
                  (User Name, Age, Location, and parents are filled from the User Profile above)
                </span>
              </div>
            )}
            <textarea
              id="textarea-system-prompt"
              className="sm-ctx-textarea sm-ctx-textarea--sysprompt"
              value={settings.contextualSystemPrompt ?? ''}
              onChange={e => updateSetting('contextualSystemPrompt', e.target.value)}
              placeholder={`Leave blank to use the built-in default.\n\nTo customise, paste your own instructions here, e.g.:\nYou are the voice of [Name]. Respond only in Mandarin Chinese. Keep every response under 5 words. Return a JSON array of strings.`}
              rows={8}
              spellCheck={false}
            />
            <div className="sm-ctx-textarea-footer">
              <span className="sm-ctx-char-count">{(settings.contextualSystemPrompt ?? '').length} chars</span>
              {(settings.contextualSystemPrompt ?? '').trim() ? (
                <>
                  <span className="sm-ctx-sysprompt-active-badge">⚡ Custom prompt active</span>
                  <button
                    className="sm-btn sm-btn--outline sm-btn--xs"
                    onClick={() => updateSetting('contextualSystemPrompt', '')}
                  >↺ Restore Default</button>
                </>
              ) : (
                <span className="sm-ctx-textarea-hint">Blank = built-in default · changes take effect on next generation</span>
              )}
            </div>
          </div>

          {/* ── AI Interaction History ── */}
          <SectionLabel>AI Interaction History</SectionLabel>
          <div className="sm-ctx-history-card">
            <div className="sm-ctx-history-card__header">
              <span className="sm-ctx-history-card__icon">🗂</span>
              <div className="sm-ctx-history-card__meta">
                <span className="sm-ctx-history-card__title">Past Interaction Log</span>
                <span className="sm-ctx-history-card__subtitle">
                  The AI uses recent context→response pairs to prime its next generation.
                  Green chips = responses the user selected. Delete individual entries or clear all.
                </span>
              </div>
            </div>

            {/* ── Toolbar ── */}
            <div className="sm-ctx-history-card__body">
              <div className="sm-ctx-history-count">
                {historyEntries === null
                  ? <span style={{ opacity: 0.4 }}>Loading…</span>
                  : historyEntries.length === 0
                    ? <span className="sm-ctx-history-count--empty">✓ History is empty</span>
                    : <span className="sm-ctx-history-count--has">{historyEntries.length} interaction{historyEntries.length !== 1 ? 's' : ''}</span>
                }
                {historyClearedMsg && <span className="sm-ctx-history-count--cleared"> ✓ Cleared!</span>}
              </div>
              <button
                id="btn-clear-ai-history"
                className="sm-btn sm-btn--danger sm-btn--xs"
                onClick={clearHistory}
                disabled={historyClearing || (historyEntries ?? []).length === 0}
              >
                {historyClearing ? '⏳ Clearing…' : '🗑 Clear All'}
              </button>
            </div>

            {/* ── Entry list ── */}
            {historyEntries && historyEntries.length > 0 && (
              <div className="sm-ctx-history-list">
                {historyEntries.map((entry) => {
                  const chosen = Array.isArray(entry.chosen)
                    ? entry.chosen
                    : entry.chosen ? [entry.chosen] : []
                  const ago = _relTime(entry.savedAt)
                  return (
                    <div key={entry.savedAt} className="sm-ctx-history-entry">
                      <div className="sm-ctx-history-entry__top">
                        <span className="sm-ctx-history-entry__context" title={entry.context}>
                          {entry.context.length > 80
                            ? entry.context.slice(0, 80) + '…'
                            : entry.context}
                        </span>
                        <span className="sm-ctx-history-entry__time">{ago}</span>
                        <button
                          className="sm-ctx-history-entry__delete"
                          onClick={() => deleteEntry(entry.savedAt)}
                          title="Delete this entry"
                          aria-label="Delete history entry"
                        >✕</button>
                      </div>
                      <div className="sm-ctx-history-entry__chips">
                        {(entry.responses ?? []).map((r, i) => {
                          const wasChosen = chosen.includes(r)
                          return (
                            <span
                              key={i}
                              className={`sm-ctx-chip ${wasChosen ? 'sm-ctx-chip--chosen' : ''}`}
                              title={wasChosen ? 'User selected this response' : ''}
                            >
                              {wasChosen && <span className="sm-ctx-chip__check">✓</span>}
                              {r}
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <p className="sm-hint-text" style={{ padding: '0 14px 12px', margin: 0 }}>
              ⚠ After changing your Prompt Prefix, clear the history — old responses
              bias the model toward the old (wrong) behaviour.
            </p>
          </div>
        </>
      )}

      {activeSubTab === 'model' && (
        <>
          {/* ── AI Model Routing ── */}
          <SectionLabel>AI Model Routing</SectionLabel>
          <div className="sm-cards sm-cards--2" role="radiogroup" aria-label="AI Routing Strategy">
            {[
              { id: 'internet-first', name: 'Internet model first', icon: '🌐', desc: 'Try Cloud AI first (Gemini or ChatGPT) · auto-falls back to local models if key fails or offline' },
              { id: 'local-only',     name: 'Local model only',     icon: '🦙', desc: '100% Offline/local · Ollama primary with local Gemini Nano fallback' },
            ].map(r => (
              <button key={r.id} role="radio" aria-checked={(settings.contextualRouting ?? 'internet-first') === r.id}
                className={`sm-card sm-card--violet ${((settings.contextualRouting ?? 'internet-first') === r.id) ? 'sm-card--active' : ''}`}
                onClick={() => updateSetting('contextualRouting', r.id)}>
                <div className="sm-card__icon">{r.icon}</div>
                <span className="sm-card__name">{r.name}</span>
                <span className="sm-card__desc">{r.desc}</span>
                <span className="sm-card__dot" aria-hidden="true" />
              </button>
            ))}
          </div>

          {/* ── Cloud AI Priority Order ── */}
          <SectionLabel sub>Cloud AI Priority Order</SectionLabel>
          <p className="sm-hint-text" style={{ marginBottom: 10, paddingLeft: 4 }}>
            The app tries each cloud AI service in order, automatically falling back to the next if one fails or has no key set.
          </p>
          <div className="sm-ai-priority-list">
            {(settings.cloudAiProviderOrder ?? ['gemini', 'openai']).map((provider, idx, arr) => {
              const info = {
                gemini: { name: 'Gemini (Google)', icon: '✨', color: 'hsl(195,80%,55%)' },
                openai: { name: 'ChatGPT (OpenAI)', icon: '🤖', color: 'hsl(265,70%,65%)' },
              }[provider] ?? { name: provider, icon: '🔌', color: 'hsl(225,30%,60%)' }
              const hasKey = provider === 'openai'
                ? !!(settings.openAiApiKey ?? '').trim()
                : !!(settings.geminiApiKey ?? '').trim()
              const ordinals = ['1st', '2nd', '3rd']
              const moveProvider = (dir) => {
                const order = [...(settings.cloudAiProviderOrder ?? ['gemini', 'openai'])]
                const newIdx = idx + dir
                if (newIdx < 0 || newIdx >= order.length) return
                ;[order[idx], order[newIdx]] = [order[newIdx], order[idx]]
                updateSetting('cloudAiProviderOrder', order)
              }
              return (
                <div key={provider} className={`sm-ai-priority-item ${idx === 0 ? 'sm-ai-priority-item--primary' : ''}`}>
                  <span className="sm-ai-priority-item__rank">{ordinals[idx] ?? `${idx + 1}th`}</span>
                  <span className="sm-ai-priority-item__icon">{info.icon}</span>
                  <div className="sm-ai-priority-item__info">
                    <span className="sm-ai-priority-item__name">{info.name}</span>
                    <span className={`sm-ai-priority-item__key-status ${hasKey ? 'sm-ai-priority-item__key-status--ok' : 'sm-ai-priority-item__key-status--missing'}`}>
                      {hasKey ? '✓ Key configured' : '⚠ No API key'}
                    </span>
                  </div>
                  <div className="sm-ai-priority-item__arrows">
                    <button
                      className="sm-ai-priority-arrow"
                      onClick={() => moveProvider(-1)}
                      disabled={idx === 0}
                      aria-label={`Move ${info.name} up in priority`}
                      title="Move up (higher priority)"
                    >↑</button>
                    <button
                      className="sm-ai-priority-arrow"
                      onClick={() => moveProvider(1)}
                      disabled={idx === arr.length - 1}
                      aria-label={`Move ${info.name} down in priority`}
                      title="Move down (lower priority)"
                    >↓</button>
                  </div>
                </div>
              )
            })}
          </div>

          {/* ── Gemini Cloud Settings (always shown) ── */}
          <SectionLabel sub>Gemini (Google) Settings</SectionLabel>
          <Row name="Gemini API Key" hint="Get a free key from Google AI Studio — paste it here. Authenticated users have this key synced to the cloud.">
            <GeminiKeyInput
              value={settings.geminiApiKey ?? ''}
              onChange={v => updateSetting('geminiApiKey', v)}
            />
          </Row>
          <Row name="Gemini Model" hint="Default is gemini-2.5-flash (recommended)">
            <input
              id="input-gemini-model"
              type="text"
              className="sm-text-input"
              value={settings.geminiModel ?? 'gemini-2.5-flash'}
              onChange={e => updateSetting('geminiModel', e.target.value.trim())}
              placeholder="gemini-2.5-flash"
              spellCheck={false}
            />
          </Row>
          <div className="sm-hint-text" style={{ marginTop: -2, paddingLeft: 4, marginBottom: 14 }}>
            💡 Get your key at <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer" style={{ color: 'hsl(195,90%,70%)' }}>Google AI Studio</a>.
            {(settings.geminiApiKey ?? '').trim() && (
              <span style={{ marginLeft: 8, color: 'hsl(140,70%,60%)', fontWeight: 600 }}>✓ API key is set</span>
            )}
          </div>

          {/* ── OpenAI / ChatGPT Settings (always shown) ── */}
          <SectionLabel sub>ChatGPT (OpenAI) Settings</SectionLabel>
          <Row name="OpenAI API Key" hint="Your secret key starting with sk-... — get one at platform.openai.com/api-keys">
            <GeminiKeyInput
              value={settings.openAiApiKey ?? ''}
              onChange={v => updateSetting('openAiApiKey', v)}
            />
          </Row>
          <Row name="ChatGPT Model" hint="Default is gpt-4o-mini (fast & affordable). Use gpt-4o for best quality.">
            <input
              id="input-openai-model"
              type="text"
              className="sm-text-input"
              value={settings.openAiModel ?? 'gpt-4o-mini'}
              onChange={e => updateSetting('openAiModel', e.target.value.trim())}
              placeholder="gpt-4o-mini"
              spellCheck={false}
            />
          </Row>
          <div className="sm-hint-text" style={{ marginTop: -2, paddingLeft: 4, marginBottom: 14 }}>
            💡 Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" style={{ color: 'hsl(195,90%,70%)' }}>platform.openai.com/api-keys</a>.
            <span style={{ marginLeft: 6, opacity: 0.65 }}>Recommended: gpt-4o-mini · gpt-4o · gpt-4-turbo</span>
            {(settings.openAiApiKey ?? '').trim() && (
              <span style={{ marginLeft: 8, color: 'hsl(140,70%,60%)', fontWeight: 600 }}>✓ API key is set</span>
            )}
          </div>


          {/* ── AI Backend ── */}
          <SectionLabel>Local Backup Backend</SectionLabel>
          <div className="sm-cards sm-cards--2" role="radiogroup" aria-label="AI backend">
            {[
              { id: 'ollama',    name: 'Ollama (Local)',  icon: '🦙', desc: 'Local REST API · zero cloud data · requires Ollama installed' },
              { id: 'window-ai', name: 'Gemini Nano',     icon: '✨', desc: 'Chrome Built-in AI · no install needed · auto-fallback if Ollama unavailable' },
            ].map(b => (
              <button key={b.id} role="radio" aria-checked={backend === b.id}
                className={`sm-card sm-card--violet ${backend === b.id ? 'sm-card--active' : ''}`}
                onClick={() => updateSetting('contextualResponseModel', b.id)}>
                <div className="sm-card__icon">{b.icon}</div>
                <span className="sm-card__name">{b.name}</span>
                <span className="sm-card__desc">{b.desc}</span>
                <span className="sm-card__dot" aria-hidden="true" />
              </button>
            ))}
          </div>
          <p className="sm-hint-text">
            💡 Ollama is the primary local backend. Gemini Nano activates automatically when Ollama is unreachable.
          </p>

          {/* ── Ollama model config ── */}
          <SectionLabel sub>Ollama Model</SectionLabel>
          <Row name="Model Name" hint="e.g. llama3.2 (text) · llava or llava-phi3 (text + image). Image/camera automatically switches to llava.">
            <input id="input-ollama-model" type="text" className="sm-text-input"
              value={settings.contextualOllamaModel ?? 'llama3.2'}
              onChange={e => updateSetting('contextualOllamaModel', e.target.value.trim())}
              placeholder="llama3.2" spellCheck={false} />
          </Row>
          <Row name="Vision Model (camera/image)" hint="Used automatically when an image is captured">
            <input id="input-ollama-vision-model" type="text" className="sm-text-input"
              value={settings.contextualOllamaVisionModel ?? 'llava'}
              onChange={e => updateSetting('contextualOllamaVisionModel', e.target.value.trim())}
              placeholder="llava" spellCheck={false} />
          </Row>

          {/* ── Ollama status ── */}
          <SectionLabel sub>Ollama Connection Status</SectionLabel>
          <div className="sm-ctx-status-row">
            <div className="sm-ctx-status">
              {checking && <><span className="sm-spinner" style={{ display: 'inline-block' }} /> Checking…</>}
              {!checking && ollamaStatus === null && <span style={{ opacity: 0.5 }}>—</span>}
              {!checking && ollamaStatus?.available === false && (
                <span className="sm-ctx-status--offline">⚠ Ollama not reachable at localhost:11434 — Gemini Nano will be used as fallback</span>
              )}
              {!checking && ollamaStatus?.available === true && (
                <span className="sm-ctx-status--online">
                  ✓ Ollama running · {ollamaStatus.models.length} model{ollamaStatus.models.length !== 1 ? 's' : ''}
                  {ollamaStatus.models.length > 0 && (
                    <span style={{ opacity: 0.65, marginLeft: 6 }}>
                      ({ollamaStatus.models.slice(0, 4).join(', ')}{ollamaStatus.models.length > 4 ? '…' : ''})
                    </span>
                  )}
                </span>
              )}
            </div>
            <button className="sm-btn sm-btn--outline sm-btn--xs" onClick={checkOllama} disabled={checking}>
              {checking ? '⏳' : '↺ Recheck'}
            </button>
          </div>
          <div className="sm-hint-text" style={{ marginTop: 4 }}>
            Install: <a href="https://ollama.ai" target="_blank" rel="noreferrer" style={{ color: 'hsl(265,70%,70%)' }}>ollama.ai</a>
            {' → '}run{' '}
            <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: 3 }}>ollama pull llama3.2</code>
            {' '}for text,{' '}
            <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: 3 }}>ollama pull llava</code>
            {' '}for vision.
          </div>
        </>
      )}
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
        <GranularSlider
          id="slider-font-scale"
          min={50}
          max={500}
          step={5}
          value={Math.round((settings.fontScale ?? 2.0) * 100)}
          onChange={val => updateSetting('fontScale', val / 100)}
          unit="%"
          presets={[
            { value: 100, label: '100% (Standard)' },
            { value: 150, label: '150% (Medium)' },
            { value: 200, label: '200% (Large)' },
            { value: 300, label: '300% (Huge)' },
            { value: 400, label: '400% (Gigantic)' },
          ]}
        />
      </Row>
      <Row name="Symbol Scale" hint="Scales symbols/images independently of text">
        <GranularSlider
          id="slider-symbol-scale"
          min={50}
          max={500}
          step={5}
          value={Math.round((settings.symbolScale ?? 2.0) * 100)}
          onChange={val => updateSetting('symbolScale', val / 100)}
          unit="%"
          presets={[
            { value: 100, label: '100% (Standard)' },
            { value: 150, label: '150% (Medium)' },
            { value: 200, label: '200% (Large)' },
            { value: 300, label: '300% (Huge)' },
            { value: 400, label: '400% (Gigantic)' },
          ]}
        />
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
            {opt.id === false ? (
              <>
                <span className="sm-card__name">{opt.name}</span>
                <span className="sm-card__desc">{opt.desc}</span>
                <div className="sm-card__icon">{opt.icon}</div>
              </>
            ) : (
              <>
                <div className="sm-card__icon">{opt.icon}</div>
                <span className="sm-card__name">{opt.name}</span>
                <span className="sm-card__desc">{opt.desc}</span>
              </>
            )}
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
                    flexDirection: (settings?.symbolOnTop ?? false) ? 'column' : 'column-reverse',
                  }}
                  onClick={() => toggleVocabCell(cell.id, !!cell.label)}
                  title={cell.label ? `${cell.label}${cell.hasLink ? ' (links to sub-page)' : ''}` : '(empty)'}
                  aria-pressed={isSel}
                  disabled={isEmpty}
                  tabIndex={isEmpty ? -1 : 0}
                >
                  {cell.imageUrl && <img src={cell.imageUrl} className="sm-vocab-cell__img" alt="" aria-hidden="true" />}
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

    </div>
  )
}

// ─── OBF Board Preview ────────────────────────────────────────────────────────
// Full grid with OBF background_color, border_color, symbols/images, load_board links

function OBFBoardPreview({ entry, boardSet, settings }) {
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
        style={{
          '--prev-cols': cols,
          '--prev-font-scale': settings?.fontScale ?? 2.0,
          '--prev-symbol-scale': settings?.symbolScale ?? 2.0,
        }}
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
              flexDirection: (settings?.symbolOnTop ?? false) ? 'column' : 'column-reverse',
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

// ─── GranularSlider — Reusable slider with text input & presets ─────────────────
function GranularSlider({
  id,
  min,
  max,
  step,
  value,
  onChange,
  presets,
  unit = '',
  valueArray = null,
  className = 'sm-slider',
}) {
  const [typedValue, setTypedValue] = useState(String(value))

  // Sync local text input when value changes externally
  useEffect(() => {
    setTypedValue(String(value))
  }, [value])

  let sliderValue
  let sliderMin = min
  let sliderMax = max
  let sliderStep = step

  if (valueArray) {
    // For index-mapped sliders (e.g., AnswerGate / CameraInterval)
    let closest = 0
    let minDiff = Infinity
    for (let i = 0; i < valueArray.length; i++) {
      let diff
      if (valueArray[i] === 'click' || value === 'click') {
        diff = (valueArray[i] === value) ? 0 : Infinity
      } else {
        diff = Math.abs(valueArray[i] - Number(value))
      }
      if (diff < minDiff) {
        minDiff = diff
        closest = i
      }
    }
    sliderValue = closest
    sliderMin = 0
    sliderMax = valueArray.length - 1
    sliderStep = 1
  } else {
    sliderValue = value
  }

  const handleSliderChange = (e) => {
    const idx = Number(e.target.value)
    if (valueArray) {
      onChange(valueArray[idx])
    } else {
      onChange(idx)
    }
  }

  const handleInputChange = (e) => {
    const valStr = e.target.value
    setTypedValue(valStr)
    if (valStr.toLowerCase() === 'click') {
      onChange('click')
      return
    }
    const num = parseFloat(valStr)
    if (!isNaN(num)) {
      const numericValues = valueArray ? valueArray.filter(v => typeof v === 'number') : []
      const minVal = valueArray ? Math.min(...numericValues) : min
      const maxVal = valueArray ? Math.max(...numericValues) : max
      const clamped = Math.max(minVal, Math.min(maxVal, num))
      onChange(clamped)
    }
  }

  const handleInputBlur = () => {
    setTypedValue(String(value))
  }

  return (
    <div className="sm-granular-container">
      <div className="sm-granular-row">
        <input
          id={id}
          type="range"
          className={className}
          min={sliderMin}
          max={sliderMax}
          step={sliderStep}
          value={sliderValue}
          onChange={handleSliderChange}
        />
        <input
          type="text"
          className="sm-granular-input"
          value={typedValue}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
        />
        {unit && value !== 'click' && <span className="sm-granular-unit">{unit}</span>}
      </div>
      {presets && presets.length > 0 && (
        <div className="sm-granular-presets">
          {presets.map((preset, idx) => {
            const active = preset.value === value
            return (
              <button
                key={idx}
                type="button"
                className={`sm-preset-btn ${active ? 'sm-preset-btn--active' : ''}`}
                onClick={() => onChange(preset.value)}
              >
                {preset.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
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

const NAV_CLICK_TONES = [
  { id: 'soft', name: 'Soft',  icon: '🔔', desc: 'Gentle sine-wave chime' },
  { id: 'tick', name: 'Tick',  icon: '🖱',  desc: 'Sharp mechanical click' },
  { id: 'pop',  name: 'Pop',   icon: '💥', desc: 'Bright high-pitched pop' },
]

const VOICE_PRESETS = [
  { id: 'default', name: 'Default',  icon: '🔊', desc: 'Normal rate & pitch',  rate: 0,  pitch: 0,  volume: 100 },
  { id: 'child',   name: 'Child',    icon: '🧒', desc: 'Higher pitch, slower', rate: -1, pitch: 6,  volume: 100 },
  { id: 'male',    name: 'Adult ♂',  icon: '👨', desc: 'Lower pitch, normal',  rate: 0,  pitch: -4, volume: 100 },
  { id: 'female',  name: 'Adult ♀',  icon: '👩', desc: 'Slightly higher pitch', rate: 0,  pitch: 3,  volume: 100 },
]

const TTS_ENGINES = [
  {
    id: 'sapi',
    name: 'SAPI',
    icon: '🔊',
    desc: 'Classic Windows TTS. Works offline on all Windows versions. Supports rate, pitch & volume.'
  },
  {
    id: 'winrt',
    name: 'WinRT / Natural',
    icon: '✨',
    desc: 'Modern UWP engine. Unlocks Neural & OneCore "Natural" voices (Azure Edge-Powered). Requires Windows 10 1703+.'
  },
]



// ─── AnswerGate slider — dual-resolution time picker ─────────────────────────
//
// Fine zone (≤ 5 s): 0.1 s steps → 0, 100, 200, …, 5000 ms  (51 values)
// Coarse zone (> 5 s): 0.5 s steps → 5500, 6000, …, 30000 ms (50 values)
// Total: 101 values; slider index 0–100.

const GATE_VALUES = (() => {
  const vals = [0]                                        // index 0  → Off
  for (let ms = 100; ms <= 5000; ms += 100) vals.push(ms) // indices 1–50
  for (let ms = 5500; ms <= 30000; ms += 500) vals.push(ms) // indices 51–100
  return vals
})()

function msToGateIndex(ms) {
  // Find closest index
  let best = 0
  let bestDiff = Math.abs(GATE_VALUES[0] - ms)
  for (let i = 1; i < GATE_VALUES.length; i++) {
    const diff = Math.abs(GATE_VALUES[i] - ms)
    if (diff < bestDiff) { bestDiff = diff; best = i }
  }
  return best
}

function fmtGateMs(ms) {
  if (ms === 0) return 'Off'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function AnswerGateSlider({ value, onChange }) {
  // value === -1 means Manual mode
  const isManual = value === -1
  // Restore timer value when switching away from manual (default 2s)
  const [lastTimerMs, setLastTimerMs] = useState(isManual ? 2000 : value)

  const idx = msToGateIndex(isManual ? lastTimerMs : value)
  const ms  = isManual ? lastTimerMs : value

  const handleToggleManual = () => {
    if (isManual) {
      // Switch back to timer mode — restore last timer value
      onChange(lastTimerMs || 2000)
    } else {
      // Switch to manual mode — cache current timer value
      setLastTimerMs(value > 0 ? value : 2000)
      onChange(-1)
    }
  }

  return (
    <div className="sm-ctx-answergate-card">
      <div className="sm-ctx-answergate-card__header">
        <span className="sm-ctx-answergate-card__icon">⏳</span>
        <div className="sm-ctx-answergate-card__meta">
          <span className="sm-ctx-answergate-card__title">Answer Gate</span>
          <span className="sm-ctx-answergate-card__subtitle">
            When enabled, response tiles are initially unselectable. Hover or gaze on the
            tiles to fill the progress bar — once full, tiles unlock for selection.
            <strong> Manual</strong> mode requires clicking the Proceed button on the Top Bar.
            Set to <strong>Off</strong> to disable the gate entirely.
          </span>
        </div>
      </div>

      {/* Manual / Timer toggle */}
      <div className="sm-ctx-answergate-mode-row">
        <button
          id="btn-answergate-timer"
          className={`sm-ctx-answergate-mode-btn ${!isManual ? 'sm-ctx-answergate-mode-btn--active' : ''}`}
          onClick={() => isManual && handleToggleManual()}
          aria-pressed={!isManual}
        >
          <span>⏱</span> Timer
        </button>
        <button
          id="btn-answergate-manual"
          className={`sm-ctx-answergate-mode-btn ${isManual ? 'sm-ctx-answergate-mode-btn--active sm-ctx-answergate-mode-btn--manual' : ''}`}
          onClick={() => !isManual && handleToggleManual()}
          aria-pressed={isManual}
        >
          <span>🖐</span> Manual
        </button>
      </div>

      {isManual ? (
        <p className="sm-hint-text" style={{ marginTop: 6 }}>
          🖐 <strong>Manual mode active</strong> — after responses appear, the action button
          on the Top Bar turns into a <strong>Proceed</strong> button. Click or dwell it to
          unlock the response tiles.
        </p>
      ) : (
        <>
          <div className="sm-ctx-answergate-slider-row">
            <GranularSlider
              id="slider-answer-gate"
              className="sm-slider sm-slider--amber"
              value={ms}
              onChange={onChange}
              valueArray={GATE_VALUES}
              unit="ms"
              presets={[
                { value: 0, label: 'Off' },
                { value: 1000, label: '1 s' },
                { value: 2000, label: '2 s' },
                { value: 5000, label: '5 s' },
                { value: 10000, label: '10 s' },
              ]}
            />
          </div>
          {ms > 0 && (
            <p className="sm-hint-text" style={{ marginTop: 6 }}>
              ⏳ Gate active — tiles require <strong>{fmtGateMs(ms)}</strong> of hover/gaze before unlocking.
              Fine: 0.1 s steps up to 5 s · Coarse: 0.5 s steps up to 30 s.
            </p>
          )}
        </>
      )}
    </div>
  )
}

// ─── GeminiKeyInput — password field with show/hide toggle ────────────────────

function GeminiKeyInput({ value, onChange }) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flex: 1 }}>
      <input
        id="input-gemini-apikey"
        type={show ? 'text' : 'password'}
        className="sm-text-input"
        style={{ flex: 1 }}
        value={value}
        onChange={e => onChange(e.target.value.trim())}
        placeholder="AIzaSy…"
        spellCheck={false}
        autoComplete="off"
      />
      <button
        type="button"
        className="sm-btn sm-btn--outline sm-btn--xs"
        style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
        onClick={() => setShow(v => !v)}
        title={show ? 'Hide key' : 'Show key'}
        aria-label={show ? 'Hide Gemini API key' : 'Show Gemini API key'}
      >
        {show ? '🙈 Hide' : '👁 Show'}
      </button>
      {value.trim() && (
        <button
          type="button"
          className="sm-btn sm-btn--danger sm-btn--xs"
          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          onClick={() => onChange('')}
          title="Clear key"
          aria-label="Clear Gemini API key"
        >
          ✕
        </button>
      )}
    </div>
  )
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function rgbaToHex(colorStr) {
  if (!colorStr) return '#00c8ff'
  if (colorStr.startsWith('#')) return colorStr.slice(0, 7)
  const m = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (m) return '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('')
  return '#00c8ff'
}

// ─── Panel 5: Camera & Vision Settings ──────────────────────────────────────────

const CAMERA_INTERVAL_VALUES = (() => {
  const vals = []
  // 500 ms to 5000 ms (5 s) in 250 ms increments
  for (let ms = 500; ms <= 5000; ms += 250) vals.push(ms)
  // 10 s to 60 s in 5 s increments
  for (let ms = 10000; ms <= 60000; ms += 5000) vals.push(ms)
  return vals
})()

function msToCameraIntervalIndex(ms) {
  let best = 0
  let bestDiff = Math.abs(CAMERA_INTERVAL_VALUES[0] - ms)
  for (let i = 1; i < CAMERA_INTERVAL_VALUES.length; i++) {
    const diff = Math.abs(CAMERA_INTERVAL_VALUES[i] - ms)
    if (diff < bestDiff) {
      bestDiff = diff
      best = i
    }
  }
  return best
}

function fmtCameraIntervalMs(ms) {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function CameraPanel({ settings, updateSetting, updateSettings }) {
  const {
    initMLModels,
    loadingModels,
    modelsLoaded,
    loadError,
    cameraActive,
    videoDevices,
    startCamera,
    stopCamera,
    captureReferenceDescriptors,
    visionData,
    liveVisionSummary,
    registerFace,
    deleteFace,
    registerObjectOrScene,
    deleteObjectOrScene,
    refreshVideoDevices,
    triggerManualDetection,
    processUploadedPhoto,
  } = useCameraVision()

  const [faceName, setFaceName] = useState('')
  const [faceMsg, setFaceMsg] = useState('')
  const [editingFaceId, setEditingFaceId] = useState(null)
  const [editingFaceName, setEditingFaceName] = useState('')
  const [customLabel, setCustomLabel] = useState('')
  const [customCategory, setCustomCategory] = useState('object') // 'object' | 'scene'
  const [customMsg, setCustomMsg] = useState('')

  // New multi-photo management states
  const [activeFacePopover, setActiveFacePopover] = useState(null)
  const [qrModalFace, setQrModalFace] = useState(null)
  const [wifiUrl, setWifiUrl] = useState('')
  const [localFileProcessingMsg, setLocalFileProcessingMsg] = useState('')
  const localFileInputRef = useRef(null)

  const isIntervalManual = settings.cameraIntervalMs === -1
  const [lastIntervalMs, setLastIntervalMs] = useState(isIntervalManual ? 2000 : (settings.cameraIntervalMs ?? 2000))

  const intervalIdx = msToCameraIntervalIndex(isIntervalManual ? lastIntervalMs : (settings.cameraIntervalMs ?? 2000))
  const intervalMs  = isIntervalManual ? lastIntervalMs : (settings.cameraIntervalMs ?? 2000)

  const handleToggleIntervalManual = () => {
    if (isIntervalManual) {
      updateSetting('cameraIntervalMs', lastIntervalMs || 2000)
    } else {
      setLastIntervalMs(settings.cameraIntervalMs > 0 ? settings.cameraIntervalMs : 2000)
      updateSetting('cameraIntervalMs', -1)
    }
  }

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const renderLoopRef = useRef(null)

  // Load models on tab mount
  useEffect(() => {
    if (!modelsLoaded && !loadingModels) {
      initMLModels()
    }
  }, [modelsLoaded, loadingModels, initMLModels])

  // Get local Wi-Fi transfer URL
  useEffect(() => {
    if (window.gazeAPI?.wifi?.getWifiUploadUrl) {
      window.gazeAPI.wifi.getWifiUploadUrl().then(url => {
        setWifiUrl(url)
      }).catch(err => {
        console.warn('Failed to query Wi-Fi upload URL:', err)
      })
    }
  }, [])

  // Listen for mobile Wi-Fi uploads
  useEffect(() => {
    if (!window.gazeAPI?.wifi?.onMobilePhotoUploaded) return

    const unsubscribe = window.gazeAPI.wifi.onMobilePhotoUploaded(async (data) => {
      const { faceId, image } = data
      console.log('[CameraPanel] Received photo uploaded over Wi-Fi for faceId:', faceId)

      // Find target face
      const faceList = settings.registeredFaces || []
      const face = faceList.find(f => f.id === faceId)
      if (!face) {
        console.warn('Received upload for unregistered faceId:', faceId)
        return
      }

      setLocalFileProcessingMsg('⏳ Extracted! Processing biometric vector in memory...')

      // Process base64 image in memory
      const img = new Image()
      img.src = image
      await new Promise(resolve => { img.onload = resolve })

      const faceDet = await processUploadedPhoto(img)
      if (!faceDet) {
        setLocalFileProcessingMsg('❌ No face detected in this photo. Please try a clearer portrait.')
        setTimeout(() => setLocalFileProcessingMsg(''), 5000)
        return
      }

      // Generate a cropped 80x80 thumbnail in memory
      const thumbnail = createCroppedFaceThumbnail(img, faceDet.detection.box)

      // Append to face photos (up to 5)
      const updatedFaces = faceList.map(f => {
        if (f.id === faceId) {
          const photos = f.photos || []
          if (photos.length >= 5) {
            alert('This face already has 5 photos registered. Please delete a photo first.')
            return f
          }
          return {
            ...f,
            photos: [
              ...photos,
              {
                id: `photo_${Date.now()}`,
                thumbnail,
                descriptor: Array.from(faceDet.descriptor),
                addedAt: Date.now()
              }
            ]
          }
        }
        return f
      })

      updateSetting('registeredFaces', updatedFaces)
      setLocalFileProcessingMsg('✅ Success! Photo added successfully.')
      setQrModalFace(null) // close QR modal on success
      setTimeout(() => setLocalFileProcessingMsg(''), 4000)
    })

    return unsubscribe
  }, [settings.registeredFaces, updateSetting, processUploadedPhoto])

  // Bind video element to camera stream when active
  useEffect(() => {
    if (cameraActive && videoRef.current && !videoRef.current.srcObject) {
      navigator.mediaDevices.getUserMedia({
        video: settings.cameraSelectedDeviceId
          ? { deviceId: { exact: settings.cameraSelectedDeviceId } }
          : { facingMode: settings.cameraFacingMode }
      }).then(stream => {
        if (videoRef.current) videoRef.current.srcObject = stream
      }).catch(() => {})
    }
  }, [cameraActive, settings.cameraSelectedDeviceId, settings.cameraFacingMode])

  // Start feed on panel open
  useEffect(() => {
    if (!cameraActive) {
      startCamera().catch(() => {})
    }
    return () => {
      // Keep feed running if contextual camera augmentation or streaming is currently active,
      // otherwise turn it off to save energy.
      const keepRunning = settings.cameraAugmentationEnabled || settings.cameraStreamingEnabled
      if (!keepRunning) {
        stopCamera()
      }
    }
  }, [cameraActive, startCamera, stopCamera, settings.cameraAugmentationEnabled, settings.cameraStreamingEnabled])

  // Local canvas rendering for overlays
  useEffect(() => {
    let active = true

    function draw() {
      if (!active) return
      const video = videoRef.current
      const canvas = canvasRef.current
      if (video && canvas && video.readyState >= 2) {
        const ctx = canvas.getContext('2d')
        if (canvas.width !== video.videoWidth) {
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        
        // Draw video frame
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

        // Draw custom emerald/green overlay for verified registered faces
        if (visionData.people) {
          visionData.people.forEach(p => {
            const box = p.box
            if (box) {
              ctx.strokeStyle = '#10B981' // emerald
              ctx.lineWidth = 3
              ctx.shadowColor = 'rgba(16, 185, 129, 0.4)'
              ctx.shadowBlur = 8
              ctx.strokeRect(box.x, box.y, box.width, box.height)
              ctx.shadowBlur = 0

              ctx.fillStyle = '#10B981'
              ctx.font = 'bold 12px Inter, sans-serif'
              const text = `${p.name} (${p.expression})`
              const tw = ctx.measureText(text).width
              ctx.fillRect(box.x, box.y > 20 ? box.y - 18 : box.y, tw + 8, 16)

              ctx.fillStyle = '#ffffff'
              ctx.fillText(text, box.x + 4, box.y > 20 ? box.y - 6 : box.y + 12)
            }
          })
        }

        // Draw COCO-SSD standard objects (vibrant amber overlay)
        if (visionData.objects) {
          visionData.objects.forEach(obj => {
            const box = obj.box
            if (box) {
              ctx.strokeStyle = '#f59e0b' // amber
              ctx.lineWidth = 2
              ctx.strokeRect(box.x, box.y, box.width, box.height)

              ctx.fillStyle = '#f59e0b'
              ctx.font = '11px Inter, sans-serif'
              const text = `${obj.label} (${Math.round(obj.confidence * 100)}%)`
              const tw = ctx.measureText(text).width
              ctx.fillRect(box.x, box.y > 16 ? box.y - 15 : box.y, tw + 6, 14)

              ctx.fillStyle = '#000000'
              ctx.fillText(text, box.x + 3, box.y > 16 ? box.y - 4 : box.y + 10)
            }
          })
        }
      }
      renderLoopRef.current = requestAnimationFrame(draw)
    }

    if (cameraActive && modelsLoaded) {
      renderLoopRef.current = requestAnimationFrame(draw)
    }

    return () => {
      active = false
      if (renderLoopRef.current) cancelAnimationFrame(renderLoopRef.current)
    }
  }, [cameraActive, modelsLoaded, visionData])

  const handleAddPerson = () => {
    if (!faceName.trim()) {
      setFaceMsg('❌ Please enter a name first.')
      return
    }

    const newFaceId = `face_${Date.now()}_${Math.floor(Math.random() * 1000)}`
    const newFace = {
      id: newFaceId,
      name: faceName.trim(),
      addedAt: Date.now(),
      addedByDevice: settings.deviceName || 'Local PC',
      photos: []
    }

    const existing = settings.registeredFaces || []
    updateSetting('registeredFaces', [...existing, newFace])

    setFaceMsg(`✅ Added "${faceName.trim()}"! Add photos inside their profile below.`)
    setFaceName('')
    setTimeout(() => setFaceMsg(''), 4000)
  }

  const handleSaveRename = (faceId) => {
    if (!editingFaceName.trim()) {
      alert('Name cannot be empty.')
      return
    }
    const faceList = settings.registeredFaces || []
    const updated = faceList.map(f => {
      if (f.id === faceId) {
        return { ...f, name: editingFaceName.trim() }
      }
      return f
    })
    updateSetting('registeredFaces', updated)
    setEditingFaceId(null)
  }

  const handleCaptureFacePhoto = async (faceId) => {
    setActiveFacePopover(null)
    const video = videoRef.current
    if (!video || video.readyState < 2) {
      setLocalFileProcessingMsg('❌ Camera feed is not active. Please turn on camera/augmentation above.')
      setTimeout(() => setLocalFileProcessingMsg(''), 4000)
      return
    }

    setLocalFileProcessingMsg('⏳ Extracting biometric descriptors from camera...')
    const faceapi = window.faceapi
    try {
      const faceDet = await faceapi
        .detectSingleFace(video, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.6 }))
        .withFaceLandmarks()
        .withFaceDescriptor()

      if (faceDet) {
        const thumbnail = createCroppedFaceThumbnail(video, faceDet.detection.box)
        const faceList = settings.registeredFaces || []

        const updated = faceList.map(f => {
          if (f.id === faceId) {
            const photos = f.photos || []
            if (photos.length >= 5) {
              alert('This face already has 5 photos registered. Please delete a photo first.')
              return f
            }
            return {
              ...f,
              photos: [
                ...photos,
                {
                  id: `photo_${Date.now()}`,
                  thumbnail,
                  descriptor: Array.from(faceDet.descriptor),
                  addedAt: Date.now()
                }
              ]
            }
          }
          return f
        })

        updateSetting('registeredFaces', updated)
        setLocalFileProcessingMsg('✅ Success! Camera photo registered.')
        setTimeout(() => setLocalFileProcessingMsg(''), 3000)
      } else {
        setLocalFileProcessingMsg('❌ No face detected. Position yourself clearly in front of the lens.')
        setTimeout(() => setLocalFileProcessingMsg(''), 5000)
      }
    } catch (err) {
      setLocalFileProcessingMsg(`❌ Error: ${err.message}`)
      setTimeout(() => setLocalFileProcessingMsg(''), 5000)
    }
  }

  const handleLocalFileChange = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    const faceId = activeFacePopover
    setActiveFacePopover(null) // close popover

    setLocalFileProcessingMsg('⏳ Loading image in memory...')

    const reader = new FileReader()
    reader.onload = async (evt) => {
      const img = new Image()
      img.src = evt.target.result
      img.onload = async () => {
        setLocalFileProcessingMsg('⏳ Analyzing face biometric vector...')
        const faceDet = await processUploadedPhoto(img)
        if (!faceDet) {
          setLocalFileProcessingMsg('❌ No face detected in this photo. Please try a clearer portrait.')
          setTimeout(() => setLocalFileProcessingMsg(''), 5000)
          return
        }

        const thumbnail = createCroppedFaceThumbnail(img, faceDet.detection.box)
        const faceList = settings.registeredFaces || []

        const updated = faceList.map(f => {
          if (f.id === faceId) {
            const photos = f.photos || []
            if (photos.length >= 5) {
              alert('This face already has 5 photos registered. Please delete a photo first.')
              return f
            }
            return {
              ...f,
              photos: [
                ...photos,
                {
                  id: `photo_${Date.now()}`,
                  thumbnail,
                  descriptor: Array.from(faceDet.descriptor),
                  addedAt: Date.now()
                }
              ]
            }
          }
          return f
        })

        updateSetting('registeredFaces', updated)
        setLocalFileProcessingMsg('✅ Photo added successfully!')
        setTimeout(() => setLocalFileProcessingMsg(''), 3000)
      }
    }
    reader.readAsDataURL(file)
  }

  const handleSnapCustom = async () => {
    const video = videoRef.current
    if (!video || video.readyState < 2) {
      setCustomMsg('❌ Camera feed is not ready.')
      return
    }
    if (!customLabel.trim()) {
      setCustomMsg('❌ Please enter a label first.')
      return
    }

    setCustomMsg('⏳ Extracting visual embeddings...')
    const descriptors = await captureReferenceDescriptors(video)
    if (descriptors && descriptors.objectDescriptor) {
      const success = registerObjectOrScene(customLabel, descriptors.objectDescriptor, customCategory)
      if (success) {
        setCustomMsg(`✅ Registered "${customLabel.trim()}"!`)
        setCustomLabel('')
        setTimeout(() => setCustomMsg(''), 3000)
      } else {
        setCustomMsg('❌ Registration error.')
      }
    } else {
      setCustomMsg('❌ Failed to capture visual descriptor.')
    }
  }

  const toggleFacingMode = () => {
    const next = settings.cameraFacingMode === 'user' ? 'environment' : 'user'
    updateSetting('cameraFacingMode', next)
    startCamera(next, settings.cameraSelectedDeviceId).catch(() => {})
  }

  const selectCamera = (deviceId) => {
    updateSetting('cameraSelectedDeviceId', deviceId)
    startCamera(settings.cameraFacingMode, deviceId).catch(() => {})
  }

  if (loadingModels) {
    return (
      <div className="sm-panel__sections sm-loader-panel">
        <div className="sm-vision-spinner-wrap">
          <span className="sm-vision-loader-spinner" />
          <h3>Loading Offline Computer Vision Models...</h3>
          <p>Downloading optimized TensorFlow, FaceMesh, and MobileNet weights locally...</p>
        </div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="sm-panel__sections sm-error-panel">
        <div className="sm-vision-error-wrap">
          <span className="sm-vision-error-icon">⚠️</span>
          <h3>Failed to Initialize Vision Engine</h3>
          <p className="sm-vision-error-text">{loadError}</p>
          <button className="sm-btn sm-btn--accent" onClick={initMLModels}>Retry Loading Pipeline</button>
        </div>
      </div>
    )
  }

  return (
    <div className="sm-panel__sections">
      
      {/* ── Augmentation Activation ── */}
      <SectionLabel>Camera Augmentation</SectionLabel>
      <Row
        name="Enable Intelligent Augmentation"
        hint="Automatically analyze physical surroundings and inject observed people, facial expressions, physical objects, and location cues directly into the contextual response AI."
      >
        <Toggle
          id="toggle-camera-augmentation"
          checked={settings.cameraAugmentationEnabled ?? false}
          onChange={e => updateSetting('cameraAugmentationEnabled', e.target.checked)}
        />
      </Row>
      <Row
        name="Augment Only on Prompt"
        hint="Only take input from the camera and generate suggestions when you explicitly prompt the system (e.g., type/speak or click 'Now'), preventing continuous background generations from interrupting regular conversation flow."
      >
        <Toggle
          id="toggle-camera-augment-only-on-prompt"
          checked={settings.cameraAugmentOnlyOnPrompt ?? false}
          onChange={e => updateSetting('cameraAugmentOnlyOnPrompt', e.target.checked)}
        />
      </Row>
      <Row
        name="Play Update Sound"
        hint="Play a soft, discreet synthesized chime whenever the background camera detection loop completes an analysis and refreshes the environment summary."
      >
        <Toggle
          id="toggle-camera-update-sound"
          checked={settings.cameraUpdateSoundEnabled ?? true}
          onChange={e => updateSetting('cameraUpdateSoundEnabled', e.target.checked)}
        />
      </Row>

      {/* ── Diagnostics HUD & Camera Controls ── */}
      <SectionLabel>Live Diagnostics &amp; HUD</SectionLabel>
      <div className="sm-camera-layout">
        
        {/* HUD Screen */}
        <div className="sm-camera-screen-wrap">
          {cameraActive ? (
            <>
              <video ref={videoRef} className="sm-camera-screen-video" muted playsInline autoPlay style={{ display: 'none' }} />
              <canvas ref={canvasRef} className="sm-camera-screen-canvas" />
              <div className="sm-camera-hud-badge">🔬 Live HUD active</div>
            </>
          ) : (
            <div className="sm-camera-screen-placeholder">
              <span>📷</span>
              <p>Camera feed is inactive. Toggle augmentation or settings to activate.</p>
            </div>
          )}
        </div>

        {/* Video Controls */}
        <div className="sm-camera-controls">
          <Row name="Facing Direction" hint="Switch between front/user camera or rear/environment camera">
            <button className="sm-btn sm-btn--outline sm-btn--sm" onClick={toggleFacingMode}>
              {settings.cameraFacingMode === 'user' ? '👤 Front Camera' : '🌳 Rear Camera'}
            </button>
          </Row>
          <Row name="Select Camera Device" hint="Pick a specific plugged-in USB camera">
            <select
              className="sm-select"
              style={{ width: '100%' }}
              value={settings.cameraSelectedDeviceId ?? ''}
              onChange={e => selectCamera(e.target.value)}
            >
              <option value="">Default System Camera</option>
              {videoDevices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${d.deviceId.slice(0, 5)}`}</option>
              ))}
            </select>
          </Row>
          <Row name="Detection Loop Interval" hint="How frequently to process video frames. Slower intervals save battery. Manual mode only runs when triggered.">
            <div className="sm-ctx-answergate-mode-row" style={{ width: '100%', marginBottom: '8px' }}>
              <button
                type="button"
                className={`sm-ctx-answergate-mode-btn ${!isIntervalManual ? 'sm-ctx-answergate-mode-btn--active' : ''}`}
                onClick={() => isIntervalManual && handleToggleIntervalManual()}
                style={{ flex: 1, padding: '4px 8px', fontSize: '0.75rem' }}
              >
                ⏱ Timer
              </button>
              <button
                type="button"
                className={`sm-ctx-answergate-mode-btn ${isIntervalManual ? 'sm-ctx-answergate-mode-btn--active sm-ctx-answergate-mode-btn--manual' : ''}`}
                onClick={() => !isIntervalManual && handleToggleIntervalManual()}
                style={{ flex: 1, padding: '4px 8px', fontSize: '0.75rem' }}
              >
                🖐 Manual
              </button>
            </div>
            {isIntervalManual ? (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', width: '100%' }}>
                <button
                  type="button"
                  className="sm-btn sm-btn--accent sm-btn--sm"
                  onClick={async (e) => {
                    const originalText = e.target.innerText
                    e.target.innerText = '⏳ Analyzing...'
                    e.target.disabled = true
                    try {
                      const res = await triggerManualDetection()
                      if (res) {
                        alert(`Detection complete: ${res}`)
                      } else {
                        alert('Detection complete: No objects or people detected.')
                      }
                    } catch (err) {
                      alert(`Detection error: ${err.message}`)
                    } finally {
                      e.target.innerText = originalText
                      e.target.disabled = false
                    }
                  }}
                  disabled={!cameraActive}
                  style={{ flex: 1 }}
                >
                  🔬 Run Detection Now
                </button>
                <Val>Manual</Val>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', width: '100%' }}>
                <GranularSlider
                  id="slider-camera-interval"
                  value={intervalMs}
                  onChange={val => updateSetting('cameraIntervalMs', val)}
                  valueArray={CAMERA_INTERVAL_VALUES}
                  unit="ms"
                  presets={[
                    { value: 1000, label: '1 s' },
                    { value: 2000, label: '2 s' },
                    { value: 5000, label: '5 s' },
                    { value: 10000, label: '10 s' },
                    { value: 30000, label: '30 s' },
                  ]}
                />
              </div>
            )}
          </Row>
        </div>

      </div>

      {liveVisionSummary && (
        <div className="sm-camera-summary-banner">
          <strong>Aggregated AI Context Prompt:</strong>
          <p>&ldquo;{liveVisionSummary}&rdquo;</p>
        </div>
      )}

      {/* ── Face Biometric Registration ── */}
      <SectionLabel>Face Biometric Registration (FaceNet)</SectionLabel>
      <div className="sm-registration-block">
        <p className="sm-hint-text">
          Enter a caregiver's or family member's name to create their profile. Once added, you can register up to 5 biometric photos inside their profile card below via your camera feed, PC files, or mobile phone.
        </p>
        <div className="sm-registration-form">
          <input
            type="text"
            className="sm-text-input"
            placeholder="Person's Name (e.g. Mom, Bob)"
            value={faceName}
            onChange={e => setFaceName(e.target.value)}
          />
          <button
            className="sm-btn sm-btn--accent"
            onClick={handleAddPerson}
          >
            ➕ Add Person
          </button>
        </div>
        {faceMsg && <div className="sm-registration-feedback">{faceMsg}</div>}

        {/* Registered list */}
        <div className="sm-vector-grid-title">Registered Face Profiles:</div>
        {localFileProcessingMsg && <div className="sm-registration-feedback" style={{ color: '#00c8ff', marginBottom: '8px' }}>{localFileProcessingMsg}</div>}
        {(!settings.registeredFaces || settings.registeredFaces.length === 0) ? (
          <p className="sm-empty-vectors-text">No face profiles registered yet.</p>
        ) : (
          <div className="sm-vector-list sm-vector-list--face">
            {settings.registeredFaces.map(face => {
              const photos = face.photos || []
              const isEditing = editingFaceId === face.id
              return (
                <div key={face.id} className="sm-vector-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="sm-vector-info">
                      <span className="sm-vector-icon">👤</span>
                      <div>
                        {isEditing ? (
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', margin: '4px 0' }}>
                            <input
                              type="text"
                              className="sm-text-input"
                              style={{ padding: '2px 6px', fontSize: '0.78rem', height: '24px', minWidth: '120px', fontFamily: 'var(--font-mono)' }}
                              value={editingFaceName}
                              onChange={e => setEditingFaceName(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') handleSaveRename(face.id)
                                if (e.key === 'Escape') setEditingFaceId(null)
                              }}
                              autoFocus
                            />
                            <button
                              className="sm-btn sm-btn--accent"
                              style={{ padding: '2px 8px', fontSize: '0.7rem', height: '24px', minHeight: 'auto' }}
                              onClick={() => handleSaveRename(face.id)}
                            >
                              Save
                            </button>
                            <button
                              className="sm-btn sm-btn--outline"
                              style={{ padding: '2px 8px', fontSize: '0.7rem', height: '24px', minHeight: 'auto', color: 'var(--color-text-secondary)' }}
                              onClick={() => setEditingFaceId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span className="sm-vector-name">{face.name}</span>
                            <button
                              className="sm-btn sm-btn--outline"
                              style={{ 
                                padding: '2px 6px', 
                                fontSize: '0.65rem', 
                                height: '18px', 
                                minHeight: 'auto', 
                                lineHeight: 1,
                                borderRadius: '4px',
                                opacity: 0.8,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '2px',
                                color: 'var(--color-text-secondary)',
                                border: '1px solid hsl(225, 16%, 24%)'
                              }}
                              onClick={() => {
                                setEditingFaceId(face.id)
                                setEditingFaceName(face.name)
                              }}
                              title="Rename person"
                            >
                              ✏️ Rename
                            </button>
                          </div>
                        )}
                        <span className="sm-vector-meta">
                          Added {_relTime(face.addedAt)}{face.addedByDevice ? ` on ${face.addedByDevice}` : ''}
                        </span>
                      </div>
                    </div>
                    <button
                      className="sm-vector-delete"
                      title="Remove face profile"
                      onClick={() => {
                        if (window.confirm(`Delete registered face profile for "${face.name}"?`)) {
                          deleteFace(face.id)
                        }
                      }}
                    >
                      🗑️ Delete
                    </button>
                  </div>

                  {/* Multi-Photo row */}
                  <div className="sm-face-photos-section">
                    <span className="sm-face-photos-title">Biometric Photos ({photos.length}/5)</span>
                    <div className="sm-face-photos-row">
                      {/* Show current photos */}
                      {photos.map(photo => (
                        <div key={photo.id} className="sm-face-photo-wrapper">
                          <img src={photo.thumbnail} className="sm-face-photo-thumb" alt="Thumbnail" />
                          <div 
                            className="sm-face-photo-delete-badge" 
                            title="Delete this photo reference"
                            onClick={() => {
                              if (window.confirm('Delete this photo reference to improve biometric accuracy?')) {
                                const updated = settings.registeredFaces.map(f => {
                                  if (f.id === face.id) {
                                    return {
                                      ...f,
                                      photos: (f.photos || []).filter(p => p.id !== photo.id)
                                    }
                                  }
                                  return f
                                })
                                const existingDeleted = settings.deletedPhotoIds || []
                                const updatedDeleted = [...existingDeleted.filter(d => d.id !== photo.id), { id: photo.id, deletedAt: Date.now() }]
                                
                                updateSettings({
                                  registeredFaces: updated,
                                  deletedPhotoIds: updatedDeleted
                                })
                              }
                            }}
                          >
                            ✕
                          </div>
                        </div>
                      ))}

                      {/* Add photo slot */}
                      {photos.length < 5 && (
                        <div className="sm-photo-actions-wrap">
                          <div 
                            className="sm-face-photo-slot" 
                            title="Add reference photo"
                            onClick={() => setActiveFacePopover(activeFacePopover === face.id ? null : face.id)}
                          >
                            +
                          </div>

                          {/* Popover action list */}
                          {activeFacePopover === face.id && (
                            <div className="sm-photo-popover">
                              <button 
                                className="sm-photo-popover-btn"
                                onClick={() => handleCaptureFacePhoto(face.id)}
                              >
                                📸 Capture from Camera
                              </button>
                              <button 
                                className="sm-photo-popover-btn"
                                onClick={() => localFileInputRef.current && localFileInputRef.current.click()}
                              >
                                📁 Upload from PC
                              </button>
                              <button 
                                className="sm-photo-popover-btn"
                                onClick={() => {
                                  setActiveFacePopover(null)
                                  setQrModalFace(face)
                                }}
                              >
                                📱 Upload from Phone
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Custom Object/Scene Registration ── */}
      <SectionLabel>Custom Object &amp; Location Registry (MobileNet Embeddings)</SectionLabel>
      <div className="sm-registration-block">
        <p className="sm-hint-text">
          Train GazeAAC to identify specific objects (e.g. Johnny's special blue cup) or custom scenes/rooms (e.g. Bedroom, Living Room) by taking embedding descriptors.
        </p>
        <div className="sm-registration-form">
          <input
            type="text"
            className="sm-text-input"
            placeholder="Label (e.g. Blue Cup, Bedroom)"
            value={customLabel}
            onChange={e => setCustomLabel(e.target.value)}
          />
          <select
            className="sm-select"
            value={customCategory}
            onChange={e => setCustomCategory(e.target.value)}
          >
            <option value="object">Object (Item)</option>
            <option value="scene">Scene (Location)</option>
          </select>
          <button
            className="sm-btn sm-btn--accent"
            onClick={handleSnapCustom}
            disabled={!cameraActive}
          >
            📸 Register Embedding
          </button>
        </div>
        {customMsg && <div className="sm-registration-feedback">{customMsg}</div>}

        {/* Registered list */}
        <div className="sm-vector-grid-title">Registered Embedding Vectors:</div>
        {(!settings.registeredObjects || settings.registeredObjects.length === 0) ? (
          <p className="sm-empty-vectors-text">No custom objects or locations registered yet.</p>
        ) : (
          <div className="sm-vector-list">
            {settings.registeredObjects.map(item => (
              <div key={item.id} className="sm-vector-item">
                <div className="sm-vector-info">
                  <span className="sm-vector-icon">{item.type === 'scene' ? '🏠' : '📦'}</span>
                  <div>
                    <span className="sm-vector-name">{item.label}</span>
                    <span className="sm-vector-meta">
                      Type: {item.type === 'scene' ? 'Location / Room' : 'Physical Object'} · Added {_relTime(item.addedAt)}
                    </span>
                  </div>
                </div>
                <button
                  className="sm-vector-delete"
                  title="Remove embedding vector"
                  onClick={() => {
                    if (window.confirm(`Delete registered embedding for "${item.label}"?`)) {
                      deleteObjectOrScene(item.id)
                    }
                  }}
                >
                  🗑️ Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Hidden file input for local photo imports */}
      <input 
        type="file" 
        accept="image/*" 
        ref={localFileInputRef} 
        style={{ display: 'none' }} 
        onChange={handleLocalFileChange} 
      />

      {/* Wi-Fi Upload QR Code Modal */}
      {qrModalFace && (
        <div className="sm-qr-overlay" onClick={() => setQrModalFace(null)}>
          <div className="sm-qr-modal" onClick={e => e.stopPropagation()}>
            <div className="sm-qr-title">📱 Upload from Phone</div>
            <div className="sm-qr-desc">
              Scan this QR code with your mobile phone's camera. Ensure your phone is connected to the same Wi-Fi network: <strong>{wifiUrl ? 'Local Wi-Fi Active' : 'Offline'}</strong>.
            </div>
            {wifiUrl && (
              <div className="sm-qr-code-wrap">
                <img 
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(wifiUrl + '/?faceId=' + qrModalFace.id + '&name=' + encodeURIComponent(qrModalFace.name))}`} 
                  className="sm-qr-code-img"
                  alt="QR Code" 
                />
              </div>
            )}
            <div className="sm-qr-url">
              {wifiUrl ? `${wifiUrl}/?faceId=${qrModalFace.id}` : 'Wi-Fi IP offline'}
            </div>
            <div className="sm-qr-status">
              <span className="sm-qr-pulse-dot" />
              Listening for Wi-Fi photo transfer...
            </div>
            <button className="sm-btn sm-btn--outline sm-qr-close-btn" onClick={() => setQrModalFace(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      
    </div>
  )
}

function createCroppedFaceThumbnail(imageElement, detectionBox) {
  const canvas = document.createElement('canvas')
  canvas.width = 160
  canvas.height = 160
  const ctx = canvas.getContext('2d')

  if (detectionBox) {
    // Crop slightly wider than the face box to include hair/context
    const padX = detectionBox.width * 0.15
    const padY = detectionBox.height * 0.15
    const sx = Math.max(0, detectionBox.x - padX)
    const sy = Math.max(0, detectionBox.y - padY)
    const sw = Math.min(imageElement.naturalWidth || imageElement.videoWidth || imageElement.width || 160, detectionBox.width + padX * 2)
    const sh = Math.min(imageElement.naturalHeight || imageElement.videoHeight || imageElement.height || 160, detectionBox.height + padY * 2)
    
    ctx.drawImage(imageElement, sx, sy, sw, sh, 0, 0, 160, 160)
  } else {
    // Fallback: draw centered square crop of the whole image
    const w = imageElement.naturalWidth || imageElement.videoWidth || imageElement.width || 160
    const h = imageElement.naturalHeight || imageElement.videoHeight || imageElement.height || 160
    const size = Math.min(w, h)
    const sx = (w - size) / 2
    const sy = (h - size) / 2
    ctx.drawImage(imageElement, sx, sy, size, size, 0, 0, 160, 160)
  }

  return canvas.toDataURL('image/jpeg', 0.6)
}

// ─── Panel 6: Movie Time ──────────────────────────────────────────────

const MT_TOPICS = [
  'Animals', 'Science', 'Nature', 'Art', 'Music', 'Sports',
  'History', 'Geography', 'Space', 'Technology', 'Cooking',
  'Gaming', 'Comedy', 'Stories', 'Math', 'Language',
]
const MT_PUZZLE_TYPES = ['Quiz', 'Word Puzzle', 'Math', 'Memory', 'Riddle']
const MT_DIFFICULTIES = ['Easy', 'Medium', 'Hard']
const MT_SAFE_SEARCHES = [
  { id: 'strict',   label: 'Strict',   desc: 'Maximum filtering — recommended for children' },
  { id: 'moderate', label: 'Moderate', desc: 'Balanced content filtering' },
  { id: 'none',     label: 'None',     desc: 'No filtering — caregiver discretion advised' },
]
const MT_DURATIONS = [
  { id: 'short',  label: 'Short',  desc: '< 4 minutes' },
  { id: 'medium', label: 'Medium', desc: '4–20 minutes' },
  { id: 'long',   label: 'Long',   desc: '> 20 minutes' },
  { id: 'any',    label: 'Any',    desc: 'No duration filter' },
]
const MT_VIDEO_QUALITIES = [
  { id: 'any',  label: 'Any',      desc: 'No quality filter',    icon: '🎞️' },
  { id: 'hd',   label: 'HD 720p',  desc: 'High definition',      icon: '📺' },
  { id: 'fhd',  label: '1080p+',   desc: 'Full HD or better',    icon: '🔷' },
  { id: '4k',   label: '4K',       desc: 'Ultra HD / 2160p',     icon: '✨' },
]
const MT_MIN_VIEWS = [
  { id: 0,           label: 'Any',   desc: 'No minimum' },
  { id: 10_000,      label: '10K',   desc: '10,000+ views' },
  { id: 50_000,      label: '50K',   desc: '50,000+ views' },
  { id: 100_000,     label: '100K',  desc: '100,000+ views' },
  { id: 250_000,     label: '250K',  desc: '250,000+ views' },
  { id: 500_000,     label: '500K',  desc: '500,000+ views' },
  { id: 1_000_000,   label: '1M',    desc: '1 million+ views' },
  { id: 5_000_000,   label: '5M',    desc: '5 million+ views' },
  { id: 10_000_000,  label: '10M',   desc: '10 million+ views' },
]

function MovieTimePanel({ settings, updateSetting, updateSettings }) {
  const [activeTab, setActiveTab] = useState('playback')  // 'playback' | 'content' | 'puzzle' | 'apikey'

  // ── YouTube API key list state ────────────────────────────────────
  const [newKeyValue, setNewKeyValue]   = useState('')
  const [newKeyLabel, setNewKeyLabel]   = useState('')
  const [keyVisibility, setKeyVisibility] = useState({})   // { [index]: true } = shown
  const [keyStatuses,   setKeyStatuses]   = useState({})   // { [index]: 'ok'|'error'|'quota'|'testing' }

  const ytKeys = settings.movieTimeYoutubeKeys ?? []
  const [newKeyError, setNewKeyError] = useState(null)  // validation error for the Add Key input

  const addYtKey = () => {
    const k = newKeyValue.trim()
    if (!k) return
    const validationErr = _validateYtKey(k)
    if (validationErr) { setNewKeyError(validationErr); return }
    const label = newKeyLabel.trim() || `Key ${ytKeys.length + 1}`
    updateSetting('movieTimeYoutubeKeys', [...ytKeys, { key: k, label }])
    setNewKeyValue('')
    setNewKeyLabel('')
    setNewKeyError(null)
  }

  // Validates that a string looks like a real YouTube Data API v3 key
  const _validateYtKey = (k) => {
    if (k.startsWith('http') || k.includes('console.cloud.google.com') || k.includes('?')) {
      return 'That looks like a URL, not an API key. Open the link, then copy the actual key string that starts with \'AIza\'.'
    }
    if (!k.startsWith('AIza')) {
      return 'A YouTube Data API v3 key always starts with \'AIza\'. Make sure you copied the \'Key string\' value from Google Cloud Console, not the page URL.'
    }
    if (k.length < 30) {
      return 'Key seems too short — a valid API key is ~39 characters. Double-check you copied the full key.'
    }
    return null  // valid
  }

  const removeYtKey = (idx) => {
    const updated = ytKeys.filter((_, i) => i !== idx)
    updateSetting('movieTimeYoutubeKeys', updated)
    setKeyVisibility(v => { const n = {...v}; delete n[idx]; return n })
    setKeyStatuses(s => { const n = {...s}; delete n[idx]; return n })
  }

  const testYtKey = async (idx) => {
    const key = ytKeys[idx]?.key?.trim()
    if (!key) return
    setKeyStatuses(s => ({ ...s, [idx]: 'testing' }))
    try {
      const res  = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=test&maxResults=1&key=${key}`)
      const data = await res.json()
      if (data.error) {
        const isQuota = data.error.errors?.some(e => e.reason === 'quotaExceeded')
        setKeyStatuses(s => ({ ...s, [idx]: isQuota ? 'quota' : 'error' }))
      } else {
        setKeyStatuses(s => ({ ...s, [idx]: 'ok' }))
      }
    } catch {
      setKeyStatuses(s => ({ ...s, [idx]: 'error' }))
    }
  }

  const [newWhitelist, setNewWhitelist] = useState('')
  const [newBlacklist, setNewBlacklist] = useState('')
  const [newInterest, setNewInterest] = useState('')
  const [newYtUrl, setNewYtUrl] = useState('')
  const [ytUrlError, setYtUrlError] = useState(null)

  // ── Toggle helpers ──────────────────────────────────────────────
  const toggleTopic = (t) => {
    const cur = settings.movieTimeTopics ?? []
    updateSetting('movieTimeTopics', cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t])
  }
  const togglePuzzleType = (t) => {
    const cur = settings.movieTimePuzzleTypes ?? []
    updateSetting('movieTimePuzzleTypes', cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t])
  }

  // ── Keyword chip helpers ────────────────────────────────────────
  const addWhitelist = () => {
    const w = newWhitelist.trim().toLowerCase()
    if (!w) return
    const cur = settings.movieTimeWhitelist ?? []
    if (!cur.includes(w)) updateSetting('movieTimeWhitelist', [...cur, w])
    setNewWhitelist('')
  }
  const removeWhitelist = (w) =>
    updateSetting('movieTimeWhitelist', (settings.movieTimeWhitelist ?? []).filter(x => x !== w))

  const addBlacklist = () => {
    const w = newBlacklist.trim().toLowerCase()
    if (!w) return
    const cur = settings.movieTimeBlacklist ?? []
    if (!cur.includes(w)) updateSetting('movieTimeBlacklist', [...cur, w])
    setNewBlacklist('')
  }
  const removeBlacklist = (w) =>
    updateSetting('movieTimeBlacklist', (settings.movieTimeBlacklist ?? []).filter(x => x !== w))

  // ── Interests (OR-based) helpers ─────────────────────────────────
  const addInterest = () => {
    const w = newInterest.trim().toLowerCase()
    if (!w) return
    const cur = settings.movieTimeInterests ?? []
    if (!cur.includes(w)) updateSetting('movieTimeInterests', [...cur, w])
    setNewInterest('')
  }
  const removeInterest = (w) =>
    updateSetting('movieTimeInterests', (settings.movieTimeInterests ?? []).filter(x => x !== w))

  // ── YouTube URL list helpers ──────────────────────────────────────
  const extractYtId = (input) => {
    const trimmed = input.trim()
    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed
    try {
      const url = new URL(trimmed.startsWith('http') ? trimmed : 'https://' + trimmed)
      if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('?')[0]
      const v = url.searchParams.get('v')
      if (v) return v
      const parts = url.pathname.split('/')
      const idx = parts.findIndex(p => ['shorts', 'embed', 'v'].includes(p))
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1].split('?')[0]
    } catch (_) {}
    return null
  }

  const addYtUrl = async () => {
    setYtUrlError(null)
    const raw = newYtUrl.trim()
    if (!raw) return
    const id = extractYtId(raw)
    if (!id) { setYtUrlError('Could not parse a YouTube video ID from that URL.'); return }
    const cur = settings.movieTimeYoutubeUrls ?? []
    if (cur.find(v => v.id === id)) { setYtUrlError('This video is already in the list.'); return }
    let title = raw
    try {
      const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`)
      if (res.ok) {
        const data = await res.json()
        title = data.title ?? raw
      }
    } catch (_) {}
    updateSetting('movieTimeYoutubeUrls', [...cur, { id, title, thumb: `https://img.youtube.com/vi/${id}/hqdefault.jpg` }])
    if (settings.movieTimeSelectedYoutubeVideoIds) {
      updateSetting('movieTimeSelectedYoutubeVideoIds', [...settings.movieTimeSelectedYoutubeVideoIds, id])
    }
    setNewYtUrl('')
  }
  const removeYtUrl = (id) => {
    updateSetting('movieTimeYoutubeUrls', (settings.movieTimeYoutubeUrls ?? []).filter(v => v.id !== id))
    if (settings.movieTimeSelectedYoutubeVideoIds) {
      updateSetting('movieTimeSelectedYoutubeVideoIds', settings.movieTimeSelectedYoutubeVideoIds.filter(x => x !== id))
    }
  }

  const selectAllCurated = () => {
    const ids = (settings.movieTimeYoutubeUrls ?? []).map(v => v.id)
    updateSetting('movieTimeSelectedYoutubeVideoIds', ids)
  }

  const clearAllCurated = () => {
    updateSetting('movieTimeSelectedYoutubeVideoIds', [])
  }

  const toggleCuratedVideo = (id) => {
    const urls = settings.movieTimeYoutubeUrls ?? []
    const currentSelected = settings.movieTimeSelectedYoutubeVideoIds ?? urls.map(x => x.id)
    let nextSelected
    if (currentSelected.includes(id)) {
      nextSelected = currentSelected.filter(x => x !== id)
    } else {
      nextSelected = [...currentSelected, id]
    }
    updateSetting('movieTimeSelectedYoutubeVideoIds', nextSelected)
  }

  // ── Tab bar styles ───────────────────────────────────────────
  const tabStyle = (id) => ({
    flex: 1,
    padding: '8px 4px',
    background: activeTab === id ? 'hsl(215 60% 20%)' : 'rgba(255,255,255,0.04)',
    border: `1.5px solid ${activeTab === id ? 'hsl(215 80% 55% / 0.7)' : 'rgba(255,255,255,0.1)'}`,
    borderRadius: '8px',
    color: activeTab === id ? 'hsl(215 90% 80%)' : 'var(--color-text-secondary)',
    fontSize: '0.82rem',
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'all 0.15s',
  })

  return (
    <div className="sm-panel__sections">

      {/* ── Tab bar ── */}
      <div style={{ display: 'flex', gap: '6px', margin: '4px 0 4px' }}>
        <button id="mt-tab-playback" style={tabStyle('playback')} onClick={() => setActiveTab('playback')}>⏯️ Playback</button>
        <button id="mt-tab-content"  style={tabStyle('content')}  onClick={() => setActiveTab('content')}>🎬 Content</button>
        <button id="mt-tab-puzzle"   style={tabStyle('puzzle')}   onClick={() => setActiveTab('puzzle')}>🧩 Puzzle</button>
        <button id="mt-tab-apikey"   style={tabStyle('apikey')}   onClick={() => setActiveTab('apikey')}>🔑 API Key</button>
        <button id="mt-tab-providers" style={tabStyle('providers')} onClick={() => setActiveTab('providers')}>🌐 Providers</button>
      </div>

      {/* TAB 1 – PLAYBACK */}
      {activeTab === 'playback' && (<>

        <SectionLabel>Playback Settings</SectionLabel>

        <Row
          name="Video Selection Gate"
          hint="Eye gaze must dwell on any video card for this long before videos become selectable. Set to 0 to allow instant selection. A progress bar appears while the gate is filling."
        >
          <GranularSlider
            id="slider-mt-selection-gate"
            min={0}
            max={30000}
            step={500}
            value={settings.movieTimeSelectionGateMs ?? 0}
            onChange={val => updateSetting('movieTimeSelectionGateMs', val)}
            unit="ms"
            presets={[
              { value: 0, label: 'Instant' },
              { value: 1000, label: '1 s' },
              { value: 3000, label: '3 s' },
              { value: 5000, label: '5 s' },
              { value: 10000, label: '10 s' },
              { value: 30000, label: '30 s' },
            ]}
          />
        </Row>

        <Row name="Gaze-Away Pause Threshold" hint="Video pauses after the user looks away for this long">
          <GranularSlider
            id="slider-mt-gaze-away"
            min={0}
            max={60000}
            step={500}
            value={settings.movieTimeGazeAwayMs ?? 3000}
            onChange={val => updateSetting('movieTimeGazeAwayMs', val)}
            unit="ms"
            presets={[
              { value: 500, label: '0.5 s' },
              { value: 3000, label: '3 s (Std)' },
              { value: 5000, label: '5 s' },
              { value: 10000, label: '10 s' },
              { value: 30000, label: '30 s' },
              { value: 60000, label: '60 s' },
              { value: 0, label: 'Unlimited' },
            ]}
          />
        </Row>

        <Row
          name="Show Eye Gaze Cursor"
          hint="When on, the eye gaze cursor (blue dot) is always visible during Movie Time. When off, the cursor is hidden while the movie is actively playing."
        >
          <Toggle
            id="toggle-mt-show-gaze-cursor"
            checked={settings.movieTimeShowGazeCursor ?? true}
            onChange={e => updateSetting('movieTimeShowGazeCursor', e.target.checked)}
          />
        </Row>

        <Row
          name="Pause when Gaze is Lost"
          hint="Automatically pauses the video if the eyes are closed or if the eye tracker completely loses tracking of the user."
        >
          <Toggle
            id="toggle-mt-pause-on-gaze-lost"
            checked={settings.movieTimePauseOnGazeLost ?? true}
            onChange={e => updateSetting('movieTimePauseOnGazeLost', e.target.checked)}
          />
        </Row>

        <Row name="Max Daily Watch Time" hint="Soft cap on how long the user can use Movie Time per day">
          <GranularSlider
            id="slider-mt-daily"
            min={10}
            max={720}
            step={5}
            value={settings.movieTimeMaxDailyMinutes ?? 60}
            onChange={val => updateSetting('movieTimeMaxDailyMinutes', val)}
            unit="min"
            presets={[
              { value: 15, label: '15m' },
              { value: 30, label: '30m' },
              { value: 60, label: '1h' },
              { value: 120, label: '2h' },
              { value: 720, label: 'Unlimited' },
            ]}
          />
        </Row>

        <SectionLabel style={{ marginTop: '20px' }}>Troubleshooting</SectionLabel>
        <Row
          name="Reset Movie Time Cache"
          hint="If Netflix, Disney+, or YouTube videos fail to play (e.g. showing E100 or DRM errors), clearing the cache will reset local storage. This will require logging back into Netflix and Disney+."
        >
          <button
            id="btn-clear-movietime-cache"
            className="sm-btn sm-btn--danger sm-btn--xs"
            onClick={async () => {
              if (window.confirm("Are you sure you want to clear the Movie Time cache? You will be logged out of Netflix and Disney+.")) {
                try {
                  const res = await window.gazeAPI.clearMovieTimeCache()
                  if (res && res.ok) {
                    alert("Movie Time cache cleared successfully! Please restart GazeAAC for the changes to take full effect.")
                  } else {
                    alert(`Failed to clear cache: ${res?.error || 'Unknown error'}`)
                  }
                } catch (err) {
                  alert(`Error: ${err.message}`)
                }
              }
            }}
          >
            Clear Cache
          </button>
        </Row>

      </>)}

      {/* TAB 2 – CONTENT */}
      {activeTab === 'content' && (<>

        <SectionLabel>Content Filter</SectionLabel>

        <Row name="Number of Videos to Show" hint="How many video choices appear on the movie selection screen (2–9)">
          <GranularSlider
            id="slider-mt-video-count"
            min={2}
            max={9}
            step={1}
            value={settings.movieTimeSelectionCount ?? 4}
            onChange={val => updateSetting('movieTimeSelectionCount', val)}
            presets={[
              { value: 2, label: '2' },
              { value: 4, label: '4' },
              { value: 6, label: '6' },
              { value: 8, label: '8' },
              { value: 9, label: '9' },
            ]}
          />
        </Row>

        <SectionLabel sub>SafeSearch Level</SectionLabel>
        <div className="sm-cards sm-cards--3" role="radiogroup" aria-label="SafeSearch level">
          {MT_SAFE_SEARCHES.map(s => (
            <button key={s.id} role="radio"
              aria-checked={(settings.movieTimeSafeSearch ?? 'strict') === s.id}
              className={`sm-card sm-card--sm sm-card--amber ${
                (settings.movieTimeSafeSearch ?? 'strict') === s.id ? 'sm-card--active' : ''
              }`}
              onClick={() => updateSetting('movieTimeSafeSearch', s.id)}>
              <span className="sm-card__name">{s.label}</span>
              <span className="sm-card__desc">{s.desc}</span>
              <span className="sm-card__dot" aria-hidden="true" />
            </button>
          ))}
        </div>

        <SectionLabel sub>Minimum Views</SectionLabel>
        <p className="sm-hint-text">Only show videos that have at least this many views. Higher thresholds favour well-known mainstream content and reduce the chance of obscure or fan-made videos appearing.</p>
        <div className="sm-cards sm-cards--5" role="radiogroup" aria-label="Minimum view count">
          {MT_MIN_VIEWS.map(v => (
            <button key={v.id} role="radio"
              id={`mt-minviews-${v.id}`}
              aria-checked={(settings.movieTimeMinViews ?? 0) === v.id}
              className={`sm-card sm-card--sm sm-card--purple ${
                (settings.movieTimeMinViews ?? 0) === v.id ? 'sm-card--active' : ''
              }`}
              onClick={() => updateSetting('movieTimeMinViews', v.id)}>
              <span className="sm-card__name">{v.label}</span>
              <span className="sm-card__desc">{v.desc}</span>
              <span className="sm-card__dot" aria-hidden="true" />
            </button>
          ))}
        </div>
        {(settings.movieTimeMinViews ?? 0) >= 5_000_000 && (
          <p className="sm-hint-text sm-hint-text--warn">⚠ Very few videos reach {(settings.movieTimeMinViews ?? 0) >= 10_000_000 ? '10M' : '5M'}+ views. Results may be limited — consider lowering the threshold if no videos appear.</p>
        )}

        <SectionLabel sub>Language Preference</SectionLabel>
        <p className="sm-hint-text">
          Prefer videos in this language. Uses the YouTube <strong>relevanceLanguage</strong> hint —
          results are boosted (not strictly filtered) toward this language. Leave blank for any language.
        </p>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <select
            id="select-mt-language"
            className="sm-select"
            style={{ flex: 1 }}
            value={settings.movieTimeLanguage ?? ''}
            onChange={e => updateSetting('movieTimeLanguage', e.target.value)}
          >
            <option value="">🌐 Any language</option>
            <option value="en">🇬🇧 English</option>
            <option value="zh-Hans">🇨🇳 Chinese (Simplified)</option>
            <option value="zh-Hant">🇹🇼 Chinese (Traditional)</option>
            <option value="fr">🇫🇷 French</option>
            <option value="de">🇩🇪 German</option>
            <option value="hi">🇮🇳 Hindi</option>
            <option value="id">🇮🇩 Indonesian</option>
            <option value="it">🇮🇹 Italian</option>
            <option value="ja">🇯🇵 Japanese</option>
            <option value="ko">🇰🇷 Korean</option>
            <option value="ms">🇲🇾 Malay</option>
            <option value="nl">🇳🇱 Dutch</option>
            <option value="pt">🇧🇷 Portuguese</option>
            <option value="ru">🇷🇺 Russian</option>
            <option value="es">🇪🇸 Spanish</option>
            <option value="th">🇹🇭 Thai</option>
            <option value="tr">🇹🇷 Turkish</option>
            <option value="vi">🇻🇳 Vietnamese</option>
          </select>
        </div>

        <SectionLabel sub>Video Duration</SectionLabel>
        <div className="sm-cards sm-cards--4" role="radiogroup" aria-label="Video duration">
          {MT_DURATIONS.map(d => (
            <button key={d.id} role="radio"
              aria-checked={(settings.movieTimeDuration ?? 'medium') === d.id}
              className={`sm-card sm-card--sm sm-card--amber ${
                (settings.movieTimeDuration ?? 'medium') === d.id ? 'sm-card--active' : ''
              }`}
              onClick={() => updateSetting('movieTimeDuration', d.id)}>
              <span className="sm-card__name">{d.label}</span>
              <span className="sm-card__desc">{d.desc}</span>
              <span className="sm-card__dot" aria-hidden="true" />
            </button>
          ))}
        </div>

        <SectionLabel sub>Minimum Video Quality</SectionLabel>
        <p className="sm-hint-text">Prefer videos at this resolution or higher. Higher quality may reduce available results.</p>
        <div className="sm-cards sm-cards--4" role="radiogroup" aria-label="Minimum video quality">
          {MT_VIDEO_QUALITIES.map(q => (
            <button key={q.id} role="radio"
              id={`mt-quality-${q.id}`}
              aria-checked={(settings.movieTimeVideoQuality ?? 'any') === q.id}
              className={`sm-card sm-card--sm sm-card--teal ${
                (settings.movieTimeVideoQuality ?? 'any') === q.id ? 'sm-card--active' : ''
              }`}
              onClick={() => updateSetting('movieTimeVideoQuality', q.id)}>
              <span className="sm-card__name">{q.icon} {q.label}</span>
              <span className="sm-card__desc">{q.desc}</span>
              <span className="sm-card__dot" aria-hidden="true" />
            </button>
          ))}
        </div>
        {(settings.movieTimeVideoQuality === '4k') && (
          <p className="sm-hint-text sm-hint-text--warn">⚠ 4K results are rare on YouTube. Consider using &ldquo;1080p+&rdquo; for better variety.</p>
        )}

        <SectionLabel sub>Content Topics</SectionLabel>
        <p className="sm-hint-text">These broad topics help shape search results (AND — all selected must be present).</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '4px 0' }}>
          {MT_TOPICS.map(t => {
            const active = (settings.movieTimeTopics ?? []).includes(t)
            return (
              <button
                key={t}
                onClick={() => toggleTopic(t)}
                style={{
                  padding: '4px 12px', borderRadius: '999px',
                  border: `1.5px solid ${active ? 'hsl(195 80% 55% / 0.7)' : 'rgba(255,255,255,0.12)'}`,
                  background: active ? 'hsl(195 60% 16% / 0.8)' : 'rgba(255,255,255,0.04)',
                  color: active ? 'hsl(195 90% 72%)' : 'var(--color-text-secondary)',
                  fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s',
                }}
              >{t}</button>
            )
          })}
        </div>

        <SectionLabel sub>Interests (OR Search)</SectionLabel>
        <p className="sm-hint-text">
          Search results must include <strong>at least one</strong> of these topics —
          think of them as &ldquo;I&rsquo;m happy with <em>any</em> of these&rdquo;. Leave empty to skip.
        </p>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
          <input
            id="input-mt-interest"
            className="sm-select"
            style={{ flex: 1 }}
            value={newInterest}
            onChange={e => setNewInterest(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addInterest()}
            placeholder="Add interest (e.g. dinosaurs)…"
          />
          <button className="sm-btn sm-btn--accent" onClick={addInterest}>Add</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
          {(settings.movieTimeInterests ?? []).map(w => (
            <span key={w} style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              padding: '3px 10px', borderRadius: '999px',
              background: 'hsl(35 55% 14%)', border: '1px solid hsl(35 65% 45% / 0.45)',
              color: 'hsl(35 85% 72%)', fontSize: '0.76rem', fontWeight: 700,
            }}>
              {w}
              <button onClick={() => removeInterest(w)} style={{
                background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '0.8rem', lineHeight: 1, opacity: 0.7,
              }}>✕</button>
            </span>
          ))}
        </div>

        <SectionLabel sub>Whitelist Keywords</SectionLabel>
        <p className="sm-hint-text">These words are added to every YouTube search.</p>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
          <input
            id="input-mt-whitelist"
            className="sm-select"
            style={{ flex: 1 }}
            value={newWhitelist}
            onChange={e => setNewWhitelist(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addWhitelist()}
            placeholder="Add keyword…"
          />
          <button className="sm-btn sm-btn--accent" onClick={addWhitelist}>Add</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
          {(settings.movieTimeWhitelist ?? []).map(w => (
            <span key={w} style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              padding: '3px 10px', borderRadius: '999px',
              background: 'hsl(145 50% 14%)', border: '1px solid hsl(145 60% 40% / 0.4)',
              color: 'hsl(145 75% 65%)', fontSize: '0.76rem', fontWeight: 700,
            }}>
              {w}
              <button onClick={() => removeWhitelist(w)} style={{
                background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '0.8rem', lineHeight: 1, opacity: 0.7,
              }}>✕</button>
            </span>
          ))}
        </div>

        <SectionLabel sub>Blacklist Keywords</SectionLabel>
        <p className="sm-hint-text">Videos containing these words are excluded from results.</p>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
          <input
            id="input-mt-blacklist"
            className="sm-select"
            style={{ flex: 1 }}
            value={newBlacklist}
            onChange={e => setNewBlacklist(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addBlacklist()}
            placeholder="Block keyword…"
          />
          <button className="sm-btn sm-btn--accent" onClick={addBlacklist}>Add</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
          {(settings.movieTimeBlacklist ?? []).map(w => (
            <span key={w} style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              padding: '3px 10px', borderRadius: '999px',
              background: 'hsl(0 50% 14%)', border: '1px solid hsl(0 60% 40% / 0.4)',
              color: 'hsl(0 70% 65%)', fontSize: '0.76rem', fontWeight: 700,
            }}>
              {w}
              <button onClick={() => removeBlacklist(w)} style={{
                background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '0.8rem', lineHeight: 1, opacity: 0.7,
              }}>✕</button>
            </span>
          ))}
        </div>

        <SectionLabel sub>Fan Content</SectionLabel>
        <Row
          name="Gamer Loophole"
          hint="Include high-quality fan creations, let's-plays, and reaction videos. Expands content variety beyond official channels."
        >
          <Toggle
            id="toggle-mt-gamer"
            checked={settings.movieTimeGamerLoophole ?? false}
            onChange={e => updateSetting('movieTimeGamerLoophole', e.target.checked)}
          />
        </Row>
        {(settings.movieTimeGamerLoophole ?? false) && (
          <p className="sm-hint-text sm-hint-text--warn">
            Fan content enabled. Review results — quality varies. SafeSearch still applies.
          </p>
        )}

        <SectionLabel sub>Curated Video List</SectionLabel>
        <p className="sm-hint-text">
          Add specific YouTube videos that will always be available for the user to pick.
          Paste a YouTube URL or video ID and click <strong>Add</strong>.
        </p>

        <Row
          name="Show Only Videos From This List"
          hint="When enabled, the browse grid shows only videos in your curated list — no YouTube search is performed."
        >
          <Toggle
            id="toggle-mt-only-from-list"
            checked={settings.movieTimeOnlyFromList ?? false}
            onChange={e => updateSetting('movieTimeOnlyFromList', e.target.checked)}
          />
        </Row>
        {(settings.movieTimeOnlyFromList ?? false) && (settings.movieTimeYoutubeUrls ?? []).length === 0 && (
          <p className="sm-hint-text sm-hint-text--warn">⚠ List is empty — add at least one video below, otherwise the browse screen will show nothing.</p>
        )}
        {(() => {
          const urls = settings.movieTimeYoutubeUrls ?? []
          const selectedVideoIds = settings.movieTimeSelectedYoutubeVideoIds ?? urls.map(v => v.id)
          if ((settings.movieTimeOnlyFromList ?? false) && urls.length > 0 && selectedVideoIds.length === 0) {
            return (
              <p className="sm-hint-text sm-hint-text--warn" style={{ marginTop: '4px', marginBottom: '8px' }}>
                ⚠ No videos selected — check at least one video below, otherwise the browse screen will show nothing.
              </p>
            )
          }
          return null
        })()}

        <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
          <input
            id="input-mt-yt-url"
            className="sm-select"
            style={{ flex: 1 }}
            value={newYtUrl}
            onChange={e => { setNewYtUrl(e.target.value); setYtUrlError(null) }}
            onKeyDown={e => e.key === 'Enter' && addYtUrl()}
            placeholder="https://www.youtube.com/watch?v=… or video ID"
          />
          <button className="sm-btn sm-btn--accent" onClick={addYtUrl}>Add</button>
        </div>
        {ytUrlError && <p className="sm-hint-text" style={{ color: 'hsl(0 70% 65%)', marginBottom: '6px' }}>❌ {ytUrlError}</p>}

        {(() => {
          const urls = settings.movieTimeYoutubeUrls ?? []
          const selectedVideoIds = settings.movieTimeSelectedYoutubeVideoIds ?? urls.map(v => v.id)
          if (urls.length === 0) {
            return <p className="sm-hint-text" style={{ fontStyle: 'italic' }}>No videos added yet.</p>
          }
          return (
            <>
              <div className="sm-curated-actions">
                <button className="sm-curated-actions__btn" onClick={selectAllCurated}>Select All</button>
                <button className="sm-curated-actions__btn" onClick={clearAllCurated}>Clear All</button>
                <span className="sm-hint-text" style={{ fontSize: '0.72rem', marginLeft: 'auto', opacity: 0.8 }}>
                  {selectedVideoIds.length} of {urls.length} active
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {urls.map(v => {
                  const isChecked = selectedVideoIds.includes(v.id)
                  return (
                    <div key={v.id} style={{
                      display: 'flex', alignItems: 'center', gap: '10px',
                      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
                      borderRadius: '8px', padding: '6px 10px',
                    }}>
                      <label className="sm-checkbox" aria-label={`Select ${v.title}`}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleCuratedVideo(v.id)}
                        />
                        <span className="sm-checkbox__box" />
                      </label>
                      <img
                        src={(v.thumb ?? `https://img.youtube.com/vi/${v.id}/hqdefault.jpg`).replace('mqdefault.jpg', 'hqdefault.jpg')}
                        alt=""
                        style={{ width: 64, height: 36, borderRadius: '4px', objectFit: 'cover', flexShrink: 0 }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '0.78rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.title}</div>
                        <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>{v.id}</div>
                      </div>
                      <button
                        onClick={() => removeYtUrl(v.id)}
                        style={{ background: 'none', border: 'none', color: 'hsl(0 70% 65%)', cursor: 'pointer', fontSize: '1rem', flexShrink: 0 }}
                        title="Remove"
                      >🗑</button>
                    </div>
                  )
                })}
              </div>
            </>
          )
        })()}

      </>)}

      {/* TAB 3 – PUZZLE */}
      {activeTab === 'puzzle' && (<>

        <SectionLabel>Puzzles &amp; Games</SectionLabel>
        <p className="sm-hint-text">
          {(() => {
            const s = settings.movieTimePuzzleIntervalSec ?? 600
            if (s === 0) return 'Puzzles disabled (interval set to Unlimited).'
            if (s < 60) return `Every ${s} seconds, the video pauses for a short challenge.`
            const m = s / 60
            return `Every ${m} minute${m !== 1 ? 's' : ''}, the video pauses for a short challenge.`
          })()}
          {' '}Requires a Gemini API key (set in Contextual Response settings).
        </p>

        <Row name="Puzzle Interval" hint="How often to pause the video for a learning challenge">
          {(() => {
            const MT_PUZZLE_INTERVALS = [
              1, 5, 10, 30,
              60, 120, 300, 600, 900, 1200, 1800, 2700, 3600,
              0
            ]
            const storedSec = settings.movieTimePuzzleIntervalSec ?? 600
            return (
              <GranularSlider
                id="slider-mt-puzzle-interval"
                className="sm-slider sm-slider--violet"
                value={storedSec}
                onChange={val => updateSetting('movieTimePuzzleIntervalSec', val)}
                valueArray={MT_PUZZLE_INTERVALS}
                unit="sec"
                presets={[
                  { value: 30, label: '30 s' },
                  { value: 60, label: '1 m' },
                  { value: 300, label: '5 m' },
                  { value: 600, label: '10 m' },
                  { value: 0, label: 'Unlimited' },
                ]}
              />
            )
          })()}
        </Row>

        <SectionLabel sub>Puzzle Types</SectionLabel>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '4px 0' }}>
          {MT_PUZZLE_TYPES.map(t => {
            const active = (settings.movieTimePuzzleTypes ?? []).includes(t)
            return (
              <button
                key={t}
                onClick={() => togglePuzzleType(t)}
                style={{
                  padding: '5px 14px', borderRadius: '999px',
                  border: `1.5px solid ${active ? 'hsl(280 70% 60% / 0.7)' : 'rgba(255,255,255,0.12)'}`,
                  background: active ? 'hsl(280 40% 16% / 0.8)' : 'rgba(255,255,255,0.04)',
                  color: active ? 'hsl(280 85% 78%)' : 'var(--color-text-secondary)',
                  fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s',
                }}
              >{t}</button>
            )
          })}
        </div>

        <SectionLabel sub>Difficulty Level</SectionLabel>
        <div className="sm-cards sm-cards--3" role="radiogroup" aria-label="Puzzle difficulty">
          {MT_DIFFICULTIES.map(d => (
            <button key={d} role="radio"
              aria-checked={(settings.movieTimePuzzleDifficulty ?? 'Easy') === d}
              className={`sm-card sm-card--sm sm-card--violet ${
                (settings.movieTimePuzzleDifficulty ?? 'Easy') === d ? 'sm-card--active' : ''
              }`}
              onClick={() => updateSetting('movieTimePuzzleDifficulty', d)}>
              <span className="sm-card__name">{d}</span>
              <span className="sm-card__dot" aria-hidden="true" />
            </button>
          ))}
        </div>

        <Row name="Answer Choices" hint="Number of answer options shown per puzzle">
          <GranularSlider
            id="slider-mt-choices"
            className="sm-slider sm-slider--violet"
            min={2}
            max={4}
            step={1}
            value={settings.movieTimePuzzleChoices ?? 4}
            onChange={val => updateSetting('movieTimePuzzleChoices', val)}
            presets={[
              { value: 2, label: '2' },
              { value: 3, label: '3' },
              { value: 4, label: '4' },
            ]}
          />
        </Row>

        <Row name="Questions per Quiz" hint="How many questions are asked each time the quiz fires (1–10). The video resumes after all questions are answered.">
          <GranularSlider
            id="slider-mt-questions-per-quiz"
            className="sm-slider sm-slider--violet"
            min={1}
            max={10}
            step={1}
            value={settings.movieTimePuzzleQuestionsPerQuiz ?? 3}
            onChange={val => updateSetting('movieTimePuzzleQuestionsPerQuiz', val)}
            presets={[
              { value: 1, label: '1' },
              { value: 2, label: '2' },
              { value: 3, label: '3' },
              { value: 5, label: '5' },
              { value: 10, label: '10' },
            ]}
          />
        </Row>

        <Row
          name="Wrong Answers Before Hint"
          hint="After this many wrong attempts, a 💡 hint glow appears on the correct answer. Set to 0 to disable hints."
        >
          <GranularSlider
            id="slider-mt-hint-after-wrong"
            className="sm-slider sm-slider--violet"
            min={0}
            max={9}
            step={1}
            value={settings.movieTimePuzzleHintAfterWrong ?? 3}
            onChange={val => updateSetting('movieTimePuzzleHintAfterWrong', val)}
            presets={[
              { value: 0, label: 'Disabled' },
              { value: 1, label: 'Immediate' },
              { value: 3, label: '3 (Std)' },
              { value: 5, label: '5' },
            ]}
          />
        </Row>


        {/* ── Quiz Settings ── */}
        <SectionLabel>Quiz Settings</SectionLabel>
        <p className="sm-hint-text">
          Controls how questions are presented: read-time gates, voice-over, educational level, and subject focus.
        </p>

        {/* Educational Level */}
        <SectionLabel sub>Educational Level</SectionLabel>
        {(() => {
          const levels = [
            { id: 'Pre-K',     label: 'Pre-K',     desc: 'Ages 3–5' },
            { id: 'Primary',   label: 'Primary',   desc: 'Ages 6–11' },
            { id: 'Secondary', label: 'Secondary', desc: 'Ages 12–17' },
            { id: 'Adult',     label: 'Adult',     desc: 'Age 18+' },
          ]
          const cur = settings.movieTimeQuizEducationLevel ?? 'Primary'
          return (
            <div className="sm-cards sm-cards--4" role="radiogroup" aria-label="Educational level">
              {levels.map(l => (
                <button key={l.id} role="radio"
                  aria-checked={cur === l.id}
                  className={`sm-card sm-card--sm sm-card--violet ${cur === l.id ? 'sm-card--active' : ''}`}
                  onClick={() => updateSetting('movieTimeQuizEducationLevel', l.id)}>
                  <span className="sm-card__name">{l.label}</span>
                  <span className="sm-card__desc">{l.desc}</span>
                  <span className="sm-card__dot" aria-hidden="true" />
                </button>
              ))}
            </div>
          )
        })()}

        {/* Subject */}
        <SectionLabel sub>Subject Focus</SectionLabel>
        <p className="sm-hint-text">Select one or more subjects to focus questions on. Leave none selected to follow the video topic. Custom subject can be combined with the selections below.</p>
        {(() => {
          const subjects = ['General', 'Math', 'Science', 'English', 'History', 'Geography', 'Art', 'Music', 'Animals', 'Nature', 'Disney', 'Kids Shows']
          const selected = settings.movieTimeQuizSubjects ?? []
          const customVal = settings.movieTimeQuizSubjectCustom ?? ''
          const toggleSubject = (s) => {
            const cur = settings.movieTimeQuizSubjects ?? []
            if (cur.includes(s)) {
              updateSetting('movieTimeQuizSubjects', cur.filter(x => x !== s))
            } else {
              updateSetting('movieTimeQuizSubjects', [...cur, s])
            }
          }
          return (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '4px 0' }}>
                {subjects.map(s => {
                  const active = selected.includes(s)
                  return (
                    <button
                      key={s}
                      onClick={() => toggleSubject(s)}
                      style={{
                        padding: '5px 14px', borderRadius: '999px',
                        border: `1.5px solid ${active ? 'hsl(280 70% 60% / 0.7)' : 'rgba(255,255,255,0.12)'}`,
                        background: active ? 'hsl(280 40% 16% / 0.8)' : 'rgba(255,255,255,0.04)',
                        color: active ? 'hsl(280 85% 78%)' : 'var(--color-text-secondary)',
                        fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s',
                      }}
                    >{s}</button>
                  )
                })}
              </div>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px' }}>
                <input
                  id="input-mt-quiz-subject-custom"
                  className="sm-select"
                  style={{ flex: 1 }}
                  value={customVal}
                  onChange={e => updateSetting('movieTimeQuizSubjectCustom', e.target.value)}
                  placeholder="Custom subject (e.g. Dinosaurs, Fractions, Planets)…"
                />
                {customVal && (
                  <button
                    className="sm-btn sm-btn--outline sm-btn--xs"
                    onClick={() => updateSetting('movieTimeQuizSubjectCustom', '')}
                    title="Clear custom subject"
                  >✕</button>
                )}
              </div>
              {(selected.length > 0 || customVal) && (
                <p className="sm-hint-text" style={{ color: 'hsl(280 85% 75%)' }}>
                  ✦ Active: <strong>{[...selected, ...(customVal ? [customVal] : [])].join(', ')}</strong>
                </p>
              )}
            </>
          )
        })()}

        {/* Start Quiz Before Video Plays */}
        <Row
          name="Start Quiz Before Video Plays"
          hint="When enabled, a quiz is required before the selected video begins playing."
        >
          <Toggle
            id="toggle-mt-quiz-require-prewatch"
            checked={settings.movieTimeQuizRequirePrewatch ?? true}
            onChange={e => updateSetting('movieTimeQuizRequirePrewatch', e.target.checked)}
          />
        </Row>

        {/* Video Specific Questions */}
        <Row
          name="Quiz on Video Content"
          hint="When enabled, questions use all video data (transcript, metadata, title, channel info). Before the video starts, questions cover the general topic. During playback, questions focus on the portion already watched."
        >
          <Toggle
            id="toggle-mt-quiz-about-video"
            checked={settings.movieTimeQuizAboutVideo ?? false}
            onChange={e => updateSetting('movieTimeQuizAboutVideo', e.target.checked)}
          />
        </Row>

        {/* Voice Over */}
        <SectionLabel sub>Voice Over</SectionLabel>
        <Row
          name="Read Questions Aloud"
          hint="Uses the system voice to read each quiz question when it appears"
        >
          <Toggle
            id="toggle-mt-quiz-voiceover"
            checked={settings.movieTimeQuizVoiceOver ?? true}
            onChange={e => updateSetting('movieTimeQuizVoiceOver', e.target.checked)}
          />
        </Row>
        {(settings.movieTimeQuizVoiceOver ?? true) && (<>
          <Row
            name="Read Answer Choices Aloud"
            hint="After reading the question, each answer choice is also spoken"
          >
            <Toggle
              id="toggle-mt-quiz-voiceover-choices"
              checked={settings.movieTimeQuizVoiceOverChoices ?? true}
              onChange={e => updateSetting('movieTimeQuizVoiceOverChoices', e.target.checked)}
            />
          </Row>
          <Row
            name="Voice Over Pause"
            hint="Delay between reading the question and answer choices, and between each choice"
          >
            {(() => {
              const PAUSE_VALUES = [
                0, 100, 200, 300, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000
              ]
              const cur = settings.movieTimeQuizVoiceOverPauseMs ?? 500
              return (
                <GranularSlider
                  id="slider-mt-voiceover-pause"
                  className="sm-slider sm-slider--violet"
                  value={cur}
                  onChange={val => updateSetting('movieTimeQuizVoiceOverPauseMs', val)}
                  valueArray={PAUSE_VALUES}
                  unit="ms"
                  presets={[
                    { value: 0, label: 'No Pause' },
                    { value: 500, label: '0.5 s (Std)' },
                    { value: 1000, label: '1 s' },
                    { value: 2000, label: '2 s' },
                    { value: 3000, label: '3 s' },
                  ]}
                />
              )
            })()}
          </Row>
        </>)}

        {/* Question Gate */}
        <SectionLabel sub>Question Gate</SectionLabel>
        <p className="sm-hint-text">
          The question box is shown first; the progress bar only fills while the user's eye gaze is on the question. Answer choices appear once this timer completes. Set to 0 for instant display.
        </p>
        {(() => {
          const GATE_VALUES = [
            'click', 0, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000,
            6000, 8000, 10000, 12000, 15000, 18000, 20000, 25000, 30000
          ]
          const cur = settings.movieTimeQuizQuestionGateMs ?? 2000
          return (
            <Row name="Question Read Time">
              <GranularSlider
                id="slider-mt-question-gate"
                className="sm-slider sm-slider--violet"
                value={cur}
                onChange={val => updateSetting('movieTimeQuizQuestionGateMs', val)}
                valueArray={GATE_VALUES}
                unit="ms"
                presets={[
                  { value: 'click', label: 'On Click' },
                  { value: 0, label: 'Instant' },
                  { value: 1000, label: '1 s' },
                  { value: 2000, label: '2 s' },
                  { value: 5000, label: '5 s' },
                  { value: 10000, label: '10 s' },
                ]}
              />
            </Row>
          )
        })()}

        {/* Answer Gate */}
        <SectionLabel sub>Answer Gate</SectionLabel>
        <p className="sm-hint-text">
          After choices appear, the progress ring on each choice only fills while the user's eye gaze is on the answers. Gaze-selection is unlocked once this timer completes. Set to 0 for instant unlock.
        </p>
        {(() => {
          const GATE_VALUES = [
            0, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000,
            6000, 8000, 10000, 12000, 15000, 18000, 20000, 25000, 30000
          ]
          const cur = settings.movieTimeQuizAnswerGateMs ?? 1500
          return (
            <Row name="Answer Read Time">
              <GranularSlider
                id="slider-mt-answer-gate"
                className="sm-slider sm-slider--violet"
                value={cur}
                onChange={val => updateSetting('movieTimeQuizAnswerGateMs', val)}
                valueArray={GATE_VALUES}
                unit="ms"
                presets={[
                  { value: 0, label: 'Instant' },
                  { value: 1000, label: '1 s' },
                  { value: 1500, label: '1.5 s (Std)' },
                  { value: 3000, label: '3 s' },
                  { value: 5000, label: '5 s' },
                ]}
              />
            </Row>
          )
        })()}

        {/* Sound Effects */}
        <SectionLabel sub>Sound Effects</SectionLabel>
        <Row
          name="Answer Sound Effects"
          hint="Plays a rising arpeggio for correct answers and a descending tone for wrong ones"
        >
          <Toggle
            id="toggle-mt-quiz-sounds"
            checked={settings.movieTimeQuizSoundEffects ?? true}
            onChange={e => updateSetting('movieTimeQuizSoundEffects', e.target.checked)}
          />
        </Row>

      </>)}

      {/* TAB 4 – API KEY */}
      {activeTab === 'apikey' && (<>

        <SectionLabel>YouTube API Keys</SectionLabel>
        <p className="sm-hint-text">
          Add one or more <strong>YouTube Data API v3</strong> keys. When a key hits its daily quota,
          the app automatically tries the next one. Get free keys at{' '}
          <strong>console.cloud.google.com</strong> → APIs &amp; Services → YouTube Data API v3.
        </p>

        {/* Existing key list */}
        {ytKeys.length === 0 ? (
          <p className="sm-hint-text" style={{ fontStyle: 'italic', marginBottom: 8 }}>No API keys added yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
            {ytKeys.map((entry, idx) => {
              const status = keyStatuses[idx]
              const visible = keyVisibility[idx]
              const maskedKey = visible ? entry.key : entry.key.slice(0, 6) + '…' + entry.key.slice(-4)
              return (
                <div key={idx} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: 'rgba(255,255,255,0.04)',
                  border: `1.5px solid ${
                    status === 'ok'    ? 'hsl(145 60% 40% / 0.5)' :
                    status === 'quota' ? 'hsl(38 70% 45% / 0.5)'  :
                    status === 'error' ? 'hsl(0 60% 45% / 0.5)'   :
                    'rgba(255,255,255,0.09)'
                  }`,
                  borderRadius: 8, padding: '6px 8px',
                }}>
                  {/* Index badge */}
                  <span style={{
                    flexShrink: 0, width: 22, height: 22,
                    background: 'hsl(215 50% 18%)', border: '1px solid hsl(215 60% 40% / 0.5)',
                    borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.7rem', fontWeight: 800, color: 'hsl(215 90% 75%)',
                  }}>{idx + 1}</span>

                  {/* Label + masked key */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 1 }}>
                      {entry.label || `Key ${idx + 1}`}
                      {status === 'ok'    && <span style={{ marginLeft: 6, color: 'hsl(145 70% 60%)', fontSize: '0.72rem' }}>✅ Valid</span>}
                      {status === 'quota' && <span style={{ marginLeft: 6, color: 'hsl(38 90% 70%)', fontSize: '0.72rem' }}>⚠️ Quota exceeded</span>}
                      {status === 'error' && <span style={{ marginLeft: 6, color: 'hsl(0 70% 65%)', fontSize: '0.72rem' }}>❌ Invalid</span>}
                      {status === 'testing' && <span style={{ marginLeft: 6, color: 'var(--color-text-secondary)', fontSize: '0.72rem' }}>Testing…</span>}
                    </div>
                    <div style={{ fontSize: '0.69rem', fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {maskedKey}
                    </div>
                  </div>

                  {/* Show/hide */}
                  <button
                    className="sm-btn sm-btn--outline sm-btn--xs"
                    title={visible ? 'Hide key' : 'Show key'}
                    onClick={() => setKeyVisibility(v => ({ ...v, [idx]: !v[idx] }))}
                  >{visible ? '🙈' : '👁'}</button>

                  {/* Test */}
                  <button
                    className="sm-btn sm-btn--accent sm-btn--xs"
                    disabled={status === 'testing'}
                    onClick={() => testYtKey(idx)}
                  >{status === 'testing' ? '…' : 'Test'}</button>

                  {/* Remove */}
                  <button
                    className="sm-btn sm-btn--xs"
                    style={{ background: 'hsl(0 50% 18%)', border: '1px solid hsl(0 55% 40% / 0.5)', color: 'hsl(0 70% 65%)' }}
                    title="Remove key"
                    onClick={() => removeYtKey(idx)}
                  >🗑</button>
                </div>
              )
            })}
          </div>
        )}

        {/* Add new key row */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', background: 'rgba(255,255,255,0.03)', border: `1px dashed ${newKeyError ? 'hsl(0 70% 50% / 0.5)' : 'rgba(255,255,255,0.12)'}`, borderRadius: 8 }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: 2 }}>➕ Add New Key</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              id="input-yt-key-label"
              className="sm-select"
              style={{ width: 110, flexShrink: 0 }}
              value={newKeyLabel}
              onChange={e => setNewKeyLabel(e.target.value)}
              placeholder="Label (e.g. Key 2)"
            />
            <input
              id="input-yt-api-key"
              type="text"
              className="sm-select"
              style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '0.75rem', borderColor: newKeyError ? 'hsl(0 65% 55% / 0.7)' : undefined }}
              value={newKeyValue}
              onChange={e => {
                setNewKeyValue(e.target.value)
                if (newKeyError) setNewKeyError(_validateYtKey(e.target.value.trim()))
              }}
              onPaste={e => {
                const pasted = e.clipboardData.getData('text').trim()
                const err = _validateYtKey(pasted)
                if (err) setNewKeyError(err)
              }}
              onKeyDown={e => e.key === 'Enter' && addYtKey()}
              placeholder="AIzaSy… (paste your API key)"
            />
            <button className="sm-btn sm-btn--accent" onClick={addYtKey} disabled={!newKeyValue.trim()}>Add</button>
          </div>
          {newKeyError && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '6px 8px', background: 'hsl(0 55% 12%)', border: '1px solid hsl(0 60% 40% / 0.5)', borderRadius: 6, marginTop: 2 }}>
              <span style={{ flexShrink: 0 }}>❌</span>
              <span style={{ fontSize: '0.76rem', color: 'hsl(0 70% 70%)', lineHeight: 1.45 }}>{newKeyError}</span>
            </div>
          )}
          {!newKeyError && (
            <p style={{ fontSize: '0.71rem', color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.4 }}>
              In Google Cloud Console, go to <strong>APIs &amp; Services → Credentials</strong>, open your key, and copy the <strong>Key string</strong> (starts with AIza…).
            </p>
          )}
        </div>

      </>)}

      {/* TAB 5 – STREAMING PROVIDERS */}
      {activeTab === 'providers' && (<>
        <SectionLabel>Streaming Providers</SectionLabel>
        <p className="sm-hint-text">
          Toggle which streaming services are available inside Movie Time. You can log in directly inside each service's official website within GazeAAC.
        </p>

        <Row
          name="YouTube"
          hint="Allow viewing videos from YouTube. Daily API keys are configured separately under the API Key tab."
        >
          <Toggle
            id="toggle-mt-prov-youtube"
            checked={settings.movieTimeProviderYoutube ?? true}
            onChange={e => updateSetting('movieTimeProviderYoutube', e.target.checked)}
          />
        </Row>

        <Row
          name="Netflix"
          hint="Allow viewing videos from Netflix. Caregivers can log in with their Netflix account directly inside GazeAAC."
        >
          <Toggle
            id="toggle-mt-prov-netflix"
            checked={settings.movieTimeProviderNetflix ?? true}
            onChange={e => updateSetting('movieTimeProviderNetflix', e.target.checked)}
          />
        </Row>

        <Row
          name="Disney+"
          hint="Allow viewing videos from Disney+. Caregivers can log in with their Disney+ account directly inside GazeAAC."
        >
          <Toggle
            id="toggle-mt-prov-disney"
            checked={settings.movieTimeProviderDisney ?? true}
            onChange={e => updateSetting('movieTimeProviderDisney', e.target.checked)}
          />
        </Row>

        <div className="sm-hint-text sm-hint-text--info" style={{ marginTop: '16px', borderLeft: '3px solid hsl(215 80% 55%)', paddingLeft: '8px' }}>
          <strong>🔒 Security & Privacy Notice:</strong>
          <br />
          Your Netflix, Disney+, and YouTube credentials and session cookies are saved securely on this device by the local Electron framework. They are <strong>never</strong> transmitted to the cloud sync database or exposed over the internet.
        </div>
      </>)}

    </div>
  )
}

function QNAPanel({ settings, updateSetting, updateSettings }) {
  return (
    <div className="sm-panel__sections">
      <SectionLabel>Q&A Timing & Hints</SectionLabel>
      <p className="sm-hint-text">
        Configure gaze gating timers, correct answer hint highlighting, and audio feedback for Q&A gameplay.
      </p>

      {/* Question Gate */}
      <SectionLabel sub>Question Gate</SectionLabel>
      <p className="sm-hint-text">
        The question box is shown first; the progress bar only fills while the user's eye gaze is on the question. Answer choices appear once this timer completes. Set to 0 for instant display.
      </p>
      {(() => {
        const GATE_VALUES = [
          'click', 0, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000,
          6000, 8000, 10000, 12000, 15000, 18000, 20000, 25000, 30000
        ]
        const cur = settings.qaQuizQuestionGateMs ?? 2000
        return (
          <Row name="Question Read Time">
            <GranularSlider
              id="slider-qa-question-gate"
              className="sm-slider sm-slider--violet"
              value={cur}
              onChange={val => updateSetting('qaQuizQuestionGateMs', val)}
              valueArray={GATE_VALUES}
              unit="ms"
              presets={[
                { value: 'click', label: 'On Click' },
                { value: 0, label: 'Instant' },
                { value: 1000, label: '1 s' },
                { value: 2000, label: '2 s' },
                { value: 5000, label: '5 s' },
                { value: 10000, label: '10 s' },
              ]}
            />
          </Row>
        )
      })()}

      {/* Answer Gate */}
      <SectionLabel sub>Answer Gate</SectionLabel>
      <p className="sm-hint-text">
        After choices appear, the progress ring on each choice only fills while the user's eye gaze is on the answers. Gaze-selection is unlocked once this timer completes. Set to 0 for instant unlock.
      </p>
      {(() => {
        const GATE_VALUES = [
          0, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000,
          6000, 8000, 10000, 12000, 15000, 18000, 20000, 25000, 30000
        ]
        const cur = settings.qaQuizAnswerGateMs ?? 1500
        return (
          <Row name="Answer Read Time">
            <GranularSlider
              id="slider-qa-answer-gate"
              className="sm-slider sm-slider--violet"
              value={cur}
              onChange={val => updateSetting('qaQuizAnswerGateMs', val)}
              valueArray={GATE_VALUES}
              unit="ms"
              presets={[
                { value: 0, label: 'Instant' },
                { value: 1000, label: '1 s' },
                { value: 1500, label: '1.5 s (Std)' },
                { value: 3000, label: '3 s' },
                { value: 5000, label: '5 s' },
              ]}
            />
          </Row>
        )
      })()}

      {/* Wrong Answers Before Hint */}
      <SectionLabel sub>Hints</SectionLabel>
      <Row
        name="Wrong Answers Before Hint"
        hint="After this many wrong attempts, a visual hint glow appears on the correct answer. Set to 0 to disable hints. Emojis are disabled in Q&A."
      >
        <GranularSlider
          id="slider-qa-hint-after-wrong"
          className="sm-slider sm-slider--violet"
          min={0}
          max={9}
          step={1}
          value={settings.qaPuzzleHintAfterWrong ?? 3}
          onChange={val => updateSetting('qaPuzzleHintAfterWrong', val)}
          presets={[
            { value: 0, label: 'Disabled' },
            { value: 1, label: 'Immediate' },
            { value: 3, label: '3 (Std)' },
            { value: 5, label: '5' },
          ]}
        />
      </Row>

      {/* Sound Effects */}
      <SectionLabel sub>Audio Feedback</SectionLabel>
      <Row
        name="Answer Sound Effects"
        hint="Plays a rising arpeggio for correct answers and a descending tone for wrong ones"
      >
        <Toggle
          id="toggle-qa-quiz-sounds"
          checked={settings.qaQuizSoundEffects ?? true}
          onChange={e => updateSetting('qaQuizSoundEffects', e.target.checked)}
        />
      </Row>

      {/* Voice Over */}
      <SectionLabel sub>Voice Over</SectionLabel>
      <Row
        name="Read Questions Aloud"
        hint="Uses the system voice to read each quiz question when it appears"
      >
        <Toggle
          id="toggle-qa-quiz-voiceover"
          checked={settings.qaQuizVoiceOver ?? true}
          onChange={e => updateSetting('qaQuizVoiceOver', e.target.checked)}
        />
      </Row>
      {(settings.qaQuizVoiceOver ?? true) && (<>
        <Row
          name="Read Answer Choices Aloud"
          hint="After reading the question, each answer choice is also spoken"
        >
          <Toggle
            id="toggle-qa-quiz-voiceover-choices"
            checked={settings.qaQuizVoiceOverChoices ?? true}
            onChange={e => updateSetting('qaQuizVoiceOverChoices', e.target.checked)}
          />
        </Row>
        <Row
          name="Voice Over Pause"
          hint="Delay between reading the question and answer choices, and between each choice"
        >
          {(() => {
            const PAUSE_VALUES = [
              0, 100, 200, 300, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000
            ]
            const cur = settings.qaQuizVoiceOverPauseMs ?? 500
            return (
              <GranularSlider
                id="slider-qa-voiceover-pause"
                className="sm-slider sm-slider--violet"
                value={cur}
                onChange={val => updateSetting('qaQuizVoiceOverPauseMs', val)}
                valueArray={PAUSE_VALUES}
                unit="ms"
                presets={[
                  { value: 0, label: 'No Pause' },
                  { value: 500, label: '0.5 s (Std)' },
                  { value: 1000, label: '1 s' },
                  { value: 2000, label: '2 s' },
                  { value: 3000, label: '3 s' },
                ]}
              />
            )
          })()}
        </Row>
      </>)}
    </div>
  )
}

