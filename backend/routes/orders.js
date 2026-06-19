const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');
const { calcularSplit } = require('../services/commission');
const { criarTransferenciaPix } = require('../services/pagarme');
const { enviarPush } = require('./notifications');
const { alertarAdmin, enviarWhatsApp } = require('../services/whatsapp');
const { enviarTelegram, enviarTelegramChatId } = require('../services/telegram');

const router = express.Router();

// =============================================
// GET /api/orders/primeiro-pedido — Verifica se telefone nunca comprou
// =============================================
router.get('/primeiro-pedido', async (req, res, next) => {
  try {
    const tel = (req.query.telefone || '').replace(/\D/g, '').slice(-11);
    if (tel.length < 10) return res.json({ primeiroP: false });

    const telFormatado = `(${tel.slice(0,2)}) ${tel.slice(2,7)}-${tel.slice(7)}`;
    const [{ data: r1 }, { data: r2 }] = await Promise.all([
      supabaseAdmin.from('pedidos').select('id').eq('telefone_cliente', tel).eq('pagamento_status', 'aprovado').limit(1),
      supabaseAdmin.from('pedidos').select('id').eq('telefone_cliente', telFormatado).eq('pagamento_status', 'aprovado').limit(1),
    ]);

    res.json({ primeiroP: (!r1 || r1.length === 0) && (!r2 || r2.length === 0) });
  } catch (err) { next(err); }
});

