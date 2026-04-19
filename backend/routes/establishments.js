const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');
const { calcularComissao } = require('../services/commission');

const router = express.Router();

// =============================================
// GET /api/establishments/products/search — Busca global de produtos (público)
// =============================================
router.get('/products/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) return res.json([]);

    const { data, error } = await supabaseAdmin
      .from('produtos')
      .select(`
        id, nome, descricao, preco, emoji, imagem_url, categoria,
        estabelecimentos!inner (id, nome, emoji, aberto, ativo, categoria, taxa_entrega, tempo_entrega)
      `)
      .ilike('nome', `%${q}%`)
      .eq('disponivel', true)
      .eq('estabelecimentos.ativo', true)
      .order('nome')
      .limit(40);

    if (error) throw error;

    // Retornar apenas produtos de lojas abertas
    const resultado = (data || [])
      .filter(p => p.estabelecimentos?.aberto)
      .map(p => ({
        id: p.id,
        nome: p.nome,
        descricao: p.descricao || '',
        preco: p.preco,
        emoji: p.emoji,
        imagem_url: p.imagem_url || null,
        loja: {
          id: p.estabelecimentos.id,
          nome: p.estabelecimentos.nome,
          emoji: p.estabelecimentos.emoji,
          categoria: p.estabelecimentos.categoria,
          taxa_entrega: p.estabelecimentos.taxa_entrega,
          tempo_entrega: p.estabelecimentos.tempo_entrega,
        },
      }));

    res.json(resultado);
  } catch (err) { next(err); }
});

