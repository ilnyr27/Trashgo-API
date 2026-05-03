const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = () => `https://api.telegram.org/bot${TOKEN}`;

export const hasTelegram = () => !!TOKEN;

export async function sendTelegramOtp(chatId: number | string, code: string): Promise<boolean> {
  if (!TOKEN) return false;
  try {
    const res = await fetch(`${API()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🗑 *TrashGo*\n\nВаш код подтверждения: *${code}*\n\nКод действителен 10 минут. Никому не сообщайте его.`,
        parse_mode: 'Markdown',
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getBotUsername(): Promise<string | null> {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${API()}/getMe`);
    const data = await res.json() as { ok: boolean; result?: { username: string } };
    return data.ok ? (data.result?.username ?? null) : null;
  } catch {
    return null;
  }
}
