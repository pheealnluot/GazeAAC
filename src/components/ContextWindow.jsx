import { useState, useEffect, useRef, useCallback } from 'react'
import { generateContextualResponses } from '@engine/ContextualResponseEngine'
import { useGazeSettings } from '@context/GazeSettingsContext'
import { useCameraVision } from '@context/CameraVisionContext'
import './ContextWindow.css'

// ── Audio Waveform Visualizer ─────────────────────────────────────────────────
// Uses the Web Audio API AnalyserNode + getUserMedia for visual feedback only.
// The actual speech recognition is handled by Windows SAPI in the main process.
function AudioWaveform({ active, deviceId }) {
  const canvasRef    = useRef(null)
  const animRef      = useRef(null)
  const audioCtxRef  = useRef(null)
  const analyserRef  = useRef(null)
  const streamRef    = useRef(null)

  useEffect(() => {
    if (!active) {
      // Tear down on deactivation
      cancelAnimationFrame(animRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close()
      }
      audioCtxRef.current = null
      analyserRef.current = null
      // Clear canvas
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
      return
    }

    let cancelled = false
    async function _start() {
      try {
        const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true }
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream

        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        audioCtxRef.current = ctx
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.75
        source.connect(analyser)
        analyserRef.current = analyser

        const dataArray = new Uint8Array(analyser.frequencyBinCount)

        function draw() {
          if (cancelled) return
          animRef.current = requestAnimationFrame(draw)
          const canvas = canvasRef.current
          if (!canvas) return
          const W = canvas.width, H = canvas.height
          analyser.getByteTimeDomainData(dataArray)

          const drawCtx = canvas.getContext('2d')
          drawCtx.clearRect(0, 0, W, H)

          // Glow line
          drawCtx.lineWidth = 2
          drawCtx.shadowBlur = 8
          drawCtx.shadowColor = 'hsl(340, 80%, 60%)'
          drawCtx.strokeStyle = 'hsl(340, 80%, 65%)'
          drawCtx.beginPath()

          const sliceW = W / dataArray.length
          let x = 0
          for (let i = 0; i < dataArray.length; i++) {
            const v = dataArray[i] / 128.0
            const y = (v * H) / 2
            if (i === 0) drawCtx.moveTo(x, y)
            else drawCtx.lineTo(x, y)
            x += sliceW
          }
          drawCtx.lineTo(W, H / 2)
          drawCtx.stroke()
        }
        draw()
      } catch (err) {
        console.warn('[AudioWaveform] getUserMedia failed:', err.message)
      }
    }
    _start()

    return () => {
      cancelled = true
      cancelAnimationFrame(animRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close()
      }
      audioCtxRef.current = null
      analyserRef.current = null
    }
  }, [active, deviceId])

  return (
    <canvas
      ref={canvasRef}
      className={`ctx-window__waveform${active ? ' ctx-window__waveform--active' : ''}`}
      width={200}
      height={36}
      aria-hidden="true"
    />
  )
}

