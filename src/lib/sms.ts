const SMS_RU_API_ID = process.env.SMS_RU_API_ID;
const SMSGATEWAY_LOGIN = process.env.SMSGATEWAY_LOGIN;
const SMSGATEWAY_PASSWORD = process.env.SMSGATEWAY_PASSWORD;
const SMSGATEWAY_DEVICE_ID = process.env.SMSGATEWAY_DEVICE_ID;

export const hasSms = () =>
  !!(SMS_RU_API_ID || (SMSGATEWAY_LOGIN && SMSGATEWAY_PASSWORD && SMSGATEWAY_DEVICE_ID));

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('7')) return digits;
  if (digits.startsWith('8')) return '7' + digits.slice(1);
  return '7' + digits;
}

async function sendViaSmsGateway(phone: string, code: string): Promise<boolean> {
  const credentials = Buffer.from(`${SMSGATEWAY_LOGIN}:${SMSGATEWAY_PASSWORD}`).toString('base64');
  const res = await fetch('https://smsgateway.me/api/v4/message/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${credentials}` },
    body: JSON.stringify({
      phone_number: '+' + normalizePhone(phone),
      message: `TrashGo: код ${code}. Никому не сообщайте.`,
      device_id: Number(SMSGATEWAY_DEVICE_ID),
    }),
  });
  if (!res.ok) { console.error('[SMS] SMSGateway HTTP', res.status); return false; }
  const data = await res.json() as { id?: number };
  return !!data.id;
}

async function sendViaSmsRu(phone: string, code: string): Promise<boolean> {
  const url = new URL('https://sms.ru/sms/send');
  url.searchParams.set('api_id', SMS_RU_API_ID!);
  url.searchParams.set('to', normalizePhone(phone));
  url.searchParams.set('msg', `TrashGo: ваш код подтверждения ${code}. Не сообщайте его никому.`);
  url.searchParams.set('json', '1');
  const res = await fetch(url.toString());
  if (!res.ok) { console.error('[SMS] SMS.ru HTTP', res.status); return false; }
  const data = await res.json() as { status: string; status_code?: number };
  if (data.status !== 'OK') { console.error('[SMS] SMS.ru error', data.status_code); return false; }
  return true;
}

export async function sendOtp(phone: string, code: string): Promise<boolean> {
  if (!hasSms()) {
    console.log(`[SMS DEV] ${phone} → ${code}`);
    return true;
  }
  try {
    // SMSGateway.me: free tier, uses Android phone with Russian SIM
    if (SMSGATEWAY_LOGIN && SMSGATEWAY_PASSWORD && SMSGATEWAY_DEVICE_ID) {
      return await sendViaSmsGateway(phone, code);
    }
    // SMS.ru: paid fallback (~0.67₽/SMS)
    if (SMS_RU_API_ID) {
      return await sendViaSmsRu(phone, code);
    }
    return false;
  } catch (err) {
    console.error('[SMS] Exception:', err);
    return false;
  }
}
