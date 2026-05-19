const { supabaseAdmin } = require('../config/supabase');
const { enviarPush } = require('../routes/notifications');

// Rastreia alertas já enviados: pedidoId -> { status, ultimoAlerta }
const alertasEnviados = new Map();

const STATUS_ATIVOS = ['pendente', 'pronto', 'aceito', 'preparando', 'coletado', 'saiu_para_entrega'];
const LIMITE_MIN = 1; // minutos para disparar alerta
const REENVIO_MIN = 5; // minutos para reenviar alerta do mesmo pedido

function mensagemAlerta(pedido, min) {
  const loja = pedido.estabelecimentos?.nome || 'Loja';
  const val = 'R$ ' + parseFloat(pedido.total || 0).toFixed(2).replace('.', ',');
  const cliente = pedido.profiles?.nome || pedido.guest_nome || 'Visitante';

  switch (pedido.status) {
    case 'pendente':
      return {
        titulo: '🚨 Lojista não aceitou',
        corpo: `${loja} — ${val} · ${cliente} · ${min}min esperando`,
      };
    case 'pronto':
      return {
        titulo: '🚨 Sem motoboy',
        corpo: `${loja} — pedido pronto há ${min}min · ${val}`,
      };
    case 'aceito':
    case 'preparando':
      if (min < 30) return null;
      return {
        titulo: '⚠️ Preparo lento',
        corpo: `${loja} — ${min}min preparando · ${val}`,
      };
    case 'coletado':
    case 'saiu_para_entrega':
      if (min < 45) return null;
      return {
        titulo: '⚠️ Entrega demorada',
        corpo: `${loja} — ${min}min em rota · ${val}`,
      };
    default:
      return null;
  }
}

async function buscarAdmins() {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('perfil', 'admin');
  return (data || []).map((p) => p.id);
}

async function verificarPedidosTravados() {
  const limiteAtivo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const agora = Date.now();

  const { data: pedidos, error } = await supabaseAdmin
    .from('pedidos')
    .select(`
      id, status, total, criado_em, guest_nome,
      estabelecimentos (nome),
      profiles (nome)
    `)
    .in('status', STATUS_ATIVOS)
    .eq('pagamento_status', 'aprovado')
    .gte('criado_em', limiteAtivo);

  if (error || !pedidos?.length) return;

  const admins = await buscarAdmins();
  if (!admins.length) return;

  const alertasParaEnviar = [];

  for (const pedido of pedidos) {
    const min = Math.floor((agora - new Date(pedido.criado_em).getTime()) / 60000);
    if (min < LIMITE_MIN) continue;

    const msg = mensagemAlerta(pedido, min);
    if (!msg) continue;

    const chave = pedido.id + ':' + pedido.status;
    const anterior = alertasEnviados.get(chave);
    const minutosDesdeUltimo = anterior
      ? Math.floor((agora - anterior.ultimoAlerta) / 60000)
      : Infinity;

    if (minutosDesdeUltimo < REENVIO_MIN) continue;

    alertasEnviados.set(chave, { status: pedido.status, ultimoAlerta: agora });
    alertasParaEnviar.push({ msg, pedidoId: pedido.id });
  }

  for (const { msg, pedidoId } of alertasParaEnviar) {
    for (const adminId of admins) {
      await enviarPush(adminId, msg.titulo, msg.corpo, { pedidoId });
    }
  }

  // Limpar entradas antigas (pedidos que saíram do mapa de ativos)
  const idsAtivos = new Set(pedidos.map((p) => p.id + ':' + p.status));
  for (const chave of alertasEnviados.keys()) {
    if (!idsAtivos.has(chave)) alertasEnviados.delete(chave);
  }
}

function iniciarMonitorAlertas() {
  console.log('[Monitor] Alertas de pedidos travados iniciados (intervalo: 60s)');
  setInterval(async () => {
    try {
      await verificarPedidosTravados();
    } catch (e) {
      console.error('[Monitor] Erro ao verificar pedidos:', e.message);
    }
  }, 60 * 1000);
}

module.exports = { iniciarMonitorAlertas };
