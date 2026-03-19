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
    body('mpUserId').optional().trim(),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { nome, telefone, email, senha, categoria, mpUserId } = req.body;

    try {
      // Criar usuário Supabase Auth
      const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: senha,
        email_confirm: true,
        user_metadata: { nome, telefone },
      });
      if (authErr) throw authErr;

      // Atualizar perfil (trigger do Supabase já cria o básico, precisamos completar)
      await supabaseAdmin.from('profiles').upsert({
        id: authData.user.id,
        nome,
        telefone,
        email,
        perfil: 'estabelecimento',
      }, { onConflict: 'id' });

      // Criar estabelecimento
      const { data: est, error: estErr } = await supabaseAdmin
        .from('estabelecimentos')
        .insert({
          user_id: authData.user.id,
          nome,
          categoria,
          mp_user_id: mpUserId || null,
          cadastro_data: new Date().toISOString(),
        })
        .select()
        .single();

      if (estErr) throw estErr;

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
    body('mpUserId').optional().trim(),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { nome, telefone, email, senha, moto, mpUserId } = req.body;

    try {
      const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: senha,
        email_confirm: true,
        user_metadata: { nome, telefone },
      });
      if (authErr) throw authErr;

      // Atualizar perfil (trigger do Supabase já cria o básico, precisamos completar)
      await supabaseAdmin.from('profiles').upsert({
        id: authData.user.id,
        nome,
        telefone,
        email,
        perfil: 'motoboy',
      }, { onConflict: 'id' });

      const { data: motoboy, error: mbErr } = await supabaseAdmin
        .from('motoboys')
        .insert({
          user_id: authData.user.id,
          nome,
          telefone,
          moto: moto || '',
          mp_user_id: mpUserId || null,
        })
        .select()
        .single();

      if (mbErr) throw mbErr;

      res.status(201).json({
        message: 'Motoboy cadastrado com sucesso',
        motoboy,
        login: { email, perfil: 'motoboy' },
      });
    } catch (err) {
      next(err);
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