// =============================================
// POST /api/orders — Criar novo pedido
// =============================================
router.post(
  '/',
  optionalAuth,
  [
    body('estabelecimentoId').isUUID().withMessage('Estabelecimento inválido'),
    body('itens')
      .isArray({ min: 1 })
      .withMessage('Pedido deve ter pelo menos 1 item'),
    body('itens.*.produtoId').isUUID().withMessage('Produto inválido'),
    body('itens.*.quantidade').isFloat({ min: 0.5 }).withMessage('Quantidade inválida'),
    body('itens.*.observacao').optional().trim().isLength({ max: 500 }),
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

    const { estabelecimentoId, itens, enderecoEntrega, telefoneCliente, formaPagamento, cupom,
            guestNome, guestCpf, indicadoPor } = req.body;
    const clienteId = req.user ? req.user.id : null;

    // Validação extra para guest
    if (!req.user) {
      const nome = (guestNome || '').trim();
      if (nome.length < 2 || nome.length > 80) {
        return res.status(400).json({ error: 'Informe seu nome completo' });
      }
    }

    try {
      // 1. Validar estabelecimento
      const { data: est, error: estErr } = await supabaseAdmin
        .from('estabelecimentos')
        .select('id, nome, aberto, horarios, taxa_entrega, tipo_frete, frete_base, frete_por_km, cadastro_data, ativo, user_id, valor_minimo, whatsapp, tipo_entrega, pausado')
        .eq('id', estabelecimentoId)
        .eq('ativo', true)
        .single();

      if (estErr || !est) {
        return res.status(404).json({ error: 'Estabelecimento não encontrado' });
      }

      // Recalcular aberto com base no horário (mesmo que o campo no banco esteja desatualizado)
      if (est.horarios && !est.pausado) {
        const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Eirunepe' }));
        const diaChave = ['dom','seg','ter','qua','qui','sex','sab'][agora.getDay()];
        const h = est.horarios[diaChave];
        if (h && h.abre && h.fecha) {
          const [hA, mA] = h.abre.split(':').map(Number);
          const [hF, mF] = h.fecha.split(':').map(Number);
          const fechaMin = hF === 0 && mF === 0 ? 1440 : hF * 60 + mF;
          const minAtual = agora.getHours() * 60 + agora.getMinutes();
          est.aberto = minAtual >= hA * 60 + mA && minAtual < fechaMin;
        }
      }

      if (!est.aberto) {
        return res.status(400).json({ error: 'Estabelecimento fechado no momento' });
      }
      if (est.pausado) {
        return res.status(400).json({ error: 'Esta loja pausou os pedidos temporariamente. Tente novamente em breve.' });
      }

      // 2. Validar e buscar produtos
      const produtosIds = itens.map((i) => i.produtoId);
      const { data: produtos, error: prodErr } = await supabaseAdmin
        .from('produtos')
        .select('id, nome, preco, preco_promocional, disponivel, estoque')
        .in('id', produtosIds)
        .eq('estabelecimento_id', estabelecimentoId)
        .eq('disponivel', true);

      if (prodErr || produtos.length !== produtosIds.length) {
        return res.status(400).json({
          error: 'Um ou mais produtos não encontrados ou indisponíveis',
        });
      }

      // Validar estoque disponível
      const produtosMap0 = Object.fromEntries(produtos.map((p) => [p.id, p]));
      for (const item of itens) {
        const prod = produtosMap0[item.produtoId];
        if (prod.estoque !== null && prod.estoque < item.quantidade) {
          const restante = prod.estoque === 0 ? 'esgotado' : `apenas ${prod.estoque} disponível(is)`;
          return res.status(400).json({ error: `"${prod.nome}" está ${restante}` });
        }
      }

      // 3. Calcular subtotal
      const produtosMap = Object.fromEntries(produtos.map((p) => [p.id, p]));
      let subtotal = 0;
      const itensPedido = itens.map((item) => {
        const produto = produtosMap[item.produtoId];
        const compsTotal = Array.isArray(item.complementos)
          ? item.complementos.reduce((s, c) => s + parseFloat(c.preco_adicional || 0), 0)
          : 0;
        const precoBase = (produto.preco_promocional != null && produto.preco_promocional < produto.preco)
          ? produto.preco_promocional : produto.preco;
        const precoUnit = parseFloat((precoBase + compsTotal).toFixed(2));
        const itemTotal = parseFloat((precoUnit * item.quantidade).toFixed(2));
        subtotal += itemTotal;
        const itemObj = {
          produto_id: item.produtoId,
          nome: produto.nome,
          preco_unitario: precoUnit,
          quantidade: item.quantidade,
          subtotal: itemTotal,
        };
        if (item.observacao) itemObj.observacao = item.observacao;
        if (Array.isArray(item.complementos) && item.complementos.length > 0) {
          itemObj.complementos = item.complementos.map(c => ({
            id: c.id, nome: c.nome, preco_adicional: parseFloat(c.preco_adicional || 0),
          }));
        }
        return itemObj;
      });
      subtotal = parseFloat(subtotal.toFixed(2));

      // 3b. Validar valor mínimo do estabelecimento
      if (est.valor_minimo && subtotal < parseFloat(est.valor_minimo)) {
        return res.status(400).json({
          error: `Pedido mínimo é R$${parseFloat(est.valor_minimo).toFixed(2).replace('.', ',')}`,
        });
      }

      // 3c. Validar valor mínimo global do app
      const valorMinimoGlobal = parseFloat(process.env.PEDIDO_MINIMO_GLOBAL || '0');
      if (valorMinimoGlobal > 0 && subtotal < valorMinimoGlobal) {
        return res.status(400).json({
          error: `Pedido mínimo é R$${valorMinimoGlobal.toFixed(2).replace('.', ',')}`,
        });
      }

      // 4. Calcular split (incluindo comissão)
      const split = calcularSplit({
        subtotal,
        taxaEntrega: est.taxa_entrega,
        tipoEntrega: est.tipo_entrega,
      });

      // 4b. Validar e aplicar cupom
      let desconto = 0;
      let cupomCodigo = null;
      if (cupom) {
        const { data: cupomData, error: cupomErr } = await supabaseAdmin
          .from('cupons_plataforma')
          .select('*')
          .eq('codigo', cupom.toUpperCase())
          .eq('ativo', true)
          .single();

        if (cupomErr || !cupomData) {
          return res.status(400).json({ error: 'Cupom inválido ou expirado' });
        }
        if (cupomData.validade) {
          const hojeEirunepe = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Eirunepe' })).toISOString().split('T')[0];
          if (cupomData.validade.split('T')[0] < hojeEirunepe) {
            return res.status(400).json({ error: 'Cupom expirado' });
          }
        }
        if (cupomData.usos_atual >= cupomData.usos_max) {
          return res.status(400).json({ error: 'Cupom esgotado' });
        }
        const valorMinimo = parseFloat(cupomData.valor_minimo || 0);
        if (valorMinimo > 0 && subtotal < valorMinimo) {
          return res.status(400).json({ error: `Cupom válido para pedidos acima de R$ ${valorMinimo.toFixed(2).replace('.', ',')}` });
        }

        // Incrementar uso atomicamente (comum a todos os tipos)
        let incrementQuery = supabaseAdmin
          .from('cupons_plataforma')
          .update({ usos_atual: cupomData.usos_atual + 1 })
          .eq('id', cupomData.id);
        // Só adiciona condição de limite quando usos_max não é null (cupons com limite)
        if (cupomData.usos_max !== null && cupomData.usos_max !== undefined) {
          incrementQuery = incrementQuery.lt('usos_atual', cupomData.usos_max);
        }
        const { data: cupomAtualizado } = await incrementQuery.select('id');
        if (!cupomAtualizado || cupomAtualizado.length === 0) {
          return res.status(400).json({ error: 'Cupom esgotado' });
        }
        cupomCodigo = cupomData.codigo;

        if (cupomData.codigo === 'VOLTEI') {
          // Frete grátis exclusivo para clientes recorrentes
          if (!clienteId) return res.status(400).json({ error: 'Faça login para usar este cupom' });
          const { data: pedidosAnt } = await supabaseAdmin
            .from('pedidos').select('id').eq('cliente_id', clienteId).eq('pagamento_status', 'aprovado').limit(1);
          if (!pedidosAnt || pedidosAnt.length === 0) {
            return res.status(400).json({ error: 'Este cupom é exclusivo para quem já fez um pedido antes' });
          }
          req.body._volteiAtivo = true;
        } else if (cupomData.frete_gratis) {
          // Frete grátis sem restrição de pedido anterior
          req.body._volteiAtivo = true;
        } else {
          if (cupomData.desconto_tipo === 'percentual') {
            desconto = parseFloat((subtotal * cupomData.desconto_valor / 100).toFixed(2));
          } else {
            desconto = Math.min(parseFloat(cupomData.desconto_valor), subtotal);
          }
        }
      }

      // 4c. Campanha automática do estabelecimento (sem código, auto-aplicada)
      if (!cupomCodigo) {
        const { data: campanha } = await supabaseAdmin
          .from('campanhas_estabelecimento')
          .select('*').eq('estabelecimento_id', est.id).eq('ativo', true)
          .order('criado_em', { ascending: false }).limit(1);
        const c = campanha && campanha[0];
        if (c) {
          const minimo = parseFloat(c.valor_minimo || 0);
          if (c.tipo === 'combo') {
            const qtdMinima = Math.max(2, parseInt(c.valor) || 2);
            const comboPreco = parseFloat(c.combo_preco || 0);
            if (comboPreco > 0) {
              let economia = 0;
              for (const item of itensPedido) {
                const qty = parseFloat(item.quantidade);
                if (qty >= qtdMinima) {
                  const grupos = Math.floor(qty / qtdMinima);
                  const semCombo = grupos * qtdMinima * item.preco_unitario;
                  const comCombo = grupos * comboPreco;
                  if (semCombo > comCombo) economia += semCombo - comCombo;
                }
              }
              desconto = parseFloat(economia.toFixed(2));
            }
          } else if (subtotal >= minimo) {
            if (c.tipo === 'percentual') {
              desconto = parseFloat((subtotal * c.valor / 100).toFixed(2));
            } else if (c.tipo === 'fixo') {
              desconto = Math.min(parseFloat(c.valor), subtotal);
            } else if (c.tipo === 'frete_gratis') {
              req.body._volteiAtivo = true;
            }
          }
        }
      }

      // 5. Calcular taxa de entrega final
      let taxaFinal = split.taxaEntrega;
      if (est.tipo_frete === 'km') {
        // Frete dinâmico por km — frontend envia distanciaKm
        const distKm = parseFloat(req.body.distanciaKm);
        if (!isNaN(distKm) && distKm > 0) {
          const base = parseFloat(est.frete_base || 2);
          const porKm = parseFloat(est.frete_por_km || 1.5);
          taxaFinal = parseFloat((base + porKm * distKm).toFixed(2));
        }
      } else if (req.body.taxaEntrega !== undefined) {
        const taxaCliente = parseFloat(req.body.taxaEntrega);
        if (isNaN(taxaCliente) || taxaCliente < 2 || taxaCliente > 4) {
          return res.status(400).json({ error: 'Taxa de entrega inválida (deve ser entre R$2,00 e R$4,00)' });
        }
        taxaFinal = taxaCliente;
      }
      taxaFinal = Math.round(taxaFinal * 100) / 100;

      // 5b. Frete grátis: cupom VOLTEI ou primeiro pedido (verificado sempre no backend)
      if (req.body._volteiAtivo === true) {
        desconto = parseFloat((desconto + taxaFinal).toFixed(2));
      } else {
        const tel = telefoneCliente.replace(/\D/g, '').slice(-11);
        const telFormatado = `(${tel.slice(0,2)}) ${tel.slice(2,7)}-${tel.slice(7)}`;
        const [{ data: ant1 }, { data: ant2 }] = await Promise.all([
          supabaseAdmin.from('pedidos').select('id').eq('telefone_cliente', tel).eq('pagamento_status', 'aprovado').limit(1),
          supabaseAdmin.from('pedidos').select('id').eq('telefone_cliente', telFormatado).eq('pagamento_status', 'aprovado').limit(1),
        ]);
        if ((!ant1 || ant1.length === 0) && (!ant2 || ant2.length === 0)) {
          desconto = parseFloat((desconto + taxaFinal).toFixed(2));
        }
      }

      const totalFinal = parseFloat(Math.max(0, subtotal + taxaFinal - desconto).toFixed(2));

      const pedidoInsert = {
        cliente_id: clienteId || null,
        estabelecimento_id: estabelecimentoId,
        status: 'pendente',
        endereco_entrega: enderecoEntrega,
        telefone_cliente: telefoneCliente.replace(/\D/g, '').slice(-11),
        subtotal,
        taxa_entrega: taxaFinal,
        comissao_plataforma: split.valorPlataforma,
        total: totalFinal,
        forma_pagamento: formaPagamento,
        pagamento_status: 'pendente',
        codigo_coleta: String(Math.floor(Math.random() * 900) + 100),
      };
      if (desconto > 0) {
        pedidoInsert.desconto = desconto;
        if (cupomCodigo) pedidoInsert.cupom_codigo = cupomCodigo;
        else if (req.body.freteGratis === true) pedidoInsert.cupom_codigo = 'FRETE_GRATIS_1P';
      }
      if (!req.user) {
        pedidoInsert.guest_nome = (guestNome || '').trim();
        if (guestCpf) pedidoInsert.guest_cpf = guestCpf.replace(/\D/g, '');
        pedidoInsert.guest_telefone = telefoneCliente.replace(/\D/g, '').slice(-11);
      }
      // Indicação para sorteio (qualquer pedido, logado ou guest)
      if (indicadoPor) {
        const telIndicador = String(indicadoPor).replace(/\D/g, '').slice(-11);
        if (telIndicador.length >= 10) pedidoInsert.indicado_por = telIndicador;
      }

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

      // 7. Push e WhatsApp só após pagamento confirmado (ver processarPagamentoAprovado em payments.js)

      // 8. Link WhatsApp para o lojista (se configurado)
      let whatsappLink = null;
      if (est.whatsapp) {
        const itensTexto = itensPedido.map((i) => `${Number.isInteger(i.quantidade) ? i.quantidade + 'x' : i.quantidade + ' kg'} ${i.nome}`).join(', ');
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
router.get('/cupom/:codigo', async (req, res, next) => {
  try {
    const subtotal = parseFloat(req.query.subtotal) || 0;
    const codigo = req.params.codigo.toUpperCase();

    const { data: cupom, error } = await supabaseAdmin
      .from('cupons_plataforma')
      .select('*')
      .eq('codigo', codigo)
      .eq('ativo', true)
      .single();

    if (error || !cupom) return res.status(404).json({ error: 'Cupom não encontrado ou inativo' });
    if (cupom.validade) {
      const hojeEirunepe = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Eirunepe' })).toISOString().split('T')[0];
      if (cupom.validade.split('T')[0] < hojeEirunepe) {
        return res.status(400).json({ error: 'Cupom expirado' });
      }
    }
    if (cupom.usos_atual >= cupom.usos_max) return res.status(400).json({ error: 'Cupom esgotado' });
    const valorMinimo = parseFloat(cupom.valor_minimo || 0);
    if (valorMinimo > 0 && subtotal < valorMinimo) {
      return res.status(400).json({ error: `Cupom válido para pedidos acima de R$ ${valorMinimo.toFixed(2).replace('.', ',')}` });
    }

    if (cupom.codigo === 'VOLTEI') {
      if (subtotal < 30) return res.status(400).json({ error: 'Cupom VOLTEI válido para pedidos acima de R$ 30,00' });
      const clienteId = req.user?.profile?.id || req.user?.id;
      if (!clienteId) return res.status(400).json({ error: 'Faça login para usar este cupom' });
      const { data: pedidosAnt } = await supabaseAdmin
        .from('pedidos').select('id').eq('cliente_id', clienteId).eq('pagamento_status', 'aprovado').limit(1);
      if (!pedidosAnt || pedidosAnt.length === 0) {
        return res.status(400).json({ error: 'Este cupom é exclusivo para quem já fez um pedido antes' });
      }
      return res.json({ codigo: cupom.codigo, desconto_tipo: 'frete_gratis', desconto_valor: 0, desconto: 0, freteGratis: true });
    }

    if (cupom.frete_gratis) {
      return res.json({ codigo: cupom.codigo, desconto_tipo: 'frete_gratis', desconto_valor: 0, desconto: 0, freteGratis: true });
    }

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
  res.set('Cache-Control', 'no-store');
  try {
    // Buscar ID do motoboy logado
    const { data: motoboy } = await supabaseAdmin
      .from('motoboys')
      .select('id, disponivel')
      .eq('user_id', req.user.id)
      .single();

    // telegram_chat_id em query separada para não quebrar se a coluna ainda não existir
    let motoboyTelegramChatId = null;
    try {
      const { data: tgData } = await supabaseAdmin
        .from('motoboys').select('telegram_chat_id').eq('user_id', req.user.id).maybeSingle();
      motoboyTelegramChatId = tgData?.telegram_chat_id || null;
    } catch (_) { /* coluna ainda não existe — ignorar */ }

    const selectPedido = 'id, status, total, taxa_entrega, endereco_entrega, telefone_cliente, guest_nome, codigo_coleta, ' +
      'estabelecimentos (nome, emoji, endereco, lat, lng, cidade, estado), ' +
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

      // Entregas ativas deste motoboy (coletado) — pode ter múltiplas
      motoboy ? supabaseAdmin
        .from('pedidos')
        .select(selectPedido)
        .eq('status', 'coletado')
        .eq('motoboy_id', motoboy.id)
        .order('criado_em', { ascending: true }) : Promise.resolve({ data: [] }),

      // Histórico de entregas do motoboy (últimos 30 dias)
      motoboy ? supabaseAdmin
        .from('pedidos')
        .select('id, taxa_entrega, criado_em, guest_nome, cliente_id, estabelecimentos(nome), profiles!pedidos_cliente_id_fkey(nome)')
        .eq('status', 'entregue')
        .eq('motoboy_id', motoboy.id)
        .order('criado_em', { ascending: false })
        .limit(20) : Promise.resolve({ data: [] }),
    ]);

    const historicoRaw = histRes.data || [];
    const entregasHoje = historicoRaw.filter(p => new Date(p.criado_em) >= hojeInicio).length;
    const ganhoHoje = historicoRaw
      .filter(p => new Date(p.criado_em) >= hojeInicio)
      .reduce((s, p) => s + (p.taxa_entrega || 0), 0);
    const ganhoTotal = historicoRaw.reduce((s, p) => s + (p.taxa_entrega || 0), 0);

    // Resolver nomes dos clientes via lookup direto (inclui historico)
    const todosOsPedidos = [
      ...(dispRes.data || []),
      ...(ativaRes.data || []),
      ...historicoRaw,
    ];
    const clienteIds = [...new Set(todosOsPedidos.map(p => p.cliente_id).filter(Boolean))];
    let nomesMap = {};
    if (clienteIds.length > 0) {
      const { data: perfis } = await supabaseAdmin.from('profiles').select('id, nome').in('id', clienteIds);
      if (perfis) perfis.forEach(p => { nomesMap[p.id] = p.nome; });
    }
    const resolverNome = (p) => ({ ...p, nome_cliente: p.guest_nome || (p.cliente_id && nomesMap[p.cliente_id]) || null });

    res.json({
      disponiveis: (dispRes.data || []).map(resolverNome),
      ativas: (ativaRes.data || []).map(resolverNome),
      ativa: (ativaRes.data || [])[0] ? resolverNome((ativaRes.data || [])[0]) : null,
      disponivel: motoboy ? motoboy.disponivel : null,
      telegram_chat_id: motoboyTelegramChatId,
      stats: {
        entregasHoje,
        ganhoHoje: parseFloat(ganhoHoje.toFixed(2)),
        entregasTotal: historicoRaw.length,
        ganhoTotal: parseFloat(ganhoTotal.toFixed(2)),
      },
      historico: historicoRaw.map(resolverNome),
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

// GET /api/orders/guest — histórico de pedidos por telefone (sem login)
router.get('/guest', async (req, res, next) => {
  try {
    const tel = (req.query.telefone || '').replace(/\D/g, '').slice(-11);
    if (tel.length < 10) return res.status(400).json({ error: 'Telefone inválido' });
    const telFormatado = `(${tel.slice(0,2)}) ${tel.slice(2,7)}-${tel.slice(7)}`;
    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .select(`id, status, pagamento_status, total, subtotal, taxa_entrega, forma_pagamento, criado_em,
        estabelecimentos (id, nome, emoji),
        itens_pedido (nome, quantidade, preco_unitario)`)
      .or(`telefone_cliente.eq.${tel},telefone_cliente.eq.${telFormatado}`)
      .eq('pagamento_status', 'aprovado')
      .order('criado_em', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json(data || []);
  } catch (err) { next(err); }
});

// GET /api/orders/frete-gratis — cupom de frete grátis ativo (público, para lojistas)
router.get('/frete-gratis', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('cupons_plataforma')
      .select('codigo')
      .eq('frete_gratis', true)
      .eq('ativo', true)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    res.json({ codigo: data ? data.codigo : null });
  } catch (err) { next(err); }
});

// =============================================
// GET /api/orders/:id — Detalhes de um pedido
// =============================================
router.get('/:id', optionalAuth, [param('id').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

  try {
    const { data: pedido, error } = await supabaseAdmin
      .from('pedidos')
      .select(`*, estabelecimentos (nome, emoji, whatsapp, user_id, categoria), itens_pedido (*)`)
      .eq('id', req.params.id)
      .single();

    if (error || !pedido) {
      if (error) console.error('[GET /orders/:id]', error.message);
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }

    // Buscar motoboy separado para não falhar a query principal
    if (pedido.motoboy_id) {
      const { data: mb } = await supabaseAdmin
        .from('motoboys')
        .select('id, nome, telefone, lat, lng')
        .eq('id', pedido.motoboy_id)
        .single();
      pedido.motoboys = mb || null;
    } else {
      pedido.motoboys = null;
    }

    if (req.user) {
      const perfil = req.user.profile.perfil;
      const isOwner = pedido.cliente_id === req.user.id;
      const isAdmin = perfil === 'admin';
      const isEstabelecimento = perfil === 'estabelecimento' && pedido.estabelecimentos?.user_id === req.user.id;
      if (!isOwner && !isAdmin && !isEstabelecimento) {
        return res.status(403).json({ error: 'Acesso negado' });
      }
    } else {
      // Guest sem token: UUID é indevinhável, acesso de rastreio é permitido
    }

    res.json(pedido);
  } catch (err) {
    next(err);
  }
});

// =============================================
// PATCH /api/orders/:id/endereco — Cliente atualiza endereço enquanto pronto
// =============================================
router.patch('/:id/endereco', async (req, res, next) => {
  const { endereco } = req.body;
  if (!endereco || endereco.trim().length < 5) {
    return res.status(400).json({ error: 'Endereço muito curto' });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .update({ endereco_entrega: endereco.trim().slice(0, 300) })
      .eq('id', req.params.id)
      .in('status', ['pronto', 'pendente', 'aceito', 'preparando', 'em_producao', 'separando'])
      .select('id')
      .single();
    if (error || !data) return res.status(404).json({ error: 'Pedido não encontrado ou já foi coletado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
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
      .isIn(['aceito', 'preparando', 'em_producao', 'separando', 'pronto', 'coletado', 'saiu_para_entrega', 'entregue', 'cancelado'])
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
      estabelecimento: ['aceito', 'preparando', 'em_producao', 'separando', 'pronto', 'saiu_para_entrega', 'entregue', 'cancelado'],
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


      // Campos extras para o update
      const agora = new Date().toISOString();
      const updateFields = { status, atualizado_em: agora };

      // Registrar timestamp no histórico de status (para timeline de encomendas)
      const { data: pedidoAtual } = await supabaseAdmin
        .from('pedidos').select('historico_status').eq('id', orderId).single();
      if (pedidoAtual) {
        const hist = pedidoAtual.historico_status || {};
        if (!hist[status]) hist[status] = agora;
        updateFields.historico_status = hist;
      }

      // Gerar código de coleta quando pedido fica pronto
      if (status === 'pronto') {
        updateFields.codigo_coleta = String(Math.floor(Math.random() * 900) + 100);
      }

      // Se marcando saiu_para_entrega com motoboy próprio, salvar o vínculo
      if (status === 'saiu_para_entrega' && req.body.motoboyProprioId) {
        updateFields.motoboy_proprio_id = req.body.motoboyProprioId;
      }

      // Para estabelecimento, restringir ao próprio pedido
      let updateQuery = supabaseAdmin
        .from('pedidos')
        .update(updateFields)
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

      // Para motoboy, restringir ao próprio pedido (plataforma ou próprio da loja)
      if (perfil === 'motoboy') {
        const { data: moto } = await supabaseAdmin
          .from('motoboys')
          .select('id')
          .eq('user_id', req.user.id)
          .single();
        if (!moto) return res.status(403).json({ error: 'Motoboy não encontrado' });
        // Aceita se for motoboy da plataforma (motoboy_id) OU motoboy próprio da loja (motoboy_proprio_id)
        updateQuery = updateQuery.or(`motoboy_id.eq.${moto.id},motoboy_proprio_id.eq.${moto.id}`);
      }

      const { data: pedido, error } = await updateQuery.select().single();

      if (error || !pedido) return res.status(404).json({ error: 'Pedido não encontrado' });

      // Notificar cliente sobre mudança de status
      const tituloStatus = {
        aceito:            '✅ Pedido confirmado!',
        preparando:        '👨‍🍳 Preparando seu pedido',
        em_producao:       '🏭 Em produção!',
        separando:         '📦 Separando seu pedido',
        pronto:            '📦 Pedido pronto! Confirme seu endereço',
        coletado:          '🛵 Motoboy a caminho!',
        saiu_para_entrega: '🛵 Saiu para entrega!',
        entregue:          '🎉 Pedido entregue!',
        cancelado:         '❌ Pedido cancelado',
      };
      const corpStatus = {
        aceito:            'A loja aceitou seu pedido e já começou a preparar.',
        preparando:        'Seu pedido está sendo preparado com cuidado.',
        em_producao:       'Seu pedido está sendo produzido. Aguarde!',
        separando:         'Quase lá! Seu pedido está sendo separado.',
        pronto:            'Confirme seu endereço de entrega. Toque para ver.',
        coletado:          'O motoboy pegou seu pedido. Toque para acompanhar.',
        saiu_para_entrega: 'Seu motoboy saiu para buscar seu pedido!',
        entregue:          'Seu pedido chegou! Obrigado por usar o Chegô 😊',
        cancelado:         'Infelizmente seu pedido foi cancelado.',
      };
      if (pedido.cliente_id && tituloStatus[status]) {
        enviarPush(pedido.cliente_id, tituloStatus[status], corpStatus[status], { pedidoId: orderId, status });
      }

      // Notificar admins nos eventos-chave
      if (['aceito', 'pronto', 'coletado', 'saiu_para_entrega', 'entregue'].includes(status)) {
        const lojaNomeAdmin = pedido.estabelecimentos?.nome || 'Loja';
        const valorAdmin = `R$ ${parseFloat(pedido.total || 0).toFixed(2).replace('.', ',')}`;
        const clienteAdmin = pedido.profiles?.nome || pedido.guest_nome || 'Cliente';
        const tituloAdmin = { aceito: `✅ Lojista aceitou — ${lojaNomeAdmin}`, pronto: `📦 Pronto para coleta — ${lojaNomeAdmin}`, coletado: `🛵 Motoboy coletou — ${lojaNomeAdmin}`, saiu_para_entrega: `🛵 Motoboy a caminho — ${lojaNomeAdmin}`, entregue: `🎉 Entregue — ${lojaNomeAdmin}` }[status];
        supabaseAdmin.from('profiles').select('id').eq('perfil', 'admin').then(({ data: admins }) => {
          (admins || []).forEach(a => enviarPush(a.id, tituloAdmin, `${valorAdmin} · ${clienteAdmin}`, { pedidoId: orderId, status }));
        });
        const msgTelegram = { aceito: `✅ <b>Lojista aceitou</b>\n🏪 ${lojaNomeAdmin}\n💰 ${valorAdmin}\n👤 ${clienteAdmin}`, pronto: `📦 <b>Pronto para coleta!</b>\n🏪 ${lojaNomeAdmin}\n💰 ${valorAdmin}\n👤 ${clienteAdmin}`, coletado: `🛵 <b>Motoboy coletou!</b>\n🏪 ${lojaNomeAdmin}\n💰 ${valorAdmin}\n👤 ${clienteAdmin}`, saiu_para_entrega: `🛵 <b>Motoboy a caminho</b>\n🏪 ${lojaNomeAdmin}\n💰 ${valorAdmin}\n👤 ${clienteAdmin}`, entregue: `🎉 <b>Pedido entregue!</b>\n🏪 ${lojaNomeAdmin}\n💰 ${valorAdmin}\n👤 ${clienteAdmin}` }[status];
        enviarTelegram(msgTelegram);
      }

      // Quando pedido fica pronto, notificar motoboys disponíveis
      if (status === 'pronto') {
        const enderecoResumido = (pedido.endereco_entrega || '').substring(0, 40);
        const lojaNome = pedido.estabelecimentos?.nome || 'Loja';
        const valorStr = `R$ ${parseFloat(pedido.total || 0).toFixed(2).replace('.', ',')}`;

        // Motoboys parceiros (plataforma)
        const { data: motosDisp } = await supabaseAdmin
          .from('motoboys')
          .select('user_id')
          .eq('disponivel', true)
          .eq('ativo', true);

        if (motosDisp?.length) {
          // Buscar telefones dos motoboys disponíveis para WhatsApp
          const motoIds = motosDisp.map((m) => m.user_id);
          const { data: motosInfo } = await supabaseAdmin
            .from('motoboys').select('user_id, telefone, telegram_chat_id').in('user_id', motoIds).eq('ativo', true);

          motosDisp.forEach((m) => {
            enviarPush(m.user_id, '🛵 Nova entrega disponível!', enderecoResumido || 'Toque para ver detalhes', { pedidoId: orderId });
          });

          if (motosInfo?.length) {
            const lojaEndereco = pedido.estabelecimentos?.endereco || '';
            const clienteNome = pedido.profiles?.nome || pedido.guest_nome || 'Cliente';
            const clienteTel = pedido.profiles?.telefone || pedido.guest_telefone || '';
            const freteStr = `R$ ${parseFloat(pedido.taxa_entrega || 0).toFixed(2).replace('.', ',')}`;
            const msgWhatsApp = `🛵 *Nova entrega disponível!*\n🏪 ${lojaNome}\n💰 ${valorStr}\n📍 ${enderecoResumido || 'Ver no app'}\n\nAbra o app para aceitar.`;
            const msgTelegramMoto = `🛵 <b>Nova entrega disponível!</b>\n🏪 ${lojaNome}${lojaEndereco ? ' — ' + lojaEndereco : ''}\n📦 Entregar para: ${clienteNome}${clienteTel ? '\n📞 ' + clienteTel : ''}\n💰 Frete: ${freteStr}\n\n👉 <a href="https://chegouaiapp.com.br/motoboy">Ver no painel</a>`;
            motosInfo.forEach((m) => {
              if (m.telefone) enviarWhatsApp(m.telefone, msgWhatsApp);
              if (m.telegram_chat_id) enviarTelegramChatId(m.telegram_chat_id, msgTelegramMoto);
            });
          }

          // Timer 30s: se nenhum motoboy coletar, alertar admin
          setTimeout(async () => {
            try {
              const { data: chk } = await supabaseAdmin
                .from('pedidos').select('status').eq('id', orderId).maybeSingle();
              if (chk && chk.status === 'pronto') {
                alertarAdmin(`⚠️ *Nenhum motoboy coletou em 30s*\n🏪 ${lojaNome}\n💰 ${valorStr}\n📍 ${enderecoResumido || 'Ver no app'}`);
              }
            } catch (e) {
              console.error('[Timer30s] Erro ao verificar pedido', orderId, e.message);
            }
          }, 30 * 1000);
        } else {
          // Sem motoboy disponível — alertar admin imediatamente
          alertarAdmin(`🚨 *Sem motoboy disponível!*\n🏪 ${lojaNome}\n💰 ${valorStr}\n📍 ${enderecoResumido || 'Ver no app'}`);
        }

        // Motoboy próprio do estabelecimento (sem login — usa FCM direto)
        if (pedido.estabelecimento_id) {
          const { data: est } = await supabaseAdmin
            .from('estabelecimentos')
            .select('motoboy_fcm_token, tipo_entrega')
            .eq('id', pedido.estabelecimento_id)
            .single();

          if (est?.tipo_entrega === 'proprio' && est?.motoboy_fcm_token) {
            const { enviarFCMDireto } = require('./notifications');
            enviarFCMDireto(est.motoboy_fcm_token, '📦 Pedido pronto para entregar!', enderecoResumido || 'Toque para ver detalhes', { pedidoId: orderId });
          }
        }
      }

      // Ao confirmar entrega, repassar taxa de entrega ao motoboy (idempotente)
      if (status === 'entregue' && pedido.motoboy_id) {
        const { data: repasseExistente } = await supabaseAdmin
          .from('repasses')
          .select('id, status, motoboy_id')
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
        } else if (!repasseExistente.motoboy_id || repasseExistente.motoboy_id !== pedido.motoboy_id) {
          // Sem motoboy ou motoboy diferente (reatribuição) — corrigir
          await supabaseAdmin.from('repasses')
            .update({ motoboy_id: pedido.motoboy_id, atualizado_em: new Date().toISOString() })
            .eq('id', repasseExistente.id);
        }

        // Transferir via Pix Pagar.me em background (não bloqueia a resposta)
        if (pedido.pagamento_status === 'aprovado' && valorRepasse > 0) {
          supabaseAdmin.from('motoboys').select('chave_pix').eq('id', pedido.motoboy_id).single()
            .then(({ data: motoboy }) => {
              if (!motoboy?.chave_pix) return;
              return criarTransferenciaPix(motoboy.chave_pix, valorRepasse)
                .then(() => supabaseAdmin.from('repasses')
                  .update({ status: 'pago', atualizado_em: new Date().toISOString() })
                  .eq('pedido_id', orderId).eq('tipo', 'motoboy'))
                .then(() => console.log(`[Repasse] Pix R$${valorRepasse} → motoboy ${pedido.motoboy_id} OK`));
            })
            .catch(e => console.error(`[Repasse] Falha Pix motoboy:`, e.message));
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

      // Atribuir todos de uma vez
      const { error } = await supabaseAdmin
        .from('pedidos')
        .update({ motoboy_id: motoboy.id, status: 'coletado' })
        .in('id', pedidoIds);

      if (error) throw error;

      // Notificar clientes
      pedidos.forEach((p) => {
        if (p.cliente_id) {
          enviarPush(p.cliente_id, 'Chegô', '🛵 Motoboy a caminho! Acompanhe no app.', { pedidoId: p.id, status: 'coletado' });
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
// DELETE /api/orders/motoboy/telegram — Desvincular Telegram do motoboy
// =============================================
router.delete('/motoboy/telegram', requireRole('motoboy'), async (req, res, next) => {
  try {
    await supabaseAdmin
      .from('motoboys')
      .update({ telegram_chat_id: null })
      .eq('user_id', req.user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

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

// =============================================
// POST /api/orders/:id/verificar-coleta
// Motoboy digita o código de 3 dígitos que o lojista mostra
// =============================================
router.post('/:id/verificar-coleta', requireRole('motoboy'), [param('id').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

  const { codigo } = req.body;
  if (!codigo || !/^\d{3}$/.test(String(codigo))) {
    return res.status(400).json({ error: 'Código deve ter exatamente 3 dígitos' });
  }

  try {
    const { data: motoboy } = await supabaseAdmin
      .from('motoboys').select('id').eq('user_id', req.user.id).single();
    if (!motoboy) return res.status(404).json({ error: 'Motoboy não encontrado' });

    const { data: pedido } = await supabaseAdmin
      .from('pedidos')
      .select('id, codigo_coleta, status')
      .eq('id', req.params.id)
      .eq('motoboy_id', motoboy.id)
      .single();

    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (!pedido.codigo_coleta) return res.status(400).json({ error: 'Pedido sem código de coleta' });
    if (pedido.codigo_coleta !== String(codigo)) {
      return res.status(400).json({ error: 'Código incorreto. Confirme com o lojista.' });
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =============================================
// GET /api/orders/:id/chat — Buscar mensagens
// POST /api/orders/:id/chat — Enviar mensagem
// PATCH /api/orders/:id/chat/lida — Marcar como lidas
// =============================================
async function verificarAcessoChat(pedidoId, user) {
  const perfil = user.profile.perfil;
  if (!['cliente', 'motoboy'].includes(perfil)) return null;

  let query = supabaseAdmin.from('pedidos').select('id, status, cliente_id, motoboy_id, telefone_cliente').eq('id', pedidoId);

  if (perfil === 'cliente') {
    query = query.eq('cliente_id', user.id);
  } else {
    const { data: mb } = await supabaseAdmin.from('motoboys').select('id').eq('user_id', user.id).single();
    if (!mb) return null;
    query = query.eq('motoboy_id', mb.id);
  }

  const { data: pedido } = await query.single();
  return pedido || null;
}

router.get('/:id/chat', requireAuth, [param('id').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

  try {
    const pedido = await verificarAcessoChat(req.params.id, req.user);
    if (!pedido) return res.status(403).json({ error: 'Acesso negado' });

    const { data: msgs, error } = await supabaseAdmin
      .from('chat_mensagens')
      .select('id, remetente, mensagem, lida, criado_em')
      .eq('pedido_id', req.params.id)
      .order('criado_em', { ascending: true });

    if (error) throw error;
    res.json(msgs || []);
  } catch (err) { next(err); }
});

router.post('/:id/chat', requireAuth, [param('id').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

  const mensagem = (req.body.mensagem || '').trim().slice(0, 500);
  if (!mensagem) return res.status(400).json({ error: 'Mensagem não pode estar vazia' });

  try {
    const pedido = await verificarAcessoChat(req.params.id, req.user);
    if (!pedido) return res.status(403).json({ error: 'Acesso negado' });
    if (!['aceito', 'preparando', 'pronto', 'coletado', 'saiu_para_entrega', 'entregue'].includes(pedido.status)) {
      return res.status(400).json({ error: 'Chat disponível apenas após confirmação do pedido' });
    }

    const perfil = req.user.profile.perfil;
    const { data: msg, error } = await supabaseAdmin
      .from('chat_mensagens')
      .insert({ pedido_id: req.params.id, remetente: perfil, mensagem })
      .select()
      .single();

    if (error) throw error;
    res.json(msg);
  } catch (err) { next(err); }
});

router.patch('/:id/chat/lida', requireAuth, [param('id').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

  try {
    const pedido = await verificarAcessoChat(req.params.id, req.user);
    if (!pedido) return res.status(403).json({ error: 'Acesso negado' });

    const perfil = req.user.profile.perfil;
    const remetenteOposto = perfil === 'cliente' ? 'motoboy' : 'cliente';

    await supabaseAdmin
      .from('chat_mensagens')
      .update({ lida: true })
      .eq('pedido_id', req.params.id)
      .eq('remetente', remetenteOposto)
      .eq('lida', false);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =============================================
// POST /api/orders/upload-arte — Upload de arte do cliente para encomenda
// =============================================
router.post('/upload-arte', async (req, res, next) => {
  try {
    const { base64, contentType } = req.body;
    if (!base64 || !contentType) return res.status(400).json({ error: 'Dados inválidos' });

    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(contentType)) return res.status(400).json({ error: 'Tipo não permitido' });

    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'Imagem muito grande (máx 8MB)' });

    const ext = contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1];
    const filename = `arte_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

    const { error } = await supabaseAdmin.storage
      .from('produtos')
      .upload(filename, buffer, { contentType, upsert: false });
    if (error) throw error;

    const { data: { publicUrl } } = supabaseAdmin.storage.from('produtos').getPublicUrl(filename);
    res.json({ url: publicUrl });
  } catch (err) { next(err); }
});

module.exports = router;
