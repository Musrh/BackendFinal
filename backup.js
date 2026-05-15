// ================================================================
//  backup.js — Sauvegarde Firestore → Cloud Storage  (ESM)
//  Usage : node backup.js
//  Cron  : 0 2 * * * node /app/backup.js
// ================================================================

import { Storage }       from "@google-cloud/storage"
import fs                from "fs"
import path              from "path"
import { fileURLToPath } from "url"
import admin, { db, SERVICE_ACCOUNT } from "./firebase-admin.js"

const __filename = fileURLToPath(import.meta.url)

const BUCKET_NAME    = process.env.BACKUP_BUCKET || "saasbuilder-backups"
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || "30")
const COLLECTIONS    = ["users","orders","forders","slugs","subscriptions","customers","prodinfos"]
const storage        = new Storage({ credentials: SERVICE_ACCOUNT })

const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-")
const log       = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`)

const serializeDoc = (data) => {
  const result = {}
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined)   result[key] = null
    else if (value?.toDate)                      result[key] = value.toDate().toISOString()
    else if (value?.seconds !== undefined)       result[key] = new Date(value.seconds * 1000).toISOString()
    else if (Array.isArray(value))               result[key] = value.map(v => typeof v === "object" && v !== null ? serializeDoc(v) : v)
    else if (typeof value === "object")          result[key] = serializeDoc(value)
    else                                         result[key] = value
  }
  return result
}

const readCollection = async (colName) => {
  log(`  📖 Lecture ${colName}...`)
  const snap = await db.collection(colName).get()
  const docs = {}
  snap.docs.forEach(d => { docs[d.id] = serializeDoc(d.data()) })
  log(`  ✅ ${colName}: ${snap.size} documents`)
  return docs
}

export const exportToJson = async () => {
  log("🚀 Démarrage backup Firestore...")
  const ts     = timestamp()
  const backup = { meta: { timestamp: new Date().toISOString(), collections: COLLECTIONS, version: "1.0" }, data: {} }
  for (const col of COLLECTIONS) {
    try      { backup.data[col] = await readCollection(col) }
    catch(e) { log(`  ⚠️ ${col}: ${e.message}`); backup.data[col] = { _error: e.message } }
  }
  const filename = `backup_${ts}.json`
  const filepath = path.join("/tmp", filename)
  fs.writeFileSync(filepath, JSON.stringify(backup, null, 2))
  log(`📄 Fichier créé: ${filename} (${(fs.statSync(filepath).size/1024).toFixed(1)} KB)`)
  return { filename, filepath, ts, backup }
}

export const uploadToStorage = async (filepath, filename) => {
  log(`☁️  Upload vers gs://${BUCKET_NAME}/backups/${filename}...`)
  await storage.bucket(BUCKET_NAME).upload(filepath, {
    destination: `backups/${filename}`,
    metadata: { contentType: "application/json", metadata: { source: "saasbuilder-backup", createdAt: new Date().toISOString() } }
  })
  log(`✅ Upload OK: gs://${BUCKET_NAME}/backups/${filename}`)
}

export const cleanOldBackups = async () => {
  log(`🧹 Nettoyage des backups > ${RETENTION_DAYS} jours...`)
  const [files] = await storage.bucket(BUCKET_NAME).getFiles({ prefix: "backups/" })
  const cutoff  = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  let deleted   = 0
  for (const file of files) {
    if (new Date(file.metadata.timeCreated).getTime() < cutoff) {
      await file.delete(); log(`  🗑️  Supprimé: ${file.name}`); deleted++
    }
  }
  log(`🧹 ${deleted} fichier(s) supprimé(s)`)
}

