const { supabaseAdmin } = require('../config/supabase');

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
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    // Buscar perfil completo do usuário
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

module.exports = { requireAuth, requireRole };
