const { supabaseAdmin } = require('../config/supabase');
const { enviarWhatsApp } = require('./whatsapp');

// Sequência D1: 6 mensagens enviadas imediatamente na aprovação
// Seguidas de acompanhamentos nos dias 7 e 15
const SEQUENCIA_D1 = [
  { tipo: 'onb_d1_1', mensagem: (nome) =>
    `Oi, ${nome}! 🎉 Aqui é a Ana, do time Chegô. Sua loja acabou de entrar no ar e eu vou te acompanhar nos primeiros dias pra garantir que tudo vai bem! Acessa o app agora e vamos configurar tudo juntos: chegouaiapp.com.br/app`
  },
  { tipo: 'onb_d1_2', mensagem: (nome) =>
    `Uma dica rápida que faz toda a diferença: coloca uma boa foto da sua loja no app! Lojas com foto recebem muito mais atenção dos clientes. É rapidinho — Painel → Minha Loja → Foto 📸`
  },
  { tipo: 'onb_d1_3', mensagem: (nome) =>
    `Agora o mais importante: cadastra seu primeiro produto! Sem produtos no cardápio, sua loja não aparece pra nenhum cliente. Painel → Cardápio → Adicionar produto. Qualquer dúvida me chama aqui 😊`
  },
  { tipo: 'onb_d1_4', mensagem: (nome) =>
    `Já configurou o horário de funcionamento? Os clientes só veem sua loja como aberta nos horários que você definir. Painel → Minha Loja → Horários de funcionamento ⏰`
  },
  { tipo: 'onb_d1_5', mensagem: (nome) =>
    `Quando chegar seu primeiro pedido, aceita logo! O cliente fica esperando a confirmação em tempo real. Depois é só avançar: Preparando → Pronto. O motoboy busca e cuida do resto. Você consegue! 🛵`
  },
  { tipo: 'onb_d1_6', mensagem: (nome) =>
    `${nome}, agora compartilha o link da sua loja com todo mundo que você conhece — WhatsApp, Instagram, grupos de família! Os primeiros pedidos quase sempre vêm de quem já te conhece. Copia seu link no painel e manda pra galera 📲`
  },
];

const SEQUENCIA_FOLLOWUP = [
  { dia: 7, tipo: 'onb_d7', mensagem: (nome) =>
    `Oi, ${nome}! Aqui é a Ana de novo 😊 Já faz uma semana que sua loja está no Chegô! Como estão as coisas? Se precisar de ajuda com qualquer configuração, pode me chamar aqui. Estamos torcendo por você! 🚀`
  },
  { dia: 15, tipo: 'onb_d15', mensagem: (nome) =>
    `${nome}, 15 dias no *Chegô*! 🎯 Você já conferiu o *painel de relatórios*? Veja quais produtos vendem mais e os horários de pico da sua loja. Painel → Relatório. Qualquer ideia ou sugestão, estamos ouvindo! 💬`
  },
];

async function agendarOnboardingLojista(estabelecimentoId, nomeResponsavel, whatsapp) {
  if (!whatsapp) return;
  const tel = whatsapp.replace(/\D/g, '');
  const agora = new Date();

  const registros = [
    // 6 mensagens D1 todas com enviar_em = agora (enviadas imediatamente)
    ...SEQUENCIA_D1.map(({ tipo, mensagem }) => ({
      enviar_em: agora.toISOString(),
      para: tel,
      mensagem: mensagem(nomeResponsavel),
      tipo,
      referencia_id: estabelecimentoId,
    })),
    // Follow-ups nos dias 7 e 15
    ...SEQUENCIA_FOLLOWUP.map(({ dia, tipo, mensagem }) => ({
      enviar_em: new Date(agora.getTime() + (dia - 1) * 24 * 60 * 60 * 1000).toISOString(),
      para: tel,
      mensagem: mensagem(nomeResponsavel),
      tipo,
      referencia_id: estabelecimentoId,
    })),
  ];

  const { error } = await supabaseAdmin.from('whatsapp_agendados').insert(registros);
  if (error) console.error('[Onboarding] Erro ao agendar mensagens:', error.message);
  else console.log(`[Onboarding] ${registros.length} mensagens agendadas para ${nomeResponsavel}`);
}

// Enviar mensagens vencidas — chamado periodicamente
async function processarMensagensAgendadas() {
  const agora = new Date().toISOString();
  let processadas = 0;

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
        break;
      }
    }

    if (data.length < 100) break;
  }

  if (processadas > 0) console.log(`[Onboarding] ${processadas} mensagem(ns) processada(s)`);
}

function iniciarMonitorOnboarding() {
  processarMensagensAgendadas().catch(() => {});
  setInterval(() => processarMensagensAgendadas().catch(() => {}), 10 * 60 * 1000);
  console.log('[Onboarding] Monitor iniciado (intervalo: 10min)');
}

module.exports = { agendarOnboardingLojista, iniciarMonitorOnboarding };
