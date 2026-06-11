require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const path = require('path');

const { apiLimiter, authLimiter } = require('./middleware/security');

const authRoutes = require('./routes/auth');
const paymentsRoutes = require('./routes/payments');
const ordersRoutes = require('./routes/orders');
const establishmentsRoutes = require('./routes/establishments');
const adminRoutes = require('./routes/admin');
const featuresRoutes = require('./routes/features');
const notificationsRoutes = require('./routes/notifications');
const mesaRoutes = require('./routes/mesa');
const motoboyProprioRoutes = require('./routes/motoboyProprio');
const candidaturasRoutes = require('./routes/candidaturas');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway e outros proxies enviam X-Forwarded-For
app.set('trust proxy', 1);

// =============================================
// SEGURANÇA — CABEÇALHOS HTTP
// =============================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "'unsafe-eval'",
        'https://fonts.googleapis.com',
        'https://unpkg.com',
        'https://cdn.jsdelivr.net',
        'https://www.gstatic.com',
      ],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://fonts.googleapis.com',
        'https://unpkg.com',
        'https://cdn.jsdelivr.net',
      ],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://unpkg.com', 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: [
        "'self'",
        process.env.SUPABASE_URL || 'https://*.supabase.co',
        'https://*.supabase.co',
        'https://api.pagar.me',
        'wss://*.supabase.co',
        'https://nominatim.openstreetmap.org',
        'https://router.project-osrm.org',
      ],
      frameSrc: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// =============================================
// CORS
// =============================================
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? [
      process.env.FRONTEND_URL,
      'https://chegouaiapp.com.br',
      'https://www.chegouaiapp.com.br',
      'https://chegouai-production.up.railway.app',
      'https://chegouai.onrender.com',
    ].filter(Boolean)
  : [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ];

app.use(cors({
  origin(origin, cb) {
    // Permitir requests sem origin (mobile apps, Postman)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origem não permitida'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// =============================================
// MIDDLEWARE GERAL
// =============================================
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10mb' }));           // Limitar body size (importação CSV pode ter muitos produtos)
app.use(express.urlencoded({ extended: false }));

// =============================================
// SERVIR FRONTEND (PWA)
// =============================================
// Servir a pasta /public e o chegou-ai.html da raiz
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
  dotfiles: 'allow', // necessário para servir /.well-known/assetlinks.json (TWA Android)
}));

// Landing page — raiz e /landing servem a página de marketing
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/landing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/app', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'chegou-ai.html'));
});

