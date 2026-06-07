import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { useGazeSettings } from './GazeSettingsContext'

const CameraVisionContext = createContext(null)

// ─── CDN URLs for TensorFlow & vision models ───────────────────────────────
const TFJS_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js'
const FACEAPI_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1/dist/face-api.js'
const COCOSSD_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js'
const MOBILENET_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js'

// Model weights URLs for FaceAPI
const FACEAPI_MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1/model/'

// Euclidean distance helper for Face Recognition 128-D vectors
function calculateEuclideanDistance(arr1, arr2) {
  if (!arr1 || !arr2 || arr1.length !== arr2.length) return Infinity
  let sum = 0
  for (let i = 0; i < arr1.length; i++) {
    const diff = arr1[i] - arr2[i]
    sum += diff * diff
  }
  return Math.sqrt(sum)
}

// Cosine Similarity helper for 1024-D MobileNet scene/object vectors
function calculateCosineSimilarity(arr1, arr2) {
  if (!arr1 || !arr2 || arr1.length !== arr2.length) return 0
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < arr1.length; i++) {
    dotProduct += arr1[i] * arr2[i]
    normA += arr1[i] * arr1[i]
    normB += arr2[i] * arr2[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

// Synthesizes a soft, discreet, and extremely short high-pitched update cue using Web Audio API
function playUpdateSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const gain = ctx.createGain()
    gain.connect(ctx.destination)

    const osc = ctx.createOscillator()
    osc.type = 'sine'
    // B5 tone (987.77 Hz) for a crystal-clear, gentle micro-chime
    osc.frequency.setValueAtTime(987.77, ctx.currentTime)
    
    // Very quiet (gain 0.035) with extremely fast attack & decay to be non-intrusive
    gain.gain.setValueAtTime(0, ctx.currentTime)
    gain.gain.linearRampToValueAtTime(0.035, ctx.currentTime + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.07)

    osc.connect(gain)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.08)

    setTimeout(() => ctx.close(), 150)
  } catch (e) {
    // Fail silently (e.g. browser context suspended or blocked)
  }
}

