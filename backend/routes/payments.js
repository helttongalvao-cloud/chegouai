const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/security');
const { supabaseAdmin } = require('../config/supabase');
const {
  criarOuBuscarCliente,
  salvarCartaoCliente,
  criarCobrancaPix,
  criarCobrancaCartao,
  montarSplitRules,
  verificarWebhook,
} = require('../services/pagarme');
const { calcularSplit } = require('../services/commission');
const { enviarPush } = require('./notifications');
const { enviarWhatsApp, alertarAdmin } = require('../services/whatsapp');
const { enviarTelegram } = require('../services/telegram');

const router = express.Router();

// ─── Helper: buscar pedido pendente do cliente ────────────────────────────
async function buscarPedidoPendente(pedidoId, clienteId) {
  let query = supabaseAdmin
    .from('pedidos')
    .select('*, estabelecimentos(nome, pagarme_recipient_id, tipo_entrega)')
    .eq('id', pedidoId)
    .eq('pagamento_status', 'pendente');

  if (clienteId) {
    query = query.eq('cliente_id', clienteId);
  } else {
    query = query.is('cliente_id', null);
  }

  const { data: pedido, error } = await query.single();
  if (error || !pedido) throw Object.assign(new Error('Pedido não encontrado'), { status: 404 });
  return pedido;
}

// ─── Helper: salvar pagarme_order_id e valores do split ──────────────────
async function salvarCobranca(pedidoId, pagarmeOrderId, split) {
  const { error } = await supabaseAdmin.from('pedidos').update({
    pagarme_order_id: pagarmeOrderId,
    comissao_plataforma: split.valorPlataforma,
    total: split.total,
    pagamento_status: 'aguardando',
  }).eq('id', pedidoId);
  if (error) {
    console.error('[salvarCobranca] Falha ao salvar pedido', pedidoId, error.message);
    throw Object.assign(new Error('Erro ao registrar cobrança'), { status: 500 });
  }
}