export const listBackups = async () => {
  const [files] = await storage.bucket(BUCKET_NAME).getFiles({ prefix: "backups/" })
  return files
    .filter(f => f.name.endsWith(".json"))
    .map(f => ({ name: f.name, filename: path.basename(f.name), size: f.metadata.size, createdAt: f.metadata.timeCreated, url: `gs://${BUCKET_NAME}/${f.name}` }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
}

export const restoreFromJson = async (jsonPath, options = {}) => {
  const { collections = COLLECTIONS, dryRun = true, overwrite = false } = options
  log(`🔄 Restore depuis: ${jsonPath} | dryRun: ${dryRun} | overwrite: ${overwrite}`)
  const backup = JSON.parse(fs.readFileSync(jsonPath, "utf-8"))
  const stats  = { restored: 0, skipped: 0, errors: 0 }
  log(`📅 Backup du: ${backup.meta?.timestamp || "inconnu"}`)
  for (const colName of collections) {
    if (!backup.data[colName]) { log(`  ⚠️ Collection ${colName} absente du backup`); continue }
    const docs = backup.data[colName]
    const ids  = Object.keys(docs).filter(k => !k.startsWith("_"))
    log(`  📦 ${colName}: ${ids.length} documents`)
    for (const docId of ids) {
      try {
        if (!dryRun) {
          const ref    = db.collection(colName).doc(docId)
          const exists = (await ref.get()).exists
          if (exists && !overwrite) { stats.skipped++; continue }
          await ref.set(docs[docId])
        }
        stats.restored++
      } catch(e) { log(`  ❌ ${colName}/${docId}: ${e.message}`); stats.errors++ }
    }
  }
  log(`✅ Restore terminé: ${stats.restored} restaurés, ${stats.skipped} ignorés, ${stats.errors} erreurs`)
  return stats
}

const ADMIN_EMAILS = ["musmamon@gmail.com", "musrh@gmail.com"]
const verifyAdmin  = async (idToken) => {
  if (!idToken) throw Object.assign(new Error("Non authentifié"), { status: 401 })
  const decoded = await admin.auth().verifyIdToken(idToken)
  if (!ADMIN_EMAILS.includes(decoded.email?.toLowerCase()))
    throw Object.assign(new Error("Non autorisé"), { status: 403 })
}

export const backupRoutes = (app) => {
  app.post("/api/admin/backup", async (req, res) => {
    try {
      await verifyAdmin(req.body.idToken)
      const { filename, filepath } = await exportToJson()
      await uploadToStorage(filepath, filename)
      await cleanOldBackups()
      fs.unlinkSync(filepath)
      res.json({ success: true, filename })
    } catch(e) { res.status(e.status || 500).json({ error: e.message }) }
  })

  app.get("/api/admin/backups", async (req, res) => {
    try {
      await verifyAdmin(req.query.idToken)
      res.json({ backups: await listBackups(), count: (await listBackups()).length })
    } catch(e) { res.status(e.status || 500).json({ error: e.message }) }
  })

  app.get("/api/admin/backup/:filename", async (req, res) => {
    try {
      await verifyAdmin(req.query.idToken)
      const file     = storage.bucket(BUCKET_NAME).file(`backups/${req.params.filename}`)
      const [exists] = await file.exists()
      if (!exists) return res.status(404).json({ error: "Backup introuvable" })
      res.setHeader("Content-Type", "application/json")
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.filename}"`)
      file.createReadStream().pipe(res)
    } catch(e) { res.status(e.status || 500).json({ error: e.message }) }
  })

  app.post("/api/admin/restore", async (req, res) => {
    const { idToken, filename, collections, dryRun = true, overwrite = false } = req.body
    try {
      await verifyAdmin(idToken)
      const file      = storage.bucket(BUCKET_NAME).file(`backups/${filename}`)
      const localPath = `/tmp/restore_${Date.now()}.json`
      await file.download({ destination: localPath })
      const stats = await restoreFromJson(localPath, { collections, dryRun, overwrite })
      fs.unlinkSync(localPath)
      res.json({ success: true, dryRun, ...stats })
    } catch(e) { res.status(e.status || 500).json({ error: e.message }) }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ;(async () => {
    try {
      const { filename, filepath } = await exportToJson()
      await uploadToStorage(filepath, filename)
      await cleanOldBackups()
      fs.unlinkSync(filepath)
      log("🎉 Backup terminé avec succès !"); process.exit(0)
    } catch(e) { log(`💥 Erreur backup: ${e.message}`); process.exit(1) }
  })()
}
