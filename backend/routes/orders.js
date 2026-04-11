const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');
const { calcularSplit } = require('../services/commission');
const { criarTransferenciaPix } = require('../services/pagarme');
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
    body('itens.*.observacao').optional().trim().isLength({ max: 200 }).escape(),
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
    body('cupom').optional().trim().isLength({ max: 50 }).escape(),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { estabelecimentoId, itens, enderecoEntrega, telefoneCliente, formaPagamento, cupom } = req.body;
    const clienteId = req.user.id;

    try {
      // 1. Validar estabelecimento
      const { data: est, error: estErr } = await supabaseAdmin
        .from('estabelecimentos')
        .select('id, nome, aberto, taxa_entrega, cadastro_data, ativo, user_id, valor_minimo, whatsapp')
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
        const itemObj = {
          produto_id: item.produtoId,
          nome: produto.nome,
          preco_unitario: produto.preco,
          quantidade: item.quantidade,
          subtotal: itemTotal,
        };
        if (item.observacao) itemObj.observacao = item.observacao;
        return itemObj;
      });
      subtotal = parseFloat(subtotal.toFixed(2));

      // 3b. Validar valor mínimo
      if (est.valor_minimo && subtotal < parseFloat(est.valor_minimo)) {
        return res.status(400).json({
          error: `Pedido mínimo é R$${parseFloat(est.valor_minimo).toFixed(2).replace('.', ',')}`,
        });
      }

      // 4. Calcular split (incluindo comissão)
      const split = calcularSplit({
        subtotal,
        taxaEntrega: est.taxa_entrega,
        cadastroData: est.cadastro_data,
      });

      // 4b. Validar e aplicar cupom
      let desconto = 0;
      let cupomCodigo = null;
      if (cupom) {
        const { data: cupomData, error: cupomErr } = await supabaseAdmin
          .from('cupons')
          .select('*')
          .eq('codigo', cupom.toUpperCase())
          .eq('ativo', true)
          .single();

        if (cupomErr || !cupomData) {
          return res.status(400).json({ error: 'Cupom inválido ou expirado' });
        }
        if (cupomData.validade && new Date(cupomData.validade) < new Date()) {
          return res.status(400).json({ error: 'Cupom expirado' });
        }
        if (cupomData.usos_atual >= cupomData.usos_max) {
          return res.status(400).json({ error: 'Cupom esgotado' });
        }
        if (cupomData.desconto_tipo === 'percentual') {
          desconto = parseFloat((subtotal * cupomData.desconto_valor / 100).toFixed(2));
        } else {
          desconto = Math.min(parseFloat(cupomData.desconto_valor), subtotal);
        }
        cupomCodigo = cupomData.codigo;
        // Incrementar uso (não bloqueia em caso de falha)
        supabaseAdmin.from('cupons').update({ usos_atual: cupomData.usos_atual + 1 }).eq('id', cupomData.id).then(() => {});
      }

      // 5. Validar e calcular taxa de entrega final
      let taxaFinal = split.taxaEntrega;
      if (req.body.taxaEntrega !== undefined) {
        const taxaCliente = parseFloat(req.body.taxaEntrega);
        if (isNaN(taxaCliente) || taxaCliente < 2 || taxaCliente > 4) {
          return res.status(400).json({ error: 'Taxa de entrega inválida (deve ser entre R$2 e R$4)' });
        }
        taxaFinal = taxaCliente;
      }
      taxaFinal = Math.round(taxaFinal * 100) / 100; // garantir 2 casas decimais
      const totalFinal = parseFloat(Math.max(0, subtotal + taxaFinal - desconto).toFixed(2));

      const pedidoInsert = {
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
      };
      if (desconto > 0) { pedidoInsert.desconto = desconto; pedidoInsert.cupom_codigo = cupomCodigo; }

      const { data: pedido, error: pedidoErr } = await supabaseAdmin
        .from('pedidos')
        .insert(pedidoInsert)
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

      // 8. Link WhatsApp para o lojista (se configurado)
      let whatsappLink = null;
      if (est.whatsapp) {
        const itensTexto = itensPedido.map((i) => `${i.quantidade}x ${i.nome}`).join(', ');
        const msg = encodeURIComponent(`🔔 Novo pedido!\nTotal: R$ ${totalFinal.toFixed(2)}\nItens: ${itensTexto}\nEntrega: ${enderecoEntrega}`);
        whatsappLink = `https://wa.me/55${est.whatsapp}?text=${msg}`;
      }

      const mensagemPagamento = {
        pix: 'Pedido criado. Gere o QR Code Pix para pagar.',
        cartao: 'Pedido criado. Redirecione para o checkout de cartão.',
      };

      res.status(201).json({
        pedidoId: pedido.id,
        status: pedido.status,
        total: totalFinal,
        subtotal,
        desconto,
        taxaEntrega: taxaFinal,
        comissao: split.comissao,
        split: {
          lojista: split.valorLojista,
          motoboy: split.valorMotoboy,
          plataforma: split.valorPlataforma,
        },
        formaPagamento,
        whatsappLink,
        mensagem: mensagemPagamento[formaPagamento] || 'Pedido criado.',
      });
    } catch (err) {
      console.error('[Orders] Criar pedido:', err.message);
      next(err);
    }
  }
);

