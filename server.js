// ===============================================================
// BACKEND FINAL SAAS — VERSION DEBUG COMPLÈTE
// ===============================================================

import express from "express"
import cors from "cors"
import Stripe from "stripe"
import dotenv from "dotenv"
import admin from "firebase-admin"
import bodyParser from "body-parser"

dotenv.config()

const app = express()
const PORT = process.env.PORT || 8080

app.use(cors({ origin: "*", methods: ["GET", "POST"] }))

// ===============================================================
// 🔥 FIREBASE
// ===============================================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const db = admin.firestore()

// ===============================================================
// 💰 STRIPE
// ===============================================================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// ===============================================================
// ⚠️ WEBHOOK
// ===============================================================
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"]

  let event
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.error("❌ Webhook signature error:", err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  console.log("📨 EVENT TYPE:", event.type)

  if (event.type === "checkout.session.completed") {
    const session = event.data.object

    console.log("🎯 SESSION ID:", session.id)
    console.log("💳 payment_status:", session.payment_status)
    console.log("📧 customer_email:", session.customer_email)
    console.log("🗂 metadata RAW:", JSON.stringify(session.metadata))

    if (session.payment_status === "paid") {

      let metadata = {}
      try {
        metadata = session.metadata?.data
          ? JSON.parse(session.metadata.data)
          : {}
        console.log("📦 METADATA PARSÉ:", JSON.stringify(metadata))
      } catch (parseErr) {
        console.error("❌ ERREUR PARSE METADATA:", parseErr.message)
      }

      console.log("🔑 ownerUid:", metadata.ownerUid || "VIDE/UNDEFINED")
      console.log("📋 type:", metadata.type || "VIDE/UNDEFINED")
      console.log("🎫 plan:", metadata.plan || "VIDE/UNDEFINED")

      // =======================================================
      // 💰 SAAS BUILDER
      // =======================================================
      if (metadata.type === "billing") {
        console.log("✅ Type billing détecté")

        // Écriture subscription
        try {
          await db.collection("subscriptions").doc(session.id).set({
            email: session.customer_email,
            plan: metadata.plan,
            ownerUid: metadata.ownerUid,
            status: "active",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          })
          console.log("✅ Subscription écrite dans Firestore")
        } catch (e) {
          console.error("❌ Erreur écriture subscription:", e.message)
        }

        // Mise à jour user
        if (!metadata.ownerUid) {
          console.error("❌ FATAL: ownerUid vide — impossible de mettre à jour l'utilisateur")
        } else {
          try {
            const userRef = db.collection("users").doc(metadata.ownerUid)
            const userSnap = await userRef.get()
            console.log("👤 User trouvé?", userSnap.exists, "| uid:", metadata.ownerUid)

            if (userSnap.exists) {
              console.log("📄 Données actuelles:", JSON.stringify(userSnap.data()))
              await userRef.update({
                plan: metadata.plan || "pro",
                paye: true,
                subscriptionActive: true,
                updatedAt: Date.now()
              })
              console.log("🔥 USER PASSÉ EN PRO — plan:", metadata.plan || "pro")
            } else {
              console.error("❌ USER INTROUVABLE pour uid:", metadata.ownerUid)
              // Tentative de création si inexistant
              await userRef.set({
                plan: metadata.plan || "pro",
                paye: true,
                subscriptionActive: true,
                email: session.customer_email,
                updatedAt: Date.now()
              }, { merge: true })
              console.log("🆕 USER CRÉÉ/MERGÉ avec plan pro")
            }
          } catch (e) {
            console.error("❌ Erreur update user:", e.message)
          }
        }
      }

      // =======================================================
      // 🛒 SAAS GENERATOR (CLIENT → OWNER)
      // =======================================================
      if (metadata.type === "store_payment") {
        try {
          await db.collection("orders").doc(session.id).set({
            email: session.customer_email,
            items: metadata.items || [],
            montant: session.amount_total / 100,
            ownerUid: metadata.ownerUid,
            status: "paid",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          })
          console.log("🛒 COMMANDE STORE OK")
        } catch (e) {
          console.error("❌ Erreur commande store:", e.message)
        }
      }

    } else {
      console.log("⏳ payment_status pas encore 'paid':", session.payment_status)
    }
  }

  res.json({ received: true })
})

