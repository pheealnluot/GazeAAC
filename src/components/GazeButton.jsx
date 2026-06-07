import { useRef, useEffect, useState } from 'react'
import './GazeButton.css'

/**
 * GazeButton – A single interactive cell in the LAMP vocabulary grid.
 *
 * Renders the word label and icon, and drives the dwell-progress ring
 * animation via a CSS custom property `--dwell-progress` (0 → 1).
 *
 * The visual label is always anchored to the cell's native (baseCol, baseRow)
 * position regardless of how large the hit-box expands, per the
 * Geometric Anchor Rule in VOCABULARY_ENGINE.md §2.1.
 *
 * Props:
 *   cellId       {string}        – Unique cell identifier ("r1c1")
 *   label        {string}        – Display word (e.g. "WANT")
 *   icon         {string|null}   – Optional icon character or URL
 *   active       {boolean}       – Whether this cell is unmasked
 *   category     {string}        – Column-block category (affects accent color)
 *   spanCols     {number}        – CSS grid column span (1 = native width)
 *   spanRows     {number}        – CSS grid row span (1 = native height)
 *   dwellProgress{number}        – Dwell ring fill [0, 1] from DwellTimer
 *   isGazed      {boolean}       – True when gaze is currently over this cell
 *   onActivate   {(cellId) => void} – Called when dwell threshold is reached
 *   // OBF visual parameters (all optional)
 *   backgroundColor {string|null}  – OBF background_color
 *   borderColor     {string|null}  – OBF border_color
 *   textColor       {string|null}  – OBF text_color
 *   capitalisation  {'as-is'|'upper'|'lower'|'title'|null}
 *   imageUrl        {string|null}  – blob: or data: URL for raster image
 *   soundUrl        {string|null}  – blob: URL for audio on activation
 */
