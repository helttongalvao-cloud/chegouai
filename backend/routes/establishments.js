const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');
const { calcularComissao } = require('../services/commission');
const { enviarPush } = require('./notifications');

const router = express.Router();

// =============================================
// GET /api/establishments/products/featured — Produtos em destaque de lojas abertas
// =============================================
router.get('/products/featured', async (req, res, next) => {
  try {
    // 1. Buscar lojas ativas com horários para calcular aberto dinamicamente
    const { data: lojas, error: eLojas } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id, aberto, pausado, horarios')
      .eq('ativo', true);

    if (eLojas) throw eLojas;

    // Mesma lógica do GET /api/establishments
    const diasMap = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
    const agoraBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Eirunepe' }));
    const diaKey = diasMap[agoraBR.getDay()];
    const minAtual = agoraBR.getHours() * 60 + agoraBR.getMinutes();

    const ids = (lojas || []).filter(est => {
      if (est.pausado) return false;
      if (est.horarios && Object.keys(est.horarios).length > 0) {
        const h = est.horarios[diaKey];
        if (h && h.abre && h.fecha) {
          const [hA, mA] = h.abre.split(':').map(Number);
          const [hF, mF] = h.fecha.split(':').map(Number);
          return minAtual >= hA * 60 + mA && minAtual < hF * 60 + mF;
        }
        return false;
      }
      return est.aberto === true;
    }).map(est => est.id);

    if (ids.length === 0) return res.json([]);

    // 2. Buscar produtos dessas lojas abertas
    const { data, error } = await supabaseAdmin
      .from('produtos')
      .select('id, nome, preco, emoji, imagem_url, estabelecimento_id, estabelecimentos(nome)')
      .eq('disponivel', true)
      .in('estabelecimento_id', ids)
      .limit(40);

    if (error) throw error;

    const embaralhados = (data || []).sort(() => Math.random() - 0.5).slice(0, 8);

    res.json(embaralhados.map(p => ({
      id: p.id,
      nome: p.nome,
      preco: p.preco,
      emoji: p.emoji || null,
      imagem_url: p.imagem_url || null,
      loja_id: p.estabelecimento_id,
      loja_nome: p.estabelecimentos?.nome || '',
    })));
  } catch (err) { next(err); }
});

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
    const { categoria, busca, cidade } = req.query;

    let query = supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, categoria, emoji, tempo_entrega, taxa_entrega, tipo_frete, frete_base, frete_por_km, aberto, lat, lng, valor_minimo, horarios, foto_url, whatsapp, pausado, criado_em, cidade, estado, cobertura')
      .eq('ativo', true)
      .order('nome');

    if (categoria && categoria !== 'todos') {
      query = query.eq('categoria', categoria);
    }

    if (busca) {
      const termoBusca = busca.trim().slice(0, 100);
      query = query.ilike('nome', `%${termoBusca}%`);
    }

    if (cidade) {
      // Lojas nacionais aparecem em qualquer cidade; locais são filtradas
      query = query.or(`cobertura.eq.nacional,cidade.ilike.${cidade.trim().slice(0, 100)}`);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Calcular aberto dinamicamente com base nos horários configurados
    const diasMap = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
    const agoraBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Eirunepe' }));
    const diaKey = diasMap[agoraBR.getDay()];
    const minAtual = agoraBR.getHours() * 60 + agoraBR.getMinutes();

    const resultado = data.map(est => {
      if (est.horarios && Object.keys(est.horarios).length > 0) {
        const h = est.horarios[diaKey];
        if (h && h.abre && h.fecha) {
          const [hA, mA] = h.abre.split(':').map(Number);
          const [hF, mF] = h.fecha.split(':').map(Number);
          est.aberto = minAtual >= hA * 60 + mA && minAtual < hF * 60 + mF;
        } else {
          // horários configurados mas hoje não tem entrada = fechado
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

// GET /api/establishments/slug/:slug — Resolve slug para dados da loja (público)
router.get('/slug/:slug', async (req, res, next) => {
  try {
    const slug = (req.params.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!slug) return res.status(400).json({ error: 'Slug inválido' });
    const { data, error } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, emoji, categoria')
      .eq('slug', slug)
      .eq('ativo', true)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Loja não encontrada' });
    res.json(data);
  } catch (err) { next(err); }
});

// =============================================
// GET /api/establishments/:estId/pedidos-operador — Pedidos abertos (modo operador)
// =============================================
router.get('/:estId/pedidos-operador', [param('estId').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { data } = await supabaseAdmin
      .from('pedidos')
      .select('id, status, total, criado_em, nome_cliente, telefone_cliente, itens_pedido(nome, quantidade)')
      .eq('estabelecimento_id', req.params.estId)
      .eq('pagamento_status', 'aprovado')
      .in('status', ['pendente', 'aceito', 'preparando', 'pronto'])
      .order('criado_em', { ascending: true });
    res.json(data || []);
  } catch (err) { next(err); }
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
        produtos (id, nome, descricao, preco, emoji, disponivel, imagem_url, categoria, unidade)
      `)
      .eq('id', req.params.id)
      .eq('ativo', true)
      .single();

    if (error || !est) return res.status(404).json({ error: 'Estabelecimento não encontrado' });

    // Calcular aberto com base em horarios se configurado
    if (est.horarios && Object.keys(est.horarios).length > 0) {
      const agoraBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Eirunepe' }));
      const diasMap = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
      const diaKey = diasMap[agoraBR.getDay()];
      const horDia = est.horarios[diaKey];
      if (horDia && horDia.abre && horDia.fecha) {
        const [hA, mA] = horDia.abre.split(':').map(Number);
        const [hF, mF] = horDia.fecha.split(':').map(Number);
        const minAtual = agoraBR.getHours() * 60 + agoraBR.getMinutes();
        const minAbre = hA * 60 + mA;
        const minFecha = hF * 60 + mF;
        est.aberto = minAtual >= minAbre && minAtual < minFecha;
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

    // Datas para filtros — meia-noite no fuso America/Eirunepe (UTC-4, sem horário de verão)
    const midnightEirunepe = (d) => {
      const dataLocal = d.toLocaleDateString('en-CA', { timeZone: 'America/Eirunepe' }); // "YYYY-MM-DD"
      return new Date(dataLocal + 'T00:00:00-04:00');
    };
    const hoje = midnightEirunepe(new Date());
    const inicioSemana = midnightEirunepe(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
    const inicioMes = (() => {
      const d = new Date();
      const ano = d.toLocaleDateString('en-CA', { timeZone: 'America/Eirunepe' }).slice(0, 7); // "YYYY-MM"
      return new Date(ano + '-01T00:00:00-04:00');
    })();

    // Todas as queries de pedidos em paralelo
    const [
      { data: pedidosHoje },
      { data: pedidosSemana },
      { data: pedidosMes },
      { data: pedidosAbertos, error: errPedidos },
      { count: totalProdutos },
    ] = await Promise.all([
      supabaseAdmin.from('pedidos')
        .select('id, subtotal, comissao_plataforma, status, pagamento_status')
        .eq('estabelecimento_id', est.id)
        .gte('criado_em', hoje.toISOString())
        .eq('pagamento_status', 'aprovado')
        .neq('status', 'cancelado'),
      supabaseAdmin.from('pedidos').select('id, subtotal')
        .eq('estabelecimento_id', est.id)
        .gte('criado_em', inicioSemana.toISOString())
        .eq('pagamento_status', 'aprovado').neq('status', 'cancelado'),
      supabaseAdmin.from('pedidos').select('id, subtotal')
        .eq('estabelecimento_id', est.id)
        .gte('criado_em', inicioMes.toISOString())
        .eq('pagamento_status', 'aprovado').neq('status', 'cancelado'),
      supabaseAdmin
      .from('pedidos')
      .select(`
        id, tipo, tipo_pedido, numero_mesa, nome_cliente_mesa, status, pagamento_status,
        cliente_id, forma_pagamento, total, subtotal, taxa_entrega,
        endereco_entrega, telefone_cliente, lista_compras, criado_em, guest_nome,
        motoboy_proprio_id, codigo_coleta,
        itens_pedido (nome, quantidade, preco_unitario, observacao, produtos(imagem_url, emoji)),
        motoboys (nome, telefone),
        motoboys_proprios (id, nome),
        profiles!pedidos_cliente_id_fkey (nome)
      `)
        .eq('estabelecimento_id', est.id)
        .in('status', ['pendente', 'aceito', 'preparando', 'pronto', 'coletado', 'saiu_para_entrega', 'entregue', 'cancelado'])
        .or('pagamento_status.eq.aprovado,tipo.eq.lista')
        .gte('criado_em', (() => {
          // Pedidos ativos: mostrar últimas 48h (cobre pedidos em andamento de ontem à noite)
          // Pedidos entregues/cancelados antigos somem depois de 48h
          return new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        })())
        .order('criado_em', { ascending: false }),
      supabaseAdmin.from('produtos').select('id', { count: 'exact', head: true }).eq('estabelecimento_id', est.id),
    ]);

    if (errPedidos) console.error('[dashboard] pedidosAbertos query error:', errPedidos);

    // Resolver nomes dos clientes logados via lookup direto (evita dependência de FK join)
    const clienteIds = [...new Set((pedidosAbertos || []).map(p => p.cliente_id).filter(Boolean))];
    let nomesMap = {};
    if (clienteIds.length > 0) {
      const { data: perfis } = await supabaseAdmin
        .from('profiles').select('id, nome').in('id', clienteIds);
      if (perfis) perfis.forEach(p => { nomesMap[p.id] = p.nome; });
    }
    const pedidosComNome = (pedidosAbertos || []).map(p => ({
      ...p,
      nome_cliente: p.guest_nome || (p.cliente_id && nomesMap[p.cliente_id]) || null,
    }));

    const faturamento = pedidosHoje?.reduce((s, p) => s + (p.subtotal || 0), 0) || 0;
    const comissao = calcularComissao(est.cadastro_data);

    res.json({
      estabelecimento: est,
      produtos: totalProdutos > 0 ? [{ id: 'placeholder' }] : [],
      comissao,
      stats: {
        pedidosHoje: pedidosHoje?.length || 0,
        faturamento: parseFloat(faturamento.toFixed(2)),
        pedidosSemana: pedidosSemana?.length || 0,
        faturamentoSemana: parseFloat(((pedidosSemana || []).reduce((s, p) => s + (p.subtotal || 0), 0)).toFixed(2)),
        pedidosMes: pedidosMes?.length || 0,
        faturamentoMes: parseFloat(((pedidosMes || []).reduce((s, p) => s + (p.subtotal || 0), 0)).toFixed(2)),
        comissaoPaga: parseFloat((faturamento * comissao.taxa / 100).toFixed(2)),
        saldoLiquido: parseFloat((faturamento * (1 - comissao.taxa / 100)).toFixed(2)),
      },
      pedidosAbertos: pedidosComNome,
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
    body('categoria').optional().isIn(['restaurante', 'mercado', 'farmacia', 'lanche', 'bebida', 'encomenda', 'loja']),
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
    body('slug').optional({ nullable: true, checkFalsy: true }).trim().matches(/^[a-z0-9-]{2,40}$/).withMessage('Link personalizado inválido (use letras minúsculas, números e hífens)'),
    body('tipo_frete').optional().isIn(['fixo', 'km']),
    body('frete_base').optional().isFloat({ min: 0, max: 100 }),
    body('frete_por_km').optional().isFloat({ min: 0, max: 50 }),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const campos = {};
    ['nome', 'emoji', 'categoria', 'tempo_entrega', 'taxa_entrega', 'valor_minimo', 'aberto', 'mp_user_id', 'whatsapp', 'horarios', 'foto_url', 'foto_capa_url', 'lat', 'lng', 'slug', 'tipo_frete', 'frete_base', 'frete_por_km'].forEach((key) => {
      if (req.body[key] !== undefined) campos[key] = req.body[key];
    });

    try {
      // Verificar estado anterior de aberto para detectar abertura e notificar favoritos
      let estaAbrindo = false;
      if (campos.aberto === true) {
        const { data: estAtual } = await supabaseAdmin
          .from('estabelecimentos').select('id, aberto').eq('user_id', req.user.id).single();
        estaAbrindo = estAtual && estAtual.aberto === false;
      }

      const { data, error } = await supabaseAdmin
        .from('estabelecimentos')
        .update(campos)
        .eq('user_id', req.user.id)
        .select()
        .single();

      if (error) throw error;

      // Notificar usuários que favoritaram esta loja quando ela abre
      if (estaAbrindo && data) {
        setImmediate(async () => {
          try {
            const { data: favs } = await supabaseAdmin
              .from('favoritos').select('user_id').eq('estabelecimento_id', data.id);
            if (favs && favs.length > 0) {
              await Promise.allSettled(favs.map(f =>
                enviarPush(f.user_id, `${data.emoji || '🏪'} ${data.nome} está aberto!`, 'Seu favorito acabou de abrir. Faça seu pedido agora!', { estId: data.id })
              ));
            }
          } catch (e) { console.error('[favoritos push]', e.message); }
        });
      }

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

    // Pagina em blocos de 100 — compatível com qualquer valor de db-max-rows no Supabase
    let todos = [];
    let from = 0;
    const PAGE = 100;
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('produtos')
        .select('*')
        .eq('estabelecimento_id', est.id)
        .order('nome')
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      todos = todos.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    res.json(todos);
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
    body('estoque').optional({ nullable: true }).isInt({ min: 0 }).withMessage('Estoque inválido'),
    body('unidade').optional().isIn(['un', 'kg']).withMessage('Unidade inválida'),
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

      const { nome, descricao, preco, preco_promocional, emoji, disponivel, categoria, imagem_url, estoque, unidade, prazo_entrega } = req.body;

      const produtoData = {
        estabelecimento_id: est.id,
        nome,
        descricao: descricao || '',
        preco: Math.round(parseFloat(preco) * 100) / 100,
        emoji: emoji || '🍽️',
        disponivel: disponivel !== false,
        unidade: unidade || 'un',
      };
      if (preco_promocional != null && preco_promocional !== '') produtoData.preco_promocional = Math.round(parseFloat(preco_promocional) * 100) / 100;
      if (categoria) produtoData.categoria = categoria;
      if (imagem_url) produtoData.imagem_url = imagem_url;
      if (estoque !== undefined) produtoData.estoque = estoque === null ? null : parseInt(estoque);
      if (prazo_entrega !== undefined) produtoData.prazo_entrega = prazo_entrega || null;

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
    if (produtos.length > 50000) {
      return res.status(400).json({ error: 'Máximo de 50.000 produtos por importação' });
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

    // Busca TODOS os nomes existentes (paginado) para evitar URL gigante com .in()
    let existentes = [];
    let from = 0;
    while (true) {
      const { data: page } = await supabaseAdmin
        .from('produtos')
        .select('nome')
        .eq('estabelecimento_id', est.id)
        .range(from, from + 99);
      if (!page || page.length === 0) break;
      existentes = existentes.concat(page);
      if (page.length < 100) break;
      from += 100;
    }
    const nomesExistentes = new Set(existentes.map(p => p.nome));
    const novos = registros.filter(r => !nomesExistentes.has(r.nome));

    if (novos.length === 0) {
      return res.json({ importados: 0, total: produtos.length, ids: [], aviso: 'Todos os produtos já existem no cardápio' });
    }

    const { data, error } = await supabaseAdmin.from('produtos').insert(novos).select('id');
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
      ['nome', 'descricao', 'preco', 'preco_promocional', 'emoji', 'disponivel', 'categoria', 'imagem_url', 'estoque', 'unidade', 'prazo_entrega'].forEach((key) => {
        if (req.body[key] !== undefined) {
          if (typeof req.body[key] === 'boolean') campos[key] = req.body[key];
          else if (req.body[key] === null || req.body[key] === '') campos[key] = null;
          else campos[key] = req.body[key];
        }
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
      .select('id, subtotal, status, criado_em, itens_pedido(nome, quantidade, preco_unitario)')
      .eq('estabelecimento_id', est.id)
      .eq('pagamento_status', 'aprovado')
      .neq('status', 'cancelado')
      .gte('criado_em', desde);

    const todos = pedidos || [];
    const entregues = todos.filter(p => p.status === 'entregue');
    const faturamento = entregues.reduce((s, p) => s + (p.subtotal || 0), 0);
    const COMISSAO = 0.05;
    const faturamento_liquido = parseFloat((faturamento * (1 - COMISSAO)).toFixed(2));

    // Gráfico diário — agrupar entregues por dia
    const graficoDias = {};
    for (let i = dias - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toLocaleDateString('pt-BR', { timeZone: 'America/Manaus', day: '2-digit', month: '2-digit' });
      graficoDias[key] = { data: key, faturamento: 0, pedidos: 0 };
    }
    entregues.forEach(p => {
      const key = new Date(p.criado_em).toLocaleDateString('pt-BR', { timeZone: 'America/Manaus', day: '2-digit', month: '2-digit' });
      if (graficoDias[key]) {
        graficoDias[key].faturamento = parseFloat((graficoDias[key].faturamento + (p.subtotal || 0)).toFixed(2));
        graficoDias[key].pedidos += 1;
      }
    });

    const contagem = {};
    todos.forEach(p => {
      (p.itens_pedido || []).forEach(item => {
        if (!contagem[item.nome]) contagem[item.nome] = { nome: item.nome, qtd: 0, preco: item.preco_unitario || 0 };
        contagem[item.nome].qtd += item.quantidade;
      });
    });
    const top_produtos = Object.values(contagem).sort((a, b) => b.qtd - a.qtd).slice(0, 5);

    res.json({
      periodo: dias,
      total_pedidos: todos.length,
      pedidos_entregues: entregues.length,
      faturamento: parseFloat(faturamento.toFixed(2)),
      faturamento_liquido,
      ticket_medio: entregues.length ? parseFloat((faturamento / entregues.length).toFixed(2)) : 0,
      top_produtos,
      grafico_dias: Object.values(graficoDias),
    });
  } catch (err) { next(err); }
});

// =============================================
// GET /api/establishments/me/relatorio/exportar — Exportar CSV
// =============================================
router.get('/me/relatorio/exportar', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const periodo = req.query.periodo || '7d';
    const formato = req.query.formato || 'csv'; // csv ou txt
    const dias = periodo === '90d' ? 90 : periodo === '30d' ? 30 : 7;
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

    const { data: est } = await supabaseAdmin
      .from('estabelecimentos').select('id, nome').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });

    const { data: pedidos } = await supabaseAdmin
      .from('pedidos')
      .select('id, subtotal, taxa_entrega, total, forma_pagamento, status, criado_em, nome_cliente, telefone_cliente, endereco_entrega, itens_pedido(nome, quantidade, preco_unitario)')
      .eq('estabelecimento_id', est.id)
      .eq('pagamento_status', 'aprovado')
      .neq('status', 'cancelado')
      .gte('criado_em', desde)
      .order('criado_em', { ascending: false });

    const COMISSAO = 0.05;
    const rows = (pedidos || []).map(p => {
      const itens = (p.itens_pedido || []).map(i => `${i.quantidade}x ${i.nome}`).join(' | ');
      const liquido = parseFloat(((p.subtotal || 0) * (1 - COMISSAO)).toFixed(2));
      const data = new Date(p.criado_em).toLocaleString('pt-BR', { timeZone: 'America/Manaus' });
      return [data, p.id.slice(0,8), p.nome_cliente || '', p.telefone_cliente || '', itens,
              p.forma_pagamento, (p.subtotal || 0).toFixed(2), (p.taxa_entrega || 0).toFixed(2),
              liquido.toFixed(2), p.status];
    });

    const header = ['Data/Hora','Pedido','Cliente','Telefone','Itens','Pagamento','Subtotal (R$)','Frete (R$)','Líquido (R$)','Status'];
    const csvLines = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    const csv = '\uFEFF' + csvLines.join('\r\n'); // BOM para Excel reconhecer UTF-8

    const nomeArquivo = `relatorio_${est.nome.replace(/\s+/g, '_')}_${periodo}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.send(csv);
  } catch (err) { next(err); }
});

// =============================================
// CAMPANHAS DE DESCONTO
// =============================================
router.get('/me/campanhas', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const { data: est } = await supabaseAdmin.from('estabelecimentos').select('id').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });
    const { data } = await supabaseAdmin.from('campanhas_estabelecimento')
      .select('*').eq('estabelecimento_id', est.id).order('criado_em', { ascending: false });
    res.json(data || []);
  } catch (err) { next(err); }
});

