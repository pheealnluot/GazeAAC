import { doc, setDoc, getDoc, collection, getDocs, writeBatch } from 'firebase/firestore'
import { db, auth } from './firebase'
import { SyncAdapter } from './SyncAdapter'

const SHARED_SETTINGS_KEYS = [
  'contextualPromptPrefix',
  'contextualLifeLore',
  'contextualSystemPrompt',
  'geminiApiKey',
  'geminiModel',
  'contextualRouting',
  // OpenAI / ChatGPT service — added so the key is shared across all devices
  'openAiApiKey',
  'openAiModel',
  'cloudAiProviderOrder',          // Ordered fallback list: ['gemini', 'openai']
  'registeredFaces',
  'registeredObjects',
  'deletedFaceIds',
  'deletedPhotoIds',
  'deletedObjectIds',
  // AAC shared settings (cross-device)
  'caregiverPin',
  'showIcons',
  'speakOnWord',
  'autoReturnHome',
  'autoReturnFromSubPage',
  'customVocabIds',
  'selectedBorderColor',
  'unmaskedBoxSize',
  'fontScale',
  'symbolScale',
  'symbolOnTop',
  'gridFontColor',
  'gridOpacity',
  'dwellProgressStyle',
  'dwellProgressPosition',
  'dwellProgressOpacity',
  'aiSuggestions',                 // AI word prediction toggle
  // Contextual Response — shared across devices
  'contextualResponseEnabled',
  'contextualResponseModel',
  'contextualOllamaModel',
  'contextualOllamaVisionModel',
  'contextualResponseMinCount',
  'contextualResponseCount',
  'contextualResponseAction',
  'answerGateMs',                  // Answer reading gate delay
  // Movie Time — shared settings
  'movieTimeYoutubeKey',
  'movieTimeYoutubeKeys',
  'movieTimeSelectionCount',
  'movieTimeDuration',
  'movieTimeVideoQuality',
  'movieTimeSafeSearch',
  'movieTimeTopics',
  'movieTimeInterests',
  'movieTimeWhitelist',
  'movieTimeBlacklist',
  'movieTimeGamerLoophole',
  'movieTimePuzzleIntervalSec',
  'movieTimePuzzleIntervalMin',
  'movieTimePuzzleDifficulty',
  'movieTimePuzzleChoices',
  'movieTimePuzzleTypes',
  'movieTimeQuizEducationLevel',
  'movieTimeQuizSubject',
  'movieTimeQuizSubjectCustom',
  'movieTimeQuizQuestionGateMs',
  'movieTimeQuizAnswerGateMs',
  'movieTimeQuizSoundEffects',
  'movieTimeQuizVoiceOver',
  'movieTimeQuizVoiceOverChoices',
  'movieTimeQuizVoiceOverPauseMs',
  'movieTimeQuizAboutVideo',
  'movieTimePuzzleHintAfterWrong',
  'movieTimePuzzleQuestionsPerQuiz',
  'movieTimeMaxDailyMinutes',
  'movieTimeOnlyFromList',
  'movieTimeYoutubeUrls',
  'movieTimeAskedQuestions',
  'movieTimeSelectedYoutubeVideoIds',
  'movieTimePopularOrder',         // Sort search results by popularity
  'movieTimeLanguage',             // BCP-47 language tag for YouTube API
  'movieTimeShowGazeCursor',       // Show gaze cursor overlay in Movie Time
  'movieTimePauseOnGazeLost',      // Auto-pause when gaze is lost
  'movieTimeSelectionGateMs',      // Gate before video can be dwell-selected
  'movieTimeGazeAwayMs',           // Gaze-away threshold before auto-pause
]

export class FirebaseSyncAdapter extends SyncAdapter {
  constructor() {
    super()
    console.log('[FirebaseSyncAdapter] Registered and active')
  }

  /**
   * Helper to retrieve the current user's UID
   * @returns {string|null}
   */
  get userId() {
    return auth.currentUser?.uid ?? null
  }

  // ─── Settings sync ─────────────────────────────────────────────────────────

