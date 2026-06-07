/**
 * ContextualResponseEngine
 *
 * Generates 2–6 short AAC-style response suggestions from a context string.
 * The AI decides the exact number within the min–max range.
 *
 * Backend priority (internet-first routing):
 *   1. Cloud AI — Gemini or ChatGPT, tried in cloudAiProviderOrder priority order
 *   2. Ollama REST (http://localhost:11434) — local primary
 *   3. Chrome / Electron window.ai (Gemini Nano) — automatic fallback
 *   4. Built-in default phrases — if all above are unavailable
 *
 * When an image frame (base64 JPEG) is provided, the engine automatically
 * switches to the configured Ollama vision model (e.g. "llava").
 * Note: OpenAI vision is not supported in this version; images fall back to Gemini.
 *
 * Exports:
 *   generateContextualResponses(contextText, count, options) → Promise<{ responses, activeModel }>
 *   checkOllamaAvailable()                                   → Promise<{ available, models }>
 */

const FALLBACK_RESPONSES = [
  "Yes",
  "No",
  "I don't know",
  "I want to try that",
  "I want to try"
]

// ─── Default user profile (Johnny) ────────────────────────────────────────────
// This profile is baked into every AI system prompt so responses are always
// age-appropriate, culturally relevant, and personalised for Johnny.
const DEFAULT_USER_PROFILE = {
  name: 'Johnny',
  age: 10,
  location: 'Singapore',
  family: { father: 'Bob', mother: 'Mary' },
}

// ─── System prompt builder ────────────────────────────────────────────────────

/**
 * Build the system prompt embedding Johnny's profile and the desired count range.
 * An optional Life Lore block (free-form background facts) is appended when provided.
 * @param {object} profile
 * @param {number} minCount
 * @param {number} maxCount
 * @param {string} lifeLore          – Raw background facts stored by the caregiver
 * @param {string} promptPrefix       – Caregiver rules prepended before everything
 * @param {string} customSystemPrompt – Full replacement for the built-in AAC body (empty = use default)
 * @returns {string}
 */