export function CameraVisionProvider({ children }) {
  const { settings, updateSetting, updateSettings } = useGazeSettings()

  // Dynamic Model loading states
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [loadError, setLoadError] = useState(null)

  // Camera stream states
  const [cameraActive, setCameraActive] = useState(false)
  const [videoDevices, setVideoDevices] = useState([])
  const [cameraStream, setCameraStream] = useState(null)

  // Diagnostics and live processing outputs
  const [visionData, setVisionData] = useState({
    people: [],    // Array<{ name: string, expression: string, confidence: number, box: object }>
    objects: [],   // Array<{ label: string, confidence: number, box: object }>
    scene: 'Unknown',
    matchedObjects: [], // Array<{ label: string, similarity: number }>
  })

  // Real-time text summary fed to the LLM
  const [liveVisionSummary, setLiveVisionSummary] = useState('')

  // Refs for background canvas, video, model objects
  const offscreenVideoRef = useRef(null)
  const offscreenCanvasRef = useRef(null)
  const activeStreamRef = useRef(null)
  const loopIntervalRef = useRef(null)

  const cocoModelRef = useRef(null)
  const mobilenetModelRef = useRef(null)

  const loadedScriptsRef = useRef(new Set())

  // ─── Script Injector Helper ───────────────────────────────────────────────
  const injectScript = useCallback((src) => {
    return new Promise((resolve, reject) => {
      // Check if already injected
      if (loadedScriptsRef.current.has(src)) {
        resolve()
        return
      }

      const scripts = Array.from(document.getElementsByTagName('script'))
      if (scripts.some(s => s.src === src)) {
        loadedScriptsRef.current.add(src)
        resolve()
        return
      }

      console.log(`[CameraVisionContext] Fetching and injecting wrapped script: ${src}`)
      fetch(src)
        .then(response => {
          if (!response.ok) {
            throw new Error(`HTTP status ${response.status}`)
          }
          return response.text()
        })
        .then(code => {
          const s = document.createElement('script')
          
          // Electron UMD safety wrapper:
          // We wrap the script in an IIFE and pass undefined for exports, module, and define.
          // This forces the UMD wrappers in tfjs, face-api, coco-ssd, and mobilenet to fall back
          // to browser-global registration (window.tf, window.faceapi, window.cocoSsd, window.mobilenet),
          // preventing them from registering under Node/CommonJS/AMD which would fail or go missing in Electron.
          // Since local function scoping will mask 'var' declarations (like vladmandic's face-api),
          // we explicitly re-expose these variables to the global window object at the end of the wrapper.
          s.text = `(function(exports, module, define) {
            ${code}
            if (typeof tf !== 'undefined') window.tf = tf;
            if (typeof faceapi !== 'undefined') window.faceapi = faceapi;
            if (typeof cocoSsd !== 'undefined') window.cocoSsd = cocoSsd;
            if (typeof mobilenet !== 'undefined') window.mobilenet = mobilenet;
          }).call(window, undefined, undefined, undefined);
          //# sourceURL=${src}`

          document.body.appendChild(s)
          loadedScriptsRef.current.add(src)
          resolve()
        })
        .catch(err => {
          console.error(`[CameraVisionContext] Failed to fetch and inject wrapped script: ${src}`, err)
          reject(new Error(`Failed to load script: ${src}. ${err.message}`))
        })
    })
  }, [])

  // ─── Dynamic Model Loader ───────────────────────────────────────────────
  const initMLModels = useCallback(async () => {
    if (modelsLoaded || loadingModels) return
    setLoadingModels(true)
    setLoadError(null)

    try {
      console.log('[CameraVisionContext] Loading TensorFlow.js base...')
      await injectScript(TFJS_URL)
      console.log('[CameraVisionContext] TFJS loaded. window.tf present:', !!window.tf)

      console.log('[CameraVisionContext] Loading Face-API...')
      await injectScript(FACEAPI_URL)
      console.log('[CameraVisionContext] Face-API loaded. window.faceapi present:', !!window.faceapi)

      console.log('[CameraVisionContext] Loading COCO-SSD...')
      await injectScript(COCOSSD_URL)
      console.log('[CameraVisionContext] COCO-SSD loaded. window.cocoSsd present:', !!window.cocoSsd)

      console.log('[CameraVisionContext] Loading MobileNet...')
      await injectScript(MOBILENET_URL)
      console.log('[CameraVisionContext] MobileNet loaded. window.mobilenet present:', !!window.mobilenet)

      const { faceapi, cocoSsd, mobilenet } = window
      if (!faceapi || !cocoSsd || !mobilenet) {
        const missing = []
        if (!faceapi) missing.push('faceapi')
        if (!cocoSsd) missing.push('cocoSsd')
        if (!mobilenet) missing.push('mobilenet')
        throw new Error(`Script execution completed but global window objects are missing: ${missing.join(', ')}`)
      }

      console.log('[CameraVisionContext] Hydrating Face-API model weights...')
      // Load SSD MobileNet face detector, landmarks, face recognition ResNet, and expressions
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(FACEAPI_MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(FACEAPI_MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(FACEAPI_MODEL_URL),
        faceapi.nets.faceExpressionNet.loadFromUri(FACEAPI_MODEL_URL),
      ])

      console.log('[CameraVisionContext] Initializing COCO-SSD object detector...')
      cocoModelRef.current = await cocoSsd.load()

      console.log('[CameraVisionContext] Initializing MobileNet scene classifier...')
      mobilenetModelRef.current = await mobilenet.load({
        version: 1,
        alpha: 1.0,
        modelUrl: 'https://storage.googleapis.com/tfjs-models/savedmodel/mobilenet_v1_1.0_224/model.json'
      })

      console.log('[CameraVisionContext] All computer vision models successfully loaded client-side!')
      setModelsLoaded(true)
    } catch (err) {
      console.error('[CameraVisionContext] Model load failure:', err)
      setLoadError(err.message)
    } finally {
      setLoadingModels(false)
    }
  }, [injectScript, modelsLoaded, loadingModels])

  // ─── Enumerate Camera Devices ─────────────────────────────────────────────
  const refreshVideoDevices = useCallback(async () => {
    try {
      // Enumerate devices without probing the camera first.
      // Device labels may appear as empty strings until an active getUserMedia
      // stream exists, but startCamera() is called right after this, which
      // creates the real stream and populates labels on the next enumeration.
      const all = await navigator.mediaDevices.enumerateDevices()
      const videoInputs = all.filter(d => d.kind === 'videoinput')
      setVideoDevices(videoInputs)
      console.log('[CameraVisionContext] Detected video sources:', videoInputs)
    } catch (err) {
      console.warn('[CameraVisionContext] Could not enumerate video devices:', err.message)
      setVideoDevices([])
    }
  }, [])

  // Camera devices are now discovered on-demand when camera features are enabled,
  // NOT on mount, to avoid activating the webcam at startup.
  const devicesEnumeratedRef = useRef(false)

  // ─── Start Camera hardware feed ──────────────────────────────────────────
  const startCamera = useCallback(async (facingModeOverride, deviceIdOverride) => {
    // Stop any existing stream first
    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach(t => t.stop())
    }

    const facing = facingModeOverride || settings.cameraFacingMode || 'user'
    const deviceId = deviceIdOverride || settings.cameraSelectedDeviceId

    console.log(`[CameraVisionContext] Launching video stream (Facing: ${facing}, DeviceId: ${deviceId})`)

    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
        : { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } }
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      activeStreamRef.current = stream
      setCameraStream(stream)
      setCameraActive(true)

      // Bind offscreen video element if not already visible
      if (!offscreenVideoRef.current) {
        const vid = document.createElement('video')
        vid.muted = true
        vid.playsInline = true
        offscreenVideoRef.current = vid
      }
      offscreenVideoRef.current.srcObject = stream
      offscreenVideoRef.current.play()

      return stream
    } catch (err) {
      console.error('[CameraVisionContext] Failed to access camera:', err)
      setCameraActive(false)
      throw err
    }
  }, [settings.cameraFacingMode, settings.cameraSelectedDeviceId])

  // ─── Stop Camera feed ─────────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    console.log('[CameraVisionContext] Tearing down camera stream')
    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach(t => t.stop())
      activeStreamRef.current = null
    }
    if (offscreenVideoRef.current) {
      offscreenVideoRef.current.srcObject = null
    }
    setCameraStream(null)
    setCameraActive(false)
  }, [])

  // ─── Run One Detection Cycle ───
  const processFrame = useCallback(async (sourceElement) => {
    if (!modelsLoaded) return null

    const tf = window.tf
    const faceapi = window.faceapi

    if (!sourceElement) return null

    const results = {
      people: [],
      objects: [],
      scene: 'Unknown',
      matchedObjects: []
    }

    try {
      // 1. Face Recognition & Expressions (face-api.js)
      const detections = await faceapi
        .detectAllFaces(sourceElement, new faceapi.SsdMobilenetv1Options({ minConfidence: settings.cameraMinConfidence }))
        .withFaceLandmarks()
        .withFaceExpressions()
        .withFaceDescriptors()

      if (detections && detections.length > 0) {
        const regFaces = settings.registeredFaces || []
        results.people = detections.map(det => {
          // Find dominant expression
          let expression = 'neutral'
          let maxVal = 0
          if (det.expressions) {
            Object.entries(det.expressions).forEach(([exp, val]) => {
              if (val > maxVal) {
                maxVal = val
                expression = exp
              }
            })
          }

          // Match registered profiles using 128-D Euclidean distance
          let matchedName = 'Stranger'
          let minDistance = Infinity

          regFaces.forEach(profile => {
            // Match against legacy descriptor
            if (profile.descriptor) {
              const dist = calculateEuclideanDistance(det.descriptor, profile.descriptor)
              if (dist < minDistance) {
                minDistance = dist
                if (dist < 0.6) { // standard FaceNet match threshold
                  matchedName = profile.name
                }
              }
            }

            // Match against any uploaded photo descriptors (up to 5)
            if (profile.photos && profile.photos.length > 0) {
              profile.photos.forEach(photo => {
                if (photo.descriptor) {
                  const dist = calculateEuclideanDistance(det.descriptor, photo.descriptor)
                  if (dist < minDistance) {
                    minDistance = dist
                    if (dist < 0.6) {
                      matchedName = profile.name
                    }
                  }
                }
              })
            }
          })

          return {
            name: matchedName,
            expression,
            confidence: det.detection.score,
            box: det.detection.box,
            descriptor: Array.from(det.descriptor) // convert to standard array
          }
        })
      }

      // 2. Common Object Detection (COCO-SSD)
      if (cocoModelRef.current) {
        const objDets = await cocoModelRef.current.detect(sourceElement)
        if (objDets) {
          results.objects = objDets
            .filter(d => d.score >= settings.cameraMinConfidence)
            .map(d => ({
              label: d.class,
              confidence: d.score,
              box: { x: d.bbox[0], y: d.bbox[1], width: d.bbox[2], height: d.bbox[3] }
            }))
        }
      }

      // 3. Scene Classification & Registered Item Matching (MobileNet)
      if (mobilenetModelRef.current) {
        // General scene prediction
        const classDets = await mobilenetModelRef.current.classify(sourceElement, 3)
        if (classDets && classDets.length > 0) {
          results.scene = classDets[0].className.split(',')[0] // pick dominant class
        }

        // Custom Registered vector matching via MobileNet feature embeddings
        const regObjects = settings.registeredObjects || []
        if (regObjects.length > 0) {
          // Extract 1024-D embedding vector
          const inferTensor = mobilenetModelRef.current.infer(sourceElement, true)
          const liveEmbedding = Array.from(await inferTensor.data())
          inferTensor.dispose()

          regObjects.forEach(item => {
            const similarity = calculateCosineSimilarity(liveEmbedding, item.descriptor)
            if (similarity > 0.85) { // high match threshold
              results.matchedObjects.push({
                id: item.id,
                label: item.label,
                type: item.type,
                similarity
              })
            }
          })
        }
      }
    } catch (e) {
      console.warn('[CameraVisionContext] Background processing error:', e.message)
    }

    return results
  }, [modelsLoaded, settings.cameraMinConfidence, settings.registeredFaces, settings.registeredObjects])

  // ─── Single Embedding Extractor (For Registration) ───────────────────────
  const captureReferenceDescriptors = useCallback(async (videoEl) => {
    if (!modelsLoaded || !videoEl) return null

    try {
      const faceapi = window.faceapi
      const mobilenet = mobilenetModelRef.current

      // 1. Try to extract face biometric vector (128-D)
      const faceDet = await faceapi
        .detectSingleFace(videoEl, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.6 }))
        .withFaceLandmarks()
        .withFaceDescriptor()

      let faceDescriptor = null
      if (faceDet) {
        faceDescriptor = Array.from(faceDet.descriptor)
      }

      // 2. Extract scene/object feature vector (1024-D)
      let objectDescriptor = null
      if (mobilenet) {
        const inferTensor = mobilenet.infer(videoEl, true)
        objectDescriptor = Array.from(await inferTensor.data())
        inferTensor.dispose()
      }

      return {
        faceDescriptor,
        objectDescriptor
      }
    } catch (err) {
      console.error('[CameraVisionContext] Failed to extract custom embeddings:', err)
      return null
    }
  }, [modelsLoaded])

  // ─── Process Uploaded Photo (For Local or Mobile QR uploads) ──────────────
  const processUploadedPhoto = useCallback(async (imageElement) => {
    if (!modelsLoaded || !imageElement) return null

    try {
      const faceapi = window.faceapi
      const faceDet = await faceapi
        .detectSingleFace(imageElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptor()

      return faceDet || null
    } catch (err) {
      console.error('[CameraVisionContext] Failed to process uploaded photo:', err)
      return null
    }
  }, [modelsLoaded])

  // ─── Compile Live Context String ──────────────────────────────────────────
  const compileLiveSummary = useCallback((data) => {
    if (!data) return ''

    const parts = []

    // 1. Summarize people and emotions
    if (data.people && data.people.length > 0) {
      const peopleStr = data.people.map(p => {
        const emotionalTag = p.expression !== 'neutral' ? `looking ${p.expression}` : 'looking calm'
        return p.name === 'Stranger' ? `an unregistered person (${emotionalTag})` : `${p.name} (${emotionalTag})`
      }).join(', ')
      parts.push(`People detected: ${peopleStr}.`)
    } else {
      parts.push(`No people are currently in the camera feed.`)
    }

    // 2. Summarize custom matched objects and locations
    const customMatches = data.matchedObjects || []
    const matchedScenes = customMatches.filter(i => i.type === 'scene')
    const matchedItems = customMatches.filter(i => i.type === 'object')

    if (matchedScenes.length > 0) {
      parts.push(`Johnny is currently in this specific registered location: ${matchedScenes[0].label}.`)
    } else if (data.scene && data.scene !== 'Unknown') {
      parts.push(`Johnny appears to be in this general environment: ${data.scene}.`)
    }

    // 3. Summarize physical items
    const itemLabels = []
    // Add specifically registered items first
    matchedItems.forEach(i => itemLabels.push(`Johnny's registered "${i.label}"`))
    // Append standard objects detected by COCO-SSD
    const detectedStandard = (data.objects || []).map(o => o.label)
    // Filter out items that are duplicates or overlapping
    detectedStandard.forEach(label => {
      if (!itemLabels.includes(label) && !itemLabels.some(x => x.includes(label))) {
        itemLabels.push(label)
      }
    })

    if (itemLabels.length > 0) {
      parts.push(`Objects in front of Johnny: ${itemLabels.join(', ')}.`)
    }

    return parts.join(' ')
  }, [])

  // ─── Background Pre-warming of ML Models ──────────────────────────────────
  // Only pre-warm when camera augmentation is explicitly enabled by the user.
  // contextualResponseEnabled alone does NOT trigger the heavy vision pipeline.
  useEffect(() => {
    if (settings.cameraAugmentationEnabled && !modelsLoaded && !loadingModels) {
      console.log('[CameraVisionContext] Pre-warming computer vision pipeline in background...')
      initMLModels().catch(err => {
        console.warn('[CameraVisionContext] Background pre-warm failed:', err)
      })
    }
  }, [settings.cameraAugmentationEnabled, modelsLoaded, loadingModels, initMLModels])

  // ─── Decoupled Camera Stream Lifecycle Management ──────────────────────
  useEffect(() => {
    // We want the camera to be active if:
    // 1. Camera Augmentation (background analysis) is enabled OR
    // 2. Camera Streaming (live video view in UI) is enabled.
    const needsCamera = settings.cameraAugmentationEnabled || settings.cameraStreamingEnabled

    if (needsCamera) {
      if (!cameraActive) {
        console.log('[CameraVisionContext] Bootstrapping camera due to enabled settings (Augmentation/Streaming)')
        // Enumerate devices on-demand before starting the camera
        const boot = async () => {
          if (!devicesEnumeratedRef.current) {
            await refreshVideoDevices()
            devicesEnumeratedRef.current = true
          }
          await startCamera()
        }
        boot().catch(err => {
          console.warn('[CameraVisionContext] Failed to auto-start camera:', err)
        })
      }
    } else {
      if (cameraActive) {
        console.log('[CameraVisionContext] Stopping camera as neither Augmentation nor Streaming is active')
        stopCamera()
      }
    }
  }, [settings.cameraAugmentationEnabled, settings.cameraStreamingEnabled, cameraActive, startCamera, stopCamera, refreshVideoDevices])

  // ─── Orchestrate Background Processing Loop ─────────────────────────────
  useEffect(() => {
    // Kill any existing loops
    if (loopIntervalRef.current) {
      clearInterval(loopIntervalRef.current)
      loopIntervalRef.current = null
    }

    const enabled = settings.cameraAugmentationEnabled ?? false
    if (!enabled || !modelsLoaded) {
      setLiveVisionSummary('')
      return
    }

    const isManual = settings.cameraIntervalMs === -1
    if (isManual) {
      console.log(`[CameraVisionContext] Background vision pipeline in MANUAL mode — auto loop inactive`)
      return
    }

    console.log(`[CameraVisionContext] Background vision pipeline active (interval: ${settings.cameraIntervalMs}ms)`)

    loopIntervalRef.current = setInterval(async () => {
      const vid = offscreenVideoRef.current
      if (vid && vid.readyState >= 2 && !vid.paused) {
        const data = await processFrame(vid)
        if (data) {
          setVisionData(data)
          const textSummary = compileLiveSummary(data)
          setLiveVisionSummary(textSummary)
          if (settings.contextualResponseEnabled && (settings.cameraUpdateSoundEnabled ?? true)) {
            playUpdateSound()
          }
        }
      }
    }, settings.cameraIntervalMs ?? 2000)

    return () => {
      if (loopIntervalRef.current) {
        clearInterval(loopIntervalRef.current)
        loopIntervalRef.current = null
      }
    }
  }, [
    settings.cameraAugmentationEnabled,
    settings.cameraIntervalMs,
    settings.contextualResponseEnabled,
    settings.cameraUpdateSoundEnabled,
    modelsLoaded,
    processFrame,
    compileLiveSummary
  ])

  // Tidy up stream and models on unmount
  useEffect(() => {
    return () => {
      stopCamera()
      if (loopIntervalRef.current) {
        clearInterval(loopIntervalRef.current)
      }
    }
  }, [stopCamera])

  // ─── Manual Detection Trigger ─────────────────────────────────────────────
  const triggerManualDetection = useCallback(async () => {
    if (!modelsLoaded) return null
    // Make sure camera is actively running
    if (!cameraActive) {
      await startCamera()
    }
    const vid = offscreenVideoRef.current
    if (vid) {
      // Wait a tiny bit for video to start receiving frames if newly opened
      if (vid.readyState < 2) {
        await new Promise(resolve => {
          const check = () => {
            if (vid.readyState >= 2) resolve()
            else setTimeout(check, 100)
          }
          check()
        })
      }
      if (vid.readyState >= 2) {
        const data = await processFrame(vid)
        if (data) {
          setVisionData(data)
          const textSummary = compileLiveSummary(data)
          setLiveVisionSummary(textSummary)
          return textSummary
        }
      }
    }
    return null
  }, [modelsLoaded, cameraActive, startCamera, processFrame, compileLiveSummary])

  // ─── Register new Face ────────────────────────────────────────────────────
  const registerFace = useCallback((name, descriptor) => {
    if (!name?.trim() || !descriptor) return false
    const existing = settings.registeredFaces || []
    const updated = [
      ...existing,
      {
        id: `face_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        name: name.trim(),
        descriptor,
        addedAt: Date.now(),
        addedByDevice: settings.deviceName || 'Local PC'
      }
    ]
    updateSetting('registeredFaces', updated)
    console.log(`[CameraVisionContext] Face registered successfully: ${name.trim()}`)
    return true
  }, [settings.registeredFaces, settings.deviceName, updateSetting])

  // ─── Delete Face ──────────────────────────────────────────────────────────
  const deleteFace = useCallback((id) => {
    const existing = settings.registeredFaces || []
    const updated = existing.filter(f => f.id !== id)
    const existingDeleted = settings.deletedFaceIds || []
    const updatedDeleted = [...existingDeleted.filter(d => d.id !== id), { id, deletedAt: Date.now() }]
    
    updateSettings({
      registeredFaces: updated,
      deletedFaceIds: updatedDeleted
    })
    console.log(`[CameraVisionContext] Face profile removed: ${id}`)
  }, [settings.registeredFaces, settings.deletedFaceIds, updateSettings])

  // ─── Register new Custom Object or Scene ──────────────────────────────────
  const registerObjectOrScene = useCallback((label, descriptor, type) => {
    if (!label?.trim() || !descriptor || !type) return false
    const existing = settings.registeredObjects || []
    const updated = [
      ...existing,
      {
        id: `obj_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        label: label.trim(),
        descriptor,
        addedAt: Date.now(),
        type // 'object' | 'scene'
      }
    ]
    updateSetting('registeredObjects', updated)
    console.log(`[CameraVisionContext] Custom vector registered successfully: ${label.trim()} (${type})`)
    return true
  }, [settings.registeredObjects, updateSetting])

  // ─── Delete Custom Object or Scene ────────────────────────────────────────
  const deleteObjectOrScene = useCallback((id) => {
    const existing = settings.registeredObjects || []
    const updated = existing.filter(o => o.id !== id)
    const existingDeleted = settings.deletedObjectIds || []
    const updatedDeleted = [...existingDeleted.filter(d => d.id !== id), { id, deletedAt: Date.now() }]
    
    updateSettings({
      registeredObjects: updated,
      deletedObjectIds: updatedDeleted
    })
    console.log(`[CameraVisionContext] Custom vector removed: ${id}`)
  }, [settings.registeredObjects, settings.deletedObjectIds, updateSettings])

  return (
    <CameraVisionContext.Provider
      value={{
        initMLModels,
        loadingModels,
        modelsLoaded,
        loadError,
        cameraActive,
        videoDevices,
        cameraStream,
        startCamera,
        stopCamera,
        processFrame,
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
      }}
    >
      {children}
    </CameraVisionContext.Provider>
  )
}

export function useCameraVision() {
  const ctx = useContext(CameraVisionContext)
  if (!ctx) throw new Error('useCameraVision must be used within CameraVisionProvider')
  return ctx
}
