const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireRole } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');
const { calcularComissao } = require('../services/commission');
const { cadastrarRecebedor, atualizarTransferenciaRecebedor } = require('../services/pagarme');

const router = express.Router();

// Todas as rotas exigem perfil admin
router.use(requireRole('admin'));

// =============================================
// GET /api/admin/dashboard — Painel geral
// =============================================
router.get('/dashboard', async (req, res, next) => {
  try {
    // Início da semana corrente (últimos 7 dias) em Brasília (UTC-3)
    const agora = new Date();
    const semanaAtras = new Date(agora.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Meia-noite de hoje (Brasília)
    const hoje = new Date(agora);
    hoje.setUTCHours(3, 0, 0, 0);
    if (hoje > agora) hoje.setUTCDate(hoje.getUTCDate() - 1);

    // Pedidos dos últimos 7 dias
    const { data: pedidosHoje } = await supabaseAdmin
      .from('pedidos')
      .select('id, total, subtotal, taxa_entrega, comissao_plataforma, status, pagamento_status, criado_em')
      .gte('criado_em', semanaAtras.toISOString());

    const { data: estabelecimentos } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, categoria, aberto, ativo, cadastro_data, pagarme_recipient_id');

    const { data: motoboys } = await supabaseAdmin
      .from('motoboys')
      .select('id, nome, disponivel, ativo');

    const { data: repasessPendentes } = await supabaseAdmin
      .from('repasses')
      .select('id, tipo, valor, status, criado_em, pedidos(id)')
      .eq('status', 'pendente');

    const pedidosAprovados = pedidosHoje?.filter((p) => p.pagamento_status === 'aprovado') || [];
    const totalFaturamento = pedidosAprovados.reduce((s, p) => s + (p.total || 0), 0);
    // comissao_plataforma = valorPlataforma (5% do subtotal, bruto antes da taxa gateway)
    const totalComissao = pedidosAprovados.reduce((s, p) => s + (p.comissao_plataforma || (p.subtotal || p.total || 0) * 0.05), 0);

    // Comissão por estabelecimento
    const estComComissao = (estabelecimentos || []).map((e) => ({
      ...e,
      comissao: calcularComissao(e.cadastro_data),
    }));

    res.json({
      stats: {
        pedidosHoje: pedidosAprovados.length,
        pedidosAprovados: pedidosAprovados.length,
        faturamentoHoje: parseFloat(totalFaturamento.toFixed(2)),
        comissaoHoje: parseFloat(totalComissao.toFixed(2)),
        estabelecimentosAtivos: estabelecimentos?.filter((e) => e.ativo).length || 0,
        motoboysdisponiveis: motoboys?.filter((m) => m.disponivel && m.ativo).length || 0,
        repasessPendentes: repasessPendentes?.length || 0,
        valorPendente: parseFloat(
          (repasessPendentes?.reduce((s, r) => s + r.valor, 0) || 0).toFixed(2)
        ),
      },
      estabelecimentos: estComComissao,
      motoboys: motoboys || [],
    });
  } catch (err) {
    next(err);
  }
});

// =============================================
// GET /api/admin/pedidos — Todos os pedidos
// =============================================
router.get('/pedidos', async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    let query = supabaseAdmin
      .from('pedidos')
      .select(`
        id, status, pagamento_status, total, subtotal, comissao_plataforma,
        forma_pagamento, criado_em, endereco_entrega,
        estabelecimentos (nome),
        profiles (nome, telefone),
        motoboys (nome)
      `, { count: 'exact' })
      .order('criado_em', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    // Só mostrar pedidos com pagamento aprovado por padrão
    query = query.eq('pagamento_status', 'aprovado');
    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ total: count, pedidos: data });
  } catch (err) {
    next(err);
  }
});

