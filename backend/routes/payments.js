const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/security');
const { supabaseAdmin } = require('../config/supabase');
const {
  criarOuBuscarCliente,
  criarCobrancaPix,
  criarCobrancaCartao,
  montarSplitRules,
  verificarWebhook,
} = require('../services/pagarme');
const { calcularSplit } = require('../services/commission');

const router = express.Router();

// ─── Helper: buscar pedido pendente do cliente ────────────────────────────
async function buscarPedidoPendente(pedidoId, clienteId) {
  const { data: pedido, error } = await supabaseAdmin
    .from('pedidos')
    .select('*, estabelecimentos(nome, pagarme_recipient_id)')
    .eq('id', pedidoId)
    .eq('cliente_id', clienteId)
    .eq('pagamento_status', 'pendente')
    .single();
  if (error || !pedido) throw Object.assign(new Error('Pedido não encontrado'), { status: 404 });
  return pedido;
}

// ─── Helper: salvar pagarme_order_id e valores do split ──────────────────
async function salvarCobranca(pedidoId, pagarmeOrderId, split) {
  await supabaseAdmin.from('pedidos').update({
    pagarme_order_id: pagarmeOrderId,
    comissao_plataforma: split.valorPlataforma,
    total: split.total,
    pagamento_status: 'aguardando',
  }).eq('id', pedidoId);
}

// ─── Helper: processar pagamento aprovado (idempotente) ──────────────────
async function processarPagamentoAprovado(orderId, pagarmeOrderId) {
  const { data: atual } = await supabaseAdmin
    .from('pedidos')
    .select('pagamento_status')
    .eq('id', orderId)
    .single();

  if (!atual || atual.pagamento_status === 'aprovado') {
    console.log(`[Pagar.me] Pedido ${orderId} já processado — ignorando`);
    return;
  }

  const { data: pedido } = await supabaseAdmin
    .from('pedidos')
    .update({ pagamento_status: 'aprovado', status: 'aceito', pagarme_order_id: pagarmeOrderId })
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
    { pedido_id: orderId, tipo: 'motoboy',    valor: split.valorMotoboy,    status: 'pendente' },
    { pedido_id: orderId, tipo: 'plataforma', valor: split.lucroPlataforma, status: 'pago' },
  ]);

  console.log(
    `[Pagar.me] Pedido ${orderId} aprovado` +
    ` — lojista R$${split.valorLojista}` +
    `, motoboy R$${split.valorMotoboy}` +
    `, plataforma R$${split.lucroPlataforma}`
  );
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

    const pedido = await buscarPedidoPendente(pedidoId, req.user.id);
    console.log('[Pix debug] telefone_cliente:', pedido.telefone_cliente, '| profile.telefone:', req.user.profile?.telefone);
    const split  = calcularSplit({
      subtotal:       pedido.subtotal,
      taxaEntrega:    pedido.taxa_entrega,
      formaPagamento: 'pix',
    });

    const customerId = await criarOuBuscarCliente({
      nome:     req.user.profile.nome,
      email:    req.user.email,
      cpf,
      telefone: pedido.telefone_cliente || req.user.profile.telefone,
    });

    // Split: lojista (95% do subtotal, sem taxa) + plataforma (remainder, paga a taxa Pix)
    const splitRules = montarSplitRules({
      total:              split.total,
      valorLojista:       split.valorLojista,
      recipientIdLojista: pedido.estabelecimentos?.pagarme_recipient_id || null,
    });

    const cobranca = await criarCobrancaPix({
      total: split.total,
      orderId: pedidoId,
      customerId,
      splitRules,
    });

    await salvarCobranca(pedidoId, cobranca.orderId, split);

    res.json({
      paymentId:    cobranca.orderId,
      qrCode:       cobranca.qrCode,
      qrCodeBase64: cobranca.qrCodeBase64,
      expiresAt:    cobranca.expiresAt,
      split: {
        total:           split.total,
        lojista:         split.valorLojista,
        motoboy:         split.valorMotoboy,
        plataforma:      split.valorPlataforma,
        taxaGateway:     split.taxaGateway,
        lucroPlataforma: split.lucroPlataforma,
      },
    });
  } catch (err) {
    console.error('[Pix]', err.message);
    next(err);
  }
});

