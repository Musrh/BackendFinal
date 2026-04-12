// ===============================================================
//  BACKEND FINAL SAAS — Billing + Stripe Connect + Firestore + IA
// ===============================================================

import express    from "express"
import cors       from "cors"
import Stripe     from "stripe"
import dotenv     from "dotenv"
import admin      from "firebase-admin"
import bodyParser from "body-parser"

dotenv.config()

const app  = express()
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
// ⚠️ WEBHOOK (AVANT express.json)
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

  // ===========================================================
  // 💰 BILLING (TON ARGENT)
  // ===========================================================
  if (event.type === "checkout.session.completed") {
    const session = event.data.object

    if (session.payment_status === "paid") {
      const metadata = session.metadata?.data
        ? JSON.parse(session.metadata.data)
        : {}

      // 🔹 CAS 1 : ABONNEMENT SAAS
      if (metadata.type === "billing") {
        await db.collection("subscriptions").doc(session.id).set({
          email: session.customer_email,
          plan: metadata.plan,
          ownerUid: metadata.ownerUid,
          status: "active",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })

        console.log("💰 Abonnement SaaS activé")
      }

      // 🔹 CAS 2 : COMMANDE STORE (Stripe Connect)
      if (metadata.type === "store_payment") {
        await db.collection("orders").doc(session.id).set({
          email: session.customer_email,
          items: metadata.items || [],
          montant: session.amount_total / 100,
          ownerUid: metadata.ownerUid,
          status: "paid",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })

        console.log("🛒 Commande store enregistrée")
      }
    }
  }

  res.json({ received: true })
})

// ===============================================================
app.use(express.json())

// ===============================================================
// 💰 BILLING (OWNER → TOI)
// ===============================================================
app.post("/create-billing-session", async (req, res) => {
  try {
    const { email, plan, ownerUid } = req.body

    const prices = {
      basic: 500,   // 5€
      pro:   1500,  // 15€
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

      success_url: "https://tonsite.com/success",
      cancel_url:  "https://tonsite.com/cancel",

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
    res.status(500).json({ error: err.message })
  }
})

// ===============================================================
// 🛒 STORE PAYMENT (CLIENT → OWNER)
// ===============================================================
app.post("/create-store-session", async (req, res) => {
  try {
    const { items, email, ownerUid } = req.body

    // 🔥 récupérer le compte Stripe du owner
    const userDoc = await db.collection("users").doc(ownerUid).get()
    const ownerStripeAccount = userDoc.data()?.stripeAccountId

    if (!ownerStripeAccount) {
      return res.status(400).json({ error: "Owner non connecté à Stripe" })
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

      // 🔥 STRIPE CONNECT (argent → owner)
      payment_intent_data: {
        transfer_data: {
          destination: ownerStripeAccount,
        },
      },

      success_url: "https://tonsite.com/success",
      cancel_url:  "https://tonsite.com/cancel",

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
// 🔗 CONNECT STRIPE (ONBOARDING OWNER)
// ===============================================================
app.post("/create-connect-account", async (req, res) => {
  try {
    const { ownerUid, email } = req.body

    const account = await stripe.accounts.create({
      type: "express",
      email,
    })

    await db.collection("users").doc(ownerUid).set({
      stripeAccountId: account.id,
    }, { merge: true })

    const link = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: "https://tonsite.com/reauth",
      return_url: "https://tonsite.com/dashboard",
      type: "account_onboarding",
    })

    res.json({ url: link.url })

  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ===============================================================
// 🧪 DEBUG
// ===============================================================
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    features: [
      "Stripe Billing (SaaS)",
      "Stripe Connect (Stores)",
      "Firestore",
    ]
  })
})

// ===============================================================
app.listen(PORT, () => {
  console.log(`🚀 Backend SaaS prêt sur port ${PORT}`)
})
