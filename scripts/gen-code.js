#!/usr/bin/env node
/**
 * scripts/gen-code.js
 *
 * Usage:
 *   npm run gen-code                 -> prints a new unique access code
 *   npm run gen-code -- --revoke CODE -> revokes CODE
 *   npm run gen-code -- --list        -> lists stored codes (admin)
 *
 * Codes are stored in data/codes.json (git-ignored, created at runtime).
 */

import { addCode, revokeCode, listCodes } from "../lib/codes.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars

function randomCode() {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function uniqueCode() {
  const existing = new Set(listCodes().map((c) => c.code));
  let code = randomCode();
  while (existing.has(code)) code = randomCode();
  return code;
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "--revoke" && arg) {
  const ok = revokeCode(arg);
  console.log(ok ? `Revoked ${String(arg).trim().toUpperCase()}.` : `Code not found: ${arg}`);
  process.exit(ok ? 0 : 1);
} else if (cmd === "--list") {
  const codes = listCodes();
  if (!codes.length) {
    console.log("No codes stored yet.");
  } else {
    for (const c of codes) {
      console.log(`${c.code}  created=${c.createdAt}  revoked=${c.revoked}`);
    }
  }
} else if (cmd && cmd.startsWith("--")) {
  console.error(`Unknown option: ${cmd}\nUsage: npm run gen-code [-- --revoke CODE | -- --list]`);
  process.exit(1);
} else {
  const code = uniqueCode();
  addCode(code);
  console.log(code);
}
