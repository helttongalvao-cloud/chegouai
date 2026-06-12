const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireRole } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');
const { enviarWhatsApp, alertarAdmin } = require('../services/whatsapp');

const router = express.Router();

// =============================================
// Score de triagem (0–100)
// =============================================
function calcularScore(d) {
  let s = 0;
  if (d.disponivel_noite)                                   s += 15;
  if (d.horas_por_dia === '6-8h' || d.horas_por_dia === 'mais_8h') s += 20;
  else if (d.horas_por_dia === '4-6h')                      s += 10;
  if (d.experiencia_anterior)                               s += 20;
  if (d.tem_smartphone)                                     s += 20;
  if (d.conhece_ruas)                                       s += 15;
  if (!d.tem_restricao)                                     s += 10;
  return s;
}

// =============================================
// POST /api/candidaturas/motoboy — público
// =============================================
router.post('/motoboy', [
  body('nome').trim().notEmpty().withMessage('Nome obrigatório'),
  body('cpf').trim().notEmpty(),
  body('nascimento').isDate(),
  body('whatsapp').trim().notEmpty(),
  body('cidade').trim().notEmpty(),
  body('tipo_veiculo').isIn(['moto','bicicleta','carro']),
  body('chave_pix').trim().notEmpty(),
  body('horas_por_dia').notEmpty(),
], async (req, res, next) => {
  try {
    const erros = validationResult(req);
    if (!erros.isEmpty()) return res.status(400).json({ error: erros.array()[0].msg });

    const d = req.body;
    const score = calcularScore(d);

    const { data, error } = await supabaseAdmin
      .from('motoboy_candidatos')
      .insert({
        nome: d.nome?.trim(),
        cpf: d.cpf?.replace(/\D/g, ''),
        nascimento: d.nascimento,
        email: d.email?.trim() || null,
        whatsapp: d.whatsapp?.replace(/\D/g, ''),
        cidade: d.cidade?.trim(),
        tipo_veiculo: d.tipo_veiculo,
        placa: d.placa?.trim() || null,
        chave_pix: d.chave_pix?.trim(),
        banco: d.banco?.trim() || null,
        disponivel_noite: !!d.disponivel_noite,
        horas_por_dia: d.horas_por_dia,
        experiencia_anterior: !!d.experiencia_anterior,
        experiencia_detalhes: d.experiencia_detalhes?.trim() || null,
        motivo_chegou: d.motivo_chegou?.trim() || null,
        tem_smartphone: d.tem_smartphone !== false,
        conhece_ruas: d.conhece_ruas !== false,
        tem_restricao: !!d.tem_restricao,
        restricao_detalhes: d.restricao_detalhes?.trim() || null,
        doc_cnh_frente: d.doc_cnh_frente || null,
        doc_cnh_verso: d.doc_cnh_verso || null,
        doc_crlv: d.doc_crlv || null,
        doc_comprovante: d.doc_comprovante || null,
        doc_selfie_cnh: d.doc_selfie_cnh || null,
        score,
        status: 'pendente',
      })
      .select('id')
      .single();

    if (error) throw error;

    res.json({ ok: true, id: data.id, score });

    // Alertar admin (fire-and-forget)
    const scoreMensagem = score >= 70 ? '🟢 Alto' : score >= 45 ? '🟡 Médio' : '🔴 Baixo';
    alertarAdmin(
      `🛵 *Nova candidatura de motoboy!*\n\n` +
      `*Nome:* ${d.nome}\n` +
      `*Cidade:* ${d.cidade}\n` +
      `*Veículo:* ${d.tipo_veiculo}\n` +
      `*Score:* ${score}/100 (${scoreMensagem})\n\n` +
      `Acesse o painel para aprovar ou reprovar.`
    ).catch(() => {});
  } catch (e) { next(e); }
});

