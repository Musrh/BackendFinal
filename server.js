// ===============================================================
//  server.js — Backend COMPLET SaasBuilder + SaasBuilder
//  Version fusionnée finale + Backup & Restore
//
//  SaasBuilder (abonnements) :
//    POST /create-billing-session   → abonnement propriétaire
//    POST /create-connect-account   → Stripe Connect
//    POST /force-upgrade            → debug upgrade plan
//
//  SaasBuilder (store clients) :
//    POST /create-stripe-session    → paiement client du store
//    POST /webhook                  → webhook Stripe (billing + store)
//
//  Assistant IA Groq :
//    POST /api/assistant            → chat Groq + contexte Firestore
//    POST /api/save-request         → requête non résolue
//    GET  /api/products/:storeUid   → catalogue produits
//    GET  /api/orders/:storeUid     → commandes
//    GET  /api/debug/:storeUid      → diagnostic produits
//
//  Backup & Restore (NOUVEAU) :
//    POST /api/admin/backup         → backup manuel (admin)
//    GET  /api/admin/backups        → liste des backups (admin)
//    GET  /api/admin/backup/:file   → télécharger un backup (admin)
//    POST /api/admin/restore        → restaurer toutes collections (admin)
//    GET  /api/store/backups        → liste des backups (user connecté)
//    POST /api/store/restore        → restaurer SES données uniquement
//
//  Variables d'env requises :
//    STRIPE_SECRET_KEY
//    STRIPE_WEBHOOK_SECRET
//    FIREBASE_SERVICE_ACCOUNT     (JSON stringify)
//    VITE_GROQ_API_KEY            (ou GROQ_API_KEY)
//    BACKUP_BUCKET                (ex: "saasbuilder-backups")  ← NOUVEAU
//    BACKUP_RETENTION_DAYS        (défaut: 30)                 ← NOUVEAU
// ===============================================================

import express    from "express"
import cors       from "cors"
import Stripe     from "stripe"
import dotenv     from "dotenv"
import bodyParser from "body-parser"
import Groq       from "groq-sdk"
import cron       from "node-cron"
import nodemailer from "nodemailer"

// ── Firebase Admin (singleton partagé) ───────────────────────
import admin, { db } from "./firebase-admin.js"

// ── Backup & Restore ──────────────────────────────────────────
import { backupRoutes, exportToJson, uploadToStorage, cleanOldBackups } from "./backup.js"
import { storeRestoreRoutes } from "./store-restore.js"
import { exportStoreRoutes }  from "./export-store.js"

dotenv.config()

const app  = express()
const PORT = process.env.PORT || 8080

app.use(cors({ origin: "*", methods: ["GET", "POST"] }))

// ── Stripe ────────────────────────────────────────────────────
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// ── Groq ──────────────────────────────────────────────────────
const groq = new Groq({
  apiKey: process.env.VITE_GROQ_API_KEY || process.env.GROQ_API_KEY || ""
})

