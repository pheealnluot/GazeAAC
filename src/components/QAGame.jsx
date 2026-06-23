import { useState, useEffect, useRef, useCallback } from 'react'
import { useGazeSettings } from '@context/GazeSettingsContext'
import './QAGame.css'

export default function QAGame({ onBack, registerHitTargets, gazeState, onDwellRef, directQuizPlay, onClearDirectPlay, onOpenCaregiver, onOpenSettings }) {
  const { quizzes, settings } = useGazeSettings()
  
  // Game State
  const [phase, setPhase] = useState('select-quiz') // 'select-quiz' | 'playing' | 'completed' | 'manage-quizzes'
  const [activeQuiz, setActiveQuiz] = useState(null)
  const [currentQuestionIdx, setCurrentQuestionIdx] = useState(0)
  const [wrongAttempts, setWrongAttempts] = useState({}) // { [choiceIdx]: true }
  const [score, setScore] = useState(0) // count of questions answered correctly on 1st attempt
  const [isFirstTry, setIsFirstTry] = useState(true)
  const [feedback, setFeedback] = useState(null) // null | 'correct' | 'wrong' | 'neutral'
  const [wrongFeedbackIdx, setWrongFeedbackIdx] = useState(null)
  const [selectedFeedbackIdx, setSelectedFeedbackIdx] = useState(null)
  const [activeVoiceOver, setActiveVoiceOver] = useState(null) // Tracks currently speaking item to highlight
  // Progress for the question gate (0 to 1)
  const [questionGateProgress, setQuestionGateProgress] = useState(0)
  const questionGateStartRef = useRef(null) // timestamp when gate started
  const questionGateAnimRef = useRef(null) // animation frame handle

  // Progress for the answer gate (0 to 1)
  const [answerGateProgress, setAnswerGateProgress] = useState(0)
  const answerGateStartRef = useRef(null) // timestamp when answer gate started
  const answerGateAnimRef = useRef(null) // animation frame handle for answer gate

  const [questionGateActive, setQuestionGateActive] = useState(true)
  const [answerGateActive, setAnswerGateActive] = useState(false)
  const [gateTriggerKey, setGateTriggerKey] = useState(0)

  const startAnswerGateRef = useRef(null)
  const isAnswerGateStartedRef = useRef(false)
  const isQuestionVoiceOverCompletedRef = useRef(false)

  const questionGazeActiveRef = useRef(false)
  const answerGazeActiveRef = useRef(false)
  const questionGateAccumRef = useRef(0)
  const answerGateAccumRef = useRef(0)
  const [showGearPopover, setShowGearPopover] = useState(false)
  const settingsBtnRef = useRef(null)
  const gearContainerRef = useRef(null)

  // TTS Voiceover Queue Refs
  const ttsChoiceQueueRef = useRef([])
  const voiceOverQueueRef = useRef(null)
  const currentTtsIndexRef = useRef(null)

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

  useEffect(() => {
    const cellId = gazeState?.cellId ?? null
    questionGazeActiveRef.current = (cellId === 'question-box')
    answerGazeActiveRef.current = (cellId?.startsWith?.('choicegate-') ?? false)
  }, [gazeState])

  const dwellMs = settings.dwellMs ?? 800
  const questionGateMs = settings.qaQuizQuestionGateMs ?? 2000
  const answerGateMs = settings.qaQuizAnswerGateMs ?? 1500
  const activeQuestion = activeQuiz?.questions?.[currentQuestionIdx] ?? null

  // Handle direct play routing from caregiver panel or editor
  useEffect(() => {
    if (directQuizPlay && quizzes && quizzes.length > 0) {
      const q = quizzes.find(item => item.id === directQuizPlay.quizId)
      if (q) {
        setActiveQuiz(q)
        setCurrentQuestionIdx(directQuizPlay.questionIdx || 0)
        setWrongAttempts({})
        setScore(0)
        setIsFirstTry(true)
        setFeedback(null)
        setWrongFeedbackIdx(null)
        setPhase('playing')
      }
      onClearDirectPlay?.()
    }
  }, [directQuizPlay, quizzes, onClearDirectPlay])



  // ── Web Audio chimes ──
  const playSound = useCallback((type) => {
    if (type !== 'click' && !(settings.qaQuizSoundEffects ?? true)) return
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const gain = ctx.createGain()
      gain.connect(ctx.destination)
      gain.gain.setValueAtTime(0.12, ctx.currentTime)

      if (type === 'correct') {
        // Ascending major chord (C5 -> E5 -> G5)
        const notes = [523.25, 659.25, 783.99]
        notes.forEach((freq, i) => {
          const osc = ctx.createOscillator()
          osc.type = 'sine'
          osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.1)
          osc.connect(gain)
          osc.start(ctx.currentTime + i * 0.1)
          osc.stop(ctx.currentTime + i * 0.1 + 0.25)
        })
      } else if (type === 'wrong') {
        // Descending low tone (A3 -> F3)
        const notes = [220.00, 174.61]
        notes.forEach((freq, i) => {
          const osc = ctx.createOscillator()
          osc.type = 'triangle'
          osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.12)
          osc.connect(gain)
          osc.start(ctx.currentTime + i * 0.12)
          osc.stop(ctx.currentTime + i * 0.12 + 0.3)
        })
      } else if (type === 'neutral') {
        // Soft ascending two-tone (E5 -> A5)
        const notes = [329.63, 440.00]
        notes.forEach((freq, i) => {
          const osc = ctx.createOscillator()
          osc.type = 'sine'
          osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.1)
          osc.connect(gain)
          osc.start(ctx.currentTime + i * 0.1)
          osc.stop(ctx.currentTime + i * 0.1 + 0.2)
        })
      } else if (type === 'click') {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(600, ctx.currentTime)
        gain.gain.setValueAtTime(0.08, ctx.currentTime)
        osc.connect(gain)
        osc.start(ctx.currentTime)
        osc.stop(ctx.currentTime + 0.08)
      }
    } catch (err) {
      console.warn('[QAGame] Audio feedback failed:', err)
    }
  }, [])

  // Clear all pending TTS and queue timers
  const clearTtsTimers = useCallback(() => {
    currentTtsIndexRef.current = null
    ttsChoiceQueueRef.current = []
    if (voiceOverQueueRef.current) {
      clearTimeout(voiceOverQueueRef.current)
      voiceOverQueueRef.current = null
    }
    setActiveVoiceOver(null)
    try {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel()
      }
    } catch (e) {
      console.warn('[QAGame] Failed to cancel speech synthesis:', e)
    }
  }, [])

  // Speak next item sequentially from our choice queue
  const speakNextFromQueue = useCallback(() => {
    if (ttsChoiceQueueRef.current.length === 0) {
      setActiveVoiceOver(null)
      currentTtsIndexRef.current = null
      return
    }

    const next = ttsChoiceQueueRef.current.shift()
    currentTtsIndexRef.current = next.target
    setActiveVoiceOver(next.target)

    const text = next.text
    try {
      if (window.gazeAPI?.speak) {
        window.gazeAPI.speak(text)
        // Fallback timer for Electron in case speech completion event is lost
        const fallbackMs = text.length * 90 + 3000
        if (voiceOverQueueRef.current) clearTimeout(voiceOverQueueRef.current)
        voiceOverQueueRef.current = setTimeout(() => {
          handleTtsItemFinished(next.target)
        }, fallbackMs)
      } else if (window.speechSynthesis) {
        window.speechSynthesis.cancel()
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.onstart = () => setActiveVoiceOver(next.target)
        utterance.onend = () => {
          handleTtsItemFinished(next.target)
        }
        utterance.onerror = () => {
          handleTtsItemFinished(next.target)
        }
        window.speechSynthesis.speak(utterance)
      }
    } catch (e) {
      console.warn('[QAGame] Speech queue output failed:', e)
      handleTtsItemFinished(next.target)
    }
  }, [clearTtsTimers])

  // Handles completion of active sequential queue item
  const handleTtsItemFinished = useCallback((target) => {
    if (currentTtsIndexRef.current !== target) return

    setActiveVoiceOver(null)
    currentTtsIndexRef.current = null

    if (voiceOverQueueRef.current) {
      clearTimeout(voiceOverQueueRef.current)
      voiceOverQueueRef.current = null
    }

    const pauseMs = settings.qaQuizVoiceOverPauseMs ?? 500

    if (target === 'question') {
      isQuestionVoiceOverCompletedRef.current = true
      if (ttsChoiceQueueRef.current.length > 0) {
        // If questionGateMs is click, we MUST wait for the answer gate to start
        if (questionGateMs !== 'click' || isAnswerGateStartedRef.current) {
          voiceOverQueueRef.current = setTimeout(() => {
            speakNextFromQueue()
          }, pauseMs)
        }
      }
    } else {
      if (ttsChoiceQueueRef.current.length > 0) {
        voiceOverQueueRef.current = setTimeout(() => {
          speakNextFromQueue()
        }, pauseMs)
      }
    }
  }, [speakNextFromQueue, settings.qaQuizVoiceOverPauseMs, questionGateMs])

  // Subscribe to native speech completion events from the main process (Electron)
  useEffect(() => {
    if (!window.gazeAPI?.onTtsCompleted) return

    const unsubscribe = window.gazeAPI.onTtsCompleted(() => {
      if (currentTtsIndexRef.current !== null) {
        handleTtsItemFinished(currentTtsIndexRef.current)
      }
    })

    return () => unsubscribe()
  }, [handleTtsItemFinished])

  // Cleanup TTS on unmount or phase changes
  useEffect(() => {
    return () => clearTtsTimers()
  }, [clearTtsTimers, phase])

  // Manage Question and Answer Gates (Gaze-contingent progression)
  useEffect(() => {
    if (phase === 'playing' && activeQuestion) {
      // Clear any existing animation frames
      if (questionGateAnimRef.current) {
        cancelAnimationFrame(questionGateAnimRef.current)
        questionGateAnimRef.current = null
      }
      if (answerGateAnimRef.current) {
        cancelAnimationFrame(answerGateAnimRef.current)
        answerGateAnimRef.current = null
      }

      // --- Start question gate ---
      setQuestionGateActive(true)
      setAnswerGateActive(false)
      setQuestionGateProgress(0)
      setAnswerGateProgress(0)

      questionGazeActiveRef.current = false
      answerGazeActiveRef.current = false
      questionGateAccumRef.current = 0
      answerGateAccumRef.current = 0
      questionGateStartRef.current = null
      answerGateStartRef.current = null

      isAnswerGateStartedRef.current = false
      isQuestionVoiceOverCompletedRef.current = false

      const startAnswerGate = () => {
        isAnswerGateStartedRef.current = true
        if (isQuestionVoiceOverCompletedRef.current && ttsChoiceQueueRef.current && ttsChoiceQueueRef.current.length > 0) {
          speakNextFromQueue()
        }
        if (answerGateMs <= 0) {
          setAnswerGateActive(false)
          setAnswerGateProgress(1)
          return
        }
        setAnswerGateActive(true)
        setAnswerGateProgress(0)
        answerGateAccumRef.current = 0
        answerGateStartRef.current = null

        const aTick = (ts) => {
          if (answerGazeActiveRef.current) {
            if (answerGateStartRef.current == null) answerGateStartRef.current = ts
            answerGateAccumRef.current += ts - answerGateStartRef.current
            answerGateStartRef.current = ts
          } else {
            answerGateStartRef.current = null
          }

          const ap = Math.min(answerGateAccumRef.current / answerGateMs, 1)
          setAnswerGateProgress(ap)

          if (ap < 1) {
            answerGateAnimRef.current = requestAnimationFrame(aTick)
          } else {
            setAnswerGateActive(false)
            setAnswerGateProgress(1)
          }
        }
        answerGateAnimRef.current = requestAnimationFrame(aTick)
      }

      startAnswerGateRef.current = startAnswerGate

      if (questionGateMs === 'click') {
        setQuestionGateActive(true)
        setQuestionGateProgress(0)
        return
      }

      if (questionGateMs <= 0) {
        setQuestionGateActive(false)
        setQuestionGateProgress(1)
        startAnswerGate()
        return
      }

      // Animation loop to update question progress bar
      const qTick = (ts) => {
        if (questionGazeActiveRef.current) {
          if (questionGateStartRef.current == null) questionGateStartRef.current = ts
          questionGateAccumRef.current += ts - questionGateStartRef.current
          questionGateStartRef.current = ts
        } else {
          questionGateStartRef.current = null
        }

        const qp = Math.min(questionGateAccumRef.current / questionGateMs, 1)
        setQuestionGateProgress(qp)

        if (qp < 1) {
          questionGateAnimRef.current = requestAnimationFrame(qTick)
        } else {
          setQuestionGateActive(false)
          setQuestionGateProgress(1)
          startAnswerGate()
        }
      }
      questionGateAnimRef.current = requestAnimationFrame(qTick)
    }

    return () => {
      if (questionGateAnimRef.current) {
        cancelAnimationFrame(questionGateAnimRef.current)
        questionGateAnimRef.current = null
      }
      if (answerGateAnimRef.current) {
        cancelAnimationFrame(answerGateAnimRef.current)
        answerGateAnimRef.current = null
      }
    }
  }, [phase, currentQuestionIdx, activeQuestion, questionGateMs, answerGateMs, gateTriggerKey, speakNextFromQueue])

  // ── TTS Text-to-Speech voice-overs (Immediate output - e.g. correct/wrong) ──
  const speakText = useCallback((text, target = null) => {
    clearTtsTimers()
    if (!text) return
    try {
      if (window.gazeAPI?.speak) {
        setActiveVoiceOver(target)
        window.gazeAPI.speak(text)
        const duration = text.length * 75 + 1000
        if (voiceOverQueueRef.current) clearTimeout(voiceOverQueueRef.current)
        voiceOverQueueRef.current = setTimeout(() => setActiveVoiceOver(null), duration)
      } else if (window.speechSynthesis) {
        window.speechSynthesis.cancel()
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.onstart = () => setActiveVoiceOver(target)
        utterance.onend = () => setActiveVoiceOver(null)
        utterance.onerror = () => setActiveVoiceOver(null)
        window.speechSynthesis.speak(utterance)
      }
    } catch (e) {
      console.warn('[QAGame] Immediate speech output failed:', e)
    }
  }, [clearTtsTimers])

  // Speak question and choices sequentially
  const runVoiceOver = useCallback((questionObj) => {
    clearTtsTimers()
    if (!questionObj) return
    if (!(settings.qaQuizVoiceOver ?? true)) return

    const queue = []
    queue.push({ text: questionObj.question, target: 'question' })

    if (settings.qaQuizVoiceOverChoices ?? true) {
      if (questionObj.answers && questionObj.answers.length > 0) {
        questionObj.answers.forEach((ans, idx) => {
          queue.push({ text: ans.text, target: idx })
        })
      }
    }

    ttsChoiceQueueRef.current = queue
    speakNextFromQueue()
  }, [settings.qaQuizVoiceOver, settings.qaQuizVoiceOverChoices, clearTtsTimers, speakNextFromQueue])

  // ── Hit targets measurement & registration ──
  const registerTargets = useCallback(() => {
    const cells = []
    const vw = window.innerWidth
    const vh = window.innerHeight

    // 1. Back button (always visible)
    const backBtn = document.getElementById('qa-back-btn')
    if (backBtn) {
      const r = backBtn.getBoundingClientRect()
      cells.push({ id: 'back-btn', x0: r.left / vw, y0: r.top / vh, x1: r.right / vw, y1: r.bottom / vh })
    }

    if (phase === 'select-quiz') {
      // Quiz selection cards
      quizzes.forEach(quiz => {
        const el = document.getElementById(`quiz-${quiz.id}`)
        if (el) {
          const r = el.getBoundingClientRect()
          cells.push({ id: `quiz-${quiz.id}`, x0: r.left / vw, y0: r.top / vh, x1: r.right / vw, y1: r.bottom / vh })
        }
      })
    } else if (phase === 'playing' && activeQuestion) {
      if (questionGateActive) {
        const el = document.getElementById('qa-question-box')
        if (el) {
          const r = el.getBoundingClientRect()
          cells.push({ id: 'question-box', x0: r.left / vw, y0: r.top / vh, x1: r.right / vw, y1: r.bottom / vh })
        }
      } else if (answerGateActive) {
        activeQuestion.answers.forEach((ans, i) => {
          if (!wrongAttempts[i]) {
            const el = document.getElementById(`choice-${i}`)
            if (el) {
              const r = el.getBoundingClientRect()
              cells.push({ id: `choicegate-${i}`, x0: r.left / vw, y0: r.top / vh, x1: r.right / vw, y1: r.bottom / vh })
            }
          }
        })
      } else {
        // Answers choice cards (only if gates are clear)
        activeQuestion.answers.forEach((ans, i) => {
          if (!wrongAttempts[i]) {
            const el = document.getElementById(`choice-${i}`)
            if (el) {
              const r = el.getBoundingClientRect()
              cells.push({ id: `choice-${i}`, x0: r.left / vw, y0: r.top / vh, x1: r.right / vw, y1: r.bottom / vh })
            }
          }
        })
      }
    } else if (phase === 'completed') {
      const el = document.getElementById('quiz-complete-btn')
      if (el) {
        const r = el.getBoundingClientRect()
        cells.push({ id: 'quiz-complete-btn', x0: r.left / vw, y0: r.top / vh, x1: r.right / vw, y1: r.bottom / vh })
      }
    }

    registerHitTargets?.(cells)
  }, [phase, quizzes, activeQuestion, wrongAttempts, registerHitTargets, questionGateActive, answerGateActive])

  // Remeasure layout when phase or content changes
  useEffect(() => {
    const frame = requestAnimationFrame(registerTargets)
    window.addEventListener('resize', registerTargets)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', registerTargets)
    }
  }, [registerTargets])

  // Trigger TTS voice-over when a new question is loaded
  useEffect(() => {
    if (phase === 'playing' && activeQuestion) {
      const t = setTimeout(() => {
        runVoiceOver(activeQuestion)
      }, 500)
      return () => clearTimeout(t)
    }
  }, [phase, currentQuestionIdx, activeQuestion, runVoiceOver, gateTriggerKey])

  const handleSelectQuiz = useCallback((quizId) => {
    playSound('click')
    const q = quizzes.find(item => item.id === quizId)
    if (q && q.questions && q.questions.length > 0) {
      setActiveQuiz(q)
      setCurrentQuestionIdx(0)
      setWrongAttempts({})
      setScore(0)
      setIsFirstTry(true)
      setFeedback(null)
      setWrongFeedbackIdx(null)
      setSelectedFeedbackIdx(null)
      setPhase('playing')
    }
  }, [quizzes, playSound])

  const handleAnswerSelect = useCallback((choiceIdx) => {
    if (feedback || questionGateActive || answerGateActive) return
    const selectedId = activeQuestion?.answers?.[choiceIdx]?.id
    if (!selectedId) return

    // Resolve correctIds array with backward compatibility
    let correctIds = []
    if (activeQuestion.correctIds) {
      correctIds = activeQuestion.correctIds
    } else if (activeQuestion.correctId) {
      correctIds = [activeQuestion.correctId]
    }

    if (correctIds.length === 0) {
      // 0 correct answers -> Neutral response!
      playSound('neutral')
      setFeedback('neutral')
      setSelectedFeedbackIdx(choiceIdx)
      speakText('Okay')

      // Always advance to next question
      setTimeout(() => {
        if (currentQuestionIdx + 1 < activeQuiz.questions.length) {
          setCurrentQuestionIdx(prev => prev + 1)
          setWrongAttempts({})
          setIsFirstTry(true)
          setFeedback(null)
          setSelectedFeedbackIdx(null)
        } else {
          setPhase('completed')
        }
      }, 1500)
    } else if (correctIds.includes(selectedId)) {
      // Correct choice selected!
      playSound('correct')
      setFeedback('correct')
      setSelectedFeedbackIdx(choiceIdx)
      if (isFirstTry) {
        setScore(prev => prev + 1)
      }
      speakText('Correct!')

      setTimeout(() => {
        if (currentQuestionIdx + 1 < activeQuiz.questions.length) {
          setCurrentQuestionIdx(prev => prev + 1)
          setWrongAttempts({})
          setIsFirstTry(true)
          setFeedback(null)
          setSelectedFeedbackIdx(null)
        } else {
          setPhase('completed')
        }
      }, 1500)
    } else {
      // Wrong choice selected!
      playSound('wrong')
      setFeedback('wrong')
      setWrongFeedbackIdx(choiceIdx)
      setIsFirstTry(false)
      speakText('Try again')

      setTimeout(() => {
        setWrongAttempts(prev => ({ ...prev, [choiceIdx]: true }))
        setFeedback(null)
        setWrongFeedbackIdx(null)
      }, 1000)
    }
  }, [activeQuestion, activeQuiz, currentQuestionIdx, feedback, isFirstTry, playSound, speakText, questionGateActive, answerGateActive])

  const handleBack = useCallback(() => {
    playSound('click')
    if (phase === 'playing') {
      setPhase('select-quiz')
      setActiveQuiz(null)
    } else if (phase === 'completed') {
      setPhase('select-quiz')
      setActiveQuiz(null)
    } else if (phase === 'manage-quizzes') {
      setPhase('select-quiz')
    } else {
      onBack()
    }
  }, [phase, onBack, playSound])

  // Wire dwell activation handler into the unified router
  useEffect(() => {
    if (!onDwellRef) return
    onDwellRef.current = (cellId) => {
      if (cellId === 'back-btn') {
        handleBack()
      } else if (cellId === 'quiz-complete-btn') {
        playSound('click')
        setPhase('select-quiz')
        setActiveQuiz(null)
      } else if (cellId.startsWith('quiz-')) {
        const id = cellId.slice(5)
        handleSelectQuiz(id)
      } else if (cellId.startsWith('choice-')) {
        const idx = parseInt(cellId.slice(7), 10)
        if (!isNaN(idx)) {
          handleAnswerSelect(idx)
        }
      }
    }
    return () => { if (onDwellRef) onDwellRef.current = null }
  }, [onDwellRef, phase, quizzes, activeQuestion, wrongAttempts, handleBack, handleSelectQuiz, handleAnswerSelect, playSound])

  const resetToQuestionGate = useCallback(() => {
    clearTtsTimers()
    if (window.speechSynthesis) window.speechSynthesis.cancel()
    setGateTriggerKey(prev => prev + 1)
  }, [clearTtsTimers])

  // ── Manual Gate Progression by Mouse Click, Spacebar, or Forward/Back Keys ──
  useEffect(() => {
    if (phase !== 'playing' || !activeQuestion) return

    const handleTrigger = (e) => {
      // 1. Identify back keys first
      if (e.type === 'keydown') {
        const isBackKey = e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Backspace'
        if (isBackKey) {
          e.preventDefault()
          // "A keyboard backkey would bring one action back."
          if (!questionGateActive) {
            // We are in Answer Gate or choices are visible -> Go back to Question Gate
            resetToQuestionGate()
            playSound('click')
          } else {
            // We are already in Question Gate -> Go back to the previous question
            if (currentQuestionIdx > 0) {
              playSound('click')
              setCurrentQuestionIdx(prev => prev - 1)
              setWrongAttempts({})
              setIsFirstTry(true)
              setFeedback(null)
              setSelectedFeedbackIdx(null)
              setWrongFeedbackIdx(null)
            }
          }
          return
        }
      }

      // 2. Identify triggering keys (Spacebar or Forward Keys like Right Arrow, Page Down, Down Arrow, Enter)
      if (e.type === 'keydown') {
        const isSpace = e.key === ' ' || e.key === 'Spacebar'
        const isForwardKey = e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'ArrowDown' || e.key === 'Enter'
        if (!isSpace && !isForwardKey) return
        
        // Prevent default spacebar scrolling or presentation clicker actions
        e.preventDefault()
      }

      // If question read time is click, progress the gate manually
      if (questionGateMs === 'click' && questionGateActive) {
        if (questionGateAnimRef.current) {
          cancelAnimationFrame(questionGateAnimRef.current)
          questionGateAnimRef.current = null
        }
        setQuestionGateActive(false)
        setQuestionGateProgress(1)
        playSound('click')
        if (startAnswerGateRef.current) {
          startAnswerGateRef.current()
        }
      }
    }

    window.addEventListener('keydown', handleTrigger)
    window.addEventListener('click', handleTrigger)

    return () => {
      window.removeEventListener('keydown', handleTrigger)
      window.removeEventListener('click', handleTrigger)
    }
  }, [
    phase,
    activeQuestion,
    questionGateActive,
    questionGateMs,
    currentQuestionIdx,
    playSound,
    resetToQuestionGate
  ])

  const getProgress = (id) => (gazeState?.cellId === id ? gazeState.dwellProgress : 0)

  return (
    <div className="qa-game">
      {/* Background orbs */}
      <div className="qa-game__bg" aria-hidden="true" />
      <div className="qa-game__orb qa-game__orb--1" aria-hidden="true" />
      <div className="qa-game__orb qa-game__orb--2" aria-hidden="true" />

      {/* Header Bar */}
      <header className="qa-game__header">
        <button
          id="qa-back-btn"
          className={`qa-game__back-btn ${gazeState?.cellId === 'back-btn' ? 'qa-game__back-btn--gazed' : ''}`}
          onClick={handleBack}
          aria-label="Go back"
        >
          <span>Back</span>
          <div
            className="qa-game__back-progress-bar"
            style={{ width: `${getProgress('back-btn') * 100}%` }}
          />
        </button>

        <h1 className="qa-game__title">
          {phase === 'playing' ? activeQuiz?.name : phase === 'manage-quizzes' ? 'Manage Quizzes' : 'Q&A Quizzes'}
        </h1>

        <div className="qa-game__header-right" style={{ display: 'flex', alignItems: 'center', gap: '1rem', justifyContent: 'flex-end' }}>
          {phase === 'playing' && (
            <div className="qa-game__progress-indicator" style={{ margin: 0 }}>
              Question {currentQuestionIdx + 1} of {activeQuiz?.questions?.length}
            </div>
          )}
          {phase === 'select-quiz' && (
            <button
              className="qa-game__manage-btn"
              onClick={() => {
                playSound('click')
                setPhase('manage-quizzes')
              }}
              style={{
                background: 'rgba(0, 200, 255, 0.12)',
                border: '1.5px solid rgba(0, 200, 255, 0.3)',
                borderRadius: '12px',
                padding: '0.6rem 1.2rem',
                color: '#00c8ff',
                fontWeight: 'bold',
                cursor: 'pointer',
                fontSize: '0.95rem',
                transition: 'all 0.2s',
                outline: 'none'
              }}
            >
              Manage Quizzes
            </button>
          )}
          {onOpenSettings && (
            <div 
              ref={gearContainerRef}
              style={{ position: 'relative' }}
            >
              <button
                ref={settingsBtnRef}
                id="qa-settings-btn"
                className="qa-game__gear-btn"
                aria-label="Open settings"
                title="Settings"
                onClick={() => setShowGearPopover(v => !v)}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: '1.5px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '12px',
                  width: '42px',
                  height: '42px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '1.2rem',
                  transition: 'transform 0.2s, border-color 0.2s',
                  outline: 'none'
                }}
              >⚙</button>

              {showGearPopover && (
                <div
                  className="qa-game__gear-popover"
                  role="menu"
                  style={{ background: '#1a1d28', opacity: 1 }}
                >
                  <button
                    className="qa-game__gear-popover-item"
                    role="menuitem"
                    onClick={() => { onOpenSettings('qna'); setShowGearPopover(false) }}
                  >
                    🧩 Q&A Settings
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Main Area */}
      <main className="qa-game__content">
        {/* PHASE 1: SELECT QUIZ */}
        {phase === 'select-quiz' && (
          <div className="qa-game__quiz-list">
            <h2 className="qa-game__section-title">Select a Quiz to Play</h2>
            {quizzes.length === 0 ? (
              <div className="qa-game__empty-state">
                <p>No quizzes available yet.</p>
                <small>Create quizzes in the Caregiver Web Console or click Manage Quizzes to start.</small>
              </div>
            ) : (
              <div className="qa-game__grid">
                {quizzes.map((quiz, idx) => {
                  const targetId = `quiz-${quiz.id}`
                  const isGazed = gazeState?.cellId === targetId
                  return (
                    <button
                      key={quiz.id}
                      id={targetId}
                      className={`qa-game__card ${isGazed ? 'qa-game__card--gazed' : ''}`}
                      onClick={() => handleSelectQuiz(quiz.id)}
                    >
                      <span className="qa-game__card-name">{idx + 1}. {quiz.name}</span>
                      <span className="qa-game__card-count">{quiz.questions?.length ?? 0} Questions</span>
                      <div
                        className="qa-game__card-progress-bar"
                        style={{ width: `${getProgress(targetId) * 100}%` }}
                      />
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* PHASE 4: MANAGE QUIZZES */}
        {phase === 'manage-quizzes' && (
          <QuizzesEditor
            onBack={() => setPhase('select-quiz')}
            onPlayQuiz={(quizId) => {
              playSound('click')
              const q = quizzes.find(item => item.id === quizId)
              if (q && q.questions && q.questions.length > 0) {
                setActiveQuiz(q)
                setCurrentQuestionIdx(0)
                setWrongAttempts({})
                setScore(0)
                setIsFirstTry(true)
                setFeedback(null)
                setWrongFeedbackIdx(null)
                setSelectedFeedbackIdx(null)
                setPhase('playing')
              }
            }}
            onPlayQuestion={(quizId, qIdx) => {
              playSound('click')
              const q = quizzes.find(item => item.id === quizId)
              if (q && q.questions && q.questions.length > qIdx) {
                setActiveQuiz(q)
                setCurrentQuestionIdx(qIdx)
                setWrongAttempts({})
                setScore(0)
                setIsFirstTry(true)
                setFeedback(null)
                setWrongFeedbackIdx(null)
                setSelectedFeedbackIdx(null)
                setPhase('playing')
              }
            }}
          />
        )}

        {/* PHASE 2: PLAYING QUIZ */}
        {phase === 'playing' && activeQuestion && (
          <div className="qa-game__playfield">
            {/* Question Panel */}
            <div
              id="qa-question-box"
              className={`qa-game__question-box ${activeVoiceOver === 'question' ? 'qa-game__question-box--reading' : ''}`}
            >
              <p className="qa-game__question-text">{activeQuestion.question}</p>
              {/* Question gate progress bar */}
              <div
                className={`qa-game__question-progress-section ${!questionGateActive ? 'qa-game__question-progress-section--hidden' : ''}`}
                aria-hidden="true"
              >
                <div className="qa-game__question-progress-track">
                  <div
                    className="qa-game__question-progress-bar"
                    style={{ width: `${questionGateProgress * 100}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Answer Choices Grid */}
            <div
              className={`qa-game__choices-grid ${activeQuestion.answers.length <= 2 ? 'qa-game__choices-grid--2col' : 'qa-game__choices-grid--4col'}`}
              style={{
                opacity: questionGateActive ? 0 : 1,
                pointerEvents: (questionGateActive || answerGateActive) ? 'none' : 'auto',
                transition: 'opacity 0.25s ease-in-out'
              }}
            >
              {activeQuestion.answers.map((answer, i) => {
                const targetId = `choice-${i}`
                const isGazed = gazeState?.cellId === targetId || gazeState?.cellId === `choicegate-${i}`
                const isCorrect = feedback === 'correct' && selectedFeedbackIdx === i
                const isNeutral = feedback === 'neutral' && selectedFeedbackIdx === i
                const isWrong = feedback === 'wrong' && wrongFeedbackIdx === i
                const isPersistWrong = !!wrongAttempts[i]

                // Determine if hint is active
                const hintAfter = settings.qaPuzzleHintAfterWrong ?? 3
                const wrongCount = Object.keys(wrongAttempts).length
                const showHint = hintAfter > 0 && wrongCount >= hintAfter

                let correctIds = []
                if (activeQuestion.correctIds) {
                  correctIds = activeQuestion.correctIds
                } else if (activeQuestion.correctId) {
                  correctIds = [activeQuestion.correctId]
                }
                const isCorrectChoice = correctIds.includes(answer.id)
                const isHinted = showHint && isCorrectChoice && !isPersistWrong

                if (isPersistWrong) {
                  return (
                    <div key={answer.id} className="qa-game__choice-card qa-game__choice-card--disabled">
                      <span className="qa-game__choice-text">{answer.text}</span>
                    </div>
                  )
                }

                return (
                  <button
                    key={answer.id}
                    id={targetId}
                    className={`qa-game__choice-card ${isGazed ? 'qa-game__choice-card--gazed' : ''} ${isCorrect ? 'qa-game__choice-card--correct' : ''} ${isWrong ? 'qa-game__choice-card--wrong' : ''} ${isNeutral ? 'qa-game__choice-card--neutral' : ''} ${isHinted ? 'qa-game__choice-card--hint' : ''} ${activeVoiceOver === i ? 'qa-game__choice-card--reading' : ''}`}
                    onClick={() => handleAnswerSelect(i)}
                    disabled={answerGateActive || !!feedback}
                  >
                    <span className="qa-game__choice-text">{answer.text}</span>
                    <div
                      className="qa-game__choice-progress-bar"
                      style={{ width: `${getProgress(targetId) * 100}%` }}
                    />
                  </button>
                )
              })}
            </div>

            {/* Answer gate progress bar */}
            <div
              className={`qa-game__answer-progress-section ${!answerGateActive ? 'qa-game__answer-progress-section--hidden' : ''}`}
              aria-hidden="true"
            >
              <div className="qa-game__answer-progress-track">
                <div
                  className="qa-game__answer-progress-bar"
                  style={{ width: `${answerGateProgress * 100}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {/* PHASE 3: COMPLETED */}
        {phase === 'completed' && (
          <div className="qa-game__completed-panel">
            <h2 className="qa-game__completed-title">Quiz Finished!</h2>
            <p className="qa-game__completed-desc">
              You answered <strong>{score}</strong> out of <strong>{activeQuiz?.questions?.length}</strong> questions on the first try!
            </p>
            <button
              id="quiz-complete-btn"
              className={`qa-game__btn qa-game__btn--primary ${gazeState?.cellId === 'quiz-complete-btn' ? 'qa-game__btn--gazed' : ''}`}
              onClick={() => {
                setPhase('select-quiz')
                setActiveQuiz(null)
              }}
            >
              <span>Play Another Quiz</span>
              <div
                className="qa-game__btn-progress-bar"
                style={{ width: `${getProgress('quiz-complete-btn') * 100}%` }}
              />
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

function QuizzesEditor({ onBack, onPlayQuiz, onPlayQuestion }) {
  const { quizzes, saveQuizzes, deleteQuizLocally, settings, updateSetting } = useGazeSettings()
  const [selectedQuizId, setSelectedQuizId] = useState(null)
  const [activeTab, setActiveTab] = useState('editor') // 'editor' | 'settings' | 'ai-generator'

  // Local edit states
  const [activeQuiz, setActiveQuiz] = useState(null)
  const [activeQuizName, setActiveQuizName] = useState('')
  const [draggingIdx, setDraggingIdx] = useState(null)

  const handleDragStart = (e, idx) => {
    setDraggingIdx(idx)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleDrop = (e, targetIdx) => {
    e.preventDefault()
    if (draggingIdx === null || draggingIdx === targetIdx) return

    const reordered = [...quizzes]
    const [draggedQuiz] = reordered.splice(draggingIdx, 1)
    reordered.splice(targetIdx, 0, draggedQuiz)

    reordered.forEach((q, i) => {
      q.order = i
      q.updatedAt = Date.now()
    })

    saveQuizzes(reordered)
    setDraggingIdx(null)
  }

  const handleDragEnd = () => {
    setDraggingIdx(null)
  }

  // AI Quiz Generator states
  const [aiSourceText, setAiSourceText] = useState('')
  const [aiNumQuestions, setAiNumQuestions] = useState(5)
  const [aiDifficulty, setAiDifficulty] = useState('Medium')
  const [aiNumChoices, setAiNumChoices] = useState(4)
  const [aiSubjects, setAiSubjects] = useState('')
  const [aiQuizName, setAiQuizName] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)

  const handleFileUpload = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      setAiSourceText(event.target.result)
    }
    reader.readAsText(file)
  }

  const handleGenerateAiQuiz = async () => {
    if (!aiSourceText.trim()) {
      alert('Please enter some source text or upload a file first.')
      return
    }
    const apiKey = settings.geminiApiKey || ''
    if (!apiKey) {
      alert('Gemini API key is not configured. Please open Q&A Settings -> General Settings to set it first.')
      return
    }

    setIsGenerating(true)
    const model = settings.geminiModel || 'gemini-2.5-flash'
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

    const systemInstruction = 
      "You are an expert educational content creator. " +
      `Generate a list of exactly ${aiNumQuestions} multiple-choice questions at ${aiDifficulty} difficulty level. ` +
      `The quiz should focus on the following subjects/topics: ${aiSubjects || 'General reading comprehension'}. ` +
      "Output strictly valid JSON and nothing else. No markdown wrapping. Do not include any emojis in the questions or choices.";

    const possibleIds = ['a', 'b', 'c', 'd'].slice(0, aiNumChoices)
    const answerFormat = possibleIds.map(id => `{"id":"${id}","text":"[Option Text]"}`).join(', ')

    const promptText = 
      `Below is the source text/content. Read it carefully and generate exactly ${aiNumQuestions} multiple-choice questions about it.\n\n` +
      `SOURCE CONTENT:\n"""\n${aiSourceText}\n"""\n\n` +
      `RULES:\n` +
      `1. Every question must be relevant to the source content and the subjects specified: ${aiSubjects || 'General'}.\n` +
      `2. The difficulty level of the questions must be: ${aiDifficulty}.\n` +
      `3. Each question must have exactly ${aiNumChoices} answer choices.\n` +
      `4. Only ONE correct answer must be provided (its id must match one of the choices).\n` +
      `5. Absolutely NO emojis are allowed in the quiz text.\n` +
      `6. Return ONLY a valid JSON object in this format:\n` +
      `{ "name": "[Suggested Quiz Name]", "questions": [ { "question": "[Question text?]", "answers": [ ${answerFormat} ], "correctId": "${possibleIds[0]}" } ] }`;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: promptText }] }],
          systemInstruction: { parts: [{ text: systemInstruction }] },
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 3072,
            temperature: 0.3
          }
        })
      })

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
      }

      const data = await resp.json()
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const parsed = JSON.parse(rawText.trim())

      if (parsed && parsed.questions && parsed.questions.length > 0) {
        const generatedName = aiQuizName.trim() || parsed.name || `AI Quiz - ${aiSubjects || 'General'}`
        const newId = 'quiz_' + Date.now()
        const newQuiz = {
          id: newId,
          name: generatedName,
          dwellTimeMs: 2000,
          questions: parsed.questions.map(q => {
            if (!q.correctIds) {
              q.correctIds = q.correctId ? [q.correctId] : []
            }
            q.question = q.question.replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF]/g, '')
            q.answers.forEach(ans => {
              ans.text = ans.text.replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF]/g, '')
            })
            return q
          }),
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        const updated = [...quizzes, newQuiz]
        saveQuizzes(updated)
        setSelectedQuizId(newId)
        setActiveTab('editor')
        alert(`Successfully generated a new quiz "${generatedName}" with ${parsed.questions.length} questions!`)
        // Clear generator states
        setAiSourceText('')
        setAiSubjects('')
        setAiQuizName('')
      } else {
        throw new Error('Response JSON did not contain questions.')
      }
    } catch (err) {
      console.error('Quiz AI Generation failed:', err)
      alert('Generation failed: ' + err.message)
    } finally {
      setIsGenerating(false)
    }
  }

  // Selected quiz changes
  useEffect(() => {
    if (selectedQuizId) {
      const q = quizzes.find(item => item.id === selectedQuizId)
      if (q) {
        const copy = JSON.parse(JSON.stringify(q))
        copy.questions = (copy.questions || []).map(question => {
          if (!question.correctIds) {
            question.correctIds = question.correctId ? [question.correctId] : []
          }
          return question
        })
        setActiveQuiz(copy)
        setActiveQuizName(copy.name || '')
      } else {
        setActiveQuiz(null)
        setActiveQuizName('')
      }
    } else {
      setActiveQuiz(null)
      setActiveQuizName('')
    }
  }, [selectedQuizId, quizzes])

  const moveQuizUp = (e, idx) => {
    e.stopPropagation()
    if (idx <= 0) return
    const reordered = [...quizzes]
    const temp = reordered[idx]
    reordered[idx] = reordered[idx - 1]
    reordered[idx - 1] = temp

    reordered.forEach((q, i) => {
      q.order = i
      q.updatedAt = Date.now()
    })

    saveQuizzes(reordered)
  }

  const moveQuizDown = (e, idx) => {
    e.stopPropagation()
    if (idx >= quizzes.length - 1) return
    const reordered = [...quizzes]
    const temp = reordered[idx]
    reordered[idx] = reordered[idx + 1]
    reordered[idx + 1] = temp

    reordered.forEach((q, i) => {
      q.order = i
      q.updatedAt = Date.now()
    })

    saveQuizzes(reordered)
  }

  const handleCreateQuiz = () => {
    const newId = 'quiz_' + Date.now()
    const newQuiz = {
      id: newId,
      name: 'New Quiz ' + (quizzes.length + 1),
      dwellTimeMs: 2000,
      questions: [
        {
          question: 'What is the color of the sky?',
          answers: [
            { id: 'a', text: 'Blue' },
            { id: 'b', text: 'Green' },
            { id: 'c', text: 'Red' },
            { id: 'd', text: 'Yellow' }
          ],
          correctIds: ['a']
        }
      ],
      order: quizzes.length,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    const updated = [...quizzes, newQuiz]
    saveQuizzes(updated)
    setSelectedQuizId(newId)
    setActiveTab('editor')
  }

  const handleDeleteQuiz = (quizId) => {
    if (window.confirm('Are you sure you want to delete this quiz permanently?')) {
      deleteQuizLocally(quizId)
      if (selectedQuizId === quizId) {
        setSelectedQuizId(null)
      }
    }
  }

  const handleSaveQuiz = () => {
    if (!activeQuiz) return
    const updatedQuiz = {
      ...activeQuiz,
      name: activeQuizName.trim() || 'Untitled Quiz',
      updatedAt: Date.now()
    }

    updatedQuiz.questions.forEach(q => {
      q.correctId = q.correctIds && q.correctIds.length > 0 ? q.correctIds[0] : ''
    })

    const updatedList = quizzes.map(q => q.id === activeQuiz.id ? updatedQuiz : q)
    saveQuizzes(updatedList)
    alert('Quiz saved successfully!')
  }

  const handleAddQuestion = () => {
    if (!activeQuiz) return
    const newQuestion = {
      question: 'New Question?',
      answers: [
        { id: 'a', text: 'Option A' },
        { id: 'b', text: 'Option B' }
      ],
      correctIds: ['a']
    }
    setActiveQuiz(prev => ({
      ...prev,
      questions: [...(prev.questions || []), newQuestion]
    }))
  }

  const handleRemoveQuestion = (idx) => {
    if (!activeQuiz) return
    const qs = [...(activeQuiz.questions || [])]
    qs.splice(idx, 1)
    setActiveQuiz(prev => ({ ...prev, questions: qs }))
  }

  const handleQuestionTextChange = (idx, text) => {
    if (!activeQuiz) return
    const qs = [...(activeQuiz.questions || [])]
    qs[idx].question = text
    setActiveQuiz(prev => ({ ...prev, questions: qs }))
  }

  const handleAnswerTextChange = (qIdx, aIdx, text) => {
    if (!activeQuiz) return
    const qs = [...(activeQuiz.questions || [])]
    qs[qIdx].answers[aIdx].text = text
    setActiveQuiz(prev => ({ ...prev, questions: qs }))
  }

  const handleToggleCorrect = (qIdx, ansId) => {
    if (!activeQuiz) return
    const qs = [...(activeQuiz.questions || [])]
    const q = qs[qIdx]
    if (!q.correctIds) q.correctIds = []

    const index = q.correctIds.indexOf(ansId)
    if (index === -1) {
      q.correctIds.push(ansId)
    } else {
      q.correctIds.splice(index, 1)
    }
    setActiveQuiz(prev => ({ ...prev, questions: qs }))
  }

  const handleAddChoice = (qIdx) => {
    if (!activeQuiz) return
    const qs = [...(activeQuiz.questions || [])]
    const q = qs[qIdx]
    if (q.answers.length >= 4) return

    const possibleIds = ['a', 'b', 'c', 'd']
    const existingIds = q.answers.map(ans => ans.id)
    const nextId = possibleIds.find(id => !existingIds.includes(id)) || 'a'

    q.answers.push({ id: nextId, text: `Choice ${nextId.toUpperCase()}` })
    setActiveQuiz(prev => ({ ...prev, questions: qs }))
  }

  const handleRemoveChoice = (qIdx, aIdx) => {
    if (!activeQuiz) return
    const qs = [...(activeQuiz.questions || [])]
    const q = qs[qIdx]
    if (q.answers.length <= 1) return

    const removedAns = q.answers[aIdx]
    q.answers.splice(aIdx, 1)
    q.correctIds = (q.correctIds || []).filter(id => id !== removedAns.id)

    setActiveQuiz(prev => ({ ...prev, questions: qs }))
  }

  return (
    <div className="cp-quizzes">
      {/* Left Column: Quiz Selector */}
      <div className="cp-quizzes__sidebar">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <h3 className="cp-quizzes__sec-title" style={{ margin: 0 }}>Quizzes</h3>
          <button
            className={`cp-quizzes__settings-tab-btn`}
            onClick={() => {
              setActiveTab('settings')
              setSelectedQuizId(null)
            }}
            style={{
              background: activeTab === 'settings' ? 'rgba(0, 200, 255, 0.15)' : 'transparent',
              border: activeTab === 'settings' ? '1px solid #00c8ff' : '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '8px',
              padding: '4px 10px',
              color: activeTab === 'settings' ? '#00c8ff' : '#94a3b8',
              cursor: 'pointer',
              fontSize: '0.78rem',
              fontWeight: '700',
              transition: 'all 0.2s'
            }}
          >
            ⚙ Settings
          </button>
        </div>
        <div className="cp-quizzes__list">
          {quizzes.map((q, idx) => (
            <div
              key={q.id}
              draggable
              onDragStart={(e) => handleDragStart(e, idx)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, idx)}
              onDragEnd={handleDragEnd}
              className={`cp-quizzes__item ${selectedQuizId === q.id && activeTab === 'editor' ? 'cp-quizzes__item--active' : ''} ${draggingIdx === idx ? 'cp-quizzes__item--dragging' : ''}`}
              onClick={() => {
                setSelectedQuizId(q.id)
                setActiveTab('editor')
              }}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cp-quizzes__item-name">{idx + 1}. {q.name}</div>
                <div className="cp-quizzes__item-count">{q.questions?.length || 0} questions</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginLeft: '0.5rem' }}>
                <button
                  type="button"
                  onClick={(e) => moveQuizUp(e, idx)}
                  disabled={idx === 0}
                  className="cp-quizzes__order-btn"
                  title="Move Up"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={(e) => moveQuizDown(e, idx)}
                  disabled={idx === quizzes.length - 1}
                  className="cp-quizzes__order-btn"
                  title="Move Down"
                >
                  ▼
                </button>
              </div>
            </div>
          ))}
        </div>
        <button className="cp-quizzes__add-btn" onClick={handleCreateQuiz}>
          + Create New Quiz
        </button>
        <button
          className="cp-quizzes__add-btn"
          onClick={() => {
            setActiveTab('ai-generator')
            setSelectedQuizId(null)
          }}
          style={{
            marginTop: '0.5rem',
            background: activeTab === 'ai-generator' ? 'rgba(99, 102, 241, 0.2)' : 'rgba(99, 102, 241, 0.08)',
            border: activeTab === 'ai-generator' ? '1.5px solid #818cf8' : '1.5px solid rgba(99, 102, 241, 0.2)',
            color: activeTab === 'ai-generator' ? '#fff' : '#a5b4fc',
          }}
        >
          🪄 Create New Quiz with AI
        </button>
      </div>

      {/* Right Column: Active Workspace */}
      <div className="cp-quizzes__workspace">
        {activeTab === 'settings' ? (
          <div className="cp-quizzes__settings-panel">
            <h3 style={{ color: '#00c8ff', marginTop: 0, marginBottom: '0.4rem', fontSize: '1.1rem', fontWeight: 800 }}>⚙ Q&A Settings</h3>
            <p style={{ color: '#94a3b8', fontSize: '0.82rem', marginBottom: '1.5rem', lineHeight: 1.4 }}>
              Configure gating timers, hint displays, and sound options for Q&A gameplay.
            </p>

            {/* Question Gate */}
            <div className="cp-quizzes__setting-row">
              <div className="cp-quizzes__setting-info">
                <span className="cp-quizzes__setting-name">Question Gate (Read Time)</span>
                <span className="cp-quizzes__setting-desc">
                  Time question text is shown before choices appear.
                </span>
              </div>
              <div className="cp-quizzes__setting-control">
                <select
                  value={settings.qaQuizQuestionGateMs ?? 2000}
                  onChange={(e) => {
                    const val = e.target.value
                    updateSetting('qaQuizQuestionGateMs', val === 'click' ? 'click' : parseInt(val, 10))
                  }}
                  className="cp-quizzes__select"
                >
                  <option value="click">On Click</option>
                  <option value={0}>Instant (0s)</option>
                  <option value={500}>0.5s</option>
                  <option value={1000}>1s</option>
                  <option value={1500}>1.5s</option>
                  <option value={2000}>2s (Std)</option>
                  <option value={3000}>3s</option>
                  <option value={5000}>5s</option>
                  <option value={10000}>10s</option>
                </select>
              </div>
            </div>

            {/* Answer Gate */}
            <div className="cp-quizzes__setting-row">
              <div className="cp-quizzes__setting-info">
                <span className="cp-quizzes__setting-name">Answer Gate (Selection Delay)</span>
                <span className="cp-quizzes__setting-desc">
                  Time choices are shown before gaze dwell selection is enabled.
                </span>
              </div>
              <div className="cp-quizzes__setting-control">
                <select
                  value={settings.qaQuizAnswerGateMs ?? 1500}
                  onChange={(e) => updateSetting('qaQuizAnswerGateMs', parseInt(e.target.value, 10))}
                  className="cp-quizzes__select"
                >
                  <option value={0}>Instant (0s)</option>
                  <option value={500}>0.5s</option>
                  <option value={1000}>1s</option>
                  <option value={1500}>1.5s (Std)</option>
                  <option value={2000}>2s</option>
                  <option value={3000}>3s</option>
                  <option value={5000}>5s</option>
                </select>
              </div>
            </div>

            {/* Hint Gate */}
            <div className="cp-quizzes__setting-row">
              <div className="cp-quizzes__setting-info">
                <span className="cp-quizzes__setting-name">Wrong Answers Before Hint</span>
                <span className="cp-quizzes__setting-desc">
                  Number of wrong selections before correct answer starts to glow.
                </span>
              </div>
              <div className="cp-quizzes__setting-control">
                <select
                  value={settings.qaPuzzleHintAfterWrong ?? 3}
                  onChange={(e) => updateSetting('qaPuzzleHintAfterWrong', parseInt(e.target.value, 10))}
                  className="cp-quizzes__select"
                >
                  <option value={0}>Disabled</option>
                  <option value={1}>Immediate (1)</option>
                  <option value={2}>2 attempts</option>
                  <option value={3}>3 attempts (Std)</option>
                  <option value={4}>4 attempts</option>
                  <option value={5}>5 attempts</option>
                </select>
              </div>
            </div>

            {/* Sound Effects */}
            <div className="cp-quizzes__setting-row">
              <div className="cp-quizzes__setting-info">
                <span className="cp-quizzes__setting-name">Answer Sound Effects</span>
                <span className="cp-quizzes__setting-desc">
                  Play rising arpeggios for correct answers and low tones for wrong attempts.
                </span>
              </div>
              <div className="cp-quizzes__setting-control" style={{ display: 'flex', alignItems: 'center', height: '36px' }}>
                <input
                  type="checkbox"
                  checked={settings.qaQuizSoundEffects ?? true}
                  onChange={(e) => updateSetting('qaQuizSoundEffects', e.target.checked)}
                  className="cp-quizzes__checkbox"
                  style={{ width: '1.25rem', height: '1.25rem', cursor: 'pointer' }}
                />
              </div>
            </div>

            {/* Read Questions Aloud (Voiceover) */}
            <div className="cp-quizzes__setting-row">
              <div className="cp-quizzes__setting-info">
                <span className="cp-quizzes__setting-name">Read Questions Aloud</span>
                <span className="cp-quizzes__setting-desc">
                  Use the system voice to read each quiz question when it appears.
                </span>
              </div>
              <div className="cp-quizzes__setting-control" style={{ display: 'flex', alignItems: 'center', height: '36px' }}>
                <input
                  type="checkbox"
                  checked={settings.qaQuizVoiceOver ?? true}
                  onChange={(e) => updateSetting('qaQuizVoiceOver', e.target.checked)}
                  className="cp-quizzes__checkbox"
                  style={{ width: '1.25rem', height: '1.25rem', cursor: 'pointer' }}
                />
              </div>
            </div>

            {/* Read Answer Choices Aloud */}
            {(settings.qaQuizVoiceOver ?? true) && (
              <>
                <div className="cp-quizzes__setting-row">
                  <div className="cp-quizzes__setting-info">
                    <span className="cp-quizzes__setting-name">Read Answer Choices Aloud</span>
                    <span className="cp-quizzes__setting-desc">
                      After reading the question, each answer choice is also spoken.
                    </span>
                  </div>
                  <div className="cp-quizzes__setting-control" style={{ display: 'flex', alignItems: 'center', height: '36px' }}>
                    <input
                      type="checkbox"
                      checked={settings.qaQuizVoiceOverChoices ?? true}
                      onChange={(e) => updateSetting('qaQuizVoiceOverChoices', e.target.checked)}
                      className="cp-quizzes__checkbox"
                      style={{ width: '1.25rem', height: '1.25rem', cursor: 'pointer' }}
                    />
                  </div>
                </div>

                <div className="cp-quizzes__setting-row">
                  <div className="cp-quizzes__setting-info">
                    <span className="cp-quizzes__setting-name">Voice Over Pause</span>
                    <span className="cp-quizzes__setting-desc">
                      Delay between reading the question and answer choices, and between each choice.
                    </span>
                  </div>
                  <div className="cp-quizzes__setting-control">
                    <select
                      value={settings.qaQuizVoiceOverPauseMs ?? 500}
                      onChange={(e) => updateSetting('qaQuizVoiceOverPauseMs', parseInt(e.target.value, 10))}
                      className="cp-quizzes__select"
                    >
                      <option value={0}>No Pause (0ms)</option>
                      <option value={100}>100ms</option>
                      <option value={200}>200ms</option>
                      <option value={300}>300ms</option>
                      <option value={400}>400ms</option>
                      <option value={500}>500ms (Std)</option>
                      <option value={750}>750ms</option>
                      <option value={1000}>1s</option>
                      <option value={1500}>1.5s</option>
                      <option value={2000}>2s</option>
                      <option value={3000}>3s</option>
                      <option value={4000}>4s</option>
                      <option value={5000}>5s</option>
                    </select>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : activeTab === 'ai-generator' ? (
          <div className="cp-quizzes__ai-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem', padding: '1.5rem', background: 'rgba(255, 255, 255, 0.01)', border: '1px solid rgba(255, 255, 255, 0.05)', borderRadius: '12px' }}>
            <h3 style={{ color: '#a5b4fc', marginTop: 0, marginBottom: '0.4rem', fontSize: '1.15rem', fontWeight: 800 }}>🪄 Create New Quiz with AI</h3>
            <p style={{ color: '#94a3b8', fontSize: '0.82rem', marginBottom: '1rem', lineHeight: 1.4 }}>
              Enter or upload source text/story content, configure generation rules, and Gemini will automatically generate quiz questions and choices.
            </p>

            <div style={{ display: 'flex', gap: '1.5rem' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {/* Source text area */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fff' }}>Source Text / Narrative Content</label>
                  <textarea
                    style={{
                      height: '180px',
                      background: 'rgba(0, 0, 0, 0.35)',
                      border: '1.5px solid rgba(0, 200, 255, 0.25)',
                      borderRadius: '8px',
                      color: '#fff',
                      padding: '0.8rem',
                      fontSize: '0.85rem',
                      fontFamily: 'inherit',
                      resize: 'vertical',
                      outline: 'none'
                    }}
                    value={aiSourceText}
                    onChange={(e) => setAiSourceText(e.target.value)}
                    placeholder="Enter or paste the story, outline, article, or source text here..."
                  />
                </div>

                {/* File upload input */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fff' }}>Or Upload Text File (.txt)</label>
                  <input
                    type="file"
                    accept=".txt"
                    onChange={handleFileUpload}
                    style={{
                      fontSize: '0.82rem',
                      color: '#94a3b8',
                      cursor: 'pointer'
                    }}
                  />
                </div>
              </div>

              {/* Options Sidebar */}
              <div style={{ width: '280px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#94a3b8' }}>Quiz Name (Optional)</label>
                  <input
                    type="text"
                    value={aiQuizName}
                    onChange={(e) => setAiQuizName(e.target.value)}
                    placeholder="e.g. Solar System Quiz"
                    style={{
                      padding: '0.5rem 0.7rem',
                      background: 'rgba(0, 0, 0, 0.35)',
                      border: '1.5px solid rgba(0, 200, 255, 0.25)',
                      borderRadius: '8px',
                      color: '#fff',
                      fontSize: '0.82rem',
                      outline: 'none'
                    }}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#94a3b8' }}>Subjects / Focus Topics</label>
                  <input
                    type="text"
                    value={aiSubjects}
                    onChange={(e) => setAiSubjects(e.target.value)}
                    placeholder="e.g. Astronomy, Planets"
                    style={{
                      padding: '0.5rem 0.7rem',
                      background: 'rgba(0, 0, 0, 0.35)',
                      border: '1.5px solid rgba(0, 200, 255, 0.25)',
                      borderRadius: '8px',
                      color: '#fff',
                      fontSize: '0.82rem',
                      outline: 'none'
                    }}
                  />
                </div>

                <div style={{ display: 'flex', gap: '0.8rem' }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                    <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#94a3b8' }}>Questions</label>
                    <select
                      value={aiNumQuestions}
                      onChange={(e) => setAiNumQuestions(parseInt(e.target.value, 10))}
                      style={{
                        padding: '0.5rem 0.7rem',
                        background: 'rgba(0, 0, 0, 0.35)',
                        border: '1.5px solid rgba(0, 200, 255, 0.25)',
                        borderRadius: '8px',
                        color: '#fff',
                        fontSize: '0.82rem',
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                    >
                      {[1,2,3,4,5,6,7,8,9,10].map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </div>

                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                    <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#94a3b8' }}>Choices</label>
                    <select
                      value={aiNumChoices}
                      onChange={(e) => setAiNumChoices(parseInt(e.target.value, 10))}
                      style={{
                        padding: '0.5rem 0.7rem',
                        background: 'rgba(0, 0, 0, 0.35)',
                        border: '1.5px solid rgba(0, 200, 255, 0.25)',
                        borderRadius: '8px',
                        color: '#fff',
                        fontSize: '0.82rem',
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                    >
                      <option value={2}>2 options</option>
                      <option value={3}>3 options</option>
                      <option value={4}>4 options</option>
                    </select>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#94a3b8' }}>Difficulty</label>
                  <select
                    value={aiDifficulty}
                    onChange={(e) => setAiDifficulty(e.target.value)}
                    style={{
                      padding: '0.5rem 0.7rem',
                      background: 'rgba(0, 0, 0, 0.35)',
                      border: '1.5px solid rgba(0, 200, 255, 0.25)',
                      borderRadius: '8px',
                      color: '#fff',
                      fontSize: '0.82rem',
                      outline: 'none',
                      cursor: 'pointer'
                    }}
                  >
                    <option value="Easy">Easy</option>
                    <option value="Medium">Medium</option>
                    <option value="Hard">Hard</option>
                  </select>
                </div>
              </div>
            </div>

            <button
              onClick={handleGenerateAiQuiz}
              disabled={isGenerating}
              style={{
                marginTop: '0.5rem',
                padding: '0.8rem',
                background: isGenerating ? 'rgba(99, 102, 241, 0.2)' : 'linear-gradient(135deg, #6366f1, #818cf8)',
                border: 'none',
                borderRadius: '8px',
                color: isGenerating ? '#94a3b8' : '#fff',
                fontWeight: 700,
                fontSize: '0.9rem',
                cursor: isGenerating ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                transition: 'all 0.2s',
                boxShadow: isGenerating ? 'none' : '0 4px 12px rgba(99, 102, 241, 0.25)'
              }}
            >
              {isGenerating ? (
                <>
                  <span>Generating Quiz...</span>
                  <div style={{ width: '16px', height: '16px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'qa-spin 0.8s linear infinite' }} />
                </>
              ) : (
                <>
                  <span>🪄 Generate Quiz questions with AI</span>
                </>
              )}
            </button>
          </div>
        ) : activeQuiz ? (
          <div className="cp-quizzes__editor">
            {/* Header info */}
            <div className="cp-quizzes__edit-header">
              <div className="cp-quizzes__title-row">
                <input
                  type="text"
                  className="cp-quizzes__name-input"
                  value={activeQuizName}
                  onChange={(e) => setActiveQuizName(e.target.value)}
                  placeholder="Quiz Name"
                />
                <div className="cp-quizzes__header-actions">
                  <button className="cp-quizzes__play-btn" onClick={() => onPlayQuiz(activeQuiz.id)}>
                    Play Quiz
                  </button>
                  <button className="cp-quizzes__del-btn" onClick={() => handleDeleteQuiz(activeQuiz.id)}>
                    Delete Quiz
                  </button>
                </div>
              </div>
            </div>

            {/* Questions list */}
            <div className="cp-quizzes__questions-sec">
              <div className="cp-quizzes__sec-header">
                <h4>Questions</h4>
                <button className="cp-quizzes__add-q-btn" onClick={handleAddQuestion}>
                  + Add Question
                </button>
              </div>

              <div className="cp-quizzes__questions-list">
                {(activeQuiz.questions || []).map((q, qIdx) => (
                  <div key={qIdx} className="cp-quizzes__q-card">
                    <div className="cp-quizzes__q-header">
                      <span className="cp-quizzes__q-num">Question {qIdx + 1}</span>
                      <div className="cp-quizzes__q-actions">
                        <button className="cp-quizzes__play-q-btn" onClick={() => onPlayQuestion(activeQuiz.id, qIdx)}>
                          Play Question
                        </button>
                        <button className="cp-quizzes__remove-q-btn" onClick={() => handleRemoveQuestion(qIdx)}>
                          Remove
                        </button>
                      </div>
                    </div>

                    <div className="cp-quizzes__field">
                      <label>Question Prompt</label>
                      <textarea
                        className="cp-quizzes__textarea"
                        value={q.question}
                        onChange={(e) => handleQuestionTextChange(qIdx, e.target.value)}
                        placeholder="e.g. What animal makes a meow sound?"
                      />
                    </div>

                    <div className="cp-quizzes__field">
                      <label>Answers & Correct Choice(s) (Check box if correct)</label>
                      <div className="cp-quizzes__choices-list">
                        {q.answers.map((ans, aIdx) => (
                          <div key={ans.id} className="cp-quizzes__choice-row">
                            <input
                              type="checkbox"
                              className="cp-quizzes__checkbox"
                              checked={(q.correctIds || []).includes(ans.id)}
                              onChange={() => handleToggleCorrect(qIdx, ans.id)}
                              title="Mark as correct answer"
                            />
                            <input
                              type="text"
                              className="cp-quizzes__choice-input"
                              value={ans.text}
                              onChange={(e) => handleAnswerTextChange(qIdx, aIdx, e.target.value)}
                              placeholder={`Choice ${ans.id.toUpperCase()}`}
                            />
                            <button
                              className="cp-quizzes__remove-choice-btn"
                              disabled={q.answers.length <= 1}
                              onClick={() => handleRemoveChoice(qIdx, aIdx)}
                              title="Delete choice"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                      {q.answers.length < 4 && (
                        <button className="cp-quizzes__add-choice-btn" onClick={() => handleAddChoice(qIdx)}>
                          + Add Answer Choice
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="cp-quizzes__footer">
              <button className="cp-quizzes__save-btn" onClick={handleSaveQuiz}>
                Save Quiz Configuration
              </button>
            </div>
          </div>
        ) : (
          <div className="cp-quizzes__empty">
            <p>Select a quiz from the sidebar or click Create New Quiz to get started.</p>
          </div>
        )}
      </div>
    </div>
  )
}
