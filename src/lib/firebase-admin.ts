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
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
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
export const isStorageConfigured = () => !!process.env.FIREBASE_STORAGE_BUCKET && !!process.env.FIREBASE_PROJECT_ID;

/**
 * Uploads a base64-encoded file to Firebase Storage and returns its public URL.
 * Returns null if storage is not configured or on error.
 */
export async function uploadBase64ToStorage(
  base64: string,
  mimeType: string,
  folder: string,
): Promise<string | null> {
  const admin = await getAdmin();
  if (!admin || !process.env.FIREBASE_STORAGE_BUCKET) return null;
  try {
    const { nanoid } = await import('nanoid');
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const filename = `${folder}/${nanoid(16)}.${ext}`;
    const bucket = admin.storage().bucket();
    const file = bucket.file(filename);
    const buffer = Buffer.from(base64, 'base64');
    await file.save(buffer, { metadata: { contentType: mimeType } });
    try { await file.makePublic(); } catch { /* uniform bucket-level access — public read via IAM */ }
    return `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${filename}`;
  } catch (e: any) {
    console.error('[Storage] Upload failed:', e.message);
    return null;
  }
}

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
  // Derive a tag/group key: order-specific notifications replace each other per order
  const tag = data?.orderId ? `order-${data.orderId}` : data?.type ?? 'trashgo';
  try {
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data: data ?? {},
      android: {
        priority: 'high',
        notification: {
          channelId: 'trashgo_default',
          defaultSound: true,
          defaultVibrateTimings: true,
          defaultLightSettings: true,
          notificationGroup: 'trashgo',
          tag,
        },
      },
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
