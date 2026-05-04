// No static import — firebase-admin is loaded lazily to avoid ESM startup crash
// (static `import admin from 'firebase-admin'` in an ESM project crashes the process on load)

let _auth: { verifyIdToken(t: string): Promise<{ phone_number?: string }> } | null = null;

async function getAuth() {
  if (_auth) return _auth;
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
    }
    _auth = admin.auth();
    console.log('✓ Firebase Admin initialized');
    return _auth;
  } catch (e: any) {
    console.warn('[Firebase Admin] failed to load:', e.message);
    return null;
  }
}

export const isFirebaseAdminReady = () => !!process.env.FIREBASE_PROJECT_ID;

export async function verifyFirebaseIdToken(idToken: string): Promise<string | null> {
  const auth = await getAuth();
  if (!auth) return null;
  try {
    const decoded = await auth.verifyIdToken(idToken);
    return decoded.phone_number ?? null;
  } catch {
    return null;
  }
}
