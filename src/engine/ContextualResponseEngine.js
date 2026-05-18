/**
 * ContextualResponseEngine
 *
 * Generates 2–6 short AAC-style response suggestions from a context string.
 * The AI decides the exact number within the min–max range.
 *
 * Backend priority:
 *   1. Ollama REST (http://localhost:11434) — primary, zero-cloud
 *   2. Chrome / Electron window.ai (Gemini Nano) — automatic fallback
 *   3. Built-in default phrases — if both above are unavailable
 *
 * When an image frame (base64 JPEG) is provided, the engine automatically
 * switches to the configured Ollama vision model (e.g. "llava").
 *
 * Exports:
 *   generateContextualResponses(contextText, count, options) → Promise<{ responses, activeModel }>
 *   checkOllamaAvailable()                                   → Promise<{ available, models }>
 */

const FALLBACK_RESPONSES = [
  'Yes please',
  'No thank you',
  'I need help',
  'Tell me more',
  'Can you show me?',
  'I want to try',
]

// ─── Default user profile (Caden) ────────────────────────────────────────────
// This profile is baked into every AI system prompt so responses are always
// age-appropriate, culturally relevant, and personalised for Caden.
const DEFAULT_USER_PROFILE = {
  name:     'Caden Chye',
  age:      9,
  location: 'Singapore',
  family:   { father: 'James', mother: 'Venus' },
}

// ─── System prompt builder ────────────────────────────────────────────────────

/**
 * Build the system prompt embedding Caden's profile and the desired count range.
 * An optional Life Lore block (free-form background facts) is appended when provided.
 * @param {object} profile
 * @param {number} minCount
 * @param {number} maxCount
 * @param {string} lifeLore          – Raw background facts stored by the caregiver
 * @param {string} promptPrefix       – Caregiver rules prepended before everything
 * @param {string} customSystemPrompt – Full replacement for the built-in AAC body (empty = use default)
 * @returns {string}
 */
function _buildSystemPrompt(profile, minCount, maxCount, lifeLore, promptPrefix, customSystemPrompt) {
  const p = { ...DEFAULT_USER_PROFILE, ...profile }

  // Caregiver-defined rules go first so they override everything else
  let prompt = ''
  if (promptPrefix?.trim()) {
    prompt += `${promptPrefix.trim()}\n\n`
  }

  // Use fully custom system prompt body if provided; otherwise use the built-in default
  if (customSystemPrompt?.trim()) {
    prompt += customSystemPrompt.trim()
  } else {
    prompt +=
      `You are an AAC assistant generating responses on behalf of ${p.name}, ` +
      `a ${p.age}-year-old child who lives in ${p.location}. ` +
      `Father is ${p.family.father} and Mother is ${p.family.mother}. ` +
      `You will speak as the voice of ${p.name}.\n` +
      `Your job is to suggest between ${minCount} and ${maxCount} short, natural, age-appropriate ` +
      `communication phrases that ${p.name} might actually say.\n` +
      `Vary the responses: mix single words, short phrases, full sentences, questions, and expressions.\n` +
      `Return ONLY a valid JSON array of strings — no explanation, no markdown, no extra text.\n` +
      `Example: ["I want to play!", "Can we call Daddy?", "Not now, please"]\n` +
      `Prioritize the usefulness of the responses.\n` +
      `If the question presents choices, ensure the responses contain the choices to allow the user to select them. ` +
      `For example, if the question is for CHOICE A OR CHOICE B, the response should at least include ` +
      `1) CHOICE A, 2) CHOICE B, 3) BOTH, 4) NONE.`
  }

  if (lifeLore?.trim()) {
    prompt +=
      `\n\n--- About ${p.name} (Life Lore — background facts) ---\n` +
      lifeLore.trim() +
      `\n--- End of Life Lore ---`
  }

  return prompt
}

// ─── History block builder ────────────────────────────────────────────────────

/**
 * Format up to 5 recent Q&A pairs into a compact text block that primes the
 * model with what Caden has communicated before, so it learns his preferences.
 * @param {Array<{ context: string, responses: string[], chosen?: string }>} history
 * @returns {string}
 */
