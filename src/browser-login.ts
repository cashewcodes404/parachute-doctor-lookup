/**
 * Puppeteer-based login for Parachute Health.
 *
 * Uses a real headless Chrome to authenticate, which bypasses
 * TLS fingerprinting and bot detection that blocks plain fetch().
 *
 * Returns the authenticated cookie string for use with ParachuteClient.fromCookies().
 */

import puppeteer, { Browser } from "puppeteer";

const BASE_URL = "https://dme.parachutehealth.com";

export interface BrowserLoginResult {
  cookie: string;
  /** How long the login took in ms */
  durationMs: number;
}

/**
 * Log into Parachute Health using headless Chrome.
 *
 * Flow:
 *   1. Navigate to /users/log_in
 *   2. Fill in email + password via the React form
 *   3. Click submit, wait for navigation
 *   4. Extract all cookies and return them as a string
 */
export async function browserLogin(
  email: string,
  password: string
): Promise<BrowserLoginResult> {
  const start = Date.now();
  let browser: Browser | null = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      // Use system Chromium if PUPPETEER_EXECUTABLE_PATH is set (Docker),
      // otherwise fall back to Puppeteer's bundled Chrome
      ...(process.env.PUPPETEER_EXECUTABLE_PATH
        ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
        : {}),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });

    const page = await browser.newPage();

    // Set a realistic viewport and user agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );

    console.log("[browser-login] Navigating to login page...");
    await page.goto(`${BASE_URL}/users/log_in`, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // Wait for the React form to render
    // The form has inputs with name="login" and name="password"
    console.log("[browser-login] Waiting for login form...");
    await page.waitForSelector('input[name="login"], input[type="email"], input[id="login"]', {
      timeout: 15000,
    });

    // Find the email/login input — try multiple selectors since the React form may vary
    const emailSelector =
      (await page.$('input[name="login"]')) ? 'input[name="login"]' :
      (await page.$('input[type="email"]')) ? 'input[type="email"]' :
      'input[id="login"]';

    const passwordSelector =
      (await page.$('input[name="password"]')) ? 'input[name="password"]' :
      (await page.$('input[type="password"]')) ? 'input[type="password"]' :
      'input[id="password"]';

    console.log(`[browser-login] Filling email (${emailSelector})...`);
    await page.click(emailSelector);
    await page.type(emailSelector, email, { delay: 30 });

    console.log(`[browser-login] Filling password (${passwordSelector})...`);
    await page.click(passwordSelector);
    await page.type(passwordSelector, password, { delay: 30 });

    // Submit the form — click the submit button or press Enter
    console.log("[browser-login] Submitting form...");
    const submitButton = await page.$(
      'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in")'
    );

    if (submitButton) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
        submitButton.click(),
      ]);
    } else {
      // Fallback: press Enter in the password field
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
        page.keyboard.press("Enter"),
      ]);
    }

    // Wait a moment for any post-login redirects
    await new Promise((r) => setTimeout(r, 2000));

    // Check if we're still on the login page (login failed)
    const currentUrl = page.url();
    console.log(`[browser-login] Current URL after submit: ${currentUrl}`);

    if (currentUrl.includes("/users/log_in") || currentUrl.includes("/users/sign_in")) {
      // Check for error messages
      const errorText = await page.evaluate(() => {
        const alert = document.querySelector('.alert-danger, .alert-error, [role="alert"], .flash-error');
        return alert?.textContent?.trim() ?? null;
      });
      throw new Error(
        `Login failed — still on login page.${errorText ? ` Error: ${errorText}` : " Check credentials."}`
      );
    }

    // Extract all cookies
    const cookies = await page.cookies();
    const cookieString = cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const duration = Date.now() - start;
    console.log(
      `[browser-login] Success! Got ${cookies.length} cookies in ${duration}ms`
    );

    return { cookie: cookieString, durationMs: duration };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
