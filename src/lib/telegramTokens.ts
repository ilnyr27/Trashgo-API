// In-memory store for Telegram OTP tokens
// Maps short random token → { phone, code, exp }
// Avoids circular imports between auth.ts and telegram.ts
export const telegramTokens = new Map<string, { phone: string; code: string; exp: number }>();

export function cleanupTelegramTokens() {
  const now = Date.now();
  for (const [key, val] of telegramTokens) {
    if (val.exp < now) telegramTokens.delete(key);
  }
}
