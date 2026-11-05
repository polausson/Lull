// Small in-memory log (last 300 entries) viewable from Settings → Diagnostics.
export type Level = 'info' | 'warn' | 'error';
export interface LogEntry { t: number; level: Level; area: string; msg: string; data?: string }

const entries: LogEntry[] = [];
let snapshot: LogEntry[] = [];
const listeners = new Set<() => void>();

function add(level: Level, area: string, msg: string, data?: unknown) {
  const e: LogEntry = { t: Date.now(), level, area, msg };
  if (data !== undefined) { try { e.data = typeof data === 'string' ? data : JSON.stringify(data); } catch { e.data = String(data); } }
  entries.push(e);
  if (entries.length > 300) entries.shift();
  snapshot = entries.slice();
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(`[${area}] ${msg}`, data ?? '');
  listeners.forEach((l) => l());
}

export const log = {
  info: (area: string, msg: string, data?: unknown) => add('info', area, msg, data),
  warn: (area: string, msg: string, data?: unknown) => add('warn', area, msg, data),
  error: (area: string, msg: string, data?: unknown) => add('error', area, msg, data),
  /** Stable snapshot (safe for useSyncExternalStore). */
  entries: () => snapshot,
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  asText: () => entries.map((e) => `${new Date(e.t).toISOString()} ${e.level.toUpperCase()} [${e.area}] ${e.msg}${e.data ? ' ' + e.data : ''}`).join('\n'),
};

window.addEventListener('error', (e) => log.error('app', e.message));
window.addEventListener('unhandledrejection', (e) => log.error('app', 'unhandled rejection', String(e.reason)));
