const { supabaseAdmin } = require('../config/supabase');
const { enviarPush } = require('../routes/notifications');
const { alertarAdmin, enviarWhatsApp } = require('./whatsapp');

// Rastreia alertas já enviados: pedidoId -> { status, ultimoAlerta }
const alertasEnviados = new Map();
// Rastreia redistribuições: pedidoId -> timestamp
const redistribuicoesEnviadas = new Map();
const REDISTRIBUICAO_MIN = 5;
const REDISTRIBUICAO_REENVIO_MIN = 10;

const STATUS_ATIVOS = ['pendente', 'pronto', 'aceito', 'preparando', 'coletado', 'saiu_para_entrega'];
const LIMITE_MIN = 1;
const REENVIO_MIN = 5;

// Controle de alertas periódicos para não reenviar toda hora
const alertasPeriodicos = new Map(); // chave -> timestamp ultimo envio

function deveEnviarAlertaPeriodico(chave, intervaloHoras = 24) {
  const ultimo = alertasPeriodicos.get(chave);
  if (!ultimo) return true;
  return Date.now() - ultimo > intervaloHoras * 60 * 60 * 1000;
}

function registrarAlertaPeriodico(chave) {
  alertasPeriodicos.set(chave, Date.now());
}

function mensagemAlerta(pedido, min) {
  const loja = pedido.estabelecimentos?.nome || 'Loja';
  const val = 'R$ ' + parseFloat(pedido.total || 0).toFixed(2).replace('.', ',');
  const cliente = pedido.profiles?.nome || pedido.guest_nome || 'Visitante';

  switch (pedido.status) {
    case 'pendente':
      return { titulo: '🚨 Lojista não aceitou', corpo: `${loja} — ${val} · ${cliente} · ${min}min esperando` };
    case 'pronto':
      return { titulo: '🚨 Sem motoboy', corpo: `${loja} — pedido pronto há ${min}min · ${val}` };
    case 'aceito':
    case 'preparando':
      if (min < 30) return null;
      return { titulo: '⚠️ Preparo lento', corpo: `${loja} — ${min}min preparando · ${val}` };
    case 'coletado':
    case 'saiu_para_entrega':
      if (min < 45) return null;
      return { titulo: '⚠️ Entrega demorada', corpo: `${loja} — ${min}min em rota · ${val}` };
    default:
      return null;
  }
}

async function buscarAdmins() {
  const { data } = await supabaseAdmin.from('profiles').select('id').eq('perfil', 'admin');
  return (data || []).map((p) => p.id);
}

// ─── ALERTAS DE PEDIDOS TRAVADOS ─────────────────────────────────────────────

async function verificarPedidosTravados() {
  const limiteAtivo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const agora = Date.now();

  const { data: pedidos, error } = await supabaseAdmin
    .from('pedidos')
    .select(`id, status, total, criado_em, guest_nome, estabelecimentos (nome, user_id), profiles (nome)`)
    .in('status', STATUS_ATIVOS)
    .eq('pagamento_status', 'aprovado')
    .gte('criado_em', limiteAtivo);

  if (error || !pedidos?.length) return;

  const admins = await buscarAdmins();
  if (!admins.length) return;

  for (const pedido of pedidos) {
    const min = Math.floor((agora - new Date(pedido.criado_em).getTime()) / 60000);
    if (min < LIMITE_MIN) continue;

    const msg = mensagemAlerta(pedido, min);
    if (!msg) continue;

    const chave = pedido.id + ':' + pedido.status;
    const anterior = alertasEnviados.get(chave);
    const minutosDesdeUltimo = anterior ? Math.floor((agora - anterior.ultimoAlerta) / 60000) : Infinity;
    if (minutosDesdeUltimo < REENVIO_MIN) continue;

    alertasEnviados.set(chave, { status: pedido.status, ultimoAlerta: agora });

    for (const adminId of admins) {
      await enviarPush(adminId, msg.titulo, msg.corpo, { pedidoId: pedido.id });
    }
    alertarAdmin(`${msg.titulo}\n${msg.corpo}`).catch(() => {});

    if ((pedido.status === 'preparando' || pedido.status === 'aceito') && min >= 30 && pedido.estabelecimentos?.user_id) {
      await enviarPush(pedido.estabelecimentos.user_id, '⏱️ Pedido em preparo há ' + min + 'min', 'Atualize o status do pedido.', { pedidoId: pedido.id });
    }
  }

  const idsAtivos = new Set(pedidos.map((p) => p.id + ':' + p.status));
  const limiteIdade = agora - 4 * 60 * 60 * 1000;
  for (const [chave, val] of alertasEnviados.entries()) {
    if (!idsAtivos.has(chave) || val.ultimoAlerta < limiteIdade) alertasEnviados.delete(chave);
  }
}

