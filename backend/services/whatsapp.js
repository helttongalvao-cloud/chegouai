const twilio = require('twilio');

let client = null;

if (process.env.TWILIO_SID && process.env.TWILIO_AUTH_TOKEN) {
  client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log('[WhatsApp] Twilio inicializado');
} else {
  console.warn('[WhatsApp] TWILIO_SID/AUTH_TOKEN não configurados — alertas WhatsApp desativados');
}

function formatarNumero(num) {
  if (!num) return null;
  const digits = num.replace(/\D/g, '');
  if (digits.length < 10) return null;
  return 'whatsapp:+55' + digits;
}

async function enviarWhatsApp(numero, mensagem) {
  if (!client) return;
  const to = formatarNumero(numero);
  if (!to) return;
  try {
    await client.messages.create({
      from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_FROM,
      to,
      body: mensagem,
    });
    console.log('[WhatsApp] ✓ Enviado para', to.substring(0, 20));
  } catch (e) {
    console.error('[WhatsApp] ✗ Erro ao enviar para', to, ':', e.message);
  }
}

async function alertarAdmin(mensagem) {
  const num = process.env.ADMIN_WHATSAPP;
  if (!num) return;
  await enviarWhatsApp(num, mensagem);
}

module.exports = { enviarWhatsApp, alertarAdmin };
