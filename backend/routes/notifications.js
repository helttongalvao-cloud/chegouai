const express = require('express');
const webpush = require('web-push');
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');

const router = express.Router();

// Configurar VAPID assim que o módulo carrega
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:contato@chegouai.com.br',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// =============================================
// Exportada: enviar push para um user_id
// =============================================
async function enviarPush(userId, titulo, corpo, dados) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    const { data } = await supabaseAdmin
      .from('push_subscriptions')
      .select('subscription')
      .eq('user_id', userId)
      .single();

    if (!data) return;

    const sub = JSON.parse(data.subscription);
    const payload = JSON.stringify({ titulo, corpo, dados: dados || {} });

    await webpush.sendNotification(sub, payload, { urgency: 'high', TTL: 3600 });
  } catch (e) {
    // Subscription expirada — remover
    if (e.statusCode === 410 || e.statusCode === 404) {
      await supabaseAdmin.from('push_subscriptions').delete().eq('user_id', userId);
    }
    // Outros erros: silencioso para não quebrar o fluxo principal
  }
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
