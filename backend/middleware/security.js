const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');

// =============================================
// RATE LIMITING
// =============================================

// Limite geral para a API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em 15 minutos.' },
  skip: (req) => req.path === '/api/health',
});

// Limite estrito para autenticação (previne brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' },
});

// Limite para pagamentos (previne abuso)
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de pagamento. Aguarde 1 minuto.' },
});

// Slow down gradual para rotas sensíveis
const authSlowDown = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 5,
  delayMs: (hits) => hits * 200,
});

module.exports = { apiLimiter, authLimiter, paymentLimiter, authSlowDown };
