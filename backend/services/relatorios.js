const { supabaseAdmin } = require('../config/supabase');
const { alertarAdmin, enviarWhatsApp } = require('./whatsapp');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MANAUS_OFFSET_MS = 4 * 60 * 60 * 1000;

function agoraManaus() {
  return new Date(Date.now() - MANAUS_OFFSET_MS);
}

function manausDateToUTC(dateStr, horaStr = '00:00:00.000') {
  return new Date(`${dateStr}T${horaStr}Z`).getTime() + MANAUS_OFFSET_MS;
}

function horaManaus() {
  const agora = new Date();
  return (agora.getUTCHours() - 4 + 24) % 24;
}

function minutoAtual() {
  return new Date().getUTCMinutes();
}

// ─── RELATÓRIO DIÁRIO ADMIN ───────────────────────────────────────────────────

async function enviarRelatorioDiarioAdmin() {
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

    const todos     = pedidos || [];
    const entregues = todos.filter(p => p.status === 'entregue');
    const cancelados = todos.filter(p => p.status === 'cancelado');
    const gmv       = entregues.reduce((s, p) => s + Number(p.total || 0), 0);
    const comissao  = entregues.reduce((s, p) => s + Number(p.comissao_plataforma || 0), 0);
    const ticket    = entregues.length ? gmv / entregues.length : 0;

    const { count: motoboyAtivos } = await supabaseAdmin
      .from('motoboys').select('id', { count: 'exact', head: true }).eq('ativo', true);
    const { count: lojistasAtivos } = await supabaseAdmin
      .from('estabelecimentos').select('id', { count: 'exact', head: true }).eq('ativo', true);

    const dtOntem = new Date(inicioDia).toLocaleDateString('pt-BR', { timeZone: 'America/Manaus' });
    await alertarAdmin(
      `📊 *Relatório diário — ${dtOntem}*\n\n` +
      `🛒 *Pedidos:* ${todos.length} (${entregues.length} entregues, ${cancelados.length} cancelados)\n` +
      `💰 *GMV:* R$ ${gmv.toFixed(2).replace('.', ',')}\n` +
      `🎯 *Comissão:* R$ ${comissao.toFixed(2).replace('.', ',')}\n` +
      `🧾 *Ticket médio:* R$ ${ticket.toFixed(2).replace('.', ',')}\n\n` +
      `🛵 *Motoboys ativos:* ${motoboyAtivos || 0}\n` +
      `🏪 *Lojistas ativos:* ${lojistasAtivos || 0}`
    );
    console.log('[Relatório] Diário admin enviado');
  } catch (e) {
    console.error('[Relatório] Erro relatório admin:', e.message);
  }
}

// ─── RELATÓRIO DIÁRIO POR LOJISTA (22h) ──────────────────────────────────────

async function enviarRelatoriosDiariosLojistas() {
  const hojeStr = agoraManaus().toISOString().slice(0, 10);
  const inicioDia = new Date(manausDateToUTC(hojeStr, '00:00:00.000'));
  const fimDia   = new Date(manausDateToUTC(hojeStr, '23:59:59.999'));

  try {
    const { data: lojistas } = await supabaseAdmin
      .from('estabelecimentos')
      .select('id, nome, whatsapp')
      .eq('ativo', true);

    if (!lojistas?.length) return;

    for (const loja of lojistas) {
      if (!loja.whatsapp) continue;

      const { data: pedidos } = await supabaseAdmin
        .from('pedidos')
        .select('id, total, status, forma_pagamento')
        .eq('estabelecimento_id', loja.id)
        .eq('pagamento_status', 'aprovado')
        .gte('criado_em', inicioDia.toISOString())
        .lte('criado_em', fimDia.toISOString());

      const todos     = pedidos || [];
      const entregues = todos.filter(p => p.status === 'entregue');
      const cancelados = todos.filter(p => p.status === 'cancelado');
      const faturamento = entregues.reduce((s, p) => s + Number(p.total || 0), 0);
      const comissao = faturamento * 0.05;
      const liquido  = faturamento - comissao;

      // Buscar avaliação média do dia
      const { data: avals } = await supabaseAdmin
        .from('avaliacoes')
        .select('nota')
        .eq('estabelecimento_id', loja.id)
        .gte('criado_em', inicioDia.toISOString());

      const mediaAval = avals?.length
        ? (avals.reduce((s, a) => s + Number(a.nota || 0), 0) / avals.length).toFixed(1)
        : null;

      const dtHoje = inicioDia.toLocaleDateString('pt-BR', { timeZone: 'America/Manaus' });

      let msg = `📊 *${loja.nome} — ${dtHoje}*\n\n`;

      if (todos.length === 0) {
        msg += `Nenhum pedido hoje. 😔\n\n💡 Compartilhe o link da sua loja para atrair mais clientes!`;
      } else {
        msg +=
          `🛒 *Pedidos:* ${todos.length} (${entregues.length} entregues, ${cancelados.length} cancelados)\n` +
          `💰 *Faturamento bruto:* R$ ${faturamento.toFixed(2).replace('.', ',')}\n` +
          `🎯 *Comissão Chegô (5%):* R$ ${comissao.toFixed(2).replace('.', ',')}\n` +
          `✅ *Líquido:* R$ ${liquido.toFixed(2).replace('.', ',')}` +
          (mediaAval ? `\n⭐ *Avaliação do dia:* ${mediaAval}` : '') +
          `\n\nBom trabalho! Até amanhã 🚀`;
      }

      await enviarWhatsApp(loja.whatsapp, msg).catch(() => {});
    }

    console.log(`[Relatório] Diário lojistas enviado (${lojistas.length} lojas)`);
  } catch (e) {
    console.error('[Relatório] Erro relatório lojistas:', e.message);
  }
}

