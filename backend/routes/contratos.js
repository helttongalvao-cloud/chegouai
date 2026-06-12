const express = require('express');
const { requireRole } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');

const router = express.Router();

const VERSAO_ATUAL = '1.0';

// =============================================
// Texto dos contratos
// =============================================
const CONTRATOS = {
  motoboy: {
    titulo: 'Contrato de Prestação de Serviços de Entrega',
    versao: VERSAO_ATUAL,
    texto: `CONTRATO DE PRESTAÇÃO DE SERVIÇOS AUTÔNOMOS DE ENTREGA

Plataforma Chegô ("Plataforma") e o Entregador Parceiro ("Entregador"), identificado no ato da assinatura eletrônica, celebram o presente contrato nas seguintes condições:

1. OBJETO
O presente contrato tem por objeto a prestação de serviços de entrega de mercadorias pelo Entregador, de forma autônoma e independente, intermediada pela Plataforma Chegô.

2. NATUREZA DO VÍNCULO
2.1. O Entregador presta serviços como profissional autônomo, não existindo qualquer vínculo de emprego, subordinação habitual ou exclusividade entre as partes.
2.2. O Entregador é livre para aceitar ou recusar solicitações de entrega, bem como para definir sua disponibilidade e horários de trabalho.
2.3. O Entregador é responsável por suas próprias despesas operacionais, incluindo combustível, manutenção do veículo, seguro e quaisquer outros custos relativos à atividade.

3. REMUNERAÇÃO
3.1. O Entregador receberá por cada entrega concluída o valor definido pela tabela vigente da Plataforma, podendo variar conforme distância, tipo de serviço e demanda.
3.2. Os repasses serão realizados via Pix para a chave cadastrada, conforme periodicidade definida pela Plataforma.
3.3. A Plataforma poderá atualizar a tabela de valores mediante aviso prévio de 7 (sete) dias.

4. OBRIGAÇÕES DO ENTREGADOR
4.1. Manter documentação do veículo regularizada (CNH, CRLV, seguro).
4.2. Realizar as entregas com pontualidade, cuidado e urbanidade.
4.3. Manter o aplicativo atualizado e o celular carregado durante os períodos de disponibilidade.
4.4. Comunicar imediatamente qualquer acidente, extravio ou dano a mercadorias.
4.5. Zelar pela imagem da Plataforma perante clientes e estabelecimentos.
4.6. Não utilizar a plataforma sob efeito de álcool, entorpecentes ou em condições que comprometam a segurança.

5. RESPONSABILIDADES
5.1. O Entregador responde civil e criminalmente por danos causados a terceiros, mercadorias e veículos durante a prestação de serviços.
5.2. A Plataforma não se responsabiliza por acidentes, multas, infrações de trânsito ou danos causados pelo Entregador.
5.3. Em caso de dano comprovado a mercadorias por negligência do Entregador, o valor do dano poderá ser descontado dos repasses pendentes.

6. DADOS PESSOAIS E PRIVACIDADE
6.1. Os dados do Entregador serão tratados em conformidade com a LGPD (Lei 13.709/2018).
6.2. A Plataforma poderá compartilhar nome e avaliação do Entregador com estabelecimentos e clientes para fins operacionais.
6.3. A localização do Entregador será coletada somente durante entregas ativas ou quando o Entregador estiver disponível no aplicativo.

7. VIGÊNCIA E RESCISÃO
7.1. O contrato tem prazo indeterminado, iniciando-se na data da assinatura eletrônica.
7.2. Qualquer das partes pode rescindir o contrato a qualquer momento, sem necessidade de aviso prévio, bastando comunicar pelo aplicativo ou canais oficiais.
7.3. A Plataforma poderá suspender ou encerrar o acesso do Entregador imediatamente em caso de violação dos termos deste contrato.

8. ASSINATURA ELETRÔNICA
A assinatura eletrônica realizada no aplicativo, com registro de nome completo, data, hora e endereço IP, tem validade jurídica nos termos do art. 10, §2º da MP 2.200-2/2001 e da Lei 14.063/2020.

Ao assinar eletronicamente, o Entregador declara ter lido, compreendido e concordado integralmente com os termos deste contrato.`,
  },

  lojista: {
    titulo: 'Contrato de Parceria Comercial',
    versao: VERSAO_ATUAL,
    texto: `CONTRATO DE PARCERIA COMERCIAL PARA USO DE PLATAFORMA DE DELIVERY

Plataforma Chegô ("Plataforma") e o Estabelecimento Comercial Parceiro ("Lojista"), identificado no ato da assinatura eletrônica, celebram o presente contrato nas seguintes condições:

1. OBJETO
O presente contrato tem por objeto a parceria comercial para disponibilização do Estabelecimento na plataforma de delivery Chegô, permitindo ao Lojista receber pedidos e ter suas entregas intermediadas pela Plataforma.

2. FUNCIONAMENTO DA PLATAFORMA
2.1. O Lojista terá acesso a um painel de gerenciamento para cadastro de produtos, recebimento e gerenciamento de pedidos.
2.2. Os pedidos recebidos através da Plataforma serão pagos pelo cliente via meios digitais (Pix, cartão de crédito/débito) processados pela Plataforma.
2.3. A Plataforma intermediará a contratação de entregadores autônomos para a realização das entregas.

3. COMISSÃO E REPASSES
3.1. A Plataforma reterá uma comissão percentual por pedido entregue e concluído, conforme tabela comunicada no momento do cadastro.
3.2. O repasse do saldo líquido (valor do pedido menos comissão e taxa de entrega) será realizado via Pix, conforme periodicidade definida pela Plataforma.
3.3. A Plataforma poderá alterar a comissão mediante aviso prévio de 15 (quinze) dias.
3.4. Pedidos cancelados não geram comissão; eventuais estornos serão de responsabilidade compartilhada conforme o motivo do cancelamento.

4. OBRIGAÇÕES DO LOJISTA
4.1. Manter o cardápio atualizado, com preços, descrições e disponibilidade corretos.
4.2. Confirmar pedidos em até 10 (dez) minutos do recebimento; atrasos recorrentes poderão resultar em suspensão.
4.3. Preparar os pedidos com qualidade e dentro do prazo estimado informado ao cliente.
4.4. Manter documentação fiscal e sanitária do estabelecimento em dia.
4.5. Não praticar preços diferentes dentro e fora da plataforma para os mesmos produtos, salvo promoções exclusivas.
4.6. Comunicar à Plataforma qualquer alteração no horário de funcionamento, encerramento temporário ou definitivo.

5. RESPONSABILIDADES
5.1. O Lojista é integralmente responsável pela qualidade, segurança alimentar e conformidade dos produtos vendidos.
5.2. Reclamações de clientes relacionadas à qualidade do produto são de responsabilidade exclusiva do Lojista.
5.3. A Plataforma não se responsabiliza por problemas relativos à produção, embalagem, higiene ou conformidade dos produtos.
5.4. Reclamações relacionadas à entrega serão analisadas caso a caso entre a Plataforma e o Lojista.

6. PROPRIEDADE INTELECTUAL E IMAGEM
6.1. O Lojista autoriza a Plataforma a utilizar nome, logotipo, fotos e descrição do estabelecimento para fins de divulgação na plataforma.
6.2. O Lojista não poderá usar a marca Chegô para divulgação própria sem autorização prévia por escrito.

7. DADOS PESSOAIS E PRIVACIDADE
7.1. Os dados do Lojista e de seus clientes serão tratados em conformidade com a LGPD (Lei 13.709/2018).
7.2. O Lojista declara ter ciência das obrigações legais referentes ao tratamento de dados de seus clientes.

8. VIGÊNCIA E RESCISÃO
8.1. O contrato tem prazo indeterminado, iniciando-se na data da assinatura eletrônica.
8.2. Qualquer das partes pode rescindir o contrato mediante aviso prévio de 30 (trinta) dias, salvo em casos de violação contratual grave.
8.3. A Plataforma poderá suspender ou encerrar o acesso do Lojista imediatamente em caso de violação dos termos, práticas fraudulentas ou danos a clientes.

9. ASSINATURA ELETRÔNICA
A assinatura eletrônica realizada no aplicativo, com registro de nome completo, data, hora e endereço IP, tem validade jurídica nos termos do art. 10, §2º da MP 2.200-2/2001 e da Lei 14.063/2020.

Ao assinar eletronicamente, o Lojista declara ter lido, compreendido e concordado integralmente com os termos deste contrato.`,
  },
};

