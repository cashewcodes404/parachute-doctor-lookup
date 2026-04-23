/**
 * Parachute Health DME API Client
 *
 * Wraps the internal JSON endpoints exposed by dme.parachutehealth.com.
 * Authentication is handled via Rails session cookies (Devise).
 *
 * Discovered endpoints (April 2026 recon):
 *   GET /u/doctors_search.json?term=<name|npi>
 *   GET /u/r/<org>/dashboard/results.json?clinicians[]=<doctor_id>&page=<n>
 *   GET /u/r/<org>/dashboard/canceled_orders_count.json?clinicians[]=<id>
 *   GET /u/r/<org>/dashboard/new_messages_count.json?clinicians[]=<id>
 *   GET /u/r/<org>/dashboard/needs_follow_up_orders_count.json?clinicians[]=<id>
 */

const BASE_URL = "https://dme.parachutehealth.com";

// ── Types ────────────────────────────────────────────────────────────────────

/** Signature breakdown by method. All fields optional — the API returns
 *  a variable subset depending on the doctor's history. */
export interface SignatureBreakdown {
  fax?: number;
  sms?: number;
  epic?: number;
  email?: number;
  cerner?: number;
  onscreen?: number;
  self_sign?: number;
  fax_invite?: number;
  unknown_electronic?: number;
}

/** Normalize a raw breakdown from the API so every key is present (defaults to 0). */
function normalizeBreakdown(raw: Record<string, number | undefined>): Required<SignatureBreakdown> {
  return {
    fax: raw.fax ?? 0,
    sms: raw.sms ?? 0,
    epic: raw.epic ?? 0,
    email: raw.email ?? 0,
    cerner: raw.cerner ?? 0,
    onscreen: raw.onscreen ?? 0,
    self_sign: raw.self_sign ?? 0,
    fax_invite: raw.fax_invite ?? 0,
    unknown_electronic: raw.unknown_electronic ?? 0,
  };
}

export interface Doctor {
  doctor_id: string;
  first_name: string;
  last_name: string;
  npi: string;
  credential: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  zip: string;
  phone_number: string;
  masked_mobile_number: string | null;
  fax_number: string | null;
  masked_email: string | null;
  pecos_certified: boolean;
  signature_count: number;
  cache_signatures_counts: Required<SignatureBreakdown>;
  clinical_organizations: string[];
}

export interface DoctorSearchResponse {
  results: Doctor[];
}

export interface SessionConfig {
  /** The full cookie string from an authenticated browser session */
  cookie: string;
  /** Your org slug, e.g. "BGP3-YIEG1-Z8-SL" */
  orgId: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
  /** Your org slug — found in the URL after /u/r/ */
  orgId: string;
}

// ── Cookie jar helper ────────────────────────────────────────────────────────

function mergeSetCookies(
  existing: Map<string, string>,
  setCookieHeaders: string[]
): Map<string, string> {
  for (const raw of setCookieHeaders) {
    const parts = raw.split(";")[0]; // "name=value"
    const eqIdx = parts.indexOf("=");
    if (eqIdx > 0) {
      const name = parts.slice(0, eqIdx).trim();
      const value = parts.slice(eqIdx + 1).trim();
      existing.set(name, value);
    }
  }
  return existing;
}

