// ===============================================================
//  server.js — Backend COMPLET SaasBuilder + SaaasGenerator
//  Version fusionnée finale
//
//  SaasBuilder (abonnements) :
//    POST /create-billing-session   → abonnement propriétaire
//    POST /create-connect-account   → Stripe Connect
//    POST /force-upgrade            → debug upgrade plan
//
//  SaaasGenerator (store clients) :
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
//  Variables d'env requises :
//    STRIPE_SECRET_KEY
//    STRIPE_WEBHOOK_SECRET
//    FIREBASE_SERVICE_ACCOUNT     (JSON stringify)
//    VITE_GROQ_API_KEY            (ou GROQ_API_KEY)
// ===============================================================

import express    from "express"
import cors       from "cors"
import Stripe     from "stripe"
import dotenv     from "dotenv"
import admin      from "firebase-admin"
import bodyParser from "body-parser"
import Groq       from "groq-sdk"

dotenv.config()

const app  = express()
const PORT = process.env.PORT || 8080

app.use(cors({ origin: "*", methods: ["GET", "POST"] }))

// ── Firebase Admin ────────────────────────────────────────────
let serviceAccount = null
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
} catch (e) {
  console.error("❌ Firebase service account JSON invalide:", e.message)
}

if (serviceAccount) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
} else {
  console.error("❌ Firebase NON initialisé — vérifier FIREBASE_SERVICE_ACCOUNT")
}

const db = admin.firestore()

// ── Stripe ────────────────────────────────────────────────────
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// ── Groq ──────────────────────────────────────────────────────
const groq = new Groq({
  apiKey: process.env.VITE_GROQ_API_KEY || process.env.GROQ_API_KEY || ""
})

