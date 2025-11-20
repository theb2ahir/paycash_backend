// server.js
// Backend PayCash minimal sans stockage (no Firestore).
// - Crée des invoices PayDunya (/recharge)
// - Vérifie le statut d'une invoice (/invoice_status)
// - Reçoit IPN PayDunya (/ipn) et vérifie via confirm (sans persistance)
// - Effectue un disburse (/withdraw)
// - Callback simple (/paydunya_callback)
//
// .env attendu (exemple):
// PORT=3000
// BASE_URL=https://ton-domaine-ou-ngrok.io
// PAYDUNYA_BASE=https://app.paydunya.com/api/v1
// PAYDUNYA_MASTER_KEY=test_xxx
// PAYDUNYA_PRIVATE_KEY=test_xxx
// PAYDUNYA_TOKEN=test_xxx
// LOG_LEVEL=info
//
// Dépendances : express cors axios dotenv winston helmet express-rate-limit
// npm i express cors axios dotenv winston helmet express-rate-limit

import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import winston from "winston";

dotenv.config();

// ---- logger (winston) -----------------------------------------------------
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

// ---- config ---------------------------------------------------------------
const PAYDUNYA_BASE = process.env.PAYDUNYA_BASE || "https://app.paydunya.com/api/v1";
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const PORT = process.env.PORT;

function paydunyaHeaders() {
  return {
    "PAYDUNYA-MASTER-KEY": process.env.PAYDUNYA_MASTER_KEY || "",
    "PAYDUNYA-PRIVATE-KEY": process.env.PAYDUNYA_PRIVATE_KEY || "",
    "PAYDUNYA-TOKEN": process.env.PAYDUNYA_TOKEN || "",
    "Content-Type": "application/json",
  };
}

// ---- app init -------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(helmet());

// basic rate limiter
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use(limiter);

// ---- helpers --------------------------------------------------------------
function extractCheckoutUrl(invoiceObj) {
  // PayDunya responses vary, try common fields
  if (!invoiceObj) return null;
  if (typeof invoiceObj === "string") return invoiceObj;
  // invoiceObj may contain checkout_url as string or object
  if (invoiceObj.checkout_url && typeof invoiceObj.checkout_url === "string") return invoiceObj.checkout_url;
  if (invoiceObj.payment_url && typeof invoiceObj.payment_url === "string") return invoiceObj.payment_url;
  if (invoiceObj.invoice_url && typeof invoiceObj.invoice_url === "string") return invoiceObj.invoice_url;
  // sometimes checkout_url is an object with payment_url
  if (invoiceObj.checkout_url && invoiceObj.checkout_url.payment_url) return invoiceObj.checkout_url.payment_url;
  if (invoiceObj.url) return invoiceObj.url;
  // fallback: try to find any string field that looks like a url
  for (const k of Object.keys(invoiceObj)) {
    const v = invoiceObj[k];
    if (typeof v === "string" && v.startsWith("http")) return v;
  }
  return null;
}

// ---- routes ---------------------------------------------------------------

app.get("/", (req, res) => {
  res.send("✅ Serveur PayCash minimal (no-storage) — en ligne");
});

// Create invoice (checkout) - PayIn
// Body: { amount, userId, operator }
// Response: { status: 'success', token, payment_url, raw: <paydunya-response> }
app.post("/recharge", async (req, res) => {
  try {
    const { amount, userId, operator } = req.body;
    if (!amount || !userId || !operator) {
      return res.status(400).json({ status: "error", message: "Champs manquants: amount, userId, operator" });
    }

    const payload = {
      items: [
        {
          name: `Recharge PayCash via ${operator}`,
          quantity: 1,
          unit_price: amount,
          total_price: amount,
        },
      ],
      total_amount: amount,
      // Set callback and ipn URLs so PayDunya knows where to redirect and notify
      callback_url: `${BASE_URL}/paydunya_callback?userId=${encodeURIComponent(userId)}`,
      ipn_url: `${BASE_URL}/ipn`,
    };

    const pdRes = await axios.post(`${PAYDUNYA_BASE}/checkout-invoice/create`, payload, {
      headers: paydunyaHeaders(),
      timeout: 15000,
    });

    const invoice = pdRes.data;
    console.log("PayDunya response:", invoice);
    const token = invoice?.token ?? invoice?.invoice_token ?? null;
    const payment_url = extractCheckoutUrl(invoice) || null;

    logger.info(`Created invoice token=${token} user=${userId}`);

    return res.json({
      status: "success",
      token,
      payment_url,
      raw: invoice,
    });
  } catch (err) {
    logger.error("Recharge error: " + (err.response?.data || err.message));
    const message = err.response?.data || err.message || "Erreur création facture";
    return res.status(500).json({ status: "error", message });
  }
});

