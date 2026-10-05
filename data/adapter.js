/**
 * Data layer abstraction for デイリー任務 DEMO
 * ------------------------------------------------
 * Now: LocalStorageAdapter (device-local)
 * Later: SyncAdapter (Supabase / Firebase) implementing the same interface
 *
 * Interface (async-capable):
 *   load()            -> Promise<object|null>
 *   save(state)       -> Promise<void>
 *   getMeta(key)      -> Promise<string|null>
 *   setMeta(key, val) -> Promise<void>
 *   subscribe(cb)     -> unsubscribe()   // remote changes; local no-ops
 *   getStatus()       -> { mode, online, syncedAt, userId }
 */
(function (global) {
  'use strict';

  const STATE_KEY = 'daily-tasks-demo-v1';
  const META_PREFIX = 'daily-tasks-demo-meta:';

  class LocalStorageAdapter {
    constructor() {
      this.mode = 'local';
      this._listeners = [];
    }

    async load() {
      try {
        const raw = localStorage.getItem(STATE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.warn('[DataLayer] load failed', e);
        return null;
      }
    }

    async save(state) {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
      this._listeners.forEach((cb) => {
        try { cb({ type: 'local-save' }); } catch (_) {}
      });
    }

    async getMeta(key) {
      return localStorage.getItem(META_PREFIX + key);
    }

    async setMeta(key, val) {
      if (val == null) localStorage.removeItem(META_PREFIX + key);
      else localStorage.setItem(META_PREFIX + key, String(val));
    }

    /** No remote events in local mode */
    subscribe(cb) {
      this._listeners.push(cb);
      return () => {
        this._listeners = this._listeners.filter((x) => x !== cb);
      };
    }

    getStatus() {
      return {
        mode: 'local',
        online: typeof navigator !== 'undefined' ? navigator.onLine : true,
        syncedAt: null,
        userId: null,
        note: '端末内 localStorage のみ。同期アダプタ未接続。'
      };
    }

    /** Hook for future: request persistent storage (helps against iOS eviction a bit) */
    async requestPersist() {
      try {
        if (navigator.storage && navigator.storage.persist) {
          return await navigator.storage.persist();
        }
      } catch (_) {}
      return false;
    }
  }

  /**
   * Stub for future Supabase/Firebase sync.
   * Do not instantiate in production until backend is configured.
   */
  class SyncAdapterStub {
    constructor(config) {
      this.mode = 'sync-stub';
      this.config = config || {};
      this._local = new LocalStorageAdapter();
    }

    async load() {
      // TODO: fetch remote profile state, merge with local
      return this._local.load();
    }

    async save(state) {
      // TODO: upsert to remote, then mirror local
      return this._local.save(state);
    }

    async getMeta(key) { return this._local.getMeta(key); }
    async setMeta(key, val) { return this._local.setMeta(key, val); }

    subscribe(cb) {
      // TODO: channel.on('postgres_changes' | firestore onSnapshot)
      return this._local.subscribe(cb);
    }

    getStatus() {
      return {
        mode: 'sync-stub',
        online: navigator.onLine,
        syncedAt: null,
        userId: null,
        note: '同期アダプタはプレースホルダです。PLAN.md のフェーズ2以降で有効化。'
      };
    }

    async requestPersist() { return this._local.requestPersist(); }
  }

  // Active adapter — swap to SyncAdapterStub/real when backend is ready
  const adapter = new LocalStorageAdapter();

  global.DataLayer = {
    adapter,
    LocalStorageAdapter,
    SyncAdapterStub,
    STATE_KEY,
    /** Convenience */
    async load() { return adapter.load(); },
    async save(state) { return adapter.save(state); },
    getStatus() { return adapter.getStatus(); },
    async requestPersist() { return adapter.requestPersist(); }
  };
})(typeof window !== 'undefined' ? window : self);
