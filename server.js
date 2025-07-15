import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import stripeModule from "stripe";
import { admin, db } from "./firebase-admin.js";
import fetch from "node-fetch"; 

dotenv.config();
const stripe = stripeModule(process.env.STRIPE_SECRET_KEY);
const app = express();
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// ✅ CORS middleware
// Global CORS for dashboard routes (lock it down here)
const allowedOrigins = [
  "https://ai-agent-staging-2f393.web.app"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Allow all origins for the public agent chat API route ONLY
  if (req.path.startsWith("/api/ai-chat")) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});


// ✅ Raw body parser ONLY for /webhook
app.post("/webhook", bodyParser.raw({ type: "application/json" }));

// ✅ JSON body parser for all other routes
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

    const customers = await stripe.customers.list({ email });
    if (customers.data.length > 0) {
      customer = customers.data[0];
    } else {
      customer = await stripe.customers.create({ email, metadata: { uid } });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1
        }
      ],
      customer: customer.id,
      metadata: { uid },
      success_url: req.body.success_url, 
      cancel_url: req.body.cancel_url,   
      subscription_data: {
        trial_period_days: 30
      }
    });
    

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Auth or Stripe error:", err);
    res.status(401).json({ error: "Unauthorized" });
  }
});

// ✅ Create Billing Portal session
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

    console.log("🔍 Using Stripe customer ID:", data.stripeCustomerId);

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: data.stripeCustomerId,
      return_url: req.body.success_url || "https://ai-agent-staging-2f393.web.app/dashboard.html" // fallback just in case
    });    

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error("❌ Billing portal error:", err);
    res.status(500).json({ error: "Failed to create billing portal session" });
  }
});

// ✅ Stripe Webhook
app.post("/webhook", (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log("🔥 Stripe webhook triggered:", event.type); // ✅ ADD THIS LINE
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

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    console.log("📩 Received subscription.deleted for customerId:", customerId); // ✅ YOU ALREADY HAVE THIS

    const bizRef = db.collection("businesses");
    bizRef
      .where("stripeCustomerId", "==", customerId)
      .get()
      .then(async snapshot => {
        if (snapshot.empty) {
          console.warn("⚠️ No Firestore business found for customerId:", customerId);
          return;
        }

        for (const doc of snapshot.docs) {
          try {
            await doc.ref.set({ isActive: false }, { merge: true });
            console.log(`🚫 isActive set to false for business: ${doc.id}`);
          } catch (err) {
            console.error("❌ Error updating Firestore doc:", err);
          }
        }
      })
      .catch(err => {
        console.error("❌ Firestore query failed:", err);
      });
  }

  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object;
    const customerId = invoice.customer;

    console.log("📩 Received invoice.payment_failed for customerId:", customerId);

    const bizRef = db.collection("businesses");
    bizRef
      .where("stripeCustomerId", "==", customerId)
      .get()
      .then(async snapshot => {
        if (snapshot.empty) {
          console.warn("⚠️ No Firestore business found for customerId:", customerId);
          return;
        }

        for (const doc of snapshot.docs) {
          try {
            await doc.ref.set({ isActive: false }, { merge: true });
            console.log(`🚫 Deactivated user ${doc.id} after payment failure`);
          } catch (err) {
            console.error("❌ Error updating Firestore doc:", err);
          }
        }
      })
      .catch(err => console.error("❌ Firestore query failed:", err));
  }

  res.status(200).send("OK");
});

// ✅ Secure AI Chat Route
app.post("/api/ai-chat", async (req, res) => {
  try {
    const { prompt, biz } = req.body;

    const systemPrompt = `
You are an emotionally intelligent AI assistant for a small business embedded on their website.

Business Info:
- Name: ${biz.name}
- Services: ${biz.services}
- Hours: ${biz.hours}
- Pricing: ${biz.pricing}
- Phone: ${biz.phone}
- Email: ${biz.email}
- Location Areas: ${biz.areas}

Custom Tone (from the business owner):
"${biz.customInstructions || "Friendly, casual, and helpful."}"
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ],
        temperature: 0.7
      })
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Sorry, I couldn't process that.";

    res.json({ reply });
  } catch (err) {
    console.error("❌ AI Chat Error:", err);
    res.status(500).json({ error: "AI Chat failed" });
  }
});


// ✅ Start Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
