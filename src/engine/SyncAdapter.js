/**
 * SyncAdapter — Milestone 5 Scaffold
 *
 * Offline-first sync interface. The local electron-store is ALWAYS the source
 * of truth; sync operations are best-effort and fire in the background.
 *
 * To integrate Firebase (or any other backend):
 *   1. Create a class that extends SyncAdapter.
 *   2. Override pushSettings(), pullSettings(), pushSessionLog().
 *   3. Pass an instance to SyncAdapter.setAdapter(instance) at app startup.
 *
 * Example (Firebase):
 *   import { FirebaseSyncAdapter } from './FirebaseSyncAdapter'
 *   SyncAdapter.setAdapter(new FirebaseSyncAdapter({ projectId: '...', apiKey: '...' }))
 *
 * The rest of the app code calls SyncAdapter.getInstance().push*() — it will
 * use the registered adapter, or the no-op stub if none is set.
 */
export class SyncAdapter {
  /** @private */
  static _instance = null

  /**
   * Register the active sync adapter.
   * @param {SyncAdapter} adapter
   */
  static setAdapter(adapter) {
    SyncAdapter._instance = adapter
    console.log(`[SyncAdapter] Adapter registered: ${adapter.constructor.name}`)
  }

  /**
   * Get the currently registered adapter (or the no-op stub).
   * @returns {SyncAdapter}
   */
  static getInstance() {
    return SyncAdapter._instance ?? new SyncAdapter()
  }

  // ── Interface methods (override in subclasses) ─────────────────────────────

  /**
   * Push the settings object to the remote backend.
   * @param {Record<string, unknown>} settings
   * @param {string} [deviceId]
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async pushSettings(settings, deviceId) {
    // No-op stub — implement in a subclass
  }

  /**
   * Pull settings from the remote backend and merge with local store.
   * Return null if no remote record exists or sync is unavailable.
   * @param {string} [deviceId]
   * @returns {Promise<Record<string, unknown>|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async pullSettings(deviceId) {
    return null
  }

  /**
   * Push the session log array to the remote backend.
   * @param {object[]} log
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async pushSessionLog(log) {
    // No-op stub — implement in a subclass
  }

  /**
   * Pull all session records from the remote backend.
   * Return null if unavailable.
   * @returns {Promise<object[]|null>}
   */
  async pullSessionLog() {
    return null
  }

  /**
   * Fetch all registered/synced devices from the remote backend.
   * @param {string} [currentDeviceId]
   * @returns {Promise<Array<Record<string, any>>>}
   */
  // eslint-disable-next-line no-unused-vars
  async getAvailableDevices(currentDeviceId) {
    return []
  }
}
