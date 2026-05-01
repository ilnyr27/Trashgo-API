const SMS_RU_API_ID = process.env.SMS_RU_API_ID;

export async function sendOtp(phone: string, code: string): Promise<boolean> {
  // Strip all non-digits and normalize to 7XXXXXXXXXX
  const digits = phone.replace(/\D/g, '');
  const normalized = digits.startsWith('7') ? digits : digits.startsWith('8') ? '7' + digits.slice(1) : '7' + digits;

  if (!SMS_RU_API_ID) {
    console.log(`[SMS DEV] ${phone} → code: ${code}`);
    return true;
  }

  try {
    const msg = `TrashGo: ваш код подтверждения ${code}. Не сообщайте его никому.`;
    const url = new URL('https://sms.ru/sms/send');
    url.searchParams.set('api_id', SMS_RU_API_ID);
    url.searchParams.set('to', normalized);
    url.searchParams.set('msg', msg);
    url.searchParams.set('json', '1');

    const res = await fetch(url.toString());
    if (!res.ok) {
      console.error(`[SMS] HTTP ${res.status}`);
      return false;
    }

    const data = await res.json() as { status: string; status_code?: number; sms?: Record<string, { status: string; status_code: number }> };

    if (data.status !== 'OK') {
      console.error(`[SMS] Error: status=${data.status} code=${data.status_code}`);
      return false;
    }

    console.log(`[SMS] Sent to ${normalized}`);
    return true;
  } catch (err) {
    console.error('[SMS] Exception:', err);
    return false;
  }
}