function _buildHistoryBlock(history) {
  if (!history?.length) return ''
  const recent = history.slice(-5) // only the 5 most recent interactions
  const lines = recent.map((h, i) => {
    const chosen = h.chosen ? ` [Caden chose: "${h.chosen}"]` : ''
    return `Past example ${i + 1}: Context was "${h.context}" → suggestions were [${h.responses.map(r => `"${r}"`).join(', ')}]${chosen}`
  })
  return (
    `Here are recent communication examples for context:\n` +
    lines.join('\n') +
    `\n\n`
  )
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @param {string}  contextText   – Context typed / spoken / described
 * @param {number}  maxCount      – Maximum suggestions to generate
 * @param {{
 *   minCount:      number,
 *   backend:       'ollama'|'window-ai',
 *   model:         string,
 *   visionModel:   string,
 *   imageDataUrl:  string|null     – base64 JPEG data: URL if camera was used
 *   userProfile:   object|null     – Override user profile fields (optional)
 *   recentHistory: Array<{ context: string, responses: string[], chosen?: string }>
 * }} options
 * @returns {Promise<{ responses: string[], activeModel: string }>}
 */
export async function generateContextualResponses(contextText, maxCount = 9, options = {}) {
  const {
    minCount      = 2,
    backend       = 'ollama',
    model         = 'llama3.2',
    visionModel   = 'llava',
    imageDataUrl  = null,
    userProfile   = null,
    recentHistory = [],
    promptPrefix       = '',   // caregiver-defined rules prepended to system prompt
    lifeLore           = '',   // background facts block appended to system prompt
    customSystemPrompt = '',   // fully custom system prompt body (overrides built-in default)
  } = options

  if (!contextText?.trim() && !imageDataUrl) {
    return { responses: FALLBACK_RESPONSES.slice(0, maxCount), activeModel: 'default' }
  }

  // ── 1. Try Ollama ─────────────────────────────────────────────────────────
  if (backend === 'ollama' || backend !== 'window-ai') {
    try {
      const result = await _generateOllama(
        contextText, minCount, maxCount, model, visionModel, imageDataUrl,
        userProfile, recentHistory, promptPrefix, lifeLore, customSystemPrompt
      )
      return result
    } catch (err) {
      console.warn('[ContextualResponseEngine] Ollama failed, trying Gemini Nano fallback:', err.message)
      // Fall through to Gemini Nano
    }
  }

  // ── 2. Try Gemini Nano (window.ai) ────────────────────────────────────────
  try {
    const result = await _generateWindowAI(contextText, minCount, maxCount, userProfile, recentHistory, promptPrefix, lifeLore, customSystemPrompt)
    return result
  } catch (err) {
    console.warn('[ContextualResponseEngine] Gemini Nano failed, using built-in fallback:', err.message)
  }

  // ── 3. Hard fallback ──────────────────────────────────────────────────────
  return { responses: FALLBACK_RESPONSES.slice(0, maxCount), activeModel: 'fallback' }
}

// ─── Ollama backend ────────────────────────────────────────────────────────────

async function _generateOllama(contextText, minCount, maxCount, model, visionModel, imageDataUrl, userProfile, recentHistory, promptPrefix, lifeLore, customSystemPrompt) {
  const useVision   = !!imageDataUrl
  const activeModel = useVision ? visionModel : model

  // promptPrefix and customSystemPrompt are both injected into the system prompt
  const systemPrompt = _buildSystemPrompt(userProfile ?? {}, minCount, maxCount, lifeLore ?? '', promptPrefix ?? '', customSystemPrompt ?? '')
  const historyBlock = _buildHistoryBlock(recentHistory)

  // Detect if the context contains a choice question (A or B, option 1 or 2, etc.)
  const hasChoices = /\b(or|either|choice|option)\b/i.test(contextText ?? '')
  const choiceReminder = hasChoices
    ? `\nIMPORTANT: The context presents choices. Your response array MUST include at least one phrase for each choice option presented, plus optionally "both" and "none" variants. Do NOT respond with only one side.`
    : ''

  const userPrompt = contextText?.trim()
    ? `${historyBlock}Current context: "${contextText}"\n\nGenerate between ${minCount} and ${maxCount} AAC responses as a JSON array (you decide the exact count).${choiceReminder} Return ONLY the JSON array:`
    : `${historyBlock}An image was shared. Generate between ${minCount} and ${maxCount} AAC responses relevant to what you see, as a JSON array (you decide the exact count). Return ONLY the JSON array:`

  // Build request body — Ollama vision API uses "images" array with raw base64
  const body = {
    model: activeModel,
    system: systemPrompt,
    prompt: userPrompt,
    stream: false,
    options: { temperature: 0.8, top_p: 0.9, num_predict: 300 },
  }

  if (useVision && imageDataUrl) {
    // Strip data URL prefix (data:image/jpeg;base64,...)
    const b64 = imageDataUrl.replace(/^data:[^;]+;base64,/, '')
    body.images = [b64]
  }

  // ── DEBUG: log the exact payload so we can verify what the AI receives ─────
  console.group('[ContextualResponseEngine] Ollama request payload')
  console.log('%cSYSTEM PROMPT:', 'color:#a78bfa;font-weight:bold')
  console.log(systemPrompt)
  console.log('%cUSER PROMPT:', 'color:#34d399;font-weight:bold')
  console.log(userPrompt)
  console.groupEnd()
  // ─────────────────────────────────────────────────────────────────────────

  // No timeout — if Ollama is unreachable the fetch fails immediately with a
  // network error; if the model is just slow/cold we let it finish naturally.
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`)

  const data      = await res.json()
  const responses = _parseResponseArray(data.response ?? '', minCount, maxCount)
  return { responses, activeModel: `ollama/${activeModel}` }
}

// ─── Chrome window.ai / Gemini Nano backend ───────────────────────────────────

async function _generateWindowAI(contextText, minCount, maxCount, userProfile, recentHistory, promptPrefix, lifeLore, customSystemPrompt) {
  const ai = window.ai
  if (!ai?.languageModel) throw new Error('window.ai.languageModel not available')

  // promptPrefix and customSystemPrompt are both injected into the system prompt
  const systemPrompt = _buildSystemPrompt(userProfile ?? {}, minCount, maxCount, lifeLore ?? '', promptPrefix ?? '', customSystemPrompt ?? '')
  const session      = await ai.languageModel.create({ systemPrompt })

  const historyBlock = _buildHistoryBlock(recentHistory)
  const hasChoices = /\b(or|either|choice|option)\b/i.test(contextText ?? '')
  const choiceReminder = hasChoices
    ? `\nIMPORTANT: The context presents choices. Your response array MUST include at least one phrase for each choice option presented, plus optionally "both" and "none" variants. Do NOT respond with only one side.`
    : ''
  const userPrompt   = `${historyBlock}Current context: "${contextText}"\n\nGenerate between ${minCount} and ${maxCount} AAC responses as a JSON array (you decide the exact count).${choiceReminder} Return ONLY the JSON array:`

  const raw = await session.prompt(userPrompt)
  session.destroy()

  const responses = _parseResponseArray(raw, minCount, maxCount)
  return { responses, activeModel: 'gemini-nano' }
}

// ─── Response parser ──────────────────────────────────────────────────────────

function _parseResponseArray(raw, minCount, maxCount) {
  const match = raw.match(/\[[\s\S]*?\]/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0])
      if (Array.isArray(parsed) && parsed.length >= minCount) {
        return parsed.slice(0, maxCount).map(s => String(s).trim()).filter(Boolean)
      }
    } catch { /* fall through */ }
  }

  // Fallback: extract numbered/bulleted lines
  const lines = raw.split('\n')
    .map(l => l.replace(/^[-•*\d.]+\s*/, '').replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)

  if (lines.length >= minCount) return lines.slice(0, maxCount)

  throw new Error('Could not parse model output')
}

// ─── Utility: check if Ollama is reachable ────────────────────────────────────

export async function checkOllamaAvailable() {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) return { available: false, models: [] }
    const data   = await res.json()
    const models = (data.models ?? []).map(m => m.name)
    return { available: true, models }
  } catch {
    return { available: false, models: [] }
  }
}
