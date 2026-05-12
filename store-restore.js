// ================================================================
//  store-restore.js — Restore d'un store par son propriétaire
//  Ajouter dans server.js : const { storeRestoreRoutes } = require("./store-restore")
//  puis : storeRestoreRoutes(app)
// ================================================================

const admin = require("firebase-admin")
const { Storage } = require("@google-cloud/storage")
const fs    = require("fs")

const db      = admin.firestore()
const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
const storage = new Storage({ credentials: SERVICE_ACCOUNT })
const BUCKET  = process.env.BACKUP_BUCKET || "saasbuilder-backups"

// ── Vérifier le token Firebase de l'utilisateur ──────────────────
const verifyToken = async (idToken) => {
  const decoded = await admin.auth().verifyIdToken(idToken)
  return decoded.uid
}

// ── Sérialiser pour Firestore ────────────────────────────────────
const serialize = (data) => {
  if (data === null || data === undefined) return null
  if (Array.isArray(data)) return data.map(serialize)
  if (typeof data === "object") {
    // Re-convertir les strings ISO en Timestamp si besoin
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, serialize(v)])
    )
  }
  return data
}

const storeRestoreRoutes = (app) => {

  // ── Lister les backups (accessible à tous les users connectés) ──
  app.get("/api/store/backups", async (req, res) => {
    const { idToken } = req.query
    if (!idToken) return res.status(401).json({ error: "Non authentifié" })

    try {
      await verifyToken(idToken)   // vérifie que l'user est bien connecté
      const bucket  = storage.bucket(BUCKET)
      const [files] = await bucket.getFiles({ prefix: "backups/" })

      const backups = files
        .filter(f => f.name.endsWith(".json"))
        .map(f => ({
          filename:  require("path").basename(f.name),
          size:      f.metadata.size,
          createdAt: f.metadata.timeCreated,
        }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 30)  // max 30 backups affichés

      res.json({ backups, count: backups.length })
    } catch(e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Restore du store de l'utilisateur connecté ──────────────────
  // Restaure UNIQUEMENT les données de cet ownerUid
  // Ne touche pas aux données des autres utilisateurs
  app.post("/api/store/restore", async (req, res) => {
    const { idToken, filename, dryRun = true } = req.body
    if (!idToken)  return res.status(401).json({ error: "Non authentifié" })
    if (!filename) return res.status(400).json({ error: "filename requis" })

    try {
      // Vérifier l'identité de l'utilisateur
      const uid = await verifyToken(idToken)
      console.log(`🔄 Restore store ${uid} depuis ${filename} (dryRun: ${dryRun})`)

      // Télécharger le backup
      const localPath = `/tmp/restore_store_${uid}_${Date.now()}.json`
      await storage.bucket(BUCKET).file(`backups/${filename}`).download({
        destination: localPath
      })

      const raw    = fs.readFileSync(localPath, "utf-8")
      const backup = JSON.parse(raw)
      fs.unlinkSync(localPath)

      if (!backup.data) throw new Error("Format de backup invalide")

      const stats = { restored: 0, skipped: 0 }

      // ── Restaurer uniquement les données de cet utilisateur ────

      // 1. Document users/{uid}
      if (backup.data.users?.[uid]) {
        if (!dryRun) {
          await db.collection("users").doc(uid).set(
            serialize(backup.data.users[uid]),
            { merge: true }
          )
        }
        stats.restored++
        console.log(`  ✅ users/${uid}`)
      }

      // 2. Commandes Pro (orders) de cet ownerUid
      const ownerOrders = Object.entries(backup.data.orders || {})
        .filter(([, data]) => data.ownerUid === uid)

      for (const [docId, data] of ownerOrders) {
        if (!dryRun) {
          await db.collection("orders").doc(docId).set(serialize(data))
        }
        stats.restored++
      }
      console.log(`  ✅ orders: ${ownerOrders.length}`)

      // 3. Commandes Free (forders) de cet ownerUid
      const ownerForders = Object.entries(backup.data.forders || {})
        .filter(([, data]) => data.ownerUid === uid)

      for (const [docId, data] of ownerForders) {
        if (!dryRun) {
          await db.collection("forders").doc(docId).set(serialize(data))
        }
        stats.restored++
      }
      console.log(`  ✅ forders: ${ownerForders.length}`)

      // 4. Slug de cet utilisateur
      const ownerSlugs = Object.entries(backup.data.slugs || {})
        .filter(([, data]) => data.uid === uid)

      for (const [docId, data] of ownerSlugs) {
        if (!dryRun) {
          await db.collection("slugs").doc(docId).set(serialize(data))
        }
        stats.restored++
      }
      console.log(`  ✅ slugs: ${ownerSlugs.length}`)

      console.log(`✅ Restore store ${uid}: ${stats.restored} éléments (dryRun: ${dryRun})`)

      res.json({
        success:  true,
        dryRun,
        uid,
        filename,
        ...stats,
        detail: {
          userData:  backup.data.users?.[uid] ? 1 : 0,
          orders:    ownerOrders.length,
          forders:   ownerForders.length,
          slugs:     ownerSlugs.length,
        }
      })

    } catch(e) {
      console.error("❌ store/restore:", e.message)
      res.status(500).json({ error: e.message })
    }
  })

}

module.exports = { storeRestoreRoutes }
