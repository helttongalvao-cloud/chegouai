const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireRole } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');
const { calcularComissao } = require('../services/commission');

const router = express.Router();

// Todas as rotas exigem perfil admin
router.use(requireRole('admin'));

// =============================================
// GET /api/admin/dashboard — Painel geral
// =============================================
router.get('/dashboard', async (req, res, next) => {
  try {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    // Pedidos de hoje
    const { data: pedidosHoje } = await supabaseAdmin
      .from('pedidos')
      .select('id, total, comissao_plataforma, status, pagamento_status')
      .gte('criado_em', hoje.toISOString());

    const { data: estabelecimentos } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, categoria, aberto, ativo, cadastro_data');

    const { data: motoboys } = await supabaseAdmin
      .from('motoboys')
      .select('id, nome, disponivel, ativo');

    const { data: repasessPendentes } = await supabaseAdmin
      .from('repasses')
      .select('id, tipo, valor, status, criado_em, pedidos(id)')
      .eq('status', 'pendente');

    const pedidosAprovados = pedidosHoje?.filter((p) => p.pagamento_status === 'aprovado') || [];
    const totalFaturamento = pedidosAprovados.reduce((s, p) => s + p.total, 0);
    const totalComissao = pedidosAprovados.reduce((s, p) => s + (p.comissao_plataforma || 0), 0);

    // Comissão por estabelecimento
    const estComComissao = (estabelecimentos || []).map((e) => ({
      ...e,
      comissao: calcularComissao(e.cadastro_data),
    }));

    res.json({
      stats: {
        pedidosHoje: pedidosHoje?.length || 0,
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
    const { data, error } = await supabaseAdmin
      .from('repasses')
      .select(`
        *,
        pedidos (
          id, total, subtotal, taxa_entrega, criado_em,
          estabelecimentos (nome),
          motoboys (nome, telefone)
        )
      `)
      .order('criado_em', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
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
    body('lat').optional().isFloat({ min: -90, max: 90 }),
    body('lng').optional().isFloat({ min: -180, max: 180 }),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { nome, telefone, email, senha, categoria, chave_pix, mpUserId, lat, lng } = req.body;

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
          chave_pix: chave_pix || null,
          mp_user_id: mpUserId || null,
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

    try {
      // PASSO 1: Criar usuario no Supabase Auth
      let userId;
      const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: senha,
        email_confirm: true,
        user_metadata: { nome, telefone },
      });

      if (authErr) {
        // Se usuario ja existe, tentar buscar o id dele
        if (authErr.message && authErr.message.includes('already')) {
          const { data: { users } } = await supabaseAdmin.auth.admin.listUsers();
          const existing = users.find(u => u.email === email);
          if (existing) {
            userId = existing.id;
          } else {
            return res.status(409).json({ error: 'E-mail já cadastrado no sistema' });
          }
        } else {
          console.error('[Admin] Erro createUser:', authErr.message);
          return res.status(400).json({ error: 'Erro ao criar usuario: ' + authErr.message });
        }
      } else {
        userId = authData.user.id;
      }

      // PASSO 2: Atualizar perfil para motoboy
      // Aguardar um instante para o trigger criar o profile
      await new Promise(r => setTimeout(r, 500));

      const { error: profileErr } = await supabaseAdmin
        .from('profiles')
        .update({ nome, telefone, email, perfil: 'motoboy' })
        .eq('id', userId);

      if (profileErr) {
        console.error('[Admin] Erro update profile:', profileErr.message);
        // Nao bloquear — tentar inserir motoboy mesmo assim
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

module.exports = router;