function _buildSystemPrompt(profile, minCount, maxCount, lifeLore, promptPrefix, customSystemPrompt, cameraAugmentationData) {
  const p = { ...DEFAULT_USER_PROFILE, ...profile }

  // Get current local date and time
  const now = new Date()
  const time12 = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) // e.g. "12:17 AM"
  const dayOfWeek = now.toLocaleDateString([], { weekday: 'long' }) // e.g. "Thursday"
  const dateFull = now.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) // e.g. "May 21, 2026"

  // Caregiver-defined rules go first so they override everything else
  let prompt = ''
  if (promptPrefix?.trim()) {
    prompt += `${promptPrefix.trim()}\n\n`
  }

  // Use fully custom system prompt body if provided; otherwise use the built-in default
  if (customSystemPrompt?.trim()) {
    let hydrated = customSystemPrompt.trim()
    hydrated = hydrated.replace(/\[User Name\]/g, p.name)
    hydrated = hydrated.replace(/\[Name\]/g, p.name)
    hydrated = hydrated.replace(/\[Age\]/g, String(p.age))
    hydrated = hydrated.replace(/\[Location\]/g, p.location)
    hydrated = hydrated.replace(/\[Father\]/g, p.family.father)
    hydrated = hydrated.replace(/\[Mother\]/g, p.family.mother)
    hydrated = hydrated.replace(/\[Min\]/g, String(minCount))
    hydrated = hydrated.replace(/\[Max\]/g, String(maxCount))
    hydrated = hydrated.replace(/\[Current Time\]/g, time12)
    hydrated = hydrated.replace(/\[Current Date\]/g, `${dayOfWeek}, ${dateFull}`)
    hydrated = hydrated.replace(/\[Current Day\]/g, dayOfWeek)
    prompt += hydrated
  } else {
    prompt +=
      `You are an AAC assistant generating responses on behalf of ${p.name}, a ${p.age}-year-old child who lives in ${p.location}. Father is ${p.family.father} and Mother is ${p.family.mother}. You will speak as the voice of ${p.name}. (User Name, Age, Location, and parents are filled from the User Profile above)\n` +
      `Your job is to suggest between ${minCount} and ${maxCount} short, natural, age-appropriate communication phrases that ${p.name} might actually say. This means that you are effectively a Multiple-Choice Question Reformatter. Whenever the user asks you a question, your task is NOT to answer it directly, but to rephrase the response into a list of plausible options that the user can choose from to answer their own question. \n` +
      `Return ONLY a valid JSON array of strings — no explanation, no markdown, no extra text.\n` +
      `For every question, you must provide a comprehensive set of choices that covers all bases. Follow these strict formatting rules:\n\n` +
      `1. **Direct Answers:** Include the most direct answers (e.g., "Yes" and "No" for binary questions, the listed choices for choice questions, or specific categories for open questions).\n` +
      `2. **The Uncertainty Buffer:** Always include options for when the responder doesn't know, is unsure, or needs more context (e.g., "Maybe", "I don't know", "It depends").\n` +
      `3. **The 'None of the Above' Buffer:** Always include an option for when the predefined choices don't fit (e.g., "Neither", "Other / Not applicable").\n` +
      `4. **Preference Diversity:** When generating options for open-ended questions about preferences, likes, dislikes, or opinions, do not limit all response options to the single preference stated in the Life Lore. Generate a diverse set of plausible alternatives (e.g., other common dislikes or likes) as distinct choices, while ensuring the preference from the Life Lore is included as one of the responses.\n` +
      `5. **Time-Sensitive Questions (Correct vs Plausible Times):** The current local time is ${dayOfWeek}, ${dateFull}, ${time12}. If the user is asked about the time or if the context asks 'what time is it?' (or similar time-sensitive/quiz questions), you MUST generate a realistic set of choices where:\n` +
      `   - One suggestion is the exact correct current time (e.g., "It is ${time12}" or "${time12}").\n` +
      `   - At least two other suggestions are plausible but incorrect times (e.g., 15-30 minutes earlier or later, or rounded to the next hour/half-hour, such as "12:30" or "11:45" if the correct time is 12:17 AM) to serve as decoy/plausible options for a quiz or choice question.\n` +
      `   - Include options for uncertainty or context (e.g., "I don't know the time", "Is it time to play?").\n\n` +
      `Example Input: "Are you sick?"\n` +
      `Example Output: \n` +
      `* Yes\n` +
      `* No\n` +
      `* Maybe / Not sure\n` +
      `* Neither \n\n` +
      `If the question presents choices, ensure the responses contain the choices to allow the user to select them. For example, if the question is for CHOICE A, B or C, the response should at least include 1) CHOICE A, 2) CHOICE B, 3) CHOICE C, 4) BOTH, 5) NONE.\n\n` +
      `When the question is not a strict yes/no or choice question, vary the responses: mix single words, short phrases, full sentences, questions, and expressions.`
  }

  // Append current environment time context so that the model always has access to the correct time
  prompt += `\n\n--- Current Environment Context ---\n` +
            `Current Local Time: ${dayOfWeek}, ${dateFull}, ${time12}\n` +
            `--- End of Environment Context ---`

  if (lifeLore?.trim()) {
    prompt +=
      `\n\n--- About ${p.name} (Life Lore — background facts) ---\n` +
      lifeLore.trim() +
      `\n--- End of Life Lore ---`
  }

  if (cameraAugmentationData?.trim()) {
    prompt +=
      `\n\n--- Live Physical Environment (Camera Vision) ---\n` +
      cameraAugmentationData.trim() +
      `\n--- End of Physical Environment ---\n\n` +
      `Instruction: You should pay attention to the Live Physical Environment context above (which tells you who is in front of Johnny, their expression, and what objects are around). Suggest phrases that Johnny might say in response to this environment (e.g., asking for a visible object, greeting the detected person, expressing a reaction to their emotion).`
  }

  return prompt
}

// ─── History block builder ────────────────────────────────────────────────────

/**
 * Format up to 5 recent Q&A pairs into a compact text block that primes the
 * model with what Johnny has communicated before, so it learns his preferences.
 * @param {Array<{ context: string, responses: string[], chosen?: string }>} history
 * @returns {string}
 */
