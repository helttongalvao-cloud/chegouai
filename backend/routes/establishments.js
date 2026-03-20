const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');
const { calcularComissao } = require('../services/commission');

const router = express.Router();

// =============================================
// GET /api/establishments — Listar (público)
// =============================================
router.get('/', async (req, res, next) => {
  try {
    const { categoria, busca } = req.query;

    let query = supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, categoria, emoji, tempo_entrega, taxa_entrega, aberto')
      .eq('ativo', true)
      .order('nome');

    if (categoria && categoria !== 'todos') {
      query = query.eq('categoria', categoria);
    }

    if (busca) {
      const termoBusca = busca.trim().slice(0, 100);
      query = query.ilike('nome', `%${termoBusca}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// =============================================
// GET /api/establishments/:id — Detalhes + cardápio
// =============================================
router.get('/:id', [param('id').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

  try {
    const { data: est, error } = await supabaseAdmin
      .from('estabelecimentos')
      .select(`
        id, nome, categoria, emoji, tempo_entrega, taxa_entrega, aberto,
        produtos (id, nome, descricao, preco, emoji, disponivel)
      `)
      .eq('id', req.params.id)
      .eq('ativo', true)
      .single();

    if (error || !est) return res.status(404).json({ error: 'Estabelecimento não encontrado' });

    // Filtrar apenas produtos disponíveis
    est.produtos = est.produtos.filter((p) => p.disponivel);

    res.json(est);
  } catch (err) {
    next(err);
  }
});

// =============================================
// GET /api/establishments/me/dashboard — Dashboard do lojista
// =============================================
router.get('/me/dashboard', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const { data: est, error: estErr } = await supabaseAdmin
      .from('estabelecimentos')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    if (estErr || !est) return res.status(404).json({ error: 'Loja não encontrada' });

    // Pedidos de hoje
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    const { data: pedidosHoje } = await supabaseAdmin
      .from('pedidos')
      .select('id, total, subtotal, comissao_plataforma, status, pagamento_status')
      .eq('estabelecimento_id', est.id)
      .gte('criado_em', hoje.toISOString())
      .eq('pagamento_status', 'aprovado') // Só conta como pedido real se foi pago
      .neq('status', 'cancelado');

    const pedidosAbertos = await supabaseAdmin
      .from('pedidos')
      .select(`
        id, status, pagamento_status, total, subtotal, taxa_entrega,
        endereco_entrega, telefone_cliente, criado_em,
        itens_pedido (nome, quantidade, preco_unitario),
        motoboys (nome, telefone)
      `)
      .eq('estabelecimento_id', est.id)
      .in('status', ['aceito', 'preparando', 'pronto']) // Exclui pendente = checkout abandonado
      .order('criado_em', { ascending: true });

    const faturamento = pedidosHoje?.reduce((s, p) => s + (p.subtotal || 0), 0) || 0;
    const comissao = calcularComissao(est.cadastro_data);

    res.json({
      estabelecimento: est,
      comissao,
      stats: {
        pedidosHoje: pedidosHoje?.length || 0,
        faturamento: parseFloat(faturamento.toFixed(2)),
        comissaoPaga: parseFloat((faturamento * comissao.taxa / 100).toFixed(2)),
        saldoLiquido: parseFloat((faturamento * (1 - comissao.taxa / 100)).toFixed(2)),
      },
      pedidosAbertos: pedidosAbertos.data || [],
    });
  } catch (err) {
    next(err);
  }
});

// =============================================
// PUT /api/establishments/me — Atualizar loja
// =============================================
router.put(
  '/me',
  requireRole('estabelecimento'),
  [
    body('nome').optional().trim().isLength({ min: 2, max: 100 }).escape(),
    body('categoria').optional().isIn(['restaurante', 'mercado', 'farmacia', 'lanche', 'bebida']),
    body('tempo_entrega').optional().trim().isLength({ max: 30 }).escape(),
    body('taxa_entrega')
      .optional()
      .isFloat({ min: 2.00, max: 4.00 })
      .withMessage('A taxa de entrega deve ser entre R$ 2,00 e R$ 4,00'),
    body('aberto').optional().isBoolean(),
    body('mp_user_id').optional().trim().isLength({ max: 50 }),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const campos = {};
    ['nome', 'categoria', 'tempo_entrega', 'aberto', 'mp_user_id'].forEach((key) => {
      if (req.body[key] !== undefined) campos[key] = req.body[key];
    });

    try {
      const { data, error } = await supabaseAdmin
        .from('estabelecimentos')
        .update(campos)
        .eq('user_id', req.user.id)
        .select()
        .single();

      if (error) throw error;
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

// =============================================
// GET /api/establishments/me/products — Cardápio
// =============================================
router.get('/me/products', requireRole('estabelecimento', 'admin'), async (req, res, next) => {
  try {
    const { data: est } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id')
      .eq('user_id', req.user.id)
      .single();

    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });

    const { data, error } = await supabaseAdmin
      .from('produtos')
      .select('*')
      .eq('estabelecimento_id', est.id)
      .order('nome');

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// =============================================
// POST /api/establishments/me/products — Adicionar produto
// =============================================
router.post(
  '/me/products',
  requireRole('estabelecimento'),
  [
    body('nome').trim().isLength({ min: 2, max: 100 }).withMessage('Nome inválido').escape(),
    body('descricao').optional().trim().isLength({ max: 300 }).escape(),
    body('preco').isFloat({ min: 0.01 }).withMessage('Preço inválido'),
    body('emoji').optional().trim().isLength({ max: 10 }),
    body('disponivel').optional().isBoolean(),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
      const { data: est } = await supabaseAdmin
        .from('estabelecimentos')
        .select('id')
        .eq('user_id', req.user.id)
        .single();

      if (!est) return res.status(404).json({ error: 'Loja não encontrada' });

      const { nome, descricao, preco, emoji, disponivel } = req.body;

      const { data, error } = await supabaseAdmin
        .from('produtos')
        .insert({
          estabelecimento_id: est.id,
          nome,
          descricao: descricao || '',
          preco: parseFloat(preco),
          emoji: emoji || '🍽️',
          disponivel: disponivel !== false,
        })
        .select()
        .single();

      if (error) throw error;
      res.status(201).json(data);
    } catch (err) {
      next(err);
    }
  }
);

// =============================================
// PUT /api/establishments/me/products/:prodId — Editar produto
// =============================================
router.put(
  '/me/products/:prodId',
  requireRole('estabelecimento'),
  [param('prodId').isUUID()],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

    try {
      const { data: est } = await supabaseAdmin
        .from('estabelecimentos')
        .select('id')
        .eq('user_id', req.user.id)
        .single();

      if (!est) return res.status(404).json({ error: 'Loja não encontrada' });

      const campos = {};
      ['nome', 'descricao', 'preco', 'emoji', 'disponivel'].forEach((key) => {
        if (req.body[key] !== undefined) campos[key] = req.body[key];
      });

      const { data, error } = await supabaseAdmin
        .from('produtos')
        .update(campos)
        .eq('id', req.params.prodId)
        .eq('estabelecimento_id', est.id)
        .select()
        .single();

      if (error || !data) return res.status(404).json({ error: 'Produto não encontrado' });
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

// =============================================
// DELETE /api/establishments/me/products/:prodId — Remover produto
// =============================================
router.delete(
  '/me/products/:prodId',
  requireRole('estabelecimento'),
  [param('prodId').isUUID()],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

    try {
      const { data: est } = await supabaseAdmin
        .from('estabelecimentos')
        .select('id')
        .eq('user_id', req.user.id)
        .single();

      const { error } = await supabaseAdmin
        .from('produtos')
        .delete()
        .eq('id', req.params.prodId)
        .eq('estabelecimento_id', est.id);

      if (error) throw error;
      res.json({ message: 'Produto removido' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
