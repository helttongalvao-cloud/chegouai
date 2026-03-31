/**
 * Serviço de pagamentos via Asaas
 * Taxa Pix: fixa (configurável via ASAAS_TAXA_PIX)
 * Split: instantâneo via wallets de subcontas
 */
const https = require('https');

const ASAAS_BASE = process.env.NODE_ENV === 'production'
  ? 'https://api.asaas.com/api/v3'
  : 'https://sandbox.asaas.com/api/v3';

// Helper HTTP simples sem dependência extra (usa apenas Node built-in)
function asaasRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(ASAAS_BASE + path);
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'access_token': process.env.ASAAS_API_KEY,
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
            const msg = parsed.errors?.[0]?.description || parsed.error || `HTTP ${res.statusCode}`;
            reject(new Error('[Asaas] ' + msg));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error('[Asaas] Resposta inválida: ' + data.substring(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('[Asaas] Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// =============================================
// CLIENTE — criar ou buscar por CPF
// =============================================
async function criarOuBuscarCliente({ nome, email, cpf }) {
  const cpfLimpo = cpf ? cpf.replace(/\D/g, '') : null;

  if (cpfLimpo && cpfLimpo.length === 11) {
    const resultado = await asaasRequest('GET', `/customers?cpfCnpj=${cpfLimpo}&limit=1`);
    if (resultado.data && resultado.data.length > 0) {
      return resultado.data[0].id;
    }
  }

  const novo = await asaasRequest('POST', '/customers', {
    name: nome || 'Cliente',
    ...(email && { email }),
    ...(cpfLimpo && { cpfCnpj: cpfLimpo }),
  });
  return novo.id;
}

// =============================================
// PIX — cobrança com QR Code dinâmico
// =============================================
async function criarCobrancaPix({ total, orderId, customerId, split }) {
  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  const dueDate = amanha.toISOString().split('T')[0];

  const body = {
    customer: customerId,
    billingType: 'PIX',
    value: parseFloat(total.toFixed(2)),
    dueDate,
    externalReference: orderId,
    description: `Pedido Chegou Aí #${orderId.substring(0, 8)}`,
    ...(split && split.length > 0 && { split }),
  };

  const cobranca = await asaasRequest('POST', '/payments', body);

  // Buscar QR code
  const pixData = await asaasRequest('GET', `/payments/${cobranca.id}/pixQrCode`);

  return {
    chargeId: cobranca.id,
    status: cobranca.status,
    qrCode: pixData.payload,          // string "copia e cola"
    qrCodeBase64: pixData.encodedImage, // base64 da imagem PNG
    expiresAt: pixData.expirationDate,
  };
}

// =============================================
// CARTÃO DE CRÉDITO — checkout transparente
// =============================================
async function criarCobrancaCartao({
  total, orderId, customerId,
  creditCard,         // { holderName, number, expiryMonth, expiryYear, ccv }
  creditCardHolderInfo, // { name, email, cpfCnpj, phone, postalCode }
  installments,
  split,
}) {
  const hoje = new Date().toISOString().split('T')[0];

  const body = {
    customer: customerId,
    billingType: 'CREDIT_CARD',
    value: parseFloat(total.toFixed(2)),
    dueDate: hoje,
    externalReference: orderId,
    description: `Pedido Chegou Aí #${orderId.substring(0, 8)}`,
    installmentCount: parseInt(installments) || 1,
    creditCard,
    creditCardHolderInfo,
    ...(split && split.length > 0 && { split }),
  };

  const cobranca = await asaasRequest('POST', '/payments', body);

  return {
    chargeId: cobranca.id,
    status: cobranca.status, // PENDING, CONFIRMED, RECEIVED
  };
}

// =============================================
// BUSCAR STATUS DA COBRANÇA
// =============================================
async function buscarCobranca(chargeId) {
  const data = await asaasRequest('GET', `/payments/${chargeId}`);
  return {
    id: data.id,
    status: data.status,
    value: data.value,
    externalReference: data.externalReference,
    paidAt: data.paymentDate,
  };
}

// =============================================
// SPLIT — montar array para a API Asaas
// A plataforma retém o restante automaticamente.
// =============================================
function montarSplit({ valorLojista, walletLojista, valorMotoboy, walletMotoboy }) {
  const split = [];

  if (walletLojista && valorLojista > 0) {
    split.push({ walletId: walletLojista, fixedValue: parseFloat(valorLojista.toFixed(2)) });
  }
  if (walletMotoboy && valorMotoboy > 0) {
    split.push({ walletId: walletMotoboy, fixedValue: parseFloat(valorMotoboy.toFixed(2)) });
  }

  return split;
}

// =============================================
// WEBHOOK — verificar token do header
// =============================================
function verificarWebhookAsaas(req) {
  const token = req.headers['asaas-access-token'];
  const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN;

  if (!webhookToken) {
    console.warn('[Asaas Webhook] ASAAS_WEBHOOK_TOKEN não configurado — aceitando sem verificação');
    return true;
  }

  return token === webhookToken;
}

module.exports = {
  criarOuBuscarCliente,
  criarCobrancaPix,
  criarCobrancaCartao,
  buscarCobranca,
  montarSplit,
  verificarWebhookAsaas,
};
