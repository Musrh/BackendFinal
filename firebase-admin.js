// ================================================================
//  firebase-admin.js — Instance Firebase Admin partagée (ESM)
//  Importé par server.js, backup.js, store-restore.js, export-store.js
//  initializeApp() est appelé une seule fois ici.
// ================================================================

import admin from "firebase-admin"

const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(SERVICE_ACCOUNT) })
}

export default admin
export const db = admin.firestore()
export { SERVICE_ACCOUNT }
