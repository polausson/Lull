export const timeOf = (iso: string | Date) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function ago(seconds: number | null | undefined): string {
  if (seconds == null) return 'never';
  if (seconds < 15) return 'just now';
  if (seconds < 60) return `${Math.round(seconds)} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

export const secondsSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 1000;

export function duration(ms: number | null | undefined) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** 0…1 intensity from how far a sound rose above the room's floor. */
export const intensity = (aboveFloorDb: number | null) => Math.max(0, Math.min(1, ((aboveFloorDb ?? 0) - 6) / 30));

export function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Phone';
}