// Download do APK Android
app.get('/download', (req, res) => {
  const apkUrl = 'https://github.com/helttongalvao-cloud/chegouai/releases/latest/download/app-debug.apk';
  const ua = req.headers['user-agent'] || '';
  const isAndroid = /android/i.test(ua);
  // Se não for Android, redireciona direto
  if (!isAndroid) return res.redirect(302, apkUrl);
  // Android: serve página com intent:// para abrir no Chrome mesmo vindo do WhatsApp
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Baixar Chegô</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#f8f8f8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{background:#fff;border-radius:20px;padding:32px 24px;max-width:360px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.10)}
  img.logo{width:80px;height:80px;border-radius:18px;margin-bottom:20px}
  h1{font-size:22px;font-weight:700;color:#1a1a1a;margin-bottom:8px}
  p{font-size:15px;color:#555;line-height:1.5;margin-bottom:24px}
  .btn{display:block;width:100%;padding:16px;border-radius:12px;font-size:17px;font-weight:600;text-decoration:none;margin-bottom:12px;border:none;cursor:pointer}
  .btn-primary{background:#f97316;color:#fff}
  .btn-secondary{background:#f0f0f0;color:#333;font-size:14px}
  .nota{font-size:12px;color:#999;margin-top:16px;line-height:1.6}
</style>
</head>
<body>
<div class="card">
  <img class="logo" src="https://chegouaiapp.com.br/icons/icon-192.png" alt="Chegô" onerror="this.style.display='none'">
  <h1>Chegô</h1>
  <p>Toque no botão abaixo para baixar o app no seu celular Android.</p>
  <a class="btn btn-primary" id="btnDownload" href="${apkUrl}">⬇ Baixar app (.apk)</a>
  <p class="nota">Se o download não iniciar, o botão vai abrir no Chrome automaticamente.</p>
</div>
<script>
var apk = ${JSON.stringify(apkUrl)};
var btn = document.getElementById('btnDownload');
// Detecta se está no WebView do WhatsApp/Instagram
var ua = navigator.userAgent || '';
var isWebView = /FBAN|FBAV|Instagram|WhatsApp/.test(ua) || (!/Chrome/.test(ua) && /Android/.test(ua));
if (isWebView) {
  // intent:// força abertura no Chrome
  var intentUrl = 'intent://' + apk.replace(/^https?:\\/\\//, '') + '#Intent;scheme=https;package=com.android.chrome;end';
  btn.href = intentUrl;
  btn.onclick = function(e) {
    e.preventDefault();
    // Tenta intent:// primeiro; se falhar (Chrome não instalado), vai direto
    var started = false;
    var t = setTimeout(function() {
      if (!started) window.location.href = apk;
    }, 1500);
    window.location.href = intentUrl;
    window.addEventListener('blur', function() { started = true; clearTimeout(t); });
  };
}
</script>
</body>
</html>`);
});

// Parceiro — auto-cadastro via convite
app.get('/parceiro', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'chegou-ai.html'));
});

// Mesa — cardápio público via QR Code (sem login)
app.get('/mesa', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'chegou-ai.html'));
});

// Motoboy próprio — tela de entregas do motoboy do lojista (sem login)
app.get('/motoboy', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'chegou-ai.html'));
});

// =============================================
// RATE LIMITING global
// =============================================
app.use('/api/', apiLimiter);

// =============================================
// ROTAS DA API
// =============================================
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/establishments', establishmentsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/features', featuresRoutes);
// OAuth MP removido — split via Asaas wallets
app.use('/api/notifications', notificationsRoutes);
app.use('/api/mesa', mesaRoutes);
app.use('/api/motoboy-proprio', motoboyProprioRoutes);
app.use('/api/candidaturas', candidaturasRoutes);

// =============================================
// CONFIG PÚBLICA — Expõe chaves seguras ao frontend
// =============================================
app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    // Taxa de conveniência do cartão cobrada do cliente (configurável via Railway)
    taxaCartaoCliente: parseFloat(process.env.ASAAS_TAXA_CARTAO || '2.99'),
    // Pedido mínimo global do app (configurável via Railway)
    pedidoMinimo: parseFloat(process.env.PEDIDO_MINIMO_GLOBAL || '0'),
    // Username do bot Telegram (para deep link dos motoboys)
    telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || '',
  });
});

// =============================================
// AVISO HOME — Banner público para todos os usuários
// =============================================
app.get('/api/aviso', async (req, res) => {
  try {
    const { getAviso } = require('./services/aviso');
    const texto = await getAviso();
    res.json({ aviso: texto || '' });
  } catch (_) { res.json({ aviso: '' }); }
});

// =============================================
// GEOCODE PROXY — evita bloqueio do Nominatim no browser
// =============================================
app.get('/api/geocode', async (req, res) => {
  const q = req.query.q;
  if (!q || q.trim().length < 3) return res.status(400).json({ error: 'Endereço muito curto' });
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&accept-language=pt-BR`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'ChegouAi/1.0 (helttongalvao@gmail.com)',
        'Accept-Language': 'pt-BR',
      },
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'Erro ao consultar geocodificação' });
  }
});

// Reverse geocode proxy — coordinates → city name (evita bloqueio do Nominatim no browser)
app.get('/api/geocode/reverse', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat e lon obrigatórios' });
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=json&accept-language=pt-BR`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'ChegouAi/1.0 (helttongalvao@gmail.com)',
        'Accept-Language': 'pt-BR',
      },
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'Erro ao consultar geocodificação reversa' });
  }
});

// =============================================
// HEALTH CHECK
// =============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    app: 'Chegô',
    timestamp: new Date().toISOString(),
  });
});

// =============================================
// HANDLER DE ERROS GLOBAL
// =============================================
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production'
    ? (status < 500 ? err.message : 'Erro interno do servidor')
    : err.message;

  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  res.status(status).json({ error: message });
});

// 404 para rotas não encontradas
// Slugs de loja: /:slug → serve o app com ?slug=... para o frontend resolver
app.get('/:slug([a-z0-9][a-z0-9-]{1,39})', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'chegou-ai.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// =============================================
// INICIAR SERVIDOR
// =============================================
const { iniciarMonitorAlertas } = require('./services/monitor-alertas');
const { iniciarMonitorPagamentos } = require('./services/monitor-pagamentos');

app.listen(PORT, () => {
  console.log(`\n🛵  Chegô — Backend rodando`);
  console.log(`📍  http://localhost:${PORT}`);
  console.log(`🌍  Ambiente: ${process.env.NODE_ENV || 'development'}\n`);

  iniciarMonitorAlertas();
  iniciarMonitorPagamentos();

  // Registrar webhook do Telegram automaticamente (idempotente)
  if (process.env.NODE_ENV === 'production' && process.env.TELEGRAM_BOT_TOKEN && process.env.FRONTEND_URL) {
    const webhookUrl = `${process.env.FRONTEND_URL}/api/notifications/telegram-webhook`;
    fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    })
      .then(r => r.json())
      .then(d => console.log('[Telegram] Webhook registrado:', d.ok ? '✅' : d.description))
      .catch(e => console.error('[Telegram] Falha ao registrar webhook:', e.message));
  }

  // Fix: atualiza logo Sabor na Brasa se ainda está com a imagem antiga
  const { supabaseAdmin } = require('./config/supabase');
  const LOGO_ANTIGA = 'https://lgcepuednurxwsandgaf.supabase.co/storage/v1/object/public/produtos/787a8b0c-f3f8-4ba5-b746-6533ca732cdc_1776560472993.jpg';
  const LOGO_NOVA = 'https://chegouaiapp.com.br/sabor-na-brasa-logo.jpg';
  supabaseAdmin.from('estabelecimentos')
    .update({ foto_url: LOGO_NOVA })
    .eq('foto_url', LOGO_ANTIGA)
    .then(({ error }) => { if (!error) console.log('✅  Logo Sabor na Brasa atualizada'); })
    .catch(() => {});
});

module.exports = app;