// ===============================================================
app.use(express.json())

// ===============================================================
// 💰 SAAS BUILDER (ABONNEMENT)
// ===============================================================
app.post("/create-billing-session", async (req, res) => {
  try {
    const { email, plan, ownerUid } = req.body

    console.log("💳 create-billing-session — email:", email, "| plan:", plan, "| ownerUid:", ownerUid)

    if (!ownerUid) {
      console.error("❌ ownerUid manquant dans la requête!")
      return res.status(400).json({ error: "ownerUid requis" })
    }

    const prices = {
      basic: 500,
      pro: 1500,
    }

    const metadataPayload = {
      type: "billing",
      plan,
      ownerUid,
    }
    console.log("📦 Metadata envoyée à Stripe:", JSON.stringify(metadataPayload))

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email,

      line_items: [{
        price_data: {
          currency: "eur",
          product_data: {
            name: `Abonnement ${plan}`,
          },
          unit_amount: prices[plan] || 1500,
        },
        quantity: 1,
      }],

      mode: "payment",

      // ✅ Redirige vers /dashboard?success=true pour déclencher le polling
      success_url: "https://musrh.github.io/SaasBuilder/#/dashboard?success=true",
      cancel_url: "https://musrh.github.io/SaasBuilder/#/dashboard",

      metadata: {
        data: JSON.stringify(metadataPayload),
      },
    })

    console.log("✅ Session Stripe créée:", session.id)
    res.json({ url: session.url })

  } catch (err) {
    console.error("❌ create-billing-session error:", err.message)
    res.status(500).json({ error: err.message })
  }
})

// ===============================================================
// 🛒 SAAS GENERATOR (CLIENT)
// ===============================================================
app.post("/create-store-session", async (req, res) => {
  try {
    const { items, email, ownerUid } = req.body

    const userDoc = await db.collection("users").doc(ownerUid).get()
    const accountId = userDoc.data()?.stripeAccountId

    if (!accountId) {
      return res.status(400).json({ error: "Stripe non connecté" })
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email,

      line_items: items.map(item => ({
        price_data: {
          currency: "eur",
          product_data: { name: item.nom },
          unit_amount: Math.round(item.prix * 100),
        },
        quantity: item.quantity,
      })),

      mode: "payment",

      payment_intent_data: {
        transfer_data: {
          destination: accountId,
        },
      },

      success_url: "https://musrh.github.io/SaaasGenerator/#/success",
      cancel_url: "https://musrh.github.io/SaaasGenerator/#/cancel",

      metadata: {
        data: JSON.stringify({
          type: "store_payment",
          ownerUid,
          items,
        }),
      },
    })

    res.json({ url: session.url })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// ===============================================================
// 🔗 STRIPE CONNECT
// ===============================================================
app.post("/create-connect-account", async (req, res) => {
  try {
    const { ownerUid, email } = req.body

    const userRef = db.collection("users").doc(ownerUid)
    const userDoc = await userRef.get()

    let accountId

    if (userDoc.exists && userDoc.data().stripeAccountId) {
      accountId = userDoc.data().stripeAccountId
    } else {
      const account = await stripe.accounts.create({
        type: "express",
        email,
      })

      accountId = account.id

      await userRef.set({ stripeAccountId: accountId }, { merge: true })
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: "https://musrh.github.io/SaasBuilder/#/reauth",
      return_url: "https://musrh.github.io/SaasBuilder/#/dashboard",
      type: "account_onboarding",
    })

    res.json({ url: link.url })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// ===============================================================
app.listen(PORT, () => {
  console.log(`🚀 Backend prêt sur port ${PORT}`)
})
