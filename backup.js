// ================================================================
//  backup.js — Sauvegarde Firestore → Cloud Storage
//  Usage : node backup.js
//  Cron  : 0 2 * * * node /app/backup.js   (tous les jours à 2h)
//
//  Variables d'env requises :
//    FIREBASE_SERVICE_ACCOUNT   (JSON stringify)
//    BACKUP_BUCKET              (ex: "saasbuilder-backups")
//    BACKUP_RETENTION_DAYS      (défaut: 30)
// ================================================================

const admin  = require("firebase-admin")
const { Storage } = require("@google-cloud/storage")
const fs     = require("fs")
const path   = require("path")

// ── Config ──────────────────────────────────────────────────────
const BUCKET_NAME    = process.env.BACKUP_BUCKET || "saasbuilder-backups"
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || "30")

// Collections à sauvegarder
const COLLECTIONS = [
  "users",
  "orders",
  "forders",
  "slugs",
  "subscriptions",
  "customers",
  "prodinfos",
]

// ── Init Firebase Admin ──────────────────────────────────────────
// Initialiser uniquement si pas déjà fait (évite le conflit avec server.js)
if (!admin.apps.length) {
  const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  admin.initializeApp({ credential: admin.credential.cert(SERVICE_ACCOUNT) })
}

const db = admin.firestore()

// Lazy init du Storage (évite le crash au démarrage si env var absente)
let _storage = null
const getStorage = () => {
  if (!_storage) {
    const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    _storage = new Storage({ credentials: SERVICE_ACCOUNT })
  }
  return _storage
}

// ── Utilitaires ──────────────────────────────────────────────────
const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-")
const log       = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`)

// Convertir les types Firestore en JSON sérialisable
const serializeDoc = (data) => {
  const result = {}
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      result[key] = null
    } else if (value?.toDate) {
      result[key] = value.toDate().toISOString()
    } else if (value?.seconds !== undefined) {
      result[key] = new Date(value.seconds * 1000).toISOString()
    } else if (Array.isArray(value)) {
      result[key] = value.map(v =>
        typeof v === "object" && v !== null ? serializeDoc(v) : v
      )
    } else if (typeof value === "object") {
      result[key] = serializeDoc(value)
    } else {
      result[key] = value
    }
  }
  return result
}

// ── Lire une collection complète ─────────────────────────────────
const readCollection = async (colName) => {
  log(`  📖 Lecture ${colName}...`)
  const snap = await db.collection(colName).get()
  const docs = {}
  snap.docs.forEach(d => {
    docs[d.id] = serializeDoc(d.data())
  })
  log(`  ✅ ${colName}: ${snap.size} documents`)
  return docs
}

// ── Export JSON complet ──────────────────────────────────────────
const exportToJson = async () => {
  log("🚀 Démarrage backup Firestore...")
  const ts     = timestamp()
  const backup = {
    meta: {
      timestamp:   new Date().toISOString(),
      collections: COLLECTIONS,
      version:     "1.0",
    },
    data: {}
  }

  for (const col of COLLECTIONS) {
    try {
      backup.data[col] = await readCollection(col)
    } catch (e) {
      log(`  ⚠️ ${col}: ${e.message}`)
      backup.data[col] = { _error: e.message }
    }
  }

  const filename = `backup_${ts}.json`
  const filepath = path.join("/tmp", filename)

  fs.writeFileSync(filepath, JSON.stringify(backup, null, 2))
  const sizeKb = (fs.statSync(filepath).size / 1024).toFixed(1)
  log(`📄 Fichier créé: ${filename} (${sizeKb} KB)`)

  return { filename, filepath, ts, backup }
}

// ── Upload vers Cloud Storage ────────────────────────────────────
const uploadToStorage = async (filepath, filename) => {
  log(`☁️  Upload vers gs://${BUCKET_NAME}/backups/${filename}...`)
  const bucket = getStorage().bucket(BUCKET_NAME)
  await bucket.upload(filepath, {
    destination: `backups/${filename}`,
    metadata: {
      contentType: "application/json",
      metadata: {
        source:    "saasbuilder-backup",
        createdAt: new Date().toISOString(),
      }
    }
  })
  log(`✅ Upload OK: gs://${BUCKET_NAME}/backups/${filename}`)
}

// ── Supprimer les vieux backups ──────────────────────────────────
const cleanOldBackups = async () => {
  log(`🧹 Nettoyage des backups > ${RETENTION_DAYS} jours...`)
  const bucket  = getStorage().bucket(BUCKET_NAME)
  const [files] = await bucket.getFiles({ prefix: "backups/" })
  const cutoff  = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  let deleted   = 0

  for (const file of files) {
    const created = new Date(file.metadata.timeCreated).getTime()
    if (created < cutoff) {
      await file.delete()
      log(`  🗑️  Supprimé: ${file.name}`)
      deleted++
    }
  }
  log(`🧹 ${deleted} fichier(s) supprimé(s)`)
}