// ─── RELATÓRIO FISCAL MENSAL EM PDF ──────────────────────────────────────────

async function gerarRelatorioFiscalMensal() {
  const agora  = agoraManaus();
  const ano    = agora.getFullYear();
  const mes    = agora.getMonth(); // mês atual = mês que acabou de fechar (estamos no dia 1)
  const mesAnterior = mes === 0 ? 11 : mes - 1;
  const anoAnterior = mes === 0 ? ano - 1 : ano;

  const nomeMes = new Date(anoAnterior, mesAnterior, 1)
    .toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  const inicioMes = new Date(anoAnterior, mesAnterior, 1);
  const fimMes    = new Date(ano, mes, 0, 23, 59, 59, 999); // último dia do mês anterior

  try {
    const { data: lojistas } = await supabaseAdmin
      .from('estabelecimentos').select('id, nome, whatsapp').eq('ativo', true);

    if (!lojistas?.length) return;

    for (const loja of lojistas) {
      const { data: pedidos } = await supabaseAdmin
        .from('pedidos')
        .select('id, total, comissao_plataforma, status, forma_pagamento, criado_em')
        .eq('estabelecimento_id', loja.id)
        .eq('pagamento_status', 'aprovado')
        .gte('criado_em', inicioMes.toISOString())
        .lte('criado_em', fimMes.toISOString());

      const todos     = pedidos || [];
      const entregues = todos.filter(p => p.status === 'entregue');
      const cancelados = todos.filter(p => p.status === 'cancelado');
      const gmv       = entregues.reduce((s, p) => s + Number(p.total || 0), 0);
      const comissao  = entregues.reduce((s, p) => s + Number(p.comissao_plataforma || 0), 0);
      const liquido   = gmv - comissao;
      const ticket    = entregues.length ? gmv / entregues.length : 0;

      // Gerar PDF
      const pdfPath = path.join(os.tmpdir(), `fiscal_${loja.id}_${anoAnterior}_${String(mesAnterior + 1).padStart(2, '0')}.pdf`);
      await new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const stream = fs.createWriteStream(pdfPath);
        doc.pipe(stream);

        // Cabeçalho
        doc.fontSize(20).font('Helvetica-Bold').text('Chegô', { align: 'center' });
        doc.fontSize(14).font('Helvetica').text('Relatório Fiscal Mensal', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(12).text(`Parceiro: ${loja.nome}`, { align: 'center' });
        doc.fontSize(11).fillColor('#555').text(`Período: ${nomeMes}`, { align: 'center' });
        doc.fillColor('#000').moveDown(1);

        // Linha divisória
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown(0.5);

        // Resumo
        const linha = (label, valor) => {
          doc.fontSize(11).font('Helvetica-Bold').text(label, { continued: true });
          doc.font('Helvetica').text(valor, { align: 'right' });
        };

        linha('Total de pedidos:', String(todos.length));
        linha('Pedidos entregues:', String(entregues.length));
        linha('Pedidos cancelados:', String(cancelados.length));
        doc.moveDown(0.3);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).dash(3, { space: 3 }).stroke();
        doc.undash().moveDown(0.3);
        linha('Faturamento bruto (GMV):', `R$ ${gmv.toFixed(2).replace('.', ',')}`);
        linha('Comissão Chegô (5%):', `R$ ${comissao.toFixed(2).replace('.', ',')}`);
        doc.moveDown(0.3);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown(0.3);
        doc.fontSize(13).font('Helvetica-Bold');
        linha('Valor líquido a receber:', `R$ ${liquido.toFixed(2).replace('.', ',')}`);
        doc.moveDown(0.3);
        doc.fontSize(11).font('Helvetica');
        linha('Ticket médio:', `R$ ${ticket.toFixed(2).replace('.', ',')}`);

        // Detalhamento por pagamento
        doc.moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Detalhamento por forma de pagamento');
        doc.moveDown(0.3);
        const pix  = entregues.filter(p => p.forma_pagamento === 'pix');
        const cartao = entregues.filter(p => p.forma_pagamento === 'cartao');
        const pixGmv = pix.reduce((s, p) => s + Number(p.total || 0), 0);
        const cartaoGmv = cartao.reduce((s, p) => s + Number(p.total || 0), 0);
        doc.fontSize(11).font('Helvetica');
        linha(`Pix (${pix.length} pedidos):`, `R$ ${pixGmv.toFixed(2).replace('.', ',')}`);
        linha(`Cartão (${cartao.length} pedidos):`, `R$ ${cartaoGmv.toFixed(2).replace('.', ',')}`);

        // Rodapé
        doc.moveDown(2);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown(0.5);
        doc.fontSize(9).fillColor('#777')
          .text(`Documento gerado automaticamente em ${new Date().toLocaleDateString('pt-BR')} pelo sistema Chegô.`, { align: 'center' })
          .text('chegouaiapp.com.br', { align: 'center' });

        doc.end();
        stream.on('finish', resolve);
        stream.on('error', reject);
      });

      // Enviar via WhatsApp como mensagem de texto com resumo (Z-API texto por enquanto)
      if (loja.whatsapp && gmv > 0) {
        await enviarWhatsApp(loja.whatsapp,
          `📄 *Relatório Fiscal — ${nomeMes}*\n\n` +
          `🏪 *${loja.nome}*\n\n` +
          `🛒 Pedidos entregues: ${entregues.length}\n` +
          `💰 Faturamento bruto: R$ ${gmv.toFixed(2).replace('.', ',')}\n` +
          `🎯 Comissão Chegô (5%): R$ ${comissao.toFixed(2).replace('.', ',')}\n` +
          `✅ *Líquido: R$ ${liquido.toFixed(2).replace('.', ',')}*\n\n` +
          `O relatório completo em PDF está disponível no seu painel. Acesse: chegouaiapp.com.br/app`
        ).catch(() => {});
      }

      // Limpar arquivo temporário
      fs.unlink(pdfPath, () => {});
    }

    await alertarAdmin(`📄 *Relatórios fiscais de ${nomeMes} gerados* para ${lojistas.length} parceiros.`);
    console.log(`[Relatório] Fiscal mensal gerado — ${nomeMes}`);
  } catch (e) {
    console.error('[Relatório] Erro fiscal mensal:', e.message);
  }
}