function cookieMapToString(map: Map<string, string>): string {
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// ── Client ───────────────────────────────────────────────────────────────────

export class ParachuteClient {
  private cookieString: string;
  private orgId: string;
  private csrfToken: string | null = null;

  private constructor(cookieString: string, orgId: string) {
    this.cookieString = cookieString;
    this.orgId = orgId;
  }

  // ── Factory: from raw cookie string ──────────────────────────────────────

  /**
   * Create a client using a manually-provided cookie string.
   * Grab this from your browser DevTools → Application → Cookies.
   */
  static fromCookies(config: SessionConfig): ParachuteClient {
    return new ParachuteClient(config.cookie, config.orgId);
  }

  // ── Factory: programmatic login ──────────────────────────────────────────

  /**
   * Log in programmatically with email/password.
   * Parachute Health uses a React SPA with JSON login:
   *   1. GET /users/log_in → extract CSRF token from meta tag + session cookie
   *   2. POST /users/log_in.json (JSON body) → authenticate, capture session cookie
   *
   * The React app uses axios with jQuery UJS CSRF injection:
   *   - CSRF token comes from <meta name="csrf-token" content="...">
   *   - Sent as X-CSRF-Token header (NOT in body)
   *   - Field names are "login" and "password" (NOT user[email]/user[password])
   */
  static async login(creds: LoginCredentials): Promise<ParachuteClient> {
    const cookieJar = new Map<string, string>();

    // Step 1: GET login page for CSRF token + session cookie
    // Follow redirects manually to capture cookies from each hop
    // (Parachute redirects /users/sign_in → /users/log_in)
    let currentUrl = `${BASE_URL}/users/log_in`;
    let html = "";
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          Connection: "keep-alive",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
          ...(cookieJar.size > 0
            ? { Cookie: cookieMapToString(cookieJar) }
            : {}),
        },
      });

      const hopCookies = res.headers.getSetCookie?.() ?? [];
      mergeSetCookies(cookieJar, hopCookies);

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) break;
        currentUrl = location.startsWith("http")
          ? location
          : `${BASE_URL}${location}`;
        await res.text(); // drain body
        continue;
      }

      html = await res.text();
      break;
    }

    // Extract CSRF token from <meta name="csrf-token" content="...">
    const csrfMatch = html.match(
      /name="csrf-token"\s+content="([^"]+)"/
    );
    if (!csrfMatch) {
      throw new Error(
        "Could not extract CSRF token from login page. The page structure may have changed."
      );
    }
    const csrfToken = csrfMatch[1];

    // Step 2: POST JSON to /users/log_in.json
    // Mirrors the React SPA's axios call with jQuery UJS CSRF injection
    const loginRes = await fetch(`${BASE_URL}/users/log_in.json`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "X-CSRF-Token": csrfToken,
        "X-Requested-With": "XMLHttpRequest",
        Origin: BASE_URL,
        Referer: `${BASE_URL}/users/log_in`,
        Cookie: cookieMapToString(cookieJar),
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({
        login: creds.email,
        password: creds.password,
      }),
    });

    const setCookies2 = loginRes.headers.getSetCookie?.() ?? [];
    mergeSetCookies(cookieJar, setCookies2);

    // On success the JSON endpoint returns 200 with user data (or 302 redirect)
    // On failure it returns 401 with {"error":"...","type":"..."}
    if (loginRes.status === 401 || loginRes.status === 422) {
      const body = await loginRes.text();
      throw new Error(
        `Login failed (${loginRes.status}): ${body}. Check your email/password.`
      );
    }

    // Accept 200 (JSON success), 302/303 (redirect after auth)
    if (
      loginRes.status !== 200 &&
      loginRes.status !== 302 &&
      loginRes.status !== 303
    ) {
      const body = await loginRes.text();
      throw new Error(
        `Login failed with unexpected status ${loginRes.status}: ${body}`
      );
    }

    // If 302, follow the redirect to pick up any final cookies
    if (loginRes.status === 302 || loginRes.status === 303) {
      const location = loginRes.headers.get("location");
      if (location) {
        const redirectUrl = location.startsWith("http")
          ? location
          : `${BASE_URL}${location}`;
        const followRes = await fetch(redirectUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            Cookie: cookieMapToString(cookieJar),
          },
        });
        const followCookies = followRes.headers.getSetCookie?.() ?? [];
        mergeSetCookies(cookieJar, followCookies);
        await followRes.text(); // drain
      }
    } else {
      // 200 — drain the JSON body
      await loginRes.text();
    }

    const client = new ParachuteClient(
      cookieMapToString(cookieJar),
      creds.orgId
    );
    client.csrfToken = csrfToken;
    return client;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async request<T>(path: string): Promise<T> {
    const url = `${BASE_URL}${path}`;

    const res = await fetch(url, {
      headers: {
        Cookie: this.cookieString,
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });

    if (res.status === 401 || res.status === 302) {
      throw new Error(
        "Session expired or invalid. Please re-authenticate."
      );
    }

    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${await res.text()}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Search for doctors by name or NPI.
   * Returns up to 25 results per query.
   *
   * @param term - Doctor name (e.g. "smith") or NPI number (e.g. "1649859471")
   */
  async searchDoctors(term: string): Promise<Doctor[]> {
    const encoded = encodeURIComponent(term);
    const data = await this.request<{ results: Record<string, unknown>[] }>(
      `/u/doctors_search.json?term=${encoded}`
    );

    // Normalize each result: fill missing breakdown fields, default nullable strings
    return data.results.map((raw) => ({
      ...raw,
      credential: (raw.credential as string | null) ?? "",
      masked_email: (raw.masked_email as string | null) ?? null,
      cache_signatures_counts: normalizeBreakdown(
        raw.cache_signatures_counts as Record<string, number | undefined>
      ),
    })) as Doctor[];
  }

  /**
   * Look up a single doctor by NPI.
   * Returns null if not found.
   */
  async lookupByNpi(npi: string): Promise<Doctor | null> {
    const results = await this.searchDoctors(npi);
    return results.find((d) => d.npi === npi) ?? null;
  }

  /**
   * Get the signature count for a doctor by NPI.
   * This is the fastest way to answer "how many orders has this doctor signed?"
   *
   * Returns the total count plus the per-method breakdown.
   */
  async getSignatureCount(
    npi: string
  ): Promise<{
    doctor: string;
    npi: string;
    credential: string;
    total: number;
    breakdown: Required<SignatureBreakdown>;
  } | null> {
    const doc = await this.lookupByNpi(npi);
    if (!doc) return null;

    return {
      doctor: `${doc.first_name} ${doc.last_name}`,
      npi: doc.npi,
      credential: doc.credential ?? "",
      total: doc.signature_count,
      breakdown: doc.cache_signatures_counts,
    };
  }

  /**
   * Get the total order count for a clinician from the dashboard.
   * This uses the dashboard/results.json endpoint which returns current_count.
   */
  async getOrderCount(doctorId: string): Promise<number> {
    const data = await this.request<{ current_count: number }>(
      `/u/r/${this.orgId}/dashboard/results.json?clinicians%5B%5D=${doctorId}&page=1`
    );
    return data.current_count;
  }

  /**
   * Full lookup: search by NPI, get signature count + dashboard order count.
   */
  async fullLookup(
    npi: string
  ): Promise<{
    doctor: Doctor;
    signatureCount: number;
    signatureBreakdown: Required<SignatureBreakdown>;
    dashboardOrderCount: number;
  } | null> {
    const doc = await this.lookupByNpi(npi);
    if (!doc) return null;

    const orderCount = await this.getOrderCount(doc.doctor_id);

    return {
      doctor: doc,
      signatureCount: doc.signature_count,
      signatureBreakdown: doc.cache_signatures_counts,
      dashboardOrderCount: orderCount,
    };
  }
}