// ─── REDISTRIBUIÇÃO AUTOMÁTICA ───────────────────────────────────────────────

async function redistribuirPedidosSemMotoboy() {
  const agora = Date.now();
  const limite = new Date(agora - REDISTRIBUICAO_MIN * 60 * 1000).toISOString();

  const { data: pedidos } = await supabaseAdmin
    .from('pedidos')
    .select('id, total, criado_em, estabelecimentos(nome)')
    .eq('status', 'pronto')
    .eq('pagamento_status', 'aprovado')
    .is('motoboy_id', null)
    .lte('criado_em', limite);

  if (!pedidos?.length) return;

  const { data: motoboys } = await supabaseAdmin
    .from('motoboys').select('user_id, telefone').eq('disponivel', true).eq('ativo', true);

  for (const pedido of pedidos) {
    const min = Math.floor((agora - new Date(pedido.criado_em).getTime()) / 60000);
    const ultimo = redistribuicoesEnviadas.get(pedido.id);
    const minutosDesde = ultimo ? Math.floor((agora - ultimo) / 60000) : Infinity;
    if (minutosDesde < REDISTRIBUICAO_REENVIO_MIN) continue;

    redistribuicoesEnviadas.set(pedido.id, agora);
    const loja = pedido.estabelecimentos?.nome || 'Loja';
    const val = 'R$ ' + parseFloat(pedido.total || 0).toFixed(2).replace('.', ',');

    alertarAdmin(`🔔 *Redistribuição automática*\nPedido *#${pedido.id.slice(-6).toUpperCase()}* em *${loja}* pronto há *${min}min* sem motoboy.\nValor: ${val}`).catch(() => {});

    if (motoboys?.length) {
      const msg = `🛵 *Entrega disponível!*\nPedido pronto em *${loja}* há ${min}min.\nValor: ${val}\n\nAbra o app: chegouaiapp.com.br/app`;
      for (const mb of motoboys) {
        if (mb.telefone) enviarWhatsApp(mb.telefone, msg).catch(() => {});
      }
    }
  }

  const idsAtivos = new Set((pedidos || []).map((p) => p.id));
  const limiteIdade = agora - 2 * 60 * 60 * 1000;
  for (const [id, ts] of redistribuicoesEnviadas.entries()) {
    if (!idsAtivos.has(id) || ts < limiteIdade) redistribuicoesEnviadas.delete(id);
  }
}

// ─── ALERTA: MOTOBOY COM AVALIAÇÃO BAIXA ─────────────────────────────────────

async function verificarAvaliacaoMotoboys() {
  const chave = 'avaliacao_motoboy';
  if (!deveEnviarAlertaPeriodico(chave, 24)) return;

  // Buscar últimas 3 avaliações de cada motoboy
  const { data: motoboys } = await supabaseAdmin
    .from('motoboys')
    .select('id, nome, user_id')
    .eq('ativo', true);

  if (!motoboys?.length) return;

  const alertas = [];
  for (const mb of motoboys) {
    const { data: avals } = await supabaseAdmin
      .from('avaliacoes')
      .select('nota_motoboy')
      .eq('motoboy_id', mb.id)
      .not('nota_motoboy', 'is', null)
      .order('criado_em', { ascending: false })
      .limit(3);

    if (!avals || avals.length < 3) continue;
    const media = avals.reduce((s, a) => s + Number(a.nota_motoboy), 0) / avals.length;
    if (media < 3.5) {
      alertas.push(`🛵 ${mb.nome} — média ${media.toFixed(1)} ⭐ (últimos 3 pedidos)`);
    }
  }

  if (alertas.length) {
    registrarAlertaPeriodico(chave);
    await alertarAdmin(`⚠️ *Motoboys com avaliação baixa*\n\n${alertas.join('\n')}\n\nVerifique no painel.`);
  }
}

// ─── ALERTA: LOJISTA COM CANCELAMENTO ALTO ───────────────────────────────────

async function verificarCancelamentoLojistas() {
  const chave = 'cancelamento_lojista';
  if (!deveEnviarAlertaPeriodico(chave, 24)) return;

  const desde = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: lojistas } = await supabaseAdmin
    .from('estabelecimentos')
    .select('id, nome, whatsapp')
    .eq('ativo', true);

  if (!lojistas?.length) return;

  const alertas = [];
  for (const loja of lojistas) {
    const { data: pedidos } = await supabaseAdmin
      .from('pedidos')
      .select('id, status')
      .eq('estabelecimento_id', loja.id)
      .eq('pagamento_status', 'aprovado')
      .gte('criado_em', desde);

    if (!pedidos || pedidos.length < 5) continue; // mínimo 5 pedidos para calcular
    const cancelados = pedidos.filter(p => p.status === 'cancelado').length;
    const taxa = (cancelados / pedidos.length) * 100;
    if (taxa > 10) {
      alertas.push(`🏪 ${loja.nome} — ${taxa.toFixed(0)}% de cancelamento (${cancelados}/${pedidos.length})`);
    }
  }

  if (alertas.length) {
    registrarAlertaPeriodico(chave);
    await alertarAdmin(`⚠️ *Lojistas com cancelamento alto (>10%)*\n\n${alertas.join('\n')}\n\nVerifique no painel.`);
  }
}

