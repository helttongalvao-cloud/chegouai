const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { optionalAuth } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/security');
const { supabaseAdmin } = require('../config/supabase');
const {
  criarPagamentoPix,
  criarPagamentoCartao,
  buscarPagamento,
  verificarAssinaturaWebhook,
} = require('../services/mercadopago');
const { calcularSplit } = require('../services/commission');
const { enviarPush } = require('./notifications');
const { enviarWhatsApp, alertarAdmin } = require('../services/whatsapp');
const { enviarTelegram } = require('../services/telegram');

const router = express.Router();

function validarCPFBackend(cpf) {
  if (!cpf) return false;
  cpf = cpf.replace(/\D/g, '');
  return cpf.length === 11 && !/^(\d)\1+$/.test(cpf);
}

// ─── Helper: buscar pedido pendente ──────────────────────────────────────────
async function buscarPedidoPendente(pedidoId, clienteId) {
  let query = supabaseAdmin
    .from('pedidos')
    .select('*, estabelecimentos(nome, tipo_entrega)')
    .eq('id', pedidoId)
    .in('pagamento_status', ['pendente', 'aguardando']);

  if (clienteId) {
    query = query.eq('cliente_id', clienteId);
  } else {
    query = query.is('cliente_id', null);
  }

  const { data: pedido, error } = await query.single();
  if (error || !pedido) throw Object.assign(new Error('Pedido não encontrado ou já foi pago'), { status: 404 });
  return pedido;
}

// ─── Helper: salvar mp_payment_id e valores do split ─────────────────────────
async function salvarCobranca(pedidoId, mpPaymentId, split) {
  const { error } = await supabaseAdmin.from('pedidos').update({
    pagarme_order_id: String(mpPaymentId),
    comissao_plataforma: split.valorPlataforma,
    total: split.total,
    pagamento_status: 'aguardando',
  }).eq('id', pedidoId);
  if (error) {
    console.error('[salvarCobranca] Falha ao salvar pedido', pedidoId, error.message);
    throw Object.assign(new Error('Erro ao registrar cobrança'), { status: 500 });
  }
}

