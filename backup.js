// ================================================================
//  backup.js — Sauvegarde Firestore → Cloud Storage (ESM)
// ================================================================

import admin from "firebase-admin"
import { Storage } from "@google-cloud/storage"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

// ── Fix __dirname en ESM ─────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ── Config ──────────────────────────────────────────────────────
const BUCKET_NAME    = process.env.BACKUP_BUCKET || "saasbuilder-backups"
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || "30")

const COLLECTIONS = [
  "users",
  "orders",
  "forders",
  "slugs",
  "subscriptions",
  "customers",
  "prodinfos",
]

// ── Init Firebase ───────────────────────────────────────────────
if (!admin.apps.length) {
  const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  admin.initializeApp({ credential: admin.credential.cert(SERVICE_ACCOUNT) })
}

const db = admin.firestore()

// ── Storage lazy ────────────────────────────────────────────────
let _storage = null
const getStorage = () => {
  if (!_storage) {
    const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    _storage = new Storage({ credentials: SERVICE_ACCOUNT })
  }
  return _storage
}

// ── Utils ───────────────────────────────────────────────────────
const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-")
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`)

const serializeDoc = (data) => {
  const result = {}
  for (const [key, value] of Object.entries(data)) {
    if (value == null) result[key] = null
    else if (value?.toDate) result[key] = value.toDate().toISOString()
    else if (value?.seconds !== undefined)
      result[key] = new Date(value.seconds * 1000).toISOString()
    else if (Array.isArray(value))
      result[key] = value.map(v =>
        typeof v === "object" && v !== null ? serializeDoc(v) : v
      )
    else if (typeof value === "object")
      result[key] = serializeDoc(value)
    else result[key] = value
  }
  return result
}

// ── Lire collection ─────────────────────────────────────────────
const readCollection = async (colName) => {
  log(`📖 ${colName}`)
  const snap = await db.collection(colName).get()
  const docs = {}
  snap.docs.forEach(d => {
    docs[d.id] = serializeDoc(d.data())
  })
  log(`✅ ${colName}: ${snap.size}`)
  return docs
}

// ── Export ──────────────────────────────────────────────────────
export const exportToJson = async () => {
  log("🚀 Backup...")
  const ts = timestamp()

  const backup = {
    meta: {
      timestamp: new Date().toISOString(),
      collections: COLLECTIONS,
      version: "1.0",
    },
    data: {}
  }

  for (const col of COLLECTIONS) {
    try {
      backup.data[col] = await readCollection(col)
    } catch (e) {
      backup.data[col] = { _error: e.message }
    }
  }

  const filename = `backup_${ts}.json`
  const filepath = path.join("/tmp", filename)

  fs.writeFileSync(filepath, JSON.stringify(backup, null, 2))

  return { filename, filepath }
}

// ── Upload ──────────────────────────────────────────────────────
const uploadToStorage = async (filepath, filename) => {
  const bucket = getStorage().bucket(BUCKET_NAME)

  await bucket.upload(filepath, {
    destination: `backups/${filename}`,
    metadata: { contentType: "application/json" }
  })
}

// ── Cleanup ─────────────────────────────────────────────────────
const cleanOldBackups = async () => {
  const bucket = getStorage().bucket(BUCKET_NAME)
  const [files] = await bucket.getFiles({ prefix: "backups/" })

  const cutoff = Date.now() - RETENTION_DAYS * 86400000

  for (const file of files) {
    const created = new Date(file.metadata.timeCreated).getTime()
    if (created < cutoff) await file.delete()
  }
}

// ── List ────────────────────────────────────────────────────────
export const listBackups = async () => {
  const bucket = getStorage().bucket(BUCKET_NAME)
  const [files] = await bucket.getFiles({ prefix: "backups/" })

  return files.map(f => ({
    name: f.name,
    createdAt: f.metadata.timeCreated
  }))
}

// ── Restore ─────────────────────────────────────────────────────
export const restoreFromJson = async (jsonPath, options = {}) => {
  const { collections = COLLECTIONS, dryRun = true, overwrite = false } = options

  const raw = fs.readFileSync(jsonPath, "utf-8")
  const backup = JSON.parse(raw)

  for (const colName of collections) {
    const docs = backup.data[colName] || {}
    for (const docId of Object.keys(docs)) {
      if (dryRun) continue

      const ref = db.collection(colName).doc(docId)
      const exists = (await ref.get()).exists

      if (exists && !overwrite) continue

      if (overwrite) await ref.set(docs[docId])
      else await ref.create(docs[docId])
    }
  }
}

// ── Routes Express ──────────────────────────────────────────────
export const backupRoutes = (app) => {
  app.post("/api/admin/backup", async (req, res) => {
    try {
      const { filename, filepath } = await exportToJson()
      await uploadToStorage(filepath, filename)
      await cleanOldBackups()
      fs.unlinkSync(filepath)
      res.json({ success: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
}

// ── Execution directe (ESM FIX) ─────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  ;(async () => {
    try {
      const { filename, filepath } = await exportToJson()
      await uploadToStorage(filepath, filename)
      await cleanOldBackups()
      fs.unlinkSync(filepath)
      log("🎉 Backup OK")
      process.exit(0)
    } catch (e) {
      log(e.message)
      process.exit(1)
    }
  })()
}