// ─── CONTROLE DE TEMPO ───────────────────────────────────────────────────────

let relatorioDiarioAdminEnviado = false;
let relatorioLojistasEnviado = false;
let relatorioFiscalEnviado = false;
let ultimoDiaManaus = '';

function iniciarMonitorRelatorios() {
  setInterval(async () => {
    const agora = agoraManaus();
    const diaAtual = agora.toISOString().slice(0, 10);
    const hora = horaManaus();
    const minuto = minutoAtual();

    // Resetar flags ao mudar de dia
    if (diaAtual !== ultimoDiaManaus) {
      relatorioDiarioAdminEnviado = false;
      relatorioLojistasEnviado = false;
      relatorioFiscalEnviado = false;
      ultimoDiaManaus = diaAtual;
    }

    // Relatório admin às 7h
    if (!relatorioDiarioAdminEnviado && hora === 7 && minuto < 5) {
      relatorioDiarioAdminEnviado = true;
      await enviarRelatorioDiarioAdmin();
    }

    // Relatório por lojista às 22h
    if (!relatorioLojistasEnviado && hora === 22 && minuto < 5) {
      relatorioLojistasEnviado = true;
      await enviarRelatoriosDiariosLojistas();
    }

    // Relatório fiscal mensal: dia 1 às 6h
    if (!relatorioFiscalEnviado && agora.getDate() === 1 && hora === 6 && minuto < 5) {
      relatorioFiscalEnviado = true;
      await gerarRelatorioFiscalMensal();
    }
  }, 60 * 1000);

  console.log('[Relatório] Monitor iniciado — admin 7h, lojistas 22h, fiscal dia 1 às 6h');
}

module.exports = { iniciarMonitorRelatorios, enviarRelatorioDiarioAdmin };
