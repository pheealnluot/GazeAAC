import { useState, useEffect, useRef, useCallback } from 'react'
import { generateContextualResponses } from '@engine/ContextualResponseEngine'
import './ContextWindow.css'

/**
 * ContextWindow — context input panel for the Contextual Response board.
 *
 * Placed ABOVE the TopBar/home bar. Occupies ~25% of the main content area.
 *
 * Input modes:
 *   1. Typed text (textarea)
 *   2. 🎤 Microphone → Web Speech API → fills textarea
 *   3. 📷 Camera → single JPEG frame → passed to vision model (llava)
 *
 * Auto-generates on a 900 ms debounce after any input change.
 * When camera image is captured, switches Ollama to the vision model automatically.
 *
 * Props:
 *   onResponsesGenerated  ({ responses, activeModel }) => void
 *   count                 number — how many tiles to generate (2–4)
 *   backend               'ollama' | 'window-ai'
 *   ollamaModel           string — text model
 *   ollamaVisionModel     string — vision model (auto-used when image present)
 */
export function ContextWindow({
  onResponsesGenerated,
  count = 9,
  minCount = 2,
  backend = 'ollama',
  ollamaModel = 'llama3.2',
  ollamaVisionModel = 'llava',
  promptPrefix = '',
  lifeLore = '',
  systemPrompt = '',
}) {
  const [contextText, setContextText]   = useState('')
  const [status, setStatus]             = useState('idle') // idle | listening | thinking | error
  const [errorMsg, setErrorMsg]         = useState(null)
  const [activeModel, setActiveModel]   = useState(null)   // displayed in header
  const [isListening, setIsListening]   = useState(false)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraFrame, setCameraFrame]   = useState(null)   // base64 JPEG data URL
  const [aiHistory, setAiHistory]       = useState([])     // persistent Q&A pairs
  const [userProfile, setUserProfile]   = useState(null)   // Caden's profile

  const textareaRef    = useRef(null)
  const recognitionRef = useRef(null)
  const videoRef       = useRef(null)
  const canvasRef      = useRef(null)
  const streamRef      = useRef(null)
  const debounceRef    = useRef(null)
  const lastKeyRef     = useRef('')  // dedup: "text|hasImage"

  // ── Load history and user profile from persistent store on mount ────────────
  useEffect(() => {
    async function _loadPersisted() {
      try {
        const [hist, prof] = await Promise.all([
          window.gazeAPI?.aiHistory?.getAll?.() ?? [],
          window.gazeAPI?.userProfile?.get?.()  ?? null,
        ])
        if (Array.isArray(hist)) setAiHistory(hist)
        if (prof) setUserProfile(prof)
      } catch (err) {
        console.warn('[ContextWindow] Could not load AI history / profile:', err)
      }
    }
    _loadPersisted()
  }, [])

  // ── Auto-generate on change (debounced 900 ms) ────────────────────────────
  useEffect(() => {
    const key = `${contextText.trim()}|${!!cameraFrame}|${promptPrefix}`
    if (!contextText.trim() && !cameraFrame) return
    if (key === lastKeyRef.current) return

    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      lastKeyRef.current = key
      _runGeneration(contextText.trim(), cameraFrame)
    }, 900)

    return () => clearTimeout(debounceRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextText, cameraFrame, count, minCount, backend, ollamaModel, ollamaVisionModel, promptPrefix, lifeLore, systemPrompt])

  useEffect(() => () => {
    _stopCamera()
    recognitionRef.current?.stop()
    clearTimeout(debounceRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Generation ──────────────────────────────────────────────────────────
  const _runGeneration = useCallback(async (text, imageDataUrl) => {
    setStatus('thinking')
    setErrorMsg(null)
    try {
      const result = await generateContextualResponses(text, count, {
        minCount,
        backend,
        model:         ollamaModel,
        visionModel:   ollamaVisionModel,
        imageDataUrl:  imageDataUrl ?? null,
        userProfile:   userProfile   ?? undefined,
        recentHistory: aiHistory,
        promptPrefix:       promptPrefix   ?? '',
        lifeLore:           lifeLore        ?? '',
        customSystemPrompt: systemPrompt    ?? '',
      })
      setActiveModel(result.activeModel)
      onResponsesGenerated?.(result)
      setStatus('idle')

      // ── Persist this interaction so the model learns over time ───────────
      if (text && result.responses?.length) {
        const entry = { context: text, responses: result.responses }
        // Optimistic local update — keeps the history fresh in-memory immediately
        setAiHistory(prev => [...prev.slice(-199), { ...entry, savedAt: Date.now() }])
        // Persist to electron-store (fire-and-forget; failure is non-fatal)
        window.gazeAPI?.aiHistory?.append?.(entry).catch(
          e => console.warn('[ContextWindow] Failed to save AI history entry:', e)
        )
      }
    } catch (err) {
      setStatus('error')
      setErrorMsg(err.message)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, minCount, backend, ollamaModel, ollamaVisionModel, onResponsesGenerated, userProfile, aiHistory, promptPrefix, lifeLore, systemPrompt])

  const handleManualGenerate = useCallback(() => {
    const text = contextText.trim()
    if (!text && !cameraFrame) return
    lastKeyRef.current = `${text}|${!!cameraFrame}`
    clearTimeout(debounceRef.current)
    _runGeneration(text, cameraFrame)
  }, [contextText, cameraFrame, _runGeneration])

  // ── Microphone ──────────────────────────────────────────────────────────
  const toggleMic = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop()
      setIsListening(false)
      setStatus('idle')
      return
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { setErrorMsg('Speech recognition not supported in this environment.'); return }

    const r = new SR()
    r.continuous = false; r.interimResults = true; r.lang = 'en-US'
    r.onstart  = () => { setIsListening(true);  setStatus('listening') }
    r.onend    = () => { setIsListening(false); setStatus('idle') }
    r.onerror  = e  => { setIsListening(false); setStatus('error'); setErrorMsg(`Mic: ${e.error}`) }
    r.onresult = e  => {
      const t = Array.from(e.results).map(res => res[0].transcript).join('')
      setContextText(t)
    }
    recognitionRef.current = r
    r.start()
  }, [isListening])

  // ── Camera ──────────────────────────────────────────────────────────────
  const toggleCamera = useCallback(async () => {
    if (cameraActive) { _stopCamera(); setCameraActive(false); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false })
      streamRef.current = stream
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play() }
      setCameraActive(true)
    } catch (err) { setErrorMsg(`Camera: ${err.message}`) }
  }, [cameraActive])

  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return
    const c = canvasRef.current, v = videoRef.current
    c.width = v.videoWidth || 320; c.height = v.videoHeight || 240
    c.getContext('2d').drawImage(v, 0, 0)
    const dataUrl = c.toDataURL('image/jpeg', 0.8)
    setCameraFrame(dataUrl)
    _stopCamera(); setCameraActive(false)
  }, [])

  const _stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }

  const clearAll = useCallback(() => {
    setContextText(''); setCameraFrame(null)
    lastKeyRef.current = ''; setErrorMsg(null)
    setStatus('idle'); setActiveModel(null)
    textareaRef.current?.focus()
  }, [])

  // ── Model badge label ─────────────────────────────────────────────────
  const modelLabel = activeModel
    ? activeModel === 'fallback' ? '⚠ default phrases'
    : activeModel === 'gemini-nano' ? '✨ Gemini Nano'
    : `🦙 ${activeModel.replace('ollama/', '')}`
    : null

  return (
    <div className="ctx-window" aria-label="Context input">

      {/* ── Header ── */}
      <div className="ctx-window__header">
        <span className="ctx-window__title">
          <span className="ctx-window__title-icon">🧠</span>
          Context
        </span>

        {modelLabel && (
          <span className="ctx-window__model-badge">{modelLabel}</span>
        )}

        <div className="ctx-window__status">
          {status === 'thinking' && (
            <span className="ctx-window__thinking">
              <span className="ctx-window__spinner" />
              Generating…
            </span>
          )}
          {status === 'listening' && (
            <span className="ctx-window__listening">
              <span className="ctx-window__pulse" />
              Listening…
            </span>
          )}
          {status === 'error' && errorMsg && (
            <span className="ctx-window__error-badge" title={errorMsg}>
              ⚠ {errorMsg.length > 45 ? errorMsg.slice(0, 45) + '…' : errorMsg}
            </span>
          )}
        </div>

        <button className="ctx-window__clear" onClick={clearAll} title="Clear" aria-label="Clear context">✕</button>
      </div>

      {/* ── Body ── */}
      <div className="ctx-window__body">

        {/* Camera panel */}
        {(cameraActive || cameraFrame) && (
          <div className="ctx-window__camera-panel">
            {cameraActive
              ? <>
                  <video ref={videoRef} className="ctx-window__video" muted playsInline autoPlay />
                  <button className="ctx-window__cam-snap" onClick={captureFrame}>📸 Snap</button>
                </>
              : cameraFrame && (
                  <div className="ctx-window__camera-thumb-wrap">
                    <img src={cameraFrame} className="ctx-window__camera-thumb" alt="Captured frame" />
                    <button className="ctx-window__cam-clear" onClick={() => setCameraFrame(null)} title="Remove image">✕</button>
                    <span className="ctx-window__cam-badge">🔬 {ollamaVisionModel}</span>
                  </div>
                )
            }
          </div>
        )}
        <canvas ref={canvasRef} style={{ display: 'none' }} />

        {/* Text input */}
        <textarea
          ref={textareaRef}
          className="ctx-window__textarea"
          value={contextText}
          onChange={e => setContextText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && e.altKey) {
              // Alt+Enter: insert a newline at cursor position
              e.preventDefault()
              const el    = e.target
              const start = el.selectionStart
              const end   = el.selectionEnd
              const next  = contextText.slice(0, start) + '\n' + contextText.slice(end)
              setContextText(next)
              requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = start + 1
              })
            } else if (e.key === 'Enter' && !e.altKey) {
              // Enter: trigger generation now (no newline)
              e.preventDefault()
              handleManualGenerate()
            }
          }}
          placeholder="Type a question, describe the situation, or speak into the mic…"
          aria-label="Context description"
        />

        {/* Controls — 2×2 grid: [Clear][Speak] / [Now][Camera] */}
        <div className="ctx-window__controls">
          {/* r1c1 */}
          <button
            id="ctx-btn-clear"
            className="ctx-window__btn ctx-window__btn--clear-input"
            onClick={clearAll}
            disabled={!contextText.trim() && !cameraFrame}
            aria-label="Clear context input"
          >
            🗑 Clear
          </button>

          {/* r1c2 */}
          <button
            id="ctx-btn-mic"
            className={`ctx-window__btn ctx-window__btn--mic ${isListening ? 'ctx-window__btn--active' : ''}`}
            onClick={toggleMic}
            aria-label={isListening ? 'Stop microphone' : 'Speak context'}
            aria-pressed={isListening}
          >
            {isListening ? '⏹ Stop' : '🎤 Speak'}
          </button>

          {/* r2c1 */}
          <button
            id="ctx-btn-generate"
            className="ctx-window__btn ctx-window__btn--generate"
            onClick={handleManualGenerate}
            disabled={(!contextText.trim() && !cameraFrame) || status === 'thinking'}
            aria-label="Generate responses now"
          >
            {status === 'thinking' ? '⏳ …' : '✨ Now'}
          </button>

          {/* r2c2 */}
          <button
            id="ctx-btn-camera"
            className={`ctx-window__btn ctx-window__btn--cam ${cameraActive ? 'ctx-window__btn--active' : ''}`}
            onClick={toggleCamera}
            aria-label={cameraActive ? 'Stop camera' : 'Capture image'}
            aria-pressed={cameraActive}
          >
            {cameraActive ? '⏹ Stop' : '📷 Camera'}
          </button>
        </div>
      </div>
    </div>
  )
}