  /**
   * Push the settings object to the remote database.
   * Split into shared settings (/users/{uid}/settings/shared) and
   * device-specific settings (/users/{uid}/settings/device_{deviceId}).
   * @param {Record<string, unknown>} settings
   * @param {string} [deviceId]
   */
  async pushSettings(settings, deviceId) {
    const uid = this.userId
    if (!uid) return
    try {
      // Exclude unnecessary or local-only keys (like sessionLog or local status) if present
      const cleanSettings = { ...settings }
      delete cleanSettings.sessionLog
      delete cleanSettings.boardEdits
      delete cleanSettings.aiHistory
      delete cleanSettings.deviceId

      const sharedSettings = {}
      const deviceSettings = {}

      Object.entries(cleanSettings).forEach(([key, value]) => {
        if (SHARED_SETTINGS_KEYS.includes(key)) {
          sharedSettings[key] = value
        } else {
          deviceSettings[key] = value
        }
      })

      if (Object.keys(sharedSettings).length > 0) {
        await setDoc(doc(db, 'users', uid, 'settings', 'shared'), sharedSettings, { merge: true })
      }
      if (deviceId && Object.keys(deviceSettings).length > 0) {
        deviceSettings.lastActive = Date.now()
        await setDoc(doc(db, 'users', uid, 'settings', `device_${deviceId}`), deviceSettings, { merge: true })
      }

      console.log('[FirebaseSyncAdapter] Settings pushed successfully (split shared/device)')
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to push settings:', err.message)
    }
  }

  /**
   * Pull settings from the remote database and merge them.
   * Pulls both shared and device-specific settings and returns the merged object.
   * Automatically migrates legacy `/users/{uid}/settings/default` if needed.
   * @param {string} [deviceId]
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async pullSettings(deviceId) {
    const uid = this.userId
    if (!uid) return null
    try {
      const sharedRef = doc(db, 'users', uid, 'settings', 'shared')
      const deviceRef = deviceId ? doc(db, 'users', uid, 'settings', `device_${deviceId}`) : null

      const sharedSnap = await getDoc(sharedRef)
      const deviceSnap = deviceRef ? await getDoc(deviceRef) : null

      const remoteSettings = {}
      let hasData = false

      if (sharedSnap.exists()) {
        Object.assign(remoteSettings, sharedSnap.data())
        hasData = true
      }
      if (deviceSnap && deviceSnap.exists()) {
        const deviceData = deviceSnap.data()
        const filteredDeviceData = {}
        Object.entries(deviceData).forEach(([key, value]) => {
          if (!SHARED_SETTINGS_KEYS.includes(key)) {
            filteredDeviceData[key] = value
          }
        })
        Object.assign(remoteSettings, filteredDeviceData)
        hasData = true
      }

      // Backward compatibility and auto-migration
      const defaultRef = doc(db, 'users', uid, 'settings', 'default')
      const defaultSnap = await getDoc(defaultRef)
      if (defaultSnap.exists()) {
        const defaultData = defaultSnap.data()

        // 1. Migrate shared settings if they don't exist in firestore yet
        if (!sharedSnap.exists()) {
          const sharedData = {}
          SHARED_SETTINGS_KEYS.forEach(key => {
            if (defaultData[key] !== undefined) {
              sharedData[key] = defaultData[key]
            }
          })
          if (Object.keys(sharedData).length > 0) {
            await setDoc(sharedRef, sharedData, { merge: true })
            Object.assign(remoteSettings, sharedData)
            hasData = true
            console.log('[FirebaseSyncAdapter] Migrated legacy shared settings to shared document')
          }
        }

        // 2. Migrate device-specific settings if they don't exist in firestore yet
        if (deviceRef && (!deviceSnap || !deviceSnap.exists())) {
          const deviceData = {}
          Object.keys(defaultData).forEach(key => {
            if (!SHARED_SETTINGS_KEYS.includes(key)) {
              deviceData[key] = defaultData[key]
            }
          })
          if (Object.keys(deviceData).length > 0) {
            await setDoc(deviceRef, deviceData, { merge: true })
            Object.assign(remoteSettings, deviceData)
            hasData = true
            console.log(`[FirebaseSyncAdapter] Migrated legacy device settings to device_${deviceId} document`)
          }
        }
      }

      if (hasData) {
        console.log('[FirebaseSyncAdapter] Settings pulled and merged successfully')
        return remoteSettings
      }
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to pull settings:', err.message)
      throw err
    }
    return null
  }

  // ─── Sessions sync ─────────────────────────────────────────────────────────

  /**
   * Push the full session log to the remote database.
   * Saved individually under `/users/{uid}/sessions/{sessionId}` to avoid large document writes.
   * @param {object[]} log
   */
  async pushSessionLog(log) {
    const uid = this.userId
    if (!uid || !log || log.length === 0) return
    try {
      const batch = writeBatch(db)
      log.forEach(record => {
        // Use savedAt timestamp as unique ID, falling back to date string
        const id = record.savedAt ? String(record.savedAt) : record.date
        const ref = doc(db, 'users', uid, 'sessions', id)
        batch.set(ref, record, { merge: true })
      })
      await batch.commit()
      console.log('[FirebaseSyncAdapter] Session log pushed successfully')
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to push session log:', err.message)
    }
  }

