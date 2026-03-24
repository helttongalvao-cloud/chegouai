const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');
const { calcularSplit } = require('../services/commission');
const { enviarPush } = require('./notifications');

const router = express.Router();

// =============================================
// POST /api/orders — Criar novo pedido
// =============================================
router.post(
  '/',
  requireAuth,
  [
    body('estabelecimentoId').isUUID().withMessage('Estabelecimento inválido'),
    body('itens')
      .isArray({ min: 1 })
      .withMessage('Pedido deve ter pelo menos 1 item'),
    body('itens.*.produtoId').isUUID().withMessage('Produto inválido'),
    body('itens.*.quantidade').isInt({ min: 1 }).withMessage('Quantidade inválida'),
    body('enderecoEntrega')
      .trim()
      .isLength({ min: 5, max: 300 })
      .withMessage('Endereço inválido')
      .escape(),
    body('telefoneCliente')
      .matches(/^\d{10,11}$/)
      .withMessage('Telefone inválido'),
    body('formaPagamento')
      .isIn(['pix', 'cartao'])
      .withMessage('Forma de pagamento inválida'),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { estabelecimentoId, itens, enderecoEntrega, telefoneCliente, formaPagamento } = req.body;
    const clienteId = req.user.id;

    try {
      // 1. Validar estabelecimento
      const { data: est, error: estErr } = await supabaseAdmin
        .from('estabelecimentos')
        .select('id, nome, aberto, taxa_entrega, cadastro_data, ativo, user_id')
        .eq('id', estabelecimentoId)
        .eq('ativo', true)
        .single();

      if (estErr || !est) {
        return res.status(404).json({ error: 'Estabelecimento não encontrado' });
      }
      if (!est.aberto) {
        return res.status(400).json({ error: 'Estabelecimento fechado no momento' });
      }

      // 2. Validar e buscar produtos
      const produtosIds = itens.map((i) => i.produtoId);
      const { data: produtos, error: prodErr } = await supabaseAdmin
        .from('produtos')
        .select('id, nome, preco, disponivel')
        .in('id', produtosIds)
        .eq('estabelecimento_id', estabelecimentoId)
        .eq('disponivel', true);

      if (prodErr || produtos.length !== produtosIds.length) {
        return res.status(400).json({
          error: 'Um ou mais produtos não encontrados ou indisponíveis',
        });
      }

      // 3. Calcular subtotal
      const produtosMap = Object.fromEntries(produtos.map((p) => [p.id, p]));
      let subtotal = 0;
      const itensPedido = itens.map((item) => {
        const produto = produtosMap[item.produtoId];
        const itemTotal = parseFloat((produto.preco * item.quantidade).toFixed(2));
        subtotal += itemTotal;
        return {
          produto_id: item.produtoId,
          nome: produto.nome,
          preco_unitario: produto.preco,
          quantidade: item.quantidade,
          subtotal: itemTotal,
        };
      });
      subtotal = parseFloat(subtotal.toFixed(2));

      // 4. Calcular split (incluindo comissão)
      const split = calcularSplit({
        subtotal,
        taxaEntrega: est.taxa_entrega,
        cadastroData: est.cadastro_data,
      });

      // 5. Criar pedido (Usar a taxa informada pelo cliente, se for menor ou igual à da loja, ou validá-la. Para simplificar no MVP, aceitar a taxa enviada ou fallback)
      const taxaFinal = req.body.taxaEntrega !== undefined ? parseFloat(req.body.taxaEntrega) : split.taxaEntrega;
      const totalFinal = parseFloat((subtotal + taxaFinal).toFixed(2));
      
      const { data: pedido, error: pedidoErr } = await supabaseAdmin
        .from('pedidos')
        .insert({
          cliente_id: clienteId,
          estabelecimento_id: estabelecimentoId,
          status: 'pendente',
          endereco_entrega: enderecoEntrega,
          telefone_cliente: telefoneCliente,
          subtotal,
          taxa_entrega: taxaFinal,
          comissao_plataforma: split.valorPlataforma,
          total: totalFinal,
          forma_pagamento: formaPagamento,
          pagamento_status: 'pendente',
        })
        .select()
        .single();

      if (pedidoErr) throw pedidoErr;

      // 6. Criar itens do pedido
      const { error: itensErr } = await supabaseAdmin
        .from('itens_pedido')
        .insert(itensPedido.map((i) => ({ ...i, pedido_id: pedido.id })));

      if (itensErr) throw itensErr;

      // 7. Notificar lojista via push
      if (est.user_id) {
        enviarPush(
          est.user_id,
          '🔔 Novo pedido!',
          `R$ ${totalFinal.toFixed(2).replace('.', ',')} — ${itensPedido.map((i) => `${i.quantidade}x ${i.nome}`).join(', ')}`,
          { pedidoId: pedido.id }
        );
      }

      res.status(201).json({
        pedidoId: pedido.id,
        status: pedido.status,
        total: totalFinal,
        subtotal,
        taxaEntrega: taxaFinal,
        comissao: split.comissao,
        split: {
          lojista: split.valorLojista,
          motoboy: split.valorMotoboy,
          plataforma: split.valorPlataforma,
        },
        formaPagamento,
        mensagem: formaPagamento === 'pix'
          ? 'Pedido criado. Gere o QR Code Pix para pagar.'
          : 'Pedido criado. Redirecione para o checkout de cartão.',
      });
    } catch (err) {
      console.error('[Orders] Criar pedido:', err.message);
      next(err);
    }
  }
);

