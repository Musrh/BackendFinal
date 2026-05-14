// ================================================================
//  store-restore.js — Restore de données par le propriétaire du store
//
//  Routes exposées :
//    GET  /api/store/backups        → liste les backups disponibles
//    POST /api/store/restore        → restaure les données de l'utilisateur
//
//  Sécurité :
//    - Chaque requête exige un idToken Firebase valide.
//    - La restauration est strictement filtrée par uid :
//      seules les données appartenant à l'utilisateur connecté
//      sont touchées (ownerUid === uid ou uid === uid).
//    - Aucun document d'un autre utilisateur n'est jamais modifié.
//
//  Collections restaurées pour un uid donné :
//    users/{uid}                              (document de profil)
//    orders   où ownerUid === uid             (commandes Pro)
//    forders  où ownerUid === uid             (commandes Free)
//    slugs    où uid === uid                  (slugs publiés)
//    prodinfos où ownerUid === uid            (infos produits)
//
//  Variables d'env requises :
//    FIREBASE_SERVICE_ACCOUNT   (JSON stringify du service account)
//    BACKUP_BUCKET              (ex: "saasbuilder-backups")
//
//  Intégration dans server.js (ESM) — voir server-integration.txt
// ================================================================

const admin = require("firebase-admin")
const path  = require("path")
const fs    = require("fs")

// ── Lazy init Firebase & Storage ────────────────────────────────
// Ne pas appeler admin.firestore() au chargement du module.
// Firebase est initialisé dans server.js ; on accède à l'instance
// uniquement au moment des requêtes.
const getDb = () => admin.firestore()

let _storage = null
const getStorage = () => {
  if (!_storage) {
    const { Storage } = require("@google-cloud/storage")
    const creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    _storage = new Storage({ credentials: creds })
  }
  return _storage
}

const BUCKET = process.env.BACKUP_BUCKET || "saasbuilder-backups"

// ── Vérification du token Firebase ──────────────────────────────
// Renvoie l'uid si le token est valide, sinon lève une erreur.
const verifyToken = async (idToken) => {
  if (!idToken) {
    const err = new Error("Non authentifié — idToken manquant")
    err.status = 401
    throw err
  }
  const decoded = await admin.auth().verifyIdToken(idToken)
  return decoded.uid
}

// ── Sérialisation Firestore-safe ─────────────────────────────────
// Convertit récursivement les types non supportés (Timestamp, etc.)
// en types JSON primitifs. Les strings ISO restent des strings :
// l'Admin SDK accepte les strings ISO dans set() sans problème.
const serialize = (data) => {
  if (data === null || data === undefined) return null
  if (Array.isArray(data)) return data.map(serialize)
  if (data && typeof data === "object") {
    // Firestore Timestamp → string ISO
    if (typeof data.toDate === "function") return data.toDate().toISOString()
    if (data._seconds !== undefined) return new Date(data._seconds * 1000).toISOString()
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, serialize(v)])
    )
  }
  return data
}

// ── Télécharger un backup depuis Cloud Storage ───────────────────
const downloadBackup = async (filename) => {
  const localPath = `/tmp/store_restore_${Date.now()}_${filename}`
  await getStorage()
    .bucket(BUCKET)
    .file(`backups/${filename}`)
    .download({ destination: localPath })
  const raw    = fs.readFileSync(localPath, "utf-8")
  const backup = JSON.parse(raw)
  fs.unlinkSync(localPath)   // nettoyage immédiat
  if (!backup.data) throw new Error("Format de backup invalide (champ 'data' manquant)")
  return backup
}

