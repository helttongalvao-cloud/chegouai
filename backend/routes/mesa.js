/**
 * mesa.js — Pedidos de salão via QR Code (sem login)
 *
 * Fluxo:
 *  1. Cliente escaneia QR → /mesa?loja=ID&mesa=N
 *  2. Vê cardápio (GET /api/mesa/:lojaId)
 *  3. Cria pedido (POST /api/mesa/order) → recebe mesaToken
 *  4. Gera Pix (POST /api/mesa/pix) com mesaToken
 *  5. Paga → webhook confirma → lojista vê no painel
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { body, param, validationResult } = require('express-validator');
const { supabaseAdmin } = require('../config/supabase');
const { calcularSplit } = require('../services/commission');
const {
  criarOuBuscarCliente,
  criarCobrancaPix,
  montarSplitRules,
} = require('../services/pagarme');
const { enviarPush } = require('./notifications');

const router = express.Router();

const MESA_SECRET = process.env.JWT_SECRET || 'chegouai-mesa-secret';

function gerarMesaToken(pedidoId) {
  return jwt.sign({ pedidoId, mesa: true }, MESA_SECRET, { expiresIn: '2h' });
}

function verificarMesaToken(token, pedidoId) {
  try {
    const payload = jwt.verify(token, MESA_SECRET);
    return payload.mesa === true && payload.pedidoId === pedidoId;
  } catch { return false; }
}

// =============================================
// GET /api/mesa/:lojaId — Cardápio público (sem auth)
// =============================================
router.get('/:lojaId', [param('lojaId').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

  try {
    const { data: est } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, categoria, emoji, taxa_entrega, aberto, foto_url, valor_minimo, horarios')
      .eq('id', req.params.lojaId)
      .eq('ativo', true)
      .single();

    if (!est) return res.status(404).json({ error: 'Estabelecimento não encontrado' });

    const { data: produtos } = await supabaseAdmin
      .from('produtos')
      .select('id, nome, descricao, preco, categoria, foto_url, disponivel')
      .eq('estabelecimento_id', req.params.lojaId)
      .eq('disponivel', true)
      .order('categoria')
      .order('nome');

    res.json({ estabelecimento: est, produtos: produtos || [] });
  } catch (err) { next(err); }
});

// =============================================
// POST /api/mesa/order — Criar pedido de salão (sem auth)
// =============================================
router.post('/order', [
  body('lojaId').isUUID().withMessage('Loja inválida'),
  body('itens').isArray({ min: 1 }).withMessage('Pedido vazio'),
  body('itens.*.produtoId').isUUID(),
  body('itens.*.quantidade').isInt({ min: 1 }),
  body('itens.*.observacao').optional().trim().isLength({ max: 200 }).escape(),
  body('numeroMesa').optional().trim().isLength({ max: 20 }).escape(),
  body('nomeCliente').optional().trim().isLength({ max: 80 }).escape(),
  body('telefone').optional().matches(/^\d{10,11}$/),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { lojaId, itens, numeroMesa, nomeCliente, telefone } = req.body;

    const { data: est } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, aberto, taxa_entrega, cadastro_data, ativo, user_id, valor_minimo, pagarme_recipient_id')
      .eq('id', lojaId)
      .eq('ativo', true)
      .single();

    if (!est) return res.status(404).json({ error: 'Estabelecimento não encontrado' });
    if (!est.aberto) return res.status(400).json({ error: 'Estabelecimento fechado no momento' });

    const produtosIds = itens.map((i) => i.produtoId);
    const { data: produtos } = await supabaseAdmin
      .from('produtos')
      .select('id, nome, preco, disponivel')
      .in('id', produtosIds)
      .eq('estabelecimento_id', lojaId)
      .eq('disponivel', true);

    if (!produtos || produtos.length !== produtosIds.length) {
      return res.status(400).json({ error: 'Um ou mais produtos indisponíveis' });
    }

    const produtosMap = Object.fromEntries(produtos.map((p) => [p.id, p]));
    let subtotal = 0;
    const itensPedido = itens.map((item) => {
      const produto = produtosMap[item.produtoId];
      const itemTotal = parseFloat((produto.preco * item.quantidade).toFixed(2));
      subtotal += itemTotal;
      const obj = {
        produto_id: item.produtoId,
        nome: produto.nome,
        preco_unitario: produto.preco,
        quantidade: item.quantidade,
        subtotal: itemTotal,
      };
      if (item.observacao) obj.observacao = item.observacao;
      return obj;
    });
    subtotal = parseFloat(subtotal.toFixed(2));

    if (est.valor_minimo && subtotal < parseFloat(est.valor_minimo)) {
      return res.status(400).json({ error: `Pedido mínimo é R$${parseFloat(est.valor_minimo).toFixed(2).replace('.', ',')}` });
    }

    const split = calcularSplit({ subtotal, taxaEntrega: 0, formaPagamento: 'pix' });
    const mesaLabel = numeroMesa ? `Mesa ${numeroMesa}` : 'Salão';

    const { data: pedido, error: pedidoErr } = await supabaseAdmin
      .from('pedidos')
      .insert({
        estabelecimento_id: lojaId,
        status: 'pendente',
        tipo_pedido: 'mesa',
        numero_mesa: numeroMesa || null,
        endereco_entrega: mesaLabel,
        telefone_cliente: telefone || null,
        subtotal,
        taxa_entrega: 0,
        comissao_plataforma: split.valorPlataforma,
        total: subtotal,
        forma_pagamento: 'pix',
        pagamento_status: 'pendente',
        nome_cliente_mesa: nomeCliente || null,
      })
      .select()
      .single();

    if (pedidoErr) throw pedidoErr;

    await supabaseAdmin.from('itens_pedido')
      .insert(itensPedido.map((i) => ({ ...i, pedido_id: pedido.id })));

    // Notificar lojista
    if (est.user_id) {
      enviarPush(
        est.user_id,
        `🔔 Pedido — ${mesaLabel}`,
        `R$ ${subtotal.toFixed(2).replace('.', ',')} — ${itensPedido.map((i) => `${i.quantidade}x ${i.nome}`).join(', ')}`,
        { pedidoId: pedido.id }
      );
    }

    const mesaToken = gerarMesaToken(pedido.id);
    res.status(201).json({ pedidoId: pedido.id, mesaToken, total: subtotal, mesa: mesaLabel });
  } catch (err) { next(err); }
});

// =============================================
// POST /api/mesa/pix — Gerar QR Code Pix (sem auth, usa mesaToken)
// =============================================
router.post('/pix', [
  body('pedidoId').isUUID(),
  body('mesaToken').notEmpty(),
  body('nomeCliente').optional().trim().isLength({ max: 80 }).escape(),
  body('telefone').optional().matches(/^\d{10,11}$/),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { pedidoId, mesaToken, nomeCliente, telefone } = req.body;

    if (!verificarMesaToken(mesaToken, pedidoId)) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    const { data: pedido } = await supabaseAdmin
      .from('pedidos')
      .select('*, estabelecimentos(nome, pagarme_recipient_id)')
      .eq('id', pedidoId)
      .eq('tipo_pedido', 'mesa')
      .eq('pagamento_status', 'pendente')
      .single();

    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });

    const split = calcularSplit({ subtotal: pedido.subtotal, taxaEntrega: 0, formaPagamento: 'pix' });

    // Cliente genérico para Pagar.me (sem CPF)
    const customerId = await criarOuBuscarCliente({
      nome: nomeCliente || pedido.nome_cliente_mesa || 'Cliente Balcão',
      email: null,
      cpf: null,
      telefone: telefone || pedido.telefone_cliente,
    });

    const splitRules = montarSplitRules({
      total: split.total,
      valorLojista: split.valorLojista,
      recipientIdLojista: pedido.estabelecimentos?.pagarme_recipient_id || null,
    });

    const cobranca = await criarCobrancaPix({
      total: split.total,
      orderId: pedidoId,
      customerId,
      splitRules,
    });

    await supabaseAdmin.from('pedidos').update({
      pagarme_order_id: cobranca.orderId,
      pagamento_status: 'aguardando',
    }).eq('id', pedidoId);

    res.json({
      qrCode: cobranca.qrCode,
      qrCodeBase64: cobranca.qrCodeBase64,
      expiresAt: cobranca.expiresAt,
      total: split.total,
    });
  } catch (err) {
    console.error('[Mesa Pix]', err.message);
    next(err);
  }
});

// =============================================
// GET /api/mesa/status/:pedidoId?token= — Verificar pagamento
// =============================================
router.get('/status/:pedidoId', [param('pedidoId').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

  const token = req.query.token;
  if (!verificarMesaToken(token, req.params.pedidoId)) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  try {
    const { data: pedido } = await supabaseAdmin
      .from('pedidos')
      .select('id, status, pagamento_status, total')
      .eq('id', req.params.pedidoId)
      .single();

    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });
    res.json(pedido);
  } catch (err) { next(err); }
});

module.exports = router;