// =============================================
// GET /api/orders/available — Entregas disponíveis + ativa (motoboy)
// =============================================
router.get('/available', requireRole('motoboy'), async (req, res, next) => {
  try {
    // Buscar ID do motoboy logado
    const { data: motoboy } = await supabaseAdmin
      .from('motoboys')
      .select('id')
      .eq('user_id', req.user.id)
      .single();

    const [dispRes, ativaRes] = await Promise.all([
      // Pedidos prontos sem motoboy atribuído
      supabaseAdmin
        .from('pedidos')
        .select('id, status, total, taxa_entrega, endereco_entrega, telefone_cliente, estabelecimentos (nome, emoji)')
        .eq('status', 'pronto')
        .is('motoboy_id', null)
        .order('criado_em', { ascending: true }),

      // Entrega ativa deste motoboy (coletado)
      motoboy ? supabaseAdmin
        .from('pedidos')
        .select('id, status, total, taxa_entrega, endereco_entrega, telefone_cliente, estabelecimentos (nome, emoji)')
        .eq('status', 'coletado')
        .eq('motoboy_id', motoboy.id)
        .maybeSingle() : Promise.resolve({ data: null }),
    ]);

    res.json({
      disponiveis: dispRes.data || [],
      ativa: ativaRes.data || null,
    });
  } catch (err) {
    next(err);
  }
});

// =============================================
// GET /api/orders — Listar pedidos do cliente
// =============================================
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { status } = req.query;
    const perfil = req.user.profile.perfil;
    
    let query = supabaseAdmin
      .from('pedidos')
      .select(`
        id, status, pagamento_status, total, subtotal, taxa_entrega,
        forma_pagamento, criado_em, endereco_entrega, telefone_cliente,
        estabelecimentos (nome, emoji),
        itens_pedido (nome, quantidade, preco_unitario)
      `)
      .order('criado_em', { ascending: false })
      .limit(50);
      
    // Lógica condicional de busca:
    if (perfil === 'motoboy') {
      // Se motoboy procurar por prontos ou entregues (via query params)
      if (status) query = query.eq('status', status);
      // O endpoint motoboys que pedem entregues pega do motoboy_id
      if (status === 'entregue') {
         // Precisa do id na tabela motoboys
         const { data: mtb } = await supabaseAdmin.from('motoboys').select('id').eq('user_id', req.user.id).single();
         if(mtb) query = query.eq('motoboy_id', mtb.id);
      }
    } else {
      // Cliente normal: vê só os dele com pagamento aprovado
      query = query.eq('cliente_id', req.user.id).eq('pagamento_status', 'aprovado');
      if (status) query = query.eq('status', status);
    }

    const { data: pedidos, error } = await query;

    if (error) throw error;
    res.json(pedidos);
  } catch (err) {
    next(err);
  }
});

