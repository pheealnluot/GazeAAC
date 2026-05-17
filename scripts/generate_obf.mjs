/**
 * generate_obf.mjs
 *
 * One-shot script: converts lamp_84.json + lamp_pages.json into OBF-compliant
 * JSON files under public/vocabulary/obf/.
 *
 * Run with:  node scripts/generate_obf.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const lamp84    = JSON.parse(readFileSync(join(root, 'src/vocabulary/lamp_84.json'), 'utf-8'))
const lampPages = JSON.parse(readFileSync(join(root, 'src/vocabulary/lamp_pages.json'), 'utf-8'))

// NAV_VERB_PAGES — maps uppercased label → sub-page key
const NAV_VERB_PAGES = {
  'PLAY': 'play', 'LIKE': 'like', 'WORK': 'work', 'HAVE': 'have',
  'FEEL': 'feel', 'READ': 'read', 'WANT': 'want', 'COME': 'come',
  'DO':   'do',   'GO':   'go',   'GET':  'get',  'LOOK': 'look',
  'HEAR': 'hear', 'THINK':'think','LIVE': 'live', 'LOVE': 'love',
  'TALK': 'talk', 'SIT':  'sit',  'EAT':  'eat',  'FIND': 'find',
  'MAKE': 'make', 'NEED': 'need', 'DRINK':'drink','WATCH':'watch',
  'SLEEP':'sleep','COLOR':'color','TIME': 'time'
}

// Stage 2 active cell IDs
const STAGE_2_ACTIVE = [
  'r1c1','r1c5','r1c6','r1c8',
  'r2c1','r3c1','r4c1','r5c2','r6c1',
  'r2c5','r4c10','r4c12','r5c12',
  'r5c3','r5c8','r7c5','r7c9',
  'r5c10','r7c1'
]

const COLS = 12
const ROWS = 7

const outDir = join(root, 'public/vocabulary/obf')
mkdirSync(outDir, { recursive: true })

// ── Category → background color mapping (LAMP colour conventions) ─────────────
const CAT_COLORS = {
  'pronoun':      'rgb(255,255,153)',  // yellow
  'verb':         'rgb(153,204,255)',  // blue
  'social':       'rgb(255,178,102)',  // orange
  'descriptor':   'rgb(178,255,178)', // green
  'spatial':      'rgb(204,153,255)', // purple
  'interrogative':'rgb(255,200,150)', // peach
  'determiner':   'rgb(220,220,220)', // light gray
  'utility':      'rgb(150,150,150)', // gray
  'noun':         'rgb(255,220,150)', // warm yellow
  'conjugation':  'rgb(180,230,255)', // light blue
  'action-man':   'rgb(153,204,255)', // blue (same as verb)
  'empty':        'rgb(255,255,255)'  // white
}

// ── Helper: build OBF button object ──────────────────────────────────────────
function makeButton({ id, label, icon, category, navPage = null, action = null, loadBoardId = null }) {
  const btn = {
    id,
    label: label || '',
    vocalization: label || '',
    background_color: CAT_COLORS[category] ?? 'rgb(255,255,255)',
    border_color: 'rgb(68,68,68)',
    ext_gazeaac_category: category,
  }
  if (icon)         btn.ext_gazeaac_icon = icon
  if (navPage)      btn.ext_gazeaac_nav_page = navPage
  if (action)       btn.ext_gazeaac_action = action
  if (loadBoardId)  btn.load_board = { id: loadBoardId }

  // Symbol (emoji stored as custom symbol set)
  if (icon) {
    btn.image_id = `img-${id}`
  }
  return btn
}

// ── Helper: build OBF image object (emoji-as-symbol) ─────────────────────────
function makeImage(btnId, emoji) {
  return {
    id: `img-${btnId}`,
    symbol: { set: 'emoji', filename: emoji }
  }
}

// ── Build home board (lamp_home.obf) ─────────────────────────────────────────
function buildHomeBoard() {
  const buttons = []
  const images  = []
  // 2D order array (null = empty cell)
  const order   = Array.from({ length: ROWS }, () => Array(COLS).fill(null))

  for (let row = 1; row <= ROWS; row++) {
    for (let col = 1; col <= COLS; col++) {
      const cellId = `r${row}c${col}`
      const entry  = lamp84[cellId]
      if (!entry || !entry.label) continue

      const label     = entry.label
      const icon      = entry.icon  ?? null
      const category  = entry.category ?? 'empty'
      const navPage   = NAV_VERB_PAGES[label.toUpperCase()] ?? null
      const isUtility = category === 'utility'
      const btnId     = `btn-home-${cellId}`

      const btn = makeButton({
        id: btnId,
        label,
        icon,
        category,
        navPage,
        action:      isUtility && label === 'CLEAR' ? 'clear' : null,
        loadBoardId: navPage ? `lamp-${navPage}` : null
      })
      buttons.push(btn)
      if (icon) images.push(makeImage(btnId, icon))
      order[row - 1][col - 1] = btnId
    }
  }

  return {
    format: 'open-board-0.1',
    id: 'lamp-home',
    locale: 'en',
    name: 'LAMP WFL — Home',
    description_html: '<p>LAMP Words For Life 84-cell home board (12×7).</p>',
    ext_gazeaac_stage_2_cells: STAGE_2_ACTIVE.map(id => `btn-home-${id}`),
    ext_gazeaac_stage_1_default: ['r5c3','r4c10','r4c12','r7c1'].map(id => `btn-home-${id}`),
    grid: { rows: ROWS, columns: COLS, order },
    buttons,
    images,
    sounds: []
  }
}

// ── Build a sub-page board ────────────────────────────────────────────────────
function buildSubPageBoard(pageKey) {
  const pageData = lampPages[pageKey]
  if (!pageData) { console.warn(`No page data for key: ${pageKey}`); return null }

  const meta     = { label: pageData._label ?? pageKey, icon: pageData._icon ?? '' }
  const buttons  = []
  const images   = []
  const order    = Array.from({ length: ROWS }, () => Array(COLS).fill(null))

  for (let row = 1; row <= ROWS; row++) {
    for (let col = 1; col <= COLS; col++) {
      const cellId = `r${row}c${col}`
      const entry  = pageData[cellId]
      if (!entry || !entry.label) continue

      const label    = entry.label
      const icon     = entry.icon     ?? null
      const category = entry.category ?? 'noun'
      const btnId    = `btn-${pageKey}-${cellId}`

      // HOME button on sub-page → navigate back to lamp-home
      const isHome  = category === 'utility' && label.toUpperCase() === 'HOME'
      const isClear = category === 'utility' && label.toUpperCase() === 'CLEAR'

      const btn = makeButton({
        id: btnId,
        label,
        icon,
        category,
        action:      isClear ? 'clear' : null,
        loadBoardId: isHome  ? 'lamp-home' : null
      })
      buttons.push(btn)
      if (icon) images.push(makeImage(btnId, icon))
      order[row - 1][col - 1] = btnId
    }
  }

  return {
    format: 'open-board-0.1',
    id: `lamp-${pageKey}`,
    locale: 'en',
    name: `LAMP WFL — ${meta.label}`,
    description_html: `<p>LAMP Words For Life sub-page for '${meta.label}'. Auto-returns to home after word selection.</p>`,
    ext_gazeaac_auto_return_home: true,
    grid: { rows: ROWS, columns: COLS, order },
    buttons,
    images,
    sounds: []
  }
}

// ── Write files ───────────────────────────────────────────────────────────────
const homeBoard = buildHomeBoard()
writeFileSync(join(outDir, 'lamp_home.obf'), JSON.stringify(homeBoard, null, 2))
console.log('✓ lamp_home.obf  — buttons:', homeBoard.buttons.length)

const subPageKeys = Object.keys(lampPages).filter(k => !k.startsWith('_'))
const manifest = {
  format: 'open-board-0.1',
  root: 'lamp_home.obf',
  paths: { boards: {}, images: {}, sounds: {} }
}

for (const key of subPageKeys) {
  const board = buildSubPageBoard(key)
  if (!board) continue
  const filename = `lamp_${key}.obf`
  writeFileSync(join(outDir, filename), JSON.stringify(board, null, 2))
  manifest.paths.boards[`lamp-${key}`] = filename
  console.log(`✓ ${filename}  — buttons: ${board.buttons.length}`)
}

manifest.paths.boards['lamp-home'] = 'lamp_home.obf'
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log('✓ manifest.json')
console.log('\nAll OBF files generated successfully.')