// ─── Helper: processar pagamento aprovado (idempotente) ──────────────────
async function processarPagamentoAprovado(orderId, pagarmeOrderId) {
  console.log(`[Processar] Iniciando: orderId=${orderId} pagarmeId=${pagarmeOrderId}`);
  // Atomic: WHERE pagamento_status != 'aprovado' garante que apenas uma execução
  // concorrente (webhook duplicado ou cartão + webhook) insere os repasses
  const { data: pedido, error: updateError } = await supabaseAdmin
    .from('pedidos')
    .update({ pagamento_status: 'aprovado', status: 'aceito', pagarme_order_id: pagarmeOrderId })
    .eq('id', orderId)
    .neq('pagamento_status', 'aprovado')
    .select('subtotal, taxa_entrega, total, forma_pagamento, guest_nome, endereco_entrega, profiles(nome), estabelecimentos(tipo_entrega, user_id, nome, whatsapp), itens_pedido(quantidade, nome)')
    .maybeSingle();

  if (updateError) console.error(`[Processar] Erro Supabase:`, updateError.message);
  console.log(`[Processar] Update resultado: ${pedido ? 'OK' : 'null (0 linhas afetadas)'}`);

  if (!pedido) {
    console.log(`[Pagar.me] Pedido ${orderId} já processado — ignorando`);
    return;
  }

  const tipoEntrega = pedido.estabelecimentos?.tipo_entrega || 'app';
  const split = calcularSplit({
    subtotal: pedido.subtotal,
    taxaEntrega: pedido.taxa_entrega,
    formaPagamento: pedido.forma_pagamento,
    tipoEntrega,
  });

  const repasses = [
    { pedido_id: orderId, tipo: 'lojista',    valor: split.valorLojista,    status: 'pendente' },
    { pedido_id: orderId, tipo: 'plataforma', valor: split.valorPlataforma, status: 'pago' },
  ];
  if (split.valorMotoboy > 0) {
    repasses.splice(1, 0, { pedido_id: orderId, tipo: 'motoboy', valor: split.valorMotoboy, status: 'pendente' });
  }
  await supabaseAdmin.from('repasses').insert(repasses);

  // Decrementar estoque dos produtos do pedido
  const { data: itensPedido } = await supabaseAdmin
    .from('itens_pedido')
    .select('produto_id, quantidade')
    .eq('pedido_id', orderId);

  if (itensPedido?.length) {
    const prodIds = itensPedido.map(i => i.produto_id);
    const { data: prods } = await supabaseAdmin
      .from('produtos')
      .select('id, estoque')
      .in('id', prodIds)
      .not('estoque', 'is', null);

    if (prods?.length) {
      const estoqueMap = Object.fromEntries(prods.map(p => [p.id, p.estoque]));
      for (const item of itensPedido) {
        if (estoqueMap[item.produto_id] === undefined) continue;
        const novoEstoque = Math.max(estoqueMap[item.produto_id] - item.quantidade, 0);
        const update = { estoque: novoEstoque };
        if (novoEstoque === 0) update.disponivel = false;
        await supabaseAdmin
          .from('produtos')
          .update(update)
          .eq('id', item.produto_id);
      }
    }
  }

  // Notificar lojista APENAS agora que pagamento foi confirmado
  const lojistaUserId = pedido.estabelecimentos?.user_id;
  const lojaInfo = pedido.estabelecimentos;
  const valorStr = `R$ ${pedido.total?.toFixed(2).replace('.', ',')}`;
  const clienteNome = pedido.profiles?.nome || pedido.guest_nome || 'Cliente';

  if (lojistaUserId) {
    enviarPush(
      lojistaUserId,
      '🔔 Novo pedido pago!',
      `${valorStr} — pagamento confirmado`,
      { pedidoId: orderId }
    );
  }

  // WhatsApp para o lojista (número cadastrado na loja)
  if (lojaInfo?.whatsapp) {
    const itensTxt = (pedido.itens_pedido || []).map(i => `${i.quantidade}x ${i.nome}`).join(', ');
    enviarWhatsApp(
      lojaInfo.whatsapp,
      `🔔 *Novo pedido!*\n💰 ${valorStr}\n👤 ${clienteNome}\n📦 ${itensTxt || 'Ver no app'}\n🏠 ${pedido.endereco_entrega || ''}`
    );
  }

  // WhatsApp + push + Telegram para o admin
  alertarAdmin(
    `🔔 *Novo pedido pago*\n🏪 ${lojaInfo?.nome || 'Loja'}\n💰 ${valorStr}\n👤 ${clienteNome}`
  );
  enviarTelegram(`🔔 <b>Novo pedido!</b>\n🏪 ${lojaInfo?.nome || 'Loja'}\n💰 ${valorStr}\n👤 ${clienteNome}`);
  supabaseAdmin.from('profiles').select('id').eq('perfil', 'admin').then(({ data: admins }) => {
    (admins || []).forEach(a => enviarPush(a.id, `🔔 Novo pedido — ${lojaInfo?.nome || 'Loja'}`, `${valorStr} · ${clienteNome}`, { pedidoId: orderId }));
  });

  // Timer 40s: se lojista não mover para 'preparando', alertar admin
  setTimeout(async () => {
    try {
      const { data: check } = await supabaseAdmin
        .from('pedidos').select('status').eq('id', orderId).maybeSingle();
      if (check && check.status === 'aceito') {
        alertarAdmin(
          `⚠️ *Lojista não aceitou em 40s*\n🏪 ${lojaInfo?.nome || 'Loja'}\n💰 ${valorStr}\n👤 ${clienteNome}`
        );
      }
    } catch (e) {
      console.error('[Timer40s] Erro ao verificar pedido', orderId, e.message);
    }
  }, 40 * 1000);

  console.log(
    `[Pagar.me] Pedido ${orderId} aprovado` +
    ` — lojista R$${split.valorLojista}` +
    (split.valorMotoboy > 0 ? `, motoboy R$${split.valorMotoboy}` : ' (entrega própria)') +
    `, plataforma R$${split.valorPlataforma}`
  );
}

