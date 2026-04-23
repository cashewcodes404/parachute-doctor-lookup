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

export interface SignatureBreakdown {
  fax: number;
  sms: number;
  epic: number;
  email: number;
  cerner: number;
  onscreen: number;
  self_sign: number;
  fax_invite: number;
  unknown_electronic: number;
}

export interface Doctor {
  doctor_id: string;
  first_name: string;
  last_name: string;
  npi: string;
  credential: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  zip: string;
  phone_number: string;
  masked_mobile_number: string | null;
  fax_number: string | null;
  masked_email: string;
  pecos_certified: boolean;
  signature_count: number;
  cache_signatures_counts: SignatureBreakdown;
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
   * Handles the Devise CSRF flow:
   *   1. GET /users/sign_in → extract CSRF token + session cookie
   *   2. POST /users/sign_in → authenticate, capture session cookie
   */
  static async login(creds: LoginCredentials): Promise<ParachuteClient> {
    const cookieJar = new Map<string, string>();

    // Step 1: GET login page for CSRF token
    const loginPageRes = await fetch(`${BASE_URL}/users/sign_in`, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "text/html",
      },
    });

    const setCookies1 = loginPageRes.headers.getSetCookie?.() ?? [];
    mergeSetCookies(cookieJar, setCookies1);

    const html = await loginPageRes.text();

    // Extract CSRF token from meta tag or hidden input
    const csrfMatch =
      html.match(/name="csrf-token"\s+content="([^"]+)"/) ??
      html.match(/name="authenticity_token".*?value="([^"]+)"/);
    if (!csrfMatch) {
      throw new Error(
        "Could not extract CSRF token from login page. The page structure may have changed."
      );
    }
    const csrfToken = csrfMatch[1];

    // Step 2: POST login
    const formBody = new URLSearchParams({
      "user[email]": creds.email,
      "user[password]": creds.password,
      authenticity_token: csrfToken,
      commit: "Log in",
    });

    const loginRes = await fetch(`${BASE_URL}/users/sign_in`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        Cookie: cookieMapToString(cookieJar),
        Referer: `${BASE_URL}/users/sign_in`,
      },
      body: formBody.toString(),
    });

    const setCookies2 = loginRes.headers.getSetCookie?.() ?? [];
    mergeSetCookies(cookieJar, setCookies2);

    // Devise redirects on success (302), returns 200/422 on failure
    if (loginRes.status !== 302 && loginRes.status !== 303) {
      throw new Error(
        `Login failed with status ${loginRes.status}. Check your email/password.`
      );
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
    const data = await this.request<DoctorSearchResponse>(
      `/u/doctors_search.json?term=${encoded}`
    );
    return data.results;
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
    breakdown: SignatureBreakdown;
  } | null> {
    const doc = await this.lookupByNpi(npi);
    if (!doc) return null;

    return {
      doctor: `${doc.first_name} ${doc.last_name}`,
      npi: doc.npi,
      credential: doc.credential,
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
    signatureBreakdown: SignatureBreakdown;
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
