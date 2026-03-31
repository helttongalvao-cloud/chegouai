/**
 * Modelo de comissão do Chegou Aí — Taxa fixa de 5%
 *
 * Regra de repasse:
 *   - Lojista recebe: subtotal - 5%
 *   - Motoboy recebe: taxa de entrega integral
 *   - Plataforma fica com: 5% do subtotal
 *   - Taxa do cartão (2,99%) é cobrada do CLIENTE como conveniência
 *   - Taxa Pix (R$0,99) é absorvida pela plataforma
 *
 * Exemplo cartão: R$20 + R$4 entrega
 *   Cliente paga:   R$24,72 (R$24 + 2,99% conveniência)
 *   Lojista:        R$19,00
 *   Motoboy:        R$ 4,00
 *   Plataforma:     R$ 1,00 (5%) — Asaas cobra ~R$0,74 do total, sobra ~R$0,26
 *
 * Exemplo Pix: R$20 + R$4 entrega
 *   Cliente paga:   R$24,00
 *   Lojista:        R$19,00
 *   Motoboy:        R$ 4,00
 *   Plataforma:     R$ 1,00 - R$0,99 Asaas = R$0,01 lucro
 */

const COMISSAO_TAXA = 5; // % sobre o subtotal dos produtos

// Taxas Asaas (ajuste conforme plano contratado)
const TAXA_PIX_ASAAS      = parseFloat(process.env.ASAAS_TAXA_PIX    || '0.99'); // R$ fixo por Pix
const TAXA_CARTAO_PERCENT = parseFloat(process.env.ASAAS_TAXA_CARTAO || '2.99'); // % cobrado do cliente

/**
 * Calcula os valores do split de um pedido.
 *
 * @param {object} params
 * @param {number} params.subtotal        - Valor dos produtos (sem entrega)
 * @param {number} params.taxaEntrega     - Taxa de entrega (vai integral ao motoboy)
 * @param {string} [params.formaPagamento] - 'pix' | 'cartao' | 'dinheiro' | 'maquininha'
 */
function calcularSplit({ subtotal, taxaEntrega, formaPagamento }) {
  const sub  = parseFloat(subtotal   || 0);
  const taxa = parseFloat(taxaEntrega || 0);
  const baseTotal = parseFloat((sub + taxa).toFixed(2));

  // Taxa de conveniência do cartão cobrada do cliente
  let taxaConveniencia = 0;
  if (formaPagamento === 'cartao') {
    taxaConveniencia = parseFloat((baseTotal * TAXA_CARTAO_PERCENT / 100).toFixed(2));
  }

  // Total que o cliente efetivamente paga
  const total = parseFloat((baseTotal + taxaConveniencia).toFixed(2));

  // Split baseado nos valores originais (lojista e motoboy não são afetados)
  const valorPlataforma = parseFloat((sub * COMISSAO_TAXA / 100).toFixed(2));
  const valorLojista    = parseFloat((sub - valorPlataforma).toFixed(2));
  const valorMotoboy    = parseFloat(taxa.toFixed(2));

  // Custo do Pix absorvido pela plataforma; cartão já foi repassado ao cliente
  const taxaGateway     = formaPagamento === 'pix' ? TAXA_PIX_ASAAS : 0;
  const lucroPlataforma = parseFloat((valorPlataforma + taxaConveniencia - taxaGateway).toFixed(2));

  return {
    total,           // valor cobrado do cliente (inclui conveniência cartão)
    baseTotal,       // subtotal + entrega sem conveniência
    subtotal: parseFloat(sub.toFixed(2)),
    taxaEntrega: valorMotoboy,
    taxaConveniencia,
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