// =============================================
// GET /api/establishments — Listar (público)
// =============================================
router.get('/', async (req, res, next) => {
  try {
    const { categoria, busca } = req.query;

    let query = supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, categoria, emoji, tempo_entrega, taxa_entrega, aberto, lat, lng, valor_minimo, horarios, foto_url, whatsapp, pausado')
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

    // Calcular aberto dinamicamente com base nos horários configurados
    const diasMap = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
    const agora = new Date();
    const diaKey = diasMap[agora.getDay()];
    const minAtual = agora.getHours() * 60 + agora.getMinutes();

    const resultado = data.map(est => {
      if (est.horarios && est.horarios[diaKey]) {
        const h = est.horarios[diaKey];
        if (h.abre && h.fecha) {
          const [hA, mA] = h.abre.split(':').map(Number);
          const [hF, mF] = h.fecha.split(':').map(Number);
          est.aberto = minAtual >= hA * 60 + mA && minAtual <= hF * 60 + mF;
        } else {
          est.aberto = false;
        }
      }
      if (est.pausado) est.aberto = false;
      return est;
    });

    res.json(resultado);
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
        id, nome, categoria, emoji, tempo_entrega, taxa_entrega, aberto, lat, lng,
        valor_minimo, horarios, foto_url, whatsapp, pausado,
        produtos (id, nome, descricao, preco, emoji, disponivel, imagem_url, categoria)
      `)
      .eq('id', req.params.id)
      .eq('ativo', true)
      .single();

    if (error || !est) return res.status(404).json({ error: 'Estabelecimento não encontrado' });

    // Calcular aberto com base em horarios se configurado
    if (est.horarios && Object.keys(est.horarios).length > 0) {
      const agora = new Date();
      const diasMap = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
      const diaKey = diasMap[agora.getDay()];
      const horDia = est.horarios[diaKey];
      if (horDia && horDia.abre && horDia.fecha) {
        const [hA, mA] = horDia.abre.split(':').map(Number);
        const [hF, mF] = horDia.fecha.split(':').map(Number);
        const minAtual = agora.getHours() * 60 + agora.getMinutes();
        const minAbre = hA * 60 + mA;
        const minFecha = hF * 60 + mF;
        est.aberto = minAtual >= minAbre && minAtual <= minFecha;
      } else {
        est.aberto = false;
      }
    }
    if (est.pausado) est.aberto = false;

    // Buscar grupos de complementos separadamente para evitar nesting de 3 níveis
    if (est.produtos && est.produtos.length > 0) {
      const prodIds = est.produtos.map(p => p.id);
      const { data: grupos } = await supabaseAdmin
        .from('grupos_complementos')
        .select('produto_id, id, nome, obrigatorio, max_escolhas, ordem, complementos(id, nome, preco_adicional, disponivel, ordem)')
        .in('produto_id', prodIds)
        .order('ordem');

      if (grupos && grupos.length > 0) {
        const gruposMap = {};
        grupos.forEach(g => {
          if (!gruposMap[g.produto_id]) gruposMap[g.produto_id] = [];
          gruposMap[g.produto_id].push(g);
        });
        est.produtos = est.produtos.map(p => ({ ...p, grupos_complementos: gruposMap[p.id] || [] }));
      }
    }

    // Ordenar: disponíveis primeiro, indisponíveis por último
    est.produtos = [...est.produtos].sort((a, b) => (b.disponivel ? 1 : 0) - (a.disponivel ? 1 : 0));

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

    const { data: pedidosAbertos, error: errPedidos } = await supabaseAdmin
      .from('pedidos')
      .select(`
        id, tipo, tipo_pedido, numero_mesa, nome_cliente_mesa, status, pagamento_status,
        forma_pagamento, total, subtotal, taxa_entrega,
        endereco_entrega, telefone_cliente, lista_compras, criado_em, guest_nome,
        motoboy_proprio_id,
        itens_pedido (nome, quantidade, preco_unitario, observacao),
        motoboys (nome, telefone),
        motoboys_proprios (id, nome),
        profiles!pedidos_cliente_id_fkey (nome)
      `)
      .eq('estabelecimento_id', est.id)
      .in('status', ['pendente', 'aceito', 'preparando', 'pronto', 'coletado', 'saiu_para_entrega', 'entregue'])
      .or('pagamento_status.eq.aprovado,tipo.eq.lista')
      .gte('criado_em', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
      .order('criado_em', { ascending: true });

    if (errPedidos) console.error('[dashboard] pedidosAbertos query error:', errPedidos);

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
      pedidosAbertos: pedidosAbertos || [],
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
    body('emoji').optional().trim().isLength({ min: 1, max: 8 }),
    body('categoria').optional().isIn(['restaurante', 'mercado', 'farmacia', 'lanche', 'bebida']),
    body('tempo_entrega').optional().trim().isLength({ max: 30 }).escape(),
    body('taxa_entrega').optional().isFloat({ min: 0, max: 50 }).withMessage('Taxa de entrega inválida'),
    body('valor_minimo').optional().isFloat({ min: 0 }).withMessage('Valor mínimo inválido'),
    body('aberto').optional().isBoolean(),
    body('mp_user_id').optional().trim().isLength({ max: 50 }),
    body('whatsapp').optional().trim().matches(/^\d{0,15}$/).withMessage('WhatsApp inválido'),
    body('horarios').optional().isObject(),
    body('foto_url').optional().trim(),
    body('lat').optional().isFloat({ min: -90, max: 90 }),
    body('lng').optional().isFloat({ min: -180, max: 180 }),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const campos = {};
    ['nome', 'emoji', 'categoria', 'tempo_entrega', 'taxa_entrega', 'valor_minimo', 'aberto', 'mp_user_id', 'whatsapp', 'horarios', 'foto_url', 'lat', 'lng'].forEach((key) => {
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
    body('categoria').optional().trim().isLength({ max: 50 }),
    body('imagem_url').optional().trim().isURL().withMessage('URL de imagem inválida'),
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

      const { nome, descricao, preco, emoji, disponivel, categoria, imagem_url } = req.body;

      const produtoData = {
        estabelecimento_id: est.id,
        nome,
        descricao: descricao || '',
        preco: Math.round(parseFloat(preco) * 100) / 100,
        emoji: emoji || '🍽️',
        disponivel: disponivel !== false,
      };
      if (categoria) produtoData.categoria = categoria;
      if (imagem_url) produtoData.imagem_url = imagem_url;

      const { data, error } = await supabaseAdmin
        .from('produtos')
        .insert(produtoData)
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
// GET /api/establishments/me/products/search-photo — Buscar foto via Open Food Facts
// =============================================
router.get('/me/products/search-photo', requireRole('estabelecimento'), async (req, res) => {
  const nome = (req.query.nome || '').trim().slice(0, 100);
  if (!nome) return res.json({ foto_url: null });

  try {
    // Tenta primeiro banco brasileiro, depois global
    const urls = [
      `https://br.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(nome)}&action=process&json=1&page_size=5&fields=product_name,image_front_url,image_url`,
      `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(nome)}&action=process&json=1&page_size=5&fields=product_name,image_front_url,image_url`,
    ];

    for (const url of urls) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(url, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'ChegouAi/1.0 (helttongalvao@gmail.com)' },
        });
        clearTimeout(timer);
        if (!r.ok) continue;
        const data = await r.json();
        const products = data.products || [];
        for (const p of products) {
          const foto = p.image_front_url || p.image_url;
          if (foto && foto.startsWith('http')) {
            return res.json({ foto_url: foto });
          }
        }
      } catch {
        clearTimeout(timer);
      }
    }
    res.json({ foto_url: null });
  } catch {
    res.json({ foto_url: null });
  }
});

