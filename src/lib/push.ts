// Web Push subscription for the Parent Unit.
import { supabase, vapidPublicKey } from './supabase';
import { unwrap } from './retry';
import { log } from './log';

export type PushSupport = 'supported' | 'needs-install' | 'unsupported' | 'not-configured';

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

export function pushSupport(): PushSupport {
  if (!vapidPublicKey) return 'not-configured';
  if (isIOS() && !isStandalone()) return 'needs-install'; // iOS only allows Web Push for Home Screen apps
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return 'supported';
}

function keyBytes(b64url: string) {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null;
  // getRegistration() resolves immediately (unlike .ready, which waits forever if the SW failed).
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Must be called from a tap (iOS requires a user gesture for the permission prompt). */
export async function enablePush(soundAlerts: boolean): Promise<NotificationPermission> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey!) });
  await saveSubscription(sub, soundAlerts);
  log.info('push', 'subscribed', new URL(sub.endpoint).host);
  return permission;
}

export async function saveSubscription(sub: PushSubscription, soundAlerts: boolean) {
  const j = sub.toJSON();
  unwrap(await supabase.rpc('save_push_subscription', {
    p_endpoint: j.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth, p_sound_alerts: soundAlerts,
  }));
}

export async function setSoundAlerts(enabled: boolean) {
  unwrap(await supabase.rpc('set_sound_alerts', { p_enabled: enabled }));
}

export async function mySubscriptionRow(): Promise<{ endpoint: string; sound_alerts: boolean } | null> {
  const rows = unwrap(await supabase.from('push_subscriptions').select('endpoint, sound_alerts')) as { endpoint: string; sound_alerts: boolean }[];
  return rows[0] ?? null;
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
  }
}
