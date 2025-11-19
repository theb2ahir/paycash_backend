// server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 🔹 URL de base PayDunya
const PAYDUNYA_BASE = "https://app.paydunya.com/api/v1";

// =========================
// 🔹 Route IPN PayDunya
// =========================
app.post("/ipn", async (req, res) => {
  try {
    const { invoice } = req.body;

    if (!invoice) return res.status(400).send("NO_INVOICE");

    // Vérification auprès de PayDunya
    const verify = await axios.get(
      `${PAYDUNYA_BASE}/checkout-invoice/confirm/${invoice.token}`,
      {
        headers: {
          "PAYDUNYA-MASTER-KEY": process.env.PAYDUNYA_MASTER_KEY,
          "PAYDUNYA-PRIVATE-KEY": process.env.PAYDUNYA_PRIVATE_KEY,
          "PAYDUNYA-TOKEN": process.env.PAYDUNYA_TOKEN,
        },
      }
    );

    if (verify.data.status === "completed") {
      // 🔹 Paiement validé : mettre à jour le portefeuille ici
      console.log("Paiement confirmé :", verify.data);
      res.status(200).send("OK");
    } else {
      console.log("Paiement non validé :", verify.data);
      res.status(200).send("FAILED");
    }
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send("ERROR");
  }
});

// =========================
// 🔹 Route Recharge
// =========================
app.post("/recharge", async (req, res) => {
  const { amount, userId, operator } = req.body;

  if (!amount || !userId || !operator) {
    return res.status(400).json({ status: "error", message: "Champs manquants" });
  }

  try {
    const response = await axios.post(
      `${PAYDUNYA_BASE}/checkout-invoice/create`,
      {
        items: [
          {
            name: `Recharge via ${operator}`,
            quantity: 1,
            unit_price: amount,
            total_price: amount,
          },
        ],
        total_amount: amount,
      },
      {
        headers: {
          "PAYDUNYA-MASTER-KEY": process.env.PAYDUNYA_MASTER_KEY,
          "PAYDUNYA-PRIVATE-KEY": process.env.PAYDUNYA_PRIVATE_KEY,
          "PAYDUNYA-TOKEN": process.env.PAYDUNYA_TOKEN,
        },
      }
    );

    res.json({
      status: "success",
      message: "Facture créée avec succès",
      invoice: response.data,
    });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ status: "error", message: "Erreur PayDunya" });
  }
});

// =========================
// 🔹 Route Retrait
// =========================
app.post("/withdraw", async (req, res) => {
  const { amount, phone, operator } = req.body;

  if (!amount || !phone || !operator) {
    return res.status(400).json({ status: "error", message: "Champs manquants" });
  }

  try {
    const response = await axios.post(
      `${PAYDUNYA_BASE}/disburse`,
      {
        account_alias: phone,
        amount: amount,
        withdraw_mode: operator === "YAS" ? "tmoney" : "flooz",
      },
      {
        headers: {
          "PAYDUNYA-MASTER-KEY": process.env.PAYDUNYA_MASTER_KEY,
          "PAYDUNYA-PRIVATE-KEY": process.env.PAYDUNYA_PRIVATE_KEY,
          "PAYDUNYA-TOKEN": process.env.PAYDUNYA_TOKEN,
        },
      }
    );

    if (response.data?.status === "success") {
      res.json({
        status: "success",
        message: "Retrait effectué avec succès",
        data: response.data,
      });
    } else {
      res.json({
        status: "error",
        message: response.data?.message || "Retrait échoué",
        data: response.data,
      });
    }
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ status: "error", message: "Erreur lors du retrait" });
  }
});

// =========================
// 🔹 Démarrage serveur
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Serveur PayCash backend sur le port ${PORT}`));