// =============================================
// POST /api/establishments/me/products/import — Importar produtos via CSV/JSON
// =============================================
router.post('/me/products/import', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const { produtos } = req.body;
    if (!Array.isArray(produtos) || produtos.length === 0) {
      return res.status(400).json({ error: 'Lista de produtos inválida' });
    }
    if (produtos.length > 500) {
      return res.status(400).json({ error: 'Máximo de 500 produtos por importação' });
    }

    const { data: est } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id')
      .eq('user_id', req.user.id)
      .single();
    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });

    const registros = produtos
      .filter(p => p.nome && p.preco)
      .map(p => {
        const reg = {
          estabelecimento_id: est.id,
          nome: String(p.nome).substring(0, 100),
          descricao: p.descricao ? String(p.descricao).substring(0, 300) : '',
          preco: parseFloat(String(p.preco).replace(',', '.')) || 0,
          emoji: p.emoji ? String(p.emoji).substring(0, 10) : '🍽️',
          categoria: p.categoria ? String(p.categoria).substring(0, 50) : null,
          disponivel: true,
        };
        if (p.foto_url && String(p.foto_url).startsWith('http')) {
          reg.imagem_url = String(p.foto_url).substring(0, 500);
        }
        return reg;
      })
      .filter(p => p.preco > 0);

    if (registros.length === 0) {
      return res.status(400).json({ error: 'Nenhum produto válido encontrado no arquivo' });
    }

    const { data, error } = await supabaseAdmin.from('produtos').insert(registros).select('id');
    if (error) throw error;

    res.json({ importados: data.length, total: produtos.length, ids: data.map(p => p.id) });
  } catch (err) {
    next(err);
  }
});

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
      ['nome', 'descricao', 'preco', 'emoji', 'disponivel', 'categoria', 'imagem_url'].forEach((key) => {
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

// =============================================
// GET /api/establishments/me/relatorio
// =============================================
router.get('/me/relatorio', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const periodo = req.query.periodo || '7d';
    const dias = periodo === '90d' ? 90 : periodo === '30d' ? 30 : 7;
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

    const { data: est } = await supabaseAdmin
      .from('estabelecimentos').select('id').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });

    const { data: pedidos } = await supabaseAdmin
      .from('pedidos')
      .select('id, subtotal, status, criado_em, itens_pedido(nome, quantidade)')
      .eq('estabelecimento_id', est.id)
      .eq('pagamento_status', 'aprovado')
      .neq('status', 'cancelado')
      .gte('criado_em', desde);

    const todos = pedidos || [];
    const entregues = todos.filter(p => p.status === 'entregue');
    const faturamento = entregues.reduce((s, p) => s + (p.subtotal || 0), 0);

    const contagem = {};
    todos.forEach(p => {
      (p.itens_pedido || []).forEach(item => {
        if (!contagem[item.nome]) contagem[item.nome] = { nome: item.nome, qtd: 0 };
        contagem[item.nome].qtd += item.quantidade;
      });
    });
    const top_produtos = Object.values(contagem).sort((a, b) => b.qtd - a.qtd).slice(0, 5);

    res.json({
      periodo: dias,
      total_pedidos: todos.length,
      pedidos_entregues: entregues.length,
      faturamento: parseFloat(faturamento.toFixed(2)),
      ticket_medio: entregues.length ? parseFloat((faturamento / entregues.length).toFixed(2)) : 0,
      top_produtos,
    });
  } catch (err) { next(err); }
});

