/**
 * lib/codes.js
 *
 * Access-code store backed by a small JSON file at data/codes.json
 * (created at runtime; git-ignored so real codes are never committed).
 *
 * On ephemeral hosting (e.g. Render's free tier) the local file is wiped on
 * every restart/redeploy, which would kill all buyer codes. To survive that,
 * codes can also be supplied via the ACCESS_CODES environment variable
 * (comma-separated, e.g. "AB12-CD34,EF56-GH78"). Env codes are merged in on
 * every load, so they work even when the file is gone. Manage them in the
 * host dashboard; the file remains useful for local development.
 *
 * Codes are normalized with trim().toUpperCase() before storage and
 * comparison, so " abc-123 " and "ABC-123" are the same code.
 *
 * Shape of data/codes.json:
 *   { "codes": [ { "code": "X7KQ-9P2M", "createdAt": "<ISO>", "revoked": false } ] }
 */

import fs from "node:fs";
import path from "node:path";

const FILE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "data",
  "codes.json"
);

/** Codes from the ACCESS_CODES env var (comma-separated). */
function envCodes() {
  const raw = process.env.ACCESS_CODES || "";
  return raw
    .split(",")
    .map((c) => normalize(c))
    .filter(Boolean);
}

/** Raw file contents only — never includes env codes. */
function loadFile() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.codes)) return parsed;
    return { codes: [] };
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn(`[codes] Could not read ${FILE}: ${err.message} — using empty store.`);
    }
    return { codes: [] };
  }
}

function saveFile(store) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/** Merged view: file codes first, then env codes not already present. */
function load() {
  const file = loadFile();
  const seen = new Set(file.codes.map((c) => c.code));
  const merged = file.codes.map((c) => ({ ...c }));
  for (const code of envCodes()) {
    if (!seen.has(code)) {
      merged.push({ code, createdAt: null, revoked: false, source: "env" });
      seen.add(code);
    }
  }
  return { codes: merged };
}

export function normalize(code) {
  return String(code ?? "").trim().toUpperCase();
}

/** All codes (for admin tooling). Returns copies, never live references. */
export function listCodes() {
  return load().codes.map((c) => ({ ...c }));
}

/** Add a code to the file store; returns the stored entry. Idempotent. */
export function addCode(code) {
  const normalized = normalize(code);
  if (!normalized) throw new Error("Code must be a non-empty string.");
  const store = loadFile();
  const existing = store.codes.find((c) => c.code === normalized);
  if (existing) return { ...existing };
  const entry = {
    code: normalized,
    createdAt: new Date().toISOString(),
    revoked: false,
  };
  store.codes.push(entry);
  saveFile(store);
  return { ...entry };
}

/** Generate a fresh unique code, store it, and return the entry. */
export function createCode() {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  const existing = new Set(load().codes.map((c) => c.code));
  let code;
  do {
    let s = "";
    for (let i = 0; i < 8; i++) {
      s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    code = `${s.slice(0, 4)}-${s.slice(4)}`;
  } while (existing.has(code));
  return addCode(code);
}

/** True when the code exists (file or env) and is not revoked. */
export function verifyCode(code) {
  const normalized = normalize(code);
  if (!normalized) return false;
  const entry = load().codes.find((c) => c.code === normalized);
  return Boolean(entry) && !entry.revoked;
}

/** Revoke a code (persisted in the file store); returns true when found. */
export function revokeCode(code) {
  const normalized = normalize(code);
  if (!normalized) return false;
  const store = loadFile();
  const entry = store.codes.find((c) => c.code === normalized);
  if (entry) {
    entry.revoked = true;
    saveFile(store);
    return true;
  }
  // Env-sourced code: record the revocation in the file so it sticks.
  if (envCodes().includes(normalized)) {
    store.codes.push({
      code: normalized,
      createdAt: new Date().toISOString(),
      revoked: true,
    });
    saveFile(store);
    return true;
  }
  return false;
}
