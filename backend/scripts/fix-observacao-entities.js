// Script pontual: decodifica entidades HTML em observacao dos itens de pedido
// Causado pelo .escape() do express-validator que foi removido
// Rodar: node backend/scripts/fix-observacao-entities.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { supabaseAdmin } = require('../config/supabase');

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function fixObservacoes() {
  console.log('Buscando itens com observações corrompidas na tabela itens_pedido...');

  let offset = 0;
  const batchSize = 500;
  let totalFixados = 0;

  while (true) {
    const { data: itens, error } = await supabaseAdmin
      .from('itens_pedido')
      .select('id, observacao, pedido_id')
      .not('observacao', 'is', null)
      .ilike('observacao', '%&#%')
      .range(offset, offset + batchSize - 1);

    if (error) { console.error('Erro:', error.message); break; }
    if (!itens?.length) break;

    for (const item of itens) {
      const novaObs = decodeEntities(item.observacao);
      if (novaObs === item.observacao) continue;

      console.log(`  Item ${item.id} (pedido ${item.pedido_id?.slice(0,8)}):`);
      console.log(`    Antes:  ${item.observacao.slice(0, 80)}`);
      console.log(`    Depois: ${novaObs.slice(0, 80)}`);

      const { error: errUpd } = await supabaseAdmin
        .from('itens_pedido')
        .update({ observacao: novaObs })
        .eq('id', item.id);

      if (errUpd) {
        console.error(`  ERRO ao atualizar item ${item.id}:`, errUpd.message);
      } else {
        totalFixados++;
      }
    }

    if (itens.length < batchSize) break;
    offset += batchSize;
  }

  console.log(`\nConcluído. ${totalFixados} item(ns) corrigido(s).`);
}

fixObservacoes().catch(console.error);