// =============================================
// POST /api/establishments/me/upload-image
// =============================================
router.post('/me/upload-image', requireAuth, requireRole('estabelecimento', 'admin'), async (req, res, next) => {
  try {
    const { base64, contentType } = req.body;
    if (!base64 || !contentType) return res.status(400).json({ error: 'Dados inválidos' });

    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(contentType)) return res.status(400).json({ error: 'Tipo de arquivo não permitido' });

    const ext = contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1];
    const filename = `${req.user.id}_${Date.now()}.${ext}`;
    const buffer = Buffer.from(base64, 'base64');

    if (buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Imagem muito grande (máx 5MB)' });

    const { error } = await supabaseAdmin.storage
      .from('produtos')
      .upload(filename, buffer, { contentType, upsert: true });

    if (error) return res.status(400).json({ error: error.message });

    const { data: { publicUrl } } = supabaseAdmin.storage.from('produtos').getPublicUrl(filename);
    res.json({ url: publicUrl });
  } catch (err) {
    next(err);
  }
});

// =============================================
// PATCH /api/establishments/me/pausar — Pausar/retomar loja
// =============================================
router.patch('/me/pausar', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const { data: est } = await supabaseAdmin.from('estabelecimentos').select('id, pausado').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Estabelecimento não encontrado' });
    const novoPausado = !est.pausado;
    await supabaseAdmin.from('estabelecimentos').update({ pausado: novoPausado }).eq('id', est.id);
    res.json({ pausado: novoPausado });
  } catch (err) { next(err); }
});

// =============================================
// COMPLEMENTOS — grupos e opções por produto
// =============================================

router.get('/me/products/:prodId/grupos', requireRole('estabelecimento'), [param('prodId').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { data: est } = await supabaseAdmin.from('estabelecimentos').select('id').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });
    const { data } = await supabaseAdmin.from('grupos_complementos')
      .select('id, nome, obrigatorio, max_escolhas, ordem, complementos(id, nome, preco_adicional, disponivel, ordem)')
      .eq('produto_id', req.params.prodId)
      .order('ordem');
    res.json(data || []);
  } catch (err) { next(err); }
});