const FRONTEND_BUILDER   = "https://musrh.github.io/SaasBuilder"
const FRONTEND_GENERATOR = "https://musrh.github.io/SaaasGenerator"


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
      let metadata = {}
      try {
        metadata = session.metadata?.data ? JSON.parse(session.metadata.data) : {}
        console.log("📦 METADATA:", JSON.stringify(metadata))
      } catch (e) {
        console.error("❌ Parse metadata:", e.message)
      }

      // ── ABONNEMENT SAAS BUILDER ──────────────────────────
      if (metadata.type === "billing") {
        console.log("✅ Type billing — plan:", metadata.plan)
        try {
          await db.collection("subscriptions").doc(session.id).set({
            email:    session.customer_email,
            plan:     metadata.plan,
            ownerUid: metadata.ownerUid,
            status:   "active",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          })
        } catch (e) { console.error("❌ subscription:", e.message) }

        if (metadata.ownerUid) {
          try {
            const userRef  = db.collection("users").doc(metadata.ownerUid)
            const userSnap = await userRef.get()
            await userRef.set({
              plan:               metadata.plan || "pro",
              paye:               true,
              subscriptionActive: true,
              email:              session.customer_email,
              updatedAt:          Date.now(),
            }, { merge: true })
            console.log("🔥 USER PASSÉ EN PRO:", metadata.ownerUid)
          } catch (e) { console.error("❌ update user:", e.message) }
        }
      }

      // ── COMMANDE STORE (PAIEMENT CLIENT) ─────────────────
      if (metadata.type === "store_payment") {
        try {
          await db.collection("orders").doc(session.id).set({
            email:     session.customer_email,
            items:     metadata.items || [],
            total:     (session.amount_total || 0) / 100,
            ownerUid:  metadata.ownerUid,
            clientId:  metadata.clientId || "",
            siteSlug:  metadata.siteSlug || "",
            adresseLivraison: metadata.adresseLivraison || "",
            status:    "paid",
            provider:  "stripe",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          })
          console.log("🛒 COMMANDE STORE OK:", session.id)

          // Aussi dans users/{ownerUid}/orders
          if (metadata.ownerUid) {
            try {
              await db.collection("users").doc(metadata.ownerUid)
                .collection("orders").add({
                  email:    session.customer_email,
                  items:    metadata.items || [],
                  total:    (session.amount_total || 0) / 100,
                  ownerUid: metadata.ownerUid,
                  clientId: metadata.clientId || "",
                  status:   "paid",
                  provider: "stripe",
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                })
            } catch(e2) { console.warn("users/orders:", e2.message) }
          }
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

    // orders par clientId ou email
    if (!results.length) {
      try {
        let q = db.collection("orders")
        if (email) q = q.where("customerEmail", "==", email.trim().toLowerCase())
        else if (storeUid) q = q.where("ownerUid", "==", storeUid)
        const snap = await q.limit(20).get()
        results = [...results, ...snap.docs.map(d => ({
          id: d.id, ...d.data(),
          customerName:  d.data().customerName  || d.data().name || "",
          customerEmail: d.data().customerEmail || d.data().email || "",
        }))]
        console.log(`📋 orders: ${results.length}`)
      } catch(e) { console.warn("orders fallback:", e.message) }
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
//  GET /api/orders/:storeUid
// ===============================================================
app.get("/api/orders/:storeUid", async (req, res) => {
  const { email, nom, date } = req.query
  const cmds = await getCmdinfos(req.params.storeUid, { email, nom, date })
  res.json({ commandes: cmds, count: cmds.length })
})


// ===============================================================
//  POST /create-stripe-session — Paiement client du store
// ===============================================================
app.post("/create-stripe-session", async (req, res) => {
  try {
    let {
      items, email, adresseLivraison, clientId,
      siteSlug, ownerUid, plan, storeName,
      successUrl, cancelUrl, currency, description,
    } = req.body

    console.log("📦 create-stripe-session — items:", items?.length, "| email:", email)

    items = (items || []).map(item => ({
      nom:      item.nom      || item.name  || item.title || "Produit",
      prix:     parseFloat(item.prix || item.price || item.unit_amount || 0),
      quantity: item.quantity || item.qty   || 1,
    }))

    if (!items.length) return res.status(400).json({ error: "Panier vide" })

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email || undefined,
      line_items: items.map(item => ({
        price_data: {
          currency:     currency || "eur",
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
          items,
          adresseLivraison: adresseLivraison || "",
          email:            email            || "",
          clientId:         clientId         || ownerUid || "",
          siteSlug:         siteSlug         || "",
          ownerUid:         ownerUid         || clientId || "",
          plan:             plan             || "basic",
          storeName:        storeName        || "",
        }),
      },
    })

    console.log("🧾 Stripe session OK:", session.id)
    res.json({ url: session.url })

  } catch (err) {
    console.error("❌ create-stripe-session:", err.message)
    res.status(500).json({ error: "Stripe session failed", details: err.message })
  }
})


// ===============================================================
//  POST /create-billing-session — Abonnement SaasBuilder
// ===============================================================
app.post("/create-billing-session", async (req, res) => {
  try {
    const { email, plan, ownerUid } = req.body
    if (!ownerUid) return res.status(400).json({ error: "ownerUid requis" })

    const prices = { basic: 500, pro: 1500, premium: 2900 }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: `Abonnement ${plan || "pro"}` },
          unit_amount: prices[plan] || 1500,
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url: `${FRONTEND_BUILDER}/#/dashboard?success=true`,
      cancel_url:  `${FRONTEND_BUILDER}/#/dashboard`,
      metadata: {
        data: JSON.stringify({ type: "billing", plan, ownerUid }),
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
  const { ownerUid } = req.body
  if (!ownerUid) return res.status(400).json({ error: "ownerUid requis" })
  try {
    await db.collection("users").doc(ownerUid).set({
      plan: "pro", paye: true, subscriptionActive: true, updatedAt: Date.now()
    }, { merge: true })
    res.json({ ok: true })
  } catch (err) {
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
      await userRef.set({ stripeAccountId: accountId }, { merge: true })
    }

    const link = await stripe.accountLinks.create({
      account:     accountId,
      refresh_url: `${FRONTEND_BUILDER}/#/reauth`,
      return_url:  `${FRONTEND_BUILDER}/#/dashboard`,
      type:        "account_onboarding",
    })

    res.json({ url: link.url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})


// ===============================================================
//  GET / — Health check
// ===============================================================
app.get("/", (req, res) => {
  res.json({
    status:   "OK",
    service:  "SaasBuilder + SaaasGenerator Backend",
    groq:     process.env.VITE_GROQ_API_KEY || process.env.GROQ_API_KEY ? "✅ configuré" : "❌ clé manquante",
    firebase: serviceAccount ? "✅ configuré" : "❌ non configuré",
    stripe:   process.env.STRIPE_SECRET_KEY ? "✅ configuré" : "❌ clé manquante",
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
      "GET  /api/debug/:storeUid",
    ]
  })
})


// ===============================================================
//  START
// ===============================================================
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`)
  console.log(`🤖 Groq:     ${process.env.VITE_GROQ_API_KEY || process.env.GROQ_API_KEY ? "✅" : "❌ VITE_GROQ_API_KEY manquant"}`)
  console.log(`🔥 Firebase: ${serviceAccount ? "✅" : "❌ FIREBASE_SERVICE_ACCOUNT manquant"}`)
  console.log(`💳 Stripe:   ${process.env.STRIPE_SECRET_KEY ? "✅" : "❌ STRIPE_SECRET_KEY manquant"}`)
})