  /**
   * Pull all session records from the remote database.
   * @returns {Promise<object[]|null>}
   */
  async pullSessionLog() {
    const uid = this.userId
    if (!uid) return null
    try {
      const colRef = collection(db, 'users', uid, 'sessions')
      const snap = await getDocs(colRef)
      const list = []
      snap.forEach(docSnap => {
        list.push(docSnap.data())
      })
      // Sort chronologically (oldest to newest) to match electron-store's append pattern
      list.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))
      console.log(`[FirebaseSyncAdapter] Pulled ${list.length} sessions`)
      return list
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to pull session log:', err.message)
    }
    return null
  }

  // ─── Additional sync helpers (User Profile & Board Edits) ──────────────────

  /**
   * Push the caregiver-customized user profile.
   * @param {object} profile
   */
  async pushUserProfile(profile) {
    const uid = this.userId
    if (!uid) return
    try {
      await setDoc(doc(db, 'users', uid, 'profile', 'default'), profile, { merge: true })
      console.log('[FirebaseSyncAdapter] User profile pushed successfully')
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to push user profile:', err.message)
    }
  }

  /**
   * Pull the remote user profile.
   * @returns {Promise<object|null>}
   */
  async pullUserProfile() {
    const uid = this.userId
    if (!uid) return null
    try {
      const snap = await getDoc(doc(db, 'users', uid, 'profile', 'default'))
      if (snap.exists()) {
        console.log('[FirebaseSyncAdapter] User profile pulled successfully')
        return snap.data()
      }
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to pull user profile:', err.message)
    }
    return null
  }

  /**
   * Push custom board edits.
   * @param {Record<string, unknown>} edits
   */
  async pushBoardEdits(edits) {
    const uid = this.userId
    if (!uid) return
    try {
      await setDoc(doc(db, 'users', uid, 'boardEdits', 'default'), edits)
      console.log('[FirebaseSyncAdapter] Board edits pushed successfully')
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to push board edits:', err.message)
    }
  }

  /**
   * Pull custom board edits.
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async pullBoardEdits() {
    const uid = this.userId
    if (!uid) return null
    try {
      const snap = await getDoc(doc(db, 'users', uid, 'boardEdits', 'default'))
      if (snap.exists()) {
        console.log('[FirebaseSyncAdapter] Board edits pulled successfully')
        return snap.data()
      }
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to pull board edits:', err.message)
    }
    return null
  }

  /**
   * Push AI history entries.
   * @param {object[]} history
   */
  async pushAIHistory(history) {
    const uid = this.userId
    if (!uid) return
    try {
      await setDoc(doc(db, 'users', uid, 'aiHistory', 'default'), { entries: history })
      console.log('[FirebaseSyncAdapter] AI history pushed successfully')
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to push AI history:', err.message)
    }
  }

  /**
   * Pull AI history entries.
   * @returns {Promise<object[]|null>}
   */
  async pullAIHistory() {
    const uid = this.userId
    if (!uid) return null
    try {
      const snap = await getDoc(doc(db, 'users', uid, 'aiHistory', 'default'))
      if (snap.exists()) {
        console.log('[FirebaseSyncAdapter] AI history pulled successfully')
        return snap.data().entries || []
      }
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to pull AI history:', err.message)
    }
    return null
  }

  /**
   * Fetch all registered/synced devices from Firestore settings collection.
   * @param {string} [currentDeviceId]
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async getAvailableDevices(currentDeviceId) {
    const uid = this.userId
    if (!uid) return []
    try {
      const colRef = collection(db, 'users', uid, 'settings')
      const snap = await getDocs(colRef)
      const list = []
      snap.forEach(docSnap => {
        const docId = docSnap.id
        if (docId.startsWith('device_')) {
          const devId = docId.slice(7)
          const data = docSnap.data()
          list.push({
            deviceId: devId,
            deviceName: data.deviceName || 'Unknown Device',
            deviceOS: data.deviceOS || 'Unknown OS',
            lastActive: data.lastActive || 0,
            isCurrent: devId === currentDeviceId,
            // Include usage details/patterns
            dwellMs: data.dwellMs,
            ttsEngine: data.ttsEngine,
            stage: data.stage,
            mouseHoverMode: data.mouseHoverMode
          })
        }
      })
      // Sort chronologically (newest active first)
      list.sort((a, b) => b.lastActive - a.lastActive)
      return list
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to fetch available devices:', err.message)
      return []
    }
  }
}
