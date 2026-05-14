// ================================================================
//  store-restore.js — VERSION ESM
// ================================================================

import admin from "firebase-admin"
import path from "path"
import fs from "fs"
import { Storage } from "@google-cloud/storage"

// ── Lazy init Firebase ──────────────────────────────────────────
const getDb = () => admin.firestore()

// ── Storage lazy (ESM) ──────────────────────────────────────────
let _storage = null
const getStorage = () => {
  if (!_storage) {
    const creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    _storage = new Storage({ credentials: creds })
  }
  return _storage
}

const BUCKET = process.env.BACKUP_BUCKET || "saasbuilder-backups"

// ── Vérification token ──────────────────────────────────────────
const verifyToken = async (idToken) => {
  if (!idToken) {
    const err = new Error("Non authentifié — idToken manquant")
    err.status = 401
    throw err
  }
  const decoded = await admin.auth().verifyIdToken(idToken)
  return decoded.uid
}

// ── Serialize ───────────────────────────────────────────────────
const serialize = (data) => {
  if (data == null) return null
  if (Array.isArray(data)) return data.map(serialize)

  if (typeof data === "object") {
    if (typeof data.toDate === "function") return data.toDate().toISOString()
    if (data._seconds !== undefined)
      return new Date(data._seconds * 1000).toISOString()

    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, serialize(v)])
    )
  }

  return data
}

// ── Download backup ─────────────────────────────────────────────
const downloadBackup = async (filename) => {
  const localPath = `/tmp/store_restore_${Date.now()}_${filename}`

  await getStorage()
    .bucket(BUCKET)
    .file(`backups/${filename}`)
    .download({ destination: localPath })

  const raw = fs.readFileSync(localPath, "utf-8")
  const backup = JSON.parse(raw)

  fs.unlinkSync(localPath)

  if (!backup.data) throw new Error("Backup invalide")

  return backup
}

// ── Restore filtré ──────────────────────────────────────────────
const restoreForUid = async (backup, uid, dryRun) => {
  const db = getDb()

  const detail = {
    userData: 0,
    orders: 0,
    forders: 0,
    slugs: 0,
    prodinfos: 0
  }

  let restored = 0
  let skipped = 0

  // users
  if (backup.data.users?.[uid]) {
    if (!dryRun) {
      await db.collection("users").doc(uid).set(
        serialize(backup.data.users[uid]),
        { merge: true }
      )
    }
    detail.userData++
    restored++
  } else skipped++

  // orders
  for (const [id, data] of Object.entries(backup.data.orders || {})) {
    if (data.ownerUid !== uid) continue

    if (!dryRun) {
      await db.collection("orders").doc(id).set(serialize(data), { merge: true })
    }
    detail.orders++
    restored++
  }

  // forders
  for (const [id, data] of Object.entries(backup.data.forders || {})) {
    if (data.ownerUid !== uid) continue

    if (!dryRun) {
      await db.collection("forders").doc(id).set(serialize(data), { merge: true })
    }
    detail.forders++
    restored++
  }

  // slugs
  for (const [id, data] of Object.entries(backup.data.slugs || {})) {
    if (data.uid !== uid) continue

    if (!dryRun) {
      await db.collection("slugs").doc(id).set(serialize(data), { merge: true })
    }
    detail.slugs++
    restored++
  }

  // prodinfos
  for (const [id, data] of Object.entries(backup.data.prodinfos || {})) {
    if (data.ownerUid !== uid) continue

    if (!dryRun) {
      await db.collection("prodinfos").doc(id).set(serialize(data), { merge: true })
    }
    detail.prodinfos++
    restored++
  }

  return { restored, skipped, detail }
}

// ================================================================
// ROUTES
// ================================================================
export const storeRestoreRoutes = (app) => {

  // ── LIST BACKUPS ──────────────────────────────────────────────
  app.get("/api/store/backups", async (req, res) => {
    try {
      const { idToken } = req.query
      await verifyToken(idToken)

      const bucket = getStorage().bucket(BUCKET)
      const [files] = await bucket.getFiles({ prefix: "backups/" })

      const backups = files
        .filter(f => f.name.endsWith(".json"))
        .map(f => ({
          filename: path.basename(f.name),
          size: f.metadata.size,
          createdAt: f.metadata.timeCreated
        }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 30)

      res.json({ backups, count: backups.length })

    } catch (e) {
      res.status(e.status || 500).json({ error: e.message })
    }
  })

  // ── RESTORE ───────────────────────────────────────────────────
  app.post("/api/store/restore", async (req, res) => {
    try {
      const { idToken, filename, dryRun = true } = req.body

      if (!filename) return res.status(400).json({ error: "filename requis" })

      const safeName = path.basename(filename)
      if (safeName !== filename || !safeName.endsWith(".json")) {
        return res.status(400).json({ error: "Nom invalide" })
      }

      const uid = await verifyToken(idToken)

      const backup = await downloadBackup(safeName)
      const stats = await restoreForUid(backup, uid, dryRun)

      res.json({
        success: true,
        uid,
        filename: safeName,
        dryRun,
        ...stats
      })

    } catch (e) {
      res.status(e.status || 500).json({ error: e.message })
    }
  })
}
