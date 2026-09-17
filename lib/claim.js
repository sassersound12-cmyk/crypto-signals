/**
 * lib/claim.js
 *
 * Turns a paid Stripe Checkout Session into a buyer access code.
 *
 * Flow: GET /api/claim?session_id=cs_... -> look the session up at Stripe,
 * require payment_status === "paid", then issue (or re-issue, idempotently)
 * an access code for that session.
 *
 * No Stripe key configured  -> throws { status: 500 }
 * Unknown session           -> throws { status: 404 }
 * Session exists, not paid  -> throws { status: 402 }
 */

import { createCode, normalize } from "./codes.js";
import { persistCodeToEnv } from "./render-env.js";

// sessionId -> code (idempotent re-issue on refresh / double claim)
const issuedBySession = new Map();

function stripeKey() {
  return process.env.STRIPE_SECRET_KEY || "";
}

async function fetchSession(sessionId) {
  const key = stripeKey();
  if (!key) {
    const err = new Error("Payments are not configured on this server yet.");
    err.status = 500;
    throw err;
  }
  const res = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${key}` } }
  );
  if (res.status === 404) {
    const err = new Error("Checkout session not found.");
    err.status = 404;
    throw err;
  }
  if (!res.ok) {
    const err = new Error("Could not verify the payment with Stripe.");
    err.status = 502;
    throw err;
  }
  return res.json();
}

export async function claimCodeForSession(rawSessionId) {
  const sessionId = String(rawSessionId || "").trim();
  if (!/^cs_(test|live)_/.test(sessionId)) {
    const err = new Error("Missing or invalid checkout session.");
    err.status = 400;
    throw err;
  }

  const existing = issuedBySession.get(sessionId);
  if (existing) return { code: existing, repeat: true };

  const session = await fetchSession(sessionId);
  if (session.payment_status !== "paid") {
    const err = new Error("This checkout has not been paid yet.");
    err.status = 402;
    throw err;
  }

  const entry = createCode();
  const code = normalize(entry.code);
  issuedBySession.set(sessionId, code);

  // Best-effort: make the code survive Render restarts. Never blocks the buyer.
  persistCodeToEnv(code).catch(() => {});

  console.log(`[claim] issued code for session ${sessionId.slice(0, 12)}...`);
  return { code, repeat: false };
}
