const CACHE = 'chegouai-v47';
const PRECACHE = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,300&display=swap',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => {
        clients.forEach((client) => {
          if (client.url.includes('/app')) client.navigate(client.url);
        });
      })
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Rotas de API: sempre rede (sem cache)
  if (url.pathname.startsWith('/api/')) return;

  // HTML do app: rede primeiro para garantir versão mais recente
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Recursos estáticos (ícones, fontes): cache-first
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((resp) => {
        if (resp.ok && (url.origin === self.location.origin || url.hostname.includes('googleapis'))) {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => null);
    })
  );
});

// =============================================
// PUSH NOTIFICATIONS
// =============================================
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { titulo: 'Chegou Aí', corpo: e.data ? e.data.text() : '' }; }

  const dados = data.dados || {};
  const tag = dados.pedidoId ? 'pedido-' + dados.pedidoId : 'chegouai-' + Date.now();

  e.waitUntil(
    // Avisar clientes em foreground para tocar beep (navegador suprime a notificação do sistema quando app está aberto)
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      cs.forEach((c) => c.postMessage({ type: 'PUSH_BEEP', dados }));
    }).then(() =>
      self.registration.showNotification(data.titulo || 'Chegou Aí', {
        body: data.corpo || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: dados,
        tag,
        renotify: true,
        requireInteraction: true,
        vibrate: [300, 100, 300, 100, 300],
        silent: false,
      })
    )
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const dados = e.notification.data || {};
  const url = dados.pedidoId ? '/app?pedido=' + dados.pedidoId : '/app';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      // Se já tem janela aberta, focar e navegar
      for (var i = 0; i < cs.length; i++) {
        if (cs[i].url.includes(self.location.origin)) {
          cs[i].focus();
          cs[i].postMessage({ type: 'NOTIF_CLICK', pedidoId: dados.pedidoId });
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