// ── STT Pipeline Visualiser ───────────────────────────────────────────────────
// Shows each stage of the SAPI initialisation flow as it arrives.
// Stage strings emitted by the C# class via STATUS: prefix:
//   recognizers=N  →  engine found
//   engine=…       →  specific recogniser chosen
//   mic-connected  →  SetInputToDefaultAudioDevice succeeded
//   grammar-loaded →  DictationGrammar loaded
//   listening      →  RecognizeAsync started (READY received)
//   got-transcript →  at least one transcript accepted
//   audio-problem= →  AudioSignalProblemOccurred
function SttPipeline({ stages, lastRejected, visible }) {
  if (!visible) return null

  // Map each known stage to: reached | audio-problem
  const hasAudioProblem = stages.some(s => s.startsWith('audio-problem='))
  const audioProblemMsg = stages.find(s => s.startsWith('audio-problem='))?.split('=')[1] ?? ''

  if (!lastRejected && !hasAudioProblem) return null

  return (
    <div className="ctx-window__pipeline" aria-label="STT pipeline status">
      {/* Rejected hint — shown in amber when SAPI hears but rejects speech */}
      {lastRejected && (
        <div className="ctx-window__pipeline-rejected" title={`Confidence: ${(lastRejected.confidence * 100).toFixed(0)}%`}>
          <span className="ctx-window__pipeline-rejected-icon">⚠</span>
          <span>
            SAPI heard: <em>&ldquo;{lastRejected.text || '…'}&rdquo;</em>
            {' '}— confidence {(lastRejected.confidence * 100).toFixed(0)}% (below threshold, speak clearly)
          </span>
        </div>
      )}

      {/* Audio problem */}
      {hasAudioProblem && (
        <div className="ctx-window__pipeline-rejected ctx-window__pipeline-rejected--error">
          <span className="ctx-window__pipeline-rejected-icon">🎙</span>
          <span>Mic signal issue: {audioProblemMsg} — check Windows default audio input device</span>
        </div>
      )}
    </div>
  )
}

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
  micMode = 'toggle',
  micDeviceId = '',
  routing = 'local-only',
  geminiApiKey = '',
  geminiModel = 'gemini-2.5-flash',
  openAiApiKey = '',
  openAiModel = 'gpt-4o-mini',
  cloudAiProviderOrder = ['gemini', 'openai'],
  speakMode = 'voice-typing',
  contextualWvtTimeout = 0,
  speakShortcutCtrl = false,
  speakShortcutShift = false,
  speakShortcutAlt = false,
  speakShortcutChar = '',
}) {
  const { settings, updateSettings } = useGazeSettings()
  const { liveVisionSummary, triggerManualDetection } = useCameraVision()
  const [contextText, setContextText]   = useState('')
  const [status, setStatus]             = useState('idle') // idle | compiling | listening | thinking | error
  const [errorMsg, setErrorMsg]         = useState(null)
  const [loadingSeconds, setLoadingSeconds] = useState(0)

  useEffect(() => {
    if (status === 'thinking') {
      setLoadingSeconds(0)
      const timer = setInterval(() => {
        setLoadingSeconds(prev => prev + 1)
      }, 1000)
      return () => clearInterval(timer)
    }
  }, [status])
  const [activeModel, setActiveModel]   = useState(null)   // displayed in header
  const [fallbackReason, setFallbackReason] = useState(null)
  const [isListening, setIsListening]   = useState(false)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraFrame, setCameraFrame]   = useState(null)   // base64 JPEG data URL
  const [aiHistory, setAiHistory]       = useState([])     // persistent Q&A pairs
  // ── STT pipeline diagnostic state ──────────────────────────────────────
  const [sttPipeline, setSttPipeline]   = useState([])     // array of stage strings received so far
  const [lastRejected, setLastRejected] = useState(null)   // { confidence, text } | null

  const textareaRef    = useRef(null)
  const baseTextRef    = useRef('')    // snapshot of context before speech starts (for appending)
  const videoRef       = useRef(null)
  const canvasRef      = useRef(null)
  const streamRef      = useRef(null)
  const debounceRef    = useRef(null)
  const lastKeyRef     = useRef('')  // dedup: "text|hasImage"
  const isListeningRef = useRef(false)
  const isUsingSapiRef = useRef(false) // Track if SAPI fallback is active
  const autoOffTimerRef = useRef(null)
  const micStoppedAtRef = useRef(0)    // timestamp (ms) when mic was last stopped — used to discard late transcripts

  // Clean up auto-off timer on unmount
  useEffect(() => {
    return () => {
      if (autoOffTimerRef.current) {
        clearTimeout(autoOffTimerRef.current)
      }
    }
  }, [])

  // ── Load history from persistent store on mount ────────────
  useEffect(() => {
    async function _loadPersisted() {
      try {
        const hist = await window.gazeAPI?.aiHistory?.getAll?.() ?? []
        if (Array.isArray(hist)) setAiHistory(hist)
      } catch (err) {
        console.warn('[ContextWindow] Could not load AI history:', err)
      }
    }
    _loadPersisted()
  }, [])

  // ── Auto-generate on change (debounced 900 ms) ────────────────────────────
  useEffect(() => {
    // If augment-only-on-prompt is enabled, exclude liveVisionSummary from the dedup key
    // so background updates do not trigger new auto-generations.
    const includeVisionSummary = settings.cameraAugmentationEnabled && !settings.cameraAugmentOnlyOnPrompt
    const key = `${contextText.trim()}|${!!cameraFrame}|${promptPrefix}|${routing}|${geminiApiKey}|${geminiModel}|${includeVisionSummary ? liveVisionSummary : ''}`

    const isCameraEnabled = settings.cameraAugmentationEnabled && liveVisionSummary
    const shouldSkipAuto = settings.cameraAugmentOnlyOnPrompt

    if (!contextText.trim() && !cameraFrame && !(isCameraEnabled && !shouldSkipAuto)) return
    if (key === lastKeyRef.current) return

    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      lastKeyRef.current = key
      _runGeneration(contextText.trim(), cameraFrame)
    }, 900)

    return () => clearTimeout(debounceRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextText, cameraFrame, count, minCount, backend, ollamaModel, ollamaVisionModel, promptPrefix, lifeLore, systemPrompt, routing, geminiApiKey, geminiModel, liveVisionSummary, settings.cameraAugmentationEnabled, settings.cameraAugmentOnlyOnPrompt])

  useEffect(() => () => {
    _stopCamera()
    // Stop SAPI mic if active on unmount
    if (isListeningRef.current) window.gazeAPI?.mic?.stop?.()
    clearTimeout(debounceRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Subscribe to SAPI transcript / error / pipeline events ──────────────
  useEffect(() => {
    let lastTranscriptText = ''
    let lastTranscriptTime = 0

    const unsubTranscript = window.gazeAPI?.mic?.onTranscript?.((text) => {
      if (window.__ttsEndTime && Date.now() < window.__ttsEndTime) return
      
      const now = Date.now()
      if (text === lastTranscriptText && (now - lastTranscriptTime) < 500) {
        return // Ignore rapid duplicate event within 500ms
      }
      // Discard transcripts that arrive within 1 s of the mic being stopped.
      // Windows Voice Typing / SAPI can flush a final partial recognition after
      // the user has already pressed Stop, causing the text to appear in the
      // context box a second time.
      if ((now - micStoppedAtRef.current) < 1000) {
        console.log('[ContextWindow] Discarding late transcript after mic stop:', text)
        return
      }
      lastTranscriptText = text
      lastTranscriptTime = now

      setContextText(prev => {
        const trimmedPrev = prev.trim()
        return trimmedPrev ? trimmedPrev + '\n\nPartner: ' + text : 'Partner: ' + text
      })
    })
    const unsubError = window.gazeAPI?.mic?.onError?.((msg) => {
      console.error('[ContextWindow] SAPI STT error:', msg)
      isListeningRef.current = false
      setIsListening(false)
      setStatus('error')
      setErrorMsg(`Mic error: ${msg}`)
    })
    const unsubStatus = window.gazeAPI?.mic?.onStatus?.((stage) => {
      setSttPipeline(prev => [...prev, stage])
      // Clear the last-rejected hint when a real transcript arrives
      if (stage === 'got-transcript') setLastRejected(null)
    })
    const unsubRejected = window.gazeAPI?.mic?.onRejected?.((data) => {
      setLastRejected(data)  // { confidence, text }
    })
    return () => {
      unsubTranscript?.()
      unsubError?.()
      unsubStatus?.()
      unsubRejected?.()
    }
  }, [])

  // ── Generation ──────────────────────────────────────────────────────────
  const _runGeneration = useCallback(async (text, imageDataUrl) => {
    setStatus('thinking')
    setErrorMsg(null)
    setFallbackReason(null)
    try {
      const activeProfile = await window.gazeAPI?.userProfile?.get?.() || null
      const result = await generateContextualResponses(text, count, {
        minCount,
        backend,
        model:         ollamaModel,
        visionModel:   ollamaVisionModel,
        imageDataUrl:  imageDataUrl ?? null,
        userProfile:   activeProfile ?? undefined,
        recentHistory: aiHistory,
        promptPrefix:       promptPrefix   ?? '',
        lifeLore:           lifeLore        ?? '',
        customSystemPrompt: systemPrompt    ?? '',
        routing,
        cloudAiProviderOrder,
        geminiApiKey,
        geminiModel,
        openAiApiKey,
        openAiModel,
        cameraAugmentationData: settings.cameraAugmentationEnabled ? liveVisionSummary : '',
      })
      setActiveModel(result.activeModel)
      setFallbackReason(result.fallbackReason || null)
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
  }, [count, minCount, backend, ollamaModel, ollamaVisionModel, onResponsesGenerated, aiHistory, promptPrefix, lifeLore, systemPrompt, routing, geminiApiKey, geminiModel, openAiApiKey, openAiModel, cloudAiProviderOrder])

  const handleManualGenerate = useCallback(() => {
    const text = contextText.trim()
    if (!text && !cameraFrame && !settings.cameraAugmentationEnabled) return
    lastKeyRef.current = `${text}|${!!cameraFrame}|manual-${Date.now()}`
    clearTimeout(debounceRef.current)
    _runGeneration(text, cameraFrame)
  }, [contextText, cameraFrame, settings.cameraAugmentationEnabled, _runGeneration])

  const handleManualGenerateRef = useRef(handleManualGenerate)
  useEffect(() => {
    handleManualGenerateRef.current = handleManualGenerate
  }, [handleManualGenerate])

  // ── Helper: reliably release keyboard focus so eye gaze can resume ────────
  // A plain .blur() call is sometimes ignored (e.g. on machines where the OS
  // or voice-typing UI briefly steals focus back). Explicitly focusing
  // document.body and then blurring it is more consistent across machines.
  const _releaseFocus = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.blur()
    }
    // Belt-and-suspenders: force focus to body so gaze dwell works immediately
    document.body.focus()
    // A second attempt after a short delay catches cases where the OS returns
    // focus to the textarea after the voice-typing overlay closes (~100-200 ms).
    setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur()
        document.body.focus()
      }
    }, 250)
  }, [])

  // ── Microphone — Windows SAPI via IPC (works offline, no Google API key needed) ─
  const toggleMic = useCallback(async () => {
    // Clear any existing auto-off timer
    if (autoOffTimerRef.current) {
      clearTimeout(autoOffTimerRef.current)
      autoOffTimerRef.current = null
    }

    if (isListeningRef.current) {
      // Stop: tell main process to kill the SAPI engine or toggle voice typing off
      isListeningRef.current = false
      setIsListening(false)
      setStatus('idle')
      // Stamp the stop time so late transcripts from the WVT/SAPI pipeline
      // (which can arrive up to ~1 s after stop) are silently discarded.
      micStoppedAtRef.current = Date.now()
      if (isUsingSapiRef.current) {
        await window.gazeAPI?.mic?.stop?.()
      } else {
        await window.gazeAPI?.mic?.triggerVoiceTyping?.('off')
      }
      // Robustly release focus so eye gaze can resume dwell selection.
      // A plain blur() is sometimes ignored on other machines; explicitly moving
      // focus to document.body is more reliable across OS configurations.
      _releaseFocus()
      handleManualGenerateRef.current?.()
      return
    }

    // Clear the context window when starting to speak
    setContextText('')

    // Focus the textarea so voice typing enters text in the right place
    textareaRef.current?.focus()
    // Defensively refocus a few times to beat any focus-stealing events or delays
    setTimeout(() => textareaRef.current?.focus(), 50)
    setTimeout(() => textareaRef.current?.focus(), 150)
    setTimeout(() => textareaRef.current?.focus(), 300)

    let shouldRunSapi = (speakMode === 'sapi')

    if (speakMode === 'voice-typing') {
      try {
        console.log('[ContextWindow] Attempting Windows Voice Typing (Win+H)...')
        isListeningRef.current = true
        setIsListening(true)
        setStatus('listening')
        isUsingSapiRef.current = false

        const res = await window.gazeAPI?.mic?.triggerVoiceTyping?.('on')
        if (res && res.ok) {
          console.log('[ContextWindow] Windows Voice Typing triggered successfully.')
          
          if (contextualWvtTimeout > 0) {
            console.log(`[ContextWindow] Scheduling WVT auto-off in ${contextualWvtTimeout} seconds...`)
            autoOffTimerRef.current = setTimeout(async () => {
              console.log('[ContextWindow] WVT auto-off timer fired. Stopping listening...')
              isListeningRef.current = false
              setIsListening(false)
              setStatus('idle')
              micStoppedAtRef.current = Date.now()
              await window.gazeAPI?.mic?.triggerVoiceTyping?.('off')
              autoOffTimerRef.current = null
              // Robustly release focus so eye gaze can resume after auto-off
              _releaseFocus()
              handleManualGenerateRef.current?.()
            }, contextualWvtTimeout * 1000)
          }
          return
        } else {
          console.warn('[ContextWindow] Windows Voice Typing failed, falling back to SAPI:', res?.reason)
          shouldRunSapi = true
        }
      } catch (err) {
        console.error('[ContextWindow] Error triggering voice typing, falling back to SAPI:', err)
        shouldRunSapi = true
      }
    }

    if (shouldRunSapi) {
      // FALLBACK TO SAPI (or SAPI selected directly)
      console.log('[ContextWindow] Triggering SAPI Speech-to-Text...')
      isUsingSapiRef.current = true
      // Snapshot empty context since we just cleared it
      baseTextRef.current = ''

      // Reset pipeline diagnostics for this new session
      setSttPipeline([])
      setLastRejected(null)

      isListeningRef.current = true
      setIsListening(true)
      setStatus('compiling')   // SAPI C# assembly compiles on first use (~3–5s)

      // Switch status to 'listening' once SAPI signals it's ready
      window.gazeAPI?.mic?.onReady?.(() => {
        if (isListeningRef.current) setStatus('listening')
      })

      try {
        await window.gazeAPI?.mic?.start?.()
      } catch (err) {
        console.error('[ContextWindow] mic start error:', err)
        isListeningRef.current = false
        setIsListening(false)
        setStatus('error')
        setErrorMsg(`Mic Error: ${err.message}`)
      }
    }
  }, [speakMode, contextualWvtTimeout, _releaseFocus])


  // ── Keyboard shortcut to toggle Speak button ─────────────────────────────
  useEffect(() => {
    if (!speakShortcutChar) return

    const handleKeyDown = (e) => {
      const ctrlMatch = !!e.ctrlKey === !!speakShortcutCtrl
      const shiftMatch = !!e.shiftKey === !!speakShortcutShift
      const altMatch = !!e.altKey === !!speakShortcutAlt

      if (!ctrlMatch || !shiftMatch || !altMatch) return

      const targetChar = speakShortcutChar.toLowerCase()
      const isFunctionKey = /^f[1-5]$/i.test(speakShortcutChar)

      let keyMatch = false
      if (isFunctionKey) {
        keyMatch = e.key.toLowerCase() === targetChar
      } else {
        const keyLower = e.key.toLowerCase()
        if (keyLower === targetChar) {
          keyMatch = true
        } else if (e.code) {
          const isLetter = /^[a-z]$/i.test(targetChar)
          const isDigit = /^[0-9]$/.test(targetChar)
          if (isLetter && e.code === `Key${targetChar.toUpperCase()}`) {
            keyMatch = true
          } else if (isDigit && e.code === `Digit${targetChar}`) {
            keyMatch = true
          }
        }
      }

      if (keyMatch) {
        // Ignore key-repeat events: the browser fires keydown repeatedly while a
        // key is held. Without this guard a slightly-long keypress would call
        // toggleMic() twice — stopping and then immediately re-starting — which
        // causes the message to be transcribed and appended a second time.
        if (e.repeat) return

        // If we are currently listening, always allow the shortcut to fire —
        // this is a "stop" action and must never be blocked by the isEditing guard
        // (the textarea is intentionally focused while listening to receive voice input).
        const currentlyListening = isListeningRef.current

        if (!currentlyListening) {
          // Starting: if the user has focused an input/textarea/select, only allow if
          // they are holding true modifiers (Ctrl or Alt) or it's a function key.
          const isEditing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable
          if (isEditing && !isFunctionKey) {
            const hasTrueModifiers = speakShortcutCtrl || speakShortcutAlt
            if (!hasTrueModifiers) {
              return
            }
          }
        }

        e.preventDefault()
        toggleMic()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [speakShortcutCtrl, speakShortcutShift, speakShortcutAlt, speakShortcutChar, toggleMic])

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
    setStatus('idle'); setActiveModel(null); setFallbackReason(null)
    onResponsesGenerated?.({ responses: [], activeModel: null, fallbackReason: null })
    textareaRef.current?.focus()
  }, [onResponsesGenerated])

  // ── Model badge label ─────────────────────────────────────────────────
  const modelLabel = activeModel
    ? activeModel === 'fallback' ? '⚠ default'
    : activeModel === 'gemini-nano' ? '✨ Nano'
    : activeModel.startsWith('gemini-cloud/') ? (
        settings.cameraStreamingEnabled
          ? `🌐 ${activeModel.replace('gemini-cloud/', '')}`
          : `🌐 Gemini Cloud (${activeModel.replace('gemini-cloud/', '')})`
      )
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

        {settings.cameraAugmentationEnabled && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            {settings.cameraIntervalMs === -1 ? (
              <button
                type="button"
                className="ctx-window__model-badge ctx-window__model-badge--camera ctx-window__manual-scan-btn"
                onClick={async () => {
                  setStatus('thinking')
                  try {
                    const summary = await triggerManualDetection()
                    if (summary) {
                      console.log('[ContextWindow] Manual env scan summary:', summary)
                    }
                  } catch (e) {
                    console.error('[ContextWindow] Manual scan failed:', e)
                  } finally {
                    setStatus('idle')
                  }
                }}
                title={liveVisionSummary ? `Environment summary: ${liveVisionSummary}\n\nClick to scan again.` : "Click to scan environment now."}
                style={{
                  cursor: 'pointer',
                  border: '1px solid rgba(16, 185, 129, 0.45)',
                  background: 'rgba(16, 185, 129, 0.12)',
                  color: '#10B981',
                  padding: '2px 10px',
                  borderRadius: '20px',
                  fontWeight: '700',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  outline: 'none',
                  transition: 'all 0.15s ease'
                }}
              >
                👁 Scan Environment
              </button>
            ) : (
              liveVisionSummary && (
                <span className="ctx-window__model-badge ctx-window__model-badge--camera" title={liveVisionSummary}>
                  👁 Env Aug Active
                </span>
              )
            )}

            <button
              type="button"
              className={`ctx-window__model-badge ctx-window__model-badge--stream ${
                settings.cameraStreamingEnabled ? 'ctx-window__model-badge--stream-active' : ''
              }`}
              onClick={() => updateSettings({ cameraStreamingEnabled: !settings.cameraStreamingEnabled })}
              title={settings.cameraStreamingEnabled ? "Click to turn off streaming video feed" : "Click to turn on streaming video feed"}
              style={{
                cursor: 'pointer',
                border: settings.cameraStreamingEnabled ? '1px solid rgba(236, 72, 153, 0.45)' : '1px solid rgba(255, 255, 255, 0.15)',
                background: settings.cameraStreamingEnabled ? 'rgba(236, 72, 153, 0.12)' : 'rgba(255, 255, 255, 0.05)',
                color: settings.cameraStreamingEnabled ? '#EC4899' : 'rgba(255, 255, 255, 0.65)',
                padding: '2px 10px',
                borderRadius: '20px',
                fontWeight: '700',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                outline: 'none',
                transition: 'all 0.15s ease'
              }}
            >
              {settings.cameraStreamingEnabled ? '📹 Stream: ON' : '📹 Stream: OFF'}
            </button>
          </div>
        )}

        <div className="ctx-window__status">
          {status === 'thinking' && (
            <span className="ctx-window__thinking">
              <span className="ctx-window__spinner" />
              Generating… ({loadingSeconds}s)
            </span>
          )}
          {status === 'compiling' && (
            <span className="ctx-window__listening">
              <span className="ctx-window__spinner" />
              Starting mic…
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

        {/* STT pipeline warnings — shows SAPI warnings or audio problems */}
        <SttPipeline
          stages={sttPipeline}
          lastRejected={lastRejected}
          visible={isListening}
        />

        {/* Quick toggle for suggestion tile count range */}
        <div className="ctx-window__responses-toggle">
          {!settings.cameraStreamingEnabled && (
            <span className="ctx-window__responses-label">Number of Responses:</span>
          )}
          <div className="ctx-window__toggle-group">
            {[
              { min: 2, max: 2, label: '2' },
              { min: 3, max: 3, label: '3' },
              { min: 2, max: 4, label: '2-4' },
              { min: 4, max: 6, label: '4-6' },
            ].map(opt => {
              const active = minCount === opt.min && count === opt.max
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={`ctx-window__toggle-btn${active ? ' ctx-window__toggle-btn--active' : ''}`}
                  onClick={() => updateSettings({
                    contextualResponseMinCount: opt.min,
                    contextualResponseCount: opt.max,
                  })}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Audio waveform — shown whenever mic is active (compiling or listening) */}
        <AudioWaveform
          active={isListening}
          deviceId={micDeviceId}
        />

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
              e.target.blur() // Release keyboard focus so gaze activations resume
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
            onMouseDown={e => e.preventDefault()}
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
            disabled={(!contextText.trim() && !cameraFrame && !settings.cameraAugmentationEnabled) || status === 'thinking'}
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
