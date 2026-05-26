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

    let query = supabaseAdmin
      .from('repasses')
      .select(`
        *,
        motoboys (id, nome, telefone, chave_pix),
        pedidos!inner (id, total, subtotal, taxa_entrega, criado_em, estabelecimentos(id, nome), motoboys(id, nome, chave_pix))
      `)
      .order('criado_em', { ascending: false });

    if (desde) query = query.gte('pedidos.criado_em', desde);
    if (ate) query = query.lte('pedidos.criado_em', ate + 'T23:59:59');

    const { data, error } = await query;
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
// POST /api/admin/establishments — Cadastrar loja
// =============================================
router.post(
  '/establishments',
  [
    body('nome').trim().isLength({ min: 2, max: 100 }).escape(),
    body('telefone').matches(/^\d{10,11}$/).withMessage('Telefone inválido'),
    body('email').isEmail().normalizeEmail(),
    body('senha').isLength({ min: 6 }),
    body('categoria').isIn(['restaurante', 'mercado', 'farmacia', 'lanche', 'bebida']),
    body('chave_pix').optional().trim(),
    body('mpUserId').optional().trim(),
    body('whatsapp').optional().trim().matches(/^\d{0,15}$/),
    body('lat').optional().isFloat({ min: -90, max: 90 }),
    body('lng').optional().isFloat({ min: -180, max: 180 }),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { nome, telefone, email, senha, categoria, chave_pix, mpUserId, whatsapp, lat, lng } = req.body;

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
    ['nome', 'categoria', 'tempo_entrega', 'taxa_entrega', 'emoji', 'aberto', 'whatsapp', 'valor_minimo', 'endereco', 'lat', 'lng'].forEach((k) => {
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
    body('desconto_valor').isFloat({ min: 0.01 }).withMessage('Valor inválido'),
    body('usos_max').optional().isInt({ min: 1 }),
    body('validade').optional().isISO8601().withMessage('Data inválida'),
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
          desconto_valor,
          usos_max: usos_max || 1,
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

module.exports = router;
