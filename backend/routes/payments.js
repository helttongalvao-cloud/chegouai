const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/security');
const { supabaseAdmin } = require('../config/supabase');
const { criarPagamentoPix, criarPreferenciaCartao, criarPagamentoCartao, buscarPagamento, verificarAssinaturaWebhook } = require('../services/mercadopago');
const { calcularSplit } = require('../services/commission');

const router = express.Router();

// =============================================
// POST /api/payments/pix — Criar pagamento Pix
// =============================================
router.post(
  '/pix',
  paymentLimiter,
  requireAuth,
  [
    body('pedidoId').isUUID().withMessage('pedidoId inválido'),
    body('payerCpf')
      .optional()
      .matches(/^\d{11}$/)
      .withMessage('CPF inválido (somente dígitos, 11 caracteres)'),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { pedidoId, payerCpf } = req.body;
    const user = req.user;

    try {
      // Buscar pedido com dados do estabelecimento
      const { data: pedido, error: pedidoErr } = await supabaseAdmin
        .from('pedidos')
        .select(`
          *,
          estabelecimentos (nome, cadastro_data, mp_user_id)
        `)
        .eq('id', pedidoId)
        .eq('cliente_id', user.id)
        .eq('pagamento_status', 'pendente')
        .single();

      if (pedidoErr || !pedido) {
        return res.status(404).json({ error: 'Erro DB: ' + (pedidoErr ? pedidoErr.message : 'Pedido nulo') });
      }

      // Calcular split
      const split = calcularSplit({
        subtotal: pedido.subtotal,
        taxaEntrega: pedido.taxa_entrega,
        cadastroData: pedido.estabelecimentos.cadastro_data,
      });

      // Verifica se a loja cadastrou um Access Token para Split Automático (inicia com APP_USR-)
      let mpAccessToken = null;
      let applicationFee = 0;
      if (pedido.estabelecimentos.mp_user_id && pedido.estabelecimentos.mp_user_id.startsWith('APP_USR-')) {
        mpAccessToken = pedido.estabelecimentos.mp_user_id.trim();
        applicationFee = split.valorPlataforma + split.valorMotoboy; // Tudo que não é da loja vai pro app transferir depois
      }

      // Criar pagamento Pix no MP
      const pixData = await criarPagamentoPix({
        total: split.total,
        orderId: pedidoId,
        storeName: pedido.estabelecimentos.nome,
        payerEmail: user.email,
        payerFirstName: user.profile.nome.split(' ')[0],
        payerLastName: user.profile.nome.split(' ').slice(1).join(' ') || 'Cliente',
        payerCpf: payerCpf || '00000000000', // CPF obrigatório pelo MP em produção
        mpAccessToken,
        applicationFee,
      });

      // Salvar mp_payment_id no pedido e comissão calculada
      await supabaseAdmin
        .from('pedidos')
        .update({
          mp_payment_id: String(pixData.paymentId),
          comissao_plataforma: split.valorPlataforma,
          total: split.total,
          pagamento_status: 'aguardando',
        })
        .eq('id', pedidoId);

      res.json({
        paymentId: pixData.paymentId,
        qrCode: pixData.qrCode,
        qrCodeBase64: pixData.qrCodeBase64,
        ticketUrl: pixData.ticketUrl,
        expiresAt: pixData.expiresAt,
        split: {
          total: split.total,
          lojista: split.valorLojista,
          motoboy: split.valorMotoboy,
          plataforma: split.valorPlataforma,
          comissao: split.comissao,
        },
      });
    } catch (err) {
      console.error('[Pix]', err.message);
      next(err);
    }
  }
);

