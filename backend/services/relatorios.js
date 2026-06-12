const { supabaseAdmin } = require('../config/supabase');
const { alertarAdmin } = require('./whatsapp');

// Gera e envia relatório diário via WhatsApp para o admin
async function enviarRelatorioDiario() {
  const agora = new Date();

  // Janela: ontem 00:00 → ontem 23:59 (Brasília = UTC-3)
  const ontem = new Date(agora);
  ontem.setUTCHours(3, 0, 0, 0); // meia-noite Brasília de hoje em UTC
  if (ontem > agora) ontem.setUTCDate(ontem.getUTCDate() - 1);
  const inicioDia = new Date(ontem.getTime() - 24 * 60 * 60 * 1000);
  const fimDia   = new Date(ontem.getTime() - 1);

  try {
    const { data: pedidos } = await supabaseAdmin
      .from('pedidos')
      .select('id, total, comissao_plataforma, status, pagamento_status')
      .gte('criado_em', inicioDia.toISOString())
      .lte('criado_em', fimDia.toISOString());

    const todos        = pedidos || [];
    const entregues    = todos.filter(p => p.status === 'entregue');
    const cancelados   = todos.filter(p => p.status === 'cancelado');
    const gmv          = entregues.reduce((s, p) => s + Number(p.total || 0), 0);
    const comissao     = entregues.reduce((s, p) => s + Number(p.comissao_plataforma || 0), 0);
    const ticketMedio  = entregues.length ? gmv / entregues.length : 0;

    const { count: motoboysAtivos } = await supabaseAdmin
      .from('motoboys').select('id', { count: 'exact', head: true }).eq('ativo', true);

    const { count: lojistasAtivos } = await supabaseAdmin
      .from('estabelecimentos').select('id', { count: 'exact', head: true }).eq('ativo', true);

    const dtOntem = inicioDia.toLocaleDateString('pt-BR', { timeZone: 'America/Manaus' });

    const msg =
      `📊 *Relatório diário — ${dtOntem}*\n\n` +
      `🛒 *Pedidos:* ${todos.length} (${entregues.length} entregues, ${cancelados.length} cancelados)\n` +
      `💰 *GMV:* R$ ${gmv.toFixed(2).replace('.', ',')}\n` +
      `🎯 *Comissão:* R$ ${comissao.toFixed(2).replace('.', ',')}\n` +
      `🧾 *Ticket médio:* R$ ${ticketMedio.toFixed(2).replace('.', ',')}\n\n` +
      `🛵 *Motoboys ativos:* ${motoboysAtivos || 0}\n` +
      `🏪 *Lojistas ativos:* ${lojistasAtivos || 0}`;

    await alertarAdmin(msg);
    console.log('[Relatório] Diário enviado para admin');
  } catch (e) {
    console.error('[Relatório] Erro ao enviar relatório diário:', e.message);
  }
}

// Verifica se é hora de enviar o relatório (7h da manhã horário de Brasília)
function deveEnviarAgora() {
  const agora = new Date();
  // UTC-4 (Manaus) = horário local do usuário
  const horaManaus = (agora.getUTCHours() - 4 + 24) % 24;
  const minuto = agora.getUTCMinutes();
  return horaManaus === 7 && minuto < 5; // janela de 5 min para não perder
}

let relatorioDiarioEnviado = false;
let ultimoDiaRelatorio = -1;

function iniciarMonitorRelatorios() {
  setInterval(async () => {
    const agora = new Date();
    const diaAtual = agora.getUTCDate();

    // Resetar flag ao mudar de dia
    if (diaAtual !== ultimoDiaRelatorio) {
      relatorioDiarioEnviado = false;
      ultimoDiaRelatorio = diaAtual;
    }

    if (!relatorioDiarioEnviado && deveEnviarAgora()) {
      relatorioDiarioEnviado = true;
      await enviarRelatorioDiario();
    }
  }, 60 * 1000); // verifica a cada minuto

  console.log('[Relatório] Monitor de relatórios diários iniciado');
}

module.exports = { iniciarMonitorRelatorios, enviarRelatorioDiario };
