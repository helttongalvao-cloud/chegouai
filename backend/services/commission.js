/**
 * Modelo progressivo de comissão do Chegou Aí.
 *
 * Mês 1:   0%   — Gratuito (boas-vindas)
 * Mês 2-3: 5%   — Fase de crescimento
 * Mês 4+:  8%   — Parceiro consolidado
 */

/**
 * Calcula a comissão baseada na data de cadastro do estabelecimento.
 * @param {Date|string} cadastroData - Data de cadastro do estabelecimento
 * @returns {{ taxa: number, fase: string, descricao: string }}
 */
function calcularComissao(cadastroData) {
  const dataBase = new Date(cadastroData);
  const agora = new Date();

  // Diferença em milissegundos → dias → meses aproximados
  const diffMs = agora - dataBase;
  const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const mesAtivo = Math.floor(diffDias / 30) + 1; // mês 1, 2, 3...

  if (mesAtivo <= 1) {
    return {
      taxa: 0,
      mesAtivo,
      fase: 'Gratuito',
      descricao: 'Mês 1 — Boas-vindas, sem comissão',
      cor: '#00C853',
    };
  }

  if (mesAtivo <= 3) {
    return {
      taxa: 5,
      mesAtivo,
      fase: 'Fase 2',
      descricao: `Mês ${mesAtivo} — 5% por pedido`,
      cor: '#FF6D00',
    };
  }

  return {
    taxa: 8,
    mesAtivo,
    fase: 'Parceiro',
    descricao: `Mês ${mesAtivo} — 8% por pedido`,
    cor: '#2979FF',
  };
}

/**
 * Calcula os valores do split de um pedido.
 *
 * @param {object} params
 * @param {number} params.subtotal         - Valor dos itens (sem taxa de entrega)
 * @param {number} params.taxaEntrega      - Taxa de entrega (vai integralmente ao motoboy)
 * @param {Date}   params.cadastroData     - Data de cadastro do estabelecimento
 * @returns {{
 *   total: number,
 *   valorLojista: number,
 *   valorMotoboy: number,
 *   valorPlataforma: number,
 *   comissao: object
 * }}
 */
function calcularSplit(params) {
  const { subtotal, taxaEntrega, cadastroData } = params;
  const comissao = calcularComissao(cadastroData);

  const valorPlataforma = parseFloat((subtotal * comissao.taxa / 100).toFixed(2));
  const valorLojista    = parseFloat((subtotal - valorPlataforma).toFixed(2));
  const valorMotoboy    = parseFloat(taxaEntrega.toFixed(2));
  const total           = parseFloat((subtotal + taxaEntrega).toFixed(2));

  return {
    total,
    subtotal: parseFloat(subtotal.toFixed(2)),
    taxaEntrega: valorMotoboy,
    valorLojista,
    valorMotoboy,
    valorPlataforma,
    comissao,
  };
}

module.exports = { calcularComissao, calcularSplit };
