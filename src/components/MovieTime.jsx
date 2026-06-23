import { useState, useEffect, useRef, useCallback, useMemo, forwardRef, memo } from 'react'
import { useGazeSettings } from '@context/GazeSettingsContext'
import './MovieTime.css'

/* ─────────────────────────────────────────────────────────────────────────────
   MovieTime
   Full-screen mode with 4 internal states:
     'browse'   → grid of YouTube videos; dwell to pick, dwell Refresh for more
     'prewatch' → AI question must be answered before the show starts
     'watching' → YouTube IFrame plays; gaze-away auto-pause; periodic puzzles
     'puzzle'   → video paused; AI quiz overlay must be answered to resume
   ───────────────────────────────────────────────────────────────────────────── */

// Module-level session ID (remains stable for a single run/load of the app)
const APP_RUN_SESSION_ID = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

// Helper to keep questions from the last 10 unique sessions only
function pruneTo10Sessions(questions, currentSessionId) {
  const sessionsMap = new Map();
  questions.forEach(q => {
    if (!q || !q.sessionId) return;
    if (!sessionsMap.has(q.sessionId)) {
      sessionsMap.set(q.sessionId, []);
    }
    sessionsMap.get(q.sessionId).push(q);
  });

  let uniqueSessionIds = Array.from(sessionsMap.keys());
  
  // Keep the current session active in the list
  if (uniqueSessionIds.includes(currentSessionId)) {
    uniqueSessionIds = uniqueSessionIds.filter(id => id !== currentSessionId);
    uniqueSessionIds.push(currentSessionId);
  }

  if (uniqueSessionIds.length > 10) {
    // Keep only the last 10 session IDs
    const sessionsToKeep = new Set(uniqueSessionIds.slice(-10));
    return questions.filter(q => q && sessionsToKeep.has(q.sessionId));
  }
  return questions;
}

function isWebviewVideoUrl(url, provider) {
  if (!url) return false
  const lowerUrl = url.toLowerCase()
  if (provider === 'youtube') {
    return lowerUrl.includes('/watch') || lowerUrl.includes('/shorts') || lowerUrl.includes('/embed')
  }
  if (provider === 'netflix') {
    return lowerUrl.includes('/watch')
  }
  if (provider === 'disney') {
    return lowerUrl.includes('/video') || lowerUrl.includes('/play') || lowerUrl.includes('/watch')
  }
  return false
}