// =============================================
// GET /api/admin/repasses — Repasses pendentes
// =============================================
router.get('/repasses', async (req, res, next) => {
  try {
    const { desde, ate } = req.query;

    // Buscar IDs dos pedidos no período para garantir filtro correto
    let pedidoQuery = supabaseAdmin.from('pedidos').select('id').eq('pagamento_status', 'aprovado');
    if (desde) pedidoQuery = pedidoQuery.gte('criado_em', desde);
    if (ate)   pedidoQuery = pedidoQuery.lte('criado_em', ate + 'T23:59:59');
    const { data: pedidosRange } = await pedidoQuery;
    const pedidoIds = (pedidosRange || []).map(p => p.id);

    if (pedidoIds.length === 0) return res.json([]);

    const { data, error } = await supabaseAdmin
      .from('repasses')
      .select(`
        *,
        motoboys (id, nome, telefone, chave_pix),
        pedidos!inner (id, total, subtotal, taxa_entrega, criado_em, estabelecimentos(id, nome), motoboys(id, nome, chave_pix))
      `)
      .in('pedido_id', pedidoIds)
      .order('criado_em', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/repasses/reconciliar — Cria repasses faltantes para todos os pedidos aprovados
router.post('/repasses/reconciliar', async (req, res, next) => {
  try {
    const { calcularSplit } = require('../services/commission');

    // Buscar todos os pedidos aprovados sem repasse lojista
    const { data: pedidos } = await supabaseAdmin
      .from('pedidos')
      .select('id, subtotal, taxa_entrega, forma_pagamento, estabelecimentos(tipo_entrega)')
      .eq('pagamento_status', 'aprovado')
      .neq('status', 'cancelado');

    if (!pedidos || pedidos.length === 0) return res.json({ criados: 0 });

    const pedidoIds = pedidos.map(p => p.id);
    const { data: repassesExist } = await supabaseAdmin
      .from('repasses').select('pedido_id').eq('tipo', 'lojista').in('pedido_id', pedidoIds);

    const comRepasse = new Set((repassesExist || []).map(r => r.pedido_id));
    const faltando = pedidos.filter(p => !comRepasse.has(p.id));

    if (faltando.length === 0) return res.json({ criados: 0, msg: 'Nenhum repasse faltando' });

    const novos = faltando.map(p => {
      const tipoEntrega = p.estabelecimentos?.tipo_entrega || 'app';
      const split = calcularSplit({ subtotal: p.subtotal, taxaEntrega: p.taxa_entrega, formaPagamento: p.forma_pagamento, tipoEntrega });
      const rows = [
        { pedido_id: p.id, tipo: 'lojista',    valor: split.valorLojista,    status: 'pendente' },
        { pedido_id: p.id, tipo: 'plataforma', valor: split.valorPlataforma, status: 'pago' },
      ];
      if (split.valorMotoboy > 0) rows.splice(1, 0, { pedido_id: p.id, tipo: 'motoboy', valor: split.valorMotoboy, status: 'pendente' });
      return rows;
    }).flat();

    const { error } = await supabaseAdmin.from('repasses').insert(novos);
    if (error) throw error;

    res.json({ criados: faltando.length, repasses_inseridos: novos.length });
  } catch (err) { next(err); }
});

// PATCH /api/admin/repasses/:id/pagar — Marcar repasse como pago
router.patch('/repasses/:id/pagar', async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('repasses')
      .update({ status: 'pago', atualizado_em: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =============================================
// GET /api/admin/monitor — Monitoramento em tempo real
// Pedidos ativos + GPS de todos os motoboys
// =============================================
router.get('/monitor', async (req, res, next) => {
  try {
    const statusAtivos = ['pendente', 'aceito', 'preparando', 'pronto', 'coletado', 'saiu_para_entrega'];
    // Tempo máximo razoável por status — pedidos mais velhos que isso estão travados
    const limiteAtivo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h

    const [{ data: pedidos }, { data: motoboys }, { data: estabelecimentos }] = await Promise.all([
      supabaseAdmin
        .from('pedidos')
        .select(`
          id, status, pagamento_status, total, subtotal, taxa_entrega,
          forma_pagamento, criado_em, endereco_entrega, guest_nome,
          estabelecimentos (id, nome),
          profiles (nome, telefone),
          motoboys (id, nome, lat, lng)
        `)
        .in('status', statusAtivos)
        .eq('pagamento_status', 'aprovado')
        .gte('criado_em', limiteAtivo)
        .order('criado_em', { ascending: false }),

      supabaseAdmin
        .from('motoboys')
        .select('id, nome, disponivel, ativo, lat, lng')
        .eq('ativo', true)
        .order('nome'),

      supabaseAdmin
        .from('estabelecimentos')
        .select('id, nome, aberto, pausado, ativo, categoria, emoji, horarios')
        .eq('ativo', true)
        .order('nome'),
    ]);

    // Calcular aberto dinamicamente com base nos horários (igual ao endpoint público)
    const diasMap = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
    const agoraBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Eirunepe' }));
    const diaKey = diasMap[agoraBR.getDay()];
    const minAtual = agoraBR.getHours() * 60 + agoraBR.getMinutes();
    (estabelecimentos || []).forEach(est => {
      if (est.horarios && Object.keys(est.horarios).length > 0) {
        const h = est.horarios[diaKey];
        if (h && h.abre && h.fecha) {
          const [hA, mA] = h.abre.split(':').map(Number);
          const [hF, mF] = h.fecha.split(':').map(Number);
          est.aberto = minAtual >= hA * 60 + mA && minAtual < hF * 60 + mF;
        } else {
          est.aberto = false;
        }
      }
      if (est.pausado) est.aberto = false;
    });

    // Calcular pedidos pendentes e tempo máximo de espera por loja
    const agora = new Date();
    const statsLoja = {};
    for (const p of (pedidos || [])) {
      const estId = p.estabelecimentos?.id;
      if (!estId) continue;
      if (!statsLoja[estId]) statsLoja[estId] = { pendentes: 0, max_espera_min: 0 };
      statsLoja[estId].pendentes++;
      if (p.status === 'pendente') {
        const min = Math.floor((agora - new Date(p.criado_em)) / 60000);
        if (min > statsLoja[estId].max_espera_min) statsLoja[estId].max_espera_min = min;
      }
    }

    const estabelecimentosComStats = (estabelecimentos || []).map(e => ({
      ...e,
      pedidos_ativos: statsLoja[e.id]?.pendentes || 0,
      max_espera_min: statsLoja[e.id]?.max_espera_min || 0,
    }));

    // Calcular minutos desde criação para cada pedido
    const pedidosEnriquecidos = (pedidos || []).map(p => ({
      ...p,
      minutos_ativo: Math.floor((agora - new Date(p.criado_em)) / 60000),
    }));

    res.json({
      pedidos_ativos: pedidosEnriquecidos,
      motoboys: motoboys || [],
      estabelecimentos: estabelecimentosComStats,
      atualizado_em: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// =============================================
// POST /api/admin/pedidos/:id/encerrar — Forçar cancelamento de pedido travado
// =============================================
router.post('/pedidos/:id/encerrar', [param('id').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { error } = await supabaseAdmin
      .from('pedidos')
      .update({ status: 'cancelado', atualizado_em: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =============================================
// GET /api/admin/sorteio — Dados para o painel do sorteio
// =============================================
router.get('/sorteio', async (req, res, next) => {
  try {
    const { desde, ate } = req.query;
    const dataInicio = desde || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dataFim = ate || new Date().toISOString().slice(0, 10);

    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .select('id, telefone_cliente, indicado_por, total, criado_em, nome_cliente, guest_nome, profiles(nome)')
      .eq('pagamento_status', 'aprovado')
      .gte('criado_em', dataInicio + 'T00:00:00.000Z')
      .lte('criado_em', dataFim + 'T23:59:59.999Z')
      .gte('total', 0)
      .order('criado_em', { ascending: false });

    if (error) throw error;

    // Calcular tickets: 1 por pedido + 1 extra por pessoa única indicada
    const ticketsPorTelefone = {};
    const indicadosPorIndicador = {};
    const nomePorTelefone = {};

    for (const p of data) {
      const tel = (p.telefone_cliente || '').replace(/\D/g, '').slice(-11);
      if (!tel || tel.length < 10) continue;
      ticketsPorTelefone[tel] = (ticketsPorTelefone[tel] || 0) + 1;
      if (!nomePorTelefone[tel]) {
        nomePorTelefone[tel] = (p.profiles && p.profiles.nome) || p.nome_cliente || p.guest_nome || null;
      }

      if (p.indicado_por) {
        const indicador = p.indicado_por.replace(/\D/g, '').slice(-11);
        if (indicador && indicador.length >= 10 && indicador !== tel) {
          if (!indicadosPorIndicador[indicador]) indicadosPorIndicador[indicador] = new Set();
          indicadosPorIndicador[indicador].add(tel);
        }
      }
    }

    // Adicionar tickets extras para quem indicou
    for (const [indicador, indicados] of Object.entries(indicadosPorIndicador)) {
      ticketsPorTelefone[indicador] = (ticketsPorTelefone[indicador] || 0) + indicados.size;
    }

    const ranking = Object.entries(ticketsPorTelefone)
      .map(([telefone, tickets]) => ({
        telefone,
        nome: nomePorTelefone[telefone] || null,
        tickets,
        indicacoes: indicadosPorIndicador[telefone] ? indicadosPorIndicador[telefone].size : 0,
      }))
      .sort((a, b) => b.tickets - a.tickets);

    res.json({
      pedidos: data.length,
      participantes: ranking.length,
      totalTickets: ranking.reduce((s, r) => s + r.tickets, 0),
      ranking,
      periodo: { desde: dataInicio, ate: dataFim },
    });
  } catch (err) { next(err); }
});

// =============================================
// POST /api/admin/establishments — Cadastrar loja
// =============================================
router.post(
  '/establishments',
  [
    body('nome').trim().isLength({ min: 2, max: 100 }).escape(),
    body('telefone').matches(/^\d{10,11}$/).withMessage('Telefone inválido'),
    body('email').isEmail().normalizeEmail(),
    body('senha').isLength({ min: 6 }),
    body('categoria').isIn(['restaurante', 'mercado', 'farmacia', 'lanche', 'bebida', 'loja', 'encomenda']),
    body('chave_pix').optional().trim(),
    body('mpUserId').optional().trim(),
    body('whatsapp').optional().trim().matches(/^\d{0,15}$/),
    body('lat').optional().isFloat({ min: -90, max: 90 }),
    body('lng').optional().isFloat({ min: -180, max: 180 }),
    body('cidade').optional().trim().isLength({ max: 100 }),
    body('estado').optional().trim().isLength({ max: 2 }),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { nome, telefone, email, senha, categoria, chave_pix, mpUserId, whatsapp, lat, lng, cidade, estado } = req.body;

    let authUserId = null;
    try {
      // Verificar se telefone já existe noutro perfil
      const { data: telExiste } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('telefone', telefone)
        .maybeSingle();
      if (telExiste) {
        return res.status(409).json({ error: 'Telefone já cadastrado noutro perfil' });
      }

      // Criar usuário Supabase Auth
      const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: senha,
        email_confirm: true,
        user_metadata: { nome, telefone },
      });
      if (authErr) {
        if (authErr.message.includes('already been registered') || authErr.message.includes('already registered')) {
          return res.status(409).json({ error: 'E-mail já cadastrado' });
        }
        throw authErr;
      }
      authUserId = authData.user.id;

      // Upsert do perfil
      const { error: profileErr } = await supabaseAdmin
        .from('profiles')
        .upsert({ id: authUserId, nome, telefone, email, perfil: 'estabelecimento' });
      if (profileErr) {
        await supabaseAdmin.auth.admin.deleteUser(authUserId);
        return res.status(400).json({ error: profileErr.message });
      }

      // Criar estabelecimento
      const { data: est, error: estErr } = await supabaseAdmin
        .from('estabelecimentos')
        .insert({
          user_id: authUserId,
          nome,
          categoria,
          mp_user_id: chave_pix || mpUserId || null,
          whatsapp: whatsapp || null,
          cadastro_data: new Date().toISOString(),
          lat: lat || null,
          lng: lng || null,
          cidade: cidade || null,
          estado: estado || null,
        })
        .select()
        .single();

      if (estErr) {
        await supabaseAdmin.auth.admin.deleteUser(authUserId);
        throw estErr;
      }

      res.status(201).json({
        message: 'Loja cadastrada com sucesso',
        estabelecimento: est,
        login: { email, perfil: 'estabelecimento' },
      });
    } catch (err) {
      next(err);
    }
  }
);

// =============================================
// GET /api/admin/motoboys/localizacoes — GPS em tempo real de todos os motoboys
// =============================================
router.get('/motoboys/localizacoes', async (req, res, next) => {
  try {
    const { data } = await supabaseAdmin
      .from('motoboys')
      .select('id, nome, disponivel, ativo, lat, lng, atualizado_em')
      .eq('ativo', true)
      .not('lat', 'is', null);
    res.json(data || []);
  } catch (err) { next(err); }
});

// =============================================
// POST /api/admin/motoboys — Cadastrar motoboy
// =============================================
router.post(
  '/motoboys',
  [
    body('nome').trim().isLength({ min: 2, max: 100 }).escape(),
    body('telefone').matches(/^\d{10,11}$/).withMessage('Telefone inválido'),
    body('email').isEmail().normalizeEmail(),
    body('senha').isLength({ min: 6 }),
    body('moto').optional().trim().isLength({ max: 100 }).escape(),
    body('chave_pix').optional().trim(),
    body('mpUserId').optional().trim(),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { nome, telefone, email, senha, moto, chave_pix, mpUserId } = req.body;
    const emailInterno = `tel_${telefone}@chegouai.app`;

    try {
      // PASSO 1: Se já existe perfil com esse telefone, só atualizar a senha
      const { data: perfilExistente } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('telefone', telefone)
        .maybeSingle();

      let userId;

      if (perfilExistente) {
        userId = perfilExistente.id;
        await supabaseAdmin.auth.admin.updateUserById(userId, { email: emailInterno, password: senha });
      } else {
        // Novo cadastro — NÃO passar telefone no user_metadata para não conflitar com o trigger
        const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
          email: emailInterno,
          password: senha,
          email_confirm: true,
          user_metadata: { nome },
        });
        if (authErr) {
          if (authErr.message && authErr.message.includes('already')) {
            // emailInterno já existe — buscar userId via listUsers
            const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
            const existing = users.find(u => u.email === emailInterno);
            if (!existing) return res.status(409).json({ error: 'Telefone já cadastrado' });
            userId = existing.id;
            await supabaseAdmin.auth.admin.updateUserById(userId, { password: senha });
          } else {
            throw authErr;
          }
        } else {
          userId = authData.user.id;
        }
      }

      // PASSO 2: Upsert do perfil com telefone e e-mail interno
      const { error: profileErr } = await supabaseAdmin
        .from('profiles')
        .upsert({ id: userId, nome, telefone, email: emailInterno, perfil: 'motoboy' });

      if (profileErr) {
        console.error('[Admin] Erro update profile:', profileErr.message);
        return res.status(500).json({ error: 'Erro ao salvar perfil do motoboy: ' + profileErr.message });
      }

      // PASSO 3: Inserir na tabela motoboys (verificar se ja existe)
      const { data: motoboyExistente } = await supabaseAdmin
        .from('motoboys')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle();

      let motoboy;
      if (motoboyExistente) {
        // Ja existe, atualizar
        const { data: mb, error: mbErr } = await supabaseAdmin
          .from('motoboys')
          .update({ nome, telefone, moto: moto || '', chave_pix: chave_pix || null })
          .eq('user_id', userId)
          .select()
          .single();
        if (mbErr) {
          console.error('[Admin] Erro update motoboy:', mbErr.message);
          return res.status(500).json({ error: 'Erro ao atualizar motoboy: ' + mbErr.message });
        }
        motoboy = mb;
      } else {
        const { data: mb, error: mbErr } = await supabaseAdmin
          .from('motoboys')
          .insert({
            user_id: userId,
            nome,
            telefone,
            moto: moto || '',
            chave_pix: chave_pix || null,
            mp_user_id: mpUserId || null,
          })
          .select()
          .single();
        if (mbErr) {
          console.error('[Admin] Erro insert motoboy:', mbErr.message);
          return res.status(500).json({ error: 'Erro ao salvar motoboy: ' + mbErr.message });
        }
        motoboy = mb;
      }

      res.status(201).json({
        message: 'Motoboy cadastrado com sucesso',
        motoboy,
        login: { email, perfil: 'motoboy' },
      });
    } catch (err) {
      console.error('[Admin] Erro geral cadastro motoboy:', err.message);
      res.status(500).json({ error: 'Erro no cadastro: ' + err.message });
    }
  }
);

// =============================================
// PUT /api/admin/establishments/:id — Editar dados da loja
// =============================================
router.put('/establishments/:id', async (req, res, next) => {
  try {
    const campos = {};
    ['nome', 'categoria', 'tempo_entrega', 'taxa_entrega', 'emoji', 'aberto', 'whatsapp', 'valor_minimo', 'endereco', 'lat', 'lng', 'slug'].forEach((k) => {
      if (req.body[k] !== undefined) campos[k] = req.body[k];
    });
    const { data, error } = await supabaseAdmin
      .from('estabelecimentos')
      .update(campos)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// =============================================
// PATCH /api/admin/establishments/:id/toggle — Ativar/desativar loja
// =============================================
router.patch('/establishments/:id/toggle', async (req, res, next) => {
  try {
    const { data: est } = await supabaseAdmin
      .from('estabelecimentos')
      .select('ativo')
      .eq('id', req.params.id)
      .single();

    if (!est) return res.status(404).json({ error: 'Loja não encontrada' });

    const { data, error } = await supabaseAdmin
      .from('estabelecimentos')
      .update({ ativo: !est.ativo })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ ativo: data.ativo, message: data.ativo ? 'Loja ativada' : 'Loja desativada' });
  } catch (err) {
    next(err);
  }
});
// =============================================
// DELETE /api/admin/establishments/:id — Excluir loja permanentemente
// =============================================
router.delete('/establishments/:id', async (req, res, next) => {
  try {
    // Buscar user_id antes de deletar
    const { data: est } = await supabaseAdmin
      .from('estabelecimentos')
      .select('user_id')
      .eq('id', req.params.id)
      .single();

    const { error } = await supabaseAdmin
      .from('estabelecimentos')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    // Deletar perfil e usuário auth para impedir login fantasma
    if (est?.user_id) {
      await supabaseAdmin.from('profiles').delete().eq('id', est.user_id);
      await supabaseAdmin.auth.admin.deleteUser(est.user_id);
    }

    res.json({ ok: true, message: 'Loja excluída com sucesso' });
  } catch (err) {
    next(err);
  }
});

// =============================================
// PUT /api/admin/motoboys/:id — Editar dados do motoboy
// =============================================
router.put('/motoboys/:id', async (req, res, next) => {
  try {
    const campos = {};
    ['nome', 'telefone', 'moto', 'chave_pix'].forEach((k) => {
      if (req.body[k] !== undefined) campos[k] = req.body[k];
    });
    const { data, error } = await supabaseAdmin
      .from('motoboys')
      .update(campos)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// =============================================
// POST /api/admin/motoboys/:id/reset-senha — Redefinir senha do motoboy
// =============================================
router.post('/motoboys/:id/reset-senha', async (req, res, next) => {
  try {
    const { senha } = req.body;
    if (!senha || senha.length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });

    const { data: motoboy } = await supabaseAdmin
      .from('motoboys')
      .select('user_id')
      .eq('id', req.params.id)
      .single();

    if (!motoboy?.user_id) return res.status(404).json({ error: 'Motoboy não encontrado' });

    const { error } = await supabaseAdmin.auth.admin.updateUserById(motoboy.user_id, { password: senha });
    if (error) throw error;

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =============================================
// PATCH /api/admin/motoboys/:id/toggle — Ativar/desativar motoboy
// =============================================
router.patch('/motoboys/:id/toggle', async (req, res, next) => {
  try {
    const { data: motoboy } = await supabaseAdmin
      .from('motoboys')
      .select('ativo')
      .eq('id', req.params.id)
      .single();

    if (!motoboy) return res.status(404).json({ error: 'Motoboy não encontrado' });

    const { data, error } = await supabaseAdmin
      .from('motoboys')
      .update({ ativo: !motoboy.ativo })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ ativo: data.ativo, message: data.ativo ? 'Motoboy ativado' : 'Motoboy desativado' });
  } catch (err) {
    next(err);
  }
});

// =============================================
// DELETE /api/admin/motoboys/:id — Excluir motoboy
// =============================================
router.delete('/motoboys/:id', async (req, res, next) => {
  try {
    const { data: motoboy } = await supabaseAdmin
      .from('motoboys')
      .select('id, user_id')
      .eq('id', req.params.id)
      .single();

    if (!motoboy) return res.status(404).json({ error: 'Motoboy não encontrado' });

    // Remover registro na tabela motoboys
    const { error } = await supabaseAdmin
      .from('motoboys')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    // Remover perfil e usuário do Auth (se tiver user_id)
    if (motoboy.user_id) {
      await supabaseAdmin.from('profiles').delete().eq('id', motoboy.user_id);
      await supabaseAdmin.auth.admin.deleteUser(motoboy.user_id);
    }

    res.json({ message: 'Motoboy excluído com sucesso' });
  } catch (err) {
    next(err);
  }
});

// =============================================
// GET /api/admin/cupons — Listar cupons
// =============================================
router.get('/cupons', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('cupons_plataforma')
      .select('*')
      .order('id', { ascending: false });
    if (error) {
      console.error('[Admin] Erro ao listar cupons:', error.message, error.code);
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        return res.json([]);
      }
      throw error;
    }
    res.json(data || []);
  } catch (err) { next(err); }
});

// =============================================
// POST /api/admin/cupons — Criar cupom
// =============================================
router.post(
  '/cupons',
  [
    body('codigo').trim().isLength({ min: 2, max: 50 }).withMessage('Código inválido'),
    body('desconto_tipo').isIn(['percentual', 'fixo']).withMessage('Tipo inválido'),
    body('desconto_valor').optional({ nullable: true, checkFalsy: true }).isFloat({ min: 0 }).withMessage('Valor inválido'),
    body('usos_max').optional().isInt({ min: 0 }),
    body('validade').optional({ nullable: true, checkFalsy: true }).isISO8601().withMessage('Data inválida'),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { codigo, desconto_tipo, desconto_valor, usos_max, validade, valor_minimo, frete_gratis } = req.body;
    try {
      const { data, error } = await supabaseAdmin
        .from('cupons_plataforma')
        .insert({
          codigo: codigo.toUpperCase(),
          desconto_tipo,
          desconto_valor: parseFloat(desconto_valor || 0),
          usos_max: (usos_max !== undefined && usos_max !== null) ? parseInt(usos_max) : 0,
          validade: validade || null,
          valor_minimo: parseFloat(valor_minimo || 0),
          frete_gratis: !!frete_gratis,
        })
        .select()
        .single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Código de cupom já existe' });
        throw error;
      }
      res.status(201).json(data);
    } catch (err) { next(err); }
  }
);

// =============================================
// PATCH /api/admin/cupons/:id — Ativar/desativar ou editar cupom
// =============================================
router.patch('/cupons/:id', async (req, res, next) => {
  try {
    const campos = {};
    if (req.body.ativo !== undefined) campos.ativo = !!req.body.ativo;
    if (req.body.frete_gratis !== undefined) campos.frete_gratis = !!req.body.frete_gratis;
    if (req.body.desconto_tipo !== undefined) campos.desconto_tipo = req.body.desconto_tipo;
    if (req.body.desconto_valor !== undefined) campos.desconto_valor = parseFloat(req.body.desconto_valor);
    if (req.body.usos_max !== undefined) campos.usos_max = parseInt(req.body.usos_max);
    if (req.body.valor_minimo !== undefined) campos.valor_minimo = parseFloat(req.body.valor_minimo);
    if (req.body.validade !== undefined) campos.validade = req.body.validade || null;
    const { data, error } = await supabaseAdmin
      .from('cupons_plataforma')
      .update(campos)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// =============================================
// DELETE /api/admin/cupons/:id — Excluir cupom
// =============================================
router.delete('/cupons/:id', async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('cupons_plataforma')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =============================================
// POST /api/admin/aviso — Definir ou limpar aviso na home
// =============================================
router.post('/aviso', async (req, res, next) => {
  try {
    const { setAviso } = require('../services/aviso');
    await setAviso(req.body.texto || '');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =============================================
// POST /api/admin/push-broadcast — Notificação para todos os clientes
// =============================================
router.post('/push-broadcast', async (req, res, next) => {
  try {
    const { titulo, corpo } = req.body;
    if (!titulo || !corpo) return res.status(400).json({ error: 'Título e corpo obrigatórios' });

    const { enviarPush } = require('./notifications');

    // Buscar todos os user_ids com push subscription ativa
    const { data: subs, error } = await supabaseAdmin
      .from('push_subscriptions')
      .select('user_id');

    if (error) throw error;
    if (!subs || subs.length === 0) return res.json({ enviados: 0 });

    let enviados = 0;
    for (const sub of subs) {
      try {
        await enviarPush(sub.user_id, titulo, corpo, { tipo: 'broadcast' });
        enviados++;
      } catch (_) {}
    }

    console.log(`[Admin] Broadcast enviado: ${enviados}/${subs.length}`);
    res.json({ enviados, total: subs.length });
  } catch (err) { next(err); }
});

// =============================================
// POST /api/admin/establishments/:id/recipient
// Cadastrar lojista como recebedor no Pagar.me
// =============================================
router.post('/establishments/:id/recipient', [
  body('nome').notEmpty().withMessage('Nome obrigatório'),
  body('email').isEmail().withMessage('E-mail inválido'),
  body('cpf').matches(/^\d{11}$/).withMessage('CPF inválido (11 dígitos)'),
  body('banco').notEmpty().withMessage('Banco obrigatório'),
  body('agencia').notEmpty().withMessage('Agência obrigatória'),
  body('conta').notEmpty().withMessage('Conta obrigatória'),
  body('tipo_conta').isIn(['checking', 'savings']).withMessage('Tipo de conta inválido'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { nome, email, cpf, banco, agencia, conta, digito, tipo_conta } = req.body;

    const recipientId = await cadastrarRecebedor({
      nome,
      email,
      cpf,
      contaBancaria: {
        holder_name: nome,
        holder_type: 'individual',
        holder_document: cpf,
        bank: banco.replace(/\D/g, '').replace(/^0+/, '').padStart(3, '0'),
        branch_number: agencia,
        account_number: conta,
        account_check_digit: digito,
        type: tipo_conta, // 'checking' ou 'savings'
      },
    });

    const { error: dbError } = await supabaseAdmin
      .from('estabelecimentos')
      .update({ pagarme_recipient_id: recipientId })
      .eq('id', req.params.id);

    if (dbError) throw new Error('Pagar.me OK mas falha ao salvar no banco: ' + dbError.message);

    res.json({ recipientId, message: 'Recebedor cadastrado com sucesso' });
  } catch (err) {
    console.error('[Admin] Cadastrar recebedor:', err.message);
    next(err);
  }
});

// =============================================
// PATCH /api/admin/establishments/:id/recipient/transfer
// Ativar transferência automática diária para recipient existente
// =============================================
router.patch('/establishments/:id/recipient/transfer', async (req, res, next) => {
  try {
    const { data: est } = await supabaseAdmin
      .from('estabelecimentos')
      .select('pagarme_recipient_id, nome')
      .eq('id', req.params.id)
      .single();

    if (!est?.pagarme_recipient_id) {
      return res.status(400).json({ error: 'Loja não tem recipient Pagar.me cadastrado' });
    }

    await atualizarTransferenciaRecebedor(est.pagarme_recipient_id);
    res.json({ ok: true, message: `Transferência automática ativada para ${est.nome}` });
  } catch (err) {
    console.error('[Admin] Atualizar transferência recipient:', err.message);
    next(err);
  }
});

// =============================================
// GET /api/admin/metrics-ceo — Dashboard CEO (tempo real)
// =============================================
router.get('/metrics-ceo', async (req, res, next) => {
  try {
    const agora = new Date();

    // Limites de tempo (UTC-4 Manaus)
    const offsetMs = 4 * 60 * 60 * 1000;
    const agoraLocal = new Date(agora.getTime() - offsetMs);
    const inicioHojeLocal = new Date(agoraLocal.toISOString().slice(0, 10) + 'T00:00:00');
    const inicioHojeUTC = new Date(inicioHojeLocal.getTime() + offsetMs);
    const inicioOntemUTC = new Date(inicioHojeUTC.getTime() - 24 * 60 * 60 * 1000);
    const fimOntemUTC = new Date(inicioHojeUTC.getTime() - 1);
    const inicioSemanaUTC = new Date(agora.getTime() - 7 * 24 * 60 * 60 * 1000);
    const inicioSemanaAntUTC = new Date(agora.getTime() - 14 * 24 * 60 * 60 * 1000);
    const inicio30 = new Date(agora.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      { data: pedidosHoje },
      { data: pedidosOntem },
      { data: pedidosSemana },
      { data: pedidosSemanaAnt },
      { data: pedidos30 },
      { data: pedidosAtivos },
      { count: motoboysonline },
      { count: lojistasAtivos },
      { data: topLojas30 },
      { data: topMotoboys30 },
    ] = await Promise.all([
      // Pedidos hoje
      supabaseAdmin.from('pedidos')
        .select('id, total, comissao_plataforma, status, pagamento_status')
        .gte('criado_em', inicioHojeUTC.toISOString()),
      // Pedidos ontem
      supabaseAdmin.from('pedidos')
        .select('id, total, comissao_plataforma, status, pagamento_status')
        .gte('criado_em', inicioOntemUTC.toISOString())
        .lte('criado_em', fimOntemUTC.toISOString()),
      // Pedidos esta semana
      supabaseAdmin.from('pedidos')
        .select('id, total, status, pagamento_status')
        .gte('criado_em', inicioSemanaUTC.toISOString()),
      // Pedidos semana anterior
      supabaseAdmin.from('pedidos')
        .select('id, total, status, pagamento_status')
        .gte('criado_em', inicioSemanaAntUTC.toISOString())
        .lt('criado_em', inicioSemanaUTC.toISOString()),
      // Pedidos 30 dias (para gráfico GMV + funil)
      supabaseAdmin.from('pedidos')
        .select('id, total, comissao_plataforma, status, pagamento_status, criado_em, estabelecimento_id')
        .gte('criado_em', inicio30.toISOString())
        .order('criado_em', { ascending: true }),
      // Pedidos ativos agora (com timestamp para detectar travados)
      supabaseAdmin.from('pedidos')
        .select('id, status, total, criado_em, motoboy_id, estabelecimentos(nome)')
        .in('status', ['pendente', 'aceito', 'preparando', 'pronto', 'coletado', 'saiu_para_entrega'])
        .eq('pagamento_status', 'aprovado'),
      // Motoboys online
      supabaseAdmin.from('motoboys').select('id', { count: 'exact', head: true }).eq('disponivel', true).eq('ativo', true),
      // Lojistas ativos
      supabaseAdmin.from('estabelecimentos').select('id', { count: 'exact', head: true }).eq('ativo', true),
      // Top 5 lojas por GMV (30 dias)
      supabaseAdmin.from('pedidos')
        .select('estabelecimento_id, total, status, pagamento_status, estabelecimentos(nome)')
        .eq('pagamento_status', 'aprovado')
        .eq('status', 'entregue')
        .gte('criado_em', inicio30.toISOString()),
      // Top 5 motoboys por entregas (30 dias)
      supabaseAdmin.from('pedidos')
        .select('motoboy_id, total, comissao_motoboy, taxa_entrega, motoboys(nome)')
        .eq('status', 'entregue')
        .eq('pagamento_status', 'aprovado')
        .not('motoboy_id', 'is', null)
        .gte('criado_em', inicio30.toISOString()),
    ]);

    // ---- Helpers ----
    const aprov = (arr) => (arr || []).filter(p => p.pagamento_status === 'aprovado');
    const entregues = (arr) => (arr || []).filter(p => p.status === 'entregue');
    const gmv = (arr) => arr.reduce((s, p) => s + Number(p.total || 0), 0);
    const comissao = (arr) => arr.reduce((s, p) => s + Number(p.comissao_plataforma || 0), 0);
    const pct = (a, b) => b > 0 ? parseFloat(((a - b) / b * 100).toFixed(1)) : (a > 0 ? 100 : 0);

    // ---- Hoje ----
    const hojeAprov = aprov(pedidosHoje);
    const hojeEnt = entregues(hojeAprov);
    const gmvHoje = gmv(hojeEnt);
    const comissaoHoje = comissao(hojeEnt);
    const ticketHoje = hojeEnt.length ? gmvHoje / hojeEnt.length : 0;

    // ---- Ontem ----
    const ontemAprov = aprov(pedidosOntem);
    const ontemEnt = entregues(ontemAprov);
    const gmvOntem = gmv(ontemEnt);
    const comissaoOntem = comissao(ontemEnt);

    // ---- Semana ----
    const semAprov = aprov(pedidosSemana);
    const semEnt = entregues(semAprov);
    const semAntAprov = aprov(pedidosSemanaAnt);
    const semAntEnt = entregues(semAntAprov);

    // ---- 30 dias: funil ----
    const p30 = pedidos30 || [];
    const funnelCriados = p30.length;
    const funnelAprovados = aprov(p30).length;
    const funnelEntregues = entregues(aprov(p30)).length;

    // ---- GMV por dia (gráfico, 30 dias) ----
    const gmvPorDia = {};
    aprov(p30).filter(p => p.status === 'entregue').forEach(p => {
      const dia = p.criado_em.slice(0, 10);
      gmvPorDia[dia] = (gmvPorDia[dia] || 0) + Number(p.total || 0);
    });

    // ---- Top lojas ----
    const lojaMap = {};
    (topLojas30 || []).forEach(p => {
      const id = p.estabelecimento_id;
      if (!lojaMap[id]) lojaMap[id] = { nome: p.estabelecimentos?.nome || id, gmv: 0, pedidos: 0 };
      lojaMap[id].gmv += Number(p.total || 0);
      lojaMap[id].pedidos += 1;
    });
    const topLojas = Object.values(lojaMap).sort((a, b) => b.gmv - a.gmv).slice(0, 5);

    // ---- Top motoboys ----
    const motoMap = {};
    (topMotoboys30 || []).forEach(p => {
      const id = p.motoboy_id;
      if (!motoMap[id]) motoMap[id] = { nome: p.motoboys?.nome || 'Motoboy', entregas: 0, ganhos: 0 };
      motoMap[id].entregas += 1;
      motoMap[id].ganhos += Number(p.comissao_motoboy ?? p.taxa_entrega ?? 0);
    });
    const topMotoboys = Object.values(motoMap).sort((a, b) => b.entregas - a.entregas).slice(0, 5);

    // ---- Alertas operacionais em tempo real ----
    const agora2 = Date.now();
    const alertasCeo = [];
    for (const p of (pedidosAtivos || [])) {
      const min = Math.floor((agora2 - new Date(p.criado_em).getTime()) / 60000);
      const loja = p.estabelecimentos?.nome || 'Loja';
      const val = 'R$ ' + parseFloat(p.total || 0).toFixed(2).replace('.', ',');
      if (p.status === 'pendente' && min >= 3) {
        alertasCeo.push({ prioridade: 'critica', icone: '🚨', msg: `${loja} — sem aceite há ${min}min · ${val}`, pedidoId: p.id });
      } else if (p.status === 'pronto' && !p.motoboy_id && min >= 5) {
        alertasCeo.push({ prioridade: 'critica', icone: '🚨', msg: `${loja} — pronto sem motoboy há ${min}min · ${val}`, pedidoId: p.id });
      } else if ((p.status === 'aceito' || p.status === 'preparando') && min >= 30) {
        alertasCeo.push({ prioridade: 'atencao', icone: '⚠️', msg: `${loja} — preparo há ${min}min · ${val}`, pedidoId: p.id });
      } else if ((p.status === 'coletado' || p.status === 'saiu_para_entrega') && min >= 45) {
        alertasCeo.push({ prioridade: 'atencao', icone: '⚠️', msg: `${loja} — em rota há ${min}min · ${val}`, pedidoId: p.id });
      }
    }
    alertasCeo.sort((a, b) => (a.prioridade === 'critica' ? -1 : 1) - (b.prioridade === 'critica' ? -1 : 1));

    res.json({
      atualizadoEm: agora.toISOString(),
      hoje: {
        gmv: parseFloat(gmvHoje.toFixed(2)),
        comissao: parseFloat(comissaoHoje.toFixed(2)),
        pedidos: hojeAprov.length,
        entregues: hojeEnt.length,
        ticketMedio: parseFloat(ticketHoje.toFixed(2)),
        varGmv: pct(gmvHoje, gmvOntem),
        varPedidos: pct(hojeAprov.length, ontemAprov.length),
        varComissao: pct(comissaoHoje, comissaoOntem),
      },
      ontem: {
        gmv: parseFloat(gmvOntem.toFixed(2)),
        pedidos: ontemAprov.length,
        entregues: ontemEnt.length,
      },
      semana: {
        gmv: parseFloat(gmv(semEnt).toFixed(2)),
        pedidos: semAprov.length,
        entregues: semEnt.length,
        varGmv: pct(gmv(semEnt), gmv(semAntEnt)),
        varPedidos: pct(semAprov.length, semAntAprov.length),
      },
      aovivo: {
        pedidosAtivos: (pedidosAtivos || []).length,
        motoboysonline: motoboysonline || 0,
        lojistasAtivos: lojistasAtivos || 0,
      },
      funil: {
        criados: funnelCriados,
        aprovados: funnelAprovados,
        entregues: funnelEntregues,
        taxaConversao: funnelCriados > 0 ? parseFloat((funnelEntregues / funnelCriados * 100).toFixed(1)) : 0,
      },
      gmvPorDia,
      topLojas,
      topMotoboys,
      alertas: alertasCeo,
    });
  } catch (err) { next(err); }
});

// =============================================
// GET /api/admin/metrics — Painel de métricas de audiência
// =============================================
router.get('/metrics', async (req, res, next) => {
  try {
    const agora = new Date();
    const d7  = new Date(agora.getTime() - 7  * 24 * 60 * 60 * 1000);
    const d30 = new Date(agora.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Todos os pedidos aprovados
    const { data: todos } = await supabaseAdmin
      .from('pedidos')
      .select('id, total, subtotal, telefone_cliente, guest_telefone, cliente_id, criado_em, pagamento_status')
      .eq('pagamento_status', 'aprovado')
      .order('criado_em', { ascending: true });

    const pedidos = todos || [];

    // Identificador único: telefone_cliente → guest_telefone → cliente_id
    const getId = p => (p.telefone_cliente || p.guest_telefone || p.cliente_id || '').toString().replace(/\D/g, '').slice(-11) || null;

    // Pedidos por período
    const p7  = pedidos.filter(p => new Date(p.criado_em) >= d7);
    const p30 = pedidos.filter(p => new Date(p.criado_em) >= d30);

    // Clientes únicos (por telefone/id)
    const unicos       = new Set(pedidos.map(getId).filter(Boolean));
    const unicos7      = new Set(p7.map(getId).filter(Boolean));
    const unicos30     = new Set(p30.map(getId).filter(Boolean));

    // Recompra: clientes com mais de 1 pedido
    const freq = {};
    pedidos.forEach(p => { const id = getId(p); if(id) freq[id] = (freq[id]||0)+1; });
    const recorrentes = Object.values(freq).filter(v => v > 1).length;
    const taxaRecompra = unicos.size > 0 ? ((recorrentes / unicos.size) * 100).toFixed(1) : '0.0';

    // GMV
    const gmvTotal = pedidos.reduce((s,p) => s + (p.total||0), 0);
    const gmv30    = p30.reduce((s,p) => s + (p.total||0), 0);
    const gmv7     = p7.reduce((s,p) => s + (p.total||0), 0);

    // Ticket médio
    const ticketMedio = pedidos.length > 0 ? (gmvTotal / pedidos.length) : 0;

    // Crescimento mês anterior vs atual
    const inicioMesAtual = new Date(agora.getFullYear(), agora.getMonth(), 1);
    const inicioMesAnt   = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
    const pMesAtual  = pedidos.filter(p => new Date(p.criado_em) >= inicioMesAtual);
    const pMesAnt    = pedidos.filter(p => new Date(p.criado_em) >= inicioMesAnt && new Date(p.criado_em) < inicioMesAtual);
    const crescimento = pMesAnt.length > 0
      ? (((pMesAtual.length - pMesAnt.length) / pMesAnt.length) * 100).toFixed(1)
      : pMesAtual.length > 0 ? '100.0' : '0.0';

    // Pedidos por dia (últimos 30 dias para gráfico)
    const porDia = {};
    p30.forEach(p => {
      const dia = p.criado_em.slice(0, 10);
      porDia[dia] = (porDia[dia] || 0) + 1;
    });

    res.json({
      clientes: {
        total: unicos.size,
        ultimos7dias: unicos7.size,
        ultimos30dias: unicos30.size,
        recorrentes,
        taxaRecompra: parseFloat(taxaRecompra),
      },
      pedidos: {
        total: pedidos.length,
        ultimos7dias: p7.length,
        ultimos30dias: p30.length,
        mesAtual: pMesAtual.length,
        mesAnterior: pMesAnt.length,
        crescimentoMensal: parseFloat(crescimento),
      },
      gmv: {
        total: parseFloat(gmvTotal.toFixed(2)),
        ultimos30dias: parseFloat(gmv30.toFixed(2)),
        ultimos7dias: parseFloat(gmv7.toFixed(2)),
        ticketMedio: parseFloat(ticketMedio.toFixed(2)),
      },
      porDia,
    });
  } catch (err) { next(err); }
});

// POST /api/admin/gerar-slugs — Auto-gera slugs para lojas sem link personalizado
router.post('/gerar-slugs', async (req, res, next) => {
  try {
    const { data: lojas, error } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, slug')
      .is('slug', null);
    if (error) throw error;

    const slugify = (str) => str
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);

    const usados = new Set();
    const updates = [];
    for (const loja of (lojas || [])) {
      let base = slugify(loja.nome || 'loja');
      if (!base) base = 'loja';
      let slug = base;
      let i = 2;
      while (usados.has(slug)) { slug = base + '-' + i++; }
      usados.add(slug);
      updates.push({ id: loja.id, slug });
    }

    for (const u of updates) {
      await supabaseAdmin.from('estabelecimentos').update({ slug: u.slug }).eq('id', u.id);
    }

    res.json({ atualizadas: updates.length, slugs: updates.map(u => u.slug) });
  } catch (err) { next(err); }
});

// =============================================
// POST /api/admin/convite — Gerar link de convite para parceiro
// =============================================
router.post('/convite', async (req, res, next) => {
  try {
    const token = require('crypto').randomBytes(16).toString('hex');
    const expira_em = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const label = ((req.body && req.body.label) || '').trim().slice(0, 100);
    await supabaseAdmin.from('configuracoes').upsert({
      chave: `convite_${token}`,
      valor: JSON.stringify({ token, criado_em: new Date().toISOString(), expira_em, usado: false, label }),
    });
    const base = process.env.FRONTEND_URL || 'https://chegouaiapp.com.br';
    res.json({ token, link: `${base}/parceiro?token=${token}`, expira_em });
  } catch (err) { next(err); }
});

// GET /api/admin/convites — Listar convites ativos
router.get('/convites', async (req, res, next) => {
  try {
    const { data } = await supabaseAdmin.from('configuracoes').select('chave, valor').like('chave', 'convite_%');
    const convites = (data || []).map(row => {
      try { return { ...JSON.parse(row.valor), chave: row.chave }; } catch { return null; }
    }).filter(c => c && !c.usado);
    res.json(convites);
  } catch (err) { next(err); }
});

// DELETE /api/admin/convite/:token — Revogar convite
router.delete('/convite/:token', async (req, res, next) => {
  try {
    await supabaseAdmin.from('configuracoes').delete().eq('chave', `convite_${req.params.token}`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/admin/pendentes — Estabelecimentos aguardando aprovação
router.get('/pendentes', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, categoria, whatsapp, tipo_entrega, cidade, estado, cadastro_data, user_id')
      .eq('ativo', false)
      .order('cadastro_data', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { next(err); }
});

// PATCH /api/admin/pendentes/:id/aprovar — Aprovar estabelecimento
router.patch('/pendentes/:id/aprovar', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('estabelecimentos')
      .update({ ativo: true, aberto: true })
      .eq('id', req.params.id)
      .select('id, nome, whatsapp, user_id, profiles(nome)')
      .single();
    if (error || !data) return res.status(404).json({ error: 'Estabelecimento não encontrado' });

    const nomeResponsavel = data.profiles?.nome || data.nome;

    // Push + WhatsApp ao parceiro
    try {
      const { enviarPush } = require('./notifications');
      enviarPush(data.user_id, '🎉 Loja aprovada!', 'Sua loja foi aprovada! Faça login e complete o cadastro.', { tipo: 'aprovacao' });
    } catch (_) {}
    try {
      const { enviarWhatsApp } = require('../services/whatsapp');
      if (data.whatsapp) enviarWhatsApp(data.whatsapp, `🎉 Parabéns! Sua loja *${data.nome}* foi aprovada no Chegô!\n\nAcesse o app, faça login e complete seu cadastro.\n\n*chegouaiapp.com.br/app*`);
    } catch (_) {}

    // Iniciar sequência de onboarding (dias 1,2,3,5,7,15)
    try {
      const { agendarOnboardingLojista } = require('../services/onboarding');
      if (data.whatsapp) await agendarOnboardingLojista(data.id, nomeResponsavel, data.whatsapp);
    } catch (_) {}

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/pendentes/:id — Recusar e excluir estabelecimento pendente
router.delete('/pendentes/:id', async (req, res, next) => {
  try {
    const { data: est } = await supabaseAdmin
      .from('estabelecimentos').select('user_id').eq('id', req.params.id).eq('ativo', false).single();
    if (!est) return res.status(404).json({ error: 'Não encontrado ou já ativo' });
    await supabaseAdmin.from('estabelecimentos').delete().eq('id', req.params.id);
    await supabaseAdmin.auth.admin.deleteUser(est.user_id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =============================================
// GET /api/admin/clientes — lista com busca e métricas
// =============================================
router.get('/clientes', async (req, res, next) => {
  try {
    const { q, limit = 50, offset = 0 } = req.query;

    let query = supabaseAdmin
      .from('profiles')
      .select('id, nome, telefone, email, criado_em')
      .eq('perfil', 'cliente')
      .order('criado_em', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (q) {
      const safe = q.replace(/[%_\\]/g, '\\$&').slice(0, 60);
      query = query.or(`nome.ilike.%${safe}%,telefone.ilike.%${safe}%`);
    }

    const { data: clientes, error } = await query;
    if (error) throw error;

    // Métricas por cliente (contagem e soma de pedidos)
    const ids = (clientes || []).map(c => c.id);
    let metricasMap = {};
    if (ids.length) {
      const { data: metricas } = await supabaseAdmin
        .from('pedidos')
        .select('cliente_id, total, status')
        .in('cliente_id', ids)
        .eq('status', 'entregue');
      (metricas || []).forEach(p => {
        if (!metricasMap[p.cliente_id]) metricasMap[p.cliente_id] = { pedidos: 0, gasto: 0 };
        metricasMap[p.cliente_id].pedidos++;
        metricasMap[p.cliente_id].gasto += Number(p.total) || 0;
      });
    }

    const resultado = (clientes || []).map(c => ({
      ...c,
      total_pedidos: metricasMap[c.id]?.pedidos || 0,
      total_gasto: metricasMap[c.id]?.gasto || 0,
    }));

    res.json(resultado);
  } catch (e) { next(e); }
});

// =============================================
// GET /api/admin/clientes/:id — ficha completa
// =============================================
router.get('/clientes/:id', async (req, res, next) => {
  try {
    const { data: perfil, error } = await supabaseAdmin
      .from('profiles')
      .select('id, nome, telefone, email, criado_em')
      .eq('id', req.params.id)
      .eq('perfil', 'cliente')
      .single();
    if (error || !perfil) return res.status(404).json({ error: 'Cliente não encontrado' });

    const { data: pedidos } = await supabaseAdmin
      .from('pedidos')
      .select('id, total, status, pagamento_status, criado_em, estabelecimentos(nome)')
      .eq('cliente_id', req.params.id)
      .order('criado_em', { ascending: false })
      .limit(20);

    const entregues = (pedidos || []).filter(p => p.status === 'entregue');
    const totalGasto = entregues.reduce((acc, p) => acc + Number(p.total), 0);

    res.json({
      ...perfil,
      pedidos: pedidos || [],
      total_pedidos: entregues.length,
      total_gasto: totalGasto,
    });
  } catch (e) { next(e); }
});

// =============================================
// GET /api/admin/motoboys/:id/ficha — ficha completa motoboy
// =============================================
router.get('/motoboys/:id/ficha', async (req, res, next) => {
  try {
    const { data: mb, error } = await supabaseAdmin
      .from('motoboys')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !mb) return res.status(404).json({ error: 'Motoboy não encontrado' });

    const { data: entregas } = await supabaseAdmin
      .from('pedidos')
      .select('id, total, taxa_entrega, comissao_motoboy, status, pagamento_status, criado_em, estabelecimentos(nome)')
      .eq('motoboy_id', req.params.id)
      .order('criado_em', { ascending: false })
      .limit(30);

    const concluidas = (entregas || []).filter(p => p.status === 'entregue' && p.pagamento_status === 'aprovado');
    const totalRecebido = concluidas.reduce((acc, p) => acc + Number(p.comissao_motoboy ?? p.taxa_entrega ?? 0), 0);

    res.json({
      ...mb,
      entregas: entregas || [],
      total_entregas: concluidas.length,
      total_recebido: totalRecebido,
    });
  } catch (e) { next(e); }
});

// =============================================
// GET /api/admin/establishments/:id/ficha — ficha completa lojista
// =============================================
router.get('/establishments/:id/ficha', async (req, res, next) => {
  try {
    const { data: est, error } = await supabaseAdmin
      .from('estabelecimentos')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !est) return res.status(404).json({ error: 'Estabelecimento não encontrado' });

    const [{ data: pedidos }, { data: profile }] = await Promise.all([
      supabaseAdmin
        .from('pedidos')
        .select('id, total, comissao_plataforma, status, pagamento_status, criado_em')
        .eq('estabelecimento_id', req.params.id)
        .order('criado_em', { ascending: false })
        .limit(30),
      est.user_id
        ? supabaseAdmin.from('profiles').select('email, nome, telefone').eq('id', est.user_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const entreguesPagos = (pedidos || []).filter(p => p.status === 'entregue' && p.pagamento_status === 'aprovado');
    const gmv = entreguesPagos.reduce((acc, p) => acc + Number(p.total), 0);
    const comissao = entreguesPagos.reduce((acc, p) => acc + Number(p.comissao_plataforma || 0), 0);

    res.json({
      ...est,
      responsavel_nome: profile?.nome || null,
      responsavel_email: profile?.email || null,
      responsavel_telefone: profile?.telefone || null,
      pedidos: pedidos || [],
      total_pedidos: entreguesPagos.length,
      gmv,
      comissao_plataforma: comissao,
    });
  } catch (e) { next(e); }
});

module.exports = router;
