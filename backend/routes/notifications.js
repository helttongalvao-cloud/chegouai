const express = require('express');
const webpush = require('web-push');
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');

const router = express.Router();

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// GET /api/notifications/vapid-public-key — Chave pública para o frontend
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/notifications/subscribe — Salvar subscription do usuário
router.post('/subscribe', requireAuth, async (req, res, next) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Subscription inválida' });
    }

    await supabaseAdmin
      .from('push_subscriptions')
      .upsert({
        user_id: req.user.id,
        endpoint: subscription.endpoint,
        subscription: JSON.stringify(subscription),
        atualizado_em: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/unsubscribe — Remover subscription
router.post('/unsubscribe', requireAuth, async (req, res, next) => {
  try {
    await supabaseAdmin
      .from('push_subscriptions')
      .delete()
      .eq('user_id', req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Função utilitária exportada: enviar push para um user_id
async function enviarPush(userId, titulo, corpo, dados = {}) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    const { data } = await supabaseAdmin
      .from('push_subscriptions')
      .select('subscription')
      .eq('user_id', userId)
      .single();

    if (!data) return;

    const sub = JSON.parse(data.subscription);
    const payload = JSON.stringify({ titulo, corpo, dados });

    await webpush.sendNotification(sub, payload).catch(async (err) => {
      // Se subscription expirou (410), remover do banco
      if (err.statusCode === 410) {
        await supabaseAdmin.from('push_subscriptions').delete().eq('user_id', userId);
      }
    });
  } catch (e) {
    // Push silenciosamente falha — não bloqueia o fluxo
  }
}

module.exports = router;
module.exports.enviarPush = enviarPush;