function _buildHistoryBlock(history) {
  if (!history?.length) return ''
  const recent = history.slice(-5) // only the 5 most recent interactions
  const lines = recent.map((h, i) => {
    const chosen = h.chosen ? ` [Johnny chose: "${h.chosen}"]` : ''
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
 *   minCount:        number,
 *   backend:         'ollama'|'window-ai',
 *   model:           string,
 *   visionModel:     string,
 *   imageDataUrl:    string|null     – base64 JPEG data: URL if camera was used
 *   userProfile:     object|null     – Override user profile fields (optional)
 *   recentHistory:   Array<{ context: string, responses: string[], chosen?: string }>,
 *   routing:         'internet-first'|'local-only',
 *   cloudAiProviderOrder: string[],   // Ordered list: ['gemini','openai'] or reversed
 *   geminiApiKey:    string,
 *   geminiModel:     string,
 *   openAiApiKey:    string,
 *   openAiModel:     string
 * }} options
 * @returns {Promise<{ responses: string[], activeModel: string }>}
 */
export async function generateContextualResponses(contextText, maxCount = 9, options = {}) {
  const {
    minCount = 2,
    backend = 'ollama',
    model = 'llama3.2',
    visionModel = 'llava',
    imageDataUrl = null,
    userProfile = null,
    recentHistory = [],
    promptPrefix = '',   // caregiver-defined rules prepended to system prompt
    lifeLore = '',   // background facts block appended to system prompt
    customSystemPrompt = '',   // fully custom system prompt body (overrides built-in default)
    routing = 'local-only',
    cloudAiProviderOrder = ['gemini', 'openai'], // ordered list of providers to try
    geminiApiKey = '',
    geminiModel = 'gemini-2.5-flash',
    openAiApiKey = '',
    openAiModel = 'gpt-4o-mini',
    cameraAugmentationData = '', // Live physical environment aggregated context string
  } = options

  if (!contextText?.trim() && !imageDataUrl && !cameraAugmentationData?.trim()) {
    return { responses: FALLBACK_RESPONSES.slice(0, maxCount), activeModel: 'default' }
  }

  let fallbackReason = null

  // ── Primary strategy: try cloud AI providers in priority order ──
  if (routing === 'internet-first') {
    const providers = Array.isArray(cloudAiProviderOrder) && cloudAiProviderOrder.length > 0
      ? cloudAiProviderOrder
      : ['gemini', 'openai']
    for (const provider of providers) {
      const hasKey = provider === 'openai' ? !!openAiApiKey : !!geminiApiKey
      if (!hasKey) {
        console.log(`[ContextualResponseEngine] Skipping ${provider} — no API key configured`)
        continue
      }
      try {
        let result
        if (provider === 'openai') {
          result = await _generateOpenAICloud(
            contextText, minCount, maxCount, openAiModel, openAiApiKey,
            userProfile, recentHistory, promptPrefix, lifeLore, customSystemPrompt, cameraAugmentationData
          )
        } else {
          result = await _generateGeminiCloud(
            contextText, minCount, maxCount, geminiModel, geminiApiKey, imageDataUrl,
            userProfile, recentHistory, promptPrefix, lifeLore, customSystemPrompt, cameraAugmentationData
          )
        }
        return result
      } catch (err) {
        console.warn(`[ContextualResponseEngine] ${provider === 'openai' ? 'OpenAI' : 'Gemini'} Cloud failed, trying next provider:`, err.message)
        fallbackReason = err.message
        // Continue to the next provider in the ordered list
      }
    }
    // All cloud providers exhausted — fall through to local models
    console.warn('[ContextualResponseEngine] All cloud AI providers failed, falling back to local path')
  }

  // ── 1. Try Ollama ─────────────────────────────────────────────────────────
  if (backend === 'ollama' || backend !== 'window-ai') {
    try {
      const result = await _generateOllama(
        contextText, minCount, maxCount, model, visionModel, imageDataUrl,
        userProfile, recentHistory, promptPrefix, lifeLore, customSystemPrompt, cameraAugmentationData
      )
      return { ...result, fallbackReason }
    } catch (err) {
      console.warn('[ContextualResponseEngine] Ollama failed, trying Gemini Nano fallback:', err.message)
      // Fall through to Gemini Nano
    }
  }

  // ── 2. Try Gemini Nano (window.ai) ────────────────────────────────────────
  try {
    const result = await _generateWindowAI(contextText, minCount, maxCount, userProfile, recentHistory, promptPrefix, lifeLore, customSystemPrompt, cameraAugmentationData)
    return { ...result, fallbackReason }
  } catch (err) {
    console.warn('[ContextualResponseEngine] Gemini Nano failed, using built-in fallback:', err.message)
  }

  // ── 3. Hard fallback ──────────────────────────────────────────────────────
  return { responses: FALLBACK_RESPONSES.slice(0, maxCount), activeModel: 'fallback', fallbackReason }
}

// ─── OpenAI Cloud backend ─────────────────────────────────────────────────────

async function _generateOpenAICloud(contextText, minCount, maxCount, openAiModel, openAiApiKey, userProfile, recentHistory, promptPrefix, lifeLore, customSystemPrompt, cameraAugmentationData) {
  if (!openAiApiKey) {
    throw new Error('OpenAI API Key is empty or not configured')
  }

  const modelToUse = openAiModel || 'gpt-4o-mini'

  const systemPrompt = _buildSystemPrompt(userProfile ?? {}, minCount, maxCount, lifeLore ?? '', promptPrefix ?? '', customSystemPrompt ?? '', cameraAugmentationData ?? '')
  const historyBlock = _buildHistoryBlock(recentHistory)

  const hasChoices = /\b(or|either|choice|option)\b/i.test(contextText ?? '')
  const choiceReminder = hasChoices
    ? `\nIMPORTANT: The context presents choices. Your response array MUST include at least one phrase for each choice option presented, plus optionally "both" and "none" variants. Do NOT respond with only one side.`
    : ''

  const userPrompt = contextText?.trim()
    ? `${historyBlock}Current context: "${contextText}"\n\nGenerate between ${minCount} and ${maxCount} AAC responses as a JSON array (you decide the exact count).${choiceReminder} Return ONLY the JSON array:`
    : `${historyBlock}Analyze the Live Physical Environment context. Generate between ${minCount} and ${maxCount} AAC responses relevant to what is happening or who is present in the physical environment, as a JSON array (you decide the exact count). Return ONLY the JSON array:`

  const payload = {
    model: modelToUse,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.8,
    response_format: { type: 'json_object' },
  }

  console.group('[ContextualResponseEngine] OpenAI Cloud request payload')
  console.log('%cSYSTEM PROMPT:', 'color:#a78bfa;font-weight:bold')
  console.log(systemPrompt)
  console.log('%cUSER PROMPT:', 'color:#34d399;font-weight:bold')
  console.log(userPrompt)
  console.groupEnd()

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify(payload)
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`OpenAI Cloud HTTP ${res.status}: ${errText}`)
  }

  const data = await res.json()
  const rawText = data.choices?.[0]?.message?.content || ''
  const responses = _parseResponseArray(rawText, minCount, maxCount)
  return { responses, activeModel: `openai/${modelToUse}` }
}

