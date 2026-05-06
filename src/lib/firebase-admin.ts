// No static import — firebase-admin is loaded lazily to avoid ESM startup crash
// (static `import admin from 'firebase-admin'` in an ESM project crashes the process on load)

let _admin: any = null;

async function getAdmin() {
  if (_admin) return _admin;
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) return null;
  try {
    const mod = await import('firebase-admin');
    const admin = mod.default ?? (mod as any);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: FIREBASE_PROJECT_ID,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
      console.log('✓ Firebase Admin initialized');
    }
    _admin = admin;
    return _admin;
  } catch (e: any) {
    console.warn('[Firebase Admin] failed to load:', e.message);
    return null;
  }
}

export const isFirebaseAdminReady = () => !!process.env.FIREBASE_PROJECT_ID;

export async function verifyFirebaseIdToken(idToken: string): Promise<string | null> {
  const admin = await getAdmin();
  if (!admin) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.phone_number ?? null;
  } catch {
    return null;
  }
}

export async function sendPushNotification(
  fcmToken: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<boolean> {
  const admin = await getAdmin();
  if (!admin) return false;
  try {
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data: data ?? {},
      webpush: {
        notification: { icon: '/icon-192.png', badge: '/icon-72.png', vibrate: [200, 100, 200] },
        fcmOptions: { link: data?.orderId ? `/order/${data.orderId}` : '/' },
      },
    });
    return true;
  } catch (e: any) {
    if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-registration-token') {
      console.warn('[FCM] Stale token, caller should remove it');
    } else {
      console.error('[FCM] Push failed:', e.message);
    }
    return false;
  }
}