// Un seul repo/domaine → toutes les URLs redirigent vers SaasBuilder
const FRONTEND           = "https://musrh.github.io/SaasBuilder"
const FRONTEND_BUILDER   = FRONTEND   // SaasBuilder (abonnements)
const FRONTEND_GENERATOR = FRONTEND   // SaasBuilder (stores clients)
// ===============================================================
//  ⚠️  WEBHOOK STRIPE — DOIT ÊTRE AVANT express.json()
// ===============================================================
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"]
  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error("❌ Webhook signature error:", err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  console.log("📨 EVENT TYPE:", event.type)

  if (event.type === "checkout.session.completed") {
    const session = event.data.object
    console.log("🎯 SESSION ID:", session.id, "| payment_status:", session.payment_status)

    if (session.payment_status === "paid") {

      // ── Parser metadata (supporte 2 formats) ──────────────
      // Format 1 (nouveau) : metadata.data = JSON stringifié
      // Format 2 (ancien)  : metadata.type, .ownerUid directs
      let metadata = {}
      try {
        if (session.metadata?.data) {
          // Format nouveau : JSON stringifié
          metadata = JSON.parse(session.metadata.data)
        } else {
          // Format ancien : champs directs
          metadata = { ...session.metadata }
        }
        console.log("📦 METADATA final:", JSON.stringify(metadata))
      } catch (e) {
        // Fallback : utiliser les champs directs
        metadata = { ...session.metadata }
        console.warn("⚠️ Parse metadata JSON échoué, utilisation directe:", metadata)
      }

      // ── Résoudre l'UID du propriétaire (plusieurs champs possibles) ──
      // Firestore users a : ownerId, uid, ownerUid, storeId
      const ownerUid =
        metadata.ownerUid ||
        metadata.ownerId  ||
        metadata.uid      ||
        metadata.storeId  ||
        session.client_reference_id || ""

      console.log("🔑 ownerUid résolu:", ownerUid || "⚠️ VIDE!")
      console.log("📋 type:", metadata.type, "| plan:", metadata.plan)

      // ── ABONNEMENT SAAS BUILDER ──────────────────────────
      if (metadata.type === "billing") {
        console.log("✅ Type billing — plan:", metadata.plan, "| uid:", ownerUid)

        // Écrire dans subscriptions
        try {
          await db.collection("subscriptions").doc(session.id).set({
            email:     session.customer_email,
            plan:      metadata.plan || "pro",
            ownerUid:  ownerUid,
            status:    "active",
            paidAt:    new Date().toISOString(),
            sessionId: session.id,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          })
          console.log("✅ Subscription écrite")
        } catch (e) { console.error("❌ subscription:", e.message) }

        // Mettre à jour le document user (cherche via ownerUid ET ownerId)
        if (ownerUid) {
          // Chercher d'abord directement
          const userRef = db.collection("users").doc(ownerUid)
          let userSnap  = await userRef.get().catch(() => null)

          // Si pas trouvé par uid direct, chercher par champ ownerId ou uid
          if (!userSnap?.exists) {
            try {
              const q = await db.collection("users")
                .where("ownerId", "==", ownerUid).limit(1).get()
              if (!q.empty) {
                const foundDoc = q.docs[0]
                await foundDoc.ref.set({
                  plan:               metadata.plan || "pro",
                  paye:               true,
                  subscriptionActive: true,
                  active:             true,
                  expiry:             Date.now() + 30 * 24 * 60 * 60 * 1000,
                  updatedAt:          Date.now(),
                }, { merge: true })
                console.log("🔥 USER PASSÉ EN PRO + RÉACTIVÉ (via ownerId):", foundDoc.id)
              } else {
                // Chercher par champ uid
                const q2 = await db.collection("users")
                  .where("uid", "==", ownerUid).limit(1).get()
                if (!q2.empty) {
                  await q2.docs[0].ref.set({
                    plan:               metadata.plan || "pro",
                    paye:               true,
                    subscriptionActive: true,
                    active:             true,
                    expiry:             Date.now() + 30 * 24 * 60 * 60 * 1000,
                    updatedAt:          Date.now(),
                  }, { merge: true })
                  console.log("🔥 USER PASSÉ EN PRO + RÉACTIVÉ (via uid field):", q2.docs[0].id)
                } else {
                  console.error("❌ USER INTROUVABLE pour ownerUid:", ownerUid)
                }
              }
            } catch(eq) { console.error("❌ query user:", eq.message) }
          } else {
            // Trouvé directement — mettre à jour
            try {
              await userRef.set({
                plan:               metadata.plan || "pro",
                paye:               true,
                subscriptionActive: true,
                active:             true,
                expiry:             Date.now() + 30 * 24 * 60 * 60 * 1000,
                updatedAt:          Date.now(),
              }, { merge: true })
              console.log("🔥 USER PASSÉ EN PRO + RÉACTIVÉ (direct):", ownerUid)
            } catch (e) { console.error("❌ update user direct:", e.message) }
          }
        } else {
          // ownerUid vide — chercher par email
          try {
            const q = await db.collection("users")
              .where("email", "==", session.customer_email).limit(1).get()
            if (!q.empty) {
              await q.docs[0].ref.set({
                plan:               metadata.plan || "pro",
                paye:               true,
                subscriptionActive: true,
                active:             true,
                expiry:             Date.now() + 30 * 24 * 60 * 60 * 1000,
                updatedAt:          Date.now(),
              }, { merge: true })
              console.log("🔥 USER PASSÉ EN PRO + RÉACTIVÉ (via email):", q.docs[0].id)
            } else {
              console.error("❌ USER INTROUVABLE via email:", session.customer_email)
            }
          } catch(em) { console.error("❌ query by email:", em.message) }
        }
      }

      // ── COMMANDE STORE (PAIEMENT CLIENT) ─────────────────
      // Routing : plan Pro/Premium → orders | plan Free → forders
      if (metadata.type === "store_payment") {
        try {
          const isPro          = metadata.plan === "pro" || metadata.plan === "premium"
          const rootCollection = isPro ? "orders" : "forders"

          // Normaliser les items : {nom/prix/quantity} → {name/price/qty}
          const rawItems = metadata.items || []
          const normItems = rawItems.map(i => ({
            name:     i.name     || i.nom  || "Produit",
            price:    i.price    !== undefined ? i.price : (i.prix !== undefined ? String(i.prix) : "0"),
            qty:      i.qty      || i.quantity || 1,
            currency: i.currency || metadata.currency || "€",
            image:    i.image    || "",
          }))

          const orderData = {
            customerEmail:    session.customer_email || metadata.email || "",
            customerName:     metadata.customerName || "",
            customerAddress:  metadata.adresseLivraison || metadata.customerAddress || "",
            email:            session.customer_email || metadata.email || "",
            items:            normItems,
            total:            (session.amount_total || 0) / 100,
            currency:         metadata.currency || "€",
            ownerUid:         metadata.ownerUid || "",
            clientId:         metadata.clientId  || "",
            siteSlug:         metadata.siteSlug  || "",
            storeName:        metadata.storeName || "",
            plan:             metadata.plan      || "free",
            status:           "paid",
            provider:         "stripe",
            createdAt:        new Date().toISOString(),
          }

          // ── Collection racine : orders (Pro) ou forders (Free) ──
          await db.collection(rootCollection).doc(session.id).set(orderData)
          console.log(`🛒 COMMANDE STORE [${rootCollection}] OK:`, session.id, "| plan:", metadata.plan)
        } catch (e) { console.error("❌ commande store:", e.message) }
      }
    }
  }

  res.json({ received: true })
})
// ── JSON middleware (après webhook) ───────────────────────────
app.use(express.json())
// ===============================================================
//  UTILITAIRES FIRESTORE
// ===============================================================

