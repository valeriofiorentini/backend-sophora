const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

let firebaseApp = null;

function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!serviceAccountPath || !fs.existsSync(path.resolve(serviceAccountPath))) {
    console.warn('Firebase service account not found — push notifications disabled');
    return null;
  }

  const serviceAccount = require(path.resolve(serviceAccountPath));
  firebaseApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return firebaseApp;
}

async function sendPushNotification(deviceToken, title, body, data = {}) {
  const app = getFirebaseApp();
  if (!app || !deviceToken) return;

  try {
    await admin.messaging().send({
      token: deviceToken,
      notification: { title, body },
      data,
    });
  } catch (err) {
    console.error('Push notification error:', err.message);
  }
}

module.exports = { sendPushNotification };
