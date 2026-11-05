// Where the Baby Unit sends its data. `remoteBackend` talks to Supabase (two-phone setup);
// `localBackend` keeps everything in this phone's IndexedDB (one-phone trial, no server).
import * as api from './api';
import type { SoundEvent } from './api';

export interface BabyBackend {
  heartbeat(monitoring: boolean, audioOk: boolean, detail: string | null): Promise<void>;
  createEvent(peakDb: number, aboveFloorDb: number): Promise<string>;
  notify(eventId: string): Promise<unknown>;
  saveClip(eventId: string, wav: Uint8Array<ArrayBuffer>, meta: { durationMs: number; peakDb: number; aboveFloorDb: number }): Promise<void>;
  markFailed(eventId: string): Promise<void>;
}

export function remoteBackend(householdId: string): BabyBackend {
  return {
    heartbeat: api.heartbeat,
    createEvent: (p, a) => api.insertSoundEvent(householdId, p, a),
    notify: api.notifySound,
    saveClip: (id, wav, meta) => api.uploadClip(householdId, id, wav, meta),
    markFailed: api.markEventFailed,
  };
}

// ---- local (IndexedDB) ------------------------------------------------------

const DB_NAME = 'lull-local';
const RETENTION_MS = 24 * 3600_000;
type LocalEvent = SoundEvent & { wav?: Blob };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('events', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('events', mode);
    const req = fn(t.objectStore('events'));
    t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export const localStore = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  async list(): Promise<LocalEvent[]> {
    const all = ((await tx('readonly', (s) => s.getAll())) ?? []) as LocalEvent[];
    const cutoff = Date.now() - RETENTION_MS;
    const expired = all.filter((e) => new Date(e.created_at).getTime() < cutoff);
    if (expired.length) await tx('readwrite', (s) => { expired.forEach((e) => s.delete(e.id)); });
    return all.filter((e) => !expired.includes(e)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  async get(id: string) { return (await tx('readonly', (s) => s.get(id))) as LocalEvent | undefined; },
  async remove(id: string) { await tx('readwrite', (s) => { s.delete(id); }); changed(); },
  async clear() { await tx('readwrite', (s) => { s.clear(); }); changed(); },
};

async function update(id: string, patch: Partial<LocalEvent>) {
  const e = await localStore.get(id);
  if (!e) return;
  await tx('readwrite', (s) => { s.put({ ...e, ...patch }); });
  changed();
}

export const localBackend: BabyBackend = {
  heartbeat: async () => undefined,
  async createEvent(peakDb, aboveFloorDb) {
    const id = crypto.randomUUID();
    const e: LocalEvent = { id, household_id: 'local', created_at: new Date().toISOString(), peak_db: peakDb, above_floor_db: aboveFloorDb, duration_ms: null, storage_path: null, status: 'recording' };
    await tx('readwrite', (s) => { s.put(e); });
    changed();
    return id;
  },
  notify: async () => ({ skipped: 'one-phone mode' }),
  async saveClip(id, wav, meta) {
    await update(id, { status: 'ready', wav: new Blob([wav], { type: 'audio/wav' }), storage_path: 'local', duration_ms: meta.durationMs, peak_db: meta.peakDb, above_floor_db: meta.aboveFloorDb });
  },
  async markFailed(id) { await update(id, { status: 'failed' }); },
};
