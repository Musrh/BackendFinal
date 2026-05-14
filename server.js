// ===============================================================
//  server.js — Backend SaasBuilder (FINAL CLEAN)
// ===============================================================

import express from "express"
import cors from "cors"
import dotenv from "dotenv"

// 🔥 Firebase (UN SEUL POINT D’INIT)
import admin from "./firebase.js"

// 🔌 Routes
import { backupRoutes } from "./backup.js"
import { storeRestoreRoutes } from "./store-restore.js"

// ── Init config ────────────────────────────────────────────────
dotenv.config()

const app = express()

// ── Middlewares ────────────────────────────────────────────────
app.use(cors())
app.use(express.json())

// ── Firebase DB ────────────────────────────────────────────────
const db = admin.firestore()

// ===============================================================
//  HEALTH CHECK
// ===============================================================
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "SaasBuilder Backend",
    firebase: "✅ connected",
    time: new Date().toISOString(),
  })
})

// ===============================================================
//  TEST FIRESTORE
// ===============================================================
app.get("/api/test-firestore", async (req, res) => {
  try {
    const snap = await db.collection("users").limit(1).get()
    res.json({
      success: true,
      documents: snap.size,
    })
  } catch (e) {
    res.status(500).json({
      error: e.message,
    })
  }
})

// ===============================================================
//  ROUTES
// ===============================================================

// 🔐 Admin backup
backupRoutes(app)

// 🧾 Store restore (utilisateur)
storeRestoreRoutes(app)

// ===============================================================
//  ERROR HANDLER GLOBAL
// ===============================================================
app.use((err, req, res, next) => {
  console.error("❌ ERROR:", err)

  res.status(err.status || 500).json({
    error: err.message || "Erreur serveur",
  })
})

// ===============================================================
//  SERVER START
// ===============================================================
const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
})
