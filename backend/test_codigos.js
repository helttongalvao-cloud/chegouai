// Teste unitário — validação de códigos de coleta e entrega
// Rodar: node test_codigos.js

let passou = 0;
let falhou = 0;

function assert(descricao, condicao) {
  if (condicao) {
    console.log('  ✅ ' + descricao);
    passou++;
  } else {
    console.error('  ❌ FALHOU: ' + descricao);
    falhou++;
  }
}

// ── Lógica extraída de orders.js (sem DB) ────────────────────

function validarCodigoColeta(codigoRecebido, codigoSalvo) {
  if (!codigoRecebido || !/^\d{3}$/.test(String(codigoRecebido))) return { ok: false, erro: 'Código deve ter exatamente 3 dígitos' };
  if (!codigoSalvo) return { ok: false, erro: 'Pedido sem código de coleta' };
  if (codigoSalvo !== String(codigoRecebido)) return { ok: false, erro: 'Código incorreto. Confirme com o lojista.' };
  return { ok: true };
}

function validarCodigoEntrega(codigoRecebido, telefoneCliente) {
  if (!codigoRecebido || !/^\d{4}$/.test(codigoRecebido)) return { ok: false, erro: 'Informe os 4 últimos dígitos do telefone do cliente' };
  const tel = (telefoneCliente || '').replace(/\D/g, '');
  if (tel.length < 4 || tel.slice(-4) !== codigoRecebido) return { ok: false, erro: 'Código incorreto. Peça ao cliente os 4 últimos dígitos do telefone.' };
  return { ok: true };
}

// ── Testes: Código de Coleta ─────────────────────────────────
console.log('\n📦 Código de Coleta (3 dígitos)\n');

const r1 = validarCodigoColeta('456', '456');
assert('Código correto é aceito', r1.ok === true);

const r2 = validarCodigoColeta('999', '456');
assert('Código errado é rejeitado', r2.ok === false && r2.erro.includes('incorreto'));

const r3 = validarCodigoColeta('12', '456');
assert('Código com 2 dígitos é rejeitado', r3.ok === false);

const r4 = validarCodigoColeta('1234', '1234');
assert('Código com 4 dígitos é rejeitado (deve ter 3)', r4.ok === false);

const r5 = validarCodigoColeta('', '456');
assert('Código vazio é rejeitado', r5.ok === false);

const r6 = validarCodigoColeta('abc', '456');
assert('Código com letras é rejeitado', r6.ok === false);

const r7 = validarCodigoColeta('000', '000');
assert('Código 000 é aceito quando correto', r7.ok === true);

// ── Testes: Código de Entrega ─────────────────────────────────
console.log('\n🏠 Código de Entrega (4 últimos dígitos do telefone)\n');

const e1 = validarCodigoEntrega('4567', '(92) 99999-4567');
assert('Últimos 4 dígitos corretos são aceitos', e1.ok === true);

const e2 = validarCodigoEntrega('1234', '(92) 99999-4567');
assert('Dígitos errados são rejeitados — status não muda', e2.ok === false);

const e3 = validarCodigoEntrega('4567', '92999994567');
assert('Telefone sem formatação também funciona', e3.ok === true);

const e4 = validarCodigoEntrega('123', '(92) 99999-4567');
assert('Código com 3 dígitos é rejeitado (deve ter 4)', e4.ok === false);

const e5 = validarCodigoEntrega('', '(92) 99999-4567');
assert('Código vazio é rejeitado', e5.ok === false);

const e6 = validarCodigoEntrega('4567', null);
assert('Pedido sem telefone rejeita qualquer código', e6.ok === false);

const e7 = validarCodigoEntrega('4567', '(92) 99999-4567');
assert('Não altera o status do pedido com código errado', e2.ok === false && e7.ok === true);

// ── Testes: Taxa de entrega por distância ─────────────────────
console.log('\n🛵 Taxa de entrega por distância\n');

function calcularTaxaEntrega(distanciaKm) {
  if (distanciaKm <= 1.5) return 2.00;
  if (distanciaKm <= 3.0) return 2.50;
  if (distanciaKm <= 4.5) return 3.00;
  if (distanciaKm <= 6.0) return 3.50;
  return 4.00;
}

assert('0,1 km → R$ 2,00', calcularTaxaEntrega(0.1) === 2.00);
assert('1,5 km exato → R$ 2,00', calcularTaxaEntrega(1.5) === 2.00);
assert('1,6 km → R$ 2,50', calcularTaxaEntrega(1.6) === 2.50);
assert('3,0 km exato → R$ 2,50', calcularTaxaEntrega(3.0) === 2.50);
assert('3,1 km → R$ 3,00', calcularTaxaEntrega(3.1) === 3.00);
assert('4,5 km exato → R$ 3,00', calcularTaxaEntrega(4.5) === 3.00);
assert('4,6 km → R$ 3,50', calcularTaxaEntrega(4.6) === 3.50);
assert('6,0 km exato → R$ 3,50', calcularTaxaEntrega(6.0) === 3.50);
assert('6,1 km → R$ 4,00', calcularTaxaEntrega(6.1) === 4.00);
assert('10 km → R$ 4,00', calcularTaxaEntrega(10) === 4.00);

// ── Resultado ─────────────────────────────────────────────────
console.log('\n─────────────────────────────────────');
console.log('Resultado: ' + passou + ' passou, ' + falhou + ' falhou');
if (falhou === 0) {
  console.log('✅ Todos os testes passaram!\n');
  process.exit(0);
} else {
  console.error('❌ ' + falhou + ' teste(s) falharam.\n');
  process.exit(1);
}
