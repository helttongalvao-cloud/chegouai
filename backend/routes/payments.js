const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/security');
const { supabaseAdmin } = require('../config/supabase');
const { criarOuBuscarCliente, criarCobrancaPix, criarCobrancaCartao, buscarCobranca, montarSplit, verificarWebhookAsaas } = require('../services/asaas');
const { calcularSplit } = require('../services/commission');

const router = express.Router();

// ─── Helper: buscar pedido pendente do cliente ─────────────────────────────
async function buscarPedidoPendente(pedidoId, clienteId) {
  const { data: pedido, error } = await supabaseAdmin
    .from('pedidos')
    .select('*, estabelecimentos(nome, asaas_wallet_id)')
    .eq('id', pedidoId)
    .eq('cliente_id', clienteId)
    .eq('pagamento_status', 'pendente')
    .single();
  if (error || !pedido) throw Object.assign(new Error('Pedido não encontrado'), { status: 404 });
  return pedido;
}

// ─── Helper: salvar ID da cobrança e atualizar split ──────────────────────
async function salvarCobranca(pedidoId, chargeId, split) {
  await supabaseAdmin.from('pedidos').update({
    asaas_payment_id: chargeId,
    comissao_plataforma: split.valorPlataforma,
    total: split.total,
    pagamento_status: 'aguardando',
  }).eq('id', pedidoId);
}

// ─── Helper: processar pagamento aprovado (idempotente) ───────────────────
async function processarPagamentoAprovado(orderId, chargeId) {
  const { data: atual } = await supabaseAdmin
    .from('pedidos').select('pagamento_status').eq('id', orderId).single();

  if (!atual || atual.pagamento_status === 'aprovado') {
    console.log(`[Asaas] Pedido ${orderId} já processado — ignorando`);
    return;
  }

  const { data: pedido } = await supabaseAdmin
    .from('pedidos')
    .update({ pagamento_status: 'aprovado', status: 'aceito', asaas_payment_id: chargeId })
    .eq('id', orderId)
    .select('subtotal, taxa_entrega, forma_pagamento')
    .single();

  if (!pedido) return;

  const split = calcularSplit({
    subtotal: pedido.subtotal,
    taxaEntrega: pedido.taxa_entrega,
    formaPagamento: pedido.forma_pagamento,
  });

  await supabaseAdmin.from('repasses').insert([
    { pedido_id: orderId, tipo: 'lojista',    valor: split.valorLojista,    status: 'pendente' },
    { pedido_id: orderId, tipo: 'plataforma', valor: split.valorPlataforma, status: 'pago' },
  ]);

  console.log(`[Asaas] Pedido ${orderId} aprovado — lojista R$${split.valorLojista}, motoboy R$${split.valorMotoboy}, plataforma R$${split.valorPlataforma}`);
}

// =============================================
// POST /api/payments/pix — Gerar QR Code Pix
// =============================================
router.post('/pix', paymentLimiter, requireAuth, [
  body('pedidoId').isUUID().withMessage('pedidoId inválido'),
  body('cpf').optional().matches(/^\d{11}$/).withMessage('CPF inválido (11 dígitos)'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { pedidoId, cpf } = req.body;
    const user = req.user;

    const pedido = await buscarPedidoPendente(pedidoId, user.id);
    const split = calcularSplit({
      subtotal: pedido.subtotal,
      taxaEntrega: pedido.taxa_entrega,
      formaPagamento: 'pix',
    });

    const customerId = await criarOuBuscarCliente({
      nome: user.profile.nome,
      email: user.email,
      cpf,
    });

    const splitArr = montarSplit({
      valorLojista: split.valorLojista,
      walletLojista: pedido.estabelecimentos?.asaas_wallet_id || null,
      valorMotoboy: 0,    // motoboy recebe após entrega confirmada
      walletMotoboy: null,
    });

    const cobranca = await criarCobrancaPix({
      total: split.total,
      orderId: pedidoId,
      customerId,
      split: splitArr,
    });

    await salvarCobranca(pedidoId, cobranca.chargeId, split);

    res.json({
      paymentId: cobranca.chargeId,
      qrCode: cobranca.qrCode,
      qrCodeBase64: cobranca.qrCodeBase64,
      expiresAt: cobranca.expiresAt,
      split: {
        total: split.total,
        lojista: split.valorLojista,
        motoboy: split.valorMotoboy,
        plataforma: split.valorPlataforma,
        taxaGateway: split.taxaGateway,
        lucroPlataforma: split.lucroPlataforma,
      },
    });
  } catch (err) {
    console.error('[Pix]', err.message);
    next(err);
  }
});