// =============================================
// POST /api/candidaturas/motoboy/upload-doc — público
// =============================================
router.post('/motoboy/upload-doc', async (req, res, next) => {
  try {
    const { base64, contentType = 'image/jpeg', tipo } = req.body;
    if (!base64) return res.status(400).json({ error: 'base64 obrigatório' });

    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(contentType)) return res.status(400).json({ error: 'Tipo não permitido' });

    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'Imagem muito grande (máx 10MB)' });

    const ext = contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1];
    const filename = `doc_${tipo || 'doc'}_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

    const { error } = await supabaseAdmin.storage
      .from('produtos')
      .upload(filename, buffer, { contentType, upsert: false });
    if (error) throw error;

    const { data: { publicUrl } } = supabaseAdmin.storage.from('produtos').getPublicUrl(filename);
    res.json({ url: publicUrl, tipo });
  } catch (e) { next(e); }
});

// =============================================
// GET /api/candidaturas — admin
// =============================================
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { status } = req.query;
    let q = supabaseAdmin
      .from('motoboy_candidatos')
      .select('*')
      .order('criado_em', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// =============================================
// GET /api/candidaturas/:id — admin
// =============================================
router.get('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('motoboy_candidatos')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// =============================================
// POST /api/candidaturas/:id/aprovar — admin
// =============================================
router.post('/:id/aprovar', requireRole('admin'), async (req, res, next) => {
  try {
    const { obs } = req.body;
    const { data: cand, error: errBusca } = await supabaseAdmin
      .from('motoboy_candidatos')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (errBusca || !cand) return res.status(404).json({ error: 'Candidato não encontrado' });

    const { error } = await supabaseAdmin
      .from('motoboy_candidatos')
      .update({ status: 'aprovado', aprovado_em: new Date().toISOString(), obs_admin: obs || null })
      .eq('id', req.params.id);
    if (error) throw error;

    // WhatsApp de boas-vindas
    if (cand.whatsapp) {
      await enviarWhatsApp(cand.whatsapp,
        `🎉 *Parabéns, ${cand.nome.split(' ')[0]}!*\n\n` +
        `Sua candidatura no *Chegô* foi aprovada! Você já pode começar a fazer entregas.\n\n` +
        `📱 *Acesse o app:*\nchegouaiapp.com.br/app\n\n` +
        `Faça login com o WhatsApp cadastrado e ative sua disponibilidade.\n\n` +
        `Bem-vindo ao time! 🛵`
      );
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// =============================================
// POST /api/candidaturas/:id/reprovar — admin
// =============================================
router.post('/:id/reprovar', requireRole('admin'), async (req, res, next) => {
  try {
    const { obs } = req.body;
    const { data: cand, error: errBusca } = await supabaseAdmin
      .from('motoboy_candidatos')
      .select('id, nome, whatsapp')
      .eq('id', req.params.id)
      .single();
    if (errBusca || !cand) return res.status(404).json({ error: 'Candidato não encontrado' });

    const { error } = await supabaseAdmin
      .from('motoboy_candidatos')
      .update({ status: 'reprovado', reprovado_em: new Date().toISOString(), obs_admin: obs || null })
      .eq('id', req.params.id);
    if (error) throw error;

    if (cand.whatsapp) {
      await enviarWhatsApp(cand.whatsapp,
        `Olá, ${cand.nome.split(' ')[0]}! 👋\n\n` +
        `Obrigado pelo interesse em trabalhar com o *Chegô*.\n\n` +
        `Após análise do seu perfil, não conseguimos avançar com sua candidatura neste momento.\n\n` +
        `Agradecemos sua participação e desejamos muito sucesso! 🙏`
      );
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// =============================================
// POST /api/candidaturas/lojista — público
// =============================================
router.post('/lojista', [
  body('nome').trim().notEmpty().withMessage('Nome obrigatório'),
  body('whatsapp').trim().notEmpty().withMessage('WhatsApp obrigatório'),
  body('cidade').trim().notEmpty().withMessage('Cidade obrigatória'),
  body('tipo_negocio').trim().notEmpty().withMessage('Tipo de negócio obrigatório'),
], async (req, res, next) => {
  try {
    const erros = validationResult(req);
    if (!erros.isEmpty()) return res.status(400).json({ error: erros.array()[0].msg });

    const d = req.body;
    const { data, error } = await supabaseAdmin
      .from('lojista_candidatos')
      .insert({
        nome: d.nome?.trim(),
        whatsapp: d.whatsapp?.replace(/\D/g, ''),
        cidade: d.cidade?.trim(),
        tipo_negocio: d.tipo_negocio?.trim(),
        descricao: d.descricao?.trim() || null,
        status: 'novo',
      })
      .select('id')
      .single();

    if (error) {
      console.error('[Candidaturas/lojista] Supabase error:', JSON.stringify(error));
      // Expõe erro real temporariamente para diagnóstico
      return res.status(500).json({ error: error.message || JSON.stringify(error) });
    }

    // Responde imediatamente — WhatsApp é fire-and-forget
    res.json({ ok: true, id: data.id });

    // Alerta admin (não bloqueia resposta)
    alertarAdmin(
      `🏪 *Novo interesse de lojista!*\n\n` +
      `*Nome:* ${d.nome}\n` +
      `*Cidade:* ${d.cidade}\n` +
      `*Negócio:* ${d.tipo_negocio}\n` +
      `${d.descricao ? '*Descrição:* ' + d.descricao + '\n' : ''}` +
      `*WhatsApp:* ${d.whatsapp}\n\n` +
      `Acesse o painel para entrar em contato.`
    ).catch(() => {});

    // Confirmação para o lojista
    if (d.whatsapp) {
      enviarWhatsApp(d.whatsapp,
        `Olá, ${d.nome.split(' ')[0]}! 👋\n\n` +
        `Recebemos seu interesse em abrir sua loja no *Chegô*!\n\n` +
        `Nossa equipe vai entrar em contato em breve pelo WhatsApp para agendar uma conversa.\n\n` +
        `Aguarde — vai ser rápido! 🚀`
      ).catch(() => {});
    }
  } catch (e) { next(e); }
});

// =============================================
// GET /api/candidaturas/lojistas — admin
// =============================================
router.get('/lojistas', requireRole('admin'), async (req, res, next) => {
  try {
    const { status } = req.query;
    let q = supabaseAdmin
      .from('lojista_candidatos')
      .select('*')
      .order('criado_em', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// =============================================
// POST /api/candidaturas/lojistas/:id/contatar — admin
// =============================================
router.post('/lojistas/:id/contatar', requireRole('admin'), async (req, res, next) => {
  try {
    const { obs } = req.body;
    const { error } = await supabaseAdmin
      .from('lojista_candidatos')
      .update({ status: 'contatado', obs_admin: obs || null })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// =============================================
// POST /api/candidaturas/lojistas/:id/reprovar — admin
// =============================================
router.post('/lojistas/:id/reprovar', requireRole('admin'), async (req, res, next) => {
  try {
    const { obs } = req.body;
    const { data: cand, error: errBusca } = await supabaseAdmin
      .from('lojista_candidatos')
      .select('nome, whatsapp')
      .eq('id', req.params.id)
      .single();
    if (errBusca || !cand) return res.status(404).json({ error: 'Candidato não encontrado' });

    const { error } = await supabaseAdmin
      .from('lojista_candidatos')
      .update({ status: 'reprovado', reprovado_em: new Date().toISOString(), obs_admin: obs || null })
      .eq('id', req.params.id);
    if (error) throw error;

    if (cand.whatsapp) {
      await enviarWhatsApp(cand.whatsapp,
        `Olá, ${cand.nome.split(' ')[0]}! 👋\n\n` +
        `Agradecemos seu interesse no *Chegô*.\n\n` +
        `Infelizmente, não conseguimos prosseguir com a parceria no momento.\n\n` +
        `Obrigado e muito sucesso! 🙏`
      );
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
