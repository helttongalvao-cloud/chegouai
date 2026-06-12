// Z-API: conecta WhatsApp Business a qualquer número sem opt-in
// Env vars: ZAPI_INSTANCE_ID, ZAPI_TOKEN, ADMIN_WHATSAPP

const ZAPI_BASE = 'https://api.z-api.io';

function formatarNumero(num) {
  if (!num) return null;
  const digits = num.replace(/\D/g, '');
  if (digits.length < 10) return null;
  // Z-API espera número com DDI sem + (ex: 5511936217798)
  return digits.startsWith('55') ? digits : '55' + digits;
}

async function enviarWhatsApp(numero, mensagem) {
  const instanceId = process.env.ZAPI_INSTANCE_ID;
  const token = process.env.ZAPI_TOKEN;
  if (!instanceId || !token) {
    console.warn('[WhatsApp] ZAPI_INSTANCE_ID/TOKEN não configurados — mensagem não enviada');
    return;
  }
  const phone = formatarNumero(numero);
  if (!phone) return;
  try {
    const url = `${ZAPI_BASE}/instances/${instanceId}/token/${token}/send-text`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message: mensagem }),
    });
    const bodyText = await r.text().catch(() => '');
    if (r.ok) {
      console.log('[WhatsApp] ✓ Enviado para', phone.substring(0, 8) + '***');
    } else {
      console.error(`[WhatsApp] ✗ Erro Z-API HTTP ${r.status}:`, bodyText.slice(0, 200));
    }
  } catch (e) {
    console.error('[WhatsApp] ✗ Falha ao enviar:', e.message);
  }
}

async function alertarAdmin(mensagem) {
  const num = process.env.ADMIN_WHATSAPP;
  if (!num) return;
  await enviarWhatsApp(num, mensagem);
}

module.exports = { enviarWhatsApp, alertarAdmin };