// =============================================
// POST /api/payments/pix — Gerar QR Code Pix
// =============================================
router.post('/pix', paymentLimiter, optionalAuth, [
  body('pedidoId').isUUID().withMessage('pedidoId inválido'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { pedidoId } = req.body;

    const pedido = await buscarPedidoPendente(pedidoId, req.user?.id || null);
    const split  = calcularSplit({
      subtotal:       pedido.subtotal,
      taxaEntrega:    pedido.taxa_entrega,
      formaPagamento: 'pix',
      tipoEntrega:    pedido.estabelecimentos?.tipo_entrega,
    });
    // Aplicar desconto (ex: frete grátis) ao total cobrado do cliente
    if (pedido.desconto > 0) split.total = parseFloat(Math.max(0, split.total - pedido.desconto).toFixed(2));

    const guestTel = (pedido.guest_telefone || pedido.telefone_cliente || '').replace(/\D/g, '');
    const customerId = await criarOuBuscarCliente({
      nome:     req.user ? req.user.profile.nome     : pedido.guest_nome,
      email:    req.user ? req.user.email            : `${guestTel}@guest.chegouai.com.br`,
      cpf:      req.user ? req.user.profile.cpf      : pedido.guest_cpf,
      telefone: req.user ? (pedido.telefone_cliente || req.user.profile.telefone) : guestTel,
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
// POST /api/payments/salvar-cartao — Tokeniza e salva cartão no Pagar.me
// Funciona sem conta (anonymous). Retorna card_id + metadados para o frontend guardar no localStorage.
// =============================================
router.post('/salvar-cartao', paymentLimiter, optionalAuth, [
  body('holderName').notEmpty().withMessage('Nome do titular obrigatório'),
  body('cardNumber').notEmpty().withMessage('Número do cartão obrigatório'),
  body('expiryMonth').matches(/^\d{2}$/).withMessage('Mês inválido'),
  body('expiryYear').matches(/^\d{4}$/).withMessage('Ano inválido'),
  body('cvv').matches(/^\d{3,4}$/).withMessage('CVV inválido'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { holderName, cardNumber, expiryMonth, expiryYear, cvv, customerId: existingCustomerId } = req.body;

    // Reutiliza customer_id do localStorage se disponível, senão cria cliente mínimo
    let customerId = existingCustomerId || null;
    if (!customerId) {
      const guestEmail = req.user?.email || `guest_${Date.now()}@guest.chegouai.com.br`;
      customerId = await criarOuBuscarCliente({
        nome:  holderName,
        email: guestEmail,
        cpf:   req.user?.profile?.cpf || null,
      });
    }

    const cartao = await salvarCartaoCliente(customerId, {
      holderName,
      number:      cardNumber,
      expiryMonth,
      expiryYear,
      cvv,
    });

    res.json({ ...cartao, customer_id: customerId });
  } catch (err) {
    console.error('[SalvarCartão]', err.message);
    next(err);
  }
});

// =============================================
// POST /api/payments/cartao — Cartão transparente (com gross-up D+0)
// Aceita card_id + customer_id (cartão salvo) ou dados completos do cartão
// =============================================
router.post('/cartao', paymentLimiter, optionalAuth, [
  body('pedidoId').isUUID().withMessage('pedidoId inválido'),
  // cardId OU dados completos do cartão
  body('holderName').if(body('cardId').not().exists()).notEmpty().withMessage('Nome do titular obrigatório'),
  body('cardNumber').if(body('cardId').not().exists()).notEmpty().withMessage('Número do cartão obrigatório'),
  body('expiryMonth').if(body('cardId').not().exists()).matches(/^\d{2}$/).withMessage('Mês inválido'),
  body('expiryYear').if(body('cardId').not().exists()).matches(/^\d{4}$/).withMessage('Ano inválido'),
  body('ccv').if(body('cardId').not().exists()).matches(/^\d{3,4}$/).withMessage('CVV inválido'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const {
      pedidoId, holderName, cardNumber, expiryMonth, expiryYear, ccv,
      cardId, savedCustomerId,
      postalCode, installments, cpf,
    } = req.body;

    const pedido = await buscarPedidoPendente(pedidoId, req.user?.id || null);

    const split = calcularSplit({
      subtotal:       pedido.subtotal,
      taxaEntrega:    pedido.taxa_entrega,
      formaPagamento: 'cartao',
      tipoEntrega:    pedido.estabelecimentos?.tipo_entrega,
    });
    // Aplicar desconto (ex: frete grátis) ao total cobrado do cliente
    if (pedido.desconto > 0) split.total = parseFloat(Math.max(0, split.total - pedido.desconto).toFixed(2));

    let customerId;
    if (cardId && savedCustomerId) {
      // Cartão salvo — usar customer_id do localStorage
      customerId = savedCustomerId;
    } else {
      const guestTel = (pedido.guest_telefone || pedido.telefone_cliente || '').replace(/\D/g, '');
      const cpfFinal = req.user ? req.user.profile.cpf : (pedido.guest_cpf || (cpf ? cpf.replace(/\D/g, '') : null));
      customerId = await criarOuBuscarCliente({
        nome:     req.user ? req.user.profile.nome     : pedido.guest_nome,
        email:    req.user ? req.user.email            : `${guestTel}@guest.chegouai.com.br`,
        cpf:      cpfFinal,
        telefone: req.user ? (pedido.telefone_cliente || req.user.profile.telefone) : guestTel,
      });
    }

    // Lojista recebe 95% do subtotal original (sem markup de conveniência)
    // A taxa e a antecipação são cobradas do saldo da plataforma (charge_processing_fee: true)
    const splitRules = montarSplitRules({
      total:              split.total,
      valorLojista:       split.valorLojista,
      recipientIdLojista: pedido.estabelecimentos?.pagarme_recipient_id || null,
    });

    // Juros a partir de 4x (1,99% a.m., calculado no backend por segurança)
    const nParcelas = parseInt(installments || 1);
    let totalCobranca = split.total;
    if (nParcelas >= 4) {
      const i = 0.0199;
      const parcela = split.total * (i * Math.pow(1+i, nParcelas)) / (Math.pow(1+i, nParcelas) - 1);
      const parcelaCeiling = Math.ceil(parcela * 100) / 100;
      totalCobranca = parseFloat((parcelaCeiling * nParcelas).toFixed(2));
      console.log(`[Cartão] ${nParcelas}x com juros: base R$${split.total} → total R$${totalCobranca}`);
    }

    const cobranca = await criarCobrancaCartao({
      total:    totalCobranca,
      orderId:  pedidoId,
      customerId,
      ...(cardId
        ? { cardId }
        : {
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
          }
      ),
      installments: nParcelas,
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
        // Pagar.me às vezes não inclui metadata — busca pelo pagarme_order_id
        console.warn('[Webhook] order.paid sem metadata.order_id, buscando por pagarme_order_id:', data.id);
        const { data: pedidoFallback } = await supabaseAdmin
          .from('pedidos')
          .select('id')
          .eq('pagarme_order_id', data.id)
          .in('pagamento_status', ['aguardando', 'pendente'])
          .maybeSingle();
        if (!pedidoFallback) {
          console.warn('[Webhook] Pedido não encontrado para pagarme_order_id:', data.id);
          return;
        }
        await processarPagamentoAprovado(pedidoFallback.id, data.id);
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
// Rota pública — UUID é segredo suficiente; necessário para guests
// =============================================
router.get('/status/:pedidoId', [
  param('pedidoId').isUUID(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

  try {
    const { data: pedido } = await supabaseAdmin
      .from('pedidos')
      .select('id, status, pagamento_status, total, comissao_plataforma, pagarme_order_id')
      .eq('id', req.params.pedidoId)
      .single();

    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });

    // Fallback: webhook não disparou → consulta Pagar.me diretamente
    // Aceita pagarme_order_id via query param quando salvarCobranca falhou
    const pagarmeId = pedido.pagarme_order_id || req.query.pagarmeOrderId || null;
    const statusNaoPago = ['pendente', 'aguardando'].includes(pedido.pagamento_status);
    console.log('[Status]', req.params.pedidoId, 'pag_status:', pedido.pagamento_status, 'pagarmeId:', pagarmeId ? 'SET' : 'NULL');

    if (statusNaoPago && pagarmeId) {
      try {
        const { buscarPedido } = require('../services/pagarme');
        const order = await buscarPedido(pagarmeId);
        console.log('[Status fallback] Pagar.me order status:', order.status, '| pedido:', req.params.pedidoId);
        if (order.status === 'paid') {
          console.warn('[Status fallback] ⚠️ Aprovando via polling — Pagar.me retornou paid para', pagarmeId);
          // Garantir pagarme_order_id no DB caso salvarCobranca tenha falhado
          if (!pedido.pagarme_order_id) {
            await supabaseAdmin.from('pedidos').update({ pagarme_order_id: pagarmeId }).eq('id', pedido.id);
          }
          await processarPagamentoAprovado(pedido.id, pagarmeId);
          pedido.pagamento_status = 'aprovado';
          pedido.status = 'aceito';
        }
      } catch (errPM) {
        console.error('[Status fallback Pagar.me]', errPM.message);
      }
    }

    res.json(pedido);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.processarPagamentoAprovado = processarPagamentoAprovado;