// Invoice status check (used by app polling)
// GET /invoice_status?token=...
// Response: { status: 'success', data: <paydunya-confirm-response> }
app.get("/invoice_status", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ status: "error", message: "token manquant" });

    const verify = await axios.get(`${PAYDUNYA_BASE}/checkout-invoice/confirm/${token}`, {
      headers: paydunyaHeaders(),
      timeout: 10000,
    });

    return res.json({ status: "success", data: verify.data });
  } catch (err) {
    logger.error("Invoice status error: " + (err.response?.data || err.message));
    const message = err.response?.data || err.message || "Erreur verify";
    return res.status(500).json({ status: "error", message });
  }
});

// IPN endpoint (PayDunya will POST here). We verify via confirm/{token} and return result.
// Note: we do NOT persist anything here (per your request).
app.post("/ipn", async (req, res) => {
  try {
    const { invoice } = req.body;
    if (!invoice) {
      logger.warn("IPN called without invoice");
      return res.status(400).send("NO_INVOICE");
    }

    const token = invoice.token || invoice.invoice_token || null;
    if (!token) {
      logger.warn("IPN invoice has no token");
      return res.status(400).send("NO_TOKEN");
    }

    const verify = await axios.get(`${PAYDUNYA_BASE}/checkout-invoice/confirm/${token}`, {
      headers: paydunyaHeaders(),
      timeout: 10000,
    });

    logger.info(`IPN verify result token=${token} status=${verify.data?.status}`);

    // Return the verify payload to whoever called (PayDunya expects 200)
    // We keep behavior simple: return OK when processed
    return res.status(200).json({ status: "success", data: verify.data });
  } catch (err) {
    logger.error("IPN error: " + (err.response?.data || err.message));
    return res.status(500).send("ERROR");
  }
});

// Callback endpoint (user redirect after payment). Minimal page.
// GET /paydunya_callback?token=...&userId=...
app.get("/paydunya_callback", (req, res) => {
  const { token, userId } = req.query;
  // In mobile flows you typically deep-link back into the app; for simplicity return a small page
  res.send(`<html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: Arial, Helvetica, sans-serif; text-align:center; padding:30px;">
      <h2>Paiement reçu</h2>
      <p>Token: <strong>${token || ""}</strong></p>
      <p>Utilisateur: <strong>${userId || ""}</strong></p>
      <p>Vous pouvez fermer cette page et retourner à l'application.</p>
    </body>
  </html>`);
});

// Withdraw (disburse)
// Body: { amount, phone, operator }
// Response: raw PayDunya response (status, message, data)
app.post("/withdraw", async (req, res) => {
  try {
    const { amount, phone, operator } = req.body;
    if (!amount || !phone || !operator) {
      return res.status(400).json({ status: "error", message: "Champs manquants: amount, phone, operator" });
    }

    const payload = {
      account_alias: phone,
      amount: amount,
      withdraw_mode: operator === "YAS" ? "tmoney" : "flooz",
    };

    const pdRes = await axios.post(`${PAYDUNYA_BASE}/disburse`, payload, {
      headers: paydunyaHeaders(),
      timeout: 15000,
    });

    logger.info(`Disburse called phone=${phone} amount=${amount} -> status=${pdRes.data?.status}`);

    return res.json({ status: "success", raw: pdRes.data });
  } catch (err) {
    logger.error("Withdraw error: " + (err.response?.data || err.message));
    const message = err.response?.data || err.message || "Erreur disburse";
    return res.status(500).json({ status: "error", message });
  }
});

// ---- start server ---------------------------------------------------------
app.listen(PORT, () => logger.info(`✅ Serveur PayCash (no-storage) sur le port ${PORT}`));
