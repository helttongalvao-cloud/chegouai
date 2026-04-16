const { createClient } = require('@supabase/supabase-js');
const { supabaseAdmin } = require('../config/supabase');

// Client isolado só para verificar tokens JWT — nunca faz queries de DB
// Evita contaminar o supabaseAdmin (service_role) com JWTs de usuários
function criarVerificadorToken() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Middleware de autenticação via JWT do Supabase.
 * Exige cabeçalho: Authorization: Bearer <token>
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de autenticação não fornecido' });
  }

  const token = authHeader.slice(7);

  try {
    // Verificar token com client isolado — não contamina o supabaseAdmin
    const { data: { user }, error } = await criarVerificadorToken().auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    // Buscar perfil completo via supabaseAdmin (service_role — bypassa RLS)
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ error: 'Perfil de usuário não encontrado' });
    }

    req.user = { ...user, profile };
    next();
  } catch (err) {
    console.error('[Auth middleware]', err.message);
    res.status(500).json({ error: 'Erro interno na autenticação' });
  }
}

/**
 * Factory para exigir perfil específico.
 * Uso: requireRole('admin'), requireRole('estabelecimento', 'admin')
 */
function requireRole(...roles) {
  return [
    requireAuth,
    (req, res, next) => {
      if (!roles.includes(req.user.profile.perfil)) {
        return res.status(403).json({
          error: `Acesso negado. Perfil necessário: ${roles.join(' ou ')}`,
        });
      }
      next();
    },
  ];
}

/**
 * Auth opcional: se tiver token válido, popula req.user. Senão, req.user = null.
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = authHeader.slice(7);
  try {
    const { data: { user }, error } = await criarVerificadorToken().auth.getUser(token);
    if (error || !user) { req.user = null; return next(); }
    const { data: profile } = await supabaseAdmin.from('profiles').select('*').eq('id', user.id).single();
    req.user = profile ? { ...user, profile } : null;
    next();
  } catch {
    req.user = null;
    next();
  }
}

module.exports = { requireAuth, requireRole, optionalAuth };
