const BASE_URL = "https://dme.parachutehealth.com";
const EMAIL = process.argv[2] ?? "";
const PASS = process.argv[3] ?? "";

async function test() {
  // GET login page
  const getRes = await fetch(`${BASE_URL}/users/log_in`, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html",
    },
  });
  
  const sc = getRes.headers.getSetCookie?.() ?? [];
  const sessionCookie = sc.map(c => c.split(";")[0]).join("; ");
  const html = await getRes.text();
  const csrf = html.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1] ?? "";
  
  console.log("Session cookie:", sessionCookie.slice(0, 50));
  console.log("CSRF:", csrf.slice(0, 30));
  
  // POST JSON login
  const postRes = await fetch(`${BASE_URL}/users/log_in.json`, {
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
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ login: EMAIL, password: PASS }),
  });
  
  console.log("POST status:", postRes.status);
  const body = await postRes.text();
  console.log("Response:", body.slice(0, 300));
  
  if (postRes.status === 200 || postRes.status === 302) {
    console.log("\n✅ LOGIN WORKS FROM THIS SANDBOX!");
    const newCookies = postRes.headers.getSetCookie?.() ?? [];
    console.log("New cookies:", newCookies.length);
  }
}

if (!EMAIL || !PASS) {
  console.log("Usage: npx tsx src/test-login-here.ts <email> <password>");
  process.exit(1);
}
test().catch(console.error);
