const express = require('express');
const { body, validationResult } = require('express-validator');
const { supabaseAdmin, supabaseAnon } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { authSlowDown } = require('../middleware/security');

// supabaseAnon é usado APENAS para signInWithPassword (nunca para queries de DB)
// Contaminação do anon com JWT de usuário não afeta o supabaseAdmin (service_role)

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

  const { nome, telefone, cpf, senha } = req.body;
  const telLimpo = (telefone || '').replace(/\D/g, '');
  const cpfLimpo = (cpf || '').replace(/\D/g, '');
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
      // Verificar se o auth user correspondente existe — se não, é perfil órfão; limpar e prosseguir
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(existente.id);
      if (authUser?.user) {
        return res.status(409).json({ error: 'Telefone já cadastrado. Tente fazer login.' });
      }
      // Perfil sem auth user — remover o órfão e permitir novo cadastro
      await supabaseAdmin.from('profiles').delete().eq('id', existente.id);
    }

    // Criar usuário no Supabase Auth com e-mail interno
    let { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: emailInterno,
      password: senha,
      email_confirm: true,
      user_metadata: { nome, telefone: telLimpo },
    });

    // Se o email já existe no Auth mas não há perfil (usuário órfão de cadastro incompleto),
    // deletar o auth user antigo e recriar
    if (authError && authError.message && authError.message.toLowerCase().includes('already been registered')) {
      const { data: usuariosExistentes } = await supabaseAdmin.auth.admin.listUsers();
      const orphan = usuariosExistentes?.users?.find((u) => u.email === emailInterno);
      if (orphan) {
        await supabaseAdmin.auth.admin.deleteUser(orphan.id);
        const resultado = await supabaseAdmin.auth.admin.createUser({
          email: emailInterno,
          password: senha,
          email_confirm: true,
          user_metadata: { nome, telefone: telLimpo },
        });
        authData = resultado.data;
        authError = resultado.error;
      }
    }

    if (authError) {
      const msg = authError.message || '';
      if (msg.toLowerCase().includes('already been registered')) {
        return res.status(409).json({ error: 'Telefone já cadastrado. Tente fazer login.' });
      }
      throw authError;
    }

    // Atualizar perfil criado pelo trigger
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .upsert({
        id: authData.user.id,
        nome,
        telefone: telLimpo,
        email: emailInterno,
        perfil: 'cliente',
        ...(cpfLimpo.length === 11 && { cpf: cpfLimpo }),
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
    const { data: profileEmail, error: profileLookupErr } = await supabaseAdmin
      .from('profiles')
      .select('id, email')
      .eq('telefone', telLimpo)
      .maybeSingle();

    console.log('[Auth/login] profileLookup:', { tel: telLimpo, email: profileEmail?.email || null, err: profileLookupErr?.message || null });

    let emailLogin = profileEmail?.email || null;

    // Se o perfil não tem e-mail, buscar via user_id do próprio perfil
    if (!emailLogin && profileEmail?.id) {
      try {
        const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(profileEmail.id);
        if (authUser?.user?.email) emailLogin = authUser.user.email;
      } catch (_) {}
    }

    // Se o perfil sequer tem o telefone (motoboy com perfil incompleto),
    // buscar na tabela motoboys pelo telefone para obter o user_id
    if (!emailLogin) {
      try {
        const { data: mb } = await supabaseAdmin
          .from('motoboys')
          .select('user_id')
          .eq('telefone', telLimpo)
          .maybeSingle();
        if (mb?.user_id) {
          const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(mb.user_id);
          if (authUser?.user?.email) emailLogin = authUser.user.email;
        }
      } catch (_) {}
    }

    // Último fallback: formato padrão de clientes
    if (!emailLogin) emailLogin = `tel_${telLimpo}@chegouai.app`;

    // supabaseAnon nunca faz queries de DB — contaminação com JWT de usuário é inofensiva
    const { data, error } = await supabaseAnon.auth.signInWithPassword({
      email: emailLogin,
      password: senha,
    });

    if (error) {
      console.error('[Auth/login] signInWithPassword error:', error.message, '| email usado:', emailLogin);
      return res.status(400).json({ error: 'Telefone ou senha incorretos' });
    }

    // Buscar perfil
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('id, nome, telefone, perfil, ativo, cpf')
      .eq('id', data.user.id)
      .single();

    if (profileErr || !profile) {
      return res.status(400).json({ error: 'Perfil não encontrado' });
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

// =============================================
// POST /api/auth/reset-senha — Reset de senha pelo telefone
// =============================================
router.post('/reset-senha', [
  body('telefone').notEmpty().withMessage('Telefone obrigatório'),
  body('novaSenha').isLength({ min: 6 }).withMessage('Senha deve ter pelo menos 6 caracteres'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const tel = req.body.telefone.replace(/\D/g, '').slice(-11);
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('telefone', tel)
      .maybeSingle();

    if (profileErr) throw profileErr;
    if (!profile) return res.status(404).json({ error: 'Telefone não cadastrado' });

    const novaSenha = req.body.novaSenha;
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey  = process.env.SUPABASE_SERVICE_KEY;

    // Atualizar senha via GoTrue Admin REST API (compatível com todas versões do supabase-js)
    const resp = await fetch(`${supabaseUrl}/auth/v1/admin/users/${profile.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ password: novaSenha }),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      console.error('[reset-senha] GoTrue falhou:', resp.status, errBody);
      return res.status(500).json({ error: 'Não foi possível redefinir a senha. Tente novamente.' });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// =============================================
// GET /api/auth/convite/:token — Validar token de convite (público)
// =============================================
router.get('/convite/:token', async (req, res) => {
  const token = (req.params.token || '').replace(/[^a-f0-9]/gi, '').slice(0, 64);
  if (!token) return res.json({ valid: false, error: 'Token inválido' });
  try {
    const { data } = await supabaseAdmin
      .from('configuracoes').select('valor').eq('chave', `convite_${token}`).maybeSingle();
    if (!data) return res.json({ valid: false, error: 'Convite não encontrado' });
    const c = JSON.parse(data.valor);
    if (c.usado) return res.json({ valid: false, error: 'Este convite já foi utilizado' });
    if (new Date(c.expira_em) < new Date()) return res.json({ valid: false, error: 'Convite expirado' });
    res.json({ valid: true });
  } catch (_) { res.json({ valid: false, error: 'Erro ao validar convite' }); }
});

// =============================================
// POST /api/auth/cadastro-parceiro — Auto-cadastro via convite
// =============================================
router.post('/cadastro-parceiro', async (req, res, next) => {
  const { token, nomeLoja, categoria, tipoEntrega, nomeResponsavel, whatsapp, email, senha, cidade, estado } = req.body;

  if (!token || !nomeLoja || !categoria || !nomeResponsavel || !email || !senha) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios' });
  }
  if ((senha || '').length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
  const telLimpo = (whatsapp || '').replace(/\D/g, '');
  if (telLimpo.length < 10) return res.status(400).json({ error: 'WhatsApp inválido (com DDD)' });

  try {
    // Validar token
    const { data: conviteData } = await supabaseAdmin
      .from('configuracoes').select('valor').eq('chave', `convite_${token}`).maybeSingle();
    if (!conviteData) return res.status(400).json({ error: 'Convite inválido' });
    const convite = JSON.parse(conviteData.valor);
    if (convite.usado) return res.status(400).json({ error: 'Convite já utilizado' });
    if (new Date(convite.expira_em) < new Date()) return res.status(400).json({ error: 'Convite expirado' });

    const emailNorm = email.toLowerCase().trim();

    // Verificar e-mail e WhatsApp duplicados
    const [{ data: existeEmail }, { data: existeTel }] = await Promise.all([
      supabaseAdmin.from('profiles').select('id').eq('email', emailNorm).maybeSingle(),
      supabaseAdmin.from('profiles').select('id').eq('telefone', telLimpo).maybeSingle(),
    ]);
    if (existeEmail) return res.status(409).json({ error: 'E-mail já cadastrado' });
    if (existeTel) return res.status(409).json({ error: 'WhatsApp já cadastrado' });

    // Criar usuário no Auth
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email: emailNorm, password: senha, email_confirm: true,
      user_metadata: { nome: nomeResponsavel, telefone: telLimpo },
    });
    if (authErr) {
      if (authErr.message.includes('already been registered')) return res.status(409).json({ error: 'E-mail já cadastrado' });
      throw authErr;
    }
    const userId = authData.user.id;

    // Criar perfil
    const { error: profErr } = await supabaseAdmin.from('profiles').upsert({
      id: userId, nome: nomeResponsavel.trim(), telefone: telLimpo,
      email: emailNorm, perfil: 'estabelecimento',
    });
    if (profErr) { await supabaseAdmin.auth.admin.deleteUser(userId); throw profErr; }

    // Criar estabelecimento com ativo=false (aguardando aprovação)
    const { data: est, error: estErr } = await supabaseAdmin
      .from('estabelecimentos')
      .insert({
        user_id: userId,
        nome: nomeLoja.trim().slice(0, 100),
        categoria,
        tipo_entrega: tipoEntrega || 'app',
        whatsapp: telLimpo,
        cidade: cidade || null,
        estado: estado || null,
        cadastro_data: new Date().toISOString(),
        ativo: false,
        aberto: false,
      })
      .select().single();
    if (estErr) { await supabaseAdmin.auth.admin.deleteUser(userId); throw estErr; }

    // Marcar token como usado
    await supabaseAdmin.from('configuracoes')
      .update({ valor: JSON.stringify({ ...convite, usado: true, usado_em: new Date().toISOString(), estabelecimento_id: est.id }) })
      .eq('chave', `convite_${token}`);

    // Notificar admin via Telegram
    try {
      const { enviarTelegram } = require('../services/telegram');
      enviarTelegram(`🏪 <b>Novo parceiro aguardando aprovação!</b>\n📛 ${nomeLoja}\n📂 ${categoria}\n📞 ${telLimpo}\n👤 ${nomeResponsavel}\n\nAcesse o painel admin → Estabelecimentos para aprovar.`);
    } catch (_) {}

    res.status(201).json({ message: 'Cadastro enviado! Aguardando aprovação do administrador.' });
  } catch (err) { next(err); }
});

module.exports = router;
