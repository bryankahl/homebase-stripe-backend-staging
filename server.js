import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import stripeModule from "stripe";
import { admin, db } from "./firebase-admin.js";

dotenv.config();
const stripe = stripeModule(process.env.STRIPE_SECRET_KEY);
const app = express();
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// ✅ CORS middleware
const allowedOrigins = ["https://ai-agent-demo-9fe52.web.app"];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ✅ Raw webhook parser (ONLY for /webhook)
app.post("/webhook", bodyParser.raw({ type: "application/json" }));

// ✅ Standard JSON parser for all other routes
app.use(bodyParser.json());

// ✅ Health check
app.get("/", (req, res) => {
  res.send("🔥 Homebase AI backend is running.");
});

// ✅ Create Stripe Checkout session
app.post("/create-checkout-session", async (req, res) => {
  const idToken = req.headers.authorization?.split("Bearer ")[1];
  if (!idToken) return res.status(401).json({ error: "Missing token" });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = decoded.email;

    let customer;

    // Check if the user already has a Stripe customer
    const customers = await stripe.customers.list({ email });
    if (customers.data.length > 0) {
      customer = customers.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { uid }
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      customer: customer.id, // ✅ use customer instead of customer_email
      metadata: { uid },
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
    });


    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Auth or Stripe error:", err);
    res.status(401).json({ error: "Unauthorized" });
  }
});

// ✅ Create Billing Portal session using stored customer ID
app.post("/create-billing-portal-session", async (req, res) => {
  const idToken = req.headers.authorization?.split("Bearer ")[1];
  if (!idToken) return res.status(401).json({ error: "Missing token" });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const bizSnap = await db.collection("businesses").doc(uid).get();
    const data = bizSnap.data();

    if (!data?.stripeCustomerId) {
      throw new Error("No Stripe customer ID found");
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: data.stripeCustomerId,
      return_url: process.env.SUCCESS_URL,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error("❌ Billing portal error:", err);
    res.status(500).json({ error: "Failed to create billing portal session" });
  }
});

// ✅ Webhook route to handle Stripe events
app.post("/webhook", (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("⚠️ Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const uid = session.metadata.uid;
    const customerId = session.customer;

    db.collection("businesses")
      .doc(uid)
      .set({ isActive: true, stripeCustomerId: customerId }, { merge: true })
      .then(() => console.log(`✅ Activated user ${uid}`))
      .catch(err => console.error(`❌ Failed to activate user ${uid}`, err));
  }

  res.status(200).send("OK");
});

// ✅ Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
