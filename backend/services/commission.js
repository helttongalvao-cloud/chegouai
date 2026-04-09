/**
 * commission.js — Cálculo de split e repasse de taxas (Pagar.me v5 + D+0)
 *
 * Regras de split:
 *   Lojista:    95% do subtotal dos produtos  (charge_processing_fee: false)
 *   Motoboy:    100% do frete                 (transferência Pix separada após entrega)
 *   Plataforma: 5% + diferença de taxa do cartão (charge_processing_fee: true, remainder)
 *
 * Pix:   taxa % absorvida pela plataforma — cliente paga o valor base.
 * Cartão: taxa gateway + antecipação D+0 repassadas ao cliente via gross-up.
 *         Fórmula: preco_cliente = valor_base / (1 - taxa_total%) + taxa_fixa
 */

const COMISSAO_TAXA = 5; // % sobre o subtotal dos produtos

// ── Taxas Pagar.me ──────────────────────────────────────────────────────────
// Configure via variáveis de ambiente conforme seu plano/negociação.
const TAXA_PIX_PERCENT       = parseFloat(process.env.PAGARME_TAXA_PIX_PERCENT        || '0.99'); // % sobre o total Pix
const TAXA_CARTAO_PERCENT    = parseFloat(process.env.PAGARME_TAXA_CARTAO_PERCENT     || '3.99'); // % base cartão crédito
const TAXA_ANTECIP_PERCENT   = parseFloat(process.env.PAGARME_TAXA_ANTECIPACAO_PERCENT || '1.99'); // % antecipação D+0
const TAXA_FIXA_CARTAO       = parseFloat(process.env.PAGARME_TAXA_FIXA_CARTAO        || '0.70'); // R$ fixo por transação cartão

/**
 * Calcula os valores de split de um pedido.
 *
 * @param {object} params
 * @param {number} params.subtotal        - Valor dos produtos (sem entrega)
 * @param {number} params.taxaEntrega     - Taxa de entrega (vai integral ao motoboy)
 * @param {string} [params.formaPagamento] - 'pix' | 'cartao'
 * @returns {object} Objeto com todos os valores em R$ (2 casas decimais)
 */
function calcularSplit({ subtotal, taxaEntrega, formaPagamento }) {
  const sub   = parseFloat(subtotal    || 0);
  const frete = parseFloat(taxaEntrega || 0);

  // ── Valores de destino (lojista e motoboy não mudam) ──────────────────────
  const valorPlataforma = parseFloat((sub * COMISSAO_TAXA / 100).toFixed(2));
  const valorLojista    = parseFloat((sub - valorPlataforma).toFixed(2));
  const valorMotoboy    = parseFloat(frete.toFixed(2));
  const valorBase       = parseFloat((sub + frete).toFixed(2));

  let total, taxaConveniencia, taxaGateway, lucroPlataforma;

  if (formaPagamento === 'cartao') {
    // Gross-up: cliente paga o suficiente para cobrir gateway + antecipação D+0
    const taxaTotalFrac = (TAXA_CARTAO_PERCENT + TAXA_ANTECIP_PERCENT) / 100;
    const totalBruto    = valorBase / (1 - taxaTotalFrac);
    total               = parseFloat((totalBruto + TAXA_FIXA_CARTAO).toFixed(2));
    taxaConveniencia    = parseFloat((total - valorBase).toFixed(2));

    // Custo efetivo do gateway sobre o total cobrado do cliente
    taxaGateway   = parseFloat((total * taxaTotalFrac + TAXA_FIXA_CARTAO).toFixed(2));
    lucroPlataforma = parseFloat((valorPlataforma + taxaConveniencia - taxaGateway).toFixed(2));
  } else {
    // Pix: cliente paga o valor base; plataforma absorve a taxa percentual
    total           = valorBase;
    taxaConveniencia = 0;
    taxaGateway     = parseFloat((total * TAXA_PIX_PERCENT / 100).toFixed(2));
    lucroPlataforma  = parseFloat((valorPlataforma - taxaGateway).toFixed(2));
  }

  return {
    total,            // o que o cliente paga (R$)
    valorBase,        // subtotal + frete sem markup
    subtotal: parseFloat(sub.toFixed(2)),
    taxaEntrega: valorMotoboy,
    taxaConveniencia, // markup cartão repassado ao cliente
    valorLojista,     // 95% do subtotal
    valorMotoboy,     // 100% do frete
    valorPlataforma,  // 5% do subtotal (antes das taxas)
    taxaGateway,      // custo do gateway absorvido pela plataforma (Pix) ou cobrado do cliente (cartão)
    lucroPlataforma,  // receita líquida real da plataforma
    comissao: {
      taxa: COMISSAO_TAXA,
      fase: 'Parceiro',
      descricao: `${COMISSAO_TAXA}% por pedido`,
    },
  };
}

// Mantém assinatura de compatibilidade usada em algumas rotas
function calcularComissao() {
  return {
    taxa: COMISSAO_TAXA,
    mesAtivo: null,
    fase: 'Parceiro',
    descricao: `${COMISSAO_TAXA}% por pedido`,
    cor: '#00C853',
  };
}

module.exports = { calcularComissao, calcularSplit };
