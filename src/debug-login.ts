/**
 * Debug login — traces every step of the auth flow
 */

const BASE_URL = "https://dme.parachutehealth.com";

function mergeSetCookies(jar: Map<string, string>, headers: string[]) {
  for (const raw of headers) {
    const parts = raw.split(";")[0];
    const eq = parts.indexOf("=");
    if (eq > 0) {
      jar.set(parts.slice(0, eq).trim(), parts.slice(eq + 1).trim());
    }
  }
}
function jarToStr(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function debugLogin() {
  const jar = new Map<string, string>();

  // Step 1: GET login page
  console.log("=== Step 1: GET /users/log_in ===");
  let url = `${BASE_URL}/users/log_in`;
  let html = "";

  for (let hop = 0; hop < 5; hop++) {
    console.log(`  Fetching: ${url}`);
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...(jar.size > 0 ? { Cookie: jarToStr(jar) } : {}),
      },
    });

    console.log(`  Status: ${res.status}`);
    const sc = res.headers.getSetCookie?.() ?? [];
    console.log(`  Set-Cookie headers: ${sc.length}`);
    sc.forEach((c, i) => console.log(`    [${i}] ${c.split(";")[0]}...`));
    mergeSetCookies(jar, sc);

    if (res.status >= 300 && res.status < 400) {
      url = res.headers.get("location") ?? "";
      if (!url.startsWith("http")) url = BASE_URL + url;
      await res.text();
      continue;
    }

    html = await res.text();
    break;
  }

  console.log(`\n  Cookie jar after GET: ${[...jar.keys()].join(", ")}`);
  console.log(`  HTML length: ${html.length}`);

  // Extract CSRF
  const csrfMatch = html.match(/name="csrf-token"\s+content="([^"]+)"/);
  if (!csrfMatch) {
    console.log("  ERROR: No CSRF token found!");
    // Check what meta tags exist
    const metaTags = html.match(/<meta[^>]*>/g);
    console.log("  Meta tags found:", metaTags?.length);
    metaTags?.forEach((m) => console.log("    ", m));
    return;
  }
  const csrf = csrfMatch[1];
  console.log(`  CSRF token: ${csrf.slice(0, 20)}...`);
  console.log(`  CSRF token length: ${csrf.length}`);

  // Step 2: POST login
  console.log("\n=== Step 2: POST /users/log_in.json ===");
  const email = process.env.PARACHUTE_EMAIL ?? "";
  const pass = process.env.PARACHUTE_PASSWORD ?? "";
  console.log(`  Email: ${email}`);
  console.log(`  Cookie being sent: ${jarToStr(jar).slice(0, 80)}...`);

  const body = JSON.stringify({ login: email, password: pass });
  console.log(`  Body: ${body.replace(pass, "***")}`);

  const loginRes = await fetch(`${BASE_URL}/users/log_in.json`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "X-CSRF-Token": csrf,
      "X-Requested-With": "XMLHttpRequest",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/users/log_in`,
      Cookie: jarToStr(jar),
    },
    body,
  });

  console.log(`\n  Response status: ${loginRes.status}`);
  const sc2 = loginRes.headers.getSetCookie?.() ?? [];
  console.log(`  Set-Cookie headers: ${sc2.length}`);
  sc2.forEach((c, i) => console.log(`    [${i}] ${c.split(";")[0]}...`));

  const resBody = await loginRes.text();
  console.log(`  Response body: ${resBody.slice(0, 500)}`);
}

debugLogin().catch(console.error);