// =============================================
// GET /api/orders/:id — Detalhes de um pedido
// =============================================
router.get('/:id', requireAuth, [param('id').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

  try {
    const { data: pedido, error } = await supabaseAdmin
      .from('pedidos')
      .select(`
        *,
        estabelecimentos (nome, emoji, telefone),
        itens_pedido (*),
        motoboys (id, nome, telefone, lat, lng)
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !pedido) return res.status(404).json({ error: 'Pedido não encontrado' });

    // Apenas o próprio cliente ou admin/estabelecimento pode ver
    const perfil = req.user.profile.perfil;
    const isOwner = pedido.cliente_id === req.user.id;
    const isAdmin = perfil === 'admin';
    const isEstabelecimento = perfil === 'estabelecimento';

    if (!isOwner && !isAdmin && !isEstabelecimento) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    res.json(pedido);
  } catch (err) {
    next(err);
  }
});

// =============================================
// PATCH /api/orders/:id/status — Atualizar status
// (usado por estabelecimento e motoboy)
// =============================================
router.patch(
  '/:id/status',
  requireAuth,
  [
    param('id').isUUID(),
    body('status')
      .isIn(['aceito', 'preparando', 'pronto', 'coletado', 'entregue', 'cancelado'])
      .withMessage('Status inválido'),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { status } = req.body;
    const perfil = req.user.profile.perfil;
    const orderId = req.params.id;

    // Mapeamento de quem pode fazer qual transição
    const transicoesPermitidas = {
      estabelecimento: ['aceito', 'preparando', 'pronto', 'cancelado'],
      motoboy: ['coletado', 'entregue'],
      admin: ['aceito', 'preparando', 'pronto', 'coletado', 'entregue', 'cancelado'],
    };

    if (!transicoesPermitidas[perfil]?.includes(status)) {
      return res.status(403).json({ error: `Perfil ${perfil} não pode setar status ${status}` });
    }

    try {
      const { data: pedido, error } = await supabaseAdmin
        .from('pedidos')
        .update({ status, atualizado_em: new Date().toISOString() })
        .eq('id', orderId)
        .select()
        .single();

      if (error || !pedido) return res.status(404).json({ error: 'Pedido não encontrado' });

      // Notificar cliente sobre mudança de status
      const msgStatus = {
        aceito: '✅ Pedido aceito! A loja está preparando.',
        preparando: '👨‍🍳 Seu pedido está sendo preparado.',
        pronto: '📦 Pedido pronto! Aguardando motoboy.',
        coletado: '🛵 Motoboy a caminho! Acompanhe no app.',
        entregue: '🎉 Pedido entregue! Bom apetite.',
        cancelado: '❌ Seu pedido foi cancelado.',
      };
      if (pedido.cliente_id && msgStatus[status]) {
        enviarPush(pedido.cliente_id, 'Chegou Aí', msgStatus[status], { pedidoId: orderId, status });
      }

      // Ao confirmar entrega, criar repasse do motoboy automaticamente
      if (status === 'entregue' && pedido.motoboy_id) {
        await supabaseAdmin.from('repasses').insert({
          pedido_id: orderId,
          motoboy_id: pedido.motoboy_id,
          tipo: 'motoboy',
          valor: pedido.taxa_entrega || 0,
          status: 'pendente',
        });
      }

      res.json({ message: `Status atualizado para: ${status}`, pedido });
    } catch (err) {
      next(err);
    }
  }
);

// =============================================
// POST /api/orders/:id/assign-motoboy — Atribuir motoboy
// =============================================
router.post(
  '/:id/assign-motoboy',
  requireRole('motoboy', 'admin'),
  [param('id').isUUID()],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

    try {
      const perfil = req.user.profile.perfil;
      let motoboyId;

      if (perfil === 'motoboy') {
        // Motoboy se auto-atribui
        const { data: motoboy } = await supabaseAdmin
          .from('motoboys')
          .select('id')
          .eq('user_id', req.user.id)
          .single();
        if (!motoboy) return res.status(404).json({ error: 'Motoboy não encontrado' });
        motoboyId = motoboy.id;
      } else {
        // Admin atribui manualmente
        motoboyId = req.body.motoboyId;
      }

      const { data: pedido, error } = await supabaseAdmin
        .from('pedidos')
        .update({ motoboy_id: motoboyId, status: 'coletado' })
        .eq('id', req.params.id)
        .eq('status', 'pronto')  // Só pedidos prontos
        .select()
        .single();

      if (error) {
        console.error('[Assign Motoboy] Erro Supabase:', error);
        return res.status(400).json({ error: 'Erro no banco: ' + error.message });
      }
      if (!pedido) {
        return res.status(400).json({ error: 'Pedido não está pronto para coleta ou não existe' });
      }

      res.json({ message: 'Motoboy atribuído', pedido });
    } catch (err) {
      next(err);
    }
  }
);
// =============================================
// PATCH /api/orders/motoboy/disponibilidade — Motoboy altera disponibilidade
// =============================================
router.patch(
  '/motoboy/disponibilidade',
  requireAuth,
  async (req, res, next) => {
    try {
      const { disponivel } = req.body;
      const userId = req.user.id;

      const { data: motoboy } = await supabaseAdmin
        .from('motoboys')
        .select('id')
        .eq('user_id', userId)
        .single();

      if (!motoboy) return res.status(404).json({ error: 'Motoboy não encontrado' });

      await supabaseAdmin
        .from('motoboys')
        .update({ disponivel: !!disponivel })
        .eq('id', motoboy.id);

      res.json({ message: disponivel ? 'Disponível para entregas' : 'Indisponível', disponivel: !!disponivel });
    } catch (err) {
      next(err);
    }
  }
);

// =============================================
// PATCH /api/orders/motoboy/location — Atualizar GPS do Motoboy
// =============================================
router.patch('/motoboy/location', requireRole('motoboy'), async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    if(lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Coordenadas inválidas' });
    }

    const { data: motoboy } = await supabaseAdmin
      .from('motoboys')
      .update({ lat, lng })
      .eq('user_id', req.user.id)
      .select('id')
      .single();

    if (!motoboy) return res.status(404).json({ error: 'Motoboy não encontrado' });

    res.json({ message: 'Localização atualizada' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
