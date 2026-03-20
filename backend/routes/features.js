const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');

const router = express.Router();

// =============================================
// GET /api/features/historico — Histórico de pedidos do cliente
// =============================================
router.get('/historico', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .select(`
        id, status, total, forma_pagamento, criado_em, tipo, lista_compras,
        estabelecimentos (nome, emoji),
        itens_pedido (nome, quantidade, preco_unitario)
      `)
      .eq('cliente_id', userId)
      .order('criado_em', { ascending: false })
      .limit(30);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// POST /api/features/avaliar — Avaliar estabelecimento
// =============================================
router.post('/avaliar', requireAuth, [
  body('pedido_id').isUUID(),
  body('estabelecimento_id').isUUID(),
  body('nota').isInt({ min: 1, max: 5 }),
  body('comentario').optional().trim().isLength({ max: 500 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { pedido_id, estabelecimento_id, nota, comentario } = req.body;

    // Verificar se já avaliou
    const { data: existente } = await supabaseAdmin
      .from('avaliacoes')
      .select('id')
      .eq('pedido_id', pedido_id)
      .eq('cliente_id', req.user.id)
      .maybeSingle();

    if (existente) return res.status(409).json({ error: 'Você já avaliou este pedido' });

    const { data, error } = await supabaseAdmin
      .from('avaliacoes')
      .insert({
        pedido_id,
        cliente_id: req.user.id,
        estabelecimento_id,
        nota,
        comentario: comentario || '',
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// GET /api/features/avaliacoes/:estId — Média de avaliações de um estabelecimento
// =============================================
router.get('/avaliacoes/:estId', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('avaliacoes')
      .select('nota, comentario, criado_em, profiles(nome)')
      .eq('estabelecimento_id', req.params.estId)
      .order('criado_em', { ascending: false })
      .limit(20);

    if (error) throw error;

    const total = data.length;
    const media = total > 0 ? data.reduce((s, a) => s + a.nota, 0) / total : 0;

    res.json({ media: parseFloat(media.toFixed(1)), total, avaliacoes: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// POST /api/features/chat — Enviar mensagem
// =============================================
router.post('/chat', requireAuth, [
  body('pedido_id').isUUID(),
  body('texto').trim().isLength({ min: 1, max: 500 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { pedido_id, texto } = req.body;
    const perfil = req.user.profile.perfil;
    const remetente_tipo = perfil === 'estabelecimento' ? 'estabelecimento' : 'cliente';

    const { data, error } = await supabaseAdmin
      .from('mensagens')
      .insert({
        pedido_id,
        remetente_id: req.user.id,
        remetente_tipo,
        texto,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// GET /api/features/chat/:pedidoId — Buscar mensagens
// =============================================
router.get('/chat/:pedidoId', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('mensagens')
      .select('id, texto, remetente_tipo, lida, criado_em')
      .eq('pedido_id', req.params.pedidoId)
      .order('criado_em', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// POST /api/features/pedido-lista — Criar pedido tipo lista de compras
// =============================================
router.post('/pedido-lista', requireAuth, [
  body('estabelecimento_id').isUUID(),
  body('lista_compras').trim().isLength({ min: 5, max: 2000 }),
  body('endereco').trim().isLength({ min: 5 }),
  body('telefone').matches(/^\d{10,11}$/),
  body('forma_pagamento').isIn(['pix', 'cartao']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { estabelecimento_id, lista_compras, endereco, telefone, forma_pagamento } = req.body;

    // Criar pedido tipo lista (total será definido pela loja depois)
    const { data: pedido, error } = await supabaseAdmin
      .from('pedidos')
      .insert({
        cliente_id: req.user.id,
        estabelecimento_id,
        status: 'pendente',
        endereco_entrega: endereco,
        telefone_cliente: telefone,
        subtotal: 0,
        taxa_entrega: 4.00,
        comissao_plataforma: 0,
        total: 0,
        forma_pagamento,
        tipo: 'lista',
        lista_compras,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ message: 'Lista enviada ao estabelecimento!', pedido });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
