// server.mjs
import nodemailer from "nodemailer";
import assert from "assert";

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

// Known-good devnet wallet (your wallet) as fallback
const DEFAULT_DEMO_WALLET = new PublicKey(
  "Dhq7PsLz3JZddmxvGZQ8q6HwtNJf9982LrCKPDpX6QTk",
);

// Helper: resolve a wallet from env with safe fallback
function resolveWallet(label, primary, secondary) {
  const raw = primary || secondary;
  if (!raw) {
    console.warn(`[WARN] ${label} not set; using DEFAULT_DEMO_WALLET`);
    return DEFAULT_DEMO_WALLET;
  }

  const trimmed = raw.trim();
  try {
    const pk = new PublicKey(trimmed);
    console.log(`[INFO] ${label} resolved to ${pk.toBase58()}`);
    return pk;
  } catch (e) {
    console.error(
      `[ERROR] ${label} invalid. raw=`,
      JSON.stringify(raw),
      "trimmed=",
      JSON.stringify(trimmed),
      "error=",
      e,
    );
    console.warn(`[WARN] Falling back to DEFAULT_DEMO_WALLET for ${label}`);
    return DEFAULT_DEMO_WALLET;
  }
}

const app = express();
app.use(cors());
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

    let from, to;
    try {
      from = new PublicKey(String(fromPubkey).trim());
    } catch (e) {
      console.error("Invalid fromPubkey:", fromPubkey, e);
      return res.status(400).json({
        ok: false,
        error: `Invalid fromPubkey: ${e}`,
      });
    }

    try {
      to = new PublicKey(String(toPubkey).trim());
    } catch (e) {
      console.error("Invalid toPubkey:", toPubkey, e);
      return res.status(400).json({
        ok: false,
        error: `Invalid toPubkey: ${e}`,
      });
    }

    const lamports = Math.round(Number(amountUi) * LAMPORTS_PER_SOL);
    if (!Number.isFinite(lamports) || lamports <= 0) {
      console.warn("Invalid amount:", amountUi);
      return res.status(400).json({
        ok: false,
        error: "Invalid amount.",
      });
    }

    // Resolve tax wallet safely (env + fallback)
    const taxWallet = resolveWallet(
      "AKSOL_TAX_WALLET",
      process.env.AKSOL_TAX_WALLET,
      null,
    );

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
  console.log(">>> HIT /aksol/zero-percent-purchase with body:", req.body);

  try {
    const { fromPubkey, amountUi, cluster } = req.body || {};

    if (!fromPubkey || amountUi == null) {
      console.warn("Missing required fields");
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: fromPubkey, amountUi.",
      });
    }

    let from;
    try {
      from = new PublicKey(String(fromPubkey).trim());
    } catch (e) {
      console.error("Invalid fromPubkey:", fromPubkey, e);
      return res.status(400).json({
        ok: false,
        error: `Invalid fromPubkey: ${e}`,
      });
    }

    const lamports = Math.round(Number(amountUi) * LAMPORTS_PER_SOL);
    if (!Number.isFinite(lamports) || lamports <= 0) {
      console.warn("Invalid amount:", amountUi);
      return res.status(400).json({
        ok: false,
        error: "Invalid amount.",
      });
    }

    // 1) Resolve the 0% route wallet:
    //    prefer AKSOL_ZERO_TAX_WALLET, else fall back to AKSOL_TAX_WALLET, else DEFAULT_DEMO_WALLET
    const zeroTaxWallet = resolveWallet(
      "AKSOL_ZERO_TAX_WALLET / AKSOL_TAX_WALLET",
      process.env.AKSOL_ZERO_TAX_WALLET,
      process.env.AKSOL_TAX_WALLET,
    );

    const selectedCluster = cluster || "devnet";
    const connection = new Connection(
      clusterApiUrl(selectedCluster),
      "confirmed",
    );

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    // 2) Build transaction: 100% of lamports → zeroTaxWallet
    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: from,
    });

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

    return res.json({
      ok: true,
      transaction: base64Tx,
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      lamports,
    });
  } catch (e) {
    console.error("Error in /aksol/zero-percent-purchase", e);
    return res.status(500).json({
      ok: false,
      error: String(e),
    });
  }
});

// Storefront purchase route (manual fulfillment, no on-chain tx here)
app.post("/aksol/storefront-purchase", async (req, res) => {
  console.log(">>> HIT /aksol/storefront-purchase with body:", req.body);

  try {
    const { fromPubkey, amountSol, estimatedAksol, note, cluster } =
      req.body || {};

    if (!fromPubkey || amountSol == null) {
      console.warn("Missing required fields for storefront");
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: fromPubkey, amountSol.",
      });
    }

    let from;
    try {
      from = new PublicKey(String(fromPubkey).trim());
    } catch (e) {
      console.error("Invalid fromPubkey (storefront):", fromPubkey, e);
      return res.status(400).json({
        ok: false,
        error: `Invalid fromPubkey: ${e}`,
      });
    }

    const solAmount = Number(amountSol);
    if (!Number.isFinite(solAmount) || solAmount <= 0) {
      console.warn("Invalid storefront SOL amount:", amountSol);
      return res.status(400).json({
        ok: false,
        error: "Invalid SOL amount.",
      });
    }

    const network = cluster || "mainnet-beta";

    // For now we just log. Later we can email, write to DB, etc.
    console.log("=== AKSOL STOREFRONT REQUEST ===");
    console.log("From wallet:", from.toBase58());
    console.log("SOL amount:", solAmount);
    console.log("Estimated AKSOL (client hint):", estimatedAksol);
    console.log("Note:", note);
    console.log("Network:", network);
    console.log("================================");

    // In a future step we can integrate nodemailer here to email you.

    return res.json({
      ok: true,
      message: "Storefront request recorded.",
    });
  } catch (e) {
    console.error("Error in /aksol/storefront-purchase", e);
    return res.status(500).json({
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
  console.log(`AKSOL backend listening on http://localhost:${PORT}`);
});
