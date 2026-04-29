/**
 * motoboyProprio.js — Tela pública do motoboy próprio do lojista
 *
 * Acesso via /motoboy?loja=:estId (sem login)
 * Segurança: UUID do estabelecimento + código de coleta/entrega
 */
const express = require('express');
const { param, body, validationResult } = require('express-validator');
const { supabaseAdmin } = require('../config/supabase');

const router = express.Router();

// =============================================
// GET /api/motoboy-proprio/:estId — Pedidos prontos e coletados
// =============================================
router.get('/:estId', [param('estId').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

  try {
    const { data: est } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, emoji, tipo_entrega')
      .eq('id', req.params.estId)
      .eq('ativo', true)
      .single();

    if (!est) return res.status(404).json({ error: 'Estabelecimento não encontrado' });
    if (est.tipo_entrega !== 'proprio') return res.status(403).json({ error: 'Este estabelecimento não usa entrega própria' });

    const { data: pedidos } = await supabaseAdmin
      .from('pedidos')
      .select('id, status, endereco_entrega, telefone_cliente, total, taxa_entrega, subtotal, codigo_coleta, criado_em, itens_pedido(nome, quantidade)')
      .eq('estabelecimento_id', req.params.estId)
      .in('status', ['pronto', 'coletado'])
      .order('criado_em', { ascending: true });

    res.json({ estabelecimento: est, pedidos: pedidos || [] });
  } catch (err) {
    next(err);
  }
});

// =============================================
// PATCH /api/motoboy-proprio/:estId/pedidos/:pedidoId/coletar
// Marca como "coletado" — sem código (motoboy é de confiança do lojista)
// =============================================
router.patch('/:estId/pedidos/:pedidoId/coletar', [
  param('estId').isUUID(),
  param('pedidoId').isUUID(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { data: pedido } = await supabaseAdmin
      .from('pedidos')
      .select('id, status')
      .eq('id', req.params.pedidoId)
      .eq('estabelecimento_id', req.params.estId)
      .single();

    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (pedido.status !== 'pronto') return res.status(400).json({ error: 'Pedido não está pronto para coleta' });

    await supabaseAdmin
      .from('pedidos')
      .update({ status: 'coletado', atualizado_em: new Date().toISOString() })
      .eq('id', req.params.pedidoId);

    res.json({ ok: true, status: 'coletado' });
  } catch (err) {
    next(err);
  }
});

// =============================================
// PATCH /api/motoboy-proprio/:estId/pedidos/:pedidoId/entregar
// Marca como "entregue" — requer 4 últimos dígitos do telefone do cliente
// =============================================
router.patch('/:estId/pedidos/:pedidoId/entregar', [
  param('estId').isUUID(),
  param('pedidoId').isUUID(),
  body('codigo').matches(/^\d{4}$/).withMessage('Informe os 4 últimos dígitos do telefone do cliente'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { data: pedido } = await supabaseAdmin
      .from('pedidos')
      .select('id, status, telefone_cliente')
      .eq('id', req.params.pedidoId)
      .eq('estabelecimento_id', req.params.estId)
      .single();

    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (pedido.status !== 'coletado') return res.status(400).json({ error: 'Pedido ainda não foi coletado' });

    const tel = (pedido.telefone_cliente || '').replace(/\D/g, '');
    if (tel.length < 4 || tel.slice(-4) !== req.body.codigo) {
      return res.status(400).json({ error: 'Código incorreto. Peça ao cliente os 4 últimos dígitos do telefone.' });
    }

    await supabaseAdmin
      .from('pedidos')
      .update({ status: 'entregue', atualizado_em: new Date().toISOString() })
      .eq('id', req.params.pedidoId);

    res.json({ ok: true, status: 'entregue' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
