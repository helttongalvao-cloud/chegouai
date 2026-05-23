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

// Firebase Admin SDK (só ativo se FIREBASE_SERVICE_ACCOUNT estiver configurado)
let fcmMessaging = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const admin = require('firebase-admin');
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    fcmMessaging = admin.messaging();
    console.log('[FCM] Firebase Admin inicializado');
  } catch (e) {
    console.error('[FCM] Erro ao inicializar Firebase Admin:', e.message);
  }
}

// =============================================
// Enviar via FCM (APK Android)
// =============================================
async function enviarFCM(fcmToken, titulo, corpo, dados) {
  if (!fcmMessaging || !fcmToken) return false;
  try {
    await fcmMessaging.send({
      token: fcmToken,
      notification: { title: titulo, body: corpo },
      data: dados ? Object.fromEntries(Object.entries(dados).map(([k, v]) => [k, String(v)])) : {},
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'pedidos' },
      },
    });
    console.log('[FCM] ✓ Enviado via FCM nativo');
    return true;
  } catch (e) {
    console.error('[FCM] ✗ Falha:', e.message);
    // Token inválido — limpar do banco
    if (e.errorInfo) {
      const code = e.errorInfo.code || '';
      if (code.includes('invalid-registration-token') || code.includes('registration-token-not-registered')) {
        await supabaseAdmin.from('push_subscriptions').update({ fcm_token: null }).eq('fcm_token', fcmToken);
      }
    }
    return false;
  }
}

// =============================================
// Exportada: enviar push para um user_id
// Tenta FCM primeiro (APK), fallback para VAPID (PWA)
// =============================================
async function enviarPush(userId, titulo, corpo, dados) {
  try {
    console.log('[Push] Enviando para user_id:', userId, '|', titulo);
    const { data, error } = await supabaseAdmin
      .from('push_subscriptions')
      .select('subscription, fcm_token')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) { console.error('[Push] Erro DB ao buscar subscription:', userId, error.message); return; }
    if (!data) { console.warn('[Push] Nenhuma subscription no banco para user_id:', userId); return; }

    // Tentar FCM primeiro (APK Android — mais confiável)
    if (data.fcm_token) {
      const fcmOk = await enviarFCM(data.fcm_token, titulo, corpo, dados);
      if (fcmOk) return;
    }

    // Fallback: VAPID (PWA)
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      console.warn('[Push] VAPID keys não configuradas — push ignorado');
      return;
    }
    if (!data.subscription) { console.warn('[Push] Sem subscription VAPID para', userId); return; }

    const sub = JSON.parse(data.subscription);
    const payload = JSON.stringify({ titulo, corpo, dados: dados || {} });

    await webpush.sendNotification(sub, payload, { urgency: 'high', TTL: 3600 });
    console.log('[Push] ✓ Enviado via VAPID para', userId, '|', titulo);
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      console.warn('[Push] Subscription VAPID expirada (', e.statusCode, ') — removendo para', userId);
      await Promise.all([
        supabaseAdmin.from('push_subscriptions').delete().eq('user_id', userId),
        supabaseAdmin.from('profiles').update({ push_needs_renewal: true }).eq('id', userId),
      ]);
    } else {
      console.error('[Push] ✗ Falha ao enviar para', userId, '— HTTP', e.statusCode, '—', e.message);
    }
  }
}

// GET /api/notifications/vapid-public-key
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// GET /api/notifications/status — verifica se subscription existe no banco
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const { data: sub } = await supabaseAdmin
      .from('push_subscriptions').select('endpoint, fcm_token').eq('user_id', req.user.id).maybeSingle();
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('push_needs_renewal').eq('id', req.user.id).maybeSingle();
    res.json({
      active: !!(sub),
      hasFcm: !!(sub && sub.fcm_token),
      needsRenewal: !!(profile && profile.push_needs_renewal),
    });
  } catch (err) { next(err); }
});

// POST /api/notifications/subscribe (VAPID — PWA)
router.post('/subscribe', requireAuth, async (req, res, next) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Subscription inválida' });

    const userId = req.user.id;
    console.log('[Push] Tentando salvar subscription para user_id:', userId, '| endpoint:', subscription.endpoint.substring(0, 50));

    // Delete + insert é mais confiável que upsert (não depende de constraint unique)
    const { error: delErr } = await supabaseAdmin
      .from('push_subscriptions')
      .delete()
      .eq('user_id', userId);
    if (delErr) console.warn('[Push] Aviso ao deletar subscription antiga:', delErr.message);

    const { error: insErr } = await supabaseAdmin
      .from('push_subscriptions')
      .insert({
        user_id: userId,
        endpoint: subscription.endpoint,
        subscription: JSON.stringify(subscription),
        atualizado_em: new Date().toISOString(),
      });

    if (insErr) {
      console.error('[Push] ERRO ao inserir subscription para', userId, ':', insErr.message);
      return res.status(500).json({ error: 'Erro ao salvar subscription: ' + insErr.message });
    }

    await supabaseAdmin.from('profiles').update({ push_needs_renewal: false }).eq('id', userId);
    console.log('[Push] ✓ Subscription VAPID salva com sucesso para user_id:', userId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/notifications/subscribe-fcm (FCM — APK Android)
router.post('/subscribe-fcm', requireAuth, async (req, res, next) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ error: 'fcmToken obrigatório' });

    const { error } = await supabaseAdmin.from('push_subscriptions').upsert({
      user_id: req.user.id,
      fcm_token: fcmToken,
      endpoint: `fcm:${req.user.id}`,
      atualizado_em: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    if (error) {
      console.error('[FCM] Erro ao salvar token para', req.user.id, error.message);
      return res.status(500).json({ error: 'Erro ao salvar FCM token' });
    }

    await supabaseAdmin.from('profiles').update({ push_needs_renewal: false }).eq('id', req.user.id);
    console.log('[FCM] Token salvo para user_id:', req.user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/notifications/test — envia push para o próprio usuário logado
router.post('/test', requireAuth, async (req, res, next) => {
  try {
    await enviarPush(req.user.id, '🔔 Teste Chegou Aí', 'Notificações estão funcionando!', {});
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
module.exports.enviarFCMDireto = enviarFCM;
