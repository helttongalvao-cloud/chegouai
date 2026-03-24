const express = require('express');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');

const router = express.Router();

// ============================================================
// VAPID helpers — implementação com crypto nativo Node.js 18+
// ============================================================

// Converte base64url para Buffer
function fromBase64url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Cria chave privada EC P-256 a partir dos bytes VAPID
function criarChavePrivadaVapid() {
  const pubRaw = fromBase64url(process.env.VAPID_PUBLIC_KEY); // 65 bytes: 04 || x || y
  const x = pubRaw.slice(1, 33).toString('base64url');
  const y = pubRaw.slice(33, 65).toString('base64url');

  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: process.env.VAPID_PRIVATE_KEY, x, y },
    format: 'jwk',
  });
}

// Gera JWT VAPID para autenticação
function gerarVapidJwt(endpoint) {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const privateKey = criarChavePrivadaVapid();

  return jwt.sign(
    { aud: audience, exp: Math.floor(Date.now() / 1000) + 43200, sub: process.env.VAPID_EMAIL },
    privateKey,
    { algorithm: 'ES256' }
  );
}

// Envia push sem payload criptografado (ping — service worker exibe notificação)
function enviarPushRaw(sub) {
  return new Promise((resolve) => {
    try {
      const endpoint = sub.endpoint;
      const token = gerarVapidJwt(endpoint);
      const url = new URL(endpoint);
      const transport = url.protocol === 'https:' ? https : http;

      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          Authorization: `vapid t=${token},k=${process.env.VAPID_PUBLIC_KEY}`,
          TTL: '86400',
          'Content-Length': 0,
        },
      }, (res) => resolve(res.statusCode));

      req.on('error', () => resolve(null));
      req.end();
    } catch (e) {
      resolve(null);
    }
  });
}

// Exportada: enviar push para um user_id
async function enviarPush(userId, titulo, corpo) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    const { data } = await supabaseAdmin
      .from('push_subscriptions')
      .select('subscription')
      .eq('user_id', userId)
      .single();

    if (!data) return;
    const sub = JSON.parse(data.subscription);
    const status = await enviarPushRaw(sub);

    if (status === 410 || status === 404) {
      await supabaseAdmin.from('push_subscriptions').delete().eq('user_id', userId);
    }
  } catch (e) { /* silencioso */ }
}

// GET /api/notifications/vapid-public-key
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// POST /api/notifications/subscribe
router.post('/subscribe', requireAuth, async (req, res, next) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Subscription inválida' });

    await supabaseAdmin.from('push_subscriptions').upsert({
      user_id: req.user.id,
      endpoint: subscription.endpoint,
      subscription: JSON.stringify(subscription),
      atualizado_em: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/notifications/unsubscribe
router.post('/unsubscribe', requireAuth, async (req, res, next) => {
  try {
    await supabaseAdmin.from('push_subscriptions').delete().eq('user_id', req.user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.enviarPush = enviarPush;