// =============================================
// POST /api/payments/cartao — Criar preferência cartão
// =============================================
router.post(
  '/cartao',
  paymentLimiter,
  requireAuth,
  [body('pedidoId').isUUID().withMessage('pedidoId inválido')],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { pedidoId } = req.body;
    const user = req.user;

    try {
      const { data: pedido, error: pedidoErr } = await supabaseAdmin
        .from('pedidos')
        .select(`
          *,
          itens_pedido (*),
          estabelecimentos (nome, cadastro_data, mp_user_id)
        `)
        .eq('id', pedidoId)
        .eq('cliente_id', user.id)
        .eq('pagamento_status', 'pendente')
        .single();

      if (pedidoErr || !pedido) {
        return res.status(404).json({ error: 'Erro DB: ' + (pedidoErr ? pedidoErr.message : 'Pedido nulo') });
      }

      const split = calcularSplit({
        subtotal: pedido.subtotal,
        taxaEntrega: pedido.taxa_entrega,
        cadastroData: pedido.estabelecimentos.cadastro_data,
      });

      // Sem application_fee para tokens APP_USR manuais no MVP
      let mpAccessToken = null;
      if (pedido.estabelecimentos.mp_user_id && pedido.estabelecimentos.mp_user_id.startsWith('APP_USR-')) {
        mpAccessToken = pedido.estabelecimentos.mp_user_id.trim();
      }

      const preference = await criarPreferenciaCartao({
        total: split.total,
        orderId: pedidoId,
        storeName: pedido.estabelecimentos.nome,
        items: pedido.itens_pedido.map((i) => ({
          nome: i.nome,
          quantidade: i.quantidade,
          precoUnitario: i.preco_unitario,
        })),
        payerEmail: user.email,
        backUrl: process.env.BASE_URL,
        mpAccessToken,
      });

      await supabaseAdmin
        .from('pedidos')
        .update({
          mp_preference_id: preference.preferenceId,
          comissao_plataforma: split.valorPlataforma,
          total: split.total,
          pagamento_status: 'aguardando',
        })
        .eq('id', pedidoId);

      const initPoint = process.env.NODE_ENV === 'production'
        ? preference.initPoint
        : preference.sandboxInitPoint;

      res.json({
        preferenceId: preference.preferenceId,
        initPoint,
        split: {
          total: split.total,
          lojista: split.valorLojista,
          motoboy: split.valorMotoboy,
          plataforma: split.valorPlataforma,
          comissao: split.comissao,
        },
      });
    } catch (err) {
      console.error('[Cartão]', err.message);
      next(err);
    }
  }
);

// =============================================
// POST /api/payments/cartao-brick — Pagamento direto com token MP Bricks
// =============================================
router.post(
  '/cartao-brick',
  paymentLimiter,
  requireAuth,
  [
    body('pedidoId').isUUID().withMessage('pedidoId inválido'),
    body('token').notEmpty().withMessage('token obrigatório'),
    body('installments').isInt({ min: 1, max: 12 }).withMessage('parcelas inválidas'),
    body('paymentMethodId').notEmpty().withMessage('paymentMethodId obrigatório'),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { pedidoId, token, installments, paymentMethodId, issuerId, payerCpf } = req.body;
    const user = req.user;

    try {
      const { data: pedido, error: pedidoErr } = await supabaseAdmin
        .from('pedidos')
        .select(`*, estabelecimentos (nome, cadastro_data, mp_user_id)`)
        .eq('id', pedidoId)
        .eq('cliente_id', user.id)
        .eq('pagamento_status', 'pendente')
        .single();

      if (pedidoErr || !pedido) {
        return res.status(404).json({ error: 'Pedido não encontrado' });
      }

      const split = calcularSplit({
        subtotal: pedido.subtotal,
        taxaEntrega: pedido.taxa_entrega,
        cadastroData: pedido.estabelecimentos.cadastro_data,
      });

      let mpAccessToken = null;
      let applicationFee = 0;
      if (pedido.estabelecimentos.mp_user_id && pedido.estabelecimentos.mp_user_id.startsWith('APP_USR-')) {
        mpAccessToken = pedido.estabelecimentos.mp_user_id.trim();
        applicationFee = split.valorPlataforma + split.valorMotoboy;
      }

      const nomeParts = (user.profile.nome || '').split(' ');
      const payment = await criarPagamentoCartao({
        total: split.total,
        token,
        installments: parseInt(installments, 10),
        paymentMethodId,
        issuerId: issuerId || undefined,
        orderId: pedidoId,
        storeName: pedido.estabelecimentos.nome,
        payerEmail: user.email,
        payerFirstName: nomeParts[0],
        payerLastName: nomeParts.slice(1).join(' ') || 'Cliente',
        payerCpf: payerCpf || '00000000000',
        mpAccessToken,
        applicationFee,
      });

      await supabaseAdmin
        .from('pedidos')
        .update({
          mp_payment_id: String(payment.paymentId),
          comissao_plataforma: split.valorPlataforma,
          total: split.total,
          pagamento_status: 'aguardando',
        })
        .eq('id', pedidoId);

      if (payment.status === 'approved') {
        await processarPagamentoAprovado(pedidoId, payment);
      } else if (['rejected', 'cancelled'].includes(payment.status)) {
        await supabaseAdmin
          .from('pedidos')
          .update({ pagamento_status: 'recusado', status: 'cancelado' })
          .eq('id', pedidoId);
      }

      res.json({
        status: payment.status,
        statusDetail: payment.statusDetail,
        paymentId: payment.paymentId,
      });
    } catch (err) {
      console.error('[CartãoBrick]', err.message);
      next(err);
    }
  }
);

