// ===============================================================
// BACKEND FINAL SAAS — VERSION ARCHI PROPRE
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
    console.error("❌ Webhook error:", err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object

    if (session.payment_status === "paid") {

      const metadata = session.metadata?.data
        ? JSON.parse(session.metadata.data)
        : {}

      console.log("📦 METADATA:", metadata)

      // =======================================================
      // 💰 SAAS BUILDER (OWNER → TOI)
      // =======================================================
      if (metadata.type === "billing") {

        await db.collection("subscriptions").doc(session.id).set({
          email: session.customer_email,
          plan: metadata.plan,
          ownerUid: metadata.ownerUid,
          status: "active",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })

        // 🔥 UPDATE USER (LE FIX IMPORTANT)
        const userRef = db.collection("users").doc(metadata.ownerUid)
        const userSnap = await userRef.get()

        if (userSnap.exists) {
          await userRef.update({
            plan: metadata.plan || "pro",
            paye: true,
            subscriptionActive: true,
            updatedAt: Date.now()
          })

          console.log("🔥 USER PASSÉ EN PRO")
        } else {
          console.error("❌ USER INTROUVABLE")
        }
      }

      // =======================================================
      // 🛒 SAAS GENERATOR (CLIENT → OWNER)
      // =======================================================
      if (metadata.type === "store_payment") {

        await db.collection("orders").doc(session.id).set({
          email: session.customer_email,
          items: metadata.items || [],
          montant: session.amount_total / 100,
          ownerUid: metadata.ownerUid,
          status: "paid",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })

        console.log("🛒 COMMANDE STORE OK")
      }
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
          product_data: {
            name: `Abonnement ${plan}`,
          },
          unit_amount: prices[plan],
        },
        quantity: 1,
      }],

      mode: "payment",

      // ✅ SaasBuilder (ton dashboard)
      success_url: "https://musrh.github.io/SaasBuilder/#/success",
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
    console.error(err)
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

      // ✅ SaaasGenerator (store client)
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
  console.log(`🚀 Backend prêt`)
})
