/**
 * Modelo de comissão do Chegou Aí — Taxa fixa de 5%
 *
 * Regra de repasse:
 *   - Lojista recebe: subtotal - 5%
 *   - Motoboy recebe: taxa de entrega integral
 *   - Plataforma fica com: 5% do subtotal
 *   - Taxa do gateway (Asaas) é descontada da parte da plataforma
 *
 * Exemplo: R$20 lanche + R$4 entrega = R$24 total
 *   Lojista:    R$19,00 (R$20 - 5%)
 *   Motoboy:    R$ 4,00 (integral)
 *   Plataforma: R$ 1,00 (5%) - R$0,90 taxa Asaas = R$0,10 lucro
 */

const COMISSAO_TAXA = 5; // % sobre o subtotal dos produtos

// Taxas Asaas (ajuste conforme plano contratado)
const TAXA_PIX_ASAAS     = parseFloat(process.env.ASAAS_TAXA_PIX     || '0.99'); // R$ fixo por Pix
const TAXA_CARTAO_PERCENT = parseFloat(process.env.ASAAS_TAXA_CARTAO  || '2.99'); // % sobre total

/**
 * Calcula os valores do split de um pedido.
 *
 * @param {object} params
 * @param {number} params.subtotal       - Valor dos produtos (sem entrega)
 * @param {number} params.taxaEntrega    - Taxa de entrega (vai integral ao motoboy)
 * @param {string} [params.formaPagamento] - 'pix' | 'cartao' | 'dinheiro' | 'maquininha'
 */
function calcularSplit({ subtotal, taxaEntrega, formaPagamento }) {
  const sub   = parseFloat(subtotal  || 0);
  const taxa  = parseFloat(taxaEntrega || 0);
  const total = parseFloat((sub + taxa).toFixed(2));

  const valorPlataforma = parseFloat((sub * COMISSAO_TAXA / 100).toFixed(2));
  const valorLojista    = parseFloat((sub - valorPlataforma).toFixed(2));
  const valorMotoboy    = parseFloat(taxa.toFixed(2));

  // Custo do gateway descontado da parte da plataforma
  let taxaGateway = 0;
  if (formaPagamento === 'pix') {
    taxaGateway = TAXA_PIX_ASAAS;
  } else if (formaPagamento === 'cartao') {
    taxaGateway = parseFloat((total * TAXA_CARTAO_PERCENT / 100).toFixed(2));
  }

  const lucroPlataforma = parseFloat((valorPlataforma - taxaGateway).toFixed(2));

  return {
    total,
    subtotal: parseFloat(sub.toFixed(2)),
    taxaEntrega: valorMotoboy,
    valorLojista,
    valorMotoboy,
    valorPlataforma,
    taxaGateway,
    lucroPlataforma,
    comissao: {
      taxa: COMISSAO_TAXA,
      fase: 'Parceiro',
      descricao: `${COMISSAO_TAXA}% por pedido`,
    },
  };
}

// Mantém assinatura antiga para compatibilidade
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
