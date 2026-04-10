/**
 * pagarme.js — Serviço Pagar.me v5
 *
 * Split model:
 *   - Lojista: valor fixo (charge_processing_fee: false, liable: false)
 *   - Plataforma: remainder (charge_processing_fee: true, liable: true)
 *   - Motoboy: transferência Pix separada após confirmação de entrega
 *
 * D+0: recipients cadastrados com anticipation_delay: 0
 */
const https  = require('https');
const crypto = require('crypto');

const PAGARME_BASE = 'https://api.pagar.me/core/v5';

// ── HTTP helper ──────────────────────────────────────────────────────────────
function pagarmeRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url     = new URL(PAGARME_BASE + path);
    const payload = body ? JSON.stringify(body) : null;
    const auth    = Buffer.from(process.env.PAGARME_API_KEY + ':').toString('base64');

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ChegouAi/1.0',
        ...(payload && { 'Content-Length': Buffer.byteLength(payload) }),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            console.error('[Pagar.me] HTTP', res.statusCode, JSON.stringify(parsed));
            const detail = Array.isArray(parsed.errors) && parsed.errors.length
              ? parsed.errors.map(e => e.message || e.parameter_name || JSON.stringify(e)).join('; ')
              : null;
            const msg = detail || parsed.message || `HTTP ${res.statusCode}`;
            const err = new Error('[Pagar.me] ' + msg);
            err.status = res.statusCode < 500 ? res.statusCode : 500;
            err.statusCode = res.statusCode;
            err.body = parsed;
            reject(err);
          } else {
            resolve(parsed);
          }
        } catch (e) {
          console.error('[Pagar.me] HTTP', res.statusCode, '| Body:', data.substring(0, 500));
          reject(new Error('[Pagar.me] Resposta inválida: ' + data.substring(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('[Pagar.me] Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Centavos ─────────────────────────────────────────────────────────────────
// Pagar.me v5 sempre trabalha com inteiros em centavos
function toCents(valor) {
  return Math.round(parseFloat(valor) * 100);
}

// =============================================
// CLIENTE — criar ou buscar por CPF
// =============================================
async function criarOuBuscarCliente({ nome, email, cpf, telefone }) {
  const doc = cpf ? cpf.replace(/\D/g, '') : null;
  const tel = telefone ? telefone.replace(/\D/g, '') : null;

  const phonePayload = tel && tel.length >= 10 ? {
    phones: {
      mobile_phone: {
        country_code: '55',
        area_code: tel.substring(0, 2),
        number: tel.substring(2),
      },
    },
  } : null;

  if (doc && doc.length === 11) {
    try {
      const res = await pagarmeRequest('GET', `/customers?document=${doc}`);
      if (res.data?.length > 0) {
        const cliente = res.data[0];
        // Se o cliente não tem telefone e temos um, atualiza antes de retornar
        if (phonePayload && !cliente.phones?.mobile_phone) {
          await pagarmeRequest('PUT', `/customers/${cliente.id}`, {
            name: cliente.name,
            ...phonePayload,
          });
        }
        return cliente.id;
      }
    } catch (e) {
      console.warn('[Pagar.me] Busca/atualização de cliente falhou:', e.message);
    }
  }

  const novo = await pagarmeRequest('POST', '/customers', {
    name: nome || 'Cliente',
    type: 'individual',
    ...(email && { email }),
    ...(doc && doc.length === 11 && { document: doc, document_type: 'CPF' }),
    ...(phonePayload || {}),
  });

  return novo.id;
}

// =============================================
// SPLIT RULES — 2 recebedores (lojista + plataforma)
//
// Lojista: amount fixo, sem taxa (charge_processing_fee: false)
// Plataforma: remainder, com taxa (charge_processing_fee: true)
//   → a taxa do gateway é descontada do saldo da plataforma,
//     não do lojista.
// =============================================
function montarSplitRules({ total, valorLojista, recipientIdLojista }) {
  const recipientPlataforma = process.env.PAGARME_RECIPIENT_ID_PLATAFORMA;

  // Split só é montado quando ambos os recebedores estão configurados
  if (!recipientIdLojista || !recipientPlataforma || valorLojista <= 0) return [];

  const amountLojista    = toCents(valorLojista);
  const amountPlataforma = toCents(total) - amountLojista;

  return [
    {
      recipient_id: recipientIdLojista,
      amount: amountLojista,
      type: 'flat',
      options: {
        charge_processing_fee: false,
        liable: false,
        charge_remainder_fee: false,
      },
    },
    {
      recipient_id: recipientPlataforma,
      amount: amountPlataforma,
      type: 'flat',
      options: {
        charge_processing_fee: true,
        liable: true,
        charge_remainder_fee: true,
      },
    },
  ];
}

// =============================================
// PIX — QR Code dinâmico
// =============================================
async function criarCobrancaPix({ total, orderId, customerId, splitRules }) {
  const body = {
    customer_id: customerId,
    items: [
      {
        amount: toCents(total),
        description: `Pedido Chegou Aí #${orderId.substring(0, 8)}`,
        quantity: 1,
        code: orderId.substring(0, 52),
      },
    ],
    payments: [
      {
        payment_method: 'pix',
        pix: { expires_in: 86400 }, // 24h
        amount: toCents(total),
        ...(splitRules?.length > 0 && { split: splitRules }),
      },
    ],
    metadata: { order_id: orderId },
  };

  const order  = await pagarmeRequest('POST', '/orders', body);
  console.log('[Pagar.me Pix] order.charges:', JSON.stringify(order.charges?.[0]?.last_transaction));
  const charge = order.charges?.[0];
  const pix    = charge?.last_transaction;

  return {
    orderId: order.id,
    chargeId: charge?.id,
    status: order.status,
    qrCode: pix?.qr_code,
    qrCodeBase64: pix?.qr_code_url,
    expiresAt: pix?.expires_at,
  };
}

// =============================================
// CARTÃO — checkout transparente
// O total já chega com o gross-up aplicado (commission.js)
// =============================================
async function criarCobrancaCartao({
  total, orderId, customerId,
  creditCard,    // { holderName, number, expiryMonth, expiryYear, ccv }
  billingAddress,
  installments,
  splitRules,
}) {
  const body = {
    customer_id: customerId,
    items: [
      {
        amount: toCents(total),
        description: `Pedido Chegou Aí #${orderId.substring(0, 8)}`,
        quantity: 1,
        code: orderId.substring(0, 52),
      },
    ],
    payments: [
      {
        payment_method: 'credit_card',
        amount: toCents(total),
        credit_card: {
          installments: parseInt(installments) || 1,
          statement_descriptor: 'CHEGOUAI',
          card: {
            number: creditCard.number.replace(/\D/g, ''),
            holder_name: creditCard.holderName,
            exp_month: parseInt(creditCard.expiryMonth),
            exp_year: parseInt(creditCard.expiryYear),
            cvv: creditCard.ccv,
            billing_address: billingAddress || {
              line_1: 'Endereco nao informado',
              zip_code: '69000000',
              city: 'Guajara',
              state: 'AM',
              country: 'BR',
            },
          },
        },
        ...(splitRules?.length > 0 && { split: splitRules }),
      },
    ],
    metadata: { order_id: orderId },
  };

  const order  = await pagarmeRequest('POST', '/orders', body);
  const charge = order.charges?.[0];

  const statusMap = { paid: 'CONFIRMED', pending: 'PENDING', failed: 'REFUSED', canceled: 'CANCELED' };

  return {
    orderId: order.id,
    chargeId: charge?.id,
    status: statusMap[order.status] || order.status,
  };
}

// =============================================
// BUSCAR PEDIDO
// =============================================
async function buscarPedido(pagarmeOrderId) {
  const data = await pagarmeRequest('GET', `/orders/${pagarmeOrderId}`);
  return {
    id: data.id,
    status: data.status,
    amount: data.amount / 100,
    metadata: data.metadata,
  };
}

// =============================================
// RECEBEDOR — cadastrar lojista/motoboy como recipient
//
// anticipation_delay: 0 → D+0 (requer aprovação Pagar.me)
// automatic_anticipation_enabled: true → antecipação automática
// =============================================
async function cadastrarRecebedor({ nome, email, cpf, contaBancaria }) {
  const doc = cpf ? cpf.replace(/\D/g, '') : null;

  const body = {
    name: nome,
    email,
    description: 'Parceiro Chegou Aí',
    type: 'individual',
    ...(doc && { document: doc, document_type: 'CPF' }),
    default_bank_account: contaBancaria,
    // Liquidação diária
    transfer_settings: {
      transfer_enabled: true,
      transfer_interval: 'daily',
      transfer_day: 0,
    },
    // Antecipação automática D+0
    automatic_anticipation_enabled: true,
    automatic_anticipation_type: 'full',
    automatic_anticipation_volume_percentage: '100',
    anticipation_delay: 0,
  };

  const recipient = await pagarmeRequest('POST', '/recipients', body);
  return recipient.id;
}

// =============================================
// TRANSFERÊNCIA PIX — repasse ao motoboy após entrega confirmada
// =============================================
function detectarTipoPix(chave) {
  const k = chave.trim();
  if (/^\d{11}$/.test(k))                                                         return 'cpf';
  if (/^\d{14}$/.test(k))                                                         return 'cnpj';
  if (k.includes('@'))                                                             return 'email';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return 'evp';
  return 'phone';
}

async function criarTransferenciaPix(chavePix, valor) {
  const type = detectarTipoPix(chavePix);
  return pagarmeRequest('POST', '/transfers', {
    amount: toCents(valor),
    source_id: process.env.PAGARME_RECIPIENT_ID_PLATAFORMA,
    target: {
      type: 'bank_account',
      bank_account: {
        pix_key: chavePix.trim(),
        pix_key_type: type,
      },
    },
  });
}

// =============================================
// WEBHOOK — verificar Basic Auth (usuário:senha)
// =============================================
function verificarWebhook(req) {
  const usuario = process.env.PAGARME_WEBHOOK_USER;
  const senha   = process.env.PAGARME_WEBHOOK_PASS;

  if (!usuario || !senha) {
    console.warn('[Pagar.me Webhook] Credenciais não configuradas — aceitando sem verificação');
    return true;
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;

  const base64      = authHeader.slice(6);
  const credenciais = Buffer.from(base64, 'base64').toString('utf8');
  const [user, pass] = credenciais.split(':');

  return user === usuario && pass === senha;
}

module.exports = {
  criarOuBuscarCliente,
  criarCobrancaPix,
  criarCobrancaCartao,
  buscarPedido,
  montarSplitRules,
  cadastrarRecebedor,
  criarTransferenciaPix,
  verificarWebhook,
};
