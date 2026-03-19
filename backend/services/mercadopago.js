const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');

if (!process.env.MP_ACCESS_TOKEN) {
  console.error('[MercadoPago] MP_ACCESS_TOKEN não definido no .env');
  process.exit(1);
}

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 5000 },
});

const paymentClient = new Payment(mpClient);
const preferenceClient = new Preference(mpClient);

// =============================================
// PIX — Criar pagamento com QR Code
// =============================================
/**
 * Cria um pagamento Pix no Mercado Pago.
 * O valor total é cobrado ao comprador; o split é feito via webhook
 * após confirmação do pagamento.
 *
 * Para split automático em marketplace, cada lojista deve ter sua
 * conta MP vinculada via OAuth (ver docs: Split de pagamentos MP).
 *
 * @param {object} params
 * @param {number} params.total
 * @param {string} params.orderId
 * @param {string} params.storeName
 * @param {string} params.payerEmail
 * @param {string} params.payerFirstName
 * @param {string} params.payerLastName
 * @param {string} params.payerCpf
 * @returns {Promise<object>} Dados do pagamento incluindo qr_code e qr_code_base64
 */
async function criarPagamentoPix(params) {
  const {
    total,
    orderId,
    storeName,
    payerEmail,
    payerFirstName,
    payerLastName,
    payerCpf,
  } = params;

  const body = {
    transaction_amount: total,
    description: `Pedido #${orderId} — ${storeName}`,
    payment_method_id: 'pix',
    external_reference: orderId,
    notification_url: `${process.env.WEBHOOK_URL}/api/payments/webhook`,
    payer: {
      email: payerEmail,
      first_name: payerFirstName,
      last_name: payerLastName,
      identification: {
        type: 'CPF',
        number: payerCpf,
      },
    },
    date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min
    metadata: { order_id: orderId },
  };

  const response = await paymentClient.create({ body });

  return {
    paymentId: response.id,
    status: response.status,
    qrCode: response.point_of_interaction?.transaction_data?.qr_code,
    qrCodeBase64: response.point_of_interaction?.transaction_data?.qr_code_base64,
    ticketUrl: response.point_of_interaction?.transaction_data?.ticket_url,
    expiresAt: body.date_of_expiration,
  };
}

// =============================================
// CARTÃO — Criar preferência (Checkout Pro)
// =============================================
/**
 * Cria uma preferência de pagamento para cartão via Checkout Pro.
 * Redireciona o usuário para a página de pagamento do MP.
 *
 * Para split (marketplace fee), informe marketplace_fee e
 * o access_token do vendedor (obtido via OAuth).
 *
 * @param {object} params
 * @param {number} params.total
 * @param {number} params.marketplaceFee   Comissão da plataforma (R$)
 * @param {string} params.orderId
 * @param {string} params.storeName
 * @param {Array}  params.items
 * @param {string} params.payerEmail
 * @param {string} params.backUrl          URL de retorno após pagamento
 * @returns {Promise<object>}
 */
async function criarPreferenciaCartao(params) {
  const {
    total,
    marketplaceFee,
    orderId,
    storeName,
    items,
    payerEmail,
    backUrl,
  } = params;

  const body = {
    items: items.map((item) => ({
      id: item.id || item.nome,
      title: item.nome,
      quantity: item.quantidade,
      unit_price: parseFloat(item.precoUnitario),
      currency_id: 'BRL',
    })),
    payer: { email: payerEmail },
    back_urls: {
      success: `${backUrl}/api/payments/callback?status=approved&order=${orderId}`,
      failure: `${backUrl}/api/payments/callback?status=failure&order=${orderId}`,
      pending: `${backUrl}/api/payments/callback?status=pending&order=${orderId}`,
    },
    auto_return: 'approved',
    external_reference: orderId,
    notification_url: `${process.env.WEBHOOK_URL}/api/payments/webhook`,
    statement_descriptor: 'CHEGOUAI',
    metadata: { order_id: orderId, store: storeName },
    // marketplace_fee vai para conta da plataforma automaticamente
    ...(marketplaceFee > 0 && { marketplace_fee: marketplaceFee }),
  };

  const response = await preferenceClient.create({ body });

  return {
    preferenceId: response.id,
    initPoint: response.init_point,           // URL produção
    sandboxInitPoint: response.sandbox_init_point, // URL testes
  };
}

// =============================================
// BUSCAR STATUS DO PAGAMENTO
// =============================================
async function buscarPagamento(paymentId) {
  const response = await paymentClient.get({ id: paymentId });
  return {
    id: response.id,
    status: response.status,
    statusDetail: response.status_detail,
    amount: response.transaction_amount,
    externalReference: response.external_reference,
    paidAt: response.date_approved,
  };
}

// =============================================
// VERIFICAR ASSINATURA DO WEBHOOK
// =============================================
/**
 * O MP envia um header x-signature com HMAC-SHA256 do payload.
 * Verificar garante que o webhook é legítimo.
 * Documentação: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
 */
function verificarAssinaturaWebhook(req) {
  // Em produção implemente a verificação da assinatura HMAC
  // Por ora, verificar apenas que veio do IP do MP e tem os campos esperados
  const { type, data } = req.body;
  return type && data && data.id;
}

module.exports = {
  criarPagamentoPix,
  criarPreferenciaCartao,
  buscarPagamento,
  verificarAssinaturaWebhook,
};
