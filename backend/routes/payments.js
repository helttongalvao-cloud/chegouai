const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/security');
const { supabaseAdmin } = require('../config/supabase');
const { criarPagamentoPix, criarPreferenciaCartao, buscarPagamento, verificarAssinaturaWebhook } = require('../services/mercadopago');
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
          estabelecimentos (nome, cadastro_data, chave_pix)
        `)
        .eq('id', pedidoId)
        .eq('cliente_id', user.id)
        .eq('pagamento_status', 'pendente')
        .single();

      if (pedidoErr || !pedido) {
        return res.status(404).json({ error: 'Pedido não encontrado ou já pago' });
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
      if (pedido.estabelecimentos.chave_pix && pedido.estabelecimentos.chave_pix.startsWith('APP_USR-')) {
        mpAccessToken = pedido.estabelecimentos.chave_pix.trim();
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
          estabelecimentos (nome, cadastro_data, chave_pix)
        `)
        .eq('id', pedidoId)
        .eq('cliente_id', user.id)
        .eq('pagamento_status', 'pendente')
        .single();

      if (pedidoErr || !pedido) {
        return res.status(404).json({ error: 'Pedido não encontrado ou já pago' });
      }

      const split = calcularSplit({
        subtotal: pedido.subtotal,
        taxaEntrega: pedido.taxa_entrega,
        cadastroData: pedido.estabelecimentos.cadastro_data,
      });

      // Sem application_fee para tokens APP_USR manuais no MVP
      let mpAccessToken = null;
      if (pedido.estabelecimentos.chave_pix && pedido.estabelecimentos.chave_pix.startsWith('APP_USR-')) {
        mpAccessToken = pedido.estabelecimentos.chave_pix.trim();
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
// POST /api/payments/webhook — Notificações MP
// =============================================
// Rota pública (MP não envia token de auth)
router.post('/webhook', async (req, res) => {
  // Responder 200 imediatamente para o MP não retentar
  res.sendStatus(200);

  try {
    if (!verificarAssinaturaWebhook(req)) {
      console.warn('[Webhook] Payload inválido recebido');
      return;
    }

    const { type, data } = req.body;

    if (type === 'payment') {
      const pagamento = await buscarPagamento(data.id);
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

  // 3. Registrar repasses (serão processados após entrega)
  await supabaseAdmin.from('repasses').insert([
    {
      pedido_id: orderId,
      tipo: 'lojista',
      valor: split.valorLojista,
      status: 'pendente',
    },
    {
      pedido_id: orderId,
      tipo: 'motoboy',
      valor: split.valorMotoboy,
      status: 'pendente',
    },
    {
      pedido_id: orderId,
      tipo: 'plataforma',
      valor: split.valorPlataforma,
      status: 'pago', // Comissão já retida no marketplace_fee
    },
  ]);

  // 4. Notificar estabelecimento via Supabase Realtime (automaticamente via DB)
  console.log(`[Webhook] Pedido ${orderId} aprovado. Split: lojista R$${split.valorLojista}, motoboy R$${split.valorMotoboy}, plataforma R$${split.valorPlataforma}`);
}

module.exports = router;
