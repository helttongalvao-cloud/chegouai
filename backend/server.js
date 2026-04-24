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
}));

// Landing page — página inicial pública
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// PWA — app principal
app.get('/app', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.sendFile(path.join(__dirname, 'chegou-ai.html'));
});

// Mesa — cardápio público via QR Code (sem login)
app.get('/mesa', (req, res) => {
  res.sendFile(path.join(__dirname, 'chegou-ai.html'));
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

// =============================================
// CONFIG PÚBLICA — Expõe chaves seguras ao frontend
// =============================================
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    // Taxa de conveniência do cartão cobrada do cliente (configurável via Railway)
    taxaCartaoCliente: parseFloat(process.env.ASAAS_TAXA_CARTAO || '2.99'),
    // Pedido mínimo global do app (configurável via Railway)
    pedidoMinimo: parseFloat(process.env.PEDIDO_MINIMO_GLOBAL || '0'),
  });
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

// =============================================
// HEALTH CHECK
// =============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    app: 'Chegou Aí',
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
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// =============================================
// INICIAR SERVIDOR
// =============================================
app.listen(PORT, () => {
  console.log(`\n🛵  Chegou Aí — Backend rodando`);
  console.log(`📍  http://localhost:${PORT}`);
  console.log(`🌍  Ambiente: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;

