import admin from 'firebase-admin';

let _initialized = false;

function init() {
  if (_initialized) return true;
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) return false;
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    _initialized = true;
    console.log('✓ Firebase Admin initialized');
    return true;
  } catch (e: any) {
    console.warn('[Firebase Admin] init failed:', e.message);
    return false;
  }
}

export const isFirebaseAdminReady = () => init();

export async function verifyFirebaseIdToken(idToken: string): Promise<string | null> {
  if (!init()) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.phone_number ?? null;
  } catch {
    return null;
  }
}