export function MovieTime({
  onBack,
  onOpenSettings,
  gazeCursorRef,
  gazeBlocked = false,
  registerHitTargets,
  gazeState: parentGazeState,
  onDwellRef,
  rawGazeRef,
  cursorStyleRef,
  onSetOverlayActive,
  onSetQuizActive,
  setScreenDwellClickEnabled,
  setAppTitlebarQuizInfo
}) {
  const { settings, updateSetting } = useGazeSettings()
  const [phase, setPhase]           = useState('browse')  // 'browse' | 'prewatch' | 'watching' | 'puzzle'
  const [videos, setVideos]         = useState([])
  const [videosLoading, setVideosLoading] = useState(false)
  const [videosError, setVideosError]     = useState(null)  // null | 'no-key' | 'quota' | 'quota-no-cache' | string
  const [videosFromCache, setVideosFromCache] = useState(false)  // true when current results are from cache
  const [cacheTimestamp, setCacheTimestamp]   = useState(null)   // Date when cache was saved
  const [activeKeyIndex, setActiveKeyIndex]   = useState(0)      // index into movieTimeYoutubeKeys currently used
  const [selectedVideo, setSelectedVideo] = useState(null)
  const isOverlayActive = selectedVideo && (selectedVideo.provider === 'netflix' || selectedVideo.provider === 'disney' || selectedVideo.provider === 'youtube') && phase === 'watching'
  const lastPrewatchUrlRef = useRef('')

  useEffect(() => {
    onSetQuizActive?.(phase === 'puzzle' || phase === 'prewatch')
  }, [phase, onSetQuizActive])

  // ── Cache key: encodes search params (not the API key, so all keys share one cache) ──
  const _ytCacheKey = () => {
    const k = [
      (settings.movieTimeTopics    ?? []).join(','),
      (settings.movieTimeInterests ?? []).join(','),
      (settings.movieTimeWhitelist ?? []).join(','),
      settings.movieTimeDuration        ?? '',
      settings.movieTimeSafeSearch      ?? '',
      settings.movieTimeSelectionCount  ?? '',
      settings.movieTimeVideoQuality    ?? '',
      settings.movieTimeGamerLoophole   ? '1' : '0',
      settings.movieTimeMinViews         ?? 0,
      settings.movieTimeLanguage         ?? '',
    ].join('|')
    return `movietime_yt_cache_${btoa(k).slice(0, 40)}`
  }



  // Topbar height — updated by ResizeObserver so hit-target registration
  // re-runs with correct overlay bounds whenever the topbar changes size
  // (e.g. quiz phase adds Pause/Skip buttons making the bar taller).
  const [topbarHeight, setTopbarHeight] = useState(0)

  // Watching state
  const [gazedAway, setGazedAway]     = useState(false)
  const [gazeNoData, setGazeNoData]   = useState(false)   // true when eye tracker sends no coordinates
  const [isVideoPlaying, setIsVideoPlaying] = useState(false)
  const [puzzleTimer, setPuzzleTimer] = useState(null)
  const [puzzleCountdown, setPuzzleCountdown] = useState(null) // 1-5 seconds before puzzle fires
  const [nextPuzzleConfirm, setNextPuzzleConfirm] = useState(false) // true = button primed (blue state)
  const [feedback, setFeedback]       = useState(null)     // null | 'correct'
  const [wrongFeedbackIdx, setWrongFeedbackIdx] = useState(null) // index of just-wrong choice, null otherwise

  // Puzzle state
  const [puzzle, setPuzzle]           = useState(null)     // { question, choices, correctIndex, type }
  const [puzzleLoading, setPuzzleLoading] = useState(false)
  const [loadingSeconds, setLoadingSeconds] = useState(0)

  useEffect(() => {
    if (puzzleLoading) {
      setLoadingSeconds(0)
      const timer = setInterval(() => {
        setLoadingSeconds(prev => prev + 1)
      }, 1000)
      return () => clearInterval(timer)
    }
  }, [puzzleLoading])

  const [puzzleQuestionGate, setPuzzleQuestionGate] = useState(true)
  const [puzzleAnswerGate, setPuzzleAnswerGate]     = useState(false)
  const [gateTriggerKey, setGateTriggerKey] = useState(0)
  const [puzzleGateProgress, setPuzzleGateProgress] = useState(0)
  const [puzzleAnswerGateProgress, setPuzzleAnswerGateProgress] = useState(0)
  const [puzzleWrongCount, setPuzzleWrongCount]     = useState(0)   // wrong attempts this puzzle
  const [puzzleQuestionIndex, setPuzzleQuestionIndex] = useState(1)  // current question number (1-based)
  const [puzzleTotalQuestions, setPuzzleTotalQuestions] = useState(3) // total questions in this session
  const [persistentWrong, setPersistentWrong]       = useState({})  // { [idx]: true } shown ❌
  const [puzzleQuestions, setPuzzleQuestions]       = useState([])  // pre-loaded/pre-fetched quiz questions

  // ── Quiz Schedule — all quiz sets generated upfront ─────────────────────
  // quizSchedule: Array<{ quizIndex: number, videoTimeSec: number, questions: Question[] }>
  const [quizSchedule, setQuizSchedule]             = useState([])
  const quizScheduleRef    = useRef([])   // always up-to-date
  const currentQuizIndexRef = useRef(0)  // which quiz slot we're on (0-based)
  const quizScheduleAbortRef = useRef(false) // set true to cancel in-flight schedule generation

  useEffect(() => {
    quizScheduleRef.current = quizSchedule
    // Keep the global inspector object always in sync so DevTools access works
    // the instant any questions arrive (not just after generation completes).
    if (typeof window !== 'undefined') {
      window.__gazeaac = window.__gazeaac ?? {}
      window.__gazeaac.quizSchedule = quizSchedule
    }
  }, [quizSchedule])

  const puzzleQuestionsRef = useRef([])
  useEffect(() => {
    puzzleQuestionsRef.current = puzzleQuestions
  }, [puzzleQuestions])

  // Answer-gate ring progress per choice (for circular animation)
  const [answerRingProgress, setAnswerRingProgress] = useState({}) // { [idx]: 0-1 }

  // TTS underline tracking — which item is currently being spoken
  // null = nothing, 'question' = question text, number = choice index
  const [ttsReadingTarget, setTtsReadingTarget] = useState(null)
  const ttsReadingTimersRef = useRef([])  // timeout IDs so we can cancel
  const ttsChoiceQueueRef = useRef([])    // queue of pending choice objects { text, index }
  const currentTtsIndexRef = useRef(null) // active index currently speaking
  const spokenChoicesRef = useRef({})     // keeps track of which choices have already been spoken
  const isSpeakingQuestionRef = useRef(false)
  const isQuestionVoiceOverCompletedRef = useRef(false)
  const isAnswerGateStartedRef = useRef(false)
  const questionTtsTimeoutRef = useRef(null)
  const choicesDelayTimeoutRef = useRef(null)
  const pendingChoicesRef = useRef(null)
  const questionVoiceOverEndTimeRef = useRef(null)

  // YouTube player ref
  const playerRef       = useRef(null)
  const playerReadyRef  = useRef(false)
  const iframeRef       = useRef(null)
  const playerWrapRef    = useRef(null)  // stable ref to the wrapper div; survives YT replacing #yt-player

  // Gaze tracking refs (kept for gaze-away and no-gaze detection)
  const gazeAwayStart      = useRef(null)
  const gazeNoDataStart    = useRef(null)    // tracks when gaze data stopped arriving
  const gazedAwayRef       = useRef(false)   // mirrors gazedAway state; read inside gaze handler
  const pausedByGazeRef    = useRef(false)   // true if paused by gaze-away or no-gaze
  const lastGazeRef        = useRef({ x: 0.5, y: 0.5 })
  const lastGazeTimeRef    = useRef(performance.now()) // tracks exact timestamp of last valid gaze coordinate
  const handleNoGazeRef    = useRef(null)    // called when eye tracker sends no data
  const gazeNoDataRef      = useRef(false)   // mirrors gazeNoData state; read inside stable handler
  const prevGazeCellRef    = useRef(null)    // tracks previous gaze cell for triggerJumpAhead

  // Gate timers
  const questionGateTimerRef   = useRef(null)
  const answerGateTimerRef     = useRef(null)
  const gateAnimFrameRef       = useRef(null)
  const answerGateAnimFrameRef = useRef(null)
  // Gaze-aware gate tracking refs
  const questionGazeActiveRef  = useRef(false)  // true while gaze is on the question box
  const answerGazeActiveRef    = useRef(false)   // true while gaze is on any answer choice
  const questionGateAccumRef   = useRef(0)       // accumulated ms of on-question gaze
  const answerGateAccumRef     = useRef(0)       // accumulated ms of on-answer gaze
  const questionGateStartRef   = useRef(null)    // timestamp when on-question gaze segment started
  const answerGateStartRef     = useRef(null)    // timestamp when on-answer gaze segment started

  // Refs for manual gate progression
  const startAnswerGateRef     = useRef(null)
  const onDoneRef              = useRef(null)
  const updateQDOMRef          = useRef(null)

  const [selectedProvider, setSelectedProvider] = useState(null)
  const [webviewPreloadPath, setWebviewPreloadPath] = useState('')
  const [webviewDuration, setWebviewDuration] = useState(0)
  const webviewRef = useRef(null)
  const isVideoPlayingRef = useRef(false)
  const webviewDurationRef = useRef(0)
  const documentTitleRef = useRef('')
  const hasScheduledWebviewQuizzesRef = useRef(false)
  const [isWebviewFullscreen, setIsWebviewFullscreen] = useState(false)

  // Fetch resolved preload script path on mount
  useEffect(() => {
    window.gazeAPI?.getWebviewPreloadPath?.().then(p => {
      setWebviewPreloadPath(p)
    })
  }, [])

  // Sync refs to make them readable inside stable callbacks
  useEffect(() => { webviewDurationRef.current = webviewDuration }, [webviewDuration])
  useEffect(() => { isVideoPlayingRef.current = isVideoPlaying }, [isVideoPlaying])

  // ── executeJavaScript / chrome polling — primary mechanism for video state ────
  // Polls the webview's or external Chrome's video element every 500 ms.
  useEffect(() => {
    const isWebviewProvider = selectedVideo?.provider === 'netflix' ||
                              selectedVideo?.provider === 'disney'  ||
                              selectedVideo?.provider === 'youtube'
    if (!isWebviewProvider || phase === 'browse') return

    const poll = setInterval(async () => {
      try {
        let s = null
        if (webviewRef.current) {
          s = await webviewRef.current.executeJavaScript(`(function(){
            const v = document.querySelector('video');
            if (!v) return { p: false, t: 0, d: 0, e: false, u: location.href, n: document.title };
            return { p: !v.paused && !v.ended, t: v.currentTime, d: v.duration || 0, e: v.ended, u: location.href, n: document.title };
          })()`)
        } else if (window.gazeAPI?.chromeVideoStatus) {
          const status = await window.gazeAPI.chromeVideoStatus()
          if (status) {
            s = {
              p: status.isPlaying,
              t: status.currentTime,
              d: status.duration,
              e: status.ended,
              u: status.url,
              n: status.documentTitle
            }
          }
        }

        if (!s) return
        const isPlaying = !!s.p

        // Force pause if the video is playing during a quiz phase
        if ((phase === 'prewatch' || phase === 'puzzle') && isPlaying) {
          console.log(`[MovieTime] Video is playing during quiz phase (${phase}) — pausing immediately.`)
          try {
            if (webviewRef.current) {
              webviewRef.current.send('control-video', 'pause')
            } else {
              window.gazeAPI?.chromeControlVideo?.('pause')
            }
          } catch (_) {}
          setIsVideoPlaying(false)
          isVideoPlayingRef.current = false
          return
        }

        setIsVideoPlaying(isPlaying)
        isVideoPlayingRef.current = isPlaying
        if (s.t > 0) savedTimeRef.current = s.t
        if (s.n) documentTitleRef.current = s.n
        if (s.d > 0 && Math.abs(s.d - webviewDurationRef.current) > 5) setWebviewDuration(s.d)
        if (s.e) onVideoEndedRef.current?.()

        // Check if we should trigger pre-watch quiz for webview / chrome video
        if (
          phase === 'watching' &&
          s.u &&
          s.u !== lastPrewatchUrlRef.current &&
          isWebviewVideoUrl(s.u, selectedVideo?.provider)
        ) {
          if (settings.movieTimeQuizRequirePrewatch ?? true) {
            triggerWebviewPrewatch(s.u, s.d)
          } else {
            lastPrewatchUrlRef.current = s.u
          }
        }
      } catch (_) {
        // Webview or Chrome might be navigating or not ready — silently skip
      }
    }, 500)

    return () => clearInterval(poll)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVideo?.provider, selectedVideo?.id, phase, settings.movieTimeQuizRequirePrewatch])

  const enabledProviders = useMemo(() => {
    const list = []
    if (settings.movieTimeProviderYoutube !== false) {
      list.push('suggested')
      list.push('youtube')
    }
    if (settings.movieTimeProviderNetflix ?? true) list.push('netflix')
    if (settings.movieTimeProviderDisney ?? true) list.push('disney')
    return list
  }, [settings.movieTimeProviderYoutube, settings.movieTimeProviderNetflix, settings.movieTimeProviderDisney])

  useEffect(() => {
    if (!selectedProvider) {
      if (enabledProviders.length === 1) {
        setSelectedProvider(enabledProviders[0])
      } else if (enabledProviders.length === 0) {
        setSelectedProvider('youtube')
      }
    }
  }, [enabledProviders, selectedProvider])

  // Sync selectedProvider to mock selectedVideo for Netflix/Disney+/YouTube webview
  useEffect(() => {
    setIsWebviewFullscreen(false)
    if (selectedProvider === 'netflix' || selectedProvider === 'disney' || selectedProvider === 'youtube') {
      const video = {
        id: selectedProvider,
        title: selectedProvider === 'netflix' ? 'Netflix' : (selectedProvider === 'disney' ? 'Disney+' : 'YouTube'),
        provider: selectedProvider
      }
      setSelectedVideo(video)
      hasScheduledWebviewQuizzesRef.current = false
      setWebviewDuration(0)
      setPhase('watching')
      lastPrewatchUrlRef.current = ''
    } else if (selectedProvider === 'suggested') {
      setSelectedVideo(null)
      setPhase('browse')
    } else if (!selectedProvider) {
      setSelectedVideo(null)
      setPhase('browse')
    }
  }, [selectedProvider])

  // Spawn external Chrome and configure transparency overlay mode on selectedProvider changes
  useEffect(() => {
    if (selectedProvider === 'netflix' || selectedProvider === 'disney' || selectedProvider === 'youtube') {
      const url = selectedProvider === 'netflix'
        ? 'https://www.netflix.com'
        : selectedProvider === 'disney'
        ? 'https://www.disneyplus.com'
        : 'https://www.youtube.com'
      
      console.log(`[MovieTime] Launching Chrome for provider ${selectedProvider}...`)

      window.gazeAPI?.launchChrome?.(url).then(({ ok, error }) => {
        if (!ok) {
          alert(`Failed to launch browser: ${error || 'Unknown error'}`)
          setSelectedProvider(null)
          return
        }
        window.gazeAPI?.enterOverlayMode?.()
        onSetOverlayActive?.(true)
      })
    } else {
      window.gazeAPI?.closeChrome?.()
      window.gazeAPI?.exitOverlayMode?.()
      onSetOverlayActive?.(false)
    }

    return () => {
      window.gazeAPI?.closeChrome?.()
      window.gazeAPI?.exitOverlayMode?.()
      onSetOverlayActive?.(false)
    }
  }, [selectedProvider])

  // Safety exit if browser is closed externally by user/caregiver
  useEffect(() => {
    if (!window.gazeAPI) return
    const clean = window.gazeAPI.onChromeExited(() => {
      console.log('[MovieTime] Chrome exited externally. Cleaning up overlay.')
      setSelectedProvider(null)
      setIsVideoPlaying(false)
      onSetOverlayActive?.(false)
      window.gazeAPI.exitOverlayMode()
    })
    return clean
  }, [onSetOverlayActive])

  // Manage screen-wide dwell click state dynamically based on video playback
  useEffect(() => {
    // Screen-wide dwell click is disabled entirely for YouTube, Netflix, and Disney provider modes
    const shouldEnable = false
    
    if (shouldEnable) {
      console.log('[MovieTime] Overlay active and not playing video — enabling screen-wide dwell click')
      setScreenDwellClickEnabled?.(true, (x, y) => {
        window.gazeAPI?.simulateClick?.(x, y)
      })
    } else {
      console.log('[MovieTime] Disabling screen-wide dwell click')
      setScreenDwellClickEnabled?.(false)
    }
    
    return () => {
      setScreenDwellClickEnabled?.(false)
    }
  }, [selectedProvider, phase, isVideoPlaying, setScreenDwellClickEnabled])

  // Manage window click-through state dynamically based on streaming phase
  useEffect(() => {
    const isWebviewVideo = selectedVideo && (selectedVideo.provider === 'netflix' || selectedVideo.provider === 'disney' || selectedVideo.provider === 'youtube')
    if (phase === 'watching' && isWebviewVideo) {
      window.gazeAPI?.setIgnoreMouseEvents?.(true, { forward: true })
    } else {
      window.gazeAPI?.setIgnoreMouseEvents?.(false)
    }
    return () => {
      window.gazeAPI?.setIgnoreMouseEvents?.(false)
    }
  }, [phase, selectedVideo])

  // Setup playerRef.current mock for Netflix/Disney+/YouTube webview / external Chrome
  useEffect(() => {
    if (selectedVideo && (selectedVideo.provider === 'netflix' || selectedVideo.provider === 'disney' || selectedVideo.provider === 'youtube')) {
      playerRef.current = {
        pauseVideo: () => {
          try {
            if (webviewRef.current) {
              webviewRef.current.send('control-video', 'pause')
            } else {
              window.gazeAPI?.chromeControlVideo?.('pause')
            }
          } catch (_) {}
        },
        playVideo: () => {
          try {
            if (webviewRef.current) {
              webviewRef.current.send('control-video', 'play')
            } else {
              window.gazeAPI?.chromeControlVideo?.('play')
            }
          } catch (_) {}
        },
        getPlayerState: () => {
          return isVideoPlayingRef.current ? 1 : 2; // 1 = playing, 2 = paused
        },
        getCurrentTime: () => {
          return savedTimeRef.current || 0;
        },
        getDuration: () => {
          return webviewDurationRef.current || 0;
        },
        seekTo: (seconds) => {
          savedTimeRef.current = seconds;
        },
        destroy: () => {
          // No-op
        }
      };
      playerReadyRef.current = true;
    }
  }, [selectedVideo]);

  // Setup Webview IPC message listener callback ref
  const handleIpcRef = useRef(null)
  handleIpcRef.current = (e) => {
    if (e.channel === 'video-status') {
      const { isPlaying, currentTime, duration, ended, documentTitle, url } = e.args[0]
      setIsVideoPlaying(isPlaying)
      isVideoPlayingRef.current = isPlaying
      savedTimeRef.current = currentTime
      documentTitleRef.current = documentTitle || ''

      if (duration > 0 && Math.abs(duration - webviewDurationRef.current) > 10) {
        setWebviewDuration(duration)
      }

      if (ended) {
        onVideoEndedRef.current?.()
      }

      // Check if we should trigger pre-watch quiz for webview video
      if (
        phase === 'watching' &&
        url &&
        url !== lastPrewatchUrlRef.current &&
        isWebviewVideoUrl(url, selectedVideo?.provider)
      ) {
        if (settings.movieTimeQuizRequirePrewatch ?? true) {
          triggerWebviewPrewatch(url, duration)
        } else {
          lastPrewatchUrlRef.current = url
        }
      }
    }
  }

  const handleConsoleRef = useRef(null)
  handleConsoleRef.current = (e) => {
    console.log(`[Webview Console] ▶`, e.message)
  }

  const handleEnterFullscreenRef = useRef(null)
  handleEnterFullscreenRef.current = () => {
    console.log('[MovieTime] Webview entered html-full-screen')
    setIsWebviewFullscreen(true)
  }

  const handleLeaveFullscreenRef = useRef(null)
  handleLeaveFullscreenRef.current = () => {
    console.log('[MovieTime] Webview left html-full-screen')
    setIsWebviewFullscreen(false)
  }

  // Navigate event: fires when webview navigates (main frame or SPA pushState).
  // Used to detect when user selects a video and trigger the pre-watch quiz.
  const handleNavigateRef = useRef(null)
  handleNavigateRef.current = (e) => {
    const url = e.url
    // did-navigate-in-page has isMainFrame; did-navigate is always main frame
    if (!url || e.isMainFrame === false) return
    if (
      phase === 'watching' &&
      url !== lastPrewatchUrlRef.current &&
      isWebviewVideoUrl(url, selectedVideo?.provider)
    ) {
      if (settings.movieTimeQuizRequirePrewatch ?? true) {
        console.log('[MovieTime] Navigation to video URL detected, triggering pre-watch:', url)
        triggerWebviewPrewatch(url, 0)
      } else {
        lastPrewatchUrlRef.current = url
      }
    }
  }

  // ── Stable wrappers ────────────────────────────────────────────────────────
  // Event listeners must be attached with a STABLE function reference so that
  // removeEventListener can find and remove the exact same function object.
  // But each handler closes over React state; attaching the raw ref.current
  // would capture a stale closure from mount time.
  // Solution: create one stable wrapper per handler (using useRef so it's only
  // created once), and have it delegate to the LATEST handler via the ref.
  // This means addEventListener/removeEventListener see the same object while
  // the actual logic always runs with the current render's closures.
  const _stableIpcWrap      = useRef((e) => handleIpcRef.current?.(e))
  const _stableConsoleWrap  = useRef((e) => handleConsoleRef.current?.(e))
  const _stableEnterFsWrap  = useRef(() => handleEnterFullscreenRef.current?.())
  const _stableLeaveFsWrap  = useRef(() => handleLeaveFullscreenRef.current?.())
  const _stableNavWrap      = useRef((e) => handleNavigateRef.current?.(e))

  const setWebviewRef = useCallback((node) => {
    if (webviewRef.current) {
      try {
        webviewRef.current.removeEventListener('ipc-message',             _stableIpcWrap.current)
        webviewRef.current.removeEventListener('console-message',         _stableConsoleWrap.current)
        webviewRef.current.removeEventListener('enter-html-full-screen',  _stableEnterFsWrap.current)
        webviewRef.current.removeEventListener('leave-html-full-screen',  _stableLeaveFsWrap.current)
        webviewRef.current.removeEventListener('did-navigate',            _stableNavWrap.current)
        webviewRef.current.removeEventListener('did-navigate-in-page',    _stableNavWrap.current)
      } catch (_) {}
    }
    webviewRef.current = node
    if (node) {
      node.addEventListener('ipc-message',            _stableIpcWrap.current)
      node.addEventListener('console-message',        _stableConsoleWrap.current)
      node.addEventListener('enter-html-full-screen', _stableEnterFsWrap.current)
      node.addEventListener('leave-html-full-screen', _stableLeaveFsWrap.current)
      node.addEventListener('did-navigate',           _stableNavWrap.current)
      node.addEventListener('did-navigate-in-page',   _stableNavWrap.current)
    }
  }, [])

  const handleBack = useCallback(() => {
    const enabledCount = enabledProviders.length;
    if (selectedProvider && enabledCount > 1) {
      setSelectedProvider(null);
      try { playerRef.current?.destroy() } catch (_) {}
      playerRef.current = null;
      playerReadyRef.current = false;
      setIsVideoPlaying(false);
      setSelectedVideo(null);
      setPhase('browse');
    } else {
      onBack();
    }
  }, [selectedProvider, enabledProviders, onBack]);
  const updateADOMRef          = useRef(null)

  // ── Video Selection Gate (browse phase) ─────────────────────────────────
  // Gaze must accumulate on any video card for selectionGateMs before selection is enabled
  const [selectionGatePassed,   setSelectionGatePassed]   = useState(false)  // true once gate completes
  const [selectionGateProgress, setSelectionGateProgress] = useState(0)      // 0-1
  const [selectionGateEpoch,    setSelectionGateEpoch]    = useState(0)       // increments to restart RAF loop
  const selectionGazeActiveRef  = useRef(false)  // true while gaze is on any video card
  const selectionGateAccumRef   = useRef(0)       // accumulated ms of on-card gaze
  const selectionGateStartRef   = useRef(null)    // timestamp when current on-card gaze segment started
  const selectionGateRafRef     = useRef(null)    // rAF handle
  const selectionGateFillRef    = useRef(null)    // direct DOM ref for smooth width updates

  // Voice-over TTS queue ref
  const voiceOverQueueRef = useRef(null)

  // Puzzle interval ref
  const puzzleIntervalRef = useRef(null)
  const puzzleTimerRef    = useRef(null)
  const nextPuzzleConfirmTimerRef = useRef(null) // auto-reset timeout for the primed button

  // Track previously asked questions to avoid repetition (loaded from persistent settings/localStorage)
  const askedQuestionsRef = useRef((() => {
    let rawQuestions = [];
    if (settings.movieTimeAskedQuestions && settings.movieTimeAskedQuestions.length > 0) {
      rawQuestions = settings.movieTimeAskedQuestions;
    } else {
      try {
        const raw = localStorage.getItem('movieTimeAskedQuestions');
        rawQuestions = raw ? JSON.parse(raw) : [];
      } catch (_) {}
    }
    // Normalize to: { question, sessionId, timestamp }
    return (Array.isArray(rawQuestions) ? rawQuestions : []).map(item => {
      if (typeof item === 'string') {
        return { question: item, sessionId: 'legacy', timestamp: Date.now() };
      }
      return item;
    });
  })())

  // Keep ref in sync when settings sync in from the cloud (merging to prevent losing locally generated questions during rendering race conditions)
  useEffect(() => {
    if (settings.movieTimeAskedQuestions) {
      const existingMap = new Map(askedQuestionsRef.current.map(q => [q.question, q]))
      settings.movieTimeAskedQuestions.forEach(item => {
        const norm = typeof item === 'string' ? { question: item, sessionId: 'legacy', timestamp: Date.now() } : item
        if (norm?.question && !existingMap.has(norm.question)) {
          existingMap.set(norm.question, norm)
        }
      })
      askedQuestionsRef.current = Array.from(existingMap.values())
    }
  }, [settings.movieTimeAskedQuestions])

  // Saved playback position – set from getCurrentTime() right before quiz fires
  // so that after the quiz we seek back to the exact video frame.
  const savedTimeRef = useRef(0)

  // Local session-level cache for video transcripts and metadata
  const transcriptCache = useRef({})

  const fetchYoutubeTranscriptAndMetadata = useCallback(async (videoId) => {
    if (!videoId) return null
    if (transcriptCache.current[videoId]) {
      return transcriptCache.current[videoId]
    }
    try {
      console.log(`[MovieTime] Fetching transcript and metadata for YouTube video ID: ${videoId}`)
      let html = ''
      if (window.gazeAPI?.fetchUrl) {
        const res = await window.gazeAPI.fetchUrl(`https://www.youtube.com/watch?v=${videoId}`)
        if (!res.ok) throw new Error(res.error)
        html = res.text
      } else {
        const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          }
        })
        if (!response.ok) throw new Error(`Failed to fetch video page: ${response.status}`)
        html = await response.text()
      }

      let playerResponse = null
      const patterns = [
        /ytInitialPlayerResponse\s*=\s*({.+?});/,
        /ytInitialPlayerResponse\s*=\s*({.+?})\s*;/s,
        /window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/,
        /ytInitialPlayerResponse\s*=\s*({.+?})\s*<\/script>/s
      ]
      for (const pattern of patterns) {
        const match = html.match(pattern)
        if (match) {
          try {
            playerResponse = JSON.parse(match[1])
            break
          } catch (e) {
            console.warn('[MovieTime] JSON parsing of playerResponse failed:', e)
          }
        }
      }

      const title = playerResponse?.videoDetails?.title || ''
      const author = playerResponse?.videoDetails?.author || ''
      const description = playerResponse?.videoDetails?.shortDescription || ''
      const keywords = playerResponse?.videoDetails?.keywords || []

      let transcriptText = ''
      let timedTranscript = []
      const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (captionTracks && captionTracks.length > 0) {
        const englishTrack = captionTracks.find(t => t.languageCode === 'en' || t.languageCode?.startsWith('en')) || captionTracks[0]
        const baseUrl = englishTrack.baseUrl
        if (baseUrl) {
          let capUrl = baseUrl
          if (capUrl.includes('fmt=')) {
            capUrl = capUrl.replace(/fmt=[^&]+/, 'fmt=json3')
          } else {
            capUrl += '&fmt=json3'
          }

          try {
            let capText = ''
            if (window.gazeAPI?.fetchUrl) {
              const capRes = await window.gazeAPI.fetchUrl(capUrl)
              if (capRes.ok) capText = capRes.text
            } else {
              const capRes = await fetch(capUrl)
              if (capRes.ok) capText = await capRes.text()
            }
            if (capText) {
              const capData = JSON.parse(capText)
              if (capData.events) {
                const segments = []
                transcriptText = capData.events
                  .map(ev => {
                    const text = ev.segs ? ev.segs.map(seg => seg.utf8 || '').join('') : ''
                    if (text.trim() && ev.tStartMs != null) {
                      segments.push({ startMs: ev.tStartMs, text: text.trim() })
                    }
                    return text
                  })
                  .filter(Boolean)
                  .join(' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                timedTranscript = segments
              }
            }
          } catch (e) {
            console.warn('[MovieTime] JSON3 fetch failed, attempting XML fallback:', e)
            try {
              let xmlText = ''
              if (window.gazeAPI?.fetchUrl) {
                const xmlRes = await window.gazeAPI.fetchUrl(baseUrl)
                if (xmlRes.ok) xmlText = xmlRes.text
              } else {
                const xmlRes = await fetch(baseUrl)
                if (xmlRes.ok) xmlText = await xmlRes.text()
              }
              if (xmlText) {
                const parser = new DOMParser()
                const doc = parser.parseFromString(xmlText, 'text/xml')
                const textNodes = doc.getElementsByTagName('text')
                const xmlSegments = []
                transcriptText = Array.from(textNodes)
                  .map(node => {
                    const text = node.textContent || ''
                    const startAttr = node.getAttribute('start')
                    if (text.trim() && startAttr != null) {
                      xmlSegments.push({ startMs: Math.round(parseFloat(startAttr) * 1000), text: text.trim() })
                    }
                    return text
                  })
                  .join(' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                if (timedTranscript.length === 0) timedTranscript = xmlSegments
              }
            } catch (xmlErr) {
              console.error('[MovieTime] XML fallback transcript fetch failed:', xmlErr)
            }
          }
        }
      }

      const result = { title, author, description, keywords, transcript: transcriptText, timedTranscript }
      transcriptCache.current[videoId] = result
      return result
    } catch (err) {
      console.error('[MovieTime] fetchYoutubeTranscriptAndMetadata failed:', err)
      return null
    }
  }, [])

  // Stable ref for the video-ended callback (avoids stale closures in YT player events)
  const onVideoEndedRef = useRef(null)

  // Gear / settings popover
  const [showGearPopover, setShowGearPopover] = useState(false)
  const gearContainerRef = useRef(null)

  useEffect(() => {
    if (!showGearPopover) return
    const handleOutsideClick = (e) => {
      if (gearContainerRef.current && !gearContainerRef.current.contains(e.target)) {
        setShowGearPopover(false)
      }
    }
    document.addEventListener('click', handleOutsideClick)
    return () => {
      document.removeEventListener('click', handleOutsideClick)
    }
  }, [showGearPopover])

  // Tracks whether the gaze cursor should be suppressed


  // Element refs for gaze dwell
  const backBtnRef        = useRef(null)
  const settingsBtnRef    = useRef(null)
  const refreshBtnRef     = useRef(null)
  const topbarObserverRef = useRef(null)
  const topbarRef = useCallback((node) => {
    if (topbarObserverRef.current) {
      topbarObserverRef.current.disconnect()
      topbarObserverRef.current = null
    }
    if (node) {
      const root = node.closest('.movie-time')
      if (root) {
        const sync = () => {
          const h = node.offsetHeight
          root.style.setProperty('--mq-topbar-offset', `${h}px`)
          setTopbarHeight(h)
        }
        sync()
        const ro = new ResizeObserver(sync)
        ro.observe(node)
        topbarObserverRef.current = ro
      }
    }
  }, [])
  const videoCardRefs     = useRef({})
  const puzzleChoiceRefs  = useRef({})
  const puzzleQuestionRef = useRef(null)   // ref for the question text box (gaze-gate target)

  // DOM refs for smooth question/answer progress bar animations
  const gateProgressFillRef        = useRef(null) // thin top-edge question bar
  const gateProgressProminentRef   = useRef(null) // prominent question bar
  const gateProgressPctRef         = useRef(null) // question percentage label
  const answerProgressFillRef      = useRef(null) // thin top-edge answer bar
  const answerProgressProminentRef = useRef(null) // prominent answer bar
  const answerProgressPctRef       = useRef(null) // answer percentage label

  // Gaze dwell state
  const [gazeState, setGazeState] = useState({ target: null, progress: 0 })

  // Sync internal gazeState from parent router's gazeState
  useEffect(() => {
    if (!parentGazeState) return
    setGazeState({
      target: parentGazeState.cellId,
      progress: parentGazeState.dwellProgress
    })
  }, [parentGazeState])

  const dwellMs = settings.dwellMs ?? 800

  // ── Web Audio – sound effects ─────────────────────────────────────────────
  const audioCtxRef = useRef(null)

  const playSoundEffect = useCallback((type) => {
    if (type !== 'click' && !(settings.movieTimeQuizSoundEffects ?? true)) return
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
      }
      const ctx = audioCtxRef.current
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})

      const now = ctx.currentTime
      const masterGain = ctx.createGain()
      masterGain.connect(ctx.destination)

      if (type === 'correct') {
        // Rising arpeggio: C5 → E5 → G5, sine, 0.45 s total
        const notes = [523.25, 659.25, 783.99]
        notes.forEach((freq, i) => {
          const osc = ctx.createOscillator()
          const g   = ctx.createGain()
          osc.type = 'sine'
          osc.frequency.value = freq
          const t = now + i * 0.12
          g.gain.setValueAtTime(0.0001, t)
          g.gain.linearRampToValueAtTime(0.45, t + 0.04)
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15)
          osc.connect(g)
          g.connect(ctx.destination)
          osc.start(t)
          osc.stop(t + 0.16)
        })
      } else if (type === 'wrong') {
        // Descending "bwamp": G4 → D4, sawtooth, 0.35 s
        const osc = ctx.createOscillator()
        const g   = ctx.createGain()
        osc.type = 'sawtooth'
        osc.frequency.setValueAtTime(392, now)
        osc.frequency.exponentialRampToValueAtTime(146.83, now + 0.35)
        g.gain.setValueAtTime(0.35, now)
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.35)
        osc.connect(g)
        g.connect(ctx.destination)
        osc.start(now)
        osc.stop(now + 0.36)
      } else if (type === 'click') {
        // Synthesize a clean, sharp digital click
        const osc = ctx.createOscillator()
        const g   = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(1200, now)
        osc.frequency.exponentialRampToValueAtTime(120, now + 0.04)

        g.gain.setValueAtTime(0, now)
        g.gain.linearRampToValueAtTime(0.2, now + 0.003)
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.04)

        osc.connect(g)
        g.connect(ctx.destination)
        osc.start(now)
        osc.stop(now + 0.05)
      }
    } catch (e) {
      console.warn('[MovieTime] Sound effect failed:', e)
    }
  }, [settings.movieTimeQuizSoundEffects])

  // ── TTS voice-over helpers ────────────────────────────────────────────────
  const speakText = useCallback((text) => {
    if (!text) return
    window.__ttsEndTime = Date.now() + text.length * 75 + 1000
    window.gazeAPI?.speak(text)
  }, [])

  // Clear all pending TTS underline timers
  const clearTtsTimers = useCallback(() => {
    ttsReadingTimersRef.current.forEach(id => clearTimeout(id))
    ttsReadingTimersRef.current = []
    setTtsReadingTarget(null)
    currentTtsIndexRef.current = null
    ttsChoiceQueueRef.current = []
    isQuestionVoiceOverCompletedRef.current = false
    isAnswerGateStartedRef.current = false

    if (questionTtsTimeoutRef.current) {
      clearTimeout(questionTtsTimeoutRef.current)
      questionTtsTimeoutRef.current = null
    }
    if (choicesDelayTimeoutRef.current) {
      clearTimeout(choicesDelayTimeoutRef.current)
      choicesDelayTimeoutRef.current = null
    }
    if (voiceOverQueueRef.current) {
      clearTimeout(voiceOverQueueRef.current)
      voiceOverQueueRef.current = null
    }
  }, [])

  // Sequentially speak the next item from our unified queue
  const speakNextFromQueue = useCallback(() => {
    if (ttsChoiceQueueRef.current.length === 0) {
      setTtsReadingTarget(null)
      currentTtsIndexRef.current = null
      return
    }

    const next = ttsChoiceQueueRef.current.shift()
    currentTtsIndexRef.current = next.target
    setTtsReadingTarget(next.target)

    speakText(next.text)

    // Fallback timer: in case the native speech completion event is lost, not supported,
    // or when we are running with mock trackers on non-supported environments.
    const fallbackMs = next.text.length * 90 + 3000
    if (voiceOverQueueRef.current) clearTimeout(voiceOverQueueRef.current)
    voiceOverQueueRef.current = setTimeout(() => {
      handleTtsItemFinished(next.target)
    }, fallbackMs)
  }, [speakText])

  // Handles completion of active sequential queue item (both native completion and fallback timer)
  const handleTtsItemFinished = useCallback((target) => {
    if (currentTtsIndexRef.current !== target) return

    setTtsReadingTarget(null)
    currentTtsIndexRef.current = null

    if (voiceOverQueueRef.current) {
      clearTimeout(voiceOverQueueRef.current)
      voiceOverQueueRef.current = null
    }

    const pauseMs = settings.movieTimeQuizVoiceOverPauseMs ?? 500;

    // Schedule next item to play after an adjustable pause
    if (target === 'question') {
      isQuestionVoiceOverCompletedRef.current = true
      if (ttsChoiceQueueRef.current.length > 0) {
        if (isAnswerGateStartedRef.current) {
          if (choicesDelayTimeoutRef.current) clearTimeout(choicesDelayTimeoutRef.current)
          choicesDelayTimeoutRef.current = setTimeout(() => {
            speakNextFromQueue()
          }, pauseMs)
        }
      }
    } else {
      if (ttsChoiceQueueRef.current.length > 0) {
        if (choicesDelayTimeoutRef.current) clearTimeout(choicesDelayTimeoutRef.current)
        choicesDelayTimeoutRef.current = setTimeout(() => {
          speakNextFromQueue()
        }, pauseMs)
      }
    }
  }, [speakNextFromQueue, settings.movieTimeQuizVoiceOverPauseMs])

  // Setup the entire sequential speech queue (question + choices) and kick it off
  const speakPuzzleVoiceOver = useCallback((question, choices) => {
    if (!(settings.movieTimeQuizVoiceOver ?? true)) return
    clearTtsTimers()
    if (voiceOverQueueRef.current) clearTimeout(voiceOverQueueRef.current)

    const queue = []
    queue.push({ text: question, target: 'question' })

    if (settings.movieTimeQuizVoiceOverChoices ?? true) {
      if (choices && choices.length > 0) {
        choices.forEach((choice, idx) => {
          queue.push({ text: choice, target: idx })
        })
      }
    }

    ttsChoiceQueueRef.current = queue
    speakNextFromQueue()
  }, [settings.movieTimeQuizVoiceOver, settings.movieTimeQuizVoiceOverChoices, clearTtsTimers, speakNextFromQueue])

  // triggerJumpAhead is disabled to make puzzle voice-overs completely deterministic and immune to gaze/focus/hover
  const triggerJumpAhead = useCallback((choiceIdx) => {
    // Disabled intentionally: voiceover is fully deterministic and sequential
  }, [])

  // Subscribe to native speech completion events from the main process
  useEffect(() => {
    if (!window.gazeAPI?.onTtsCompleted) return

    const unsubscribe = window.gazeAPI.onTtsCompleted(() => {
      // Real speech completed!
      if (currentTtsIndexRef.current !== null) {
        handleTtsItemFinished(currentTtsIndexRef.current)
      }
    })

    return () => unsubscribe()
  }, [handleTtsItemFinished])

  // ── Gate logic helpers ────────────────────────────────────────────────────
  // Gaze-aware gates:
  //   questionGate: only progresses while gaze is on the question box
  //   answerGate:   only progresses while gaze is on any answer choice
  // setQGate, setAGate, setQProgress, setAProgress = state setters
  // onAnswerGateStart = called when answer gate begins (use for answer TTS)
  // onDone = called when both gates expire (dwell fully unlocked)
  const runGates = useCallback((questionGateMs, answerGateMs, setQGate, setAGate, setQProgress, setAProgress, onDone, onAnswerGateStart) => {
    // Clear previous animation frames / timers
    if (questionGateTimerRef.current)   { cancelAnimationFrame(questionGateTimerRef.current); questionGateTimerRef.current = null }
    if (answerGateTimerRef.current)     { cancelAnimationFrame(answerGateTimerRef.current);   answerGateTimerRef.current = null }
    if (gateAnimFrameRef.current)       { cancelAnimationFrame(gateAnimFrameRef.current); gateAnimFrameRef.current = null }
    if (answerGateAnimFrameRef.current) { cancelAnimationFrame(answerGateAnimFrameRef.current); answerGateAnimFrameRef.current = null }

    // Reset gaze-tracking refs
    questionGazeActiveRef.current = false
    answerGazeActiveRef.current   = false
    questionGateAccumRef.current  = 0
    answerGateAccumRef.current    = 0
    questionGateStartRef.current  = null
    answerGateStartRef.current    = null

    setQGate(true)
    setAGate(false)
    setQProgress(0)
    setAProgress(0)

    const updateQDOM = (pct) => {
      const wStr = `${pct * 100}%`
      const tStr = `${Math.round(pct * 100)}%`
      if (gateProgressFillRef.current) gateProgressFillRef.current.style.width = wStr
      if (gateProgressProminentRef.current) gateProgressProminentRef.current.style.width = wStr
      if (gateProgressPctRef.current) gateProgressPctRef.current.textContent = tStr
    }

    const updateADOM = (pct) => {
      const wStr = `${pct * 100}%`
      const tStr = `${Math.round(pct * 100)}%`
      if (answerProgressFillRef.current) answerProgressFillRef.current.style.width = wStr
      if (answerProgressProminentRef.current) answerProgressProminentRef.current.style.width = wStr
      if (answerProgressPctRef.current) answerProgressPctRef.current.textContent = tStr
    }

    updateQDOMRef.current = updateQDOM
    updateADOMRef.current = updateADOM
    onDoneRef.current      = onDone

    // Initialize DOM progress bars to 0
    requestAnimationFrame(() => {
      updateQDOM(0)
      updateADOM(0)
    })

    const startAnswerGate = () => {
      onAnswerGateStart?.()   // fire answer TTS now that answer gate begins
      if (answerGateMs <= 0) {
        setAGate(false)
        onDone?.()
        return
      }
      setAGate(true)
      answerGateAccumRef.current  = 0
      answerGateStartRef.current  = null
      answerGazeActiveRef.current = false

      // Make sure DOM reset happens immediately on gate start
      requestAnimationFrame(() => {
        updateADOM(0)
      })

      const aTick = (ts) => {
        if (answerGazeActiveRef.current) {
          if (answerGateStartRef.current == null) answerGateStartRef.current = ts
          answerGateAccumRef.current += ts - answerGateStartRef.current
          answerGateStartRef.current = ts
        } else {
          answerGateStartRef.current = null
        }
        const ap = Math.min(answerGateAccumRef.current / answerGateMs, 1)
        updateADOM(ap)
        if (ap < 1) {
          answerGateAnimFrameRef.current = requestAnimationFrame(aTick)
        } else {
          setAGate(false)
          setAProgress(0)
          onDone?.()
        }
      }
      answerGateAnimFrameRef.current = requestAnimationFrame(aTick)
    }

    startAnswerGateRef.current = startAnswerGate

    if (questionGateMs === 'click') {
      setQGate(true)
      setQProgress(0)
      updateQDOM(0)
      return
    }

    if (questionGateMs <= 0) {
      // Skip question gate — immediately run answer gate
      setQGate(false)
      startAnswerGate()
      return
    }

    // ── Question gate: accumulate time while gaze is on question box ──
    const qTick = (ts) => {
      if (questionGazeActiveRef.current) {
        if (questionGateStartRef.current == null) questionGateStartRef.current = ts
        questionGateAccumRef.current += ts - questionGateStartRef.current
        questionGateStartRef.current = ts
      } else {
        questionGateStartRef.current = null
      }
      const p = Math.min(questionGateAccumRef.current / questionGateMs, 1)
      updateQDOM(p)
      if (p < 1) {
        gateAnimFrameRef.current = requestAnimationFrame(qTick)
      } else {
        // Question gate done — move to answer gate
        setQGate(false)
        setQProgress(1)
        startAnswerGate()
      }
    }
    gateAnimFrameRef.current = requestAnimationFrame(qTick)
  }, [])


  // ── YouTube Data API v3 fetch ─────────────────────────────────────────────

  // Helper: search YouTube for a single query, returns up to `max` raw items
  const _ytSearch = async (apiKey, q, safeSearch, duration, max, videoDefinition, order, relevanceLanguage) => {
    const params = new URLSearchParams({
      part:        'snippet',
      type:        'video',
      q,
      safeSearch,
      maxResults:  max,
      key:         apiKey,
      fields:      'items(id/videoId,snippet(title,channelTitle,thumbnails/high))',
    })
    if (duration)          params.set('videoDuration', duration)
    if (videoDefinition)   params.set('videoDefinition', videoDefinition)
    if (order)             params.set('order', order)
    if (relevanceLanguage) params.set('relevanceLanguage', relevanceLanguage)

    // ── Debug: log outgoing search parameters ──────────────────────────────
    const debugParams = Object.fromEntries(params.entries())
    const debugParamsSafe = { ...debugParams, key: `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}` }
    console.log('[MovieTime][YT Search] ▶ Sending request:', debugParamsSafe)
    console.log('[MovieTime][YT Search] ▶ Full URL (key redacted):',
      `https://www.googleapis.com/youtube/v3/search?${new URLSearchParams(debugParamsSafe)}`)

    const res  = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`)
    const data = await res.json()

    if (!res.ok) {
      // ── Debug: log API error ──────────────────────────────────────────────
      console.error('[MovieTime][YT Search] ✖ API error', res.status, data.error)
      // Attach the raw error data so callers can detect quota specifically
      const err = new Error(data.error?.message ?? `HTTP ${res.status}`)
      err.ytError = data.error
      throw err
    }

    // ── Debug: log what came back ─────────────────────────────────────────
    const items = data.items ?? []
    console.log(`[MovieTime][YT Search] ◀ Got ${items.length} result(s) for q="${q}"`,
      items.map(i => i.snippet?.title ?? i.id?.videoId))

    return items
  }

  // ── Cache helpers ─────────────────────────────────────────────────────────
  const _saveCache = (videos) => {
    try {
      localStorage.setItem(_ytCacheKey(), JSON.stringify({ ts: Date.now(), videos }))
    } catch (_) {}
  }

  const _loadCache = () => {
    try {
      const raw = localStorage.getItem(_ytCacheKey())
      if (!raw) return null
      return JSON.parse(raw)   // { ts, videos }
    } catch (_) { return null }
  }

  // Helper to detect quota exceeded errors
  const _isQuotaError = (err) =>
    err?.ytError?.errors?.some(e => e.reason === 'quotaExceeded') ||
    /quota/i.test(err?.message ?? '')

  const fetchVideos = useCallback(async () => {
    // ── "Only from list" mode ──────────────────────────────────────────────
    if (settings.movieTimeOnlyFromList) {
      const list = settings.movieTimeYoutubeUrls ?? []
      const selectedIds = settings.movieTimeSelectedYoutubeVideoIds ?? list.map(v => v.id)
      const activeList = list.filter(v => selectedIds.includes(v.id))

      // Shuffle activeList to provide dynamic options on each entry
      const shuffled = [...activeList]
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      const totalSlots = settings.movieTimeSelectionCount ?? 4
      const sliced = shuffled.slice(0, totalSlots)

      setVideos(sliced.map(v => ({
        id:         v.id,
        title:      v.title ?? v.id,
        channel:    '',
        thumb:      v.thumb ?? `https://img.youtube.com/vi/${v.id}/hqdefault.jpg`,
        duration:   '',
        viewCount:  null,
        likeCount:  null,
        definition: '',
      })))
      setVideosError(null)
      setVideosFromCache(false)
      setCacheTimestamp(null)
      return
    }

    // ── Build ordered key list (new array setting preferred; fall back to legacy single key) ──
    const keyObjects = (settings.movieTimeYoutubeKeys ?? []).filter(k => k?.key?.trim())
    // Legacy fallback: if the new array is empty but the old single key is set, use it
    if (keyObjects.length === 0 && settings.movieTimeYoutubeKey?.trim()) {
      keyObjects.push({ key: settings.movieTimeYoutubeKey.trim(), label: 'Key 1' })
    }

    if (keyObjects.length === 0) {
      setVideosError('no-key')
      setVideosFromCache(false)
      return
    }

    setVideosLoading(true)
    setVideosError(null)
    setVideosFromCache(false)
    setCacheTimestamp(null)

    // ── Build search parameters (shared across all key attempts) ─────────────────
    const topics    = (settings.movieTimeTopics    ?? []).join(' ')
    const whitelist = (settings.movieTimeWhitelist ?? []).join(' ')
    const blacklist = (settings.movieTimeBlacklist ?? []).map(w => `-${w}`).join(' ')
    const gamer     = settings.movieTimeGamerLoophole
      ? 'fan animation let\'s play reaction'
      : ''

    const durationMap  = { any: '', short: 'short', medium: 'medium', long: 'long' }
    const duration     = durationMap[settings.movieTimeDuration ?? 'medium'] || 'medium'
    const safeSearch   = settings.movieTimeSafeSearch ?? 'strict'
    const totalSlots   = settings.movieTimeSelectionCount ?? 6
    const minViews     = settings.movieTimeMinViews ?? 0
    const ytLanguage   = (settings.movieTimeLanguage ?? '').trim()

    // When a minViews filter is active, over-fetch extra candidates so the
    // client-side filter has material to work with even if many results are discarded.
    // Buffer: 3× totalSlots when minViews is set, otherwise exact totalSlots.
    const fetchSlots   = minViews > 0 ? Math.min(totalSlots * 3, 50) : totalSlots

    const qualitySetting  = settings.movieTimeVideoQuality ?? 'any'
    const videoDefinition = (qualitySetting === 'hd' || qualitySetting === 'fhd' || qualitySetting === '4k') ? 'high' : ''
    const qualityKeyword  = qualitySetting === 'fhd' ? '1080p' : qualitySetting === '4k' ? '4K 2160p' : ''

    const baseQ = [topics, whitelist, qualityKeyword, gamer, blacklist].filter(Boolean).join(' ').trim() || 'kids educational'
    const interests = [...(settings.movieTimeInterests ?? [])]

    // ── AI-generated search queries ───────────────────────────────────────────
    // Ask the configured cloud AI to produce specific, diverse YouTube search
    // strings targeting well-known mainstream content for this child. Falls back
    // to the static keyword approach silently if no AI key or if the call fails.
    const geminiKey = settings.geminiApiKey?.trim()
    const openAiKey = settings.openAiApiKey?.trim()
    const cloudProviderOrder = settings.cloudAiProviderOrder ?? ['gemini', 'openai']

    // Build child context for the prompt
    const userProfile   = settings.userProfile ?? {}
    const childName     = userProfile.name  ?? 'the child'
    const childAge      = userProfile.age   ?? ''
    const topicsList    = (settings.movieTimeTopics    ?? []).join(', ') || 'general children\'s content'
    const interestsList = (settings.movieTimeInterests ?? []).join(', ')
    const lifeLore      = settings.contextualLifeLore?.trim() ?? ''
    const blacklistStr  = (settings.movieTimeBlacklist ?? []).join(', ')
    const durationHint  = { short: 'under 4 minutes', medium: '4 to 20 minutes', long: 'over 20 minutes', any: 'any length' }[settings.movieTimeDuration ?? 'medium'] ?? ''
    const langHint      = ytLanguage ? `Prefer ${ytLanguage}-language content.` : ''
    const numQueries    = Math.max(fetchSlots, totalSlots + 3) // ask for a few extra so filter has candidates

    const aiQueryPrompt = `You are helping select YouTube videos for ${childName}${childAge ? `, age ${childAge}` : ''}.
Generate exactly ${numQueries} diverse YouTube search query strings to find popular, mainstream, age-appropriate videos they would enjoy.

Child interests / topics: ${topicsList}${interestsList ? `\nSpecific interests: ${interestsList}` : ''}${lifeLore ? `\nAbout the child: ${lifeLore}` : ''}
Video length preference: ${durationHint}
${langHint}
${blacklistStr ? `Avoid content related to: ${blacklistStr}` : ''}

Rules:
- Each query should target a SPECIFIC well-known show, series, character, or topic (e.g. "Peppa Pig official season 9", "Wild Kratts animal adventures", "CoComelon nursery rhymes 2024")
- Queries must target popular mainstream content likely to have millions of views
- Vary the queries widely — different shows, genres, and topics each time
- DO NOT use generic terms like "kids educational" or "children's video" as the whole query
- DO NOT repeat the same show in multiple queries
- Return ONLY a valid JSON array of ${numQueries} plain search query strings, no markdown, no extra text

Example output: ["Bluey full episode season 4", "National Geographic Kids sharks", "Magic School Bus science experiments", ...]`

    let aiQueries = null
    for (const provider of cloudProviderOrder) {
      const providerKey = provider === 'openai' ? openAiKey : geminiKey
      if (!providerKey) continue
      try {
        let rawText = ''
        if (provider === 'openai') {
          const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${providerKey}` },
            body: JSON.stringify({
              model: settings.openAiModel ?? 'gpt-4o-mini',
              messages: [{ role: 'user', content: aiQueryPrompt }],
              temperature: 1.1,
              max_tokens: 800,
            }),
          })
          if (!res.ok) throw new Error(`OpenAI ${res.status}`)
          const data = await res.json()
          rawText = data.choices?.[0]?.message?.content ?? ''
        } else {
          const model = settings.geminiModel ?? 'gemini-2.5-flash'
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${providerKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: aiQueryPrompt }] }],
                generationConfig: {
                  temperature: 1.1, maxOutputTokens: 800,
                  responseMimeType: 'application/json',
                  responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
                },
              }),
            }
          )
          if (!res.ok) throw new Error(`Gemini ${res.status}`)
          const data = await res.json()
          rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
        }
        // Parse: strip markdown fences then JSON.parse
        const clean = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
        const parsed = JSON.parse(clean)
        if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
          aiQueries = parsed.filter(q => typeof q === 'string' && q.trim().length > 0)
          console.log(`[MovieTime] AI (${provider}) generated ${aiQueries.length} search queries:`, aiQueries)
          break
        }
      } catch (err) {
        console.warn(`[MovieTime] AI query generation failed (${provider}):`, err.message)
      }
    }

    // ── Inner fetch function using a specific API key ──────────────────────────
    const _fetchWithKey = async (apiKey) => {
      let rawItems = []

      if (aiQueries && aiQueries.length > 0) {
        // ── AI-guided path: limit to at most 2 searches to save YouTube API quota ──
        const maxSearchCalls = 2
        const shuffledQueries = [...aiQueries].sort(() => Math.random() - 0.5)
        const queriesToSearch = shuffledQueries.slice(0, maxSearchCalls)
        
        // For each query, fetch more results so we have a diverse and sufficiently large candidate pool
        const resultsPerQuery = Math.max(Math.round(fetchSlots / queriesToSearch.length) * 2, 15)
        
        const queryPromises = queriesToSearch.map(q => {
          const fullQ = [q.trim(), ...( (settings.movieTimeBlacklist ?? []).map(w => `-${w}`) )].filter(Boolean).join(' ')
          return _ytSearch(apiKey, fullQ, safeSearch, duration, resultsPerQuery, videoDefinition, null, ytLanguage)
            .catch(err => { if (_isQuotaError(err)) throw err; return [] })
        })
        const resultsLists = await Promise.all(queryPromises)
        rawItems = resultsLists.flat().filter(Boolean)

        // If AI queries didn't fill all slots, top up with static fallback (at most 1 extra search)
        if (rawItems.length < totalSlots) {
          const fallbackQ = [topics, whitelist, qualityKeyword, gamer, blacklist].filter(Boolean).join(' ').trim() || 'kids educational'
          const fill = await _ytSearch(apiKey, fallbackQ, safeSearch, duration, Math.max(totalSlots * 2, 15), videoDefinition, null, ytLanguage)
            .catch(err => { if (_isQuotaError(err)) throw err; return [] })
          rawItems = [...rawItems, ...fill]
        }
      } else {
        // ── Static fallback path (no AI key or AI call failed) ─────────────────
        if (interests.length > 0) {
          const shuffled = [...interests]
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
          }
          // Limit to at most 2 interest searches to save YouTube API quota
          const maxInterestSearches = 2
          const selectedInterests = shuffled.slice(0, maxInterestSearches)
          const resultsPerQuery = Math.max(Math.round(fetchSlots / selectedInterests.length) * 2, 15)

          const interestPromises = selectedInterests.map(interest => {
            const q = [topics, whitelist, qualityKeyword, interest, gamer, blacklist].filter(Boolean).join(' ').trim()
            return _ytSearch(apiKey, q, safeSearch, duration, resultsPerQuery, videoDefinition, null, ytLanguage)
              .catch(err => { if (_isQuotaError(err)) throw err; return [] })
          })
          const resultsLists = await Promise.all(interestPromises)
          rawItems = resultsLists.flat().filter(Boolean)

          // If we need more items, top up with a single base query search
          if (rawItems.length < totalSlots) {
            const fill = await _ytSearch(apiKey, baseQ, safeSearch, duration, Math.max(totalSlots * 2, 15), videoDefinition, null, ytLanguage)
              .catch(err => { if (_isQuotaError(err)) throw err; return [] })
            rawItems = [...rawItems, ...fill]
          }
        } else {
          rawItems = await _ytSearch(apiKey, baseQ, safeSearch, duration, Math.max(fetchSlots, 20), videoDefinition, null, ytLanguage)
        }
      }

      // Deduplicate
      const seen = new Set()
      const deduped = rawItems.filter(item => {
        const id = item?.id?.videoId
        if (!id || seen.has(id)) return false
        seen.add(id); return true
      })   // keep ALL deduped; slice after stats so minViews filter has candidates

      // Shuffle the candidates to provide variety on each load/refresh
      const shuffledCandidates = [...deduped]
      for (let i = shuffledCandidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledCandidates[i], shuffledCandidates[j]] = [shuffledCandidates[j], shuffledCandidates[i]]
      }

      // Fetch duration + statistics (viewCount, likeCount, definition)
      // Capped at 50 IDs to comply with YouTube's /v3/videos limits
      const eligibleCandidates = shuffledCandidates.slice(0, 50)
      const ids = eligibleCandidates.map(i => i.id.videoId).filter(Boolean).join(',')
      let durMap   = {}  // id -> formatted duration string
      let statsMap = {}  // id -> { viewCount, likeCount, definition }
      if (ids) {
        const vRes  = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${ids}&key=${apiKey}&fields=items(id,contentDetails/duration,contentDetails/definition,statistics/viewCount,statistics/likeCount)`)
        const vData = await vRes.json()
        ;(vData.items ?? []).forEach(v => {
          durMap[v.id]   = _parseDuration(v.contentDetails?.duration)
          statsMap[v.id] = {
            viewCount:  v.statistics?.viewCount  ? parseInt(v.statistics.viewCount,  10) : null,
            likeCount:  v.statistics?.likeCount  ? parseInt(v.statistics.likeCount,  10) : null,
            definition: v.contentDetails?.definition ?? '',   // 'hd' | 'sd'
          }
        })
      }

      // Apply minViews filter then slice to totalSlots
      let filtered = eligibleCandidates.filter(item => {
        if (minViews <= 0) return true
        const vc = statsMap[item.id.videoId]?.viewCount
        return vc != null && vc >= minViews
      })

      // Auto-relax filter if we found too few videos (under 2), to make sure the child is never stuck on an empty screen.
      if (filtered.length < 2 && minViews > 0) {
        console.warn(`[MovieTime] Only ${filtered.length} videos passed minViews threshold (${minViews.toLocaleString()}). Relaxing threshold to ensure options exist.`)
        const relaxedMin = minViews * 0.1
        filtered = eligibleCandidates.filter(item => {
          const vc = statsMap[item.id.videoId]?.viewCount
          return vc != null && vc >= relaxedMin
        })
        // Ultimate fallback: ignore minViews if we still have under 2 videos
        if (filtered.length < 2) {
          filtered = eligibleCandidates
        }
      }

      const mapped = filtered
        .slice(0, totalSlots)
        .map(item => ({
          id:         item.id.videoId,
          title:      item.snippet.title,
          channel:    item.snippet.channelTitle,
          thumb:      item.snippet.thumbnails?.high?.url ?? '',
          duration:   durMap[item.id.videoId]   ?? '',
          viewCount:  statsMap[item.id.videoId]?.viewCount  ?? null,
          likeCount:  statsMap[item.id.videoId]?.likeCount  ?? null,
          definition: statsMap[item.id.videoId]?.definition ?? '',
        }))

      if (minViews > 0) {
        console.log(`[MovieTime] minViews filter (${minViews.toLocaleString()}): ${eligibleCandidates.length} candidates → ${mapped.length} passed/relaxed`)
      }

      return mapped
    }

    // ── Try each key in order; rotate on quota exceeded ───────────────────────
    let lastErr = null
    for (let i = 0; i < keyObjects.length; i++) {
      const apiKey = keyObjects[i].key.trim()
      try {
        const mapped = await _fetchWithKey(apiKey)
        _saveCache(mapped)
        setVideos(mapped)
        setVideosFromCache(false)
        setCacheTimestamp(null)
        setActiveKeyIndex(i)
        setVideosLoading(false)
        return
      } catch (err) {
        lastErr = err
        if (_isQuotaError(err)) {
          console.warn(`[MovieTime] Key ${i + 1} ("${keyObjects[i].label ?? apiKey.slice(-4)}") quota exceeded — trying next key`)
          // continue to next key
        } else {
          // Non-quota error — stop trying other keys
          break
        }
      }
    }

    // All keys failed — fall back to cache if quota, else show error
    console.error('[MovieTime] fetchVideos error (all keys exhausted):', lastErr)
    if (_isQuotaError(lastErr)) {
      const cached = _loadCache()
      if (cached?.videos?.length) {
        setVideos(cached.videos)
        setVideosFromCache(true)
        setCacheTimestamp(new Date(cached.ts))
        setVideosError('quota')
      } else {
        setVideosError('quota-no-cache')
      }
    } else {
      setVideosError(lastErr?.message ?? 'Unknown error')
    }
    setVideosLoading(false)
  }, [settings.movieTimeYoutubeKeys, settings.movieTimeYoutubeKey, settings.movieTimeTopics,
      settings.movieTimeWhitelist, settings.movieTimeBlacklist, settings.movieTimeGamerLoophole,
      settings.movieTimeDuration, settings.movieTimeSafeSearch, settings.movieTimeInterests,
      settings.movieTimeSelectionCount, settings.movieTimeOnlyFromList,
      settings.movieTimeYoutubeUrls, settings.movieTimeVideoQuality,
      settings.movieTimeSelectedYoutubeVideoIds, settings.movieTimeMinViews,
      settings.movieTimeLanguage])

  // Reset selection gate — called whenever videos reload or gate setting changes.
  // Incrementing the epoch causes the RAF useEffect to restart cleanly.
  const resetSelectionGate = useCallback(() => {
    const gateMs = settings.movieTimeSelectionGateMs ?? 0
    // Reset accumulators immediately via refs (RAF loop reads these)
    selectionGazeActiveRef.current = false
    selectionGateAccumRef.current  = 0
    selectionGateStartRef.current  = null
    // Also reset the fill bar immediately via DOM ref
    if (selectionGateFillRef.current) selectionGateFillRef.current.style.width = '0%'
    if (gateMs <= 0) {
      // Gate disabled — instantly pass without running RAF loop
      setSelectionGatePassed(true)
      setSelectionGateProgress(1)
    } else {
      // Reset progress and bump epoch so the RAF useEffect restarts
      setSelectionGatePassed(false)
      setSelectionGateProgress(0)
      setSelectionGateEpoch(e => e + 1)
    }
  }, [settings.movieTimeSelectionGateMs])

  useEffect(() => { fetchVideos() }, [fetchVideos])

  // Run the selection gate animation loop.
  // Deps: phase, gateMs, and selectionGateEpoch (incremented by resetSelectionGate).
  // selectionGatePassed is intentionally NOT a dep — the epoch ensures a fresh start.
  useEffect(() => {
    const gateMs = settings.movieTimeSelectionGateMs ?? 0
    if (phase !== 'browse' || gateMs <= 0) return

    // Cancel any previous RAF that may still be running
    if (selectionGateRafRef.current) {
      cancelAnimationFrame(selectionGateRafRef.current)
      selectionGateRafRef.current = null
    }

    // Accumulators were already zeroed by resetSelectionGate; just start the loop
    const tick = (ts) => {
      if (selectionGazeActiveRef.current) {
        if (selectionGateStartRef.current == null) selectionGateStartRef.current = ts
        selectionGateAccumRef.current += ts - selectionGateStartRef.current
        selectionGateStartRef.current  = ts
      } else {
        selectionGateStartRef.current = null
      }
      const p = Math.min(selectionGateAccumRef.current / gateMs, 1)
      // Write width directly to DOM — no React re-render per frame → buttery smooth
      if (selectionGateFillRef.current) {
        selectionGateFillRef.current.style.width = `${p * 100}%`
      }
      
      // Update progress state so VideoCards and UI text can render the current value
      setSelectionGateProgress(p)

      if (p < 1) {
        selectionGateRafRef.current = requestAnimationFrame(tick)
      } else {
        selectionGateRafRef.current = null
        setSelectionGatePassed(true)
        setSelectionGateProgress(1)
      }
    }
    selectionGateRafRef.current = requestAnimationFrame(tick)

    return () => {
      if (selectionGateRafRef.current) {
        cancelAnimationFrame(selectionGateRafRef.current)
        selectionGateRafRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, settings.movieTimeSelectionGateMs, selectionGateEpoch])

  // Reset selection gate whenever videos change (new fetch)
  useEffect(() => {
    resetSelectionGate()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos])

  // ── AI question generation (Cloud AI providers + local fallbacks) ────────
  const generateQuestionsBatch = useCallback(async (videoOrTitle, quizPhase, watchedUpToSec, countToGenerate = null, excludeQuestions = []) => {
    const batchCount = countToGenerate ?? settings.movieTimePuzzleQuestionsPerQuiz ?? 3
    const cloudProviderOrder = settings.cloudAiProviderOrder ?? ['gemini', 'openai']
    const geminiKey  = settings.geminiApiKey?.trim()
    const openAiKey  = settings.openAiApiKey?.trim()
    const difficulty    = settings.movieTimePuzzleDifficulty   ?? 'Easy'
    const numChoices    = settings.movieTimePuzzleChoices       ?? 4
    const types         = settings.movieTimePuzzleTypes         ?? ['Quiz']
    const qType         = types[Math.floor(Math.random() * types.length)] ?? 'Quiz'
    const eduLevel      = settings.movieTimeQuizEducationLevel  ?? 'Primary'
    const subjectCustom = settings.movieTimeQuizSubjectCustom?.trim()
    const subjectsArr   = settings.movieTimeQuizSubjects ?? []
    const isPrewatch    = quizPhase === 'prewatch'
    const videoId       = typeof videoOrTitle === 'object' ? videoOrTitle?.id : null
    const provider      = typeof videoOrTitle === 'object' ? videoOrTitle?.provider : null
    const isOverlayMode = provider === 'netflix' || provider === 'disney' || provider === 'youtube' || videoId === 'netflix' || videoId === 'disney' || videoId === 'youtube'
    const usePureEducationalPrompt = isPrewatch || isOverlayMode

    // Combine selected chips + custom into a single subject string
    let allSubjects   = [...subjectsArr, ...(subjectCustom ? [subjectCustom] : [])]
    if (usePureEducationalPrompt) {
      allSubjects = allSubjects.filter(s => s !== 'Video Content')
    }
    // If overlay mode and no subjects are selected, fallback to settings.movieTimeTopics
    if (isOverlayMode && allSubjects.length === 0) {
      allSubjects = settings.movieTimeTopics ?? []
    }

    const subject       = allSubjects.length > 0 ? allSubjects.join(' + ') : (settings.movieTimeQuizSubject ?? 'General')
    const finalSubject  = (usePureEducationalPrompt && subject === 'Video Content') ? 'General' : subject

    let videoTitle = typeof videoOrTitle === 'string' ? videoOrTitle : (videoOrTitle?.title ?? '')

    if ((videoId === 'netflix' || videoId === 'disney') && documentTitleRef.current) {
      videoTitle = documentTitleRef.current
        .replace(/\s*-\s*Netflix/gi, '')
        .replace(/\s*\|\s*Disney\+/gi, '')
        .trim();
    }

    const basePrompt = usePureEducationalPrompt
      ? `Generate a batch of high-quality educational questions.`
      : (videoTitle
          ? `The user is about to watch a YouTube video titled "${videoTitle}".`
          : `The user just watched a YouTube video.`)

    // Anti-inane-question guardrail — applies to ALL AI-generated questions
    const antiInaneClause = `
CRITICAL RULES:
- Do NOT ask meta questions about the video title itself (e.g. "What is the main topic of this video?", "How many words are in the title?", "Which word appears in the title?").
- Do NOT ask questions about the YouTube channel name, who uploaded the video, or anything else that is metadata a child would not learn by watching the video.
- Questions must be about the ACTUAL SUBJECT MATTER or TOPIC of the video — things that happen in it, concepts it covers, or knowledge related to its theme.
${settings.movieTimeQuizAboutVideo ? `
- Because "Quiz on Video Content" is enabled, questions during video playback (mid-watch) MUST focus strictly on WHAT HAPPENS IN THE VIDEO itself (specific events, narrative details, statements, actions, occurrences, or specific facts explicitly shown or spoken in the video transcript). 
- Avoid general knowledge questions that are merely related to the video's general topic but do not specifically test what happens in the video (e.g. if the video is about how honeybees make honey, do not ask a generic question like "What color is a honeybee?" or "Which insect produces honey?"; instead, ask a question specifically about what the video explained, such as "What did the video say honeybees collect from flowers to make honey?" or "According to the video, how do bees communicate?").
` : ''}
- For pre-watch questions: ask about the general topic/subject the video covers (e.g. if the video is about fishing in Florida, ask about fish species, Florida geography, fishing techniques, or invasive species — NOT about the title text itself).
- For mid-watch questions: ask about specific things shown, said, or demonstrated in the portions of the video already watched.
`


    let videoContentSection = ''
    const isAboutVideo = !isPrewatch && !isOverlayMode && (settings.movieTimeQuizAboutVideo || finalSubject === 'Video Content')
    const isYoutube = videoId && videoId !== 'netflix' && videoId !== 'disney' && videoId !== 'youtube'
    if (isAboutVideo && isYoutube) {
      try {
        const transcriptData = await fetchYoutubeTranscriptAndMetadata(videoId)
        if (transcriptData) {
          if (isPrewatch) {
            // Pre-watch: user hasn't seen the video yet — use metadata for general topic questions
            const previewSnippet = transcriptData.transcript ? transcriptData.transcript.slice(0, 500) : ''
            videoContentSection = `
Here is the metadata of the video the user is ABOUT TO watch (they have NOT watched it yet):
Video Title: ${transcriptData.title || videoTitle}
Description: ${transcriptData.description || ''}
Keywords: ${(transcriptData.keywords || []).join(', ')}
${previewSnippet ? `\nBrief preview of the video\'s opening: ${previewSnippet}` : ''}

IMPORTANT: The user has NOT watched this video yet. Generate questions about the GENERAL TOPIC, theme, or subject matter of the video — something predictive, conceptual, or related to the broader topic. Do NOT ask about specific details, facts, or dialogue from the video since they haven't seen it. Think: "What do you think this video might be about?" or general knowledge related to the video's theme.
`
          } else {
            // Mid-watch: only use the transcript portion already watched
            let watchedTranscript = ''
            const watchedMs = (watchedUpToSec ?? 0) * 1000
            if (watchedMs > 0 && transcriptData.timedTranscript && transcriptData.timedTranscript.length > 0) {
              watchedTranscript = transcriptData.timedTranscript
                .filter(seg => seg.startMs <= watchedMs)
                .map(seg => seg.text)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
            }
            // Fallback: if no timed data or watchedUpToSec not set, use full transcript
            if (!watchedTranscript) {
              watchedTranscript = transcriptData.transcript || ''
            }
            const truncTranscript = watchedTranscript.slice(0, 30000)
            const watchedMinutes = Math.round((watchedUpToSec ?? 0) / 60)
            videoContentSection = `
Here is the transcript and metadata of the video the user is watching:
Video Title: ${transcriptData.title || videoTitle}
Description: ${transcriptData.description || ''}

Video Transcript (up to ${watchedMinutes} minute${watchedMinutes !== 1 ? 's' : ''} watched so far):
${truncTranscript || '(No transcript available)'}

IMPORTANT: The user has watched this video up to approximately ${watchedMinutes} minute${watchedMinutes !== 1 ? 's' : ''}. You MUST generate high-quality educational questions focusing specifically on WHAT HAPPENS in the portion of the video already watched (the specific actions, events, narrative details, or dialogue mentioned in the watched transcript), rather than asking generic general knowledge questions that are merely related to the video's topic. The correct answers must be fully verifiable from the provided transcript. Do NOT ask about content the user has not yet seen. Do NOT invent information outside of what is provided.
`
          }
        }
      } catch (err) {
        console.warn('[MovieTime] Could not fetch transcript for video content:', err)
      }
    }

    // Safeguard check: If a video-specific question is requested but the transcript failed to load
    if (isAboutVideo && !videoContentSection) {
      videoContentSection = isPrewatch
        ? `
(Warning: Transcript and metadata are currently not available for this video).
IMPORTANT: The user has NOT watched this video yet. Since the video transcript could not be loaded, please create engaging, educational questions about the general topic suggested by the video title "${videoTitle}". Do NOT ask about specific video details.
`
        : `
(Warning: Transcript and metadata are currently not available for this video).
IMPORTANT: Since the video transcript could not be loaded, please create engaging, educational questions directly inspired by what is likely happening or presented in the video "${videoTitle}". Do NOT ask generic, unrelated general knowledge questions. Focus as much as possible on predicting or describing specific scenes or events suggested by the title.
`
    }

    const typeHints = isPrewatch
      ? {
          'Quiz':        'Create fascinating, educational multiple-choice quiz questions.',
          'Word Puzzle': 'Create engaging vocabulary, spelling, or word puzzles (e.g. word meanings, root words, finding a synonym, or decoding a simple anagram).',
          'Math':        'Create fun, age-appropriate word problems, logic puzzles, or arithmetic questions.',
          'Memory':      'Ask fun, educational general knowledge or logical reasoning questions.',
          'Riddle':      'Create clever, educational riddles that describe a concept, object, or term, followed by choices where only one fits.',
        }
      : {
          'Quiz':        'Create fascinating, educational multiple-choice quiz questions.',
          'Word Puzzle': 'Create engaging vocabulary, spelling, or word puzzles (e.g. word meanings, root words, finding a synonym, or decoding a simple anagram) themed around the video.',
          'Math':        'Create fun, age-appropriate word problems, logic puzzles, or arithmetic questions themed around the video.',
          'Memory':      videoTitle 
                         ? 'Ask fun, educational prediction or conceptual questions about what they think the video might explore based on its title.' 
                         : 'Ask fun conceptual recall or observation check questions about what was just watched.',
          'Riddle':      'Create clever, educational riddles that describe a concept, object, or term related to the video, followed by choices where only one fits.',
        }
    const typeHint = typeHints[qType] ?? typeHints['Quiz']

    const subjectLine = usePureEducationalPrompt
      ? (finalSubject !== 'General'
          ? `Subject focus: ${finalSubject}. Generate high-quality educational questions solely about the subject of ${finalSubject}. Do NOT mention or refer to any videos, YouTube, Netflix, Disney+, or watching content.`
          : `General knowledge focus: Generate high-quality educational general knowledge questions. Do NOT mention or refer to any videos, YouTube, Netflix, Disney+, or watching content.`)
      : (isAboutVideo
          ? (finalSubject !== 'General' && finalSubject !== 'Video Content'
              ? `Subject focus: ${finalSubject}. You must creatively weave the subject of ${finalSubject} together with the actual events, actions, facts, or specific details described in the provided video transcript. The question must focus on what happens in the video (e.g. if the transcript mentions a speed, distance, or number of objects at a specific point in the video, ask a math word problem based directly on those occurrences). It must NOT be a general knowledge question about the subject. Be highly creative, engaging, and educational!`
              : `Video Content focus: Your questions must be directly about what happens in the video, focusing on the specific events, actions, narrative details, facts, or ideas presented in the video's transcript and metadata, rather than general knowledge questions related to the video's general topic.`)
          : (finalSubject !== 'General'
              ? `Subject focus: ${finalSubject}. You must creatively weave the subject of ${finalSubject} together with the video's topic or context. For example, if the video is about trains and the subject is Math, ask a speed/distance/number word problem. If the video is about baking and the subject is Science, ask about chemistry/states of matter in baking. Be highly creative, engaging, and educational!`
              : `General knowledge focus: Create engaging, educational questions directly based on or inspired by the video's topic or themes.`))

    // Build a "do not repeat" clause from all questions asked in the last 10 sessions + any currently being generated
    const askedStrings = [
      ...askedQuestionsRef.current.map(item => (typeof item === 'string' ? item : item?.question)),
      ...excludeQuestions
    ].filter(Boolean)
    const avoidClause = askedStrings.length > 0
      ? `\nIMPORTANT: Do NOT ask any of these questions that were already asked in recent sessions:\n${askedStrings.map((q, i) => `${i + 1}. ${q}`).join('\n')}\nCreate COMPLETELY DIFFERENT questions with a different focus or concept.`
      : ''

    // Random seed to prevent cached/identical responses from the AI
    const seed = Math.random().toString(36).slice(2, 8)

    // Educational level pedagogical guidelines
    const levelGuidelines = {
      'Pre-K': 'For Pre-K (Ages 3–5): Keep language extremely simple, clear, and encouraging. Focus on basic counting (under 10), shape recognition, color matching, animal sounds, or simple 3-letter spelling.',
      'Primary': 'For Primary (Ages 6–11): Focus on basic fractions, simple arithmetic, general science facts (solar system, water cycle, habitats), historical figures, spelling, synonyms/antonyms, or basic sequencing.',
      'Secondary': 'For Secondary (Ages 12–17): Focus on algebra, chemistry, biology, historical events, literary devices (metaphors, personification), or basic Python/JS/HTML concepts.',
      'Adult': 'For Adult (Ages 18+): Focus on advanced logic, statistics, scientific principles (genetics, thermodynamics, relativity), global history, philosophy, or data structures/algorithms.',
    }
    const levelGuideline = levelGuidelines[eduLevel] ?? levelGuidelines['Primary']

    const prompt = `${basePrompt}${videoContentSection}
${typeHint}
Educational Level: ${eduLevel}. Difficulty: ${difficulty}.
${levelGuideline}
${subjectLine}
${antiInaneClause}
Generate exactly ${batchCount} distinct educational questions. Each question must have exactly ${numChoices} answer choices. Mark the correct answer clearly.${avoidClause}
Session entropy seed (use this to randomize question angle and wording): ${seed}
Respond ONLY with valid JSON in this exact format, which is an array of question objects (no markdown, no extra text):
[
  {
    "question": "Your question 1 here?",
    "choices": ["Choice A", "Choice B", "Choice C", "Choice D"],
    "correctIndex": 0,
    "type": "${qType}"
  }
]
Keep each question engaging, concise, and under 180 characters. Keep choice answers short and under 50 characters each. Be age-appropriate and fun.`

    // Parameters snapshot — attached to every returned question for display
    // Use the first cloud provider that has an API key configured
    const firstAvailableProvider = cloudProviderOrder.find(p => p === 'openai' ? !!openAiKey : !!geminiKey)
    const promptParams = {
      model: firstAvailableProvider
        ? (firstAvailableProvider === 'openai' ? (settings.openAiModel ?? 'gpt-4o-mini') : (settings.geminiModel ?? 'gemini-2.5-flash'))
        : null,
      difficulty,
      level:      eduLevel,
      subject:    finalSubject,
      videoTitle: isPrewatch ? null : (videoTitle || null),
      videoId:    isPrewatch ? null : (videoId || null),
    }

    // Eye-gaze-friendly offline puzzles — True/False or 2-choice only,
    // so the target areas are as large and easy to hit as possible.
    const _getGazePuzzles = () => {
      const topic = videoTitle || finalSubject || 'General'
      const history = [...askedQuestionsRef.current]

      // Build a pool of True/False questions themed around the current topic / subject.
      // Each entry: { statement, answer: true|false }
      const tfPool = _buildGazeTrueFalsePool(topic, eduLevel, finalSubject)

      const results = []
      for (let i = 0; i < batchCount; i++) {
        // Filter out already-asked questions
        const askedSet = new Set(history.map(h => typeof h === 'string' ? h : h?.question).filter(Boolean))
        const available = tfPool.filter(q => !askedSet.has(q.question))
        const pool = available.length > 0 ? available : tfPool
        const selected = pool[Math.floor(Math.random() * pool.length)]

        const q = {
          question:     selected.question,
          choices:      ['✅ True', '❌ False'],
          correctIndex: selected.correct ? 0 : 1,
          type:         'Quiz',
          source:       'gaze-puzzle',
          promptParams: { ...promptParams, model: null, type: 'Quiz' },
        }
        results.push(q)
        history.push({ question: selected.question, sessionId: APP_RUN_SESSION_ID, timestamp: Date.now() })
      }
      return results
    }

    const _processAndSaveParsedResults = (resultsArr, actualModel) => {
      const processedResults = []
      const updatedHistory = [...askedQuestionsRef.current]

      resultsArr.forEach(parsed => {
        const shuffled = shuffleChoices(parsed)
        if (shuffled?.question) {
          const newRecord = {
            question: shuffled.question,
            sessionId: APP_RUN_SESSION_ID,
            timestamp: Date.now()
          }
          updatedHistory.push(newRecord)
        }
        // Use actualModel (the model that really generated this question) if provided,
        // falling back to the promptParams baseline model.
        processedResults.push({
          ...shuffled,
          promptParams: { ...promptParams, type: parsed.type || 'Quiz', model: actualModel ?? promptParams.model }
        })
      })

      // Update asked questions ref and save
      const pruned = pruneTo10Sessions(updatedHistory, APP_RUN_SESSION_ID)
      askedQuestionsRef.current = pruned
      updateSetting('movieTimeAskedQuestions', pruned)
      try {
        localStorage.setItem('movieTimeAskedQuestions', JSON.stringify(pruned))
      } catch (_) {}

      return processedResults
    }

    const _isOverloadError = (err) => {
      const msg = err?.message ?? ''
      return msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('overloaded') || msg.includes('high demand')
    }

    // ── Cloud AI helper: call a single provider with retry ────────────────────
    const _callProviderBatch = async (provider, providerKey, attempt = 1) => {
      if (provider === 'openai') {
        // OpenAI Chat Completions
        const modelToUse = settings.openAiModel ?? 'gpt-4o-mini'
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${providerKey}` },
          body: JSON.stringify({
            model: modelToUse,
            messages: [
              { role: 'system', content: 'You are an educational quiz generator for children. Respond ONLY with a valid JSON array of question objects — no markdown, no extra text.' },
              { role: 'user', content: prompt }
            ],
            temperature: attempt > 1 ? 0.8 : 1.0,
          }),
        })
        if (!res.ok) {
          const errBody = await res.text().catch(() => '')
          throw new Error(`OpenAI API HTTP ${res.status}: ${errBody.slice(0, 200)}`)
        }
        const data = await res.json()
        return data.choices?.[0]?.message?.content ?? ''
      } else {
        // Gemini
        const SECONDARY_MODEL = 'gemini-2.5-flash'
        const modelToUse = attempt >= 3 ? SECONDARY_MODEL : (settings.geminiModel ?? 'gemini-2.5-flash')
        const genConfig = {
          temperature: attempt > 1 ? 0.8 : 1.0,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        }
        if (attempt === 1) {
          genConfig.responseSchema = {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                question: { type: 'STRING' },
                choices: { type: 'ARRAY', items: { type: 'STRING' } },
                correctIndex: { type: 'INTEGER' },
                type: { type: 'STRING' }
              },
              required: ['question', 'choices', 'correctIndex', 'type']
            }
          }
        }
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${providerKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: genConfig }),
          }
        )
        if (!res.ok) {
          const errBody = await res.text().catch(() => '')
          throw new Error(`Gemini API HTTP ${res.status}: ${errBody.slice(0, 200)}`)
        }
        const data = await res.json()
        const candidate = data.candidates?.[0]
        if (!candidate) throw new Error(`Gemini response blocked (reason: ${data.promptFeedback?.blockReason ?? 'unknown'})`)
        if (candidate.finishReason === 'SAFETY') throw new Error('Gemini response filtered by safety settings')
        return candidate.content?.parts?.[0]?.text ?? ''
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ── MAIN FLOW: CLOUD (in priority order) → OLLAMA → WINDOW.AI → STATIC ───
    // ──────────────────────────────────────────────────────────────────────────

    // 1. Try Cloud AI providers in configured priority order
    for (const provider of cloudProviderOrder) {
      const providerKey = provider === 'openai' ? openAiKey : geminiKey
      if (!providerKey) {
        console.log(`[MovieTime] Skipping ${provider} — no API key configured`)
        continue
      }
      const providerName = provider === 'openai' ? 'ChatGPT' : 'Gemini'
      const primaryModel = provider === 'openai' ? (settings.openAiModel ?? 'gpt-4o-mini') : (settings.geminiModel ?? 'gemini-2.5-flash')
      try {
        console.log(`[MovieTime] 📡 ${providerName} ← calling (on-the-fly | model: ${primaryModel})`)
        let rawResponse
        let lastErr
        let usedModel = primaryModel
        const maxAttempts = provider === 'openai' ? 2 : 3
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            if (attempt === 2) {
              console.warn(`[MovieTime] ❌ ${providerName} attempt 1 failed — waiting 3s before retry...`)
              await new Promise(r => setTimeout(r, 3000))
            } else if (attempt === 3) {
              console.warn(`[MovieTime] ❌ ${providerName} attempt 2 failed — waiting 6s, switching to secondary model...`)
              await new Promise(r => setTimeout(r, 6000))
              // Gemini switches to secondary model on attempt 3
              if (provider === 'gemini') usedModel = 'gemini-2.5-flash'
            }
            if (attempt > 1) console.log(`[MovieTime] 📡 ${providerName} ← retrying (on-the-fly | model: ${usedModel}, attempt ${attempt})`)
            rawResponse = await _callProviderBatch(provider, providerKey, attempt)
            lastErr = null
            break
          } catch (err) {
            lastErr = err
            console.warn(`[MovieTime] ${providerName} Attempt ${attempt} failed:`, err.message)
            if (!_isOverloadError(err)) break
          }
        }
        if (lastErr) throw lastErr
        const parsed = _parseBatchResponse(rawResponse)
        if (parsed && parsed.length > 0) {
          console.log(`[MovieTime] ✅ ${providerName} → responded OK — ${parsed.length} questions generated (model: ${usedModel})`)
          // Pass the actual model used so each question gets the correct attribution
          const processed = _processAndSaveParsedResults(parsed, usedModel)
          return processed.map(q => ({ ...q, source: provider }))
        }
      } catch (err) {
        console.warn(`[MovieTime] ❌ ${providerName} → all attempts failed, trying next provider:`, err.message)
        // Continue to next provider in the order
      }
    }

    // 2. Try Ollama Fallback
    try {
      const modelName = settings.contextualOllamaModel ?? 'llama3.2'
      console.log(`[MovieTime] 📡 Ollama ← calling (on-the-fly fallback | model: ${modelName})`)
      
      const body = {
        model: modelName,
        system: "You are an educational quiz generator for children. Generate fun multiple-choice quiz questions in valid JSON array format.",
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.8,
          num_predict: 2048,
        },
      }

      const res = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`)
      const data = await res.json()
      const rawResponse = data.response ?? ''
      
      const parsed = _parseBatchResponse(rawResponse)
      if (parsed && parsed.length > 0) {
        console.log(`[MovieTime] ✅ Ollama → responded OK — ${parsed.length} questions generated (model: ${modelName})`)
        // Tag each question with the Ollama model name for accurate attribution
        const processed = _processAndSaveParsedResults(parsed, modelName)
        return processed.map(q => ({ ...q, source: 'ollama' }))
      }
    } catch (err) {
      console.warn('[MovieTime] ❌ Ollama → failed:', err.message)
    }

    // 3. Try Gemini Nano (window.ai) Fallback
    try {
      if (window.ai?.languageModel) {
        console.log('[MovieTime] 📡 Gemini Nano ← calling (on-the-fly fallback | window.ai)')
        const session = await window.ai.languageModel.create({
          systemPrompt: "You are an educational quiz generator for children. Generate fun multiple-choice quiz questions in valid JSON array format."
        })
        const rawResponse = await session.prompt(prompt)
        session.destroy()
        
        const parsed = _parseBatchResponse(rawResponse)
        if (parsed && parsed.length > 0) {
          console.log(`[MovieTime] ✅ Gemini Nano → responded OK — ${parsed.length} questions generated`)
          // Tag with 'Gemini Nano' as the actual model for accurate attribution
          const processed = _processAndSaveParsedResults(parsed, 'Gemini Nano')
          return processed.map(q => ({ ...q, source: 'gemini-nano' }))
        }
      }
    } catch (err) {
      console.warn('[MovieTime] ❌ Gemini Nano → failed:', err.message)
    }

    // 5. Hard Fallback — eye-gaze-friendly True/False puzzles (2 large targets, no AI needed)
    console.warn('[MovieTime] All AI pathways failed. Falling back to gaze-friendly True/False puzzles.')
    return _getGazePuzzles()
  }, [settings.geminiApiKey, settings.geminiModel, settings.cloudAiProviderOrder, settings.openAiApiKey, settings.openAiModel,
      settings.movieTimePuzzleDifficulty,
      settings.movieTimePuzzleChoices, settings.movieTimePuzzleTypes,
      settings.movieTimeQuizEducationLevel, settings.movieTimeQuizSubject, settings.movieTimeQuizSubjects, settings.movieTimeQuizSubjectCustom,
      settings.movieTimeQuizAboutVideo, settings.contextualOllamaModel, updateSetting])

  // Backward-compatible single question generator using the batch generator
  const generateQuestion = useCallback(async (videoOrTitle, type, quizPhase, watchedUpToSec, excludeQuestions = []) => {
    const results = await generateQuestionsBatch(videoOrTitle, quizPhase, watchedUpToSec, 1, excludeQuestions)
    return results[0]
  }, [generateQuestionsBatch])

  // ── Generate a full quiz schedule for the entire video upfront ──────────
  // Calculates how many quiz slots fit in the video given the interval, then
  // generates questions for ALL of them in batched API calls (up to 30 slots
  // per call to stay within context limits). Each slot's questions focus on
  // the portion of the video already watched at that quiz's firing time.
  const generateFullQuizSchedule = useCallback(async (videoOrTitle, intervalSec, videoDurationSec, startFromSec = 0) => {
    quizScheduleAbortRef.current = false
    setQuizSchedule([])
    quizScheduleRef.current = []
    currentQuizIndexRef.current = 0

    const questionsPerQuiz    = settings.movieTimePuzzleQuestionsPerQuiz ?? 3
    const cloudProviderOrder   = settings.cloudAiProviderOrder ?? ['gemini', 'openai']
    const geminiKey            = settings.geminiApiKey?.trim()
    const openAiKey            = settings.openAiApiKey?.trim()
    const difficulty       = settings.movieTimePuzzleDifficulty ?? 'Easy'
    const numChoices       = settings.movieTimePuzzleChoices ?? 4
    const types            = settings.movieTimePuzzleTypes ?? ['Quiz']
    const eduLevel         = settings.movieTimeQuizEducationLevel ?? 'Primary'
    const subjectCustom    = settings.movieTimeQuizSubjectCustom?.trim()
    const subjectsArr      = settings.movieTimeQuizSubjects ?? []
    let allSubjects        = [...subjectsArr, ...(subjectCustom ? [subjectCustom] : [])]
    const subject          = allSubjects.length > 0 ? allSubjects.join(' + ') : (settings.movieTimeQuizSubject ?? 'General')
    const videoTitle       = typeof videoOrTitle === 'string' ? videoOrTitle : (videoOrTitle?.title ?? '')
    const videoId          = typeof videoOrTitle === 'object' ? videoOrTitle?.id : null

    // Build the list of quiz slot timestamps (each is when the quiz fires, in seconds)
    if (!intervalSec || intervalSec <= 0) return
    const MAX_SETS = 30
    const slotTimes = []
    let t = (startFromSec || 0) + intervalSec
    const maxTime = videoDurationSec > 0 ? videoDurationSec : t + intervalSec * MAX_SETS
    while (t <= maxTime && slotTimes.length < MAX_SETS) {
      slotTimes.push(Math.round(t))
      t += intervalSec
    }
    if (slotTimes.length === 0) return

    console.log(`[MovieTime] Generating quiz schedule: ${slotTimes.length} quizzes × ${questionsPerQuiz} Qs each, interval=${intervalSec}s`)

    // Fetch transcript once for the whole schedule
    let transcriptData = null
    const isYoutube = videoId && videoId !== 'netflix' && videoId !== 'disney' && videoId !== 'youtube'
    if (isYoutube && (settings.movieTimeQuizAboutVideo || subject === 'Video Content')) {
      try {
        transcriptData = await fetchYoutubeTranscriptAndMetadata(videoId)
      } catch (_) {}
    }

    const levelGuidelines = {
      'Pre-K': 'For Pre-K (Ages 3–5): Keep language extremely simple, clear, and encouraging. Focus on basic counting (under 10), shape recognition, color matching, animal sounds, or simple 3-letter spelling.',
      'Primary': 'For Primary (Ages 6–11): Focus on basic fractions, simple arithmetic, general science facts (solar system, water cycle, habitats), historical figures, spelling, synonyms/antonyms, or basic sequencing.',
      'Secondary': 'For Secondary (Ages 12–17): Focus on algebra, chemistry, biology, historical events, literary devices (metaphors, personification), or basic Python/JS/HTML concepts.',
      'Adult': 'For Adult (Ages 18+): Focus on advanced logic, statistics, scientific principles (genetics, thermodynamics, relativity), global history, philosophy, or data structures/algorithms.',
    }
    const levelGuideline = levelGuidelines[eduLevel] ?? levelGuidelines['Primary']

    // Split into batches (max 12 questions per call, e.g. 4 slots if 3 Qs/slot)
    // to keep generation conservative and relevant to specific video timestamps.
    const BATCH_CALL_LIMIT = Math.max(1, Math.floor(12 / questionsPerQuiz))
    const allSlots = slotTimes.map((sec, i) => ({ quizIndex: i, videoTimeSec: sec }))
    const batches = []
    for (let i = 0; i < allSlots.length; i += BATCH_CALL_LIMIT) {
      batches.push(allSlots.slice(i, i + BATCH_CALL_LIMIT))
    }

    for (const batch of batches) {
      if (quizScheduleAbortRef.current) break

      // Build the prompt for this batch of slots
      const seed = Math.random().toString(36).slice(2, 8)
      const askedStrings = askedQuestionsRef.current.map(item => typeof item === 'string' ? item : item?.question).filter(Boolean)
      const avoidClause = askedStrings.length > 0
        ? `\nIMPORTANT: Do NOT repeat any of these recently asked questions:\n${askedStrings.map((q, i) => `${i + 1}. ${q}`).join('\n')}\nCreate COMPLETELY DIFFERENT questions.`
        : ''

      let batchTranscript = ''
      if (transcriptData?.timedTranscript?.length > 0) {
        const maxMs = batch[batch.length - 1].videoTimeSec * 1000
        const relevantSegs = transcriptData.timedTranscript.filter(seg => seg.startMs <= maxMs)
        
        let currentChunkStart = -1
        let currentChunkText = []
        const chunks = []
        for (const seg of relevantSegs) {
          const sec = Math.floor(seg.startMs / 1000)
          const chunkKey = Math.floor(sec / 30) * 30 // group by 30 seconds
          if (currentChunkStart === -1) currentChunkStart = chunkKey
          
          if (chunkKey !== currentChunkStart) {
            const m = Math.floor(currentChunkStart / 60)
            const s = String(currentChunkStart % 60).padStart(2, '0')
            chunks.push(`[${m}:${s}] ${currentChunkText.join(' ').replace(/\s+/g, ' ').trim()}`)
            currentChunkStart = chunkKey
            currentChunkText = []
          }
          currentChunkText.push(seg.text)
        }
        if (currentChunkText.length > 0) {
            const m = Math.floor(currentChunkStart / 60)
            const s = String(currentChunkStart % 60).padStart(2, '0')
            chunks.push(`[${m}:${s}] ${currentChunkText.join(' ').replace(/\s+/g, ' ').trim()}`)
        }
        batchTranscript = `\nTranscript (grouped by ~30 seconds):\n${chunks.join('\n')}`
      }

      // Build per-slot descriptions indicating which part of the transcript to use
      const slotsDesc = batch.map(slot => {
        const watchedMin = Math.floor(slot.videoTimeSec / 60)
        const watchedSec = String(slot.videoTimeSec % 60).padStart(2, '0')
        return `Quiz ${slot.quizIndex + 1} (fires at timestamp [${watchedMin}:${watchedSec}]): Generate questions based on the transcript from [0:00] up to [${watchedMin}:${watchedSec}].`
      }).join('\n')

      const transcriptHeader = transcriptData
        ? `Video Title: ${transcriptData.title || videoTitle}\nDescription: ${transcriptData.description?.slice(0, 300) || ''}\n${batchTranscript}\n`
        : `Video Title: ${videoTitle}\n`

      const prompt = `You are generating a full quiz schedule for a video. The user will watch the video and answer quizzes at regular intervals. Each quiz must ask questions about the SPECIFIC PORTION of the video the user has watched SO FAR — NOT about later parts they haven't seen yet. Vary the quiz types, angles, concepts, and wording across quizzes so they feel completely different from each other.

${transcriptHeader}
Educational Level: ${eduLevel}. Difficulty: ${difficulty}.
${levelGuideline}
Subject focus: ${subject}.

Quiz slots to generate (each slot = ${questionsPerQuiz} questions):
${slotsDesc}

CRITICAL RULES:
- Each quiz set MUST ask about things already shown/said in the video up to that timestamp — NOT about later content.
- Questions across different quiz slots MUST be VARIED — cover different events, facts, characters, concepts, or angles. Avoid repeating the same question theme in multiple slots.
- Do NOT ask meta questions about the video title itself.
- Do NOT ask questions about the YouTube channel name, who uploaded the video, or any other metadata a child would not learn by watching the video.
- Each question must have exactly ${numChoices} answer choices.
- Keep each question under 180 characters. Keep choices under 50 characters each.
${avoidClause}
Session entropy seed: ${seed}

Respond ONLY with valid JSON — an array of ${batch.length} quiz slot objects, each containing ${questionsPerQuiz} questions:
[
  {
    "quizIndex": 0,
    "questions": [
      { "question": "...", "choices": ["A", "B", "C", "D"], "correctIndex": 0, "type": "Quiz" }
    ]
  }
]
No markdown, no extra text. Exactly ${batch.length} slots.`

      const firstActiveProvider = cloudProviderOrder.find(p => p === 'openai' ? !!openAiKey : !!geminiKey)
      const promptParams = {
        model: firstActiveProvider
          ? (firstActiveProvider === 'openai' ? (settings.openAiModel ?? 'gpt-4o-mini') : (settings.geminiModel ?? 'gemini-2.5-flash'))
          : null,
        difficulty, level: eduLevel, subject: subject, videoTitle: videoTitle || null, videoId: videoId || null
      }

      // Try Cloud AI providers in configured priority order
      let slotResults = null
      let scheduleCloudFailed = false
      let scheduleSource = 'gaze-puzzle'
      for (const provider of cloudProviderOrder) {
        const providerKey = provider === 'openai' ? openAiKey : geminiKey
        if (!providerKey) continue
        if (slotResults && Array.isArray(slotResults)) break // already got results from a prior provider
        const providerName = provider === 'openai' ? 'ChatGPT' : 'Gemini'
        for (let attempt = 1; attempt <= 2 && (!slotResults || !Array.isArray(slotResults)); attempt++) {
          try {
            if (attempt === 2) {
              console.warn(`[MovieTime] ❌ ${providerName} → schedule attempt 1 failed — waiting 4s before retry...`)
              await new Promise(r => setTimeout(r, 4000))
            }
            if (quizScheduleAbortRef.current) break
            console.log(`[MovieTime] 📡 ${providerName} ← calling (schedule | slots ${batch[0].quizIndex + 1}–${batch[batch.length - 1].quizIndex + 1}, attempt ${attempt})`)

            let rawText = ''
            if (provider === 'openai') {
              const modelToUse = settings.openAiModel ?? 'gpt-4o-mini'
              const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${providerKey}` },
                body: JSON.stringify({
                  model: modelToUse,
                  messages: [
                    { role: 'system', content: 'You are an educational quiz generator. Respond ONLY with a valid JSON array of quiz slot objects — no markdown, no extra text.' },
                    { role: 'user', content: prompt }
                  ],
                  temperature: 1.0,
                }),
              })
              if (!res.ok) {
                const errBody = await res.text().catch(() => '')
                const isOverload = res.status === 503 || errBody.includes('overloaded')
                console.warn(`[MovieTime] ❌ ChatGPT → HTTP ${res.status}${isOverload ? ' (overloaded)' : ''}`)
                if (isOverload) { scheduleCloudFailed = true; break }
                break
              }
              rawText = (await res.json()).choices?.[0]?.message?.content ?? ''
            } else {
              const modelToUse = settings.geminiModel ?? 'gemini-2.5-flash'
              const genConfig = {
                temperature: 1.0,
                maxOutputTokens: 4096,
                responseMimeType: 'application/json',
                responseSchema: {
                  type: 'ARRAY',
                  items: {
                    type: 'OBJECT',
                    properties: {
                      quizIndex: { type: 'INTEGER' },
                      questions: {
                        type: 'ARRAY',
                        items: {
                          type: 'OBJECT',
                          properties: {
                            question: { type: 'STRING' },
                            choices: { type: 'ARRAY', items: { type: 'STRING' } },
                            correctIndex: { type: 'INTEGER' },
                            type: { type: 'STRING' }
                          },
                          required: ['question', 'choices', 'correctIndex', 'type']
                        }
                      }
                    },
                    required: ['quizIndex', 'questions']
                  }
                }
              }
              const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${providerKey}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: genConfig }) }
              )
              if (!res.ok) {
                const errBody = await res.text().catch(() => '')
                const isOverload = res.status === 503 || errBody.includes('UNAVAILABLE') || errBody.includes('high demand')
                console.warn(`[MovieTime] ❌ Gemini → HTTP ${res.status}${isOverload ? ' (overloaded)' : ''}`)
                if (isOverload) { scheduleCloudFailed = true; break }
                break
              }
              const data = await res.json()
              rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
              const blockReason = data.promptFeedback?.blockReason
              if (blockReason) console.warn('[MovieTime] Quiz schedule: Gemini blocked response, reason:', blockReason)
            }

            if (!rawText) { console.warn(`[MovieTime] ❌ ${providerName} → returned empty text (schedule).`); continue }
            try {
              const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()
              slotResults = JSON.parse(cleaned)
              if (slotResults) scheduleSource = `${provider}-schedule`
            } catch (_) {
              const match = rawText.match(/\[.*\]/s)
              if (match) {
                try { slotResults = JSON.parse(match[0]); if (slotResults) scheduleSource = `${provider}-schedule` } catch (_2) {}
              }
            }
            if (slotResults && Array.isArray(slotResults))
              console.log(`[MovieTime] ✅ ${providerName} → responded OK — ${slotResults.length} slot(s) parsed (schedule, attempt ${attempt})`)
          } catch (err) {
            console.warn(`[MovieTime] ❌ ${providerName} → schedule attempt ${attempt} failed:`, err.message)
            const isOverload = err.message?.includes('503') || err.message?.includes('UNAVAILABLE')
            if (isOverload) { scheduleCloudFailed = true; break }
          }
        }
        if (!slotResults || !Array.isArray(slotResults)) {
          console.warn(`[MovieTime] ❌ ${providerName} → all schedule attempts exhausted, trying next provider...`)
        }
      }

      // If Cloud AI batch call failed, try Ollama for the whole batch (one request, not per-slot)
      if (!slotResults || !Array.isArray(slotResults)) {
        if (!scheduleCloudFailed) {
          console.warn('[MovieTime] Quiz schedule batch parse failed — batch response was malformed')
        }
        // Try Ollama as a single batch call
        try {
          const ollamaModel = settings.contextualOllamaModel ?? 'llama3.2'
          console.log(`[MovieTime] 📡 Ollama ← calling (schedule fallback | model: ${ollamaModel}, slots ${batch[0].quizIndex + 1}–${batch[batch.length - 1].quizIndex + 1})`)
          const ollamaRes = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: ollamaModel,
              system: 'You are an educational quiz generator. Generate quiz schedules in valid JSON array format.',
              prompt,
              stream: false,
              options: { temperature: 0.8, num_predict: 4096 },
            }),
          })
          if (ollamaRes.ok) {
            const ollamaData = await ollamaRes.json()
            const rawText = ollamaData.response ?? ''
            try {
              const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()
              slotResults = JSON.parse(cleaned)
              if (slotResults) scheduleSource = 'ollama-schedule'
            } catch (_) {
              const match = rawText.match(/\[.*\]/s)
              if (match) { try { slotResults = JSON.parse(match[0]); scheduleSource = 'ollama-schedule' } catch (_2) {} }
            }
            if (slotResults && Array.isArray(slotResults))
              console.log(`[MovieTime] ✅ Ollama → responded OK — ${slotResults.length} slot(s) parsed (schedule)`)
          }
        } catch (_) {
          console.warn('[MovieTime] ❌ Ollama → schedule fallback failed — using static gaze puzzles for these slots')
        }
      }

      // Last resort: fill slots with empty arrays so the puzzle timer falls back to gaze puzzles at fire time
      // IMPORTANT: do NOT call generateQuestionsBatch here — it would hammer Gemini again per-slot
      if (!slotResults || !Array.isArray(slotResults)) {
        console.warn('[MovieTime] Quiz schedule: all AI paths failed — slots will use static gaze puzzles when they fire')
        slotResults = batch.map(slot => ({ quizIndex: slot.quizIndex, questions: [] }))
      }

      // Determine the actual model name for attribution based on which provider won
      const scheduleActualModel = scheduleSource.startsWith('gemini')
        ? (settings.geminiModel ?? 'gemini-2.5-flash')
        : scheduleSource.startsWith('openai')
          ? (settings.openAiModel ?? 'gpt-4o-mini')
          : scheduleSource.startsWith('ollama')
            ? (settings.contextualOllamaModel ?? 'llama3.2')
            : null

      // Merge results into quizSchedule state
      const newEntries = []
      for (const slotResult of (Array.isArray(slotResults) ? slotResults : [])) {
        const slotDef = batch.find(b => b.quizIndex === (slotResult.quizIndex ?? newEntries.length))
        if (!slotDef) continue
        const rawQs = slotResult.questions ?? []
        const processedQs = rawQs.map(q => {
          const shuffled = shuffleChoices(q)
          // Use the actual winning provider's model for each question's attribution
          return {
            ...shuffled,
            promptParams: { ...promptParams, type: q.type || 'Quiz', model: scheduleActualModel },
            source: scheduleSource
          }
        })
        // Fall back to single-batch generation if slot has no questions
        newEntries.push({ quizIndex: slotDef.quizIndex, videoTimeSec: slotDef.videoTimeSec, questions: processedQs })
      }

      if (newEntries.length > 0 && !quizScheduleAbortRef.current) {
        setQuizSchedule(prev => {
          const merged = [...prev]
          for (const entry of newEntries) {
            const existing = merged.findIndex(s => s.quizIndex === entry.quizIndex)
            if (existing >= 0) merged[existing] = entry
            else merged.push(entry)
          }
          merged.sort((a, b) => a.quizIndex - b.quizIndex)
          quizScheduleRef.current = merged
          return merged
        })
      }
    }
    // ── Pretty-print the full schedule to the DevTools console ──────────────
    const schedule = quizScheduleRef.current
    const _schedWinSource = schedule[0]?.questions?.[0]?.source ?? 'none'
    const _schedWinModel  = schedule[0]?.questions?.[0]?.promptParams?.model ?? ''
    const _schedWinLabel  = _schedWinSource.startsWith('gemini') ? 'Gemini'
      : _schedWinSource.startsWith('openai') ? 'ChatGPT'
      : _schedWinSource.startsWith('ollama') ? 'Ollama'
      : _schedWinSource === 'gaze-puzzle'    ? 'Static (gaze puzzles)'
      : _schedWinSource
    console.log(`[MovieTime] ✅ Quiz schedule complete: ${schedule.length} slots — generated by ${_schedWinLabel}${_schedWinModel ? ` (${_schedWinModel})` : ''}`)
    console.groupCollapsed(`[MovieTime] 📋 Full Quiz Schedule (${schedule.length} quizzes, expand to inspect)`)
    schedule.forEach((slot, si) => {
      const min = Math.floor(slot.videoTimeSec / 60)
      const sec = String(slot.videoTimeSec % 60).padStart(2, '0')
      console.groupCollapsed(`  Quiz ${si + 1}  ⏱ ${min}:${sec}  (${slot.questions?.length ?? 0} questions)`)
      ;(slot.questions ?? []).forEach((q, qi) => {
        console.log(`    Q${qi + 1}: ${q.question}`)
        ;(q.choices ?? []).forEach((c, ci) => {
          console.log(`         ${ci === q.correctIndex ? '✅' : '  '} [${ci}] ${c}`)
        })
      })
      console.groupEnd()
    })
    console.groupEnd()
    // Expose on window so caregivers / devs can inspect live in DevTools:
    //   window.__gazeaac.quizSchedule
    if (typeof window !== 'undefined') {
      window.__gazeaac = window.__gazeaac ?? {}
      window.__gazeaac.quizSchedule = schedule
    }

  }, [settings.geminiApiKey, settings.geminiModel, settings.cloudAiProviderOrder, settings.openAiApiKey, settings.openAiModel,
      settings.movieTimePuzzleDifficulty,
      settings.movieTimePuzzleChoices, settings.movieTimePuzzleTypes,
      settings.movieTimeQuizEducationLevel, settings.movieTimeQuizSubject, settings.movieTimeQuizSubjects, settings.movieTimeQuizSubjectCustom,
      settings.movieTimeQuizAboutVideo, settings.movieTimePuzzleQuestionsPerQuiz, settings.contextualOllamaModel,
      fetchYoutubeTranscriptAndMetadata])

  // Legacy preFetchPuzzleQuestions — kept for the fallback path inside puzzle timer
  const preFetchPuzzleQuestions = useCallback(async (videoOrTitle) => {
    try {
      const totalQs = settings.movieTimePuzzleQuestionsPerQuiz ?? 3
      const questions = await generateQuestionsBatch(videoOrTitle, 'watching', savedTimeRef.current, totalQs)
      setPuzzleQuestions(questions)
    } catch (err) {
      console.warn('[MovieTime] Background pre-fetch failed:', err)
    }
  }, [generateQuestionsBatch, settings.movieTimePuzzleQuestionsPerQuiz])

  // ── Video selection → pre-watch question ─────────────────────────────────
  const selectVideo = useCallback(async (video) => {
    setSelectedVideo(video)
    setPuzzle(null)
    setPuzzleLoading(false)
    setPuzzleQuestionGate(true)
    setPuzzleAnswerGate(false)
    setPuzzleGateProgress(0)
    setPuzzleAnswerGateProgress(0)
    setPuzzleWrongCount(0)
    setPersistentWrong({})
    setPuzzleQuestionIndex(1)
    setPuzzleQuestions([])
    // Reset quiz schedule for the new video
    quizScheduleAbortRef.current = true  // cancel any previous in-flight schedule
    setQuizSchedule([])
    quizScheduleRef.current = []
    currentQuizIndexRef.current = 0

    if (settings.movieTimeQuizRequirePrewatch ?? true) {
      const totalQs = settings.movieTimePuzzleQuestionsPerQuiz ?? 3
      setPuzzleTotalQuestions(totalQs)
      setPhase('prewatch')
      setPuzzleLoading(true)
      try {
        const questions = await generateQuestionsBatch(video, 'prewatch', 0, totalQs)
        setPuzzleQuestions(questions)
        setPuzzle(questions[0])
      } catch (err) {
        console.error('[MovieTime] Failed to pre-load questions:', err)
      } finally {
        setPuzzleLoading(false)
      }
    } else {
      setPhase('watching')
    }
  }, [generateQuestionsBatch, settings.movieTimePuzzleQuestionsPerQuiz, settings.movieTimeQuizRequirePrewatch])

  const triggerWebviewPrewatch = useCallback(async (url, duration) => {
    lastPrewatchUrlRef.current = url
    try {
      if (webviewRef.current) {
        webviewRef.current.send('control-video', 'pause')
      } else {
        window.gazeAPI?.chromeControlVideo?.('pause')
      }
      setIsVideoPlaying(false)
      isVideoPlayingRef.current = false
    } catch (_) {}

    let videoTitle = documentTitleRef.current
      .replace(/\s*-\s*Netflix/gi, '')
      .replace(/\s*\|\s*Disney\+/gi, '')
      .replace(/\s*-\s*YouTube/gi, '')
      .trim()

    const tempVideo = {
      id: selectedVideo.id,
      title: videoTitle || selectedVideo.title,
      provider: selectedVideo.provider
    }

    setPuzzle(null)
    setPuzzleLoading(true)
    setPuzzleQuestionGate(true)
    setPuzzleAnswerGate(false)
    setPuzzleGateProgress(0)
    setPuzzleAnswerGateProgress(0)
    setPuzzleWrongCount(0)
    setPersistentWrong({})
    setPuzzleQuestionIndex(1)
    setPuzzleQuestions([])

    quizScheduleAbortRef.current = true
    setQuizSchedule([])
    quizScheduleRef.current = []
    currentQuizIndexRef.current = 0

    const totalQs = settings.movieTimePuzzleQuestionsPerQuiz ?? 3
    setPuzzleTotalQuestions(totalQs)
    setPhase('prewatch')

    try {
      const questions = await generateQuestionsBatch(tempVideo, 'prewatch', 0, totalQs)
      setPuzzleQuestions(questions)
      setPuzzle(questions[0])
    } catch (err) {
      console.error('[MovieTime] Failed to pre-load questions:', err)
    } finally {
      setPuzzleLoading(false)
    }
  }, [selectedVideo, generateQuestionsBatch, settings.movieTimePuzzleQuestionsPerQuiz])

  // ��� YouTube IFrame Player API ��������������������������������������������
  // IMPORTANT: dependency array is [selectedVideo] only � NOT [phase].
  // The player must survive the watching → puzzle → watching transition so the
  // video position is preserved.  Adding `phase` here causes React to destroy
  // and recreate the player every time the quiz overlay appears, which resets
  // the video to 0:00.
  useEffect(() => {
    if (!selectedVideo) return
    if (selectedVideo.provider === 'netflix' || selectedVideo.provider === 'disney' || selectedVideo.provider === 'youtube') return

    let mounted = true
    savedTimeRef.current = 0  // fresh video � reset saved position

    const initPlayer = () => {
      // Guard: the #yt-player div is only in the DOM during 'watching' phase.
      // If it isn't mounted yet (e.g. still in prewatch), the second effect
      // below will retry once the phase becomes 'watching'.
      if (!mounted || !iframeRef.current) return
      // Don't double-create if already initialised
      if (playerRef.current) return
      try {
        playerRef.current = new window.YT.Player(iframeRef.current, {
          videoId: selectedVideo.id,
          playerVars: {
            autoplay:       1,
            rel:            0,
            modestbranding: 1,
            fs:             0,
          },
          events: {
            onReady: (e) => {
              playerReadyRef.current = true
              try {
                if (savedTimeRef.current > 0) {
                  e.target.seekTo(savedTimeRef.current, true)
                }
              } catch (_) {}
              e.target.playVideo()
            },
            onStateChange: (e) => {
              setIsVideoPlaying(e.data === 1)
              if (e.data === 1) {
                pausedByGazeRef.current = false
                gazedAwayRef.current = false
                setGazedAway(false)
                setGazeNoData(false)
              } else if (e.data === 2) {
                try {
                  const t = playerRef.current?.getCurrentTime?.()
                  if (t != null && t > 0) savedTimeRef.current = t
                } catch (_) {}
                if (!pausedByGazeRef.current) {
                  gazedAwayRef.current = false
                  setGazedAway(false)
                  setGazeNoData(false)
                }
              }
              // YT.PlayerState.ENDED === 0
              if (e.data === 0) onVideoEndedRef.current?.()
            },
          },
        })
      } catch (err) {
        console.error('[MovieTime] YT.Player init error:', err)
      }
    }

    if (window.YT?.Player) {
      initPlayer()
    } else {
      if (!document.getElementById('yt-iframe-api')) {
        const tag = document.createElement('script')
        tag.id  = 'yt-iframe-api'
        tag.src = 'https://www.youtube.com/iframe_api'
        document.head.appendChild(tag)
      }
      const prev = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        prev?.()
        if (mounted) initPlayer()
      }
    }

    return () => {
      mounted = false
      try { playerRef.current?.destroy() } catch (_) {}
      playerRef.current    = null
      playerReadyRef.current = false
      setIsVideoPlaying(false)
      pausedByGazeRef.current = false
      gazedAwayRef.current = false
      setGazedAway(false)
      setGazeNoData(false)
    }
  }, [selectedVideo])  // ← selectedVideo only; phase intentionally excluded

  // ── Video-ended handler — go back to video selection screen ──────────────
  // Keep a stable ref so YT player closures (created once) always invoke the
  // latest version without needing to recreate the player.
  useEffect(() => {
    onVideoEndedRef.current = () => {
      // Destroy the player and return to the browse/selection screen
      try { playerRef.current?.destroy() } catch (_) {}
      playerRef.current     = null
      playerReadyRef.current = false
      setIsVideoPlaying(false)
      pausedByGazeRef.current = false
      gazedAwayRef.current = false
      setGazedAway(false)
      setGazeNoData(false)
      setSelectedVideo(null)
      setPuzzleTimer(null)
      setPhase('browse')
      // Trigger a fresh video load so the selection grid is up to date
      resetSelectionGate()
    }
  })

  // ── Deferred player init ──────────────────────────────────────────────────
  // Fires when phase becomes 'watching' in case the iframe div wasn't in the
  // DOM yet when selectedVideo was first set (during prewatch).
  useEffect(() => {
    if (phase !== 'watching' || !selectedVideo || playerRef.current) return
    if (selectedVideo.provider === 'netflix' || selectedVideo.provider === 'disney' || selectedVideo.provider === 'youtube') return
    if (!iframeRef.current || !window.YT?.Player) return
    try {
      playerRef.current = new window.YT.Player(iframeRef.current, {
        videoId: selectedVideo.id,
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1, fs: 0 },
        events: {
          onReady: (e) => {
            playerReadyRef.current = true
            try {
              if (savedTimeRef.current > 0) {
                e.target.seekTo(savedTimeRef.current, true)
              }
            } catch (_) {}
            e.target.playVideo()
          },
          onStateChange: (e) => {
            setIsVideoPlaying(e.data === 1)
            if (e.data === 1) {
              pausedByGazeRef.current = false
              gazedAwayRef.current = false
              setGazedAway(false)
              setGazeNoData(false)
            } else if (e.data === 2) {
              try {
                const t = playerRef.current?.getCurrentTime?.()
                if (t != null && t > 0) savedTimeRef.current = t
              } catch (_) {}
              if (!pausedByGazeRef.current) {
                gazedAwayRef.current = false
                setGazedAway(false)
                setGazeNoData(false)
              }
            }
            if (e.data === 0) onVideoEndedRef.current?.()
          },
        },
      })
    } catch (err) {
      console.error('[MovieTime] YT.Player deferred init error:', err)
    }
  }, [phase, selectedVideo])

  // ── Enforce video pause during puzzle / prewatch phases ──────────────────
  // Acts as a safety net: regardless of how the phase transition happened,
  // the video is guaranteed to be paused whenever a quiz overlay is visible.
  // Uses a small polling loop because the YT player may not honour a single
  // pauseVideo() call made milliseconds after a state change.
  useEffect(() => {
    if (phase !== 'puzzle' && phase !== 'prewatch') return

    // Bring focus to the app window when the quiz starts
    window.gazeAPI?.windowControl?.('focus')

    // Force pause the video immediately on state entry
    try {
      if (playerRef.current) {
        playerRef.current.pauseVideo()
      } else if (window.gazeAPI?.chromeControlVideo) {
        window.gazeAPI.chromeControlVideo('pause')
      }
    } catch (_) {}

    if (!playerRef.current) return

    // Immediate call
    try { playerRef.current?.pauseVideo() } catch (_) {}

    // Poll for up to 2 seconds to catch delayed player responses
    const maxAttempts = 8
    let attempts = 0
    const interval = setInterval(() => {
      attempts++
      try {
        const state = playerRef.current?.getPlayerState?.()
        // YT.PlayerState.PLAYING === 1
        if (state === 1) {
          playerRef.current?.pauseVideo()
        }
      } catch (_) {}
      if (attempts >= maxAttempts) clearInterval(interval)
    }, 250)

    return () => clearInterval(interval)
  }, [phase])

  // ── Periodic puzzle timer – tracks VIDEO playback time, not wall clock ───
  // Polls getCurrentTime() every second; only advances the countdown while the
  // player is actually playing.  This means pauses (gaze-away, buffering) do
  // NOT consume the interval, and the saved resume position reflects the real
  // last-seen video timestamp.
  useEffect(() => {
    if (phase !== 'watching') {
      clearInterval(puzzleIntervalRef.current)
      clearInterval(puzzleTimerRef.current)
      clearTimeout(nextPuzzleConfirmTimerRef.current)
      setNextPuzzleConfirm(false)
      setPuzzleTimer(null)
      return
    }

    const intervalSec = settings.movieTimePuzzleIntervalSec ?? 600

    // Snapshot the video's current time when we (re-)enter watching phase so
    // the target fires intervalSec of *actual playback* later.
    let startVideoTime = null   // set on first poll when player is ready
    let accumulatedSec = 0      // video-seconds of playback counted so far
    let lastVideoTime  = null   // previous getCurrentTime() sample

    setPuzzleTimer(intervalSec === 0 ? null : intervalSec)

    puzzleTimerRef.current = setInterval(() => {
      try {
        // YT.PlayerState.PLAYING === 1
        const state = playerRef.current?.getPlayerState?.()
        const now   = playerRef.current?.getCurrentTime?.()

        if (state === 1 && now != null) {
          // Record starting position on first ready sample
          if (lastVideoTime == null) {
            lastVideoTime = now
          } else {
            const delta = now - lastVideoTime
            // Guard against seeks / rewinds producing a negative delta
            if (delta > 0 && delta < 5) {
              accumulatedSec += delta
            }
            lastVideoTime = now
          }
        }
        // Always update savedTimeRef with the latest known position
        if (now != null) savedTimeRef.current = now

        if (intervalSec > 0) {
          const remaining = Math.max(0, intervalSec - accumulatedSec)
          setPuzzleTimer(Math.round(remaining))

          // Show countdown banner during the last 5 seconds before the puzzle fires
          if (remaining <= 5 && remaining > 0) {
            setPuzzleCountdown(Math.ceil(remaining))
          } else {
            setPuzzleCountdown(null)
          }

          if (accumulatedSec >= intervalSec) {
            // Time's up – fire the puzzle
            clearInterval(puzzleTimerRef.current)
            setPuzzleCountdown(null)

            // Snapshot the exact frame before pausing
            try {
              const t = playerRef.current?.getCurrentTime?.()
              if (t != null) savedTimeRef.current = t
            } catch (_) {}

            const totalQs = settings.movieTimePuzzleQuestionsPerQuiz ?? 3
            try { playerRef.current?.pauseVideo() } catch (_) {}
            setPuzzleQuestionGate(true)
            setPuzzleAnswerGate(false)
            setPuzzleGateProgress(0)
            setPuzzleAnswerGateProgress(0)
            setPuzzleWrongCount(0)
            setPersistentWrong({})
            setPuzzleQuestionIndex(1)
            setPuzzleTotalQuestions(totalQs)

            // ── Use the pre-generated quiz schedule slot ─────────────────
            // Check schedule BEFORE setting phase/loading so we only show the
            // "Generating…" spinner if we genuinely need to call the API.
            const scheduleSlot = quizScheduleRef.current[currentQuizIndexRef.current]
            const scheduleQs   = scheduleSlot?.questions ?? []
            if (scheduleQs.length > 0) {
              // Great — use the pre-generated questions for this slot (no spinner needed)
              setPuzzleLoading(false)
              setPuzzleQuestions(scheduleQs)
              puzzleQuestionsRef.current = scheduleQs
              setPuzzle(scheduleQs[0])
              setPhase('puzzle')
              console.log(`[MovieTime] Quiz #${currentQuizIndexRef.current + 1} fired — using pre-generated schedule slot (${scheduleQs.length} Qs at ${Math.round(scheduleSlot.videoTimeSec / 60)}min)`)
            } else {
              // Schedule slot not ready yet — show spinner and generate on-the-fly
              console.warn(`[MovieTime] Quiz #${currentQuizIndexRef.current + 1}: schedule slot not ready, generating on-the-fly`)
              setPuzzleLoading(true)
              setPhase('puzzle')
              generateQuestion(selectedVideo, null, 'watching', savedTimeRef.current).then(q => {
                setPuzzle(q)
                setPuzzleLoading(false)
              })
            }
            // Advance the schedule pointer for the next quiz
            currentQuizIndexRef.current += 1
          }
        }
      } catch (_) {}
    }, 1000)

    return () => {
      clearInterval(puzzleTimerRef.current)
      clearTimeout(puzzleIntervalRef.current)
    }
  }, [phase, settings.movieTimePuzzleIntervalSec, generateQuestion, selectedVideo])

  // ── Generate quiz schedule when entering watching phase or interval changes ──
  // On first entry to watching: kick off a full schedule for the whole video.
  // If the interval is changed while watching: cancel old schedule, reset index,
  // and regenerate from the current playback position with the new interval.
  // IMPORTANT: track the last video+interval pair we generated for so that
  // returning to 'watching' after a quiz does NOT wipe and regenerate the schedule.
  const scheduleGenerationKeyRef  = useRef(0)   // increments to detect stale calls
  const scheduleVideoIdRef        = useRef(null) // video id of last schedule generation
  const scheduleVideoUrlRef       = useRef(null) // URL of last schedule generation
  const scheduleIntervalKeyRef    = useRef(null) // interval of last schedule generation
  const generateFullQuizScheduleRef = useRef(null)
  useEffect(() => { generateFullQuizScheduleRef.current = generateFullQuizSchedule }, [generateFullQuizSchedule])

  useEffect(() => {
    if (phase !== 'watching' || !selectedVideo) return
    const intervalSec = settings.movieTimePuzzleIntervalSec ?? 600
    if (!intervalSec || intervalSec <= 0) return

    const videoId = selectedVideo?.id ?? selectedVideo?.title ?? String(selectedVideo)
    const isWebview = selectedVideo?.provider === 'netflix' || selectedVideo?.provider === 'disney' || selectedVideo?.provider === 'youtube'
    const webviewUrl = lastPrewatchUrlRef.current

    if (isWebview) {
      if (!webviewUrl || (
        scheduleVideoIdRef.current === videoId &&
        scheduleVideoUrlRef.current === webviewUrl &&
        scheduleIntervalKeyRef.current === intervalSec &&
        quizScheduleRef.current.length > 0
      )) return
    } else {
      if (
        scheduleVideoIdRef.current === videoId &&
        scheduleIntervalKeyRef.current === intervalSec &&
        quizScheduleRef.current.length > 0
      ) return
    }

    // New video or new interval — cancel any in-flight generation and start fresh
    quizScheduleAbortRef.current = true
    const myKey = ++scheduleGenerationKeyRef.current
    quizScheduleAbortRef.current = false

    scheduleVideoIdRef.current   = videoId
    scheduleVideoUrlRef.current  = isWebview ? webviewUrl : null
    scheduleIntervalKeyRef.current = intervalSec

    // Reset schedule state so the new interval's slots are used
    setQuizSchedule([])
    quizScheduleRef.current = []
    currentQuizIndexRef.current = 0

    // Wait a tick so the player is ready, then read duration and generate
    const timer = setTimeout(async () => {
      if (scheduleGenerationKeyRef.current !== myKey) return  // stale call
      let videoDurationSec = 0
      if (isWebview) {
        videoDurationSec = webviewDurationRef.current || 0
      } else {
        try {
          const dur = playerRef.current?.getDuration?.()
          if (dur && dur > 0) videoDurationSec = dur
        } catch (_) {}
      }

      const startFrom = savedTimeRef.current ?? 0
      await generateFullQuizScheduleRef.current?.(selectedVideo, intervalSec, videoDurationSec, startFrom)
    }, 1500)  // 1.5s delay to let the player initialise

    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, selectedVideo, settings.movieTimePuzzleIntervalSec, webviewDuration])

  // Start gates once puzzle / prewatch loads
  useEffect(() => {
    if ((phase !== 'puzzle' && phase !== 'prewatch') || puzzleLoading || !puzzle) return

    const qMs = settings.movieTimeQuizQuestionGateMs ?? 2000
    const aMs = settings.movieTimeQuizAnswerGateMs   ?? 1500

    // Unified voice-over queue for question and choices
    speakPuzzleVoiceOver(puzzle.question, puzzle.choices)

    runGates(
      qMs, aMs,
      setPuzzleQuestionGate, setPuzzleAnswerGate,
      setPuzzleGateProgress, setPuzzleAnswerGateProgress,
      () => {}, // fully unlocked
      () => {
        isAnswerGateStartedRef.current = true
        if (isQuestionVoiceOverCompletedRef.current && ttsChoiceQueueRef.current.length > 0) {
          if (choicesDelayTimeoutRef.current) clearTimeout(choicesDelayTimeoutRef.current)
          choicesDelayTimeoutRef.current = setTimeout(() => {
            speakNextFromQueue()
          }, 1000)
        }
      }
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, puzzleLoading, puzzle, gateTriggerKey])

  // ── Quiz Countdown Titlebar Sync & Callback ──────────────────────────────
  const handleQuizButtonClick = useCallback(() => {
    if (nextPuzzleConfirm) {
      // Second click — fire puzzle immediately
      clearTimeout(nextPuzzleConfirmTimerRef.current)
      setNextPuzzleConfirm(false)
      clearInterval(puzzleTimerRef.current)
      setPuzzleCountdown(null)
      try {
        const t = playerRef.current?.getCurrentTime?.()
        if (t != null) savedTimeRef.current = t
      } catch (_) {}
      const totalQs = settings.movieTimePuzzleQuestionsPerQuiz ?? 3
      try { playerRef.current?.pauseVideo() } catch (_) {}
      setPuzzleQuestionGate(true)
      setPuzzleAnswerGate(false)
      setPuzzleGateProgress(0)
      setPuzzleAnswerGateProgress(0)
      setPuzzleWrongCount(0)
      setPersistentWrong({})
      setPuzzleQuestionIndex(1)
      setPuzzleTotalQuestions(totalQs)
      const scheduleSlot = quizScheduleRef.current[currentQuizIndexRef.current]
      const scheduleQs   = scheduleSlot?.questions ?? []
      if (scheduleQs.length > 0) {
        setPuzzleLoading(false)
        setPuzzleQuestions(scheduleQs)
        puzzleQuestionsRef.current = scheduleQs
        setPuzzle(scheduleQs[0])
        setPhase('puzzle')
      } else {
        setPuzzleLoading(true)
        setPhase('puzzle')
        generateQuestion(selectedVideo, null, 'watching', savedTimeRef.current).then(q => {
          setPuzzle(q)
          setPuzzleLoading(false)
        })
      }
      currentQuizIndexRef.current += 1
    } else {
      // First click — prime the button
      setNextPuzzleConfirm(true)
      clearTimeout(nextPuzzleConfirmTimerRef.current)
      nextPuzzleConfirmTimerRef.current = setTimeout(() => {
        setNextPuzzleConfirm(false)
      }, 5000)
    }
  }, [nextPuzzleConfirm, generateQuestion, selectedVideo, settings.movieTimePuzzleQuestionsPerQuiz])

  useEffect(() => {
    if (!setAppTitlebarQuizInfo) return
    if (phase === 'watching' && puzzleTimer != null) {
      setAppTitlebarQuizInfo({
        puzzleTimerText: formatTimer(puzzleTimer),
        nextPuzzleConfirm,
        onQuizButtonClick: handleQuizButtonClick
      })
    } else {
      setAppTitlebarQuizInfo(null)
    }
    return () => {
      setAppTitlebarQuizInfo(null)
    }
  }, [phase, puzzleTimer, nextPuzzleConfirm, handleQuizButtonClick, setAppTitlebarQuizInfo])

  // ── Puzzle answer handling ────────────────────────────────────────────────
  const handlePuzzleAnswer = useCallback((choiceIdx) => {
    if (!puzzle || puzzleQuestionGate || puzzleAnswerGate) return
    const correct = choiceIdx === puzzle.correctIndex
    playSoundEffect(correct ? 'correct' : 'wrong')
    if (correct) {
      setFeedback('correct')
    } else {
      // Flash red cross on the specific wrong choice box
      setWrongFeedbackIdx(choiceIdx)
      // Mark this choice with a persistent ❌ and increment wrong counter
      setPersistentWrong(prev => ({ ...prev, [choiceIdx]: true }))
      setPuzzleWrongCount(prev => prev + 1)
    }
    setTimeout(() => {
      setFeedback(null)
      setWrongFeedbackIdx(null)
      if (correct) {
        const nextIndex = puzzleQuestionIndex + 1
        if (nextIndex <= puzzleTotalQuestions) {
          // More questions remain -- load the next one without resuming video
          setPuzzleQuestionIndex(nextIndex)
          setPuzzleWrongCount(0)
          setPersistentWrong({})
          setPuzzle(null)
          
          const nextQ = puzzleQuestionsRef.current[nextIndex - 1]
          if (nextQ) {
            setPuzzle(nextQ)
            setPuzzleLoading(false)
          } else {
            // Fallback just in case
            setPuzzleLoading(true)
            generateQuestion(selectedVideo, null, 'watching', savedTimeRef.current).then(q => {
              setPuzzle(q)
              setPuzzleLoading(false)
            })
          }
        } else {
          // All questions answered -- resume video
          setPuzzle(null)
          setPuzzleWrongCount(0)
          setPersistentWrong({})
          setPuzzleQuestionIndex(1)
          setPhase('watching')
          // Bring Chrome/Edge back to front (it may have lost z-order during quiz interaction)
          window.gazeAPI?.chromeBringToFront?.()
          setTimeout(() => {
            try {
              // Resume from the exact video timestamp saved just before the quiz fired
              if (savedTimeRef.current > 0) {
                playerRef.current?.seekTo(savedTimeRef.current, true)
              }
              playerRef.current?.playVideo()
            } catch (_) {}
            // Belt-and-suspenders: also send play via the Chrome CDP channel directly
            window.gazeAPI?.chromeControlVideo?.('play')
          }, 300)
          // No need to pre-fetch — quiz schedule already generated all future slots
        }
      }
    }, correct ? 2200 : 1200)
  }, [puzzle, puzzleQuestionGate, puzzleAnswerGate, playSoundEffect, puzzleQuestionIndex, puzzleTotalQuestions, generateQuestion, selectedVideo, preFetchPuzzleQuestions])

  // ── Register hit targets with the unified TelemetryRouter ──────────────────
  useEffect(() => {
    if (!registerHitTargets) return

    const registerAll = () => {
      const cells = []
      const vw = window.innerWidth
      const vh = window.innerHeight
      const measure = (id, el) => {
        if (!el) return
        const r = el.getBoundingClientRect()
        cells.push({ id, x0: r.left / vw, y0: r.top / vh, x1: r.right / vw, y1: r.bottom / vh })
      }

      measure('back', backBtnRef.current)
      measure('settings', settingsBtnRef.current)
      
      if (!selectedProvider) {
        measure('prov-suggested', document.getElementById('prov-btn-suggested'))
        measure('prov-youtube', document.getElementById('prov-btn-youtube'))
        measure('prov-netflix', document.getElementById('prov-btn-netflix'))
        measure('prov-disney', document.getElementById('prov-btn-disney'))
      }

      if (selectedVideo && (selectedVideo.provider === 'netflix' || selectedVideo.provider === 'disney' || selectedVideo.provider === 'youtube') && phase === 'watching') {
        measure('wv-back', document.getElementById('wv-btn-back'))
        measure('wv-reload', document.getElementById('wv-btn-reload'))
        measure('wv-navback', document.getElementById('wv-btn-navback'))
        measure('wv-navforward', document.getElementById('wv-btn-navforward'))
      }

      if (phase === 'browse') {
        measure('refresh', refreshBtnRef.current)
        videos.forEach(vid => {
          measure(`video-${vid.id}`, document.getElementById(`video-card-${vid.id}`) || videoCardRefs.current[vid.id])
        })
      }
      if ((phase === 'puzzle' || phase === 'prewatch') && puzzle) {
        const numChoices = puzzle.choices?.length ?? 4
        if (!puzzleQuestionGate && !puzzleAnswerGate) {
          for (let i = 0; i < numChoices; i++) {
            if (!persistentWrong[i]) {
              measure(`puz-${i}`, document.getElementById(`puz-choice-${i}`) || puzzleChoiceRefs.current[i])
            }
          }
        }
        if (puzzleAnswerGate && !puzzleQuestionGate) {
          for (let i = 0; i < numChoices; i++) {
            if (!persistentWrong[i]) {
              measure(`puzgate-${i}`, document.getElementById(`puz-choice-${i}`) || puzzleChoiceRefs.current[i])
            }
          }
        }
      }
      if ((phase === 'puzzle' || phase === 'prewatch') && puzzleQuestionGate && puzzleQuestionRef.current) {
        measure('puz-question', puzzleQuestionRef.current)
      }
      registerHitTargets(cells)
    }

    // Measure on mount/update (using requestAnimationFrame to ensure layout is complete)
    const frame = requestAnimationFrame(registerAll)

    // Measure on window resize
    window.addEventListener('resize', registerAll)

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', registerAll)
    }
  }, [registerHitTargets, phase, puzzleQuestionGate, puzzleAnswerGate, videos, puzzle, topbarHeight, puzzleWrongCount, persistentWrong])

  // Keep gazedAwayRef in sync with state so the stable gaze handler can read it
  useEffect(() => { gazedAwayRef.current = gazedAway }, [gazedAway])
  // Keep gazeNoDataRef in sync with state
  useEffect(() => { gazeNoDataRef.current = gazeNoData }, [gazeNoData])

  // ── Sync gate active refs from unified router's gazeState ─────────────────
  useEffect(() => {
    const cellId = parentGazeState?.cellId ?? null
    questionGazeActiveRef.current  = (cellId === 'puz-question')
    answerGazeActiveRef.current    = (cellId?.startsWith?.('puzgate-') ?? false)
    selectionGazeActiveRef.current = (phase === 'browse' && (cellId?.startsWith?.('video-') ?? false))
  }, [parentGazeState, phase])

  // ── Trigger jump-ahead when gaze enters a puzzle choice ───────────────────
  useEffect(() => {
    const cellId = parentGazeState?.cellId
    if (cellId === prevGazeCellRef.current) return
    prevGazeCellRef.current = cellId
    if (!cellId) return
    if (cellId.startsWith('puzgate-') || (cellId.startsWith('puz-') && cellId !== 'puz-question')) {
      const choiceIdx = parseInt(cellId.replace('puzgate-', '').replace('puz-', ''))
      triggerJumpAhead(choiceIdx)
    }
  }, [parentGazeState, triggerJumpAhead])

  // ── Gaze-away detection via unified router's rawGazeRef ───────────────────
  useEffect(() => {
    if (!rawGazeRef) return
    rawGazeRef.current = (gazePoint) => {
      if (gazeBlocked) return
      const { x, y, valid } = gazePoint

      // Update last gaze time for the no-gaze watchdog
      if (valid && x != null) {
        lastGazeTimeRef.current = performance.now()
        lastGazeRef.current = { x, y }

        // Clear any no-gaze state
        gazeNoDataStart.current = null
        if (gazeNoDataRef.current) {
          gazeNoDataRef.current = false
          setGazeNoData(false)
        }
      }

      // Gaze-away detection (watching phase only)
      if (phase !== 'watching') return
      if (!valid || x == null) return

      const px = x * window.innerWidth
      const py = y * window.innerHeight

      const rect = playerWrapRef.current?.getBoundingClientRect?.()
      const away = rect
        ? (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom)
        : false

      let isPlaying = false
      let isPausedByGaze = pausedByGazeRef.current
      try {
        isPlaying = playerRef.current?.getPlayerState?.() === 1
      } catch (_) {}

      if (away) {
        if (isPlaying) {
          if (!gazeAwayStart.current) gazeAwayStart.current = performance.now()
          const awayFor = performance.now() - gazeAwayStart.current
          const threshMs = settings.movieTimeGazeAwayMs ?? 3000
          if (threshMs === 0) { gazeAwayStart.current = null }
          else if (awayFor >= threshMs && !gazedAwayRef.current) {
            gazedAwayRef.current = true
            setGazedAway(true)
            pausedByGazeRef.current = true
            try {
              const t = playerRef.current?.getCurrentTime?.()
              if (t != null && t > 0) savedTimeRef.current = t
            } catch (_) {}
            try { playerRef.current?.pauseVideo() } catch (_) {}
          }
        } else {
          if (!isPausedByGaze) {
            gazeAwayStart.current = null
          }
        }
      } else {
        gazeAwayStart.current = null
        if (gazedAwayRef.current && isPausedByGaze) {
          gazedAwayRef.current = false
          setGazedAway(false)
          pausedByGazeRef.current = false
          try {
            if (savedTimeRef.current > 0) {
              playerRef.current?.seekTo(savedTimeRef.current, true)
            }
          } catch (_) {}
          try { playerRef.current?.playVideo() } catch (_) {}
        }
      }
    }
    return () => { if (rawGazeRef) rawGazeRef.current = null }
  }, [rawGazeRef, gazeBlocked, phase, settings.movieTimeGazeAwayMs])

  // ── Wire dwell activation from unified router ─────────────────────────────
  useEffect(() => {
    if (!onDwellRef) return
    onDwellRef.current = (cellId) => {
      if (gazeBlocked) return
      playSoundEffect('click')
      
      if (cellId === 'prov-suggested') { setSelectedProvider('suggested'); return }
      if (cellId === 'prov-youtube') { setSelectedProvider('youtube'); return }
      if (cellId === 'prov-netflix') { setSelectedProvider('netflix'); return }
      if (cellId === 'prov-disney')  { setSelectedProvider('disney'); return }

      if (cellId === 'wv-back' || cellId === 'wv-exit') {
        setSelectedProvider(null);
        setIsVideoPlaying(false);
        return;
      }
      if (cellId === 'wv-reload') {
        window.gazeAPI?.chromeReload?.();
        try { webviewRef.current?.reload() } catch (_) {}
        return;
      }
      if (cellId === 'wv-navback') {
        window.gazeAPI?.chromeGoBack?.();
        try { if (webviewRef.current?.canGoBack()) webviewRef.current?.goBack() } catch (_) {}
        return;
      }
      if (cellId === 'wv-navforward') {
        window.gazeAPI?.chromeGoForward?.();
        try { if (webviewRef.current?.canGoForward()) webviewRef.current?.goForward() } catch (_) {}
        return;
      }

      if (cellId === 'back')     { handleBack(); return }
      if (cellId === 'settings') { setShowGearPopover(v => !v); return }
      if (cellId === 'refresh')  { fetchVideos(); return }
      if (cellId?.startsWith('video-')) {
        if (!selectionGatePassed) return
        const vid = videos.find(v => String(v.id) === String(cellId.replace('video-', '')))
        if (vid) selectVideo(vid)
        return
      }
      if (cellId?.startsWith('puz-') && !cellId.startsWith('puzgate-') && cellId !== 'puz-question') {
        handlePuzzleAnswer(parseInt(cellId.replace('puz-', '')))
        return
      }
    }
    return () => { if (onDwellRef) onDwellRef.current = null }
  }, [onDwellRef, gazeBlocked, onBack, fetchVideos, videos, selectVideo, handlePuzzleAnswer, selectionGatePassed, playSoundEffect])

  // ── Tell App.jsx about cursor visibility for this mode ────────────────────
  useEffect(() => {
    if (!cursorStyleRef) return
    const showCursor = settings.movieTimeShowGazeCursor ?? true
    const shouldHide = !showCursor && phase === 'watching' && isVideoPlaying
    cursorStyleRef.current = { shouldHide }
  }, [cursorStyleRef, settings.movieTimeShowGazeCursor, phase, isVideoPlaying])

  // Handle no-gaze-detected: called when the eye tracker sends null coordinates.\n  // Behaves like gaze-away — pauses after the same threshold.
  // Handle no-gaze-detected: called when the eye tracker sends null coordinates.
  // Behaves like gaze-away — pauses after the same threshold.
  const handleNoGaze = useCallback(() => {
    if (gazeBlocked) return
    if (phase !== 'watching') return

    // Skip if setting is disabled
    if (settings.movieTimePauseOnGazeLost === false) {
      gazeNoDataStart.current = null
      return
    }

    let isPlaying = false
    try {
      isPlaying = playerRef.current?.getPlayerState?.() === 1
    } catch (_) {}

    if (!isPlaying) {
      gazeNoDataStart.current = null
      return
    }

    const threshMs = settings.movieTimeGazeAwayMs ?? 3000
    // 0 = Unlimited — never auto-pause when gaze is lost
    if (threshMs === 0) return
    const lostDuration = performance.now() - lastGazeTimeRef.current
    if (lostDuration >= threshMs && !gazedAwayRef.current) {
      gazedAwayRef.current = true
      setGazedAway(true)
      setGazeNoData(true)
      pausedByGazeRef.current = true
      try {
        const t = playerRef.current?.getCurrentTime?.()
        if (t != null && t > 0) savedTimeRef.current = t
      } catch (_) {}
      try { playerRef.current?.pauseVideo() } catch (_) {}
    }
  }, [gazeBlocked, phase, settings.movieTimeGazeAwayMs, settings.movieTimePauseOnGazeLost])

  // Keep the stable no-gaze ref up to date
  useEffect(() => { handleNoGazeRef.current = handleNoGaze }, [handleNoGaze])

  // ── Gaze Watchdog Timer ───────────────────────────────────────────────────
  // If the eye tracker stops sending events completely (e.g., eyes closed or
  // gaze lost), this watchdog triggers the no-gaze pause logic.
  useEffect(() => {
    if (phase !== 'watching' || settings.mouseHoverMode) return

    lastGazeTimeRef.current = performance.now()

    const checkInterval = setInterval(() => {
      const elapsed = performance.now() - lastGazeTimeRef.current
      const threshMs = settings.movieTimeGazeAwayMs ?? 3000
      // 0 = Unlimited — never auto-pause
      if (threshMs > 0 && elapsed >= threshMs) {
        handleNoGazeRef.current?.()
      }
    }, 250)

    return () => clearInterval(checkInterval)
  }, [phase, settings.mouseHoverMode, settings.movieTimeGazeAwayMs])

  // ── Gaze cursor custom styles for MovieTime ──────────────────────────────────
  // Cursor positioning is handled by App.jsx; here we only apply mode-specific
  // visual styles (tiny dot during playback, full settings-based cursor otherwise).
  useEffect(() => {
    const el = gazeCursorRef?.current
    if (!el) return

    if (phase === 'watching' && isVideoPlaying) {
      // Apply a very tiny, partially transparent dot cursor to avoid distracting
      Object.assign(el.style, {
        width: '4px',
        height: '4px',
        background: settings.cursorColor || 'rgba(0, 200, 255, 0.7)',
        border: 'none',
        borderRadius: '50%',
        boxShadow: 'none',
        filter: 'none',
        rotate: '0deg',
        opacity: '0.3',
      })
    } else {
      // Restore default settings-based cursor style
      const sz    = settings.cursorSize  ?? 20
      const shape = settings.cursorShape ?? 'circle'
      const color = settings.cursorColor || 'rgba(0, 200, 255, 0.7)'

      Object.assign(el.style, {
        width:        `${sz}px`,
        height:       `${sz}px`,
        background:   color,
        border:       'none',
        borderRadius: '50%',
        boxShadow:    `0 0 12px 4px currentColor`,
        filter:       'blur(2px)',
        rotate:       '0deg',
        opacity:      '',
      })

      switch (shape) {
        case 'circle': break
        case 'ring':
          el.style.background   = 'transparent'
          el.style.border       = `${Math.max(2, sz * 0.18)}px solid ${color}`
          el.style.filter       = 'none'
          el.style.boxShadow    = `0 0 10px 2px ${color}`
          break
        case 'dot': {
          const ds = Math.max(6, sz * 0.55)
          el.style.width        = `${ds}px`
          el.style.height       = `${ds}px`
          el.style.filter       = 'none'
          el.style.boxShadow    = `0 0 8px 3px ${color}`
          break
        }
        case 'crosshair': {
          const arm  = sz + 10
          const thin = 2
          el.style.width        = `${thin}px`
          el.style.height       = `${arm}px`
          el.style.borderRadius = '1px'
          el.style.filter       = 'none'
          el.style.boxShadow    = [
            `${arm / 2}px 0 0 0 ${color}`,
            `-${arm / 2}px 0 0 0 ${color}`,
            `0 0 8px 2px ${color}`,
          ].join(', ')
          break
        }
        case 'diamond':
          el.style.borderRadius = '3px'
          el.style.rotate       = '45deg'
          el.style.filter       = 'none'
          el.style.boxShadow    = `0 0 10px 2px ${color}`
          break
        default: break
      }
    }

    // Cleanup: restore default cursor style when component unmounts
    return () => {
      const elCleanup = gazeCursorRef?.current
      if (!elCleanup) return
      const sz    = settings.cursorSize  ?? 20
      const color = settings.cursorColor || 'rgba(0, 200, 255, 0.7)'
      Object.assign(elCleanup.style, {
        width: `${sz}px`, height: `${sz}px`,
        background: color, border: 'none', borderRadius: '50%',
        boxShadow: `0 0 12px 4px currentColor`, filter: 'blur(2px)',
        rotate: '0deg', opacity: '',
      })
    }
  }, [gazeCursorRef, settings.cursorSize, settings.cursorShape, settings.cursorColor, settings.movieTimeShowGazeCursor, phase, isVideoPlaying])

  // Cleanup gate timers on unmount
  useEffect(() => {
    return () => {
      if (questionGateTimerRef.current)   cancelAnimationFrame(questionGateTimerRef.current)
      if (answerGateTimerRef.current)     cancelAnimationFrame(answerGateTimerRef.current)
      if (gateAnimFrameRef.current)       cancelAnimationFrame(gateAnimFrameRef.current)
      if (answerGateAnimFrameRef.current) cancelAnimationFrame(answerGateAnimFrameRef.current)
      if (selectionGateRafRef.current)    cancelAnimationFrame(selectionGateRafRef.current)
      if (voiceOverQueueRef.current)      clearTimeout(voiceOverQueueRef.current)
      if (questionTtsTimeoutRef.current)  clearTimeout(questionTtsTimeoutRef.current)
      if (choicesDelayTimeoutRef.current) clearTimeout(choicesDelayTimeoutRef.current)
    }
  }, [])

  // ── Sync topbar height as CSS variable so .mq-overlay starts right below it ─
  // Handled dynamically via topbarRef useCallback callback ref above

  const resetToQuestionGate = useCallback(() => {
    clearTtsTimers()
    if (window.speechSynthesis) window.speechSynthesis.cancel()
    setGateTriggerKey(prev => prev + 1)
  }, [clearTtsTimers])

  // ── Manual Gate Progression by Mouse Click, Spacebar, or Forward Keys ──
  useEffect(() => {
    const handleTrigger = (e) => {
      // 1. Identify back keys first
      if (e.type === 'keydown') {
        const isBackKey = e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Backspace';
        if (isBackKey) {
          e.preventDefault();
          // "A keyboard backkey would bring one action back."
          if (phase === 'puzzle' && puzzle) {
            if (!puzzleQuestionGate) {
              // We are in Answer Gate or choices visible -> Go back to Question Gate
              resetToQuestionGate();
              playSoundEffect('click');
            } else {
              // We are already in Question Gate -> Go back to the previous question
              if (puzzleQuestionIndex > 1) {
                const prevIndex = puzzleQuestionIndex - 1;
                setPuzzleQuestionIndex(prevIndex);
                setPuzzleWrongCount(0);
                setPersistentWrong({});
                setPuzzle(null);
                playSoundEffect('click');
                const prevQ = puzzleQuestionsRef.current[prevIndex - 1];
                if (prevQ) {
                  setPuzzle(prevQ);
                  setPuzzleLoading(false);
                }
              }
            }
          }
          return;
        }
      }

      // 2. Identify triggering keys (Spacebar or Forward Keys like Right Arrow, Page Down, Down Arrow, Enter)
      if (e.type === 'keydown') {
        const isSpace = e.key === ' ' || e.key === 'Spacebar';
        const isForwardKey = e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'ArrowDown' || e.key === 'Enter';
        if (!isSpace && !isForwardKey) return;
        
        // Prevent default spacebar scrolling or presentation clicker actions
        e.preventDefault();
      }

      // 3. Determine active gate and progress it
      if (phase === 'browse') {
        const gateMs = settings.movieTimeSelectionGateMs ?? 0;
        if (!selectionGatePassed && gateMs > 0) {
          if (selectionGateRafRef.current) {
            cancelAnimationFrame(selectionGateRafRef.current);
            selectionGateRafRef.current = null;
          }
          selectionGateAccumRef.current = gateMs;
          if (selectionGateFillRef.current) {
            selectionGateFillRef.current.style.width = '100%';
          }
          setSelectionGatePassed(true);
          setSelectionGateProgress(1);
          playSoundEffect('click');
        }
      } else if ((phase === 'puzzle' || phase === 'prewatch') && !puzzleLoading && puzzle) {
        if (puzzleQuestionGate) {
          if (gateAnimFrameRef.current) {
            cancelAnimationFrame(gateAnimFrameRef.current);
            gateAnimFrameRef.current = null;
          }
          if (updateQDOMRef.current) {
            updateQDOMRef.current(1);
          }
          setPuzzleQuestionGate(false);
          setPuzzleGateProgress(1);
          playSoundEffect('click');
          if (startAnswerGateRef.current) {
            startAnswerGateRef.current();
          }
        } else if (puzzleAnswerGate) {
          if (answerGateAnimFrameRef.current) {
            cancelAnimationFrame(answerGateAnimFrameRef.current);
            answerGateAnimFrameRef.current = null;
          }
          if (updateADOMRef.current) {
            updateADOMRef.current(1);
          }
          setPuzzleAnswerGate(false);
          setPuzzleAnswerGateProgress(1);
          playSoundEffect('click');
          if (onDoneRef.current) {
            onDoneRef.current();
          }
        }
      }
    };

    window.addEventListener('keydown', handleTrigger);
    window.addEventListener('click', handleTrigger);

    return () => {
      window.removeEventListener('keydown', handleTrigger);
      window.removeEventListener('click', handleTrigger);
    };
  }, [
    phase,
    selectionGatePassed,
    settings.movieTimeSelectionGateMs,
    puzzleQuestionGate,
    puzzleAnswerGate,
    puzzleLoading,
    puzzle,
    puzzleQuestionIndex,
    playSoundEffect,
    resetToQuestionGate
  ]);

  // ── Dynamic question font sizing ──────────────────────────────────────────
  // Measures the question container and scales the font so the text fits
  // within the 30vh max-height constraint without overflow.
  useEffect(() => {
    const container = puzzleQuestionRef.current
    if (!container) return
    const qEl = container.querySelector('.mq-question')
    if (!qEl) return

    // Reset to max size first to measure natural height
    const maxSize = Math.min(window.innerWidth * 0.04, 48) // 4vw capped at 48px (~3rem)
    const minSize = Math.min(window.innerWidth * 0.02, 18) // 2vw capped at 18px (~1.1rem)
    qEl.style.fontSize = `${maxSize}px`

    // Allow a frame for layout to settle
    const raf = requestAnimationFrame(() => {
      const maxH = window.innerHeight * 0.30
      let currentSize = maxSize

      // Binary search for the right size
      let lo = minSize, hi = currentSize
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2)
        qEl.style.fontSize = `${mid}px`
        if (qEl.scrollHeight > maxH) {
          hi = mid
        } else {
          lo = mid
        }
      }
      qEl.style.fontSize = `${lo}px`
    })
    return () => cancelAnimationFrame(raf)
  }, [puzzle?.question, phase])

  // ── Time-until-puzzle display ─────────────────────────────────────────────
  const formatTimer = (s) => {
    if (s == null) return ''
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `Next puzzle in ${m}:${String(sec).padStart(2, '0')}`
  }

  // ── Render helpers ────────────────────────────────────────────────────────
  const noApiKey = (
    (settings.movieTimeYoutubeKeys ?? []).filter(k => k?.key?.trim()).length === 0 &&
    !settings.movieTimeYoutubeKey?.trim()
  ) && !settings.movieTimeOnlyFromList

  // Renders a full-screen quiz overlay (used for both prewatch and puzzle)
  const renderQuizOverlay = ({
    question, choices, correctIndex,
    questionGate, answerGate,
    gateProgress, answerGateProgress,
    result,           // prewatch: preResult; puzzle: null (uses feedback state)
    onChoiceSelect,
    choiceRefsObj,
    idPrefix,
    badge,
    isLoading,
    onSkip,
    wrongCount,       // number of wrong answers so far
    persistWrong,     // { [idx]: true } for persistently marked wrong choices
    hintAfter,        // number of wrongs before hint is shown (0 = disabled)
    readingTarget,    // null | 'question' | number (choice index) — underline while TTS
    wrongFlashIdx,    // index of choice currently flashing wrong (null otherwise)
    questionSource,   // 'gemini' | 'fallback' | undefined
    questionIndex,    // 1-based current question number in this session
    totalQuestions,   // total questions in this session
    promptParams,     // { model, type, difficulty, level, subject, videoTitle }
  }) => {
    const numChoices = choices?.length ?? 4
    const gridClass  = numChoices <= 2
      ? 'mq-choices--cols-1'
      : 'mq-choices--cols-2'

    const showHint = hintAfter > 0 && wrongCount >= hintAfter

    return (
      <div className="mq-overlay" role="dialog" aria-modal="true">

        {/* Question area — ref used for gaze-gate tracking; box shows user where to look */}
        <div
          className={`mq-question-area ${questionGate ? 'mq-question-area--gate' : ''}`}
          ref={puzzleQuestionRef}
        >
          {isLoading ? (
            <div className="mq-loading">
              <div className="mq-spinner" />
              <span>Generating your question… ({loadingSeconds}s)</span>
            </div>
          ) : question ? (
            <p className={`mq-question${readingTarget === 'question' ? ' mq-question--reading' : ''}`}>{question}</p>
          ) : null}

          {/* ── Discrete gaze-gate progress bar — inside the question box ── */}
          {!isLoading && questionGate && (
            <div className="mq-gate-progress-section" aria-hidden="true">
              <div className="mq-gate-progress-track mq-gate-progress-track--question">
                <div className="mq-gate-progress-bar">
                  <div
                    ref={gateProgressProminentRef}
                    className="mq-gate-progress-fill mq-gate-progress-fill--question"
                    style={{ width: `${gateProgress * 100}%` }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Answer gate progress bar — outside question box, preserved for layout stability ── */}
        {!isLoading && !questionGate && (
          <div className={`mq-gate-progress-section${!answerGate ? ' mq-gate-progress-section--done' : ''}`} aria-hidden="true">
            <div className={`mq-gate-progress-track mq-gate-progress-track--answer${!answerGate ? ' mq-gate-progress-track--complete' : ''}`}>
              <div className="mq-gate-progress-label">
                <span className="mq-gate-progress-icon">👁️</span>
                <span>{answerGate ? 'Look at an answer…' : ''}</span>
              </div>
              <div className="mq-gate-progress-bar">
                <div
                  ref={answerProgressProminentRef}
                  className="mq-gate-progress-fill mq-gate-progress-fill--answer"
                  style={{ width: `${answerGateProgress * 100}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Choices area — always fills remaining space */}
        {choices && !isLoading && !questionGate && (
          <div className={`mq-choices ${gridClass}`}>
            {choices.map((c, i) => {
              const isGazed        = gazeState.target === `${idPrefix}-${i}`
              const progress       = isGazed ? gazeState.progress : 0
              const isCorrect      = result === 'correct' && i === correctIndex
              const isWrong        = result === 'wrong'   && i !== correctIndex
              const isPersistWrong = !!(persistWrong?.[i])
              const isHinted       = showHint && i === correctIndex && !isPersistWrong
              const locked         = questionGate || answerGate
              // During question gate: visible but locked; during answer gate: locked by answerGate flag
              const isQGateLocked  = questionGate   // choices visible but cannot be selected
              const isAGateLocked  = answerGate && !questionGate
              const isReading      = readingTarget === i  // TTS is currently reading this choice

              const isWrongFlash = wrongFlashIdx === i

              return (
                <button
                  key={i}
                  ref={el => { choiceRefsObj.current[i] = el }}
                  id={`${idPrefix}-choice-${i}`}
                  className={[
                    'mq-choice',
                    isGazed        ? 'mq-choice--gazed'        : '',
                    isCorrect      ? 'mq-choice--correct'       : '',
                    isWrong        ? 'mq-choice--wrong'         : '',
                    isPersistWrong ? 'mq-choice--persist-wrong' : '',
                    isHinted       ? 'mq-choice--hint'          : '',
                    isQGateLocked  ? 'mq-choice--q-locked'      : '',
                    isAGateLocked  ? 'mq-choice--a-locked'      : '',
                    locked         ? 'mq-choice--locked'        : '',
                    isReading      ? 'mq-choice--reading'       : '',
                    isWrongFlash   ? 'mq-choice--wrong-flash'   : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => !locked && !isPersistWrong && onChoiceSelect(i)}
                  onMouseEnter={() => triggerJumpAhead(i)}
                  onFocus={() => triggerJumpAhead(i)}
                  aria-label={c}
                  aria-disabled={locked || isPersistWrong}
                >
                  <span className="mq-choice__text">{c}</span>

                  {/* Wrong flash overlay — full-box red cross, briefly shown on wrong pick */}
                  {isWrongFlash && (
                    <span className="mq-choice__wrong-flash" aria-hidden="true">✕</span>
                  )}

                  {/* Persistent wrong mark (red ❌ cross overlay) */}
                  {isPersistWrong && (
                    <span className="mq-choice__wrong-mark" aria-hidden="true">✕</span>
                  )}

                  {/* Hint indicator on correct answer box */}
                  {isHinted && (
                    <span className="mq-choice__hint-mark" aria-hidden="true">💡</span>
                  )}

                  {/* Dwell progress bar (bottom) — only when fully unlocked */}
                  {!locked && !isPersistWrong && (
                    <span
                      className="mq-choice__dwell"
                      style={{ width: `${progress * 100}%` }}
                      aria-hidden="true"
                    />
                  )}



                  {/* Q-gate lock indicator — subtle but no reading veil */}
                  {isQGateLocked && (
                    <div className="mq-choice__q-gate-lock" aria-hidden="true" />
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* Skip button moved to topbar */}
      </div>
    )
  }

  return (
    <div className={`movie-time${isOverlayActive ? ' movie-time--transparent' : ''}`} role="main" aria-label="Movie Time">
      <div className="movie-time__bg" aria-hidden="true" />

      {/* Top bar (visible only when not in transparent overlay mode) */}
      {!isOverlayActive && (
        <div className="movie-time__topbar" ref={topbarRef}>
        <button
          ref={backBtnRef}
          id="movie-back-btn"
          className="movie-time__back-btn"
          style={{ position: 'relative', overflow: 'hidden' }}
          onClick={handleBack}
          aria-label="Go back to home"
        >
          ← Back
          <span
            className="movie-card__dwell-bar"
            style={{ width: `${gazeState.target === 'back' ? gazeState.progress * 100 : 0}%`, background: 'hsl(195 80% 60%)' }}
            aria-hidden="true"
          />
        </button>
        <span className="movie-time__title">🎬 Movie Time</span>

        {/* ── Quiz info chips — shown inline in topbar during puzzle/prewatch ── */}
        {(phase === 'puzzle' || phase === 'prewatch') && puzzle && !puzzleLoading && (
          <div className="movie-time__quiz-topbar-info">
            {puzzleTotalQuestions > 1 && puzzleQuestionIndex && (
              <span className="mq-progress-pill mq-progress-pill--topbar">
                {puzzleQuestionIndex} / {puzzleTotalQuestions}
              </span>
            )}
            {puzzle.source && (
              <span
                className={`mq-source-chip mq-source-chip--${
                  puzzle.source === 'gemini'          || puzzle.source === 'gemini-schedule'  ? 'gemini' :
                  puzzle.source === 'openai'          || puzzle.source === 'openai-schedule'  ? 'openai' :
                  puzzle.source === 'ollama'          || puzzle.source === 'ollama-schedule'  ? 'ollama' :
                  puzzle.source === 'gemini-nano'      ? 'nano' :
                  puzzle.source === 'gaze-puzzle'      ? 'gaze' :
                  'fallback'
                } mq-source-chip--topbar`}
                title={
                  puzzle.source === 'gemini'           ? 'Question generated by Gemini AI' :
                  puzzle.source === 'gemini-schedule'  ? 'Question pre-generated by Gemini AI' :
                  puzzle.source === 'openai'           ? 'Question generated by ChatGPT (OpenAI)' :
                  puzzle.source === 'openai-schedule'  ? 'Question pre-generated by ChatGPT (OpenAI)' :
                  puzzle.source === 'ollama'           ? 'Question generated by local Ollama' :
                  puzzle.source === 'ollama-schedule'  ? 'Question pre-generated by local Ollama' :
                  puzzle.source === 'gemini-nano'      ? 'Question generated by on-device Gemini Nano' :
                  puzzle.source === 'gaze-puzzle'      ? 'Gaze-friendly True/False puzzle (offline)' :
                  'Question from built-in fallback bank'
                }
              >
                {
                  puzzle.source === 'gemini'           ? '✨ Gemini' :
                  puzzle.source === 'gemini-schedule'  ? '✨ Gemini' :
                  puzzle.source === 'openai'           ? '🤖 ChatGPT' :
                  puzzle.source === 'openai-schedule'  ? '🤖 ChatGPT' :
                  puzzle.source === 'ollama'           ? '🦙 Ollama' :
                  puzzle.source === 'ollama-schedule'  ? '🦙 Ollama' :
                  puzzle.source === 'gemini-nano'      ? '🔬 Nano' :
                  puzzle.source === 'gaze-puzzle'      ? '👁️ Gaze' :
                  '🗂️ Offline'
                }
              </span>
            )}
            {puzzle.promptParams && (
              <>
                {puzzle.promptParams.model && (
                  <span className="mq-param mq-param--model mq-param--topbar" title="AI model">
                    <span className="mq-param__icon">🤖</span>
                    <span className="mq-param__label">{puzzle.promptParams.model}</span>
                  </span>
                )}
                <span className="mq-param mq-param--type mq-param--topbar" title="Question type">
                  <span className="mq-param__icon">🧩</span>
                  <span className="mq-param__label">{puzzle.promptParams.type}</span>
                </span>
                <span className="mq-param mq-param--difficulty mq-param--topbar" title="Difficulty">
                  <span className="mq-param__icon">⚡</span>
                  <span className="mq-param__label">{puzzle.promptParams.difficulty}</span>
                </span>
                <span className="mq-param mq-param--level mq-param--topbar" title="Level">
                  <span className="mq-param__icon">🎓</span>
                  <span className="mq-param__label">{puzzle.promptParams.level}</span>
                </span>
                {puzzle.promptParams.subject && puzzle.promptParams.subject !== 'General' && (
                  <span className="mq-param mq-param--subject mq-param--topbar" title="Subject">
                    <span className="mq-param__icon">📚</span>
                    <span className="mq-param__label">{puzzle.promptParams.subject}</span>
                  </span>
                )}
                {puzzle.promptParams.videoTitle && (
                  <span className="mq-param mq-param--video mq-param--topbar" title="Based on video">
                    <span className="mq-param__icon">🎬</span>
                    <span className="mq-param__label" style={{ maxWidth: '14ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{puzzle.promptParams.videoTitle}</span>
                  </span>
                )}
              </>
            )}
          </div>
        )}

        <span className="movie-time__topbar-spacer" />
        {phase === 'watching' && puzzleTimer != null && (
          <button
            className={`movie-time__status-badge movie-time__status-badge--btn${nextPuzzleConfirm ? ' movie-time__status-badge--primed' : ''}`}
            title={nextPuzzleConfirm ? 'Click again to start the puzzle now' : 'Click to start the next puzzle early'}
            onClick={() => {
              if (nextPuzzleConfirm) {
                // Second click — fire puzzle immediately
                clearTimeout(nextPuzzleConfirmTimerRef.current)
                setNextPuzzleConfirm(false)
                // Simulate the timer reaching zero by clearing the interval and
                // triggering the puzzle launch logic inline
                clearInterval(puzzleTimerRef.current)
                setPuzzleCountdown(null)
                try {
                  const t = playerRef.current?.getCurrentTime?.()
                  if (t != null) savedTimeRef.current = t
                } catch (_) {}
                const totalQs = settings.movieTimePuzzleQuestionsPerQuiz ?? 3
                try { playerRef.current?.pauseVideo() } catch (_) {}
                setPuzzleQuestionGate(true)
                setPuzzleAnswerGate(false)
                setPuzzleGateProgress(0)
                setPuzzleAnswerGateProgress(0)
                setPuzzleWrongCount(0)
                setPersistentWrong({})
                setPuzzleQuestionIndex(1)
                setPuzzleTotalQuestions(totalQs)
                // Check schedule BEFORE setting phase/loading so we only show the
                // "Generating…" spinner if we genuinely need to call the API.
                const scheduleSlot = quizScheduleRef.current[currentQuizIndexRef.current]
                const scheduleQs   = scheduleSlot?.questions ?? []
                if (scheduleQs.length > 0) {
                  // Pre-generated questions available — no spinner needed
                  setPuzzleLoading(false)
                  setPuzzleQuestions(scheduleQs)
                  puzzleQuestionsRef.current = scheduleQs
                  setPuzzle(scheduleQs[0])
                  setPhase('puzzle')
                } else {
                  // No pre-generated questions — show spinner and generate on-the-fly
                  setPuzzleLoading(true)
                  setPhase('puzzle')
                  generateQuestion(selectedVideo, null, 'watching', savedTimeRef.current).then(q => {
                    setPuzzle(q)
                    setPuzzleLoading(false)
                  })
                }
                currentQuizIndexRef.current += 1
              } else {
                // First click — prime the button
                setNextPuzzleConfirm(true)
                clearTimeout(nextPuzzleConfirmTimerRef.current)
                nextPuzzleConfirmTimerRef.current = setTimeout(() => {
                  setNextPuzzleConfirm(false)
                }, 5000)
              }
            }}
          >
            {nextPuzzleConfirm ? '▶ Start puzzle now' : formatTimer(puzzleTimer)}
          </button>
        )}

        {/* Pause Video button — shown in top bar during quiz phases for caregiver access */}
        {(phase === 'puzzle' || phase === 'prewatch') && (
          <button
            className="mq-pause-btn mq-pause-btn--topbar"
            onClick={() => {
              try { playerRef.current?.pauseVideo() } catch (_) {}
            }}
            title="Pause video (caregiver use)"
          >
            ⏸️ Pause Video
          </button>
        )}

        {/* Skip button — shown in top bar during puzzle phase for caregiver access */}
        {phase === 'puzzle' && (
          <button
            className="mq-skip mq-skip--topbar"
            onClick={() => {
              setPuzzle(null)
              setPuzzleWrongCount(0)
              setPersistentWrong({})
              setPhase('watching')
              window.gazeAPI?.chromeBringToFront?.()
              setTimeout(() => {
                try {
                  if (savedTimeRef.current > 0) {
                    playerRef.current?.seekTo(savedTimeRef.current, true)
                  }
                  playerRef.current?.playVideo()
                } catch (_) {}
                window.gazeAPI?.chromeControlVideo?.('play')
              }, 300)
            }}
            title="Skip this question (caregiver use)"
          >
            Skip
          </button>
        )}

        {onOpenSettings && (
          <div 
            ref={gearContainerRef}
            style={{ position: 'relative' }}
          >
            <button
              ref={settingsBtnRef}
              id="movie-settings-btn"
              className="movie-time__gear-btn"
              aria-label="Open settings"
              title="Settings"
              onClick={() => setShowGearPopover(v => !v)}
            >⚙</button>

            {showGearPopover && (
              <div
                className="movie-time__gear-popover"
                role="menu"
                style={{ background: '#1a1d28', opacity: 1 }}
              >
                <button
                  className="movie-time__gear-popover-item"
                  role="menuitem"
                  onClick={() => { onOpenSettings('movietime'); setShowGearPopover(false) }}
                >
                  🎬 Movie Time Settings
                </button>
                <button
                  className="movie-time__gear-popover-item"
                  role="menuitem"
                  onClick={() => { onOpenSettings('eye'); setShowGearPopover(false) }}
                >
                  👁 Eye Tracker Settings
                </button>
                <button
                  className="movie-time__gear-popover-item"
                  role="menuitem"
                  onClick={() => { onOpenSettings('contextual'); setShowGearPopover(false) }}
                >
                  🧠 Contextual Response Settings
                </button>
                <div className="movie-time__gear-popover-divider" />
                <button
                  className="movie-time__gear-popover-item"
                  role="menuitem"
                  onClick={() => { onOpenSettings('aac'); setShowGearPopover(false) }}
                >
                  🗣 AAC Settings
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      )}



      {/* ── Provider Selection ── */}
      {!selectedProvider && (
        <div className="movie-browse movie-browse--providers">
          <div className="movie-browse__header">
            <h2 className="movie-browse__heading">🎥 Select a Provider</h2>
          </div>
          
          <div className="movie-providers__grid-wrapper">
            <div className="movie-providers__grid" style={{ gridTemplateColumns: `repeat(${enabledProviders.length}, 1fr)` }}>
              {enabledProviders.includes('suggested') && (
                <button
                  id="prov-btn-suggested"
                  className={`movie-provider-card movie-provider-card--suggested ${gazeState.target === 'prov-suggested' ? 'movie-provider-card--gazed' : ''}`}
                  onClick={() => setSelectedProvider('suggested')}
                >
                  <span className="movie-provider-card__emoji">🍿</span>
                  <span className="movie-provider-card__label">Suggested Videos</span>
                  <div
                    className="movie-provider-card__dwell-bar"
                    style={{
                      width: `${gazeState.target === 'prov-suggested' ? gazeState.progress * 100 : 0}%`
                    }}
                  />
                </button>
              )}

              {enabledProviders.includes('youtube') && (
                <button
                  id="prov-btn-youtube"
                  className={`movie-provider-card movie-provider-card--youtube ${gazeState.target === 'prov-youtube' ? 'movie-provider-card--gazed' : ''}`}
                  onClick={() => setSelectedProvider('youtube')}
                >
                  <span className="movie-provider-card__emoji">📺</span>
                  <span className="movie-provider-card__label">YouTube</span>
                  <div
                    className="movie-provider-card__dwell-bar"
                    style={{
                      width: `${gazeState.target === 'prov-youtube' ? gazeState.progress * 100 : 0}%`
                    }}
                  />
                </button>
              )}

              {enabledProviders.includes('netflix') && (
                <button
                  id="prov-btn-netflix"
                  className={`movie-provider-card movie-provider-card--netflix ${gazeState.target === 'prov-netflix' ? 'movie-provider-card--gazed' : ''}`}
                  onClick={() => setSelectedProvider('netflix')}
                >
                  <span className="movie-provider-card__emoji">🎬</span>
                  <span className="movie-provider-card__label">Netflix</span>
                  <div
                    className="movie-provider-card__dwell-bar"
                    style={{
                      width: `${gazeState.target === 'prov-netflix' ? gazeState.progress * 100 : 0}%`
                    }}
                  />
                </button>
              )}

              {enabledProviders.includes('disney') && (
                <button
                  id="prov-btn-disney"
                  className={`movie-provider-card movie-provider-card--disney ${gazeState.target === 'prov-disney' ? 'movie-provider-card--gazed' : ''}`}
                  onClick={() => setSelectedProvider('disney')}
                >
                  <span className="movie-provider-card__emoji">✨</span>
                  <span className="movie-provider-card__label">Disney+</span>
                  <div
                    className="movie-provider-card__dwell-bar"
                    style={{
                      width: `${gazeState.target === 'prov-disney' ? gazeState.progress * 100 : 0}%`
                    }}
                  />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Browse ── */}
      {selectedProvider === 'suggested' && phase === 'browse' && (
        <div className="movie-browse">
          <div className="movie-browse__header">
            <h2 className="movie-browse__heading">
              {noApiKey ? '🔑 Setup Required' : '🎥 Choose a Show'}
            </h2>
            {!noApiKey && (
              <button
                ref={refreshBtnRef}
                id="movie-refresh-btn"
                className={`movie-browse__refresh-btn${videosLoading ? ' movie-browse__refresh-btn--loading' : ''}`}
                onClick={fetchVideos}
                aria-label="Refresh video suggestions"
              >
                {videosLoading ? '⏳ Loading…' : '↻ Refresh'}
                <span
                  className="movie-browse__refresh-progress"
                  style={{ width: `${gazeState.target === 'refresh' ? gazeState.progress * 100 : 0}%` }}
                  aria-hidden="true"
                />
              </button>
            )}
          </div>

          {noApiKey ? (
            <div className="movie-browse__api-warn">
              <p>
                A <strong>YouTube Data API v3 key</strong> is required to search for videos.<br />
                Add it in <strong>Settings → 🎬 Movie Time</strong>.
              </p>
            </div>
          ) : videosLoading ? (
            <div className="movie-browse__loading">
              <div className="movie-browse__loading-spinner" />
              <span>Finding shows for you…</span>
            </div>
          ) : videosError === 'quota-no-cache' ? (
            <div className="movie-browse__empty">
              <span className="movie-browse__empty-icon">📊</span>
              <p className="movie-browse__empty-msg">
                <strong>YouTube API daily quota exceeded.</strong><br />
                No cached results available yet. Try again after midnight (Pacific Time) when the quota resets.
              </p>
            </div>
          ) : videosError && videos.length === 0 ? (
            <div className="movie-browse__empty">
              <span className="movie-browse__empty-icon">😕</span>
              <p className="movie-browse__empty-msg">Could not load videos: {videosError}.<br />Check your API key in Movie Time Settings.</p>
            </div>
          ) : videos.length === 0 ? (
            <div className="movie-browse__empty">
              <span className="movie-browse__empty-icon">🎬</span>
              <p className="movie-browse__empty-msg">
                <strong>No videos found.</strong><br />
                Try adjusting your child's interests, topics, or safe search filters in settings.
              </p>
            </div>
          ) : (
            <>
              {videosFromCache && (
                <div className="movie-browse__quota-banner">
                  <span className="movie-browse__quota-banner-icon">📊</span>
                  <span>
                    <strong>YouTube API quota exceeded</strong> — showing videos from your last session
                    {cacheTimestamp ? ` (loaded ${cacheTimestamp.toLocaleDateString(undefined, { month:'short', day:'numeric' })} at ${cacheTimestamp.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' })})` : ''}.
                    Quota resets after midnight (Pacific Time).
                  </span>
                </div>
              )}
              {/* Selection Gate progress bar — shown above grid while gate is filling */}
              {!selectionGatePassed && (settings.movieTimeSelectionGateMs ?? 0) > 0 && (
                <div className="movie-browse__selection-gate" aria-live="polite" aria-label="Gaze gate progress">
                  <div className="movie-browse__selection-gate-label">
                    <span className="movie-browse__selection-gate-icon" aria-hidden="true">👁️</span>
                    <span>Look at a video to unlock selection…</span>
                  </div>
                  <div className="movie-browse__selection-gate-track">
                    <div
                      ref={selectionGateFillRef}
                      className="movie-browse__selection-gate-fill"
                      aria-hidden="true"
                    />
                    <span className="movie-browse__selection-gate-pct" aria-hidden="true">
                      {Math.round(selectionGateProgress * 100)}%
                    </span>
                  </div>
                </div>
              )}
              <div
                className="movie-browse__grid"
                style={{
                  gridTemplateColumns: `repeat(${
                    videos.length <= 3 ? videos.length
                    : videos.length === 4 ? 2
                    : 3
                  }, 1fr)`,
                }}
              >
                {videos.map((vid) => {
                  const isGazed = gazeState.target === `video-${vid.id}`
                  const cardProgress = selectionGatePassed
                    ? (isGazed ? gazeState.progress : 0)
                    : (isGazed ? selectionGateProgress : 0)
                  return (
                    <VideoCard
                      key={vid.id}
                      video={vid}
                      ref={el => { videoCardRefs.current[vid.id] = el }}
                      isGazed={isGazed}
                      progress={cardProgress}
                      onClick={() => selectionGatePassed && selectVideo(vid)}
                      locked={!selectionGatePassed}
                    />
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Pre-watch question (full-screen) ── */}
      {phase === 'prewatch' && selectedVideo && renderQuizOverlay({
        question:     puzzle?.question,
        choices:      puzzle?.choices,
        correctIndex: puzzle?.correctIndex,
        questionGate: puzzleQuestionGate,
        answerGate:   puzzleAnswerGate,
        gateProgress: puzzleGateProgress,
        answerGateProgress: puzzleAnswerGateProgress,
        result:       null,
        onChoiceSelect: handlePuzzleAnswer,
        choiceRefsObj:  puzzleChoiceRefs,
        idPrefix:       'puz',
        badge:          '✨ Quick Question First!',
        isLoading:      puzzleLoading,
        onSkip:         null, // no skip on pre-watch
        readingTarget:  ttsReadingTarget,
        wrongCount:     puzzleWrongCount,
        persistWrong:   persistentWrong,
        hintAfter:      settings.movieTimePuzzleHintAfterWrong ?? 3,
        wrongFlashIdx:  wrongFeedbackIdx,
        questionSource: puzzle?.source,
        questionIndex:  puzzleQuestionIndex,
        totalQuestions: puzzleTotalQuestions,
        promptParams:   puzzle?.promptParams,
      })}

      {/* ── Watching (also kept in DOM during puzzle so the YT player instance survives) ── */}
      {(phase === 'watching' || phase === 'puzzle' || phase === 'prewatch') && selectedVideo && (
        <div className={`movie-watching${(selectedVideo.provider === 'netflix' || selectedVideo.provider === 'disney' || selectedVideo.provider === 'youtube') ? ' movie-watching--transparent' : ''}`} style={(phase === 'puzzle' || phase === 'prewatch') ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}>
          <div className={`movie-watching__player-wrap${isWebviewFullscreen ? ' movie-watching__player-wrap--fullscreen' : ''}`} ref={playerWrapRef}>
            {selectedVideo.provider === 'netflix' || selectedVideo.provider === 'disney' || selectedVideo.provider === 'youtube' ? (
              <div style={{ position: 'absolute', inset: 0, background: 'transparent', pointerEvents: 'none' }} />
            ) : (
              <div ref={iframeRef} id="yt-player" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
            )}

            {gazedAway && phase === 'watching' && (
              <div className="movie-watching__gaze-overlay" role="alert">
                <span className="movie-watching__gaze-icon">
                  {gazeNoData ? '🚫' : '👁️'}
                </span>
                <span className="movie-watching__gaze-msg">
                  {gazeNoData
                    ? 'No eye gaze detected — look at the screen to continue'
                    : 'Look at the screen to continue'}
                </span>
              </div>
            )}

            {/* Puzzle countdown banner — shown 5 s before puzzle fires */}
            {phase === 'watching' && puzzleCountdown != null && (
              <div className="movie-watching__puzzle-countdown" role="status" aria-live="polite">
                <span className="movie-watching__puzzle-countdown-icon">🧩</span>
                <span className="movie-watching__puzzle-countdown-text">
                  Puzzle starting in <strong>{puzzleCountdown}s</strong>
                </span>
              </div>
            )}
          </div>
          {selectedVideo.provider === 'netflix' || selectedVideo.provider === 'disney' || selectedVideo.provider === 'youtube' ? (
            null
          ) : (
            <div className="movie-watching__controls">
              <button className="movie-watching__ctrl-btn" onClick={() => {
                try { playerRef.current?.seekTo(0) } catch (_) {}
              }}>↺ Restart</button>
              <button className="movie-watching__ctrl-btn" onClick={() => {
                setPhase('browse')
                try { playerRef.current?.pauseVideo() } catch (_) {}
              }}>⏏ Change Show</button>
            </div>
          )}
        </div>
      )}

      {/* ── Puzzle overlay (full-screen, on top of watching) ── */}
      {phase === 'puzzle' && renderQuizOverlay({
        question:     puzzle?.question,
        choices:      puzzle?.choices,
        correctIndex: puzzle?.correctIndex,
        questionGate: puzzleQuestionGate,
        answerGate:   puzzleAnswerGate,
        gateProgress: puzzleGateProgress,
        answerGateProgress: puzzleAnswerGateProgress,
        result:       null,
        onChoiceSelect: handlePuzzleAnswer,
        choiceRefsObj:  puzzleChoiceRefs,
        idPrefix:       'puz',
        badge:          '⏸ Puzzle Break!',
        isLoading:      puzzleLoading,
        wrongCount:     puzzleWrongCount,
        persistWrong:   persistentWrong,
        hintAfter:      settings.movieTimePuzzleHintAfterWrong ?? 3,
        readingTarget:  ttsReadingTarget,
        wrongFlashIdx:  wrongFeedbackIdx,
        questionSource: puzzle?.source,
        questionIndex:  puzzleQuestionIndex,
        totalQuestions: puzzleTotalQuestions,
        promptParams:   puzzle?.promptParams,
        onSkip:         () => {
          setPuzzle(null)
          setPuzzleWrongCount(0)
          setPersistentWrong({})
          setPhase('watching')
          window.gazeAPI?.chromeBringToFront?.()
          setTimeout(() => {
            try {
              if (savedTimeRef.current > 0) {
                playerRef.current?.seekTo(savedTimeRef.current, true)
              }
              playerRef.current?.playVideo()
            } catch (_) {}
            window.gazeAPI?.chromeControlVideo?.('play')
          }, 300)
        },
      })}

      {/* ── Correct answer celebration (puzzle) ── */}
      {feedback === 'correct' && (
        <div className="movie-celebration" aria-hidden="true">
          <div className="movie-celebration__burst">
            {['🎉','⭐','🌟','✨','🎊','💫','🏆','🎈'].map((e, i) => (
              <span key={i} className={`movie-celebration__particle movie-celebration__particle--${i}`}>{e}</span>
            ))}
          </div>
          <div className="movie-celebration__text">Amazing!</div>
          <div className="movie-celebration__subtext">🎉 That's correct! 🎉</div>
        </div>
      )}


    </div>
  )
}

// ─── WebviewWrapper ───────────────────────────────────────────────────────────

const WebviewWrapper = memo(function WebviewWrapper({ provider, preloadPath, setWebviewRef }) {
  return (
    <webview
      ref={setWebviewRef}
      src={
        provider === 'netflix'
          ? 'https://www.netflix.com'
          : provider === 'disney'
          ? 'https://www.disneyplus.com'
          : 'https://www.youtube.com'
      }
      partition="persist:movietime"
      useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
      webpreferences="plugins=yes"
      preload={preloadPath ? `file:///${preloadPath.replace(/\\/g, '/')}` : undefined}
      allowpopups="true"
      plugins="true"
      allowfullscreen="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: '#000' }}
    />
  )
}, (prevProps, nextProps) => {
  return prevProps.provider === nextProps.provider && prevProps.preloadPath === nextProps.preloadPath
})

// ─── VideoCard ────────────────────────────────────────────────────────────────

const VideoCard = forwardRef(function VideoCard({ video, isGazed, progress, onClick, locked }, ref) {
  const views = _formatViews(video.viewCount)
  const likes = _formatViews(video.likeCount)
  const isHD  = video.definition === 'hd'

  return (
    <button
      ref={ref}
      id={`video-card-${video.id}`}
      className={[
        'movie-card',
        isGazed ? 'movie-card--gazed' : '',
        locked  ? 'movie-card--locked' : '',
      ].filter(Boolean).join(' ')}
      onClick={onClick}
      aria-label={`Watch ${video.title}`}
      aria-disabled={locked}
    >
      {/* ── Thumbnail ── */}
      <div className="movie-card__thumb-wrap">
        <img
          className="movie-card__thumb"
          src={video.thumb ? video.thumb.replace('mqdefault.jpg', 'hqdefault.jpg') : ''}
          alt={video.title}
          loading="lazy"
        />
        {/* Duration badge — bottom-right of thumbnail */}
        {video.duration && (
          <span className="movie-card__duration">{video.duration}</span>
        )}
        {/* HD badge — top-left of thumbnail */}
        {isHD && (
          <span className="movie-card__hd-badge">HD</span>
        )}
      </div>

      {/* ── Info panel ── */}
      <div className="movie-card__info">
        <div className="movie-card__title">{video.title}</div>
        <div className="movie-card__channel">📺 {video.channel}</div>

        {/* Stats row — views + likes */}
        {(views || likes) && (
          <div className="movie-card__stats">
            {views && (
              <span className="movie-card__stat">
                <span className="movie-card__stat-icon">👁</span>
                {views} views
              </span>
            )}
            {likes && (
              <span className="movie-card__stat">
                <span className="movie-card__stat-icon">👍</span>
                {likes}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Dwell progress bar */}
      <span
        className="movie-card__dwell-bar"
        style={{ width: `${progress * 100}%` }}
        aria-hidden="true"
      />
      {/* Lock veil overlay */}
      {locked && (
        <div className="movie-card__lock-veil" aria-hidden="true" />
      )}
    </button>
  )
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _parseDuration(iso) {
  if (!iso) return ''
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return ''
  const h = parseInt(m[1] ?? 0)
  const min = parseInt(m[2] ?? 0)
  const s = parseInt(m[3] ?? 0)
  if (h > 0) return `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${min}:${String(s).padStart(2, '0')}`
}

function _formatViews(n) {
  if (n == null || isNaN(n)) return null
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000)         return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

const FALLBACK_BANK = {
  'Pre-K': {
    'General': [
      { question: 'What color do you get if you mix red and white?', choices: ['Green', 'Pink', 'Blue', 'Black'], correctIndex: 1 },
      { question: 'Which of these is a vegetable?', choices: ['Apple', 'Banana', 'Carrot', 'Strawberry'], correctIndex: 2 },
      { question: 'What is the opposite of hot?', choices: ['Dry', 'Loud', 'Cold', 'Big'], correctIndex: 2 },
      { question: 'Which season is the coldest and has snow?', choices: ['Summer', 'Winter', 'Spring', 'Fall'], correctIndex: 1 },
      { question: 'Which animal says "meow"?', choices: ['Dog', 'Cat', 'Cow', 'Duck'], correctIndex: 1 },
    ],
    'Math': [
      { question: 'How many legs does a dog have?', choices: ['2', '3', '4', '6'], correctIndex: 2 },
      { question: 'Which shape is round like a ball?', choices: ['Square', 'Triangle', 'Circle', 'Star'], correctIndex: 2 },
      { question: 'If you have 1 cookie and get 1 more, how many do you have?', choices: ['1', '2', '3', '4'], correctIndex: 1 },
      { question: 'Count the stars: ⭐ ⭐ ⭐ ⭐. How many are there?', choices: ['2', '3', '4', '5'], correctIndex: 2 },
      { question: 'Which number is the biggest?', choices: ['1', '2', '3', '5'], correctIndex: 3 },
    ],
    'Science': [
      { question: 'What do caterpillars turn into?', choices: ['Beetles', 'Butterflies', 'Moths', 'Ants'], correctIndex: 1 },
      { question: 'Which of these shines brightly in the sky during the day?', choices: ['Moon', 'Sun', 'Raincloud', 'Star'], correctIndex: 1 },
      { question: 'What parts of plants grow down into the dirt?', choices: ['Leaves', 'Flowers', 'Roots', 'Stems'], correctIndex: 2 },
      { question: 'Where do fish live and swim?', choices: ['In trees', 'In the air', 'In water', 'On land'], correctIndex: 2 },
      { question: 'Which sense do you use to hear a song?', choices: ['Eyes', 'Nose', 'Ears', 'Tongue'], correctIndex: 2 },
    ],
    'English': [
      { question: 'What letter does the word "Apple" start with?', choices: ['B', 'A', 'C', 'P'], correctIndex: 1 },
      { question: 'Which word rhymes with "cat"?', choices: ['Dog', 'Hat', 'Sun', 'Tree'], correctIndex: 1 },
      { question: 'What is the last letter of the alphabet?', choices: ['A', 'M', 'Y', 'Z'], correctIndex: 3 },
      { question: 'Which of these is a letter, not a number?', choices: ['3', 'B', '5', '7'], correctIndex: 1 },
      { question: 'How do you spell the color of the clear sky?', choices: ['RED', 'BLUE', 'GREEN', 'PINK'], correctIndex: 1 },
    ],
    'History': [
      { question: 'What is a giant animal that lived long, long ago?', choices: ['Elephant', 'Dinosaur', 'Lion', 'Giraffe'], correctIndex: 1 },
      { question: 'What did people use to ride before cars were invented?', choices: ['Bicycles', 'Horses', 'Airplanes', 'Trains'], correctIndex: 1 },
      { question: 'Which helper builds houses and buildings?', choices: ['Doctor', 'Builder', 'Astronaut', 'Baker'], correctIndex: 1 },
    ],
    'Geography': [
      { question: 'What is the name of the planet we live on?', choices: ['Mars', 'Earth', 'Jupiter', 'The Sun'], correctIndex: 1 },
      { question: 'What shape is a globe that shows the Earth?', choices: ['Flat square', 'Round ball', 'Flat triangle', 'Star'], correctIndex: 1 },
      { question: 'Which one is mostly water?', choices: ['Forest', 'Desert', 'Ocean', 'Mountain'], correctIndex: 2 },
    ],
    'Art': [
      { question: 'What primary colors mix to make green?', choices: ['Red and Blue', 'Blue and Yellow', 'Red and Yellow', 'White and Black'], correctIndex: 1 },
      { question: 'What tool do you use to paint on paper?', choices: ['Crayon', 'Paintbrush', 'Scissors', 'Glue'], correctIndex: 1 },
      { question: 'What color is a banana?', choices: ['Red', 'Blue', 'Yellow', 'Purple'], correctIndex: 2 },
    ],
    'Music': [
      { question: 'Which instrument do you hit with sticks to make a sound?', choices: ['Flute', 'Violin', 'Drums', 'Guitar'], correctIndex: 2 },
      { question: 'Is a lullaby song fast or slow?', choices: ['Fast and loud', 'Slow and quiet', 'Happy and jumpy', 'Scary'], correctIndex: 1 },
      { question: 'What do you use to sing songs?', choices: ['Hands', 'Feet', 'Voice', 'Ears'], correctIndex: 2 },
    ],
    'Animals': [
      { question: 'What sound does a cow make?', choices: ['Woof', 'Meow', 'Moo', 'Baa'], correctIndex: 2 },
      { question: 'Which animal has a very long neck?', choices: ['Elephant', 'Giraffe', 'Dog', 'Cat'], correctIndex: 1 },
      { question: 'Where do fish live?', choices: ['In trees', 'In water', 'In the sky', 'Under rocks'], correctIndex: 1 },
    ],
    'Nature': [
      { question: 'What falls from the sky when it rains?', choices: ['Snow', 'Leaves', 'Water', 'Stars'], correctIndex: 2 },
      { question: 'What color are most leaves on a tree?', choices: ['Blue', 'Red', 'Green', 'Purple'], correctIndex: 2 },
      { question: 'What do plants need to grow?', choices: ['Candy', 'Sunlight and water', 'Ice cream', 'Toys'], correctIndex: 1 },
    ],
    'Disney': [
      { question: 'What is the name of the little mermaid?', choices: ['Elsa', 'Ariel', 'Belle', 'Moana'], correctIndex: 1 },
      { question: 'Who is Mickey Mouse\'s best friend?', choices: ['Donald', 'Goofy', 'Pluto', 'Daisy'], correctIndex: 2 },
      { question: 'What does Elsa have the power to create?', choices: ['Fire', 'Ice and snow', 'Rain', 'Flowers'], correctIndex: 1 },
    ],
    'Kids Shows': [
      { question: 'What shape is SpongeBob?', choices: ['Circle', 'Triangle', 'Square', 'Star'], correctIndex: 2 },
      { question: 'What does Dora love to do?', choices: ['Sleep', 'Explore', 'Cook', 'Drive'], correctIndex: 1 },
      { question: 'What color is Peppa Pig?', choices: ['Blue', 'Green', 'Pink', 'Yellow'], correctIndex: 2 },
    ],
  },
  'Primary': {
    'General': [
      { question: 'How many days are in a leap year?', choices: ['364', '365', '366', '367'], correctIndex: 2 },
      { question: 'What is the largest mammal in the world?', choices: ['African Elephant', 'Blue Whale', 'Giraffe', 'Colossal Squid'], correctIndex: 1 },
      { question: 'Which famous ship sank in 1912?', choices: ['Mayflower', 'Titanic', 'Santa Maria', 'Britannic'], correctIndex: 1 },
      { question: 'How many colors are in a rainbow?', choices: ['5', '6', '7', '8'], correctIndex: 2 },
    ],
    'Math': [
      { question: 'What is 12 x 8?', choices: ['86', '96', '104', '108'], correctIndex: 1 },
      { question: 'How many degrees are in a right angle?', choices: ['45°', '90°', '180°', '360°'], correctIndex: 1 },
      { question: 'What is the value of 3/4 as a decimal?', choices: ['0.25', '0.50', '0.75', '0.80'], correctIndex: 2 },
      { question: 'How many sides does a hexagon have?', choices: ['5', '6', '8', '10'], correctIndex: 1 },
      { question: 'If a triangle has sides of 3cm, 4cm, and 5cm, what is its perimeter?', choices: ['10cm', '12cm', '15cm', '20cm'], correctIndex: 1 },
    ],
    'Science': [
      { question: 'Which planet is known as the Red Planet?', choices: ['Venus', 'Mars', 'Jupiter', 'Mercury'], correctIndex: 1 },
      { question: 'What gas do plants absorb from the air to make food?', choices: ['Oxygen', 'Nitrogen', 'Carbon Dioxide', 'Hydrogen'], correctIndex: 2 },
      { question: 'What is the boiling point of water in Celsius?', choices: ['90°C', '100°C', '110°C', '120°C'], correctIndex: 1 },
      { question: 'Which force pulls objects toward the center of the Earth?', choices: ['Magnetism', 'Friction', 'Gravity', 'Wind'], correctIndex: 2 },
      { question: 'What is the water cycle process where water turns into vapor?', choices: ['Condensation', 'Evaporation', 'Precipitation', 'Runoff'], correctIndex: 1 },
    ],
    'English': [
      { question: 'Which of these is a noun in: "The quick brown fox jumps over the dog"?', choices: ['quick', 'jumps', 'fox', 'over'], correctIndex: 2 },
      { question: 'What is a word that means the opposite of "ancient"?', choices: ['Old', 'Modern', 'Historic', 'Huge'], correctIndex: 1 },
      { question: 'Which word is spelled correctly?', choices: ['Receive', 'Recieve', 'Receve', 'Reciefe'], correctIndex: 0 },
      { question: 'What are two words combined with an apostrophe (like "don\'t") called?', choices: ['Compound', 'Adverb', 'Contraction', 'Pronoun'], correctIndex: 2 },
    ],
    'History': [
      { question: 'Which ancient civilization built the Great Pyramids?', choices: ['Greeks', 'Romans', 'Egyptians', 'Aztecs'], correctIndex: 2 },
      { question: 'Who was the first President of the United States?', choices: ['Thomas Jefferson', 'Abraham Lincoln', 'George Washington', 'John Adams'], correctIndex: 2 },
      { question: 'What did Johannes Gutenberg invent that changed books forever?', choices: ['Telescope', 'Printing Press', 'Compass', 'Steam Engine'], correctIndex: 1 },
    ],
    'Geography': [
      { question: 'Which is the largest ocean on Earth?', choices: ['Atlantic Ocean', 'Indian Ocean', 'Arctic Ocean', 'Pacific Ocean'], correctIndex: 3 },
      { question: 'What is the capital city of France?', choices: ['London', 'Berlin', 'Rome', 'Paris'], correctIndex: 3 },
      { question: 'Which continent has the Nile River and the Sahara Desert?', choices: ['Asia', 'South America', 'Africa', 'Australia'], correctIndex: 2 },
      { question: 'How many continents are on Earth?', choices: ['5', '6', '7', '8'], correctIndex: 2 },
    ],
    'Art': [
      { question: 'Who painted the famous painting "Mona Lisa"?', choices: ['Vincent van Gogh', 'Leonardo da Vinci', 'Pablo Picasso', 'Claude Monet'], correctIndex: 1 },
      { question: 'Which of these is a primary color?', choices: ['Green', 'Orange', 'Blue', 'Purple'], correctIndex: 2 },
      { question: 'What art style uses small dots of color to create an image?', choices: ['Cubism', 'Pointillism', 'Sculpture', 'Origami'], correctIndex: 1 },
    ],
    'Music': [
      { question: 'How many keys are on a standard piano?', choices: ['64', '76', '88', '92'], correctIndex: 2 },
      { question: 'Which instrument belongs to the brass family?', choices: ['Flute', 'Trumpet', 'Violin', 'Clarinet'], correctIndex: 1 },
      { question: 'What Italian word tells musicians to play loudly?', choices: ['Piano', 'Forte', 'Presto', 'Adagio'], correctIndex: 1 },
    ],
    'Animals': [
      { question: 'What is the fastest land animal?', choices: ['Lion', 'Cheetah', 'Horse', 'Gazelle'], correctIndex: 1 },
      { question: 'Which animal is known for changing its skin color?', choices: ['Gecko', 'Chameleon', 'Frog', 'Snake'], correctIndex: 1 },
      { question: 'What is a group of wolves called?', choices: ['Herd', 'Flock', 'Pack', 'School'], correctIndex: 2 },
    ],
    'Nature': [
      { question: 'What is the process by which plants make food using sunlight?', choices: ['Respiration', 'Photosynthesis', 'Germination', 'Pollination'], correctIndex: 1 },
      { question: 'What type of cloud is tall and brings thunderstorms?', choices: ['Cirrus', 'Stratus', 'Cumulonimbus', 'Nimbus'], correctIndex: 2 },
      { question: 'What is the hardest natural substance on Earth?', choices: ['Gold', 'Iron', 'Diamond', 'Quartz'], correctIndex: 2 },
    ],
    'Disney': [
      { question: 'In "The Lion King," what is Simba\'s father\'s name?', choices: ['Scar', 'Mufasa', 'Rafiki', 'Zazu'], correctIndex: 1 },
      { question: 'Which Disney princess has a glass slipper?', choices: ['Rapunzel', 'Cinderella', 'Snow White', 'Aurora'], correctIndex: 1 },
      { question: 'In "Finding Nemo," what type of fish is Nemo?', choices: ['Goldfish', 'Angelfish', 'Clownfish', 'Swordfish'], correctIndex: 2 },
    ],
    'Kids Shows': [
      { question: 'In "Avatar: The Last Airbender," what element does Aang primarily bend?', choices: ['Water', 'Earth', 'Fire', 'Air'], correctIndex: 3 },
      { question: 'What is the name of the talking dog in "Paw Patrol" who leads the team?', choices: ['Chase', 'Marshall', 'Ryder (human)', 'Rocky'], correctIndex: 0 },
      { question: 'In "Pokémon," what is the name of Ash\'s first Pokémon?', choices: ['Charmander', 'Bulbasaur', 'Squirtle', 'Pikachu'], correctIndex: 3 },
    ],
  },
  'Secondary': {
    'General': [
      { question: 'In which year did World War II end?', choices: ['1918', '1939', '1945', '1950'], correctIndex: 2 },
      { question: 'What is the currency of Japan?', choices: ['Yuan', 'Won', 'Yen', 'Dollar'], correctIndex: 2 },
      { question: 'Which gas makes up about 78% of Earth\'s atmosphere?', choices: ['Oxygen', 'Nitrogen', 'Carbon Dioxide', 'Argon'], correctIndex: 1 },
    ],
    'Math': [
      { question: 'Solve for x: 3x - 7 = 14.', choices: ['x = 5', 'x = 6', 'x = 7', 'x = 8'], correctIndex: 2 },
      { question: 'What is the value of Pi (π) rounded to two decimal places?', choices: ['3.12', '3.14', '3.16', '3.18'], correctIndex: 1 },
      { question: 'What is the square root of 144?', choices: ['10', '11', '12', '14'], correctIndex: 2 },
      { question: 'In a right triangle, what formula relates the sides a, b, and c?', choices: ['a + b = c', 'ab = c²', 'a² + b² = c²', 'a + b = c²'], correctIndex: 2 },
    ],
    'Science': [
      { question: 'What is the chemical symbol for Gold?', choices: ['Gd', 'Au', 'Ag', 'Fe'], correctIndex: 1 },
      { question: 'Which organelle is known as the powerhouse of the cell?', choices: ['Nucleus', 'Ribosome', 'Mitochondria', 'Chloroplast'], correctIndex: 2 },
      { question: 'What is the speed of light in a vacuum?', choices: ['300,000 km/s', '150,000 km/s', '500,000 km/s', '1,000,000 km/s'], correctIndex: 0 },
      { question: 'What is the process where cells divide to create identical copies?', choices: ['Meiosis', 'Mitosis', 'Photosynthesis', 'Respiration'], correctIndex: 1 },
    ],
    'English': [
      { question: 'What literary device is used in "The wind whispered through the trees"?', choices: ['Simile', 'Metaphor', 'Personification', 'Hyperbole'], correctIndex: 2 },
      { question: 'What is the active voice of: "The cake was eaten by John"?', choices: ['John ate the cake', 'John was eating cake', 'John had eaten the cake', 'The cake John ate'], correctIndex: 0 },
      { question: 'What does the prefix "bene-" mean (as in beneficial)?', choices: ['Bad', 'Good', 'Large', 'Under'], correctIndex: 1 },
    ],
    'History': [
      { question: 'Who wrote the American Declaration of Independence?', choices: ['George Washington', 'Thomas Jefferson', 'Benjamin Franklin', 'Alexander Hamilton'], correctIndex: 1 },
      { question: 'Which empire was ruled by Julius Caesar?', choices: ['Greek Empire', 'Roman Empire', 'Ottoman Empire', 'Persian Empire'], correctIndex: 1 },
      { question: 'What historical period followed the Middle Ages in Europe?', choices: ['Industrial Revolution', 'Renaissance', 'Stone Age', 'Viking Age'], correctIndex: 1 },
    ],
    'Geography': [
      { question: 'What occurs when tectonic plates slide past or collide with each other?', choices: ['Tsunamis', 'Tornados', 'Earthquakes', 'Monsoons'], correctIndex: 2 },
      { question: 'Which line of latitude splits the Earth into Northern and Southern hemispheres?', choices: ['Prime Meridian', 'Equator', 'Tropic of Cancer', 'Tropic of Capricorn'], correctIndex: 1 },
      { question: 'What is the capital city of Australia?', choices: ['Sydney', 'Melbourne', 'Canberra', 'Brisbane'], correctIndex: 2 },
    ],
    'Art': [
      { question: 'Which art movement is famous for artists like Claude Monet and Edgar Degas?', choices: ['Surrealism', 'Cubism', 'Impressionism', 'Expressionism'], correctIndex: 2 },
      { question: 'What is the term for painting using only one color in various shades?', choices: ['Polychromatic', 'Monochromatic', 'Complementary', 'Abstract'], correctIndex: 1 },
    ],
    'Music': [
      { question: 'Which classical composer wrote the famous Symphony No. 5?', choices: ['Johann Sebastian Bach', 'Wolfgang Amadeus Mozart', 'Ludwig van Beethoven', 'Franz Schubert'], correctIndex: 2 },
      { question: 'Which clef is primarily used for lower pitch instruments like the cello?', choices: ['Treble Clef', 'Bass Clef', 'Alto Clef', 'Tenor Clef'], correctIndex: 1 },
    ],
    'Animals': [
      { question: 'What is the term for animals that are active at night?', choices: ['Diurnal', 'Nocturnal', 'Crepuscular', 'Cathemeral'], correctIndex: 1 },
      { question: 'Which marine animal has three hearts?', choices: ['Whale', 'Shark', 'Octopus', 'Dolphin'], correctIndex: 2 },
      { question: 'What is the largest species of shark?', choices: ['Great White', 'Hammerhead', 'Whale Shark', 'Tiger Shark'], correctIndex: 2 },
    ],
    'Nature': [
      { question: 'What layer of Earth\'s atmosphere do we live in?', choices: ['Stratosphere', 'Troposphere', 'Mesosphere', 'Thermosphere'], correctIndex: 1 },
      { question: 'What phenomenon causes the Northern Lights?', choices: ['Meteor showers', 'Solar wind particles', 'Volcanic gases', 'Ocean reflections'], correctIndex: 1 },
      { question: 'What is the pH level of pure water?', choices: ['5', '7', '9', '14'], correctIndex: 1 },
    ],
    'Disney': [
      { question: 'Which Pixar film features the emotion characters Joy, Sadness, and Anger?', choices: ['Coco', 'Inside Out', 'Soul', 'Up'], correctIndex: 1 },
      { question: 'In "Frozen 2," what ancient spirit does Elsa encounter in the enchanted forest?', choices: ['Fire Spirit', 'Water Nokk', 'Earth Giants', 'All of the above'], correctIndex: 3 },
      { question: 'What year was the first Toy Story released?', choices: ['1993', '1995', '1997', '1999'], correctIndex: 1 },
    ],
    'Kids Shows': [
      { question: 'In "Stranger Things," what is the alternate dimension called?', choices: ['The Shadow Realm', 'The Upside Down', 'The Other Side', 'The Dark World'], correctIndex: 1 },
      { question: 'What is the name of the fictional town in "Gravity Falls"?', choices: ['Gravity Falls, Oregon', 'Mystery Town, CA', 'Pinesdale, WA', 'Strangeville, OR'], correctIndex: 0 },
      { question: 'In "The Owl House," what is the Boiling Isles made from?', choices: ['A giant mountain', 'The body of a Titan', 'Magical crystals', 'Enchanted trees'], correctIndex: 1 },
    ],
  },
  'Adult': {
    'General': [
      { question: 'Which treaty established the European Union in 1993?', choices: ['Treaty of Versailles', 'Maastricht Treaty', 'Rome Treaty', 'Paris Accord'], correctIndex: 1 },
      { question: 'Who is considered the father of modern economics?', choices: ['John Maynard Keynes', 'Adam Smith', 'Karl Marx', 'Milton Friedman'], correctIndex: 1 },
      { question: 'What is the main compound in natural gas?', choices: ['Ethane', 'Methane', 'Propane', 'Butane'], correctIndex: 1 },
    ],
    'Math': [
      { question: 'What is the derivative of x² with respect to x?', choices: ['x', '2x', 'x²', '2'], correctIndex: 1 },
      { question: 'What is the probability of flipping a fair coin twice and getting two heads?', choices: ['0.25', '0.50', '0.75', '0.33'], correctIndex: 0 },
      { question: 'In logic, what is a statement that is true by its own definition called?', choices: ['Oxymoron', 'Tautology', 'Paradox', 'Hypothesis'], correctIndex: 1 },
    ],
    'Science': [
      { question: 'What is the atomic number of Carbon?', choices: ['6', '8', '12', '14'], correctIndex: 0 },
      { question: 'Which physicist developed the theory of General Relativity?', choices: ['Isaac Newton', 'Albert Einstein', 'Niels Bohr', 'Richard Feynman'], correctIndex: 1 },
      { question: 'What molecules form the double-helix structure of DNA?', choices: ['Amino Acids', 'Nucleotides', 'Lipids', 'Polysaccharides'], correctIndex: 1 },
      { question: 'What is the most abundant element in the universe?', choices: ['Oxygen', 'Helium', 'Hydrogen', 'Carbon'], correctIndex: 2 },
    ],
    'English': [
      { question: 'What is a word or phrase that combines contradictory terms (e.g. "deafening silence")?', choices: ['Oxymoron', 'Euphemism', 'Hyperbole', 'Anaphora'], correctIndex: 0 },
      { question: 'Which word describes a person who has extensive knowledge on many subjects?', choices: ['Polyglot', 'Polymath', 'Philanthropist', 'Pundit'], correctIndex: 1 },
      { question: 'What is the etymological origin of the prefix "anthro-"?', choices: ['Star', 'Time', 'Human', 'Life'], correctIndex: 2 },
    ],
    'History': [
      { question: 'What intellectual movement dominated Europe in the 17th and 18th centuries?', choices: ['Renaissance', 'The Enlightenment', 'Romanticism', 'Realism'], correctIndex: 1 },
      { question: 'Who was the first emperor of the Roman Empire, ruling from 27 BC until 14 AD?', choices: ['Julius Caesar', 'Augustus', 'Nero', 'Marcus Aurelius'], correctIndex: 1 },
      { question: 'In what year was the fall of the Berlin Wall?', choices: ['1985', '1989', '1991', '1995'], correctIndex: 1 },
    ],
    'Geography': [
      { question: 'What is the name of the deep ocean current system that acts as a global conveyor belt?', choices: ['Gulf Stream', 'Thermohaline Circulation', 'Jet Stream', 'El Niño'], correctIndex: 1 },
      { question: 'Which country has the highest population density in the world?', choices: ['Monaco', 'Singapore', 'Bangladesh', 'Malta'], correctIndex: 0 },
      { question: 'Which mountain range contains the highest peak outside of Asia?', choices: ['Rockies', 'Alps', 'Andes', 'Urals'], correctIndex: 2 },
    ],
    'Art': [
      { question: 'What architectural movement was characterized by steel frames and "form follows function"?', choices: ['Art Nouveau', 'Bauhaus/Modernism', 'Baroque', 'Gothic'], correctIndex: 1 },
      { question: 'Which 20th century artist is primary credited with co-founding Cubism?', choices: ['Henri Matisse', 'Salvador Dalí', 'Pablo Picasso', 'Jackson Pollock'], correctIndex: 2 },
    ],
    'Music': [
      { question: 'What chord progression is widely known as the "axis of awesome" progression?', choices: ['I-IV-V-I', 'I-V-vi-IV', 'ii-V-I-IV', 'I-vi-IV-V'], correctIndex: 1 },
      { question: 'Which musical mode is identical to the natural minor scale?', choices: ['Dorian Mode', 'Phrygian Mode', 'Aeolian Mode', 'Mixolydian Mode'], correctIndex: 2 },
    ],
    'Animals': [
      { question: 'What is the term for an organism that can produce its own food?', choices: ['Heterotroph', 'Autotroph', 'Decomposer', 'Parasite'], correctIndex: 1 },
      { question: 'Which animal has the highest blood pressure of any living creature?', choices: ['Elephant', 'Giraffe', 'Blue Whale', 'Horse'], correctIndex: 1 },
      { question: 'What is the only mammal capable of true sustained flight?', choices: ['Flying Squirrel', 'Sugar Glider', 'Bat', 'Colugo'], correctIndex: 2 },
    ],
    'Nature': [
      { question: 'What is the Coriolis effect responsible for?', choices: ['Tidal patterns', 'Deflection of moving objects due to Earth\'s rotation', 'Volcanic eruptions', 'Earthquake propagation'], correctIndex: 1 },
      { question: 'What percentage of Earth\'s water is freshwater?', choices: ['About 3%', 'About 10%', 'About 25%', 'About 50%'], correctIndex: 0 },
      { question: 'What geological era are we currently living in?', choices: ['Mesozoic', 'Paleozoic', 'Cenozoic', 'Proterozoic'], correctIndex: 2 },
    ],
    'Disney': [
      { question: 'Which Disney animated film was the first to use the CAPS digital ink-and-paint system?', choices: ['The Little Mermaid', 'The Rescuers Down Under', 'Beauty and the Beast', 'Aladdin'], correctIndex: 1 },
      { question: 'What was Walt Disney\'s first full-length animated feature film?', choices: ['Pinocchio', 'Fantasia', 'Snow White and the Seven Dwarfs', 'Dumbo'], correctIndex: 2 },
      { question: 'Which Pixar film explores the concept of the "Great Before" — where new souls get their personalities?', choices: ['Inside Out', 'Coco', 'Soul', 'Onward'], correctIndex: 2 },
    ],
    'Kids Shows': [
      { question: 'What groundbreaking 1999 anime series explored themes of human consciousness and existential philosophy?', choices: ['Cowboy Bebop', 'Serial Experiments Lain', 'Neon Genesis Evangelion', 'Ghost in the Shell: SAC'], correctIndex: 2 },
      { question: 'Which animated show\'s creator described it as "a show about nothing" for kids?', choices: ['Adventure Time', 'Phineas and Ferb', 'Seinfeld (not a kids show)', 'SpongeBob SquarePants'], correctIndex: 1 },
      { question: 'In "Arcane" (League of Legends), what is the name of the undercity beneath Piltover?', choices: ['The Sump', 'Zaun', 'The Lanes', 'Stillwater'], correctIndex: 1 },
    ],
  },
}

/**
 * Build a pool of True/False questions for the eye-gaze offline fallback.
 * Only 2 choices (✅ True / ❌ False) → largest possible gaze targets.
 * Questions are loosely themed around the current subject / education level.
 * Each item: { question: string, correct: boolean }
 */
function _buildGazeTrueFalsePool(topic, eduLevel, subject) {
  // Universal always-available pool (works for any topic)
  const universal = [
    { question: 'The Sun is a star.', correct: true },
    { question: 'Fish can breathe air like humans.', correct: false },
    { question: 'Water freezes at 0°C (32°F).', correct: true },
    { question: 'The Moon makes its own light.', correct: false },
    { question: 'Humans have 5 senses.', correct: true },
    { question: 'Spiders are insects.', correct: false },
    { question: 'Plants need sunlight to grow.', correct: true },
    { question: 'The Earth is flat.', correct: false },
    { question: 'Birds are warm-blooded animals.', correct: true },
    { question: 'The heart pumps blood around the body.', correct: true },
    { question: 'Ice is heavier than liquid water.', correct: false },
    { question: 'The ocean covers more than half of Earth.', correct: true },
    { question: 'Humans breathe in carbon dioxide.', correct: false },
    { question: 'Butterflies start life as caterpillars.', correct: true },
    { question: 'The colour of the sky is green.', correct: false },
    { question: 'Lightning can strike the same place twice.', correct: true },
    { question: 'Elephants are the largest land animals.', correct: true },
    { question: 'Bananas grow underground like potatoes.', correct: false },
  ]

  // Subject / level specific pools
  const pools = {
    'Math': [
      { question: '2 + 2 = 4', correct: true },
      { question: '10 − 3 = 8', correct: false },
      { question: 'A triangle has 3 sides.', correct: true },
      { question: 'A square has 5 corners.', correct: false },
      { question: '5 × 2 = 10', correct: true },
      { question: 'Half of 20 is 8.', correct: false },
      { question: '100 ÷ 10 = 10', correct: true },
      { question: 'An even number can be divided by 2 evenly.', correct: true },
      { question: '7 is an even number.', correct: false },
    ],
    'Science': [
      { question: 'Gravity pulls objects downward.', correct: true },
      { question: 'Sound travels faster than light.', correct: false },
      { question: 'Magnets have a North and a South pole.', correct: true },
      { question: 'Electricity can flow through rubber.', correct: false },
      { question: 'The smallest unit of matter is an atom.', correct: true },
      { question: 'Volcanoes are found only in the ocean.', correct: false },
    ],
    'Animals': [
      { question: 'Dolphins are mammals, not fish.', correct: true },
      { question: 'Penguins can fly long distances.', correct: false },
      { question: 'A baby cat is called a kitten.', correct: true },
      { question: 'Sharks must keep swimming to breathe.', correct: true },
      { question: 'Frogs are reptiles.', correct: false },
      { question: 'Bees make honey.', correct: true },
      { question: 'Owls are active during the day.', correct: false },
    ],
    'Nature': [
      { question: 'Trees produce oxygen.', correct: true },
      { question: 'Deserts always have sand.', correct: false },
      { question: 'Rain forms from water vapour in clouds.', correct: true },
      { question: 'Earthquakes are caused by clouds.', correct: false },
      { question: 'The Amazon Rainforest is in South America.', correct: true },
    ],
    'Geography': [
      { question: 'Australia is both a country and a continent.', correct: true },
      { question: 'The Nile is the longest river in the world.', correct: true },
      { question: 'China is a country in Africa.', correct: false },
      { question: 'Mount Everest is the tallest mountain on Earth.', correct: true },
      { question: 'Paris is the capital of Spain.', correct: false },
    ],
    'Disney': [
      { question: 'Elsa has ice powers in Frozen.', correct: true },
      { question: 'Simba is a lion in The Lion King.', correct: true },
      { question: 'Mickey Mouse is a cat.', correct: false },
      { question: 'Moana goes on a voyage across the ocean.', correct: true },
      { question: 'Buzz Lightyear is a cowboy toy.', correct: false },
    ],
    'Pre-K': [
      { question: 'A dog says "woof".', correct: true },
      { question: 'The sky is green.', correct: false },
      { question: 'Apples are a fruit.', correct: true },
      { question: 'We sleep during the day.', correct: false },
      { question: 'A circle is round.', correct: true },
      { question: 'A cow says "moo".', correct: true },
      { question: 'Fish live on land.', correct: false },
      { question: 'We have 10 fingers.', correct: true },
    ],
  }

  // Pick the best matching subject pool, then mix in universal questions
  let subjectPool = []
  if (subject && subject !== 'General' && subject !== 'Video Content') {
    // Check for direct match or partial match in pools
    const key = Object.keys(pools).find(k => subject.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(subject.toLowerCase()))
    if (key) subjectPool = pools[key]
  }

  // For Pre-K level, use the simple Pre-K pool regardless of subject
  if (eduLevel === 'Pre-K') {
    subjectPool = [...pools['Pre-K'], ...(subjectPool.length > 0 ? subjectPool : [])]
  }

  // Combine: subject-specific first (higher relevance), then universal
  const combined = [...subjectPool, ...universal]

  // Deduplicate by question text
  const seen = new Set()
  return combined.filter(q => {
    if (seen.has(q.question)) return false
    seen.add(q.question)
    return true
  })
}

function _fallbackQuestion(videoTitle, numChoices, qType, askedHistory = [], eduLevel = 'Primary', subject = 'General') {
  // Try to find pool for selected eduLevel
  const levelBank = FALLBACK_BANK[eduLevel] || FALLBACK_BANK['Primary']

  // When subject is 'Video Content', generate dynamic title-based questions
  // instead of falling back to generic 'General' questions
  if ((subject === 'Video Content' || !levelBank[subject]) && videoTitle) {
    const titleQuestions = _generateVideoTitleFallbacks(videoTitle, numChoices)
    if (titleQuestions.length > 0) {
      // Filter out already-asked questions
      const askedStrings = (askedHistory ?? []).map(item => {
        if (!item) return ''
        return typeof item === 'string' ? item : item.question
      }).filter(Boolean)
      const askedSet = new Set(askedStrings)
      const available = titleQuestions.filter(q => !askedSet.has(q.question))
      const activePool = available.length > 0 ? available : titleQuestions
      const selected = activePool[Math.floor(Math.random() * activePool.length)]
      const adjustedChoices = selected.choices.slice(0, numChoices)
      let correctIdx = selected.correctIndex
      if (correctIdx >= adjustedChoices.length) {
        const correctVal = selected.choices[correctIdx]
        adjustedChoices[adjustedChoices.length - 1] = correctVal
        correctIdx = adjustedChoices.length - 1
      }
      return { question: selected.question, choices: adjustedChoices, correctIndex: correctIdx, type: qType }
    }
  }

  // Handle multi-subject string (e.g. "Animals + Disney + custom") by picking one at random
  let resolvedSubject = subject
  if (subject.includes(' + ')) {
    const parts = subject.split(' + ').map(s => s.trim()).filter(Boolean)
    // Prefer parts that have a matching bank; fallback to random pick
    const withBank = parts.filter(p => levelBank[p])
    resolvedSubject = withBank.length > 0
      ? withBank[Math.floor(Math.random() * withBank.length)]
      : parts[Math.floor(Math.random() * parts.length)]
  }

  // Try to find pool for selected subject (or fallback to General)
  let pool = levelBank[resolvedSubject]
  if (!pool || pool.length === 0) {
    pool = levelBank['General'] || []
  }
  
  // If still empty (e.g. invalid configuration), combine all questions for this level
  if (!pool || pool.length === 0) {
    pool = Object.values(levelBank).flat()
  }

  // If still empty (extremely rare fallback check), use a global list
  if (!pool || pool.length === 0) {
    pool = [
      { question: 'How many continents are on Earth?', choices: ['5', '6', '7', '8'], correctIndex: 2 }
    ]
  }

  // Filter out questions already asked this session to prevent repetition
  const askedStrings = (askedHistory ?? []).map(item => {
    if (!item) return ''
    return typeof item === 'string' ? item : item.question
  }).filter(Boolean)
  const askedSet = new Set(askedStrings)
  const available = pool.filter(q => !askedSet.has(q.question))
  
  // If all have been used, reset and use the full pool
  const activePool = available.length > 0 ? available : pool

  // Select a random question
  const selected = activePool[Math.floor(Math.random() * activePool.length)]
  
  // Adjust choices count dynamically based on settings
  const adjustedChoices = selected.choices.slice(0, numChoices)
  let correctIdx = selected.correctIndex
  
  // Guard: if the correct answer index is sliced out, force it back in
  if (correctIdx >= adjustedChoices.length) {
    // Swap the correct choice with the last choice in our slice
    const correctVal = selected.choices[correctIdx]
    adjustedChoices[adjustedChoices.length - 1] = correctVal
    correctIdx = adjustedChoices.length - 1
  }

  return {
    question: selected.question,
    choices: adjustedChoices,
    correctIndex: correctIdx,
    type: qType
  }
}

/**
 * Generate dynamic fallback questions based on the video title.
 * Used when subject is 'Video Content' but Gemini API failed.
 * These questions are always related to the video's topic.
 */
function _generateVideoTitleFallbacks(videoTitle, numChoices = 4) {
  if (!videoTitle) return []

  const title = videoTitle.trim()

  const questions = [
    {
      question: `What subject area does this video most likely cover?`,
      choices: _inferSubjectChoices(title, numChoices),
      correctIndex: 0
    },
    {
      question: `What type of content would you expect from this video?`,
      choices: _inferVideoTypeChoices(title, numChoices),
      correctIndex: 0
    },
    {
      question: `Which topic is most closely related to what this video is about?`,
      choices: _inferSubjectChoices(title, numChoices),
      correctIndex: 0
    },
  ]

  return questions.filter(q => q.choices.length >= 2)
}

function _inferSubjectChoices(title, n) {
  const t = title.toLowerCase()
  const subjects = []
  if (/fish|animal|nature|wild|ocean|sea|bird|pet|cat|dog|bear/.test(t)) subjects.push('Nature & Animals')
  if (/math|number|count|add|multiply|equation/.test(t)) subjects.push('Math')
  if (/science|experiment|chemistry|physics|biology/.test(t)) subjects.push('Science')
  if (/history|ancient|war|king|queen|empire/.test(t)) subjects.push('History')
  if (/cook|recipe|food|bake|kitchen|eat/.test(t)) subjects.push('Cooking')
  if (/music|song|sing|band|dance|concert/.test(t)) subjects.push('Music')
  if (/game|play|sport|football|soccer|basket/.test(t)) subjects.push('Sports & Games')
  if (/art|draw|paint|craft|create|design/.test(t)) subjects.push('Art & Creativity')
  if (/travel|adventure|explore|trip|camping/.test(t)) subjects.push('Travel & Adventure')
  if (/code|program|computer|tech|robot|ai/.test(t)) subjects.push('Technology')
  if (subjects.length === 0) subjects.push('Entertainment')
  // Pad with distractors
  const distractors = ['Astronomy', 'Geography', 'Literature', 'Philosophy', 'Economics', 'Architecture'].filter(d => !subjects.includes(d))
  while (subjects.length < n && distractors.length > 0) {
    subjects.push(distractors.splice(Math.floor(Math.random() * distractors.length), 1)[0])
  }
  return subjects.slice(0, n)
}


function _inferVideoTypeChoices(title, n) {
  const t = title.toLowerCase()
  const types = []
  if (/tutorial|how to|guide|learn|diy|tips/.test(t)) types.push('Tutorial / How-To')
  if (/vlog|day in|daily|routine/.test(t)) types.push('Vlog')
  if (/review|unbox|test|compare/.test(t)) types.push('Review')
  if (/challenge|prank|funny|fail/.test(t)) types.push('Challenge / Entertainment')
  if (/documentary|explain|story|history/.test(t)) types.push('Documentary')
  if (types.length === 0) types.push('Entertainment / Fun')
  const fallbacks = ['News Report', 'Music Video', 'Science Experiment', 'Cooking Show', 'Sports Highlight', 'Travel Vlog'].filter(f => !types.includes(f))
  while (types.length < n && fallbacks.length > 0) {
    types.push(fallbacks.splice(Math.floor(Math.random() * fallbacks.length), 1)[0])
  }
  return types.slice(0, n)
}

function shuffleChoices(questionObj) {
  if (!questionObj || !Array.isArray(questionObj.choices) || questionObj.choices.length === 0) {
    return questionObj
  }
  
  const { choices, correctIndex } = questionObj
  if (correctIndex < 0 || correctIndex >= choices.length) {
    return questionObj
  }
  
  const correctChoiceValue = choices[correctIndex]
  const shuffled = [...choices]
  
  // Fisher-Yates shuffle
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  
  const newCorrectIndex = shuffled.indexOf(correctChoiceValue)
  
  return {
    ...questionObj,
    choices: shuffled,
    correctIndex: newCorrectIndex === -1 ? 0 : newCorrectIndex
  }
}

function _parseBatchResponse(raw) {
  if (!raw || !raw.trim()) return null
  let parsed = null

  // 1. Direct JSON parse
  try {
    parsed = JSON.parse(raw)
  } catch (_) {}

  // 2. Strip code fences and try again
  if (!parsed) {
    const stripped = raw.replace(/```json?\s*/gi, '').replace(/```/g, '').trim()
    try {
      parsed = JSON.parse(stripped)
    } catch (_) {}
  }

  // 3. Extract JSON array using brackets matching [...]
  if (!parsed) {
    const startIdx = raw.indexOf('[')
    const endIdx = raw.lastIndexOf(']')
    if (startIdx !== -1 && endIdx > startIdx) {
      try {
        parsed = JSON.parse(raw.slice(startIdx, endIdx + 1))
      } catch (_) {}
    }
  }

  // 4. Fallback: if they returned a single object instead of an array
  if (!parsed) {
    const startIdx = raw.indexOf('{')
    const endIdx = raw.lastIndexOf('}')
    if (startIdx !== -1 && endIdx > startIdx) {
      try {
        const obj = JSON.parse(raw.slice(startIdx, endIdx + 1))
        if (obj && obj.question) {
          parsed = [obj]
        }
      } catch (_) {}
    }
  }

  if (Array.isArray(parsed)) {
    return parsed.filter(item => item && item.question && Array.isArray(item.choices))
  } else if (parsed && typeof parsed === 'object' && parsed.question) {
    return [parsed]
  }

  return null
}
