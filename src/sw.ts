/// <reference lib="webworker" />
// Service worker: offline app shell + push notifications.
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<string | { url: string; revision: string | null }> };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

interface PushData { title: string; body: string; url: string; tag: string; kind: string; eventId?: string }

self.addEventListener('push', (event) => {
  let data: PushData;
  try { data = event.data!.json() as PushData; }
  catch { data = { title: 'Lull', body: 'Open Lull to see what happened.', url: '/', tag: 'lull', kind: 'unknown' }; }
  // iOS revokes push permission if a push doesn't show a notification, so always show one.
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag,
    icon: new URL('icon-192.png', self.registration.scope).href,
    badge: new URL('badge-72.png', self.registration.scope).href,
    data: { url: new URL(data.url.replace(/^\//, ''), self.registration.scope).href, eventId: data.eventId },
    requireInteraction: data.kind === 'lost',
    renotify: true,
  } as NotificationOptions));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url = self.registration.scope, eventId } = (event.notification.data ?? {}) as { url?: string; eventId?: string };
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find((c) => c.url.startsWith(self.registration.scope));
    if (client) {
      await client.focus();
      client.postMessage({ type: 'open-event', eventId });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
