const SMS_RU_API_ID = process.env.SMS_RU_API_ID;
const SMSGATEWAY_LOGIN = process.env.SMSGATEWAY_LOGIN;
const SMSGATEWAY_PASSWORD = process.env.SMSGATEWAY_PASSWORD;
const SMSGATEWAY_DEVICE_ID = process.env.SMSGATEWAY_DEVICE_ID;
const HTTPSMS_API_KEY = process.env.HTTPSMS_API_KEY;
const HTTPSMS_SENDER = process.env.HTTPSMS_SENDER; // your Android phone number e.g. +79001234567

export const hasSms = () => !!(
  HTTPSMS_API_KEY && HTTPSMS_SENDER ||
  SMS_RU_API_ID ||
  SMSGATEWAY_LOGIN && SMSGATEWAY_PASSWORD && SMSGATEWAY_DEVICE_ID
);

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('7')) return digits;
  if (digits.startsWith('8')) return '7' + digits.slice(1);
  return '7' + digits;
}

// HttpSMS.com — free 200 SMS/month, your Android phone sends via Russian SIM
async function sendViaHttpSms(phone: string, code: string): Promise<boolean> {
  const res = await fetch('https://api.httpsms.com/v1/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': HTTPSMS_API_KEY! },
    body: JSON.stringify({
      from: HTTPSMS_SENDER!,
      to: '+' + normalizePhone(phone),
      content: `TrashGo: код ${code}. Никому не сообщайте.`,
    }),
  });
  if (!res.ok) { console.error('[SMS] HttpSMS HTTP', res.status, await res.text()); return false; }
  const data = await res.json() as { data?: { id: string } };
  return !!data.data?.id;
}

// SMSGateway.me — free 50 SMS/month
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

// SMS.ru — paid fallback (~0.67₽/SMS), 100% reliable in Russia
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
    if (HTTPSMS_API_KEY && HTTPSMS_SENDER) return await sendViaHttpSms(phone, code);
    if (SMSGATEWAY_LOGIN && SMSGATEWAY_PASSWORD && SMSGATEWAY_DEVICE_ID) return await sendViaSmsGateway(phone, code);
    if (SMS_RU_API_ID) return await sendViaSmsRu(phone, code);
    return false;
  } catch (err) {
    console.error('[SMS] Exception:', err);
    return false;
  }
}
