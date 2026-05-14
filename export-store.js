// ================================================================
//  export-store.js — Export JSON d'un store par ownerUid
//  Usage : node export-store.js <ownerUid>
//  Ou via API : GET /api/admin/export-store/:uid
// ================================================================

const admin = require("firebase-admin")
const fs    = require("fs")
const path  = require("path")

if (!admin.apps.length) {
  const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  admin.initializeApp({ credential: admin.credential.cert(SERVICE_ACCOUNT) })
}
const db = admin.firestore()

const ADMIN_EMAILS = ["musmamon@gmail.com", "musrh@gmail.com"]

// ── Sérialiser les types Firestore ───────────────────────────────
const serialize = (data) => {
  if (data === null || data === undefined) return null
  if (data?.toDate) return data.toDate().toISOString()
  if (data?.seconds) return new Date(data.seconds * 1000).toISOString()
  if (Array.isArray(data)) return data.map(serialize)
  if (typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, serialize(v)])
    )
  }
  return data
}

// ── Exporter un store complet ────────────────────────────────────
const exportStore = async (ownerUid) => {
  console.log(`📦 Export du store: ${ownerUid}`)

  // 1. Données utilisateur (siteData, siteTheme, plan...)
  const userDoc = await db.collection("users").doc(ownerUid).get()
  if (!userDoc.exists) throw new Error(`Utilisateur ${ownerUid} introuvable`)
  const userData = serialize(userDoc.data())

  // 2. Slug
  const slugSnap = await db.collection("slugs")
    .where("uid", "==", ownerUid).get()
  const slugs = slugSnap.docs.map(d => ({ id: d.id, ...serialize(d.data()) }))

  // 3. Commandes Pro (orders)
  const ordersSnap = await db.collection("orders")
    .where("ownerUid", "==", ownerUid).get()
  const orders = ordersSnap.docs.map(d => ({ id: d.id, ...serialize(d.data()) }))

  // 4. Commandes Free (forders)
  const fordersSnap = await db.collection("forders")
    .where("ownerUid", "==", ownerUid).get()
  const forders = fordersSnap.docs.map(d => ({ id: d.id, ...serialize(d.data()) }))

  // 5. Infos produits
  const prodSnap = await db.collection("prodinfos")
    .where("ownerUid", "==", ownerUid).get()
  const prodinfos = prodSnap.docs.map(d => ({ id: d.id, ...serialize(d.data()) }))

  // 6. Abonnement
  const subSnap = await db.collection("subscriptions")
    .where("ownerUid", "==", ownerUid).get()
  const subscriptions = subSnap.docs.map(d => ({ id: d.id, ...serialize(d.data()) }))

  // 7. Clients (customers) — ajouté pour cohérence avec backup.js
  const custSnap = await db.collection("customers")
    .where("ownerUid", "==", ownerUid).get()
  const customers = custSnap.docs.map(d => ({ id: d.id, ...serialize(d.data()) }))

  // ── Assembler l'export ──────────────────────────────────────
  const exportData = {
    meta: {
      exportedAt:    new Date().toISOString(),
      ownerUid,
      siteName:      userData.siteName      || "",
      publishedSlug: userData.publishedSlug || "",
      plan:          userData.plan          || "free",
      version:       "1.0",
    },
    store: {
      user:          userData,
      slugs,
      orders,
      forders,
      prodinfos,
      subscriptions,
      customers,
    },
    stats: {
      totalOrders:  orders.length + forders.length,
      proOrders:    orders.length,
      freeOrders:   forders.length,
      customers:    customers.length,
      revenue:      [...orders, ...forders]
        .reduce((acc, o) => acc + parseFloat(o.total || 0), 0)
        .toFixed(2),
    }
  }

  console.log(`✅ Export terminé:`)
  console.log(`   Site      : ${exportData.meta.siteName}`)
  console.log(`   Slug      : ${exportData.meta.publishedSlug}`)
  console.log(`   Plan      : ${exportData.meta.plan}`)
  console.log(`   Commandes : ${exportData.stats.totalOrders} (${exportData.stats.proOrders} Pro / ${exportData.stats.freeOrders} Free)`)
  console.log(`   Revenu    : ${exportData.stats.revenue} €`)

  return exportData
}

// ── Endpoint Express ────────────────────────────────────────────
const exportStoreRoutes = (app) => {

  const verifyAdmin = async (idToken) => {
    if (!idToken) throw Object.assign(new Error("Non authentifié"), { status: 401 })
    const decoded = await admin.auth().verifyIdToken(idToken)
    if (!ADMIN_EMAILS.includes(decoded.email?.toLowerCase())) {
      throw Object.assign(new Error("Non autorisé"), { status: 403 })
    }
  }

  // Export JSON d'un store
  app.get("/api/admin/export-store/:uid", async (req, res) => {
    try {
      await verifyAdmin(req.query.idToken)
      const data     = await exportStore(req.params.uid)
      const filename = `store_${data.meta.publishedSlug || req.params.uid}_${Date.now()}.json`
      res.setHeader("Content-Type", "application/json")
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
      res.json(data)
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message })
    }
  })

  // Export de TOUS les stores (admin global)
  app.get("/api/admin/export-all", async (req, res) => {
    try {
      await verifyAdmin(req.query.idToken)
      const usersSnap = await db.collection("users").get()
      const exports   = []
      for (const doc of usersSnap.docs) {
        try {
          const data = await exportStore(doc.id)
          exports.push(data)
        } catch (e) {
          exports.push({ meta: { ownerUid: doc.id }, error: e.message })
        }
      }
      res.json({
        exportedAt:  new Date().toISOString(),
        totalStores: exports.length,
        stores:      exports,
      })
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message })
    }
  })
}

// ── Exécution directe ───────────────────────────────────────────
if (require.main === module) {
  const uid = process.argv[2]
  if (!uid) {
    console.error("Usage: node export-store.js <ownerUid>")
    process.exit(1)
  }
  ;(async () => {
    try {
      const data     = await exportStore(uid)
      const filename = `store_${uid}_${Date.now()}.json`
      fs.writeFileSync(filename, JSON.stringify(data, null, 2))
      console.log(`💾 Sauvegardé dans: ${filename}`)
    } catch (e) {
      console.error("Erreur:", e.message)
      process.exit(1)
    }
  })()
}

module.exports = { exportStore, exportStoreRoutes }