router.post('/me/campanhas', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const { data: est } = await supabaseAdmin.from('estabelecimentos').select('id').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });
    const { nome, tipo, valor, valor_minimo, combo_preco, kit_descricao } = req.body;
    if (!nome || !tipo) return res.status(400).json({ error: 'nome e tipo obrigatórios' });
    if (!['percentual', 'fixo', 'frete_gratis', 'combo', 'kit'].includes(tipo)) return res.status(400).json({ error: 'tipo inválido' });
    if (tipo === 'combo' && (!(parseInt(valor) >= 2) || !(parseFloat(combo_preco) > 0))) {
      return res.status(400).json({ error: 'Combo: informe quantidade mínima (≥2) e preço do combo' });
    }
    if (tipo === 'kit' && (!kit_descricao || !String(kit_descricao).trim())) {
      return res.status(400).json({ error: 'Kit: informe a descrição do que está incluído' });
    }
    if (tipo === 'kit' && !(parseFloat(combo_preco) > 0)) {
      return res.status(400).json({ error: 'Kit: informe o preço do kit' });
    }
    const { data, error } = await supabaseAdmin.from('campanhas_estabelecimento').insert({
      estabelecimento_id: est.id,
      nome: String(nome).trim().slice(0, 80),
      tipo,
      valor: parseFloat(valor) || 0,
      valor_minimo: parseFloat(valor_minimo) || 0,
      combo_preco: parseFloat(combo_preco) || 0,
      kit_descricao: kit_descricao ? String(kit_descricao).trim().slice(0, 200) : null,
      ativo: true,
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

router.put('/me/campanhas/:id', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const { data: est } = await supabaseAdmin.from('estabelecimentos').select('id').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });
    const allowed = ['nome', 'tipo', 'valor', 'valor_minimo', 'combo_preco', 'kit_descricao', 'ativo'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (updates.valor !== undefined) updates.valor = parseFloat(updates.valor) || 0;
    if (updates.valor_minimo !== undefined) updates.valor_minimo = parseFloat(updates.valor_minimo) || 0;
    if (updates.combo_preco !== undefined) updates.combo_preco = parseFloat(updates.combo_preco) || 0;
    const { data, error } = await supabaseAdmin.from('campanhas_estabelecimento')
      .update(updates).eq('id', req.params.id).eq('estabelecimento_id', est.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

router.delete('/me/campanhas/:id', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const { data: est } = await supabaseAdmin.from('estabelecimentos').select('id').eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });
    await supabaseAdmin.from('campanhas_estabelecimento').delete().eq('id', req.params.id).eq('estabelecimento_id', est.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/establishments/:estId/campanha-ativa — campanha ativa (público, para checkout)
router.get('/:estId/campanha-ativa', async (req, res, next) => {
  try {
    const { data } = await supabaseAdmin.from('campanhas_estabelecimento')
      .select('*').eq('estabelecimento_id', req.params.estId).eq('ativo', true)
      .order('criado_em', { ascending: false }).limit(1);
    res.json(data && data[0] ? data[0] : null);
  } catch (err) { next(err); }
});

// =============================================
// GET /api/establishments/me/relatorio/contador — Dados para PDF fiscal mensal
// =============================================
router.get('/me/relatorio/contador', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const mes = req.query.mes; // formato YYYY-MM
    let inicio, fim;
    if (mes && /^\d{4}-\d{2}$/.test(mes)) {
      const [ano, m] = mes.split('-').map(Number);
      inicio = new Date(ano, m - 1, 1).toISOString();
      fim = new Date(ano, m, 1).toISOString();
    } else {
      const now = new Date();
      inicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      fim = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
    }

    const { data: est } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, whatsapp, cidade, estado, categoria, slug')
      .eq('user_id', req.user.id).single();
    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });

    const { data: pedidos } = await supabaseAdmin
      .from('pedidos')
      .select('id, subtotal, taxa_entrega, total, forma_pagamento, status, criado_em, nome_cliente, telefone_cliente, itens_pedido(nome, quantidade, preco_unitario)')
      .eq('estabelecimento_id', est.id)
      .eq('pagamento_status', 'aprovado')
      .neq('status', 'cancelado')
      .gte('criado_em', inicio)
      .lt('criado_em', fim)
      .order('criado_em', { ascending: true });

    const todos = pedidos || [];
    const COMISSAO = 0.05;
    const bruto = todos.reduce((s, p) => s + (p.subtotal || 0), 0);
    const taxaPlataforma = parseFloat((bruto * COMISSAO).toFixed(2));
    const liquido = parseFloat((bruto - taxaPlataforma).toFixed(2));
    const ticketMedio = todos.length ? parseFloat((bruto / todos.length).toFixed(2)) : 0;

    const porFormaPag = {};
    todos.forEach(p => {
      const f = p.forma_pagamento || 'outro';
      if (!porFormaPag[f]) porFormaPag[f] = { count: 0, total: 0 };
      porFormaPag[f].count++;
      porFormaPag[f].total = parseFloat((porFormaPag[f].total + (p.subtotal || 0)).toFixed(2));
    });

    const produtosContagem = {};
    todos.forEach(p => {
      (p.itens_pedido || []).forEach(i => {
        if (!produtosContagem[i.nome]) produtosContagem[i.nome] = { nome: i.nome, qtd: 0, total: 0 };
        produtosContagem[i.nome].qtd += i.quantidade;
        produtosContagem[i.nome].total = parseFloat((produtosContagem[i.nome].total + (i.preco_unitario || 0) * i.quantidade).toFixed(2));
      });
    });
    const topProdutos = Object.values(produtosContagem).sort((a, b) => b.qtd - a.qtd).slice(0, 10);

    res.json({
      estabelecimento: { nome: est.nome, whatsapp: est.whatsapp, cidade: est.cidade, estado: est.estado, categoria: est.categoria },
      periodo: { mes: mes || new Date(inicio).toISOString().slice(0, 7), inicio, fim },
      resumo: { total_pedidos: todos.length, bruto: parseFloat(bruto.toFixed(2)), taxa_plataforma: taxaPlataforma, liquido, ticket_medio: ticketMedio },
      por_forma_pagamento: porFormaPag,
      top_produtos: topProdutos,
      pedidos: todos.map(p => ({
        id: p.id.slice(0, 8).toUpperCase(),
        data: new Date(p.criado_em).toLocaleString('pt-BR', { timeZone: 'America/Manaus' }),
        cliente: p.nome_cliente || '—',
        itens: (p.itens_pedido || []).map(i => `${i.quantidade}x ${i.nome}`).join(', '),
        forma_pagamento: p.forma_pagamento,
        subtotal: parseFloat((p.subtotal || 0).toFixed(2)),
        taxa_entrega: parseFloat((p.taxa_entrega || 0).toFixed(2)),
        liquido_pedido: parseFloat(((p.subtotal || 0) * (1 - COMISSAO)).toFixed(2)),
        status: p.status,
      })),
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
// PUT /api/establishments/me/pin-operador — Definir ou remover PIN do operador
// =============================================
router.put('/me/pin-operador', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    const { pin } = req.body;
    if (pin !== null && pin !== undefined && !/^\d{4}$/.test(String(pin))) {
      return res.status(400).json({ error: 'PIN deve ter exatamente 4 dígitos' });
    }
    await supabaseAdmin
      .from('estabelecimentos')
      .update({ pin_operador: pin ? String(pin) : null })
      .eq('user_id', req.user.id);
    res.json({ ok: true, pin: pin ? String(pin) : null });
  } catch (err) { next(err); }
});

// =============================================
// POST /api/establishments/:slug/operador-login — Validar PIN do operador
// =============================================
router.post('/:slug/operador-login', async (req, res, next) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN obrigatório' });

    const { data: est } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, emoji, pin_operador')
      .eq('slug', req.params.slug)
      .eq('ativo', true)
      .maybeSingle();

    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });
    if (!est.pin_operador) return res.status(403).json({ error: 'Acesso de operador não configurado' });
    if (est.pin_operador !== String(pin)) return res.status(401).json({ error: 'PIN incorreto' });

    res.json({ ok: true, estabelecimentoId: est.id, nome: est.nome, emoji: est.emoji });
  } catch (err) { next(err); }
});

