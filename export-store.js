// ================================================================
//  export-store.js — Export JSON d'un store par ownerUid  (ESM)
//  Usage : node export-store.js <ownerUid>
//  Ou via API : GET /api/admin/export-store/:uid
// ================================================================

import admin from "firebase-admin"
import fs    from "fs"
import { fileURLToPath } from "url"

if (!admin.apps.length) {
  const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  admin.initializeApp({ credential: admin.credential.cert(SERVICE_ACCOUNT) })
}
const db = admin.firestore()

const serialize = (data) => {
  if (data === null || data === undefined) return null
  if (data?.toDate) return data.toDate().toISOString()
  if (data?.seconds) return new Date(data.seconds * 1000).toISOString()
  if (Array.isArray(data)) return data.map(serialize)
  if (typeof data === "object") {
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, serialize(v)]))
  }
  return data
}

export const exportStore = async (ownerUid) => {
  console.log(`📦 Export du store: ${ownerUid}`)

  const userDoc = await db.collection("users").doc(ownerUid).get()
  if (!userDoc.exists) throw new Error(`Utilisateur ${ownerUid} introuvable`)
  const userData = serialize(userDoc.data())

  const slugSnap  = await db.collection("slugs").where("uid", "==", ownerUid).get()
  const slugs     = slugSnap.docs.map(d => ({ id: d.id, ...serialize(d.data()) }))

  const ordersSnap = await db.collection("orders").where("ownerUid", "==", ownerUid).get()
  const orders     = ordersSnap.docs.map(d => ({ id: d.id, ...serialize(d.data()) }))

  const fordersSnap = await db.collection("forders").where("ownerUid", "==", ownerUid).get()
  const forders     = fordersSnap.docs.map(d => ({ id: d.id, ...serialize(d.data()) }))

  const prodSnap  = await db.collection("prodinfos").where("ownerUid", "==", ownerUid).get()
  const prodinfos = prodSnap.docs.map(d => ({ id: d.id, ...serialize(d.data()) }))

  const subSnap       = await db.collection("subscriptions").where("ownerUid", "==", ownerUid).get()
  const subscriptions = subSnap.docs.map(d => ({ id: d.id, ...serialize(d.data()) }))

  const exportData = {
    meta: {
      exportedAt:    new Date().toISOString(),
      ownerUid,
      siteName:      userData.siteName      || "",
      publishedSlug: userData.publishedSlug || "",
      plan:          userData.plan          || "free",
      version:       "1.0",
    },
    store: { user: userData, slugs, orders, forders, prodinfos, subscriptions },
    stats: {
      totalOrders: orders.length + forders.length,
      proOrders:   orders.length,
      freeOrders:  forders.length,
      revenue:     [...orders, ...forders].reduce((acc, o) => acc + parseFloat(o.total || 0), 0).toFixed(2),
    }
  }

  console.log(`✅ Export terminé — ${exportData.meta.siteName} | ${exportData.stats.totalOrders} commandes | ${exportData.stats.revenue} €`)
  return exportData
}

const ADMIN_EMAILS = ["musmamon@gmail.com", "musrh@gmail.com"]

export const exportStoreRoutes = (app) => {
  app.get("/api/admin/export-store/:uid", async (req, res) => {
    const { idToken } = req.query
    if (!idToken) return res.status(401).json({ error: "Non authentifié" })
    try {
      const decoded = await admin.auth().verifyIdToken(idToken)
      if (!ADMIN_EMAILS.includes(decoded.email?.toLowerCase()))
        return res.status(403).json({ error: "Non autorisé" })
    } catch(e) { return res.status(401).json({ error: "Token invalide" }) }
    try {
      const data     = await exportStore(req.params.uid)
      const filename = `store_${data.meta.publishedSlug || req.params.uid}_${Date.now()}.json`
      res.setHeader("Content-Type", "application/json")
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
      res.json(data)
    } catch(e) { res.status(500).json({ error: e.message }) }
  })

  app.get("/api/admin/export-all", async (req, res) => {
    const { idToken } = req.query
    if (!idToken) return res.status(401).json({ error: "Non authentifié" })
    try {
      const decoded = await admin.auth().verifyIdToken(idToken)
      if (!ADMIN_EMAILS.includes(decoded.email?.toLowerCase()))
        return res.status(403).json({ error: "Non autorisé" })
    } catch(e) { return res.status(401).json({ error: "Token invalide" }) }
    try {
      const usersSnap = await db.collection("users").get()
      const exports   = []
      for (const doc of usersSnap.docs) {
        try      { exports.push(await exportStore(doc.id)) }
        catch(e) { exports.push({ meta: { ownerUid: doc.id }, error: e.message }) }
      }
      res.json({ exportedAt: new Date().toISOString(), totalStores: exports.length, stores: exports })
    } catch(e) { res.status(500).json({ error: e.message }) }
  })
}

// ── Exécution directe ───────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const uid = process.argv[2]
  if (!uid) { console.error("Usage: node export-store.js <ownerUid>"); process.exit(1) }
  ;(async () => {
    try {
      const data     = await exportStore(uid)
      const filename = `store_${uid}_${Date.now()}.json`
      fs.writeFileSync(filename, JSON.stringify(data, null, 2))
      console.log(`💾 Sauvegardé dans: ${filename}`)
    } catch(e) { console.error("Erreur:", e.message); process.exit(1) }
  })()
}
