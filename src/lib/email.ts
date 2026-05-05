import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export const isEmailEnabled = () => !!process.env.RESEND_API_KEY;

export async function sendEmailOtp(to: string, code: string): Promise<void> {
  if (!resend) {
    console.log(`[EMAIL OTP DEV] ${to}: ${code}`);
    return;
  }

  const from = process.env.RESEND_FROM_EMAIL ?? 'TrashGo <onboarding@resend.dev>';

  await resend.emails.send({
    from,
    to,
    subject: `${code} — код подтверждения TrashGo`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:420px;margin:0 auto;padding:2rem;background:#f9fafb;border-radius:12px">
        <h2 style="color:#111827;margin:0 0 0.5rem">🗑️ TrashGo</h2>
        <p style="color:#6b7280;margin:0 0 1.5rem;font-size:0.95rem">Ваш код подтверждения:</p>
        <div style="background:#fff;border:2px solid #e5e7eb;border-radius:12px;padding:1.5rem;text-align:center;margin-bottom:1.5rem">
          <span style="font-size:2.5rem;font-weight:800;letter-spacing:0.5rem;color:#111827">${code}</span>
        </div>
        <p style="color:#9ca3af;font-size:0.8rem;margin:0">Код действителен 10 минут. Не сообщайте его никому.</p>
      </div>
    `,
  });
}
