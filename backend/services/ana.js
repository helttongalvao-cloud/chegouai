const Anthropic = require('@anthropic-ai/sdk');
const { supabaseAdmin } = require('../config/supabase');
const { enviarWhatsApp } = require('./whatsapp');

const MANAUS_OFFSET_MS = 4 * 60 * 60 * 1000;

function horaManaus() {
  return (new Date().getUTCHours() - 4 + 24) % 24;
}
function minutoAtual() {
  return new Date().getUTCMinutes();
}
function agoraManaus() {
  return new Date(Date.now() - MANAUS_OFFSET_MS);
}

let briefingEnviado = false;
let ultimoDiaEnviado = -1;

async function coletarDados() {
  const agora = agoraManaus();
  const ontem = new Date(agora.getTime() - 24 * 60 * 60 * 1000);
  const ha5dias = new Date(agora.getTime() - 5 * 24 * 60 * 60 * 1000);
  const ha3dias = new Date(agora.getTime() - 3 * 24 * 60 * 60 * 1000);

  const inicioDiaOntem = new Date(ontem);
  inicioDiaOntem.setUTCHours(4, 0, 0, 0); // meia-noite Manaus em UTC
  const fimDiaOntem = new Date(agora);
  fimDiaOntem.setUTCHours(4, 0, 0, 0);

  const [
    { data: candidaturasPendentes },
    { data: lojistasInativos },
    { data: motoboysInativos },
    { data: pedidosProblema },
    { data: faturamento },
    { data: novosLojistas },
  ] = await Promise.all([
    // Motoboys aguardando aprovação
    supabaseAdmin.from('candidaturas').select('nome, criado_em').eq('status', 'pendente'),

    // Lojistas sem pedido há mais de 5 dias
    supabaseAdmin.from('estabelecimentos')
      .select('nome, whatsapp')
      .eq('ativo', true)
      .lt('ultimo_pedido_em', ha5dias.toISOString()),

    // Motoboys inativos há mais de 3 dias
    supabaseAdmin.from('motoboys')
      .select('nome, telefone')
      .eq('ativo', true)
      .lt('ultimo_online', ha3dias.toISOString()),

    // Pedidos cancelados ou travados nas últimas 24h
    supabaseAdmin.from('pedidos')
      .select('id, status, estabelecimentos(nome)')
      .eq('status', 'cancelado')
      .gte('criado_em', ontem.toISOString()),

    // Faturamento do dia anterior
    supabaseAdmin.from('pedidos')
      .select('subtotal, comissao_plataforma')
      .eq('pagamento_status', 'aprovado')
      .neq('status', 'cancelado')
      .gte('criado_em', inicioDiaOntem.toISOString())
      .lt('criado_em', fimDiaOntem.toISOString()),

    // Novos lojistas aprovados ontem
    supabaseAdmin.from('estabelecimentos')
      .select('nome')
      .eq('ativo', true)
      .gte('cadastro_data', ontem.toISOString()),
  ]);

  const gmv = (faturamento || []).reduce((s, p) => s + parseFloat(p.subtotal || 0), 0);
  const comissao = (faturamento || []).reduce((s, p) => s + parseFloat(p.comissao_plataforma || 0), 0);

  return {
    data: agora.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }),
    candidaturasPendentes: candidaturasPendentes || [],
    lojistasInativos: lojistasInativos || [],
    motoboysInativos: motoboysInativos || [],
    pedidosCancelados: (pedidosProblema || []).length,
    faturamento: { gmv, comissao, pedidos: (faturamento || []).length },
    novosLojistas: novosLojistas || [],
  };
}

async function gerarBriefing(dados) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `Você é Ana, secretária pessoal e inteligente do Helton, fundador do Chegô (app de delivery).
Escreva o briefing matinal do dia ${dados.data} para o Helton em português brasileiro natural, próximo e profissional.
Seja concisa, direta e humana — não robótica. Varie o tom e a abertura a cada dia. Use emojis com moderação.

Dados do dia:
- Candidaturas de motoboy pendentes: ${dados.candidaturasPendentes.length > 0 ? dados.candidaturasPendentes.map(c => c.nome).join(', ') : 'nenhuma'}
- Lojistas inativos há mais de 5 dias: ${dados.lojistasInativos.length > 0 ? dados.lojistasInativos.map(l => l.nome).join(', ') : 'nenhum'}
- Motoboys inativos há mais de 3 dias: ${dados.motoboysInativos.length > 0 ? dados.motoboysInativos.map(m => m.nome).join(', ') : 'nenhum'}
- Pedidos cancelados ontem: ${dados.pedidosCancelados}
- Faturamento de ontem: R$ ${dados.faturamento.gmv.toFixed(2).replace('.', ',')} (${dados.faturamento.pedidos} pedidos, comissão R$ ${dados.faturamento.comissao.toFixed(2).replace('.', ',')})
- Novos lojistas aprovados ontem: ${dados.novosLojistas.length > 0 ? dados.novosLojistas.map(l => l.nome).join(', ') : 'nenhum'}

Regras:
- Mencione apenas o que for relevante (não diga "nenhum" para cada item vazio)
- Se houver ações urgentes, destaque-as
- Finalize com algo motivador mas breve
- Máximo 5-7 linhas no WhatsApp`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

async function enviarBriefingAna() {
  try {
    console.log('[Ana] Coletando dados para o briefing...');
    const dados = await coletarDados();
    const briefing = await gerarBriefing(dados);
    const adminPhone = process.env.ADMIN_WHATSAPP;
    if (!adminPhone) { console.warn('[Ana] ADMIN_WHATSAPP não configurado'); return; }
    await enviarWhatsApp(adminPhone, briefing);
    console.log('[Ana] Briefing enviado com sucesso');
  } catch (e) {
    console.error('[Ana] Erro ao gerar briefing:', e.message);
  }
}

function iniciarAna() {
  setInterval(async () => {
    const hora = horaManaus();
    const minuto = minutoAtual();
    const diaHoje = agoraManaus().getDate();

    if (hora === 7 && minuto < 10) {
      if (!briefingEnviado || ultimoDiaEnviado !== diaHoje) {
        briefingEnviado = true;
        ultimoDiaEnviado = diaHoje;
        await enviarBriefingAna().catch(() => {});
      }
    } else if (hora !== 7) {
      briefingEnviado = false;
    }
  }, 60 * 1000); // verifica a cada 1 minuto

  console.log('[Ana] Secretária iniciada — briefing diário às 7h');
}

module.exports = { iniciarAna, enviarBriefingAna };
