const express = require('express');
const router = express.Router();
const https = require('https');
const { supabaseAdmin } = require('../config/supabase');

// =============================================
// GET /api/oauth/mercadopago/url — Obter URL de Autenticação
// Recebe tipo (motoboy ou estabelecimento) e id (user.id)
// =============================================
router.get('/mercadopago/url', (req, res) => {
  const { tipo, id } = req.query;
  if (!['motoboy', 'estabelecimento'].includes(tipo) || !id) {
    return res.status(400).json({ error: 'Faltam parâmetros tipo ou id' });
  }

  const clientId = process.env.MP_CLIENT_ID;
  const redirectUri = `${process.env.BASE_URL}/api/oauth/mercadopago/callback`;
  
  // O parâmetro state carregará nosso contexto interno: "tipo|id_do_usuario"
  const state = Buffer.from(`${tipo}|${id}`).toString('base64');

  const mpUrl = `https://auth.mercadopago.com/authorization?client_id=${clientId}&response_type=code&platform_id=mp&redirect_uri=${redirectUri}&state=${state}`;
  
  res.json({ url: mpUrl });
});

// =============================================
// GET /api/oauth/mercadopago/callback — Retorno do MP
// =============================================
router.get('/mercadopago/callback', async (req, res, next) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.send('<h2>Erro na autorização do Mercado Pago. Tente novamente ou contate o suporte.</h2>');
  }

  if (!code || !state) {
    return res.status(400).send('Parâmetros inválidos');
  }

  try {
    const rawState = Buffer.from(state, 'base64').toString('ascii');
    const [tipo, userId] = rawState.split('|');

    if (!tipo || !userId) throw new Error('State malformado');

    const redirectUri = `${process.env.BASE_URL}/api/oauth/mercadopago/callback`;
    const clientId = process.env.MP_CLIENT_ID;
    const clientSecret = process.env.MP_CLIENT_SECRET;

    // Troca o auth code por access_token e refresh_token via API OAuth do Mercado Pago
    const tokenData = JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri
    });

    const options = {
      hostname: 'api.mercadopago.com',
      port: 443,
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': tokenData.length
      }
    };

    const tokens = await new Promise((resolve, reject) => {
      const reqMP = https.request(options, (resMP) => {
        let responseBody = '';
        resMP.on('data', (chunk) => responseBody += chunk);
        resMP.on('end', () => {
          if (resMP.statusCode >= 200 && resMP.statusCode < 300) {
            resolve(JSON.parse(responseBody));
          } else {
            reject(new Error(responseBody));
          }
        });
      });
      reqMP.on('error', (e) => reject(e));
      reqMP.write(tokenData);
      reqMP.end();
    });
    
    // tokens.access_token, tokens.refresh_token, tokens.user_id, tokens.public_key
    // Vamos salvar a public_key ou access_token no campo chave_pix (que já usamos pra guardar a credencial)
    // E o mp_user_id (para as regras de Split)
    const tabela = tipo === 'motoboy' ? 'motoboys' : 'estabelecimentos';

    const { error: dbError } = await supabaseAdmin
      .from(tabela)
      .update({
        mp_user_id: tokens.access_token
      })
      .eq('user_id', userId);

    if (dbError) throw dbError;

    // Sucesso, manda fechar a janela ou voltar pro front
    res.send(`
      <html>
        <body style="font-family:sans-serif; text-align:center; padding-top:50px;">
          <div style="font-size:48px;">✅</div>
          <h2>Conta do Mercado Pago conectada com sucesso!</h2>
          <p>Você já pode fechar esta página e voltar ao aplicativo.</p>
          <button onclick="window.close()" style="margin-top:20px; padding:10px 20px; font-size:16px; background:#00C853; color:#fff; border:none; border-radius:8px; cursor:pointer;">Voltar ao App</button>
        </body>
      </html>
    `);

  } catch (err) {
    console.error('[OAuth] Erro na troca de token MP:', err.message);
    res.send('<h2>Erro interno ao conectar a conta do Mercado Pago.</h2><p>' + err.message + '</p>');
  }
});

module.exports = router;
