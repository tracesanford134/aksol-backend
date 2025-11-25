// server.mjs
import express from "express";
import cors from "cors";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
} from "@solana/web3.js";
import "dotenv/config";

const PORT = process.env.PORT || 8080;
const LAMPORTS_PER_SOL = 1_000_000_000;

const app = express();

/**
 * CORS configuration
 * - Allows local dev and your production/frontend domains.
 * - Blocks unknown origins to keep the backend tidy.
 */
const allowedOrigins = [
  "http://localhost:5173",            // Vite dev
  "http://localhost:4173",            // Vite preview (optional)
  "https://aksoldapp.netlify.app",    // NEW Netlify dapp URL
  "https://alaskacrypto.financial",
  "https://www.alaskacrypto.financial",
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser tools without origin (curl, Postman, etc.)
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn(`[CORS] Blocked origin: ${origin}`);
      return callback(new Error("Not allowed by CORS"));
    },
  }),
);

app.use(express.json());

// Log every incoming request
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// Root route
app.get("/", (_req, res) => {
  res.send("AKSOL backend is running");
});

// Status route
app.post("/aksol/status", async (req, res) => {
  const cluster = (req.body && req.body.cluster) || "devnet";
  const connection = new Connection(clusterApiUrl(cluster), "confirmed");

  try {
    const version = await connection.getVersion();
    res.json({
      ok: true,
      cluster,
      backendVersion: "1.0.0",
      solanaVersion: version["solana-core"],
    });
  } catch (e) {
    console.error("Error in /aksol/status", e);
    res.status(500).json({
      ok: false,
      error: String(e),
    });
  }
});

// 3% taxed send route
app.post("/aksol/send-taxed-tx", async (req, res) => {
  console.log(">>> HIT /aksol/send-taxed-tx with body:", req.body);

  try {
    const { fromPubkey, toPubkey, amountUi, cluster } = req.body || {};

    if (!fromPubkey || !toPubkey || amountUi == null) {
      console.warn("Missing required fields");
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: fromPubkey, toPubkey, amountUi.",
      });
    }

    const from = new PublicKey(fromPubkey);
    const to = new PublicKey(toPubkey);

    const lamports = Math.round(Number(amountUi) * LAMPORTS_PER_SOL);
    if (!Number.isFinite(lamports) || lamports <= 0) {
      console.warn("Invalid amount:", amountUi);
      return res.status(400).json({
        ok: false,
        error: "Invalid amount.",
      });
    }

    const taxWalletStr = process.env.AKSOL_TAX_WALLET;
    if (!taxWalletStr) {
      console.error("AKSOL_TAX_WALLET not configured");
      return res.status(500).json({
        ok: false,
        error: "AKSOL_TAX_WALLET not configured.",
      });
    }
    const taxWallet = new PublicKey(taxWalletStr);

    const taxBps = 300; // 3% tax
    const taxLamports = Math.floor((lamports * taxBps) / 10000);
    const netLamports = lamports - taxLamports;

    const selectedCluster = cluster || "devnet";
    const connection = new Connection(
      clusterApiUrl(selectedCluster),
      "confirmed",
    );

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: from,
    });

    // 1) Net amount to recipient
    tx.add(
      SystemProgram.transfer({
        fromPubkey: from,
        toPubkey: to,
        lamports: netLamports,
      }),
    );

    // 2) Tax amount to tax wallet
    tx.add(
      SystemProgram.transfer({
        fromPubkey: from,
        toPubkey: taxWallet,
        lamports: taxLamports,
      }),
    );

    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    const base64Tx = Buffer.from(serialized).toString("base64");

    console.log("<<< Responding from /aksol/send-taxed-tx OK");

    res.json({
      ok: true,
      transaction: base64Tx,
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      taxLamports,
      netLamports,
    });
  } catch (e) {
    console.error("Error in /aksol/send-taxed-tx", e);
    res.status(500).json({
      ok: false,
      error: String(e),
    });
  }
});

// 0% purchase route (no tax; full amount to 0% wallet)
app.post("/aksol/zero-percent-purchase", async (req, res) => {
  console.log(
    ">>> HIT /aksol/zero-percent-purchase with body:",
    req.body,
  );

  try {
    const { fromPubkey, amountUi, cluster } = req.body || {};

    if (!fromPubkey || amountUi == null) {
      console.warn("Missing required fields");
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: fromPubkey, amountUi.",
      });
    }

    const from = new PublicKey(fromPubkey);

    const lamports = Math.round(Number(amountUi) * LAMPORTS_PER_SOL);
    if (!Number.isFinite(lamports) || lamports <= 0) {
      console.warn("Invalid amount:", amountUi);
      return res.status(400).json({
        ok: false,
        error: "Invalid amount.",
      });
    }

    const zeroTaxWalletStr =
      process.env.AKSOL_ZERO_TAX_WALLET || process.env.AKSOL_TAX_WALLET;
    if (!zeroTaxWalletStr) {
      console.error("AKSOL_ZERO_TAX_WALLET not configured");
      return res.status(500).json({
        ok: false,
        error: "AKSOL_ZERO_TAX_WALLET not configured.",
      });
    }
    const zeroTaxWallet = new PublicKey(zeroTaxWalletStr);

    const selectedCluster = cluster || "devnet";
    const connection = new Connection(
      clusterApiUrl(selectedCluster),
      "confirmed",
    );

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: from,
    });

    // 100% of amount goes to 0% route wallet
    tx.add(
      SystemProgram.transfer({
        fromPubkey: from,
        toPubkey: zeroTaxWallet,
        lamports,
      }),
    );

    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base64Tx = Buffer.from(serialized).toString("base64");

    console.log("<<< Responding from /aksol/zero-percent-purchase OK");

    res.json({
      ok: true,
      transaction: base64Tx,
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      lamports,
    });
  } catch (e) {
    console.error("Error in /aksol/zero-percent-purchase", e);
    res.status(500).json({
      ok: false,
      error: String(e),
    });
  }
});

// Catch-all 404 so we see missing routes
app.use((req, res) => {
  console.log(`[404] No route for ${req.method} ${req.url}`);
  res.status(404).send(`No route for ${req.method} ${req.url}`);
});

app.listen(PORT, () => {
  console.log(`AKSOL backend listening on port ${PORT}`);
});
