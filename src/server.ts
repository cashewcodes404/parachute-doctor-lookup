/**
 * Parachute Doctor Lookup — HTTP Service
 *
 * Runs on Railway. Accepts an NPI and/or doctor name, logs into
 * Parachute Health, checks the doctor's signature count, and returns
 * a contact method determination: "parachute" or "fax".
 *
 * Threshold: >15 signed orders → "parachute", else "fax"
 *
 * Endpoints:
 *   GET  /api/lookup?npi=<npi>&name=<name>
 *   GET  /health
 *
 * Environment variables:
 *   PARACHUTE_EMAIL    — login email
 *   PARACHUTE_PASSWORD — login password
 *   PARACHUTE_ORG_ID   — org slug (e.g. BGP3-YIEG1-Z8-SL)
 *   PORT               — server port (default 3000)
 *   SIGNATURE_THRESHOLD — override the 15-order threshold (optional)
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { ParachuteClient, Doctor } from "./client.js";

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const SIGNATURE_THRESHOLD = parseInt(process.env.SIGNATURE_THRESHOLD ?? "15", 10);

const PARACHUTE_EMAIL = process.env.PARACHUTE_EMAIL ?? "";
const PARACHUTE_PASSWORD = process.env.PARACHUTE_PASSWORD ?? "";
const PARACHUTE_ORG_ID = process.env.PARACHUTE_ORG_ID ?? "";

// ── Session management ──────────────────────────────────────────────────────
// Re-login when the session expires (Devise cookies last ~2-4 hours).

let cachedClient: ParachuteClient | null = null;
let lastLoginAt = 0;
const SESSION_TTL_MS = 90 * 60 * 1000; // re-login every 90 minutes to be safe

async function getClient(): Promise<ParachuteClient> {
  const now = Date.now();
  if (cachedClient && now - lastLoginAt < SESSION_TTL_MS) {
    return cachedClient;
  }

  console.log("[parachute] Logging in as", PARACHUTE_EMAIL);
  cachedClient = await ParachuteClient.login({
    email: PARACHUTE_EMAIL,
    password: PARACHUTE_PASSWORD,
    orgId: PARACHUTE_ORG_ID,
  });
  lastLoginAt = now;
  console.log("[parachute] Login successful");
  return cachedClient;
}

// ── Contact method determination ────────────────────────────────────────────

export type DoctorContactResult = {
  doctor_contact: "parachute" | "fax";
  doctor_name: string;
  npi: string;
  signature_count: number;
  threshold: number;
  breakdown: Record<string, number>;
  matched_by: "npi" | "name" | "none";
};

/**
 * Determine the contact method for a doctor.
 *
 * Strategy:
 *   1. Search by NPI (exact match, most reliable)
 *   2. If no NPI or NPI not found, search by name and pick the best match
 *   3. Apply threshold: >15 signed orders = "parachute", else "fax"
 */
async function getDoctorContact(
  npi: string | null,
  name: string | null
): Promise<DoctorContactResult | null> {
  const client = await getClient();

  let doc: Doctor | null = null;
  let matchedBy: "npi" | "name" | "none" = "none";

  // Strategy 1: NPI lookup
  if (npi) {
    try {
      doc = await client.lookupByNpi(npi);
      if (doc) matchedBy = "npi";
    } catch (e) {
      console.error("[parachute] NPI lookup failed:", (e as Error).message);
      // If session expired, force re-login and retry once
      if ((e as Error).message.includes("expired")) {
        cachedClient = null;
        const freshClient = await getClient();
        doc = await freshClient.lookupByNpi(npi);
        if (doc) matchedBy = "npi";
      }
    }
  }

  // Strategy 2: Name search (fallback or verification)
  if (!doc && name) {
    try {
      const client = await getClient();
      const results = await client.searchDoctors(name);

      if (results.length === 1) {
        doc = results[0];
        matchedBy = "name";
      } else if (results.length > 1) {
        // If we have an NPI, try to match within name results
        if (npi) {
          const npiMatch = results.find((d) => d.npi === npi);
          if (npiMatch) {
            doc = npiMatch;
            matchedBy = "npi";
          }
        }

        // Otherwise pick the one with the highest signature count
        if (!doc) {
          results.sort((a, b) => b.signature_count - a.signature_count);
          doc = results[0];
          matchedBy = "name";
          console.log(
            `[parachute] Multiple results for "${name}" — using top match: ${doc.first_name} ${doc.last_name} (${doc.signature_count} sigs)`
          );
        }
      }
    } catch (e) {
      console.error("[parachute] Name search failed:", (e as Error).message);
      if ((e as Error).message.includes("expired")) {
        cachedClient = null;
      }
    }
  }

  if (!doc) return null;

  const contactMethod = doc.signature_count > SIGNATURE_THRESHOLD ? "parachute" : "fax";

  return {
    doctor_contact: contactMethod,
    doctor_name: `${doc.first_name} ${doc.last_name}`,
    npi: doc.npi,
    signature_count: doc.signature_count,
    threshold: SIGNATURE_THRESHOLD,
    breakdown: doc.cache_signatures_counts as unknown as Record<string, number>,
    matched_by: matchedBy,
  };
}

