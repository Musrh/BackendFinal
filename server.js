// ===============================================================
//  server.js — Backend FINAL SaasBuilder (ESM CLEAN)
// ===============================================================

import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import admin from "firebase-admin"

// ⚠️ IMPORTANT: import ESM
import { storeRestoreRoutes } from "./store-restore.js"

// ===============================================================
// ENV
// ===============================================================
dotenv.config()

// ===============================================================
// EXPRESS
// ===============================================================
const app = express()

app.use(cors())
app.use(express.json())

// ===============================================================
// FIREBASE INIT (ANTI-DUPLICATE FIX)
// ===============================================================

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  })

  console.log("🔥 Firebase initialized")
} else {
  console.log("⚠️ Firebase already initialized")
}

// ===============================================================
// ROUTES TEST
// ===============================================================
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "BackendFinal",
    firebase: "✅",
  })
})

// ===============================================================
// STORE RESTORE ROUTES
// ===============================================================
storeRestoreRoutes(app)

// ===============================================================
// PORT
// ===============================================================
const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
})
