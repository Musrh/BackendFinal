// ===============================================================
// BACKEND FINAL SAAS — VERSION FIX + PRODUCTION SAFE
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

// ===============================================================
// 🔥 MIDDLEWARE ORDER (CRITICAL FIX)
// ===============================================================
app.use(cors({ origin: "*", methods: ["GET", "POST"] }))
app.use(express.json()) // ✅ MUST BE BEFORE ROUTES

// ===============================================================
// 🔥 FIREBASE
// ===============================================================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT missing")
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const db = admin.firestore()

// ===============================================================
// 💰 STRIPE
// ===============================================================
if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY missing")
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// ===============================================================
// ⚠️ WEBHOOK (RAW BODY MUST STAY FIRST)
// ===============================================================
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
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

      if (session.payment_status !== "paid") {
        return res.json({ received: true })
      }

      let metadata = {}

      try {
        metadata = session.metadata?.data
          ? JSON.parse(session.metadata.data)
          : {}
      } catch (e) {
        console.error("❌ metadata parse error:", e.message)
      }

      console.log("📦 METADATA:", metadata)

      // =======================================================
      // 💰 BILLING
      // =======================================================
      if (metadata.type === "billing") {
        try {
          await db.collection("subscriptions").doc(session.id).set({
            email: session.customer_email,
            plan: metadata.plan,
            ownerUid: metadata.ownerUid,
            status: "active",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          })

          const userRef = db.collection("users").doc(metadata.ownerUid)

          await userRef.set(
            {
              plan: metadata.plan || "pro",
              paye: true,
              subscriptionActive: true,
              updatedAt: Date.now(),
            },
            { merge: true }
          )

          console.log("🔥 USER UPDATED")
        } catch (err) {
          console.error("❌ billing error:", err.message)
        }
      }

      // =======================================================
      // 🛒 STORE PAYMENT
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

          console.log("🛒 ORDER SAVED")
        } catch (err) {
          console.error("❌ order error:", err.message)
        }
      }
    }

    res.json({ received: true })
  }
)

// ===============================================================
// 💰 BILLING SESSION
// ===============================================================
app.post("/create-billing-session", async (req, res) => {
  try {
    const { email, plan, ownerUid } = req.body || {}

    if (!ownerUid) {
      return res.status(400).json({ error: "ownerUid requis" })
    }

    const prices = {
      basic: 500,
      pro: 1500,
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email,

      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: `Abonnement ${plan}`,
            },
            unit_amount: prices[plan] || 1500,
          },
          quantity: 1,
        },
      ],

      mode: "payment",

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
    console.error("❌ billing error:", err.message)
    res.status(500).json({ error: err.message })
  }
})

// ===============================================================
// 🛒 STORE SESSION (FULL SAFE FIX)
// ===============================================================
app.post("/create-store-session", async (req, res) => {
  try {
    const body = req.body || {}

    const { items, email, ownerUid } = body

    // ================= VALIDATION =================
    if (!ownerUid) {
      return res.status(400).json({ error: "ownerUid requis" })
    }

    if (!email) {
      return res.status(400).json({ error: "email requis" })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Panier invalide" })
    }

    // ================= USER =================
    const userDoc = await db.collection("users").doc(ownerUid).get()

    if (!userDoc.exists) {
      return res.status(404).json({ error: "Utilisateur introuvable" })
    }

    const accountId = userDoc.data()?.stripeAccountId

    if (!accountId) {
      return res.status(400).json({ error: "Stripe non connecté" })
    }

    // ================= LINE ITEMS SAFE =================
    const lineItems = items.map((item, i) => {
      if (!item?.nom || item?.prix == null || !item?.quantity) {
        throw new Error(`Item invalide index ${i}`)
      }

      const price = Number(item.prix)

      if (isNaN(price)) {
        throw new Error(`Prix invalide index ${i}`)
      }

      return {
        price_data: {
          currency: "eur",
          product_data: { name: item.nom },
          unit_amount: Math.round(price * 100),
        },
        quantity: Number(item.quantity),
      }
    })

    // ================= STRIPE =================
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email,

      line_items: lineItems,
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
    console.error("❌ STORE ERROR:", err.message)
    res.status(500).json({ error: err.message })
  }
})

// ===============================================================
// 🔗 STRIPE CONNECT
// ===============================================================
app.post("/create-connect-account", async (req, res) => {
  try {
    const { ownerUid, email } = req.body || {}

    if (!ownerUid) {
      return res.status(400).json({ error: "ownerUid requis" })
    }

    const userRef = db.collection("users").doc(ownerUid)
    const userDoc = await userRef.get()

    let accountId = userDoc.data()?.stripeAccountId

    if (!accountId) {
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
  console.log("🚀 Backend running on port", PORT)
})