// ─── Gemini Cloud backend ───────────────────────────────────────────────────────

async function _generateGeminiCloud(contextText, minCount, maxCount, geminiModel, geminiApiKey, imageDataUrl, userProfile, recentHistory, promptPrefix, lifeLore, customSystemPrompt, cameraAugmentationData) {
  if (!geminiApiKey) {
    throw new Error('Gemini API Key is empty or not configured')
  }

  const modelToUse = geminiModel || 'gemini-2.5-flash'
  const useVision = !!imageDataUrl

  const systemPrompt = _buildSystemPrompt(userProfile ?? {}, minCount, maxCount, lifeLore ?? '', promptPrefix ?? '', customSystemPrompt ?? '', cameraAugmentationData ?? '')
  const historyBlock = _buildHistoryBlock(recentHistory)

  const hasChoices = /\b(or|either|choice|option)\b/i.test(contextText ?? '')
  const choiceReminder = hasChoices
    ? `\nIMPORTANT: The context presents choices. Your response array MUST include at least one phrase for each choice option presented, plus optionally "both" and "none" variants. Do NOT respond with only one side.`
    : ''

  const userPrompt = contextText?.trim()
    ? `${historyBlock}Current context: "${contextText}"\n\nGenerate between ${minCount} and ${maxCount} AAC responses as a JSON array (you decide the exact count).${choiceReminder} Return ONLY the JSON array:`
    : useVision
      ? `${historyBlock}An image was shared. Generate between ${minCount} and ${maxCount} AAC responses relevant to what you see, as a JSON array (you decide the exact count). Return ONLY the JSON array:`
      : `${historyBlock}Analyze the Live Physical Environment context. Generate between ${minCount} and ${maxCount} AAC responses relevant to what is happening or who is present in the physical environment, as a JSON array (you decide the exact count). Return ONLY the JSON array:`

  const parts = []
  if (useVision && imageDataUrl) {
    const b64 = imageDataUrl.replace(/^data:[^;]+;base64,/, '')
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: b64
      }
    })
  }
  parts.push({ text: userPrompt })

  const payload = {
    contents: [
      {
        role: 'user',
        parts: parts
      }
    ],
    systemInstruction: {
      parts: [
        { text: systemPrompt }
      ]
    },
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.8
    }
  }

  console.group('[ContextualResponseEngine] Gemini Cloud request payload')
  console.log('%cSYSTEM PROMPT:', 'color:#a78bfa;font-weight:bold')
  console.log(systemPrompt)
  console.log('%cUSER PROMPT:', 'color:#34d399;font-weight:bold')
  console.log(userPrompt)
  console.groupEnd()

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${geminiApiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Gemini Cloud HTTP ${res.status}: ${errText}`)
  }

  const data = await res.json()
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const responses = _parseResponseArray(rawText, minCount, maxCount)
  return { responses, activeModel: `gemini-cloud/${modelToUse}` }
}

// ─── Ollama backend ────────────────────────────────────────────────────────────

async function _generateOllama(contextText, minCount, maxCount, model, visionModel, imageDataUrl, userProfile, recentHistory, promptPrefix, lifeLore, customSystemPrompt, cameraAugmentationData) {
  const useVision = !!imageDataUrl
  const activeModel = useVision ? visionModel : model

  // promptPrefix and customSystemPrompt are both injected into the system prompt
  const systemPrompt = _buildSystemPrompt(userProfile ?? {}, minCount, maxCount, lifeLore ?? '', promptPrefix ?? '', customSystemPrompt ?? '', cameraAugmentationData ?? '')
  const historyBlock = _buildHistoryBlock(recentHistory)

  // Detect if the context contains a choice question (A or B, option 1 or 2, etc.)
  const hasChoices = /\b(or|either|choice|option)\b/i.test(contextText ?? '')
  const choiceReminder = hasChoices
    ? `\nIMPORTANT: The context presents choices. Your response array MUST include at least one phrase for each choice option presented, plus optionally "both" and "none" variants. Do NOT respond with only one side.`
    : ''

  const userPrompt = contextText?.trim()
    ? `${historyBlock}Current context: "${contextText}"\n\nGenerate between ${minCount} and ${maxCount} AAC responses as a JSON array (you decide the exact count).${choiceReminder} Return ONLY the JSON array:`
    : useVision
      ? `${historyBlock}An image was shared. Generate between ${minCount} and ${maxCount} AAC responses relevant to what you see, as a JSON array (you decide the exact count). Return ONLY the JSON array:`
      : `${historyBlock}Analyze the Live Physical Environment context. Generate between ${minCount} and ${maxCount} AAC responses relevant to what is happening or who is present in the physical environment, as a JSON array (you decide the exact count). Return ONLY the JSON array:`

  const body = {
    model: activeModel,
    system: systemPrompt,
    prompt: userPrompt,
    stream: false,
    options: {
      temperature: 0.8,
      top_p: 0.9,
      num_predict: 300,
      seed: Math.floor(Math.random() * 1000000),
    },
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

  const data = await res.json()
  const responses = _parseResponseArray(data.response ?? '', minCount, maxCount)
  return { responses, activeModel: `ollama/${activeModel}` }
}

// ─── Chrome window.ai / Gemini Nano backend ───────────────────────────────────

async function _generateWindowAI(contextText, minCount, maxCount, userProfile, recentHistory, promptPrefix, lifeLore, customSystemPrompt, cameraAugmentationData) {
  const ai = window.ai
  if (!ai?.languageModel) throw new Error('window.ai.languageModel not available')

  // promptPrefix and customSystemPrompt are both injected into the system prompt
  const systemPrompt = _buildSystemPrompt(userProfile ?? {}, minCount, maxCount, lifeLore ?? '', promptPrefix ?? '', customSystemPrompt ?? '', cameraAugmentationData ?? '')
  const session = await ai.languageModel.create({ systemPrompt })

  const historyBlock = _buildHistoryBlock(recentHistory)
  const hasChoices = /\b(or|either|choice|option)\b/i.test(contextText ?? '')
  const choiceReminder = hasChoices
    ? `\nIMPORTANT: The context presents choices. Your response array MUST include at least one phrase for each choice option presented, plus optionally "both" and "none" variants. Do NOT respond with only one side.`
    : ''
  const userPrompt = contextText?.trim()
    ? `${historyBlock}Current context: "${contextText}"\n\nGenerate between ${minCount} and ${maxCount} AAC responses as a JSON array (you decide the exact count).${choiceReminder} Return ONLY the JSON array:`
    : `${historyBlock}Analyze the Live Physical Environment context. Generate between ${minCount} and ${maxCount} AAC responses relevant to what is happening or who is present in the physical environment, as a JSON array (you decide the exact count). Return ONLY the JSON array:`

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
    const data = await res.json()
    const models = (data.models ?? []).map(m => m.name)
    return { available: true, models }
  } catch {
    return { available: false, models: [] }
  }
}