// ─── Helper: processar pagamento aprovado (idempotente) ──────────────────────
async function processarPagamentoAprovado(orderId, mpPaymentId) {
  console.log(`[Processar] Iniciando: orderId=${orderId} mpPaymentId=${mpPaymentId}`);
  const { data: pedido, error: updateError } = await supabaseAdmin
    .from('pedidos')
    .update({ pagamento_status: 'aprovado', status: 'aceito', pagarme_order_id: String(mpPaymentId) })
    .eq('id', orderId)
    .neq('pagamento_status', 'aprovado')
    .select('subtotal, taxa_entrega, total, forma_pagamento, guest_nome, endereco_entrega, profiles(nome), estabelecimentos(tipo_entrega, user_id, nome, whatsapp, telegram_chat_id, slug), itens_pedido(quantidade, nome)')
    .maybeSingle();

  if (updateError) console.error(`[Processar] Erro Supabase:`, updateError.message);
  console.log(`[Processar] Update resultado: ${pedido ? 'OK' : 'null (já processado)'}`);

  if (!pedido) {
    console.log(`[MP] Pedido ${orderId} já processado — ignorando`);
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

  // Decrementar estoque
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
        await supabaseAdmin.from('produtos').update(update).eq('id', item.produto_id);
      }
    }
  }

  const lojistaUserId = pedido.estabelecimentos?.user_id;
  const lojaInfo = pedido.estabelecimentos;
  const valorStr = `R$ ${pedido.total?.toFixed(2).replace('.', ',')}`;
  const clienteNome = pedido.profiles?.nome || pedido.guest_nome || 'Cliente';

  if (lojistaUserId) {
    enviarPush(lojistaUserId, '🔔 Novo pedido pago!', `${valorStr} — pagamento confirmado`, { pedidoId: orderId });
  }

  const itensTxt = (pedido.itens_pedido || []).map(i => `${i.quantidade}x ${i.nome}`).join(', ');
  if (lojaInfo?.whatsapp) {
    enviarWhatsApp(lojaInfo.whatsapp, `🔔 *Novo pedido!*\n💰 ${valorStr}\n👤 ${clienteNome}\n📦 ${itensTxt || 'Ver no app'}\n🏠 ${pedido.endereco_entrega || ''}`);
  }
  if (lojaInfo?.telegram_chat_id) {
    const linkLoja = lojaInfo.slug ? `https://chegouaiapp.com.br/${lojaInfo.slug}` : 'https://chegouaiapp.com.br/app';
    const { enviarTelegramChatId } = require('../services/telegram');
    enviarTelegramChatId(lojaInfo.telegram_chat_id,
      `🔔 <b>Novo pedido!</b>\n💰 ${valorStr}\n👤 ${clienteNome}\n📦 ${itensTxt || 'Ver no app'}\n🏠 ${pedido.endereco_entrega || ''}\n\n👉 <a href="${linkLoja}">Ver pedido</a>`);
  }

  alertarAdmin(`🔔 *Novo pedido pago*\n🏪 ${lojaInfo?.nome || 'Loja'}\n💰 ${valorStr}\n👤 ${clienteNome}`);
  enviarTelegram(`🔔 <b>Novo pedido!</b>\n🏪 ${lojaInfo?.nome || 'Loja'}\n💰 ${valorStr}\n👤 ${clienteNome}`);
  supabaseAdmin.from('profiles').select('id').eq('perfil', 'admin').then(({ data: admins }) => {
    (admins || []).forEach(a => enviarPush(a.id, `🔔 Novo pedido — ${lojaInfo?.nome || 'Loja'}`, `${valorStr} · ${clienteNome}`, { pedidoId: orderId }));
  });

  setTimeout(async () => {
    try {
      const { data: check } = await supabaseAdmin.from('pedidos').select('status').eq('id', orderId).maybeSingle();
      if (check && check.status === 'aceito') {
        alertarAdmin(`⚠️ *Lojista não aceitou em 40s*\n🏪 ${lojaInfo?.nome || 'Loja'}\n💰 ${valorStr}\n👤 ${clienteNome}`);
      }
    } catch (e) { console.error('[Timer40s]', e.message); }
  }, 40 * 1000);

  console.log(`[MP] Pedido ${orderId} aprovado — lojista R$${split.valorLojista}, plataforma R$${split.valorPlataforma}`);
}