// =============================================
// POST /api/payments/cartao — Cartão transparente
// =============================================
router.post('/cartao', paymentLimiter, requireAuth, [
  body('pedidoId').isUUID().withMessage('pedidoId inválido'),
  body('holderName').notEmpty().withMessage('Nome do titular obrigatório'),
  body('cardNumber').notEmpty().withMessage('Número do cartão obrigatório'),
  body('expiryMonth').matches(/^\d{2}$/).withMessage('Mês inválido'),
  body('expiryYear').matches(/^\d{4}$/).withMessage('Ano inválido'),
  body('ccv').matches(/^\d{3,4}$/).withMessage('CVV inválido'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const {
      pedidoId, holderName, cardNumber, expiryMonth, expiryYear, ccv,
      cpf, phone, postalCode, installments,
    } = req.body;
    const user = req.user;

    const pedido = await buscarPedidoPendente(pedidoId, user.id);
    const split = calcularSplit({
      subtotal: pedido.subtotal,
      taxaEntrega: pedido.taxa_entrega,
      formaPagamento: 'cartao',
    });

    const customerId = await criarOuBuscarCliente({
      nome: user.profile.nome,
      email: user.email,
      cpf,
    });

    const splitArr = montarSplit({
      valorLojista: split.valorLojista,
      walletLojista: pedido.estabelecimentos?.asaas_wallet_id || null,
      valorMotoboy: 0,
      walletMotoboy: null,
    });

    const cobranca = await criarCobrancaCartao({
      total: split.total,
      orderId: pedidoId,
      customerId,
      creditCard: {
        holderName,
        number: cardNumber.replace(/\D/g, ''),
        expiryMonth,
        expiryYear,
        ccv,
      },
      creditCardHolderInfo: {
        name: holderName,
        email: user.email,
        cpfCnpj: cpf ? cpf.replace(/\D/g, '') : '00000000000',
        phone: phone || '',
        postalCode: postalCode ? postalCode.replace(/\D/g, '') : '00000000',
      },
      installments: parseInt(installments || 1),
      split: splitArr,
    });

    await salvarCobranca(pedidoId, cobranca.chargeId, split);

    const aprovado = ['CONFIRMED', 'RECEIVED'].includes(cobranca.status);
    if (aprovado) {
      await processarPagamentoAprovado(pedidoId, cobranca.chargeId);
    }

    res.json({
      status: aprovado ? 'approved' : 'pending',
      chargeId: cobranca.chargeId,
    });
  } catch (err) {
    console.error('[Cartão]', err.message);
    next(err);
  }
});

// =============================================
// POST /api/payments/webhook — Notificações Asaas
// =============================================
router.post('/webhook', async (req, res) => {
  if (!verificarWebhookAsaas(req)) {
    console.warn('[Webhook] Token inválido');
    return res.sendStatus(401);
  }

  // Responder 200 imediatamente para o Asaas não retentar
  res.sendStatus(200);

  try {
    const { event, payment } = req.body;
    console.log('[Asaas Webhook]', event, payment?.id, 'ref:', payment?.externalReference);

    if (!payment?.externalReference) return;
    const orderId = payment.externalReference;

    if (['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'].includes(event)) {
      await processarPagamentoAprovado(orderId, payment.id);
    } else if (['PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_REFUNDED'].includes(event)) {
      await supabaseAdmin.from('pedidos')
        .update({ pagamento_status: 'cancelado', status: 'cancelado' })
        .eq('id', orderId);
    }
  } catch (err) {
    console.error('[Webhook Asaas]', err.message);
  }
});

// =============================================
// GET /api/payments/status/:pedidoId
// =============================================
router.get('/status/:pedidoId', requireAuth, [
  param('pedidoId').isUUID(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

  try {
    const { data: pedido } = await supabaseAdmin
      .from('pedidos')
      .select('id, status, pagamento_status, total, comissao_plataforma')
      .eq('id', req.params.pedidoId)
      .eq('cliente_id', req.user.id)
      .single();

    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });
    res.json(pedido);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