// ── Lister les backups disponibles ──────────────────────────────
const listBackups = async () => {
  const bucket  = getStorage().bucket(BUCKET_NAME)
  const [files] = await bucket.getFiles({ prefix: "backups/" })
  return files
    .filter(f => f.name.endsWith(".json"))
    .map(f => ({
      name:      f.name,
      filename:  path.basename(f.name),
      size:      f.metadata.size,
      createdAt: f.metadata.timeCreated,
      url:       `gs://${BUCKET_NAME}/${f.name}`,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
}

// ── Restore depuis un fichier JSON ───────────────────────────────
// FIX : le bug "dead code" est corrigé — overwrite=false → ref.create()
const restoreFromJson = async (jsonPath, options = {}) => {
  const {
    collections = COLLECTIONS,
    dryRun      = true,
    overwrite   = false,
  } = options

  log(`🔄 Restore depuis: ${jsonPath}`)
  log(`   dryRun: ${dryRun} | overwrite: ${overwrite}`)
  log(`   collections: ${collections.join(", ")}`)

  const raw    = fs.readFileSync(jsonPath, "utf-8")
  const backup = JSON.parse(raw)
  const stats  = { restored: 0, skipped: 0, errors: 0 }

  log(`📅 Backup du: ${backup.meta?.timestamp || "inconnu"}`)

  for (const colName of collections) {
    if (!backup.data[colName]) {
      log(`  ⚠️ Collection ${colName} absente du backup`)
      continue
    }

    const docs = backup.data[colName]
    const ids  = Object.keys(docs).filter(k => !k.startsWith("_"))
    log(`  📦 ${colName}: ${ids.length} documents à restaurer`)

    for (const docId of ids) {
      try {
        if (!dryRun) {
          const ref    = db.collection(colName).doc(docId)
          const exists = (await ref.get()).exists

          if (exists && !overwrite) {
            stats.skipped++
            continue
          }

          // FIX : overwrite=true → set (écrase), overwrite=false → create (sûr)
          if (overwrite) {
            await ref.set(docs[docId])
          } else {
            await ref.create(docs[docId])
          }
        }
        stats.restored++
      } catch (e) {
        log(`  ❌ ${colName}/${docId}: ${e.message}`)
        stats.errors++
      }
    }
  }

  log(`✅ Restore terminé: ${stats.restored} restaurés, ${stats.skipped} ignorés, ${stats.errors} erreurs`)
  return stats
}

// ── Endpoint Express pour intégrer dans server.js ────────────────
// Intégration : const { backupRoutes } = require("./backup")
//               backupRoutes(app)
const ADMIN_EMAILS = ["musmamon@gmail.com", "musrh@gmail.com"]

const verifyAdmin = async (idToken) => {
  if (!idToken) throw Object.assign(new Error("Non authentifié"), { status: 401 })
  const decoded = await admin.auth().verifyIdToken(idToken)
  if (!ADMIN_EMAILS.includes(decoded.email?.toLowerCase())) {
    throw Object.assign(new Error("Non autorisé"), { status: 403 })
  }
}

const backupRoutes = (app) => {
  // Déclencher un backup manuel
  app.post("/api/admin/backup", async (req, res) => {
    try {
      await verifyAdmin(req.body.idToken)
      const { filename, filepath } = await exportToJson()
      await uploadToStorage(filepath, filename)
      await cleanOldBackups()
      fs.unlinkSync(filepath)
      res.json({ success: true, filename })
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message })
    }
  })

  // Lister les backups
  app.get("/api/admin/backups", async (req, res) => {
    try {
      await verifyAdmin(req.query.idToken)
      const list = await listBackups()
      res.json({ backups: list, count: list.length })
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message })
    }
  })

  // Télécharger un backup
  app.get("/api/admin/backup/:filename", async (req, res) => {
    try {
      await verifyAdmin(req.query.idToken)
      const bucket   = getStorage().bucket(BUCKET_NAME)
      const file     = bucket.file(`backups/${req.params.filename}`)
      const [exists] = await file.exists()
      if (!exists) return res.status(404).json({ error: "Backup introuvable" })
      res.setHeader("Content-Type", "application/json")
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.filename}"`)
      file.createReadStream().pipe(res)
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message })
    }
  })

  // Restore depuis un backup (dryRun par défaut)
  app.post("/api/admin/restore", async (req, res) => {
    const { idToken, filename, collections, dryRun = true, overwrite = false } = req.body
    try {
      await verifyAdmin(idToken)
      const bucket    = getStorage().bucket(BUCKET_NAME)
      const file      = bucket.file(`backups/${filename}`)
      const localPath = `/tmp/restore_${Date.now()}.json`
      await file.download({ destination: localPath })
      const stats = await restoreFromJson(localPath, { collections, dryRun, overwrite })
      fs.unlinkSync(localPath)
      res.json({ success: true, dryRun, ...stats })
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message })
    }
  })
}

// ── Exécution directe (cron) ─────────────────────────────────────
if (require.main === module) {
  ;(async () => {
    try {
      const { filename, filepath } = await exportToJson()
      await uploadToStorage(filepath, filename)
      await cleanOldBackups()
      fs.unlinkSync(filepath)
      log("🎉 Backup terminé avec succès !")
      process.exit(0)
    } catch (e) {
      log(`💥 Erreur backup: ${e.message}`)
      process.exit(1)
    }
  })()
}

module.exports = { backupRoutes, exportToJson, restoreFromJson, listBackups }