// ─── ALERTA: LOJISTA INATIVO HÁ 3 DIAS ──────────────────────────────────────

async function verificarLojistasInativos() {
  const chave = 'lojista_inativo';
  if (!deveEnviarAlertaPeriodico(chave, 24)) return;

  const limite3dias = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const { data: lojistas } = await supabaseAdmin
    .from('estabelecimentos')
    .select('id, nome, whatsapp, user_id')
    .eq('ativo', true);

  if (!lojistas?.length) return;

  const inativos = [];
  for (const loja of lojistas) {
    const { count } = await supabaseAdmin
      .from('pedidos')
      .select('id', { count: 'exact', head: true })
      .eq('estabelecimento_id', loja.id)
      .eq('pagamento_status', 'aprovado')
      .gte('criado_em', limite3dias);

    if ((count || 0) === 0) {
      inativos.push(loja);
    }
  }

  if (!inativos.length) return;
  registrarAlertaPeriodico(chave);

  // Notificar admin
  await alertarAdmin(
    `📭 *Lojistas sem pedido há 3+ dias*\n\n` +
    inativos.map(l => `🏪 ${l.nome}`).join('\n') +
    `\n\nConsidere entrar em contato.`
  );

  // Dica automática para cada lojista
  for (const loja of inativos) {
    if (!loja.whatsapp) continue;
    await enviarWhatsApp(loja.whatsapp,
      `Olá, ${loja.nome}! 👋\n\nNotamos que você está há alguns dias sem receber pedidos no Chegô.\n\n` +
      `💡 *Dica:* Compartilhe o link da sua loja com clientes e no seu status do WhatsApp para aumentar as vendas!\n\n` +
      `Qualquer dúvida, estamos aqui. 🚀`
    ).catch(() => {});
  }
}

// ─── ALERTA: MOTOBOY INATIVO HÁ 7 DIAS ──────────────────────────────────────

async function verificarMotoboyInativos() {
  const chave = 'motoboy_inativo';
  if (!deveEnviarAlertaPeriodico(chave, 24)) return;

  const limite7dias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: motoboys } = await supabaseAdmin
    .from('motoboys')
    .select('id, nome, telefone, user_id')
    .eq('ativo', true);

  if (!motoboys?.length) return;

  const inativos = [];
  for (const mb of motoboys) {
    const { count } = await supabaseAdmin
      .from('pedidos')
      .select('id', { count: 'exact', head: true })
      .eq('motoboy_id', mb.id)
      .eq('status', 'entregue')
      .gte('atualizado_em', limite7dias);

    if ((count || 0) === 0) inativos.push(mb);
  }

  if (!inativos.length) return;
  registrarAlertaPeriodico(chave);

  await alertarAdmin(
    `🛵 *Motoboys inativos há 7+ dias*\n\n` +
    inativos.map(m => `• ${m.nome}`).join('\n')
  );

  for (const mb of inativos) {
    if (!mb.telefone) continue;
    await enviarWhatsApp(mb.telefone,
      `Olá, ${mb.nome}! 👋\n\nFaz alguns dias que você não faz entregas pelo Chegô.\n\n` +
      `Quando quiser voltar é só abrir o app e ativar sua disponibilidade! 🛵\n\n` +
      `chegouaiapp.com.br/app`
    ).catch(() => {});
  }
}

// ─── INICIALIZAR ─────────────────────────────────────────────────────────────

function iniciarMonitorAlertas() {
  console.log('[Monitor] Alertas iniciados (intervalo: 60s)');

  setInterval(async () => {
    try {
      await verificarPedidosTravados();
      await redistribuirPedidosSemMotoboy();
    } catch (e) {
      console.error('[Monitor] Erro pedidos:', e.message);
    }
  }, 60 * 1000);

  // Alertas periódicos: a cada hora verifica se deve disparar (evita loop desnecessário)
  setInterval(async () => {
    try {
      await verificarAvaliacaoMotoboys();
      await verificarCancelamentoLojistas();
      await verificarLojistasInativos();
      await verificarMotoboyInativos();
    } catch (e) {
      console.error('[Monitor] Erro alertas periódicos:', e.message);
    }
  }, 60 * 60 * 1000); // a cada hora (controle interno garante 1x/dia)
}

module.exports = { iniciarMonitorAlertas };
