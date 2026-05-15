// ================================================================
//  store-restore.js — Restore d'un store par son propriétaire (ESM)
// ================================================================

import { Storage }   from "@google-cloud/storage"
import fs            from "fs"
import path          from "path"
import admin, { db, SERVICE_ACCOUNT } from "./firebase-admin.js"

const storage = new Storage({ credentials: SERVICE_ACCOUNT })
const BUCKET  = process.env.BACKUP_BUCKET || "saasbuilder-backups"

const verifyToken = async (idToken) => {
  const decoded = await admin.auth().verifyIdToken(idToken)
  return decoded.uid
}

const serialize = (data) => {
  if (data === null || data === undefined) return null
  if (Array.isArray(data)) return data.map(serialize)
  if (typeof data === "object")
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, serialize(v)]))
  return data
}

export const storeRestoreRoutes = (app) => {

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

  app.post("/api/store/restore", async (req, res) => {
    const idToken  = req.headers.authorization?.replace("Bearer ", "") || req.body.idToken
    const { filename, dryRun = true } = req.body
    if (!idToken)  return res.status(401).json({ error: "Non authentifié" })
    if (!filename) return res.status(400).json({ error: "filename requis" })
    try {
      const uid       = await verifyToken(idToken)
      const localPath = `/tmp/restore_store_${uid}_${Date.now()}.json`
      await storage.bucket(BUCKET).file(`backups/${filename}`).download({ destination: localPath })
      const backup = JSON.parse(fs.readFileSync(localPath, "utf-8"))
      fs.unlinkSync(localPath)
      if (!backup.data) throw new Error("Format de backup invalide")

      const stats = { restored: 0, skipped: 0 }

      if (backup.data.users?.[uid]) {
        if (!dryRun) await db.collection("users").doc(uid).set(serialize(backup.data.users[uid]))
        stats.restored++
      }
      const ownerOrders = Object.entries(backup.data.orders || {}).filter(([,d]) => d.ownerUid === uid)
      for (const [id, data] of ownerOrders) { if (!dryRun) await db.collection("orders").doc(id).set(serialize(data)); stats.restored++ }

      const ownerForders = Object.entries(backup.data.forders || {}).filter(([,d]) => d.ownerUid === uid)
      for (const [id, data] of ownerForders) { if (!dryRun) await db.collection("forders").doc(id).set(serialize(data)); stats.restored++ }

      const ownerSlugs = Object.entries(backup.data.slugs || {}).filter(([,d]) => d.uid === uid)
      for (const [id, data] of ownerSlugs) { if (!dryRun) await db.collection("slugs").doc(id).set(serialize(data)); stats.restored++ }

      const ownerProdinfos = Object.entries(backup.data.prodinfos || {}).filter(([,d]) => d.ownerUid === uid)
      for (const [id, data] of ownerProdinfos) { if (!dryRun) await db.collection("prodinfos").doc(id).set(serialize(data)); stats.restored++ }

      res.json({ success: true, dryRun, uid, filename, ...stats,
        detail: { userData: backup.data.users?.[uid] ? 1 : 0, orders: ownerOrders.length, forders: ownerForders.length, slugs: ownerSlugs.length, prodinfos: ownerProdinfos.length }
      })
    } catch(e) { console.error("❌ store/restore:", e.message); res.status(500).json({ error: e.message }) }
  })
}