// =============================================
// GET /api/contratos/texto/:tipo — público (texto do contrato)
// =============================================
router.get('/texto/:tipo', (req, res) => {
  const c = CONTRATOS[req.params.tipo];
  if (!c) return res.status(404).json({ error: 'Tipo inválido' });
  res.json({ titulo: c.titulo, versao: c.versao, texto: c.texto });
});

// =============================================
// GET /api/contratos/meu — autenticado (verificar se assinou)
// =============================================
router.get('/meu', requireRole('motoboy', 'estabelecimento', 'admin'), async (req, res, next) => {
  try {
    const perfil = req.user.profile.perfil;
    const tipo = perfil === 'motoboy' ? 'motoboy' : 'lojista';
    const { data } = await supabaseAdmin
      .from('contratos')
      .select('id, tipo, versao, assinado_em, nome_assinante')
      .eq('user_id', req.user.id)
      .eq('tipo', tipo)
      .eq('versao', VERSAO_ATUAL)
      .maybeSingle();
    res.json({ assinou: !!data, contrato: data || null });
  } catch (e) { next(e); }
});

// =============================================
// POST /api/contratos/assinar — autenticado
// =============================================
router.post('/assinar', requireRole('motoboy', 'estabelecimento'), async (req, res, next) => {
  try {
    const { nome_assinante } = req.body;
    if (!nome_assinante || nome_assinante.trim().length < 3) {
      return res.status(400).json({ error: 'Nome completo obrigatório' });
    }

    const perfil = req.user.profile.perfil;
    const tipo = perfil === 'motoboy' ? 'motoboy' : 'lojista';

    // Idempotente: não duplica assinatura
    const { data: existente } = await supabaseAdmin
      .from('contratos')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('tipo', tipo)
      .eq('versao', VERSAO_ATUAL)
      .maybeSingle();

    if (existente) return res.json({ ok: true, id: existente.id });

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;

    const { data, error } = await supabaseAdmin
      .from('contratos')
      .insert({
        user_id: req.user.id,
        tipo,
        versao: VERSAO_ATUAL,
        nome_assinante: nome_assinante.trim(),
        ip,
      })
      .select('id, assinado_em')
      .single();

    if (error) throw error;
    res.json({ ok: true, id: data.id, assinado_em: data.assinado_em });
  } catch (e) { next(e); }
});

// =============================================
// GET /api/contratos/usuario/:userId — admin
// =============================================
router.get('/usuario/:userId', requireRole('admin'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('contratos')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('assinado_em', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { next(e); }
});

module.exports = router;
