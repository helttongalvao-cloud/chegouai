// =============================================
// SERVICE WORKER — Chegou Aí PWA
// =============================================
const CACHE_NAME = 'chegouai-v1';
const STATIC_CACHE = 'chegouai-static-v1';
const API_CACHE = 'chegouai-api-v1';

// Recursos estáticos para cache offline
const STATIC_ASSETS = [
  '/',
  '/chegou-ai.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,300&display=swap',
];

// =============================================
// INSTALL — pré-cachear assets estáticos
// =============================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// =============================================
// ACTIVATE — limpar caches antigos
// =============================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key !== STATIC_CACHE && key !== API_CACHE)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

// =============================================
// FETCH — estratégia por tipo de recurso
// =============================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Não interceptar rotas da API de pagamento (crítico, sempre online)
  if (url.pathname.startsWith('/api/payments')) {
    return;
  }

  // Rotas da API: Network First (dados sempre frescos, fallback cache)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  // Assets estáticos: Cache First (performance)
  if (
    request.destination === 'image' ||
    request.destination === 'font' ||
    request.destination === 'style' ||
    url.origin !== location.origin
  ) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // HTML e scripts: Stale While Revalidate
  event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
});

// =============================================
// ESTRATÉGIAS DE CACHE
// =============================================

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || offlineFallback();
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback();
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || fetchPromise || offlineFallback();
}

function offlineFallback() {
  return new Response(
    `<!DOCTYPE html>
    <html lang="pt-BR">
    <head><meta charset="UTF-8"><title>Chegou Aí — Offline</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{background:#0A0A0A;color:#F0F0F0;font-family:sans-serif;
           display:flex;flex-direction:column;align-items:center;
           justify-content:center;min-height:100vh;text-align:center;padding:24px;}
      .icon{font-size:64px;margin-bottom:16px;}
      h2{font-size:24px;margin-bottom:8px;}
      p{color:#999;font-size:14px;}
      button{margin-top:24px;background:#00C853;color:#000;border:none;
             border-radius:12px;padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer;}
    </style>
    </head>
    <body>
      <div class="icon">📡</div>
      <h2>Sem conexão</h2>
      <p>Verifique sua internet e tente novamente.</p>
      <button onclick="location.reload()">Tentar novamente</button>
    </body>
    </html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

// =============================================
// PUSH NOTIFICATIONS (futuro)
// =============================================
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Chegou Aí', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      tag: data.tag || 'chegouai',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || '/')
  );
});