// ── HTTP server ─────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx < 0) return {};
  const params: Record<string, string> = {};
  for (const pair of url.slice(idx + 1).split("&")) {
    const [k, v] = pair.split("=");
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return params;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // Health check
  if (url === "/health" || url === "/") {
    sendJson(res, 200, { status: "ok", service: "parachute-doctor-lookup", nodeVersion: process.version });
    return;
  }

  // Debug: test login flow step by step
  if (url === "/debug/login-test") {
    const steps: string[] = [];
    try {
      steps.push(`Node ${process.version}`);
      steps.push(`Email configured: ${!!PARACHUTE_EMAIL}`);
      steps.push(`Password configured: ${!!PARACHUTE_PASSWORD}`);
      steps.push(`Org configured: ${!!PARACHUTE_ORG_ID}`);

      // Step 1: GET login page
      const getRes = await fetch("https://dme.parachutehealth.com/users/log_in", {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html",
        },
      });
      steps.push(`GET status: ${getRes.status}`);

      // Check getSetCookie availability
      const hasGetSetCookie = typeof (getRes.headers as any).getSetCookie === "function";
      steps.push(`getSetCookie available: ${hasGetSetCookie}`);

      const rawSetCookie = getRes.headers.get("set-cookie");
      steps.push(`Raw set-cookie header: ${rawSetCookie ? rawSetCookie.slice(0, 80) + "..." : "null"}`);

      if (hasGetSetCookie) {
        const cookies = (getRes.headers as any).getSetCookie();
        steps.push(`getSetCookie() count: ${cookies.length}`);
      }

      const html = await getRes.text();
      steps.push(`HTML length: ${html.length}`);

      const csrfMatch = html.match(/name="csrf-token"\s+content="([^"]+)"/);
      steps.push(`CSRF found: ${!!csrfMatch}`);
      if (csrfMatch) steps.push(`CSRF length: ${csrfMatch[1].length}`);

      // Extract session cookie manually
      const sessionMatch = rawSetCookie?.match(/_session_id=([^;]+)/);
      steps.push(`Session cookie found: ${!!sessionMatch}`);

      if (csrfMatch && sessionMatch) {
        const csrf = csrfMatch[1];
        const sessionCookie = `_session_id=${sessionMatch[1]}`;

        // Strategy A: JSON POST with X-CSRF-Token header
        const postResA = await fetch("https://dme.parachutehealth.com/users/log_in.json", {
          method: "POST",
          redirect: "manual",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
            "X-CSRF-Token": csrf,
            "X-Requested-With": "XMLHttpRequest",
            Origin: "https://dme.parachutehealth.com",
            Referer: "https://dme.parachutehealth.com/users/log_in",
            Cookie: sessionCookie,
          },
          body: JSON.stringify({ login: PARACHUTE_EMAIL, password: PARACHUTE_PASSWORD }),
        });
        steps.push(`Strategy A (JSON+header): ${postResA.status} → ${(await postResA.text()).slice(0, 150)}`);

        // GET a fresh session for strategy B
        const getRes2 = await fetch("https://dme.parachutehealth.com/users/log_in", {
          method: "GET",
          redirect: "manual",
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", Accept: "text/html" },
        });
        const html2 = await getRes2.text();
        const csrf2 = html2.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1] ?? "";
        const sc2 = getRes2.headers.get("set-cookie");
        const sid2 = sc2?.match(/_session_id=([^;]+)/)?.[1] ?? "";
        const sessionCookie2 = `_session_id=${sid2}`;

        // Strategy B: JSON POST with authenticity_token IN body
        const postResB = await fetch("https://dme.parachutehealth.com/users/log_in.json", {
          method: "POST",
          redirect: "manual",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest",
            Origin: "https://dme.parachutehealth.com",
            Referer: "https://dme.parachutehealth.com/users/log_in",
            Cookie: sessionCookie2,
          },
          body: JSON.stringify({ login: PARACHUTE_EMAIL, password: PARACHUTE_PASSWORD, authenticity_token: csrf2 }),
        });
        steps.push(`Strategy B (JSON+body token): ${postResB.status} → ${(await postResB.text()).slice(0, 150)}`);

        // GET a fresh session for strategy C
        const getRes3 = await fetch("https://dme.parachutehealth.com/users/log_in", {
          method: "GET",
          redirect: "manual",
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", Accept: "text/html" },
        });
        const html3 = await getRes3.text();
        const csrf3 = html3.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1] ?? "";
        const sc3 = getRes3.headers.get("set-cookie");
        const sid3 = sc3?.match(/_session_id=([^;]+)/)?.[1] ?? "";

        // Strategy C: Form POST to /users/log_in (not .json)
        const formBody = new URLSearchParams({
          "login": PARACHUTE_EMAIL,
          "password": PARACHUTE_PASSWORD,
          "authenticity_token": csrf3,
          "commit": "Log in",
        });
        const postResC = await fetch("https://dme.parachutehealth.com/users/log_in", {
          method: "POST",
          redirect: "manual",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Origin: "https://dme.parachutehealth.com",
            Referer: "https://dme.parachutehealth.com/users/log_in",
            Cookie: `_session_id=${sid3}`,
          },
          body: formBody.toString(),
        });
        steps.push(`Strategy C (form POST /log_in): ${postResC.status}`);
        const postCHeaders = Object.fromEntries(postResC.headers.entries());
        steps.push(`Strategy C headers: ${JSON.stringify(postCHeaders).slice(0, 200)}`);
        const postCBody = await postResC.text();
        steps.push(`Strategy C body length: ${postCBody.length}, snippet: ${postCBody.slice(0, 150)}`);

        // Strategy D: user[email] / user[password] form fields (old Devise style) with fresh session
        const getRes4 = await fetch("https://dme.parachutehealth.com/users/log_in", {
          method: "GET",
          redirect: "manual",
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", Accept: "text/html" },
        });
        const html4 = await getRes4.text();
        const csrf4 = html4.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1] ?? "";
        const sc4 = getRes4.headers.get("set-cookie");
        const sid4 = sc4?.match(/_session_id=([^;]+)/)?.[1] ?? "";
        const formBody2 = new URLSearchParams({
          "user[email]": PARACHUTE_EMAIL,
          "user[password]": PARACHUTE_PASSWORD,
          "authenticity_token": csrf4,
          "commit": "Log in",
        });
        const postResD = await fetch("https://dme.parachutehealth.com/users/log_in", {
          method: "POST",
          redirect: "manual",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Origin: "https://dme.parachutehealth.com",
            Referer: "https://dme.parachutehealth.com/users/log_in",
            Cookie: `_session_id=${sid4}`,
          },
          body: formBody2.toString(),
        });
        steps.push(`Strategy D (form user[email]): ${postResD.status}`);
        if (postResD.status === 302 || postResD.status === 303) {
          steps.push(`Strategy D redirect: ${postResD.headers.get("location")}`);
        }
        const postDBody = await postResD.text();
        steps.push(`Strategy D body length: ${postDBody.length}, snippet: ${postDBody.slice(0, 150)}`);
      }

      sendJson(res, 200, { steps });
    } catch (e) {
      steps.push(`ERROR: ${(e as Error).message}`);
      sendJson(res, 200, { steps });
    }
    return;
  }

  // Lookup endpoint
  if (url.startsWith("/api/lookup") && method === "GET") {
    const query = parseQuery(url);
    const npi = query.npi || null;
    const name = query.name || null;

    if (!npi && !name) {
      sendJson(res, 400, {
        error: "Missing required parameter: provide 'npi' and/or 'name'",
      });
      return;
    }

    console.log(`[parachute] Lookup request — NPI: ${npi ?? "none"}, Name: ${name ?? "none"}`);

    try {
      const result = await getDoctorContact(npi, name);

      if (!result) {
        console.log("[parachute] Doctor not found on Parachute Health");
        sendJson(res, 200, {
          doctor_contact: "fax",
          doctor_name: null,
          npi: npi,
          signature_count: 0,
          threshold: SIGNATURE_THRESHOLD,
          matched_by: "none",
          note: "Doctor not found on Parachute Health — defaulting to fax",
        });
        return;
      }

      console.log(
        `[parachute] Result: ${result.doctor_name} → ${result.doctor_contact} (${result.signature_count} sigs, matched by ${result.matched_by})`
      );
      sendJson(res, 200, result);
    } catch (e) {
      console.error("[parachute] Lookup error:", (e as Error).message);
      sendJson(res, 500, {
        error: "Lookup failed",
        message: (e as Error).message,
      });
    }
    return;
  }

  // 404
  sendJson(res, 404, { error: "Not found" });
}

// ── Startup ─────────────────────────────────────────────────────────────────

function validateEnv(): void {
  const missing: string[] = [];
  if (!PARACHUTE_EMAIL) missing.push("PARACHUTE_EMAIL");
  if (!PARACHUTE_PASSWORD) missing.push("PARACHUTE_PASSWORD");
  if (!PARACHUTE_ORG_ID) missing.push("PARACHUTE_ORG_ID");

  if (missing.length > 0) {
    console.error(`[parachute] Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

validateEnv();

const server = createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    console.error("[parachute] Unhandled error:", e);
    sendJson(res, 500, { error: "Internal server error" });
  });
});

server.listen(PORT, () => {
  console.log(`[parachute] Doctor lookup service running on port ${PORT}`);
  console.log(`[parachute] Threshold: ${SIGNATURE_THRESHOLD} signed orders`);
  console.log(`[parachute] Org: ${PARACHUTE_ORG_ID}`);
});
