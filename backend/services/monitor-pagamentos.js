const { supabaseAdmin } = require('../config/supabase');
const { buscarPedido } = require('./pagarme');

// Importação lazy para evitar dependência circular
function getProcessar() {
  return require('../routes/payments').processarPagamentoAprovado;
}

async function verificarPagamentosPerdidos() {
  // Busca pedidos aguardando pagamento criados há mais de 1 min e menos de 24h
  const limite24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const limite1m  = new Date(Date.now() -      60 * 1000).toISOString();

  const { data: pedidos, error } = await supabaseAdmin
    .from('pedidos')
    .select('id, pagarme_order_id')
    .in('pagamento_status', ['aguardando', 'pendente'])
    .not('pagarme_order_id', 'is', null)
    .gte('criado_em', limite24h)
    .lte('criado_em', limite1m);

  if (error || !pedidos?.length) return;

  console.log(`[Monitor-Pag] Verificando ${pedidos.length} pedido(s) aguardando...`);

  for (const pedido of pedidos) {
    try {
      const order = await buscarPedido(pedido.pagarme_order_id);
      console.log(`[Monitor-Pag] Pedido ${pedido.id} → Pagar.me status: "${order.status}"`);
      if (order.status === 'paid') {
        console.log(`[Monitor-Pag] ✓ Pagamento recuperado para pedido ${pedido.id}`);
        const processar = getProcessar();
        await processar(pedido.id, pedido.pagarme_order_id);
      }
    } catch (e) {
      console.error(`[Monitor-Pag] Erro ao verificar pedido ${pedido.id} (pagarme_id: ${pedido.pagarme_order_id}):`, e.message);
    }
  }
}

function iniciarMonitorPagamentos() {
  console.log('[Monitor-Pag] Monitor de pagamentos perdidos iniciado (intervalo: 2min)');
  setInterval(async () => {
    try {
      await verificarPagamentosPerdidos();
    } catch (e) {
      console.error('[Monitor-Pag] Erro geral:', e.message);
    }
  }, 2 * 60 * 1000);
}

module.exports = { iniciarMonitorPagamentos };