// =============================================
// DELETE /api/establishments/me/telegram — Desvincular Telegram do lojista
// =============================================
router.delete('/me/telegram', requireRole('estabelecimento'), async (req, res, next) => {
  try {
    await supabaseAdmin
      .from('estabelecimentos')
      .update({ telegram_chat_id: null })
      .eq('user_id', req.user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
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
      .eq('pagamento_status', 'aprovado')
      .neq('status', 'cancelado')
      .gte('criado_em', desde)
      .order('criado_em', { ascending: false });

    // Reconciliar: criar repasses faltantes para pedidos aprovados sem entrada na tabela
    if ((pedidos || []).length > 0) {
      const pedidoIds = pedidos.map(p => p.id);
      const { data: repassesExist } = await supabaseAdmin
        .from('repasses').select('pedido_id').eq('tipo', 'lojista').in('pedido_id', pedidoIds);
      const comRepasse = new Set((repassesExist || []).map(r => r.pedido_id));
      const { calcularSplit } = require('../services/commission');
      const faltando = pedidos.filter(p => !comRepasse.has(p.id));
      if (faltando.length > 0) {
        const novos = faltando.map(p => {
          const split = calcularSplit({ subtotal: p.subtotal, taxaEntrega: p.taxa_entrega, formaPagamento: p.forma_pagamento, tipoEntrega: est.tipo_entrega });
          const rows = [{ pedido_id: p.id, tipo: 'lojista', valor: split.valorLojista, status: 'pendente' },
                        { pedido_id: p.id, tipo: 'plataforma', valor: split.valorPlataforma, status: 'pago' }];
          if (split.valorMotoboy > 0) rows.splice(1, 0, { pedido_id: p.id, tipo: 'motoboy', valor: split.valorMotoboy, status: 'pendente' });
          return rows;
        }).flat();
        await supabaseAdmin.from('repasses').insert(novos);
      }
    }

    const lista = (pedidos || []).map(p => {
      const subtotal = parseFloat(p.subtotal || 0);
      const taxa     = parseFloat(p.taxa_entrega || 0);
      const desconto = parseFloat((subtotal * COMISSAO).toFixed(2));
      // Entrega própria: lojista recebe frete para pagar o motoboy dele
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

// =============================================
// POST /api/establishments/:id/favoritar — Toggle favorito
// =============================================
router.post('/:id/favoritar', requireAuth, [param('id').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { data: existente } = await supabaseAdmin
      .from('favoritos').select('id').eq('user_id', req.user.id).eq('estabelecimento_id', req.params.id).maybeSingle();
    if (existente) {
      await supabaseAdmin.from('favoritos').delete().eq('id', existente.id);
      res.json({ favoritado: false });
    } else {
      await supabaseAdmin.from('favoritos').insert({ user_id: req.user.id, estabelecimento_id: req.params.id });
      res.json({ favoritado: true });
    }
  } catch (err) { next(err); }
});

// =============================================
// GET /api/establishments/favoritos — IDs dos favoritos do usuário
// =============================================
router.get('/favoritos/meus', requireAuth, async (req, res, next) => {
  try {
    const { data } = await supabaseAdmin
      .from('favoritos').select('estabelecimento_id').eq('user_id', req.user.id);
    res.json((data || []).map(f => f.estabelecimento_id));
  } catch (err) { next(err); }
});

// =============================================
// POST /api/establishments/leads-cidade — Lead de cidade sem cobertura
// =============================================
router.post('/leads-cidade', async (req, res, next) => {
  try {
    const { email, cidade, estado } = req.body;
    if (!email || !cidade) return res.status(400).json({ error: 'email e cidade obrigatórios' });
    const emailLimpo = String(email).trim().toLowerCase().slice(0, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLimpo)) return res.status(400).json({ error: 'email inválido' });
    await supabaseAdmin.from('leads_cidade').upsert(
      { email: emailLimpo, cidade: String(cidade).trim().slice(0, 100), estado: estado ? String(estado).trim().slice(0, 100) : null },
      { onConflict: 'email,cidade' }
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