// =============================================
// GET /api/orders/cupom/:codigo — Validar cupom
// =============================================
router.get('/cupom/:codigo', requireAuth, async (req, res, next) => {
  try {
    const subtotal = parseFloat(req.query.subtotal) || 0;
    const codigo = req.params.codigo.toUpperCase();

    const { data: cupom, error } = await supabaseAdmin
      .from('cupons')
      .select('*')
      .eq('codigo', codigo)
      .eq('ativo', true)
      .single();

    if (error || !cupom) return res.status(404).json({ error: 'Cupom não encontrado ou inativo' });
    if (cupom.validade && new Date(cupom.validade) < new Date()) return res.status(400).json({ error: 'Cupom expirado' });
    if (cupom.usos_atual >= cupom.usos_max) return res.status(400).json({ error: 'Cupom esgotado' });

    let desconto = 0;
    if (cupom.desconto_tipo === 'percentual') {
      desconto = parseFloat((subtotal * cupom.desconto_valor / 100).toFixed(2));
    } else {
      desconto = Math.min(parseFloat(cupom.desconto_valor), subtotal);
    }

    res.json({ codigo: cupom.codigo, desconto_tipo: cupom.desconto_tipo, desconto_valor: cupom.desconto_valor, desconto });
  } catch (err) {
    next(err);
  }
});

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

    const selectPedido = 'id, status, total, taxa_entrega, endereco_entrega, telefone_cliente, ' +
      'estabelecimentos (nome, emoji, endereco, lat, lng), ' +
      'profiles!pedidos_cliente_id_fkey (nome)';

    // Início do dia em Brasília (UTC-3 = 03:00 UTC)
    const agora = new Date();
    const hojeInicio = new Date(agora);
    hojeInicio.setUTCHours(3, 0, 0, 0);
    if (hojeInicio > agora) hojeInicio.setUTCDate(hojeInicio.getUTCDate() - 1);

    const [dispRes, ativaRes, histRes] = await Promise.all([
      // Pedidos prontos sem motoboy atribuído
      supabaseAdmin
        .from('pedidos')
        .select(selectPedido)
        .eq('status', 'pronto')
        .is('motoboy_id', null)
        .order('criado_em', { ascending: true }),

      // Entrega ativa deste motoboy (coletado)
      motoboy ? supabaseAdmin
        .from('pedidos')
        .select(selectPedido)
        .eq('status', 'coletado')
        .eq('motoboy_id', motoboy.id)
        .maybeSingle() : Promise.resolve({ data: null }),

      // Histórico de entregas do motoboy (últimos 30 dias)
      motoboy ? supabaseAdmin
        .from('pedidos')
        .select('id, taxa_entrega, criado_em, estabelecimentos(nome), profiles!pedidos_cliente_id_fkey(nome)')
        .eq('status', 'entregue')
        .eq('motoboy_id', motoboy.id)
        .order('criado_em', { ascending: false })
        .limit(20) : Promise.resolve({ data: [] }),
    ]);

    const historico = histRes.data || [];
    const entregasHoje = historico.filter(p => new Date(p.criado_em) >= hojeInicio).length;
    const ganhoHoje = historico
      .filter(p => new Date(p.criado_em) >= hojeInicio)
      .reduce((s, p) => s + (p.taxa_entrega || 0), 0);
    const ganhoTotal = historico.reduce((s, p) => s + (p.taxa_entrega || 0), 0);

    res.json({
      disponiveis: dispRes.data || [],
      ativa: ativaRes.data || null,
      stats: {
        entregasHoje,
        ganhoHoje: parseFloat(ganhoHoje.toFixed(2)),
        entregasTotal: historico.length,
        ganhoTotal: parseFloat(ganhoTotal.toFixed(2)),
      },
      historico,
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
        estabelecimentos (id, nome, emoji),
        itens_pedido (nome, quantidade, preco_unitario, observacao)
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
        estabelecimentos (nome, emoji, telefone, whatsapp, user_id),
        itens_pedido (*),
        motoboys (id, nome, telefone, lat, lng)
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !pedido) return res.status(404).json({ error: 'Pedido não encontrado' });

    // Apenas o próprio cliente, admin, ou o estabelecimento dono do pedido pode ver
    const perfil = req.user.profile.perfil;
    const isOwner = pedido.cliente_id === req.user.id;
    const isAdmin = perfil === 'admin';
    const isEstabelecimento = perfil === 'estabelecimento' && pedido.estabelecimentos?.user_id === req.user.id;

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
      .isIn(['aceito', 'preparando', 'pronto', 'coletado', 'saiu_para_entrega', 'entregue', 'cancelado'])
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
      estabelecimento: ['aceito', 'preparando', 'pronto', 'saiu_para_entrega', 'entregue', 'cancelado'],
      motoboy: ['coletado', 'entregue'],
      admin: ['aceito', 'preparando', 'pronto', 'coletado', 'saiu_para_entrega', 'entregue', 'cancelado'],
    };

    if (!transicoesPermitidas[perfil]?.includes(status)) {
      return res.status(403).json({ error: `Perfil ${perfil} não pode setar status ${status}` });
    }

    try {
      // Para estabelecimento, verificar pedido pago antes de cancelar
      if (status === 'cancelado' && perfil === 'estabelecimento') {
        const { data: p } = await supabaseAdmin
          .from('pedidos')
          .select('pagamento_status')
          .eq('id', orderId)
          .single();
        if (p?.pagamento_status === 'aprovado')
          return res.status(400).json({ error: 'Não é possível cancelar pedido já pago' });
      }

      // Para estabelecimento, restringir ao próprio pedido
      let updateQuery = supabaseAdmin
        .from('pedidos')
        .update({ status, atualizado_em: new Date().toISOString() })
        .eq('id', orderId);

      if (perfil === 'estabelecimento') {
        const { data: est } = await supabaseAdmin
          .from('estabelecimentos')
          .select('id')
          .eq('user_id', req.user.id)
          .single();
        if (!est) return res.status(403).json({ error: 'Estabelecimento não encontrado' });
        updateQuery = updateQuery.eq('estabelecimento_id', est.id);
      }

      // Para motoboy, restringir ao próprio pedido
      if (perfil === 'motoboy') {
        const { data: moto } = await supabaseAdmin
          .from('motoboys')
          .select('id')
          .eq('user_id', req.user.id)
          .single();
        if (!moto) return res.status(403).json({ error: 'Motoboy não encontrado' });
        updateQuery = updateQuery.eq('motoboy_id', moto.id);
      }

      const { data: pedido, error } = await updateQuery.select().single();

      if (error || !pedido) return res.status(404).json({ error: 'Pedido não encontrado' });

      // Notificar cliente sobre mudança de status
      const msgStatus = {
        aceito: '✅ Pedido aceito! A loja está preparando.',
        preparando: '👨‍🍳 Seu pedido está sendo preparado.',
        pronto: '📦 Pedido pronto! Aguardando entrega.',
        coletado: '🛵 Motoboy a caminho! Acompanhe no app.',
        saiu_para_entrega: '🛵 Pedido saiu para entrega! Confirme quando chegar.',
        entregue: '🎉 Pedido entregue! Bom apetite.',
        cancelado: '❌ Seu pedido foi cancelado.',
      };
      if (pedido.cliente_id && msgStatus[status]) {
        enviarPush(pedido.cliente_id, 'Chegou Aí', msgStatus[status], { pedidoId: orderId, status });
      }

      // Quando pedido fica pronto, notificar todos os motoboys disponíveis
      if (status === 'pronto') {
        const { data: motosDisp } = await supabaseAdmin
          .from('motoboys')
          .select('user_id')
          .eq('disponivel', true)
          .eq('ativo', true);

        if (motosDisp?.length) {
          const enderecoResumido = (pedido.endereco_entrega || '').substring(0, 40);
          motosDisp.forEach((m) => {
            enviarPush(m.user_id, '🛵 Nova entrega disponível!', enderecoResumido || 'Toque para ver detalhes', { pedidoId: orderId });
          });
        }
      }

      // Ao confirmar entrega, repassar taxa de entrega ao motoboy (idempotente)
      if (status === 'entregue' && pedido.motoboy_id) {
        const { data: repasseExistente } = await supabaseAdmin
          .from('repasses')
          .select('id, status')
          .eq('pedido_id', orderId)
          .eq('tipo', 'motoboy')
          .maybeSingle();

        const valorRepasse = parseFloat(pedido.taxa_entrega || 0);

        if (!repasseExistente) {
          await supabaseAdmin.from('repasses').insert({
            pedido_id: orderId,
            motoboy_id: pedido.motoboy_id,
            tipo: 'motoboy',
            valor: valorRepasse,
            status: 'pendente',
          });
        }

        // Transferir via Pix Pagar.me se pagamento aprovado e motoboy tem chave Pix
        if (pedido.pagamento_status === 'aprovado' && valorRepasse > 0) {
          const { data: motoboy } = await supabaseAdmin
            .from('motoboys')
            .select('chave_pix')
            .eq('id', pedido.motoboy_id)
            .single();

          if (motoboy?.chave_pix) {
            try {
              await criarTransferenciaPix(motoboy.chave_pix, valorRepasse);
              await supabaseAdmin
                .from('repasses')
                .update({ status: 'pago', atualizado_em: new Date().toISOString() })
                .eq('pedido_id', orderId)
                .eq('tipo', 'motoboy');
              console.log(`[Repasse] Transferência Pix R$${valorRepasse} → motoboy ${pedido.motoboy_id} OK`);
            } catch (transErr) {
              console.error(`[Repasse] Falha na transferência Pix ao motoboy:`, transErr.message);
              // repasse permanece 'pendente' para reprocessamento manual
            }
          }
        }
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
// POST /api/orders/bulk-assign — Motoboy aceita múltiplos pedidos da mesma loja
// =============================================
router.post(
  '/bulk-assign',
  requireRole('motoboy'),
  [body('pedidoIds').isArray({ min: 1, max: 10 }).withMessage('Selecione entre 1 e 10 pedidos')],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
      const { pedidoIds } = req.body;

      const { data: motoboy } = await supabaseAdmin
        .from('motoboys')
        .select('id')
        .eq('user_id', req.user.id)
        .single();
      if (!motoboy) return res.status(404).json({ error: 'Motoboy não encontrado' });

      // Validar que todos são UUIDs
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!pedidoIds.every((id) => uuidRegex.test(id))) {
        return res.status(400).json({ error: 'IDs inválidos' });
      }

      // Verificar que todos estão prontos e são da mesma loja
      const { data: pedidos } = await supabaseAdmin
        .from('pedidos')
        .select('id, estabelecimento_id, status, cliente_id, endereco_entrega')
        .in('id', pedidoIds)
        .eq('status', 'pronto')
        .is('motoboy_id', null);

      if (!pedidos || pedidos.length !== pedidoIds.length) {
        return res.status(400).json({ error: 'Um ou mais pedidos não estão prontos ou já foram atribuídos' });
      }

      const lojas = [...new Set(pedidos.map((p) => p.estabelecimento_id))];
      if (lojas.length > 1) {
        return res.status(400).json({ error: 'Só é possível aceitar pedidos da mesma loja por vez' });
      }

      // Atribuir todos de uma vez
      const { error } = await supabaseAdmin
        .from('pedidos')
        .update({ motoboy_id: motoboy.id, status: 'coletado' })
        .in('id', pedidoIds);

      if (error) throw error;

      // Notificar clientes
      pedidos.forEach((p) => {
        if (p.cliente_id) {
          enviarPush(p.cliente_id, 'Chegou Aí', '🛵 Motoboy a caminho! Acompanhe no app.', { pedidoId: p.id, status: 'coletado' });
        }
      });

      res.json({
        message: `${pedidos.length} pedido(s) aceito(s)`,
        pedidos: pedidos.map((p) => ({ id: p.id, endereco: p.endereco_entrega })),
      });
    } catch (err) { next(err); }
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

// =============================================
// PATCH /api/orders/:id/cancelar — Cliente cancela pedido antes do pagamento
// =============================================
router.patch(
  '/:id/cancelar',
  requireAuth,
  [param('id').isUUID()],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

    try {
      const { data: pedido, error: fetchErr } = await supabaseAdmin
        .from('pedidos')
        .select('id, cliente_id, pagamento_status, status')
        .eq('id', req.params.id)
        .single();

      if (fetchErr || !pedido) return res.status(404).json({ error: 'Pedido não encontrado' });

      if (pedido.cliente_id !== req.user.id) {
        return res.status(403).json({ error: 'Acesso negado' });
      }

      if (pedido.pagamento_status !== 'pendente') {
        return res.status(400).json({ error: 'Pedido não pode ser cancelado após o pagamento' });
      }

      const { data: atualizado, error: updateErr } = await supabaseAdmin
        .from('pedidos')
        .update({ status: 'cancelado', pagamento_status: 'cancelado', atualizado_em: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();

      if (updateErr) throw updateErr;

      res.json({ message: 'Pedido cancelado com sucesso', pedido: atualizado });
    } catch (err) {
      next(err);
    }
  }
);

// =============================================
// POST /api/orders/:id/confirmar-recebimento
// Cliente confirma que recebeu o pedido (entrega própria do lojista)
// =============================================
router.post('/:id/confirmar-recebimento', requireAuth, [param('id').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

  try {
    const { data: pedido, error } = await supabaseAdmin
      .from('pedidos')
      .update({ status: 'entregue', atualizado_em: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('cliente_id', req.user.id)
      .eq('status', 'saiu_para_entrega')
      .select()
      .single();

    if (error || !pedido) return res.status(400).json({ error: 'Pedido não encontrado ou não está em trânsito' });

    res.json({ message: 'Recebimento confirmado!', pedido });
  } catch (err) { next(err); }
});

module.exports = router;