// =============================================
// POST /api/payments/cartao — Cartão transparente (com gross-up D+0)
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
      cpf, postalCode, installments,
    } = req.body;

    const pedido = await buscarPedidoPendente(pedidoId, req.user.id);

    // split.total já contém o gross-up (produto + frete + taxas repassadas ao cliente)
    const split = calcularSplit({
      subtotal:       pedido.subtotal,
      taxaEntrega:    pedido.taxa_entrega,
      formaPagamento: 'cartao',
    });

    const customerId = await criarOuBuscarCliente({
      nome:     req.user.profile.nome,
      email:    req.user.email,
      cpf,
      telefone: pedido.telefone_cliente || req.user.profile.telefone,
    });

    // Lojista recebe 95% do subtotal original (sem markup de conveniência)
    // A taxa e a antecipação são cobradas do saldo da plataforma (charge_processing_fee: true)
    const splitRules = montarSplitRules({
      total:              split.total,
      valorLojista:       split.valorLojista,
      recipientIdLojista: pedido.estabelecimentos?.pagarme_recipient_id || null,
    });

    const cobranca = await criarCobrancaCartao({
      total:    split.total, // valor gross-up cobrado do cliente
      orderId:  pedidoId,
      customerId,
      creditCard: {
        holderName,
        number:      cardNumber.replace(/\D/g, ''),
        expiryMonth,
        expiryYear,
        ccv,
      },
      billingAddress: postalCode ? {
        line_1:   'Endereco nao informado',
        zip_code: postalCode.replace(/\D/g, ''),
        city:     'Guajara',
        state:    'AM',
        country:  'BR',
      } : null,
      installments: parseInt(installments || 1),
      splitRules,
    });

    await salvarCobranca(pedidoId, cobranca.orderId, split);

    const aprovado = cobranca.status === 'CONFIRMED';
    if (aprovado) await processarPagamentoAprovado(pedidoId, cobranca.orderId);

    res.json({
      status:  aprovado ? 'approved' : 'pending',
      orderId: cobranca.orderId,
      split: {
        totalCliente:    split.total,
        valorBase:       split.valorBase,
        taxaConveniencia: split.taxaConveniencia,
        lojista:         split.valorLojista,
        motoboy:         split.valorMotoboy,
        lucroPlataforma: split.lucroPlataforma,
      },
    });
  } catch (err) {
    console.error('[Cartão]', err.message);
    next(err);
  }
});

// =============================================
// POST /api/payments/webhook — Notificações Pagar.me
// =============================================
router.post('/webhook', async (req, res) => {
  if (!verificarWebhook(req)) {
    console.warn('[Webhook] Assinatura inválida');
    return res.sendStatus(401);
  }

  res.sendStatus(200); // responde imediatamente

  try {
    const { type, data } = req.body;
    console.log('[Pagar.me Webhook]', type, data?.id);

    if (!data?.id) return;
    const orderId = data.metadata?.order_id;

    if (type === 'order.paid') {
      if (!orderId) {
        console.warn('[Webhook] order.paid sem metadata.order_id:', data.id);
        return;
      }
      await processarPagamentoAprovado(orderId, data.id);

    } else if (['order.canceled', 'order.payment_failed'].includes(type)) {
      if (!orderId) return;
      await supabaseAdmin.from('pedidos')
        .update({ pagamento_status: 'cancelado', status: 'cancelado' })
        .eq('id', orderId);
    }
  } catch (err) {
    console.error('[Webhook Pagar.me]', err.message);
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
