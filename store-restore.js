// ================================================================
//  store-restore.js — Restore d'un store par son propriétaire (ESM)
// ================================================================

import admin         from "firebase-admin"
import { Storage }   from "@google-cloud/storage"
import fs            from "fs"
import path          from "path"

const db      = admin.firestore()
const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
const storage = new Storage({ credentials: SERVICE_ACCOUNT })
const BUCKET  = process.env.BACKUP_BUCKET || "saasbuilder-backups"

const verifyToken = async (idToken) => {
  const decoded = await admin.auth().verifyIdToken(idToken)
  return decoded.uid
}

const serialize = (data) => {
  if (data === null || data === undefined) return null
  if (Array.isArray(data)) return data.map(serialize)
  if (typeof data === "object") {
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, serialize(v)]))
  }
  return data
}

export const storeRestoreRoutes = (app) => {

  // ── Lister les backups ──────────────────────────────────────────
  app.get("/api/store/backups", async (req, res) => {
    const idToken = req.headers.authorization?.replace("Bearer ", "") || req.query.idToken
    if (!idToken) return res.status(401).json({ error: "Non authentifié" })
    try {
      await verifyToken(idToken)
      const [files] = await storage.bucket(BUCKET).getFiles({ prefix: "backups/" })
      const backups = files
        .filter(f => f.name.endsWith(".json"))
        .map(f => ({ filename: path.basename(f.name), size: f.metadata.size, createdAt: f.metadata.timeCreated }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 30)
      res.json({ backups, count: backups.length })
    } catch(e) { res.status(500).json({ error: e.message }) }
  })

  // ── Restore du store de l'utilisateur connecté ──────────────────
  app.post("/api/store/restore", async (req, res) => {
    const idToken  = req.headers.authorization?.replace("Bearer ", "") || req.body.idToken
    const { filename, dryRun = true } = req.body
    if (!idToken)  return res.status(401).json({ error: "Non authentifié" })
    if (!filename) return res.status(400).json({ error: "filename requis" })

    try {
      const uid       = await verifyToken(idToken)
      console.log(`🔄 Restore store ${uid} depuis ${filename} (dryRun: ${dryRun})`)

      const localPath = `/tmp/restore_store_${uid}_${Date.now()}.json`
      await storage.bucket(BUCKET).file(`backups/${filename}`).download({ destination: localPath })

      const backup = JSON.parse(fs.readFileSync(localPath, "utf-8"))
      fs.unlinkSync(localPath)

      if (!backup.data) throw new Error("Format de backup invalide")

      const stats = { restored: 0, skipped: 0 }

      // 1. Document users/{uid}
      if (backup.data.users?.[uid]) {
        if (!dryRun) await db.collection("users").doc(uid).set(serialize(backup.data.users[uid]))
        stats.restored++
        console.log(`  ✅ users/${uid}`)
      }

      // 2. Orders
      const ownerOrders = Object.entries(backup.data.orders || {}).filter(([, d]) => d.ownerUid === uid)
      for (const [docId, data] of ownerOrders) {
        if (!dryRun) await db.collection("orders").doc(docId).set(serialize(data))
        stats.restored++
      }
      console.log(`  ✅ orders: ${ownerOrders.length}`)

      // 3. Forders
      const ownerForders = Object.entries(backup.data.forders || {}).filter(([, d]) => d.ownerUid === uid)
      for (const [docId, data] of ownerForders) {
        if (!dryRun) await db.collection("forders").doc(docId).set(serialize(data))
        stats.restored++
      }
      console.log(`  ✅ forders: ${ownerForders.length}`)

      // 4. Slugs
      const ownerSlugs = Object.entries(backup.data.slugs || {}).filter(([, d]) => d.uid === uid)
      for (const [docId, data] of ownerSlugs) {
        if (!dryRun) await db.collection("slugs").doc(docId).set(serialize(data))
        stats.restored++
      }
      console.log(`  ✅ slugs: ${ownerSlugs.length}`)

      // 5. Prodinfos
      const ownerProdinfos = Object.entries(backup.data.prodinfos || {}).filter(([, d]) => d.ownerUid === uid)
      for (const [docId, data] of ownerProdinfos) {
        if (!dryRun) await db.collection("prodinfos").doc(docId).set(serialize(data))
        stats.restored++
      }
      console.log(`  ✅ prodinfos: ${ownerProdinfos.length}`)

      console.log(`✅ Restore store ${uid}: ${stats.restored} éléments (dryRun: ${dryRun})`)

      res.json({
        success: true, dryRun, uid, filename, ...stats,
        detail: {
          userData:  backup.data.users?.[uid] ? 1 : 0,
          orders:    ownerOrders.length,
          forders:   ownerForders.length,
          slugs:     ownerSlugs.length,
          prodinfos: ownerProdinfos.length,
        }
      })
    } catch(e) {
      console.error("❌ store/restore:", e.message)
      res.status(500).json({ error: e.message })
    }
  })
}