// ── Restauration filtrée par uid ─────────────────────────────────
// Renvoie { restored, skipped, detail } dans les deux modes.
// En mode dryRun : aucune écriture Firestore, comptage uniquement.
const restoreForUid = async (backup, uid, dryRun) => {
  const db     = getDb()
  const detail = { userData: 0, orders: 0, forders: 0, slugs: 0, prodinfos: 0 }
  let restored = 0
  let skipped  = 0

  // 1. Profil utilisateur : users/{uid}
  if (backup.data.users?.[uid]) {
    if (!dryRun) {
      await db.collection("users").doc(uid).set(
        serialize(backup.data.users[uid]),
        { merge: true }   // merge pour ne pas effacer des champs ajoutés après le backup
      )
    }
    detail.userData = 1
    restored++
  } else {
    skipped++
  }

  // 2. Commandes Pro (collection "orders"), filtrées par ownerUid
  const ownerOrders = Object.entries(backup.data.orders || {})
    .filter(([, d]) => d.ownerUid === uid)

  for (const [docId, data] of ownerOrders) {
    if (!dryRun) {
      await db.collection("orders").doc(docId).set(serialize(data), { merge: true })
    }
    detail.orders++
    restored++
  }

  // 3. Commandes Free (collection "forders"), filtrées par ownerUid
  const ownerForders = Object.entries(backup.data.forders || {})
    .filter(([, d]) => d.ownerUid === uid)

  for (const [docId, data] of ownerForders) {
    if (!dryRun) {
      await db.collection("forders").doc(docId).set(serialize(data), { merge: true })
    }
    detail.forders++
    restored++
  }

  // 4. Slugs publiés, filtrés par uid
  const ownerSlugs = Object.entries(backup.data.slugs || {})
    .filter(([, d]) => d.uid === uid)

  for (const [docId, data] of ownerSlugs) {
    if (!dryRun) {
      await db.collection("slugs").doc(docId).set(serialize(data), { merge: true })
    }
    detail.slugs++
    restored++
  }

  // 5. Infos produits (collection "prodinfos"), filtrées par ownerUid
  const ownerProdinfos = Object.entries(backup.data.prodinfos || {})
    .filter(([, d]) => d.ownerUid === uid)

  for (const [docId, data] of ownerProdinfos) {
    if (!dryRun) {
      await db.collection("prodinfos").doc(docId).set(serialize(data), { merge: true })
    }
    detail.prodinfos++
    restored++
  }

  return { restored, skipped, detail }
}

// ================================================================
//  Routes Express
// ================================================================
const storeRestoreRoutes = (app) => {

  // ── GET /api/store/backups ──────────────────────────────────────
  // Liste les backups disponibles (tout utilisateur connecté peut voir
  // la liste des noms ; le contenu ne leur est pas accessible).
  // Query param : ?idToken=<Firebase ID token>
  app.get("/api/store/backups", async (req, res) => {
    const { idToken } = req.query
    try {
      await verifyToken(idToken)  // authentification requise

      const bucket  = getStorage().bucket(BUCKET)
      const [files] = await bucket.getFiles({ prefix: "backups/" })

      const backups = files
        .filter(f => f.name.endsWith(".json"))
        .map(f => ({
          filename:  path.basename(f.name),
          size:      f.metadata.size,
          createdAt: f.metadata.timeCreated,
        }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 30)    // max 30 backups affichés

      res.json({ backups, count: backups.length })

    } catch (e) {
      console.error("❌ GET /api/store/backups:", e.message)
      res.status(e.status || 500).json({ error: e.message })
    }
  })

  // ── POST /api/store/restore ─────────────────────────────────────
  // Restaure les données de l'utilisateur connecté depuis un backup.
  // Body JSON :
  //   { idToken, filename, dryRun }
  //     idToken  : Firebase ID token (obligatoire)
  //     filename : nom du fichier backup, ex: "backup_2026-05-14T02-00-00.json"
  //     dryRun   : true (simulation, défaut) | false (écriture réelle)
  //
  // Réponse :
  //   { success, dryRun, uid, filename, restored, skipped, detail }
  //   detail : { userData, orders, forders, slugs, prodinfos }
  app.post("/api/store/restore", async (req, res) => {
    const { idToken, filename, dryRun = true } = req.body

    if (!filename) return res.status(400).json({ error: "filename requis" })

    // Sécurité : bloquer les tentatives de path traversal
    const safeName = path.basename(filename)
    if (safeName !== filename || !safeName.endsWith(".json")) {
      return res.status(400).json({ error: "Nom de fichier invalide" })
    }

    try {
      const uid = await verifyToken(idToken)

      console.log(`🔄 [store/restore] uid=${uid} | file=${safeName} | dryRun=${dryRun}`)

      const backup = await downloadBackup(safeName)
      const stats  = await restoreForUid(backup, uid, dryRun)

      console.log(
        `✅ [store/restore] uid=${uid} | restored=${stats.restored}` +
        ` | skipped=${stats.skipped} | dryRun=${dryRun}`
      )

      res.json({
        success:  true,
        dryRun,
        uid,
        filename: safeName,
        restored: stats.restored,
        skipped:  stats.skipped,
        detail:   stats.detail,
      })

    } catch (e) {
      console.error(`❌ [store/restore] ${e.message}`)
      res.status(e.status || 500).json({ error: e.message })
    }
  })

}

module.exports = { storeRestoreRoutes }
