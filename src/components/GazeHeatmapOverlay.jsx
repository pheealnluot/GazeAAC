import { useEffect, useRef } from 'react'
import { useGazeHeatmap } from '../context/GazeHeatmapContext'
import './GazeHeatmapOverlay.css'

export function GazeHeatmapOverlay({ active, mode }) {
  const { heatmapData, setShowOverlay, clearHeatmap } = useGazeHeatmap()
  const canvasRef = useRef(null)

  const points = heatmapData[mode] || []

  useEffect(() => {
    if (!active || !canvasRef.current) return

    const canvas = canvasRef.current
    
    const renderHeatmap = () => {
      if (!canvas) return
      
      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      
      if (points.length === 0) return

      // Smooth radius of gaze points
      const radius = 50

      // Step 1: Draw blurred radial gradient circles to accumulate intensity in grayscale
      ctx.globalCompositeOperation = 'screen'

      points.forEach(p => {
        const px = p.x * canvas.width
        const py = p.y * canvas.height

        const grad = ctx.createRadialGradient(px, py, 0, px, py, radius)
        // Low opacity gradient so multiple overlapping circles accumulate color density
        grad.addColorStop(0, 'rgba(0, 0, 0, 0.22)')
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)')

        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(px, py, radius, 0, Math.PI * 2)
        ctx.fill()
      })

      // Step 2: Colorize using a custom linear gradient color ramp
      try {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const data = imgData.data

        // Draw color ramp to a temporary canvas to extract RGB values
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = 256
        tempCanvas.height = 1
        const tempCtx = tempCanvas.getContext('2d')
        const gradient = tempCtx.createLinearGradient(0, 0, 256, 0)
        
        // Classic heatmap color ramp: Transparent -> Blue -> Cyan -> Green -> Yellow -> Red
        gradient.addColorStop(0.0, 'rgba(0, 0, 255, 0)')
        gradient.addColorStop(0.2, 'rgba(0, 0, 255, 0.45)')
        gradient.addColorStop(0.45, 'rgba(0, 255, 255, 0.65)')
        gradient.addColorStop(0.68, 'rgba(0, 255, 0, 0.8)')
        gradient.addColorStop(0.88, 'rgba(255, 255, 0, 0.9)')
        gradient.addColorStop(1.0, 'rgba(255, 0, 0, 0.95)')
        
        tempCtx.fillStyle = gradient
        tempCtx.fillRect(0, 0, 256, 1)
        const rampData = tempCtx.getImageData(0, 0, 256, 1).data

        // Map accumulated alpha intensity to the colored ramp
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3]
          if (alpha > 0) {
            const rampIndex = alpha * 4
            data[i]     = rampData[rampIndex]     // Red
            data[i + 1] = rampData[rampIndex + 1] // Green
            data[i + 2] = rampData[rampIndex + 2] // Blue
            data[i + 3] = rampData[rampIndex + 3] // Alpha
          }
        }

        ctx.globalCompositeOperation = 'source-over'
        ctx.putImageData(imgData, 0, 0)
      } catch (e) {
        console.error('[GazeHeatmapOverlay] Error colorizing canvas:', e)
      }
    }

    const resizeCanvas = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
      renderHeatmap()
    }

    resizeCanvas()
    window.addEventListener('resize', resizeCanvas)

    return () => {
      window.removeEventListener('resize', resizeCanvas)
    }
  }, [active, points])

  if (!active) return null

  const modeLabels = {
    aac: 'AAC Board',
    movie: 'Movie Time',
    games: 'Games'
  }

  return (
    <div className="gho-backdrop">
      <canvas ref={canvasRef} className="gho-canvas" />
      
      {/* Floating HUD Control Box */}
      <div className="gho-hud" role="dialog" aria-label="Heatmap controls">
        <div className="gho-hud__header">
          <span className="gho-hud__logo">🔥 Gaze Heatmap</span>
          <span className="gho-hud__badge">{modeLabels[mode] || mode}</span>
        </div>
        
        <p className="gho-hud__text">
          Showing <strong>{points.length}</strong> gaze points. Highlighted zones show where Johnny focused most attention. Dark areas suggest potential blind spots.
        </p>

        <div className="gho-hud__actions">
          <button 
            className="gho-hud__btn gho-hud__btn--clear" 
            onClick={() => clearHeatmap(mode)}
            title={`Clear recorded gaze data for ${modeLabels[mode] || mode}`}
          >
            🗑️ Clear Data
          </button>
          <button 
            className="gho-hud__btn gho-hud__btn--close" 
            onClick={() => setShowOverlay(false)}
            title="Close heatmap overlay (Ctrl+Shift+H)"
          >
            ✕ Close
          </button>
        </div>
        
        <div className="gho-hud__footer">Shortcut: Press Ctrl+Shift+H to close</div>
      </div>
    </div>
  )
}
