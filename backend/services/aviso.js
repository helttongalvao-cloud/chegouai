const { supabaseAdmin } = require('../config/supabase');

let _cache = null;

async function getAviso() {
  if (_cache !== null) return _cache;
  const { data } = await supabaseAdmin
    .from('configuracoes')
    .select('valor')
    .eq('chave', 'aviso_home')
    .maybeSingle();
  _cache = data?.valor || '';
  return _cache;
}

async function setAviso(texto) {
  _cache = texto || '';
  await supabaseAdmin
    .from('configuracoes')
    .upsert({ chave: 'aviso_home', valor: _cache });
}

module.exports = { getAviso, setAviso };
