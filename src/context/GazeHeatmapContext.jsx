import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'

const GazeHeatmapContext = createContext(null)

export function GazeHeatmapProvider({ children }) {
  const [heatmapData, setHeatmapData] = useState({
    aac: [],
    movie: [],
    games: []
  })
  const [showOverlay, setShowOverlay] = useState(false)
  
  const lastRecordTimeRef = useRef(0)
  const pendingSaveRef = useRef(false)
  const heatmapDataRef = useRef(heatmapData)
  
  // Keep stable reference for debounced save
  useEffect(() => {
    heatmapDataRef.current = heatmapData
  }, [heatmapData])

  // Hydrate from electron-store or localStorage on mount
  useEffect(() => {
    const api = window.gazeAPI?.settings
    if (api) {
      api.getAll().then(stored => {
        if (stored && stored.gazeHeatmapData) {
          setHeatmapData(stored.gazeHeatmapData)
          console.log('[GazeHeatmapContext] Hydrated heatmap data from electron-store.')
        }
      }).catch(err => {
        console.warn('[GazeHeatmapContext] Failed to load heatmap data from store:', err)
      })
    } else {
      const stored = localStorage.getItem('gaze_heatmap_data')
      if (stored) {
        try {
          setHeatmapData(JSON.parse(stored))
          console.log('[GazeHeatmapContext] Hydrated heatmap data from localStorage.')
        } catch (e) {
          console.warn('[GazeHeatmapContext] Failed to parse heatmap data from localStorage')
        }
      }
    }
  }, [])

  // Periodically persist heatmap data to disk (every 10 seconds if dirty)
  useEffect(() => {
    const saveInterval = setInterval(() => {
      if (!pendingSaveRef.current) return
      pendingSaveRef.current = false

      const api = window.gazeAPI?.settings
      const dataToSave = heatmapDataRef.current
      if (api) {
        api.set('gazeHeatmapData', dataToSave).catch(err => {
          console.warn('[GazeHeatmapContext] Failed to persist heatmap data:', err)
        })
      } else {
        localStorage.setItem('gaze_heatmap_data', JSON.stringify(dataToSave))
      }
    }, 10000)

    return () => clearInterval(saveInterval)
  }, [])

  // Record a throttled gaze point
  const recordPoint = useCallback((mode, x, y) => {
    if (!mode || typeof x !== 'number' || typeof y !== 'number') return
    // Ignore invalid values outside [0, 1]
    if (x < 0 || x > 1 || y < 0 || y > 1) return

    const now = Date.now()
    // Throttle to 150ms interval (~6.7 Hz) to prevent flooding
    if (now - lastRecordTimeRef.current < 150) return
    lastRecordTimeRef.current = now

    setHeatmapData(prev => {
      const currentList = prev[mode] || []
      // Limit to 3000 points per mode to balance visualization detail and memory footprint
      const updatedList = [...currentList, { x, y, ts: now }].slice(-3000)
      
      const nextData = {
        ...prev,
        [mode]: updatedList
      }
      
      pendingSaveRef.current = true
      return nextData
    })
  }, [])

  // Clear heatmap data for a specific mode
  const clearHeatmap = useCallback((mode) => {
    if (!mode) return
    setHeatmapData(prev => {
      const nextData = {
        ...prev,
        [mode]: []
      }
      pendingSaveRef.current = true
      return nextData
    })
  }, [])

  // Clear all heatmaps
  const clearAllHeatmaps = useCallback(() => {
    setHeatmapData({
      aac: [],
      movie: [],
      games: []
    })
    pendingSaveRef.current = true
  }, [])

  // Toggle full-screen heatmap overlay
  const toggleHeatmapOverlay = useCallback(() => {
    setShowOverlay(prev => !prev)
  }, [])

  // Quadrant attention and blind spot analysis
  const analyzeBlindSpots = useCallback((mode) => {
    const points = heatmapData[mode] || []
    if (points.length < 50) {
      return {
        hasData: false,
        totalPoints: points.length,
        quadrants: { tl: 0, tr: 0, bl: 0, br: 0 },
        blindSpots: [],
        recommendations: 'Awaiting more eye-gaze data. Keep using this section to build a personalized blind spot profile.'
      }
    }

    let tl = 0, tr = 0, bl = 0, br = 0
    points.forEach(p => {
      if (p.x < 0.5) {
        if (p.y < 0.5) tl++
        else bl++
      } else {
        if (p.y < 0.5) tr++
        else br++
      }
    })

    const total = points.length
    const tlPct = Math.round((tl / total) * 100)
    const trPct = Math.round((tr / total) * 100)
    const blPct = Math.round((bl / total) * 100)
    const brPct = Math.round((br / total) * 100)

    const quadrants = { tl: tlPct, tr: trPct, bl: blPct, br: brPct }
    const blindSpots = []
    
    // Flag any quadrant with less than 8% attention as a potential blind spot
    if (tlPct < 8) blindSpots.push('Top-Left')
    if (trPct < 8) blindSpots.push('Top-Right')
    if (blPct < 8) blindSpots.push('Bottom-Left')
    if (brPct < 8) blindSpots.push('Bottom-Right')

    let recommendations = 'Johnny displays a well-balanced visual search pattern. No significant blind spots are detected.'
    if (blindSpots.length > 0) {
      const spots = blindSpots.join(' and ')
      recommendations = `Johnny looks very infrequently at the ${spots} section of the screen. `
      if (mode === 'aac') {
        recommendations += 'Consider shifting critical communication buttons (such as Yes/No or clear requests) into higher-attention areas (like the center or opposite side). Place decorative elements or secondary choices in these lower-attention zones.'
      } else if (mode === 'movie') {
        recommendations += 'Ensure the display is directly centered in front of Johnny, aligned at eye level, and verify that there are no bright lights or distracting movements on that side of the room.'
      } else {
        recommendations += 'Try calibrating the eye tracker again, or slightly turn Johnny’s seat so his visual field centers more naturally on that area.'
      }
    }

    return {
      hasData: true,
      totalPoints: total,
      quadrants,
      blindSpots,
      recommendations
    }
  }, [heatmapData])

  return (
    <GazeHeatmapContext.Provider
      value={{
        heatmapData,
        showOverlay,
        setShowOverlay,
        recordPoint,
        clearHeatmap,
        clearAllHeatmaps,
        toggleHeatmapOverlay,
        analyzeBlindSpots
      }}
    >
      {children}
    </GazeHeatmapContext.Provider>
  )
}

export function useGazeHeatmap() {
  const ctx = useContext(GazeHeatmapContext)
  if (!ctx) throw new Error('useGazeHeatmap must be used within GazeHeatmapProvider')
  return ctx
}
