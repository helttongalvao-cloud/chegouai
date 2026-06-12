const { supabaseAdmin } = require('../config/supabase');
const { alertarAdmin } = require('./whatsapp');

// Manaus é UTC-4, sem horário de verão
const MANAUS_OFFSET_MS = 4 * 60 * 60 * 1000;

function agoraManaus() {
  return new Date(Date.now() - MANAUS_OFFSET_MS);
}

// Converte data local Manaus (YYYY-MM-DD) para UTC
function manausDateToUTC(dateStr, horaStr = '00:00:00.000') {
  return new Date(`${dateStr}T${horaStr}Z`).getTime() + MANAUS_OFFSET_MS;
}

// Gera e envia relatório diário via WhatsApp para o admin
async function enviarRelatorioDiario() {
  const hoje = agoraManaus().toISOString().slice(0, 10);            // YYYY-MM-DD em Manaus
  const ontemStr = new Date(Date.now() - MANAUS_OFFSET_MS - 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const inicioDia = new Date(manausDateToUTC(ontemStr, '00:00:00.000'));
  const fimDia   = new Date(manausDateToUTC(ontemStr, '23:59:59.999'));

  try {
    const { data: pedidos } = await supabaseAdmin
      .from('pedidos')
      .select('id, total, comissao_plataforma, status, pagamento_status')
      .gte('criado_em', inicioDia.toISOString())
      .lte('criado_em', fimDia.toISOString());

    const todos       = pedidos || [];
    const entregues   = todos.filter(p => p.status === 'entregue');
    const cancelados  = todos.filter(p => p.status === 'cancelado');
    const gmv         = entregues.reduce((s, p) => s + Number(p.total || 0), 0);
    const comissao    = entregues.reduce((s, p) => s + Number(p.comissao_plataforma || 0), 0);
    const ticketMedio = entregues.length ? gmv / entregues.length : 0;

    const { count: motoboyAtivos } = await supabaseAdmin
      .from('motoboys').select('id', { count: 'exact', head: true }).eq('ativo', true);

    const { count: lojistasAtivos } = await supabaseAdmin
      .from('estabelecimentos').select('id', { count: 'exact', head: true }).eq('ativo', true);

    const dtOntem = new Date(inicioDia).toLocaleDateString('pt-BR', { timeZone: 'America/Manaus' });

    const msg =
      `📊 *Relatório diário — ${dtOntem}*\n\n` +
      `🛒 *Pedidos:* ${todos.length} (${entregues.length} entregues, ${cancelados.length} cancelados)\n` +
      `💰 *GMV:* R$ ${gmv.toFixed(2).replace('.', ',')}\n` +
      `🎯 *Comissão:* R$ ${comissao.toFixed(2).replace('.', ',')}\n` +
      `🧾 *Ticket médio:* R$ ${ticketMedio.toFixed(2).replace('.', ',')}\n\n` +
      `🛵 *Motoboys ativos:* ${motoboyAtivos || 0}\n` +
      `🏪 *Lojistas ativos:* ${lojistasAtivos || 0}`;

    await alertarAdmin(msg);
    console.log('[Relatório] Diário enviado para admin');
  } catch (e) {
    console.error('[Relatório] Erro ao enviar relatório diário:', e.message);
  }
}

// Verifica se é hora de enviar o relatório (7h da manhã horário de Manaus)
function deveEnviarAgora() {
  const agora = new Date();
  const horaManaus = (agora.getUTCHours() - 4 + 24) % 24; // UTC-4, sem DST
  const minuto = agora.getUTCMinutes();
  return horaManaus === 7 && minuto < 5;
}

let relatorioDiarioEnviado = false;
let ultimoDiaRelatorioManaus = '';

function iniciarMonitorRelatorios() {
  setInterval(async () => {
    const diaAtualManaus = agoraManaus().toISOString().slice(0, 10);

    // Resetar flag ao mudar de dia em Manaus
    if (diaAtualManaus !== ultimoDiaRelatorioManaus) {
      relatorioDiarioEnviado = false;
      ultimoDiaRelatorioManaus = diaAtualManaus;
    }

    if (!relatorioDiarioEnviado && deveEnviarAgora()) {
      relatorioDiarioEnviado = true;
      await enviarRelatorioDiario();
    }
  }, 60 * 1000);

  console.log('[Relatório] Monitor de relatórios diários iniciado');
}

module.exports = { iniciarMonitorRelatorios, enviarRelatorioDiario };
