// ===============================================================
// BACKEND FINAL SAAS — VERSION CORRIGÉE + SÉCURISÉE
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
// 🛡️ VALIDATION UTILS
// ===============================================================
const isValidString = (val) => typeof val === "string" && val.trim() !== ""

// ===============================================================
// ⚠️ WEBHOOK STRIPE
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

  console.log("📨 EVENT:", event.type)

  if (event.type === "checkout.session.completed") {
    const session = event.data.object

    if (session.payment_status !== "paid") {
      console.log("⏳ Payment pas encore validé")
      return res.json({ received: true })
    }

    // 🔐 Parse metadata
    let metadata = {}
    try {
      metadata = session.metadata?.data
        ? JSON.parse(session.metadata.data)
        : {}
    } catch (e) {
      console.error("❌ Metadata parse error:", e.message)
    }

    const { type, ownerUid, plan, items } = metadata

    console.log("📦 Metadata:", metadata)

    // =======================================================
    // 💰 ABONNEMENT SAAS
    // =======================================================
    if (type === "billing") {
      if (!isValidString(ownerUid)) {
        console.error("❌ ownerUid invalide (billing)")
        return res.json({ received: true })
      }

      try {
        await db.collection("subscriptions").doc(session.id).set({
          email: session.customer_email,
          plan,
          ownerUid,
          status: "active",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })

        const userRef = db.collection("users").doc(ownerUid)
        const snap = await userRef.get()

        if (snap.exists) {
          await userRef.update({
            plan: plan || "pro",
            paye: true,
            subscriptionActive: true,
            updatedAt: Date.now(),
          })
        } else {
          await userRef.set({
            email: session.customer_email,
            plan: plan || "pro",
            paye: true,
            subscriptionActive: true,
            updatedAt: Date.now(),
          }, { merge: true })
        }

        console.log("🔥 USER PASSÉ EN PRO:", ownerUid)

      } catch (e) {
        console.error("❌ Billing error:", e.message)
      }
    }

    // =======================================================
    // 🛒 PAIEMENT STORE
    // =======================================================
    if (type === "store_payment") {
      if (!isValidString(ownerUid)) {
        console.error("❌ ownerUid invalide (store)")
        return res.json({ received: true })
      }

      try {
        await db.collection("orders").doc(session.id).set({
          email: session.customer_email,
          items: items || [],
          montant: session.amount_total / 100,
          ownerUid,
          status: "paid",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })

        console.log("🛒 COMMANDE OK")

      } catch (e) {
        console.error("❌ Store payment error:", e.message)
      }
    }
  }

  res.json({ received: true })
})

// ===============================================================
app.use(express.json())

// ===============================================================
// 🧪 TEST
// ===============================================================
app.get("/test", (req, res) => {
  res.json({ ok: true })
})

// ===============================================================
// 💰 CREATE BILLING SESSION
// ===============================================================
app.post("/create-billing-session", async (req, res) => {
  try {
    const { email, plan, ownerUid } = req.body

    console.log("💳 Billing request:", req.body)

    if (!isValidString(ownerUid)) {
      return res.status(400).json({ error: "ownerUid requis" })
    }

    const prices = {
      basic: 500,
      pro: 1500,
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email,

      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: `Abonnement ${plan}` },
          unit_amount: prices[plan] || 1500,
        },
        quantity: 1,
      }],

      mode: "payment",

      success_url: "https://musrh.github.io/SaasBuilder/#/dashboard?success=true",
      cancel_url: "https://musrh.github.io/SaasBuilder/#/dashboard",

      metadata: {
        data: JSON.stringify({
          type: "billing",
          plan,
          ownerUid,
        }),
      },
    })

    res.json({ url: session.url })

  } catch (err) {
    console.error("❌ billing error:", err.message)
    res.status(500).json({ error: err.message })
  }
})

// ===============================================================
// 🛒 CREATE STORE SESSION (FIX PRINCIPAL ICI)
// ===============================================================
app.post("/create-store-session", async (req, res) => {
  try {
    const { items, email, ownerUid } = req.body

    console.log("🛒 STORE REQUEST:", req.body)

    // 🔴 FIX CRITIQUE
    if (!isValidString(ownerUid)) {
      console.error("❌ ownerUid invalide ou vide")
      return res.status(400).json({ error: "ownerUid requis" })
    }

    const userDoc = await db.collection("users").doc(ownerUid).get()

    if (!userDoc.exists) {
      return res.status(404).json({ error: "Utilisateur introuvable" })
    }

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
    console.error("❌ store session error:", err.message)
    res.status(500).json({ error: err.message })
  }
})

// ===============================================================
// 🔗 STRIPE CONNECT
// ===============================================================
app.post("/create-connect-account", async (req, res) => {
  try {
    const { ownerUid, email } = req.body

    if (!isValidString(ownerUid)) {
      return res.status(400).json({ error: "ownerUid requis" })
    }

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
    console.error("❌ connect error:", err.message)
    res.status(500).json({ error: err.message })
  }
})

// ===============================================================
app.listen(PORT, () => {
  console.log(`🚀 Backend prêt sur port ${PORT}`)
})
