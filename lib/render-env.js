/**
 * lib/render-env.js
 *
 * Lets the running service append newly issued buyer codes to its own
 * Render ACCESS_CODES env var, so codes survive restarts/redeploys on
 * Render's ephemeral free-tier filesystem.
 *
 * Requires RENDER_API_KEY and RENDER_SERVICE_ID env vars. Best-effort:
 * failures are logged, never thrown — the code already works in-memory
 * and on local disk until the next restart.
 */

const API = "https://api.render.com/v1";

function creds() {
  const apiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;
  if (!apiKey || !serviceId) return null;
  return { apiKey, serviceId };
}

async function api(path, method = "GET", body) {
  const { apiKey, serviceId } = creds();
  const res = await fetch(`${API}/services/${serviceId}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Render API ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Append `code` to the ACCESS_CODES env var (deduped). Sends the full
 * merged env-var list so the update is safe whether Render's PUT
 * replaces or upserts. Returns true on success.
 */
export async function persistCodeToEnv(code) {
  const c = creds();
  if (!c) {
    console.warn("[render-env] RENDER_API_KEY/RENDER_SERVICE_ID not set — code will not survive restarts.");
    return false;
  }
  try {
    const list = await api("/env-vars");
    const vars = Array.isArray(list) ? list.map((i) => i.envVar || i).filter((v) => v && v.key) : [];
    const entry = vars.find((v) => v.key === "ACCESS_CODES");
    const current = String(entry?.value || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (current.includes(code)) return true;
    current.push(code);
    const next = vars.map((v) =>
      v.key === "ACCESS_CODES" ? { key: v.key, value: current.join(",") } : { key: v.key, value: v.value }
    );
    if (!entry) next.push({ key: "ACCESS_CODES", value: current.join(",") });
    await api("/env-vars", "PUT", next);
    console.log(`[render-env] persisted new buyer code to ACCESS_CODES (${current.length} total).`);
    return true;
  } catch (err) {
    console.warn(`[render-env] failed to persist code: ${err.message}`);
    return false;
  }
}