// Charger les produits depuis toutes les sources disponibles
const getProduits = async (storeUid) => {
  try {
    let results = []

    // Helper : normaliser un doc produit (gère nom/prix/desc et name/price/description)
    const normalize = (p, src) => ({
      id:          p.id          || String(p.name || p.nom || ""),
      name:        p.name        || p.nom         || "Produit",
      price:       p.price       !== undefined ? p.price : (p.prix !== undefined ? p.prix : 0),
      description: p.description || p.desc        || "",
      stock:       p.stock       !== undefined ? p.stock : "disponible",
      currency:    p.currency    || p.devise       || "€",
      badge:       p.badge       || "",
      storeUid:    p.storeUid    || storeUid       || "",
      source:      src           || "collection",
    })

    const addIfNew = (raw, src) => {
      const n = normalize(raw, src)
      if (n.name && !results.find(r => r.name === n.name)) results.push(n)
    }

    // ── SOURCE 1 : siteData du store (PRINCIPALE) ─────────────
    // Les produits affichés dans le store builder viennent de ici
    if (storeUid) {
      try {
        const userDoc = await db.collection("users").doc(storeUid).get()
        if (userDoc.exists) {
          const siteData = userDoc.data().siteData
          ;(siteData?.pages || []).forEach(page => {
            ;(page.sections || []).forEach(section => {
              if (section.type === "products" && Array.isArray(section.items)) {
                section.items.forEach(p => addIfNew(p, "siteData"))
              }
            })
          })
          console.log(`📦 siteData(${storeUid}): ${results.length} produits`)
        }
      } catch(e) { console.warn("siteData:", e.message) }
    }

    // ── SOURCE 2 : prodinfos filtré par storeUid ──────────────
    if (storeUid) {
      try {
        const snap = await db.collection("prodinfos")
          .where("storeUid", "==", storeUid).limit(100).get()
        snap.docs.forEach(d => addIfNew({ id: d.id, ...d.data() }, "prodinfos"))
        console.log(`📦 prodinfos(${storeUid}): ${snap.docs.length} docs`)
      } catch(e) { console.warn("prodinfos filtré:", e.message) }
    }

    // ── SOURCE 3 : prodinfos GLOBAL (sans filtre storeUid) ────
    // Cas où storeUid n'est pas encore dans prodinfos
    if (results.length === 0) {
      try {
        const snap = await db.collection("prodinfos").limit(100).get()
        snap.docs.forEach(d => addIfNew({ id: d.id, ...d.data() }, "prodinfos-global"))
        console.log(`📦 prodinfos(global): ${snap.docs.length} docs`)
      } catch(e) { console.warn("prodinfos global:", e.message) }
    }

    // ── SOURCE 4 : products filtré par storeUid ───────────────
    if (storeUid) {
      try {
        const snap = await db.collection("products")
          .where("storeUid", "==", storeUid).limit(100).get()
        snap.docs.forEach(d => addIfNew({ id: d.id, ...d.data() }, "products"))
        console.log(`📦 products(${storeUid}): ${snap.docs.length} docs`)
      } catch(e) { console.warn("products:", e.message) }
    }

    // ── SOURCE 5 : products GLOBAL ────────────────────────────
    if (results.length === 0) {
      try {
        const snap = await db.collection("products").limit(50).get()
        snap.docs.forEach(d => addIfNew({ id: d.id, ...d.data() }, "products-global"))
        console.log(`📦 products(global): ${snap.docs.length} docs`)
      } catch(e) { console.warn("products global:", e.message) }
    }

    console.log(`✅ TOTAL ${results.length} produits pour storeUid=${storeUid || "global"}`)
    return results
  } catch (e) {
    console.error("❌ getProduits:", e.message)
    return []
  }
}
// Charger les commandes (cmdinfos + orders)
const getCmdinfos = async (storeUid, { nom, email, date } = {}) => {
  try {
    let results = []

    // cmdinfos par storeUid
    if (storeUid) {
      try {
        let q = db.collection("cmdinfos")
        if (email) q = q.where("clientEmail", "==", email.trim().toLowerCase())
        else if (nom) q = q.where("customerName", "==", nom)
        else q = q.where("storeUid", "==", storeUid)
        const snap = await q.limit(20).get()
        results = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        console.log(`📋 cmdinfos: ${results.length}`)
      } catch(e) { console.warn("cmdinfos:", e.message) }
    }

    // orders (Pro) + forders (Free) par clientId ou email
    if (!results.length) {
      for (const col of ["orders", "forders"]) {
        try {
          let q = db.collection(col)
          if (email) q = q.where("email", "==", email.trim().toLowerCase())
          else if (storeUid) q = q.where("ownerUid", "==", storeUid)
          const snap = await q.limit(20).get()
          const ids  = new Set(results.map(r => r.id))
          const docs = snap.docs
            .filter(d => !ids.has(d.id))
            .map(d => ({
              id: d.id, ...d.data(),
              customerName:  d.data().customerName  || d.data().name  || "",
              customerEmail: d.data().customerEmail || d.data().email || "",
              _source: col,
            }))
          results = [...results, ...docs]
          console.log(`📋 ${col}: ${docs.length} commandes`)
        } catch(e) { console.warn(`${col} fallback:`, e.message) }
      }
    }

    // users/{storeUid}/orders
    if (storeUid) {
      try {
        let q = db.collection("users").doc(storeUid).collection("orders")
        if (email) q = q.where("customerEmail", "==", email.trim().toLowerCase())
        const snap = await q.limit(20).get()
        const ids  = new Set(results.map(r => r.id))
        snap.docs.filter(d => !ids.has(d.id)).forEach(d =>
          results.push({ id: d.id, ...d.data() })
        )
      } catch(e) { console.warn("users/orders:", e.message) }
    }

    // Filtres
    if (nom)  results = results.filter(r => (r.customerName||"").toLowerCase().includes(nom.toLowerCase()))
    if (date) results = results.filter(r => String(r.createdAt||"").includes(date))
    if (email) results = results.filter(r =>
      (r.customerEmail||r.email||"").toLowerCase() === email.trim().toLowerCase()
    )

    return results
  } catch(e) {
    console.error("❌ getCmdinfos:", e.message)
    return []
  }
}
// Sauvegarder une requête non résolue
const saveRequete = async (storeUid, data) => {
  try {
    const ref = await db.collection("requetes").add({
      storeUid:  storeUid  || "unknown",
      nom:       data.nom       || "",
      email:     data.email     || "",
      telephone: data.telephone || "",
      adresse:   data.adresse   || "",
      question:  data.question  || "",
      status:    "nouveau",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    return ref.id
  } catch (e) {
    console.error("❌ saveRequete:", e.message)
    return null
  }
}
// Construire le contexte produits pour le prompt Groq
const buildProduitsContext = (produits) => {
  if (!produits.length) return "Aucun produit disponible dans le catalogue."
  return produits.map(p => {
    const price = p.price !== undefined && p.price !== null ? p.price : p.prix
    const priceFmt = price !== undefined && price !== null
      ? `${price}${p.currency || p.devise || "€"}`
      : "prix non défini"
    const desc  = p.description || p.desc || ""
    const badge = p.badge ? `[${p.badge}]` : ""
    const stock = p.stock !== undefined && p.stock !== "disponible" ? ` | stock: ${p.stock}` : ""
    return `- ${p.name || p.nom} ${badge} | Prix: ${priceFmt}${desc ? " | " + desc : ""}${stock}`
  }).join("\n")
}
// Construire le contexte commandes pour le prompt Groq
const buildCmdContext = (cmds) => {
  if (!cmds.length) return "Aucune commande trouvée."
  const statuts = {
    pending:      "En attente",
    paid:         "Payée — en cours de traitement",
    shipped:      "Expédiée",
    delivered:    "Livrée",
    cancelled:    "Annulée",
    info_needed:  "Renseignements requis",
  }
  return cmds.map(c => {
    const statut = statuts[c.status] || c.status || "Inconnu"
    const date   = c.createdAt?.toDate?.()?.toLocaleDateString("fr-FR") || c.createdAt || "N/A"
    const items  = (c.items || []).map(i => `${i.name || i.nom} ×${i.qty || 1}`).join(", ")
    return `Commande #${(c.id||"").slice(0,8).toUpperCase()} | Date: ${date} | Articles: ${items || "N/A"} | Total: ${c.total || c.montant || "N/A"}€ | Statut: ${statut} | Livraison: ${c.customerAddress || c.adresseLivraison || "non renseignée"}`
  }).join("\n")
}
// ===============================================================
//  POST /api/assistant — Chat Groq + contexte Firestore
// ===============================================================
app.post("/api/assistant", async (req, res) => {
  const {
    message,
    history    = [],
    storeUid,
    storeEmail,
    storeName,
    lang       = "fr",
    clientInfo = {}
  } = req.body

  if (!message) return res.status(400).json({ error: "message requis" })

  try {
    console.log(`🤖 Assistant | storeUid=${storeUid} | lang=${lang} | msg="${message.slice(0,60)}"`)

    const [produits, cmds] = await Promise.all([
      getProduits(storeUid),
      (clientInfo.email || clientInfo.nom)
        ? getCmdinfos(storeUid, clientInfo)
        : Promise.resolve([]),
    ])
    console.log(`📊 Contexte: ${produits.length} produits, ${cmds.length} commandes`)

    const produitsCtx = buildProduitsContext(produits)
    const cmdsCtx     = cmds.length ? buildCmdContext(cmds) : ""

    const langLabel = { fr: "français", ar: "arabe", es: "espagnol", en: "anglais" }[lang] || "français"

    const systemPrompt = `
Tu es l'assistant IA du store "${storeName || "notre boutique"}".
Tu aides les clients. Tu réponds en ${langLabel}. Sois chaleureux, professionnel et concis.

=== CATALOGUE PRODUITS ===
${produitsCtx}

=== COMMANDES DU CLIENT ===
${cmdsCtx || "Aucune commande chargée. Si le client demande sa commande, invite-le à fournir son email et sa date de commande."}

=== RÈGLES ===
1. Pour les PRODUITS : informe sur prix, description, disponibilité depuis le catalogue ci-dessus.
2. Pour les COMMANDES : demande nom + email + date si pas fournis.
3. Si tu ne trouves PAS la réponse : réponds exactement :
   {"action":"SHOW_REQUEST_FORM","reason":"[raison]"}
4. Pour sauvegarder une requête : réponds exactement :
   {"action":"SAVE_REQUEST","data":{"nom":"...","email":"...","telephone":"...","question":"..."}}
5. Ne jamais inventer des prix ou informations absents du catalogue.
6. Email du store : ${storeEmail || "contactez-nous via le formulaire"}
`.trim()

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.slice(-8),
      { role: "user",   content: message },
    ]

    const completion = await groq.chat.completions.create({
      model:       "llama-3.3-70b-versatile",
      messages,
      temperature: 0.4,
      max_tokens:  600,
    })

    const reply = completion.choices[0]?.message?.content?.trim() || ""

    // Détecter actions JSON
    let action = null, actionData = null, cleanReply = reply
    const jsonMatch = reply.match(/\{[\s\S]*?"action"[\s\S]*?\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        action     = parsed.action
        actionData = parsed.data || { reason: parsed.reason }
        cleanReply = reply.replace(jsonMatch[0], "").trim()
        if (!cleanReply) {
          const fallbacks = {
            fr: "Je ne trouve pas la réponse dans notre système. Laissez-moi noter vos coordonnées pour qu'un conseiller vous rappelle.",
            en: "I can't find the answer. Let me take your details so an advisor can call you back.",
            ar: "لم أجد الإجابة. دعني أسجل معلوماتك لكي يتصل بك أحد المستشارين.",
            es: "No encuentro la respuesta. Déjame tomar tus datos para que un asesor te llame.",
          }
          cleanReply = fallbacks[lang] || fallbacks.fr
        }
      } catch(e) { /* JSON invalide, garder reply brut */ }
    }

    // Sauvegarder requête si demandé
    if (action === "SAVE_REQUEST" && actionData) {
      await saveRequete(storeUid, actionData)
    }

    res.json({
      reply:      cleanReply || reply,
      action,
      actionData,
      debug: {
        produitsCount: produits.length,
        cmdsCount:     cmds.length,
        storeUid,
      }
    })

  } catch (e) {
    console.error("❌ /api/assistant:", e.message)
    res.status(500).json({ error: "Erreur assistant: " + e.message })
  }
})
// ===============================================================
//  POST /api/save-request — Sauvegarder requête non résolue
// ===============================================================
app.post("/api/save-request", async (req, res) => {
  const { storeUid, nom, email, telephone, adresse, question } = req.body
  try {
    const id = await saveRequete(storeUid, { nom, email, telephone, adresse, question })
    res.json({ ok: true, id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})
// ===============================================================
//  GET /api/debug/:storeUid — Diagnostic assistant
// ===============================================================
app.get("/api/debug/:storeUid", async (req, res) => {
  const { storeUid } = req.params
  try {
    const produits = await getProduits(storeUid)
    res.json({
      storeUid,
      count:         produits.length,
      produits:      produits.map(p => ({ name: p.name, price: p.price, source: p.source })),
      promptInjecte: buildProduitsContext(produits),
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})
// ===============================================================
//  GET /api/products/:storeUid
// ===============================================================
app.get("/api/products/:storeUid", async (req, res) => {
  const produits = await getProduits(req.params.storeUid)
  res.json({ produits, count: produits.length })
})
// ===============================================================
//  GET /api/orders/:storeUid  — Commandes Pro (collection orders)
// ===============================================================
app.get("/api/orders/:storeUid", async (req, res) => {
  const { email, nom, date } = req.query
  const storeUid = req.params.storeUid
  try {
    let q = db.collection("orders").where("ownerUid", "==", storeUid)
    if (email) q = q.where("email", "==", email.trim().toLowerCase())
    const snap = await q.orderBy("createdAt", "desc").limit(50).get()
    const commandes = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    res.json({ commandes, count: commandes.length, plan: "pro" })
  } catch(e) {
    const cmds = await getCmdinfos(storeUid, { email, nom, date })
    res.json({ commandes: cmds, count: cmds.length })
  }
})
// ===============================================================
//  GET /api/forders/:storeUid  — Commandes Free (collection forders)
// ===============================================================
app.get("/api/forders/:storeUid", async (req, res) => {
  const { email, nom, date } = req.query
  const storeUid = req.params.storeUid
  try {
    let q = db.collection("forders").where("ownerUid", "==", storeUid)
    if (email) q = q.where("email", "==", email.trim().toLowerCase())
    const snap = await q.orderBy("createdAt", "desc").limit(50).get()
    let commandes = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    if (nom)  commandes = commandes.filter(c => (c.storeName||"").toLowerCase().includes(nom.toLowerCase()))
    if (date) commandes = commandes.filter(c => String(c.createdAt||"").includes(date))
    res.json({ commandes, count: commandes.length, plan: "free" })
  } catch(e) {
    console.error("❌ /api/forders:", e.message)
    res.status(500).json({ error: e.message })
  }
})
// ===============================================================
//  POST /create-stripe-session — Paiement client du store
// ===============================================================
// Convertir symbole devise → code ISO Stripe
const normalizeCurrency = (raw) => {
  if (!raw) return "eur"
  const str = String(raw).trim().toLowerCase()
  // Déjà un code ISO valide (3 lettres)
  if (/^[a-z]{3}$/.test(str)) return str
  // Mapper les symboles courants
  const map = {
    "€": "eur", "$": "usd", "£": "gbp",
    "¥": "jpy", "₣": "chf", "＄": "usd",
    "د.م.": "mad", "dh": "mad", "mad": "mad",
    "cad": "cad", "aud": "aud", "chf": "chf",
    "dz": "dzd", "tn": "tnd",
  }
  return map[str] || map[raw.trim()] || "eur"  // fallback eur
}


// ================================================================
//  POST /api/contact — Formulaire de contact → email propriétaire
//  Variables requises : SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
// ================================================================
app.post("/api/contact", async (req, res) => {
  const { name, email, message, storeUid, siteSlug } = req.body
  if (!name || !email || !message || !storeUid)
    return res.status(400).json({ error: "Champs manquants" })

  // Sauvegarder en Firestore d'abord (toujours)
  try {
    await db.collection("users").doc(storeUid)
      .collection("contacts").add({
        name, email, message,
        siteSlug: siteSlug || storeUid,
        status:   "nouveau",
        createdAt: new Date().toISOString(),
      })
  } catch(e) {
    console.error("/api/contact Firestore:", e.message)
  }

  // Envoyer par email via Brevo API (HTTP, pas SMTP — fonctionne sur Railway)
  const brevoKey = process.env.BREVO_API_KEY
  if (!brevoKey) {
    console.warn("/api/contact: BREVO_API_KEY non configuré — message sauvegardé en Firestore uniquement")
    return res.json({ success: true, emailSent: false })
  }

  try {
    const userSnap   = await db.collection("users").doc(storeUid).get()
    const ownerEmail = userSnap.exists ? userSnap.data().email : null
    const siteName   = userSnap.exists ? (userSnap.data().siteName || siteSlug || storeUid) : storeUid

    if (!ownerEmail) {
      console.warn("/api/contact: email propriétaire absent — email non envoyé")
      return res.json({ success: true, emailSent: false })
    }

    const senderEmail = process.env.BREVO_SENDER_EMAIL || process.env.SMTP_USER || "noreply@onlinestores.com"
    const senderName  = process.env.BREVO_SENDER_NAME  || "OnlineStores"

    const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key":      brevoKey,
      },
      body: JSON.stringify({
        sender:      { name: senderName, email: senderEmail },
        to:          [{ email: ownerEmail }],
        replyTo:     { email, name },
        subject:     `Nouveau message de contact — ${siteName}`,
        htmlContent: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
          <div style="background:#6c63ff;padding:24px 28px;border-radius:12px 12px 0 0">
            <h2 style="color:white;margin:0;font-size:20px">Nouveau message de contact</h2>
            <p style="color:rgba(255,255,255,.8);margin:6px 0 0;font-size:14px">Via ${siteName}</p>
          </div>
          <div style="padding:28px;background:white;border-radius:0 0 12px 12px;border:1px solid #e5e7eb">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;font-size:13px;color:#6b7280;width:80px">Nom</td><td style="font-size:15px;font-weight:600">${name}</td></tr>
              <tr><td style="padding:8px 0;font-size:13px;color:#6b7280">Email</td><td><a href="mailto:${email}" style="color:#6c63ff">${email}</a></td></tr>
            </table>
            <div style="margin-top:20px;padding:16px;background:#f9fafb;border-radius:8px;border-left:3px solid #6c63ff">
              <p style="margin:0;font-size:13px;color:#6b7280;margin-bottom:8px">Message :</p>
              <p style="margin:0;font-size:15px;line-height:1.7;white-space:pre-wrap">${message}</p>
            </div>
            <p style="margin-top:20px;font-size:12px;color:#9ca3af;text-align:center">
              Recu le ${new Date().toLocaleString("fr-FR")} — Repondez directement a cet email.
            </p>
          </div>
        </div>`,
        textContent: `Nouveau message — ${siteName}\n\nNom: ${name}\nEmail: ${email}\n\n${message}`,
      }),
    })

    if (!brevoRes.ok) {
      const errBody = await brevoRes.text()
      throw new Error(`Brevo ${brevoRes.status}: ${errBody}`)
    }

    console.log(`Email contact envoye via Brevo a ${ownerEmail} (store: ${storeUid})`)
    res.json({ success: true, emailSent: true })

  } catch(e) {
    console.error("/api/contact email:", e.message)
    // Firestore a déjà sauvegardé → succès quand même
    res.json({ success: true, emailSent: false, emailError: e.message })
  }
})

app.post("/create-store-session", async (req, res) => {
  try {
    let {
      items, email, adresseLivraison, clientId,
      siteSlug, ownerUid, storeUid, plan, storeName,
      successUrl, cancelUrl, currency, description,
    } = req.body

    // ownerUid peut aussi venir sous storeUid
    ownerUid = ownerUid || storeUid || clientId || ""

    console.log("📦 create-store-session — items:", items?.length, "| email:", email, "| ownerUid:", ownerUid)

    items = (items || []).map(item => ({
      nom:      item.nom      || item.name  || item.title || "Produit",
      prix:     parseFloat(item.prix || item.price || item.unit_amount || 0),
      quantity: item.quantity || item.qty   || 1,
      currency: item.currency || item.devise || currency || "€",
    }))

    if (!items.length) return res.status(400).json({ error: "Panier vide" })

    // Devise ISO depuis le premier item ou le paramètre currency
    const rawCurrency = items[0]?.currency || currency || "eur"
    const stripeCurrency = normalizeCurrency(rawCurrency)
    console.log(`💱 Devise: "${rawCurrency}" → Stripe: "${stripeCurrency}"`)

    // Vérifier que les prix sont valides
    const invalidItem = items.find(i => !i.prix || i.prix <= 0)
    if (invalidItem) return res.status(400).json({ error: `Prix invalide pour: ${invalidItem.nom}` })

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email || undefined,
      line_items: items.map(item => ({
        price_data: {
          currency:     stripeCurrency,
          product_data: { name: item.nom },
          unit_amount:  Math.round(item.prix * 100),
        },
        quantity: item.quantity,
      })),
      mode: "payment",
      success_url: successUrl || `${FRONTEND_GENERATOR}/`,
      cancel_url:  cancelUrl  || `${FRONTEND_GENERATOR}/`,
      metadata: {
        data: JSON.stringify({
          type:             "store_payment",
          items:            items.map(i => ({ nom: i.nom, prix: i.prix, quantity: i.quantity })),
          adresseLivraison: adresseLivraison || "",
          email:            email            || "",
          clientId:         clientId         || ownerUid,
          siteSlug:         siteSlug         || "",
          ownerUid:         ownerUid,
          plan:             plan             || "basic",
          storeName:        storeName        || "",
          currency:         stripeCurrency,
        }),
      },
    })

    console.log("🧾 Stripe session OK:", session.id)
    res.json({ url: session.url })

  } catch (err) {
    console.error("❌ create-store-session:", err.message)
    res.status(500).json({ error: err.message, details: err.message })
  }
})
// ===============================================================
//  POST /create-stripe-session — Alias de create-store-session
//  (SiteViewer appelle cfg.backendUrl qui pointe vers cette route)
// ===============================================================
app.post("/create-stripe-session", async (req, res, next) => {
  // Même logique que /create-store-session
  req.url = "/create-store-session"
  // Re-router vers create-store-session
  app._router.handle(req, res, next)
})
// ===============================================================
//  POST /create-billing-session — Abonnement SaasBuilder
// ===============================================================
app.post("/create-billing-session", async (req, res) => {
  try {
    const { email, plan, ownerUid } = req.body
    if (!ownerUid) return res.status(400).json({ error: "ownerUid requis" })

    const prices = { basic: 0, pro: 1000 }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: `Abonnement ${plan || "pro"}` },
          unit_amount: prices[plan] || 1000,
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url: `${FRONTEND_BUILDER}/#/dashboard?success=true`,
      cancel_url:  `${FRONTEND_BUILDER}/#/dashboard`,
      metadata: {
        // Format JSON stringifié (nouveau standard)
        data: JSON.stringify({
          type:     "billing",
          plan:     plan      || "pro",
          ownerUid: ownerUid,
          ownerId:  ownerUid,   // compat champ Firestore ownerId
          uid:      ownerUid,   // compat champ Firestore uid
        }),
        // Champs directs en backup (ancien format)
        type:     "billing",
        ownerUid: ownerUid,
        ownerId:  ownerUid,
        plan:     plan || "pro",
      },
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error("❌ create-billing-session:", err.message)
    res.status(500).json({ error: err.message })
  }
})
// ===============================================================
//  POST /force-upgrade — Debug : forcer upgrade plan (test)
// ===============================================================
app.post("/force-upgrade", async (req, res) => {
  const { ownerUid, ownerId, uid, email, plan } = req.body
  // Accepter n'importe quel champ UID
  const targetUid = ownerUid || ownerId || uid
  const targetPlan = plan || "pro"

  if (!targetUid && !email) return res.status(400).json({ error: "ownerUid ou email requis" })

  try {
    const update = { plan: targetPlan, paye: true, subscriptionActive: true, expiry: Date.now() + 30 * 24 * 60 * 60 * 1000, updatedAt: Date.now() }

    if (targetUid) {
      // 1. Essai direct par document ID
      const ref  = db.collection("users").doc(targetUid)
      const snap = await ref.get()

      if (snap.exists) {
        await ref.set(update, { merge: true })
        console.log("✅ force-upgrade OK (direct):", targetUid, "→", targetPlan)
        return res.json({ ok: true, method: "direct", uid: targetUid, plan: targetPlan })
      }

      // 2. Chercher par champ ownerId
      const q1 = await db.collection("users").where("ownerId", "==", targetUid).limit(1).get()
      if (!q1.empty) {
        await q1.docs[0].ref.set(update, { merge: true })
        return res.json({ ok: true, method: "ownerId", uid: q1.docs[0].id, plan: targetPlan })
      }

      // 3. Chercher par champ uid
      const q2 = await db.collection("users").where("uid", "==", targetUid).limit(1).get()
      if (!q2.empty) {
        await q2.docs[0].ref.set(update, { merge: true })
        return res.json({ ok: true, method: "uid-field", uid: q2.docs[0].id, plan: targetPlan })
      }
    }

    // 4. Chercher par email
    if (email) {
      const qe = await db.collection("users").where("email", "==", email).limit(1).get()
      if (!qe.empty) {
        await qe.docs[0].ref.set(update, { merge: true })
        return res.json({ ok: true, method: "email", uid: qe.docs[0].id, plan: targetPlan })
      }
    }

    return res.status(404).json({ error: "Utilisateur introuvable", targetUid, email })
  } catch (err) {
    console.error("❌ force-upgrade:", err.message)
    res.status(500).json({ error: err.message })
  }
})
// ===============================================================
//  POST /create-connect-account — Stripe Connect
// ===============================================================
app.post("/create-connect-account", async (req, res) => {
  try {
    const { ownerUid, email } = req.body
    const userRef = db.collection("users").doc(ownerUid)
    const userDoc = await userRef.get()
    let accountId = userDoc.exists && userDoc.data().stripeAccountId
      ? userDoc.data().stripeAccountId
      : null

    if (!accountId) {
      const account = await stripe.accounts.create({ type: "express", email })
      accountId = account.id
    }

    // Toujours marquer stripeVerified: false quand le propriétaire (re)configure
    // L'admin SaaS devra vérifier dans Stripe et activer manuellement
    await userRef.set({
      stripeAccountId: accountId,
      stripeVerified:  false,          // ← en attente de vérification admin
      stripeSubmittedAt: Date.now(),   // ← date de soumission
    }, { merge: true })

    const link = await stripe.accountLinks.create({
      account:     accountId,
      refresh_url: `${FRONTEND_BUILDER}/#/reauth`,
      return_url:  `${FRONTEND_BUILDER}/#/dashboard?stripe=pending`,
      type:        "account_onboarding",
    })

    console.log(`🔗 Stripe Connect soumis: ${ownerUid} | account: ${accountId}`)
    res.json({ url: link.url })
  } catch (err) {
    console.error("❌ create-connect-account:", err.message)
    res.status(500).json({ error: err.message })
  }
})
// ===============================================================
//  POST /api/admin/verify-stripe — Vérifier et activer Stripe d'un propriétaire
//  Appelé par l'admin SaaS après vérification dans le dashboard Stripe
// ===============================================================
app.post("/api/admin/verify-stripe", async (req, res) => {
  const { idToken, ownerUid, approve } = req.body
  if (!idToken) return res.status(401).json({ error: "Non authentifié" })

  try {
    // Vérifier que c'est bien un admin SaaS
    const decoded      = await admin.auth().verifyIdToken(idToken)
    const ADMIN_EMAILS = ["musmamon@gmail.com", "musrh@gmail.com"]
    if (!ADMIN_EMAILS.includes(decoded.email?.toLowerCase())) {
      return res.status(403).json({ error: "Non autorisé" })
    }

    if (!ownerUid) return res.status(400).json({ error: "ownerUid requis" })

    const userRef  = db.collection("users").doc(ownerUid)
    const userSnap = await userRef.get()
    if (!userSnap.exists) return res.status(404).json({ error: "Utilisateur introuvable" })

    const userData   = userSnap.data()
    const accountId  = userData.stripeAccountId

    if (!accountId) {
      return res.status(400).json({ error: "Aucun compte Stripe Connect trouvé" })
    }

    if (approve) {
      // Vérifier l'état réel du compte dans Stripe
      const account = await stripe.accounts.retrieve(accountId)
      const chargesEnabled  = account.charges_enabled
      const payoutsEnabled  = account.payouts_enabled
      const detailsSubmitted = account.details_submitted

      // Activer seulement si Stripe confirme que le compte est opérationnel
      await userRef.set({
        stripeVerified:    true,
        stripeActivatedAt: Date.now(),
        stripeChargesEnabled:  chargesEnabled,
        stripePayoutsEnabled:  payoutsEnabled,
        stripeDetailsSubmitted: detailsSubmitted,
      }, { merge: true })

      console.log(`✅ Stripe activé pour ${ownerUid} | charges: ${chargesEnabled} | payouts: ${payoutsEnabled}`)
      res.json({
        success: true,
        ownerUid,
        accountId,
        chargesEnabled,
        payoutsEnabled,
        detailsSubmitted,
        message: `Stripe activé pour ${userData.email || ownerUid}`
      })
    } else {
      // Rejeter / désactiver
      await userRef.set({
        stripeVerified:   false,
        stripeRejectedAt: Date.now(),
      }, { merge: true })

      console.log(`🚫 Stripe rejeté pour ${ownerUid}`)
      res.json({ success: true, ownerUid, message: "Stripe rejeté" })
    }

  } catch(e) {
    console.error("❌ verify-stripe:", e.message)
    res.status(500).json({ error: e.message })
  }
})
// ===============================================================
//  GET /api/admin/stripe-accounts — Lister les comptes en attente
// ===============================================================
app.get("/api/admin/stripe-accounts", async (req, res) => {
  const { idToken } = req.query
  if (!idToken) return res.status(401).json({ error: "Non authentifié" })

  try {
    const decoded      = await admin.auth().verifyIdToken(idToken)
    const ADMIN_EMAILS = ["musmamon@gmail.com", "musrh@gmail.com"]
    if (!ADMIN_EMAILS.includes(decoded.email?.toLowerCase())) {
      return res.status(403).json({ error: "Non autorisé" })
    }

    // Récupérer tous les users avec un compte Stripe soumis
    const snap = await db.collection("users")
      .where("stripeAccountId", "!=", null)
      .get()

    const accounts = snap.docs.map(d => {
      const data = d.data()
      return {
        uid:              d.id,
        email:            data.email,
        plan:             data.plan,
        stripeAccountId:  data.stripeAccountId,
        stripeVerified:   data.stripeVerified || false,
        stripeSubmittedAt: data.stripeSubmittedAt,
        stripeActivatedAt: data.stripeActivatedAt,
      }
    })

    const pending = accounts.filter(a => !a.stripeVerified)
    const active  = accounts.filter(a =>  a.stripeVerified)

    res.json({ pending, active, total: accounts.length })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})
// ===============================================================
//  GET / — Health check
// ===============================================================
app.get("/", (req, res) => {
  res.json({
    status:   "OK",
    service:  "SaasBuilder + SaasBuilder Backend",
    groq:     process.env.VITE_GROQ_API_KEY || process.env.GROQ_API_KEY ? "✅ configuré" : "❌ clé manquante",
    firebase: admin.apps.length ? "✅ configuré" : "❌ non configuré",
    stripe:   process.env.STRIPE_SECRET_KEY ? "✅ configuré" : "❌ clé manquante",
    backup:   process.env.BACKUP_BUCKET ? `✅ bucket: ${process.env.BACKUP_BUCKET}` : "❌ BACKUP_BUCKET manquant",
    endpoints: [
      "POST /create-billing-session",
      "POST /create-stripe-session",
      "POST /create-connect-account",
      "POST /force-upgrade",
      "POST /webhook",
      "POST /api/assistant",
      "POST /api/save-request",
      "GET  /api/products/:storeUid",
      "GET  /api/orders/:storeUid",
      "GET  /api/forders/:storeUid",
      "GET  /api/debug/:storeUid",
      "POST /api/admin/check-expiry",
      "POST /api/admin/backup",
      "GET  /api/admin/backups",
      "GET  /api/admin/backup/:filename",
      "POST /api/admin/restore",
      "GET  /api/store/backups",
      "POST /api/store/restore",
    ]
  })
})
// ===============================================================
//  Backup & Restore — Routes (depuis backup.js et store-restore.js)
// ===============================================================
backupRoutes(app)        // Admin : /api/admin/backup, /api/admin/backups, /api/admin/restore
storeRestoreRoutes(app)  // Store  : /api/store/backups, /api/store/restore
exportStoreRoutes(app)   // Admin  : /api/admin/export-store/:uid, /api/admin/export-all
// ===============================================================
//  CRON — Vérification des comptes expirés
//  Tourne tous les jours à 1h00 du matin
//  Désactive les comptes dont expiry < Date.now()
// ===============================================================
const checkExpiredAccounts = async () => {
  console.log("[CRON] 🔍 Vérification des comptes expirés...")
  const now      = Date.now()
  let   disabled = 0
  let   checked  = 0

  try {
    // Récupérer tous les users actifs avec une date d'expiration dépassée
    const snap = await db.collection("users")
      .where("active", "==", true)
      .where("expiry", "<", now)
      .get()

    checked = snap.size
    console.log(`[CRON] 📊 ${checked} compte(s) avec expiry dépassé`)

    for (const doc of snap.docs) {
      const data = doc.data()

      // Ne pas désactiver les admins
      if (["musmamon@gmail.com", "musrh@gmail.com"].includes(data.email?.toLowerCase())) {
        console.log(`[CRON] ⚙️  Admin ignoré: ${data.email}`)
        continue
      }

      // Ne pas désactiver les plans gratuits (pas d'expiry pour eux)
      if (data.plan === "free" || !data.expiry) {
        continue
      }

      try {
        await doc.ref.set({
          active:             false,
          subscriptionActive: false,
          paye:               false,
          suspendedAt:        now,
          suspendedReason:    "expiry",
        }, { merge: true })

        console.log(`[CRON] 🔒 Compte désactivé: ${data.email} | expiry: ${new Date(data.expiry).toISOString()}`)
        disabled++
      } catch(e) {
        console.error(`[CRON] ❌ Erreur désactivation ${doc.id}:`, e.message)
      }
    }

    console.log(`[CRON] ✅ Terminé — ${disabled}/${checked} compte(s) désactivé(s)`)
  } catch(e) {
    console.error("[CRON] ❌ Erreur checkExpiredAccounts:", e.message)
  }

  return { checked, disabled }
}

// Lancer le cron tous les jours à 1h00
cron.schedule("0 1 * * *", () => {
  console.log("[CRON] ⏰ Déclenchement quotidien checkExpiredAccounts")
  checkExpiredAccounts()
})

// ===============================================================
//  CRON — Backup Firestore automatique à 2h00 UTC
// ===============================================================
cron.schedule("0 2 * * *", async () => {
  console.log("[CRON] ☁️  Démarrage backup automatique Firestore...")
  try {
    const { filename, filepath } = await exportToJson()
    await uploadToStorage(filepath, filename)
    await cleanOldBackups()
    fs.unlinkSync(filepath)
    console.log(`[CRON] ✅ Backup OK : ${filename}`)
  } catch (e) {
    console.error("[CRON] ❌ Backup échoué :", e.message)
  }
})

// Endpoint manuel pour déclencher la vérification (debug/admin)
app.post("/api/admin/check-expiry", async (req, res) => {
  const { idToken } = req.body
  if (!idToken) return res.status(401).json({ error: "Non authentifié" })
  try {
    const decoded      = await admin.auth().verifyIdToken(idToken)
    const ADMIN_EMAILS = ["musmamon@gmail.com", "musrh@gmail.com"]
    if (!ADMIN_EMAILS.includes(decoded.email?.toLowerCase())) {
      return res.status(403).json({ error: "Non autorisé" })
    }
    const result = await checkExpiredAccounts()
    res.json({ success: true, ...result })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ===============================================================
//  START
// ===============================================================
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`)
  console.log(`🤖 Groq:     ${process.env.VITE_GROQ_API_KEY || process.env.GROQ_API_KEY ? "✅" : "❌ VITE_GROQ_API_KEY manquant"}`)
  console.log(`🔥 Firebase: ${admin.apps.length ? "✅" : "❌ FIREBASE_SERVICE_ACCOUNT manquant"}`)
  console.log(`💳 Stripe:   ${process.env.STRIPE_SECRET_KEY ? "✅" : "❌ STRIPE_SECRET_KEY manquant"}`)
  console.log(`☁️  Backup:   ${process.env.BACKUP_BUCKET ? `✅ bucket: ${process.env.BACKUP_BUCKET}` : "❌ BACKUP_BUCKET manquant"}`)
  console.log(`⏰ Cron:     Expiry 01h00 | Backup 02h00 UTC`)
})
