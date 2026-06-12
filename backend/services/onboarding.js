const { supabaseAdmin } = require('../config/supabase');
const { enviarWhatsApp } = require('./whatsapp');

// Mensagens da sequência de onboarding para lojistas
// Disparadas nos dias 1,2,3,5,7,15 após o cadastro
const SEQUENCIA = [
  { dia: 1, tipo: 'onb_d1', mensagem: (nome) =>
    `🎉 Olá, ${nome}! Sua loja acaba de entrar no ar no *Chegô*!\n\n` +
    `Acesse o painel e cadastre seus produtos para começar a receber pedidos:\n` +
    `chegouaiapp.com.br/app\n\n` +
    `Qualquer dúvida, é só chamar aqui. 🛵`
  },
  { dia: 2, tipo: 'onb_d2', mensagem: (nome) =>
    `Oi, ${nome}! Dica rápida 📸\n\n` +
    `Lojas com foto de capa recebem *3x mais cliques*. Adicione uma boa foto da sua loja no painel!\n\n` +
    `chegouaiapp.com.br/app`
  },
  { dia: 3, tipo: 'onb_d3', mensagem: (nome) =>
    `${nome}, você já configurou seus *horários de funcionamento*? ⏰\n\n` +
    `Os clientes só encontram sua loja quando ela está marcada como aberta.\n\n` +
    `Painel → Configurações → Horários de funcionamento`
  },
  { dia: 5, tipo: 'onb_d5', mensagem: (nome) =>
    `Oi, ${nome}! Seus primeiros pedidos dependem de divulgação. 📣\n\n` +
    `Compartilhe o link da sua loja no WhatsApp, Instagram e com amigos — é o jeito mais rápido de crescer!\n\n` +
    `Acesse o painel para copiar seu link exclusivo.`
  },
  { dia: 7, tipo: 'onb_d7', mensagem: (nome) =>
    `Uma semana no *Chegô*! 🙌\n\n` +
    `${nome}, como estão as coisas? Se precisar de ajuda para configurar produtos, frete ou pagamentos, chama a gente.\n\n` +
    `Estamos aqui para ajudar você a crescer! 🚀`
  },
  { dia: 15, tipo: 'onb_d15', mensagem: (nome) =>
    `15 dias no *Chegô*, ${nome}! 🎯\n\n` +
    `Você já conferiu o *painel de relatórios*? Veja quais produtos vendem mais, horários de pico e desempenho geral.\n\n` +
    `Painel → Relatórios\n\n` +
    `Qualquer ideia ou sugestão, estamos ouvindo! 💬`
  },
];

// Agendar sequência completa para um lojista recém-cadastrado
async function agendarOnboardingLojista(estabelecimentoId, nomeResponsavel, whatsapp) {
  if (!whatsapp) return;
  const agora = new Date();
  const registros = SEQUENCIA.map(({ dia, tipo, mensagem }) => {
    const enviarEm = new Date(agora.getTime() + dia * 24 * 60 * 60 * 1000);
    return {
      enviar_em: enviarEm.toISOString(),
      para: whatsapp.replace(/\D/g, ''),
      mensagem: mensagem(nomeResponsavel),
      tipo,
      referencia_id: estabelecimentoId,
    };
  });

  const { error } = await supabaseAdmin.from('whatsapp_agendados').insert(registros);
  if (error) console.error('[Onboarding] Erro ao agendar mensagens:', error.message);
  else console.log(`[Onboarding] ${registros.length} mensagens agendadas para ${nomeResponsavel}`);
}

// Enviar mensagens vencidas — chamado periodicamente
async function processarMensagensAgendadas() {
  const agora = new Date().toISOString();
  let processadas = 0;

  // Loop até esgotar todas as mensagens vencidas (evita perder se > 100 vencerem juntas)
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('whatsapp_agendados')
      .select('id, para, mensagem, tipo')
      .lte('enviar_em', agora)
      .eq('enviado', false)
      .limit(100);

    if (error || !data?.length) break;

    for (const msg of data) {
      try {
        await enviarWhatsApp(msg.para, msg.mensagem);
        await supabaseAdmin
          .from('whatsapp_agendados')
          .update({ enviado: true, enviado_em: new Date().toISOString() })
          .eq('id', msg.id);
        console.log(`[Onboarding] ✓ ${msg.tipo} enviado para ${msg.para.substring(0,8)}***`);
        processadas++;
      } catch (e) {
        console.error(`[Onboarding] ✗ Falha ao enviar ${msg.id}:`, e.message);
        // Marca como enviado mesmo com falha de WhatsApp para não ficar em loop infinito
        // (se Z-API estiver fora, voltará na próxima rodada com .eq('enviado', false))
        break;
      }
    }

    if (data.length < 100) break; // Não há mais mensagens pendentes
  }

  if (processadas > 0) console.log(`[Onboarding] ${processadas} mensagem(ns) processada(s)`);
}

function iniciarMonitorOnboarding() {
  // Verifica mensagens agendadas a cada 10 minutos
  processarMensagensAgendadas().catch(() => {});
  setInterval(() => processarMensagensAgendadas().catch(() => {}), 10 * 60 * 1000);
  console.log('[Onboarding] Monitor iniciado (intervalo: 10min)');
}

module.exports = { agendarOnboardingLojista, iniciarMonitorOnboarding };