router.post('/me/products/:prodId/grupos', requireRole('estabelecimento'), [
  param('prodId').isUUID(),
  body('nome').trim().notEmpty().withMessage('Nome do grupo obrigatório'),
  body('obrigatorio').optional().isBoolean(),
  body('max_escolhas').optional().isInt({ min: 1, max: 20 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  try {
    const { data: est } = await supabaseAdmin.from('estabelecimentos').select('id').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });
    const { data: prod } = await supabaseAdmin.from('produtos').select('id').eq('id', req.params.prodId).eq('estabelecimento_id', est.id).single();
    if (!prod) return res.status(404).json({ error: 'Produto não encontrado' });
    const { data, error } = await supabaseAdmin.from('grupos_complementos').insert({
      produto_id: req.params.prodId,
      nome: req.body.nome,
      obrigatorio: req.body.obrigatorio || false,
      max_escolhas: parseInt(req.body.max_escolhas || 1),
      ordem: 0,
    }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

router.delete('/me/grupos/:grupoId', requireRole('estabelecimento'), [param('grupoId').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { data: est } = await supabaseAdmin.from('estabelecimentos').select('id').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });
    await supabaseAdmin.from('grupos_complementos').delete().eq('id', req.params.grupoId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/me/grupos/:grupoId/complementos', requireRole('estabelecimento'), [
  param('grupoId').isUUID(),
  body('nome').trim().notEmpty().withMessage('Nome obrigatório'),
  body('preco_adicional').optional().isFloat({ min: 0 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  try {
    const { data, error } = await supabaseAdmin.from('complementos').insert({
      grupo_id: req.params.grupoId,
      nome: req.body.nome,
      preco_adicional: parseFloat(req.body.preco_adicional || 0),
      disponivel: true,
      ordem: 0,
    }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

router.delete('/me/complementos/:compId', requireRole('estabelecimento'), [param('compId').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });
  try {
    await supabaseAdmin.from('complementos').delete().eq('id', req.params.compId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =============================================
// MOTOBOYS PRÓPRIOS
// =============================================

router.get('/me/motoboys', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const { data: est } = await supabaseAdmin.from('estabelecimentos').select('id').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Estabelecimento não encontrado' });
    const { data } = await supabaseAdmin.from('motoboys_proprios').select('id, nome').eq('estabelecimento_id', est.id).eq('ativo', true).order('nome');
    res.json(data || []);
  } catch (err) { next(err); }
});

router.post('/me/motoboys', requireRole('estabelecimento'), [
  body('nome').trim().isLength({ min: 2, max: 80 }).escape().withMessage('Nome inválido'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  try {
    const { data: est } = await supabaseAdmin.from('estabelecimentos').select('id').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Estabelecimento não encontrado' });
    const { data, error } = await supabaseAdmin.from('motoboys_proprios').insert({ estabelecimento_id: est.id, nome: req.body.nome }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

router.delete('/me/motoboys/:id', requireRole('estabelecimento'), [param('id').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { data: est } = await supabaseAdmin.from('estabelecimentos').select('id').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Estabelecimento não encontrado' });
    await supabaseAdmin.from('motoboys_proprios').update({ ativo: false }).eq('id', req.params.id).eq('estabelecimento_id', est.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =============================================
// TIPO DE ENTREGA
// =============================================

router.patch('/me/tipo-entrega', requireRole('estabelecimento'), [
  body('tipo_entrega').isIn(['app', 'proprio']).withMessage('Tipo inválido'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  try {
    const { error } = await supabaseAdmin.from('estabelecimentos').update({ tipo_entrega: req.body.tipo_entrega }).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =============================================
// REPASSES MOTOBOYS PRÓPRIOS
// =============================================

// =============================================
// GET /api/establishments/me/extrato-repasse
// Extrato semanal do lojista com breakdown financeiro
// =============================================
router.get('/me/extrato-repasse', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const { data: est } = await supabaseAdmin
      .from('estabelecimentos').select('id, tipo_entrega').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });

    const COMISSAO = 0.05; // 5%
    const periodo = req.query.periodo || '7d';
    const dias = periodo === '30d' ? 30 : periodo === '14d' ? 14 : 7;
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
    const temMotoboyProprio = est.tipo_entrega === 'proprio';

    const { data: pedidos } = await supabaseAdmin
      .from('pedidos')
      .select('id, subtotal, total, taxa_entrega, status, pagamento_status, criado_em, forma_pagamento, motoboy_proprio_id, motoboys_proprios(id, nome), itens_pedido(nome, quantidade, preco_unitario)')
      .eq('estabelecimento_id', est.id)
      .in('pagamento_status', ['aprovado', 'aguardando'])
      .neq('status', 'cancelado')
      .gte('criado_em', desde)
      .order('criado_em', { ascending: false });

    const lista = (pedidos || []).map(p => {
      const subtotal = parseFloat(p.subtotal || 0);
      const taxa     = parseFloat(p.taxa_entrega || 0);
      const desconto = parseFloat((subtotal * COMISSAO).toFixed(2));
      // Motoboy próprio: lojista recebe 95% subtotal + taxa_entrega (paga o motoboy com a taxa)
      // Motoboy do app: lojista recebe somente 95% subtotal
      const liquido  = temMotoboyProprio
        ? parseFloat((subtotal - desconto + taxa).toFixed(2))
        : parseFloat((subtotal - desconto).toFixed(2));
      return {
        id: p.id,
        data: p.criado_em,
        status: p.status,
        forma_pagamento: p.forma_pagamento,
        subtotal,
        taxa_entrega: taxa,
        desconto,
        liquido,
        motoboy_proprio: p.motoboys_proprios || null,
        itens: p.itens_pedido || [],
      };
    });

    const totalBruto    = lista.reduce((s, p) => s + p.subtotal, 0);
    const totalDesconto = lista.reduce((s, p) => s + p.desconto, 0);
    const totalLiquido  = lista.reduce((s, p) => s + p.liquido, 0);

    // Breakdown por motoboy próprio (apenas se tipo_entrega === 'proprio')
    let motoboyBreakdown = null;
    if (temMotoboyProprio) {
      const mbMap = {};
      lista.forEach(p => {
        if (!p.motoboy_proprio) return;
        const id = p.motoboy_proprio.id;
        if (!mbMap[id]) mbMap[id] = { id, nome: p.motoboy_proprio.nome, entregas: 0, total: 0, fretes: [] };
        mbMap[id].entregas++;
        mbMap[id].total += p.taxa_entrega;
        mbMap[id].fretes.push(p.taxa_entrega);
      });
      motoboyBreakdown = Object.values(mbMap).map(m => ({
        id: m.id,
        nome: m.nome,
        entregas: m.entregas,
        total: parseFloat(m.total.toFixed(2)),
        fretes: m.fretes,
      }));
    }

    const totalMotoboysPagar = motoboyBreakdown
      ? motoboyBreakdown.reduce((s, m) => s + m.total, 0)
      : 0;

    res.json({
      periodo: dias,
      tipo_entrega: est.tipo_entrega,
      comissao_pct: COMISSAO * 100,
      pedidos: lista,
      resumo: {
        total_pedidos:  lista.length,
        total_bruto:    parseFloat(totalBruto.toFixed(2)),
        total_desconto: parseFloat(totalDesconto.toFixed(2)),
        total_liquido:  parseFloat(totalLiquido.toFixed(2)),
        ...(temMotoboyProprio && {
          total_motoboys_pagar: parseFloat(totalMotoboysPagar.toFixed(2)),
          lucro_liquido: parseFloat((totalLiquido - totalMotoboysPagar).toFixed(2)),
        }),
      },
      motoboys_breakdown: motoboyBreakdown,
    });
  } catch (err) { next(err); }
});

// =============================================
router.get('/me/repasses-motoboys', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const { data: est } = await supabaseAdmin.from('estabelecimentos').select('id').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Estabelecimento não encontrado' });

    const { data: pedidos } = await supabaseAdmin
      .from('pedidos')
      .select('id, taxa_entrega, motoboy_repasse_pago, motoboys_proprios(id, nome)')
      .eq('estabelecimento_id', est.id)
      .eq('status', 'entregue')
      .not('motoboy_proprio_id', 'is', null);

    // Agrupar por motoboy
    const grupos = {};
    (pedidos || []).forEach((p) => {
      const mb = p.motoboys_proprios;
      if (!mb) return;
      if (!grupos[mb.id]) grupos[mb.id] = { id: mb.id, nome: mb.nome, pendente: 0, pago: 0, pedidosPendentes: [] };
      const frete = parseFloat(p.taxa_entrega || 0);
      if (p.motoboy_repasse_pago) {
        grupos[mb.id].pago += frete;
      } else {
        grupos[mb.id].pendente += frete;
        grupos[mb.id].pedidosPendentes.push(p.id);
      }
    });

    const resultado = Object.values(grupos).map((g) => ({
      ...g,
      pendente: parseFloat(g.pendente.toFixed(2)),
      pago: parseFloat(g.pago.toFixed(2)),
    }));

    res.json(resultado);
  } catch (err) { next(err); }
});

router.post('/me/repasses-motoboys/pagar', requireRole('estabelecimento'), [
  body('motoboyId').isUUID().withMessage('ID inválido'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  try {
    const { data: est } = await supabaseAdmin.from('estabelecimentos').select('id').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Estabelecimento não encontrado' });

    await supabaseAdmin.from('pedidos')
      .update({ motoboy_repasse_pago: true })
      .eq('estabelecimento_id', est.id)
      .eq('motoboy_proprio_id', req.body.motoboyId)
      .eq('motoboy_repasse_pago', false);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
