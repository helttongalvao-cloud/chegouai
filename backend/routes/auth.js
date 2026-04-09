const express = require('express');
const { body, validationResult } = require('express-validator');
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { authSlowDown } = require('../middleware/security');

const router = express.Router();

// =============================================
// VALIDAÇÕES
// =============================================
const validateRegister = [
  body('nome')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Nome deve ter entre 2 e 100 caracteres')
    .escape(),
  body('telefone')
    .customSanitizer(v => (v || '').replace(/\D/g, ''))
    .isLength({ min: 10, max: 11 })
    .withMessage('Telefone inválido (DDD + número)'),
  body('senha')
    .isLength({ min: 6 })
    .withMessage('Senha deve ter pelo menos 6 caracteres'),
];

const validateLogin = [
  body('telefone')
    .customSanitizer(v => (v || '').replace(/\D/g, ''))
    .isLength({ min: 10, max: 11 })
    .withMessage('Telefone inválido'),
  body('senha').notEmpty().withMessage('Senha obrigatória'),
];

// =============================================
// POST /api/auth/register — Cadastro de cliente
// =============================================
router.post('/register', validateRegister, async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  const { nome, telefone, senha } = req.body;
  const telLimpo = (telefone || '').replace(/\D/g, '');
  // E-mail gerado internamente — usuário não precisa fornecer
  const emailInterno = `tel_${telLimpo}@chegouai.app`;

  try {
    // Verificar telefone duplicado
    const { data: existente } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('telefone', telLimpo)
      .maybeSingle();

    if (existente) {
      return res.status(409).json({ error: 'Telefone já cadastrado' });
    }

    // Criar usuário no Supabase Auth com e-mail interno
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: emailInterno,
      password: senha,
      email_confirm: true,
      user_metadata: { nome, telefone: telLimpo },
    });

    if (authError) throw authError;

    // Atualizar perfil criado pelo trigger
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .upsert({
        id: authData.user.id,
        nome,
        telefone: telLimpo,
        email: emailInterno,
        perfil: 'cliente',
      });

    if (profileError) throw profileError;

    res.status(201).json({
      message: 'Conta criada com sucesso',
      userId: authData.user.id,
    });
  } catch (err) {
    next(err);
  }
});

// =============================================
// POST /api/auth/login — Login
// =============================================
router.post('/login', authSlowDown, validateLogin, async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  const { telefone, senha } = req.body;
  const telLimpo = (telefone || '').replace(/\D/g, '');

  try {
    // Buscar e-mail interno pelo telefone
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('email')
      .eq('telefone', telLimpo)
      .maybeSingle();

    const emailLogin = profile?.email || `tel_${telLimpo}@chegouai.app`;

    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email: emailLogin,
      password: senha,
    });

    if (error) {
      return res.status(401).json({ error: 'Telefone ou senha incorretos' });
    }

    // Buscar perfil
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('id, nome, telefone, perfil, ativo, cpf')
      .eq('id', data.user.id)
      .single();

    if (profileErr || !profile) {
      return res.status(401).json({ error: 'Perfil não encontrado' });
    }

    if (!profile.ativo) {
      return res.status(403).json({ error: 'Conta desativada. Entre em contato.' });
    }

    // Se for estabelecimento, buscar dados da loja
    let estabelecimento = null;
    if (profile.perfil === 'estabelecimento') {
      const { data: est } = await supabaseAdmin
        .from('estabelecimentos')
        .select('id, nome, categoria, aberto, cadastro_data')
        .eq('user_id', profile.id)
        .single();
      estabelecimento = est;
    }

    res.json({
      token: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at,
      user: {
        id: profile.id,
        nome: profile.nome,
        telefone: profile.telefone,
        perfil: profile.perfil,
        cpf: profile.cpf || null,
        estabelecimento,
      },
    });
  } catch (err) {
    next(err);
  }
});

// =============================================
// POST /api/auth/logout — Logout
// =============================================
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await supabaseAdmin.auth.admin.signOut(req.user.id);
    res.json({ message: 'Logout realizado com sucesso' });
  } catch (err) {
    next(err);
  }
});

// =============================================
// POST /api/auth/refresh — Renovar token
// =============================================
router.post('/refresh', async (req, res, next) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken obrigatório' });
  }

  try {
    const { data, error } = await supabaseAdmin.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error) return res.status(401).json({ error: 'Token de refresh inválido' });

    res.json({
      token: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at,
    });
  } catch (err) {
    next(err);
  }
});

// =============================================
// GET /api/auth/me — Dados do usuário logado
// =============================================
router.get('/me', requireAuth, (req, res) => {
  const { profile } = req.user;
  res.json({
    id: profile.id,
    nome: profile.nome,
    telefone: profile.telefone,
    email: profile.email,
    perfil: profile.perfil,
  });
});

// =============================================
// PATCH /api/auth/cpf — Salvar CPF do usuário
// =============================================
router.patch('/cpf', requireAuth, async (req, res, next) => {
  try {
    const { cpf } = req.body;
    const cpfLimpo = (cpf || '').replace(/\D/g, '');
    if (cpfLimpo.length !== 11) return res.status(400).json({ error: 'CPF inválido' });
    await supabaseAdmin.from('profiles').update({ cpf: cpfLimpo }).eq('id', req.user.id);
    res.json({ cpf: cpfLimpo });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