// =============================================
// POST /api/payments/pix — Gerar QR Code Pix (Mercado Pago)
// =============================================
router.post('/pix', paymentLimiter, optionalAuth, [
  body('pedidoId').isUUID().withMessage('pedidoId inválido'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { pedidoId } = req.body;
    const pedido = await buscarPedidoPendente(pedidoId, req.user?.id || null);

    // Se já tem Pix gerado aguardando, rebuscar status no MP
    if (pedido.pagamento_status === 'aguardando' && pedido.pagarme_order_id) {
      try {
        const pagMP = await buscarPagamento(pedido.pagarme_order_id);
        if (pagMP.status === 'approved') {
          await processarPagamentoAprovado(pedidoId, pedido.pagarme_order_id);
          return res.json({ paymentId: pedido.pagarme_order_id, status: 'aprovado' });
        }
        // Retorna o pedido como aguardando — frontend vai pedir novo Pix
      } catch (e) {
        console.warn('[Pix retry] Falha ao rebuscar MP:', e.message);
      }
      // Resetar para pendente e gerar novo Pix
      await supabaseAdmin.from('pedidos').update({ pagamento_status: 'pendente', pagarme_order_id: null }).eq('id', pedidoId);
      pedido.pagamento_status = 'pendente';
      pedido.pagarme_order_id = null;
    }

    const split = calcularSplit({
      subtotal: pedido.subtotal,
      taxaEntrega: pedido.taxa_entrega,
      formaPagamento: 'pix',
      tipoEntrega: pedido.estabelecimentos?.tipo_entrega,
    });
    if (pedido.desconto > 0) split.total = parseFloat(Math.max(0, split.total - pedido.desconto).toFixed(2));

    const guestTel = (pedido.guest_telefone || pedido.telefone_cliente || '').replace(/\D/g, '');
    const cpfBody = req.body.cpf ? String(req.body.cpf).replace(/\D/g, '') : null;
    const cpfCandidato = cpfBody || (req.user ? req.user.profile.cpf : pedido.guest_cpf) || null;
    const cpfFinal = validarCPFBackend(cpfCandidato) ? cpfCandidato : null;

    if (!cpfFinal) {
      return res.status(400).json({ error: 'CPF inválido ou ausente. Informe um CPF válido para pagar via Pix.' });
    }

    if (req.user && cpfBody && validarCPFBackend(cpfBody)) {
      supabaseAdmin.from('profiles').update({ cpf: cpfBody }).eq('id', req.user.id).then(() => {}).catch(() => {});
    }

    const nomeCompleto = (req.user ? req.user.profile.nome : pedido.guest_nome) || 'Cliente';
    const partes = nomeCompleto.trim().split(' ');
    const firstName = partes[0] || 'Cliente';
    const lastName = partes.slice(1).join(' ') || 'Chegô';

    const pagamento = await criarPagamentoPix({
      total: split.total,
      orderId: pedidoId,
      storeName: pedido.estabelecimentos?.nome || 'Chegô',
      payerEmail: req.user?.email || `${guestTel || cpfFinal}@guest.chegouai.com.br`,
      payerFirstName: firstName,
      payerLastName: lastName,
      payerCpf: cpfFinal,
    });

    if (!pagamento.qrCode) {
      return res.status(400).json({ error: 'Não foi possível gerar o Pix. Verifique o CPF e tente novamente.' });
    }

    await salvarCobranca(pedidoId, pagamento.paymentId, split);

    res.json({
      paymentId: String(pagamento.paymentId),
      qrCode: pagamento.qrCode,
      qrCodeBase64: pagamento.qrCodeBase64 ? `data:image/png;base64,${pagamento.qrCodeBase64}` : null,
      expiresAt: pagamento.expiresAt,
      split: {
        total: split.total,
        lojista: split.valorLojista,
        motoboy: split.valorMotoboy,
        plataforma: split.valorPlataforma,
      },
    });
  } catch (err) {
    console.error('[Pix] ERRO:', err.message);
    try { enviarTelegram(`❌ <b>Erro ao gerar Pix</b>\n<code>${err.message}</code>`); } catch (_) {}
    if (!err.status || err.status >= 500) {
      err.status = 422;
      err.message = 'Serviço de pagamento indisponível. Aguarde alguns minutos e tente novamente.';
    }
    next(err);
  }
});

// =============================================
// POST /api/payments/salvar-cartao — stub (tokenização via MP SDK no frontend)
// =============================================
router.post('/salvar-cartao', paymentLimiter, optionalAuth, async (req, res) => {
  // Com Mercado Pago, a tokenização do cartão ocorre no frontend via MP JS SDK.
  // Este endpoint existe apenas para compatibilidade — retorna sucesso vazio.
  res.json({ ok: true });
});