export function GazeButton({
  cellId,
  label,
  icon = null,
  active = false,
  category = 'empty',
  spanCols = 1,
  spanRows = 1,
  dwellProgress = 0,
  isGazed = false,
  onActivate,
  // Visual anchor: where within the expanded button the LABEL/CONTENT appear.
  // Expressed as percentages (0-100) from the button's left/top edge.
  // Defaults to dead-centre (50%, 50%) which is correct for 1x1 native cells.
  // The dwell ring is ALWAYS centered on the button itself (50/50).
  contentAnchorX = 50,
  contentAnchorY = 50,
  // M4: whether to render the emoji icon above the label
  showIcons = true,
  // OBF visual parameters
  backgroundColor = null,
  borderColor = null,
  textColor = null,
  capitalisation = null,
  imageUrl = null,
  soundUrl = null,
  // Navigation / display settings
  loadBoardId = null,      // non-null → shows link indicator badge
  symbolScale = 1.0,       // scale factor for image/icon (independent of font)
  symbolOnTop = false,     // when true, symbol appears above the text label
  // Dwell ring transparency (0–1)
  dwellRingOpacity = 1.0,
}) {
  const [justActivated, setJustActivated] = useState(false)
  const activatedTimerRef = useRef(null)
  const audioRef = useRef(null)

  // Pre-load audio when soundUrl changes
  useEffect(() => {
    if (!soundUrl) { audioRef.current = null; return }
    audioRef.current = new Audio(soundUrl)
    audioRef.current.preload = 'auto'
  }, [soundUrl])

  // Flash animation on activation
  useEffect(() => {
    if (dwellProgress >= 1 && !justActivated) {
      setJustActivated(true)
      activatedTimerRef.current = setTimeout(() => setJustActivated(false), 600)
    }
    return () => clearTimeout(activatedTimerRef.current)
  }, [dwellProgress, justActivated])

  if (!active) {
    // Masked cell: render an invisible placeholder that still occupies grid space
    return (
      <div
        className="gaze-button gaze-button--masked"
        style={{
          gridColumn: `span ${spanCols}`,
          gridRow: `span ${spanRows}`
        }}
        aria-hidden="true"
      />
    )
  }

  const ringCircumference = 2 * Math.PI * 40 // r=40 on a 100x100 viewBox
  const dashOffset = ringCircumference * (1 - dwellProgress)

  // ── Inline styles for dwell ring & label ────────────────────────────────
  // The ring is ALWAYS centered on the visible button area (50%, 50%),
  // sized relative to the smaller of the button's two dimensions.
  // The content (label/icon) uses contentAnchorX/Y to stay over the native
  // cell center when the hit-box is expanded via HitBoxSolver.
  const ringSize = 80  // percentage of the button's smaller dimension

  const ringStyle = {
    position: 'absolute',
    width:    `${ringSize}%`,
    height:   `${ringSize}%`,
    left:     '50%',
    top:      '50%',
    transform: 'translate(-50%, -50%)',
    aspectRatio: '1 / 1',
    // NOTE: opacity is NOT set here — it is handled by CSS rules so that
    // the ring is invisible when not gazed and fades in on gaze:
    //   .gaze-button__ring            { opacity: 0 }
    //   .gaze-button--gazed ring       { opacity: var(--dwell-ring-opacity, 1) }
    // The CSS variable is already on the button via buttonStyle.
  }

  const contentStyle = {
    position: 'absolute',
    left:     `${contentAnchorX}%`,
    top:      `${contentAnchorY}%`,
    transform: 'translate(-50%, -50%)'
  }

  // ── Capitalisation transform ──────────────────────────────────────────────
  const displayLabel = _applyCapitalisation(label, capitalisation)

  // ── OBF-driven inline button styles ──────────────────────────────────────
  const buttonStyle = {
    gridColumn: `span ${spanCols}`,
    gridRow:    `span ${spanRows}`,
    '--dwell-progress': dwellProgress,
    // Expose the resolved background as a CSS variable so the link badge
    // can produce a darkened version via color-mix() without any JS math.
    '--cell-bg': backgroundColor ?? null,
    '--dwell-ring-opacity': dwellRingOpacity,
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(borderColor     ? { borderColor, borderWidth: '2px', borderStyle: 'solid' } : {}),
  }

  // ── Activation handler: play sound + call parent ──────────────────────────
  const handleActivate = () => {
    if (soundUrl && audioRef.current) {
      audioRef.current.currentTime = 0
      audioRef.current.play().catch(() => {/* ignore autoplay policy errors */})
    }
    onActivate?.(cellId)
  }

  return (
    <button
      className={[
        'gaze-button',
        `gaze-button--${category}`,
        isGazed       ? 'gaze-button--gazed'     : '',
        justActivated ? 'gaze-button--activated'  : '',
        imageUrl      ? 'gaze-button--has-image'  : '',
        loadBoardId   ? 'gaze-button--has-link'   : '',
      ].join(' ').trim()}
      style={buttonStyle}
      data-cell-id={cellId}
      aria-label={displayLabel}
      onClick={handleActivate}
    >
      {/* Dwell progress ring (SVG overlay) — anchored to native cell center */}
      <svg
        className="gaze-button__ring"
        viewBox="0 0 100 100"
        aria-hidden="true"
        style={ringStyle}
      >
        {/* Track */}
        <circle
          className="gaze-button__ring-track"
          cx="50" cy="50" r="40"
          fill="none"
          strokeWidth="4"
        />
        {/* Progress arc */}
        <circle
          className="gaze-button__ring-arc"
          cx="50" cy="50" r="40"
          fill="none"
          strokeWidth="4"
          strokeDasharray={ringCircumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform="rotate(-90 50 50)"
        />
      </svg>

      {/* Anchor point: label always centered on native cell regardless of span */}
      <span className="gaze-button__content" style={contentStyle}>
        {symbolOnTop ? (
          // Symbol ABOVE label
          <>
            {/* Raster/SVG image from OBF (takes priority over emoji icon) */}
            {imageUrl && (
              <img
                className="gaze-button__image"
                src={imageUrl}
                alt=""
                aria-hidden="true"
              />
            )}
            {/* Emoji icon (only shown if no raster image) */}
            {showIcons && icon && !imageUrl && (
              <span
                className="gaze-button__icon"
                aria-hidden="true"
              >{icon}</span>
            )}
            <span
              className="gaze-button__label"
              style={{ color: textColor != null ? textColor : 'var(--grid-font-color, #ffffff)' }}
            >
              {displayLabel}
            </span>
          </>
        ) : (
          // Text ABOVE symbol (default)
          <>
            <span
              className="gaze-button__label"
              style={{ color: textColor != null ? textColor : 'var(--grid-font-color, #ffffff)' }}
            >
              {displayLabel}
            </span>
            {/* Raster/SVG image from OBF (takes priority over emoji icon) */}
            {imageUrl && (
              <img
                className="gaze-button__image"
                src={imageUrl}
                alt=""
                aria-hidden="true"
              />
            )}
            {/* Emoji icon (only shown if no raster image) */}
            {showIcons && icon && !imageUrl && (
              <span
                className="gaze-button__icon"
                aria-hidden="true"
              >{icon}</span>
            )}
          </>
        )}
      </span>

      {/* Quarter-circle link indicator — top-right corner, shown when button navigates to a sub-board */}
      {loadBoardId && (
        <span className="gaze-button__link-badge" aria-hidden="true" title="Links to sub-page" />
      )}
    </button>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _applyCapitalisation(label, mode) {
  if (!label) return label
  switch (mode) {
    case 'upper': return label.toUpperCase()
    case 'lower': return label.toLowerCase()
    case 'title': return label.replace(/\b\w/g, c => c.toUpperCase())
    default:      return label  // 'as-is' or null
  }
}