// =============================================
// POST /api/payments/webhook — Notificações MP
// =============================================
// Rota pública (MP não envia token de auth)
router.post('/webhook', async (req, res) => {
  // Validar assinatura HMAC antes de qualquer processamento
  if (!verificarAssinaturaWebhook(req)) {
    console.warn('[Webhook] Assinatura inválida — requisição ignorada');
    return res.sendStatus(401);
  }

  // Responder 200 imediatamente para o MP não retentar
  res.sendStatus(200);

  try {
    console.log('[Webhook] Body:', JSON.stringify(req.body), '| Query:', JSON.stringify(req.query));

    // MP envia dados no body OU em query params — normalizar ambos
    const type = req.body.type || req.query.type || req.query.topic;
    const paymentId = req.body.data?.id || req.query['data.id'] || req.query.id;

    if (!type || !paymentId) {
      console.warn('[Webhook] Sem type ou paymentId');
      return;
    }

    if (type === 'payment') {
      const pagamento = await buscarPagamento(paymentId);
      const orderId = pagamento.externalReference;

      if (!orderId) return;

      if (pagamento.status === 'approved') {
        await processarPagamentoAprovado(orderId, pagamento);
      } else if (['cancelled', 'rejected'].includes(pagamento.status)) {
        await supabaseAdmin
          .from('pedidos')
          .update({ pagamento_status: 'recusado', status: 'cancelado' })
          .eq('id', orderId);
      }
    }
  } catch (err) {
    console.error('[Webhook] Erro ao processar:', err.message);
  }
});

// =============================================
// GET /api/payments/callback — Retorno do checkout MP
// =============================================
router.get('/callback', (req, res) => {
  const { status, order } = req.query;
  // Redirecionar para o app com parâmetros
  const url = `/?payment_status=${status}&order=${order}`;
  res.redirect(url);
});

// =============================================
// GET /api/payments/status/:pedidoId — Checar status
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

// =============================================
// HELPER — Processar pagamento aprovado
// =============================================
async function processarPagamentoAprovado(orderId, pagamento) {
  // 0. Idempotência — não processar se já aprovado
  const { data: pedidoAtual } = await supabaseAdmin
    .from('pedidos')
    .select('pagamento_status')
    .eq('id', orderId)
    .single();

  if (!pedidoAtual || pedidoAtual.pagamento_status === 'aprovado') {
    console.log(`[Webhook] Pedido ${orderId} já processado — ignorando duplicata`);
    return;
  }

  // 1. Atualizar status do pedido
  const { data: pedido } = await supabaseAdmin
    .from('pedidos')
    .update({
      pagamento_status: 'aprovado',
      status: 'aceito',
      mp_payment_id: String(pagamento.id),
    })
    .eq('id', orderId)
    .select('*, estabelecimentos(cadastro_data)')
    .single();

  if (!pedido) return;

  // 2. Calcular split
  const split = calcularSplit({
    subtotal: pedido.subtotal,
    taxaEntrega: pedido.taxa_entrega,
    cadastroData: pedido.estabelecimentos.cadastro_data,
  });

  // 3. Registrar repasses — lojista e plataforma criados agora, motoboy ao confirmar entrega
  await supabaseAdmin.from('repasses').insert([
    {
      pedido_id: orderId,
      estabelecimento_id: pedido.estabelecimento_id,
      tipo: 'lojista',
      valor: split.valorLojista,
      status: 'pendente',
    },
    {
      pedido_id: orderId,
      tipo: 'plataforma',
      valor: split.valorPlataforma,
      status: 'pago',
    },
  ]);

  // 4. Notificar estabelecimento via Supabase Realtime (automaticamente via DB)
  console.log(`[Webhook] Pedido ${orderId} aprovado. Split: lojista R$${split.valorLojista}, motoboy R$${split.valorMotoboy}, plataforma R$${split.valorPlataforma}`);
}

module.exports = router;