// =============================================
// POST /api/payments/cartao — Cartão via token MP Bricks
// =============================================
router.post('/cartao', paymentLimiter, optionalAuth, [
  body('pedidoId').isUUID().withMessage('pedidoId inválido'),
  body('token').notEmpty().withMessage('Token do cartão obrigatório'),
  body('paymentMethodId').notEmpty().withMessage('paymentMethodId obrigatório'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { pedidoId, token, paymentMethodId, issuerId, holderName, cpf, installments } = req.body;

    const pedido = await buscarPedidoPendente(pedidoId, req.user?.id || null);

    const split = calcularSplit({
      subtotal: pedido.subtotal,
      taxaEntrega: pedido.taxa_entrega,
      formaPagamento: 'cartao',
      tipoEntrega: pedido.estabelecimentos?.tipo_entrega,
    });
    if (pedido.desconto > 0) split.total = parseFloat(Math.max(0, split.total - pedido.desconto).toFixed(2));

    const guestTel = (pedido.guest_telefone || pedido.telefone_cliente || '').replace(/\D/g, '');
    const cpfLimpo = cpf ? cpf.replace(/\D/g, '') : null;
    const cpfCandidato = cpfLimpo || (req.user ? req.user.profile.cpf : pedido.guest_cpf) || null;
    const cpfFinal = validarCPFBackend(cpfCandidato) ? cpfCandidato : null;

    if (!cpfFinal) {
      return res.status(400).json({ error: 'CPF inválido ou ausente.' });
    }

    if (req.user && cpfLimpo && validarCPFBackend(cpfLimpo)) {
      supabaseAdmin.from('profiles').update({ cpf: cpfLimpo }).eq('id', req.user.id).then(() => {}).catch(() => {});
    }

    const nomeCompleto = holderName || (req.user ? req.user.profile.nome : pedido.guest_nome) || 'Cliente';
    const partes = nomeCompleto.trim().split(' ');
    const firstName = partes[0] || 'Cliente';
    const lastName = partes.slice(1).join(' ') || 'Chegô';

    const nParcelas = parseInt(installments || 1);
    let totalCobranca = split.total;
    if (nParcelas >= 4) {
      const i = 0.0199;
      const parcela = split.total * (i * Math.pow(1 + i, nParcelas)) / (Math.pow(1 + i, nParcelas) - 1);
      const parcelaCeiling = Math.ceil(parcela * 100) / 100;
      totalCobranca = parseFloat((parcelaCeiling * nParcelas).toFixed(2));
    }

    const pagamento = await criarPagamentoCartao({
      total: totalCobranca,
      token,
      installments: nParcelas,
      paymentMethodId,
      issuerId: issuerId || undefined,
      orderId: pedidoId,
      storeName: pedido.estabelecimentos?.nome || 'Chegô',
      payerEmail: req.user?.email || `${guestTel || cpfFinal}@guest.chegouai.com.br`,
      payerFirstName: firstName,
      payerLastName: lastName,
      payerCpf: cpfFinal,
    });

    await salvarCobranca(pedidoId, pagamento.paymentId, split);

    const aprovado = pagamento.status === 'approved';
    if (aprovado) await processarPagamentoAprovado(pedidoId, pagamento.paymentId);

    res.json({
      status: aprovado ? 'approved' : 'pending',
      orderId: String(pagamento.paymentId),
      split: {
        totalCliente: split.total,
        valorBase: split.valorBase,
        taxaConveniencia: split.taxaConveniencia,
        lojista: split.valorLojista,
        motoboy: split.valorMotoboy,
        lucroPlataforma: split.lucroPlataforma,
      },
    });
  } catch (err) {
    console.error('[Cartão MP]', err.message);
    next(err);
  }
});

// =============================================
// POST /api/payments/webhook — Notificações Mercado Pago
// =============================================
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde imediatamente

  try {
    const { type, data } = req.body;
    console.log('[MP Webhook]', type, data?.id);

    if (!data?.id) return;

    // Verificar assinatura (opcional se MP_WEBHOOK_SECRET configurado)
    if (!verificarAssinaturaWebhook(req)) {
      console.warn('[Webhook] Assinatura MP inválida — ignorando');
      return;
    }

    if (type === 'payment') {
      const pagamento = await buscarPagamento(data.id);
      console.log('[MP Webhook] payment status:', pagamento.status, 'ref:', pagamento.externalReference);

      if (pagamento.status === 'approved' && pagamento.externalReference) {
        await processarPagamentoAprovado(pagamento.externalReference, data.id);
      } else if (['cancelled', 'rejected', 'refunded'].includes(pagamento.status) && pagamento.externalReference) {
        await supabaseAdmin.from('pedidos')
          .update({ pagamento_status: 'cancelado', status: 'cancelado' })
          .eq('id', pagamento.externalReference)
          .neq('pagamento_status', 'aprovado');
      }
    }
  } catch (err) {
    console.error('[Webhook MP]', err.message);
  }
});

// =============================================
// GET /api/payments/status/:pedidoId
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

    const mpPaymentId = pedido.pagarme_order_id || req.query.pagarmeOrderId || null;
    const statusNaoPago = ['pendente', 'aguardando'].includes(pedido.pagamento_status);

    if (statusNaoPago && mpPaymentId) {
      try {
        const pagMP = await buscarPagamento(mpPaymentId);
        console.log('[Status fallback] MP status:', pagMP.status, '| pedido:', req.params.pedidoId);
        if (pagMP.status === 'approved') {
          await processarPagamentoAprovado(pedido.id, mpPaymentId);
          pedido.pagamento_status = 'aprovado';
          pedido.status = 'aceito';
        }
      } catch (errMP) {
        console.error('[Status fallback MP]', errMP.message);
      }
    }

    res.json(pedido);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.processarPagamentoAprovado = processarPagamentoAprovado;
