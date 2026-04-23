#!/usr/bin/env node
/**
 * Parachute Health Doctor Lookup CLI
 *
 * Usage:
 *   # Search by NPI (returns signature count)
 *   npx tsx src/cli.ts --npi 1649859471
 *
 *   # Search by name
 *   npx tsx src/cli.ts --name "smith"
 *
 *   # Full lookup (signature count + dashboard order count)
 *   npx tsx src/cli.ts --npi 1649859471 --full
 *
 *   # JSON output (for piping to other tools)
 *   npx tsx src/cli.ts --npi 1649859471 --json
 *
 *   # Login with credentials (creates a session)
 *   npx tsx src/cli.ts --login --email you@example.com --password yourpass --org BGP3-YIEG1-Z8-SL
 *
 *   # Use saved session cookie
 *   npx tsx src/cli.ts --npi 1649859471 --cookie-file .cookie
 *
 * Environment variables:
 *   PARACHUTE_COOKIE  - Session cookie string
 *   PARACHUTE_ORG_ID  - Org slug (e.g. BGP3-YIEG1-Z8-SL)
 *   PARACHUTE_EMAIL   - Login email
 *   PARACHUTE_PASSWORD - Login password
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ParachuteClient } from "./client.js";
import type { Doctor } from "./client.js";

// ── Argument parsing ─────────────────────────────────────────────────────────

interface CliArgs {
  npi?: string;
  name?: string;
  full: boolean;
  json: boolean;
  login: boolean;
  email?: string;
  password?: string;
  org?: string;
  cookieFile?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    full: false,
    json: false,
    login: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--npi":
        args.npi = argv[++i];
        break;
      case "--name":
        args.name = argv[++i];
        break;
      case "--full":
        args.full = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--login":
        args.login = true;
        break;
      case "--email":
        args.email = argv[++i];
        break;
      case "--password":
        args.password = argv[++i];
        break;
      case "--org":
        args.org = argv[++i];
        break;
      case "--cookie-file":
        args.cookieFile = argv[++i];
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  return args;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
Parachute Health Doctor Lookup CLI

USAGE:
  npx tsx src/cli.ts [OPTIONS]

SEARCH OPTIONS:
  --npi <number>       Look up a doctor by NPI number
  --name <query>       Search doctors by name (returns multiple results)
  --full               Include dashboard order count (slower, extra API call)
  --json               Output raw JSON (for piping to other tools)

AUTH OPTIONS (pick one):
  --login              Log in with email/password (interactive)
  --email <email>      Email for login (or set PARACHUTE_EMAIL)
  --password <pass>    Password for login (or set PARACHUTE_PASSWORD)
  --org <slug>         Org ID slug (or set PARACHUTE_ORG_ID)
  --cookie-file <path> Load/save session cookie from file (default: .cookie)

ENVIRONMENT VARIABLES:
  PARACHUTE_COOKIE     Session cookie string (alternative to --cookie-file)
  PARACHUTE_ORG_ID     Org slug, e.g. BGP3-YIEG1-Z8-SL
  PARACHUTE_EMAIL      Login email
  PARACHUTE_PASSWORD   Login password

EXAMPLES:
  # First time: log in and save session
  npx tsx src/cli.ts --login --email you@co.com --password secret --org BGP3-YIEG1-Z8-SL

  # Then look up a doctor
  npx tsx src/cli.ts --npi 1649859471

  # Search by name, get JSON
  npx tsx src/cli.ts --name "smith" --json

  # Full lookup with order count
  npx tsx src/cli.ts --npi 1649859471 --full
`);
}

function formatDoctor(doc: Doctor, index?: number): string {
  const prefix = index !== undefined ? `[${index + 1}] ` : "";
  const breakdown = doc.cache_signatures_counts;
  const methods = Object.entries(breakdown)
    .filter(([, v]) => (v ?? 0) > 0)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  const cred = doc.credential ? `, ${doc.credential}` : "";

  return [
    `${prefix}${doc.first_name} ${doc.last_name}${cred}`,
    `    NPI:        ${doc.npi}`,
    `    Location:   ${doc.city}, ${doc.state} ${doc.zip}`,
    `    Practice:   ${doc.line1}`,
    `    PECOS:      ${doc.pecos_certified ? "Yes" : "No"}`,
    `    Signed:     ${doc.signature_count} order(s)${methods ? ` (${methods})` : ""}`,
    `    Phone:      ${doc.phone_number || "N/A"}`,
    `    Fax:        ${doc.fax_number || "N/A"}`,
  ].join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printUsage();
    return;
  }

  const cookieFilePath = resolve(args.cookieFile ?? ".cookie");
  const orgId =
    args.org ?? process.env.PARACHUTE_ORG_ID ?? "";

  // ── Resolve authentication ──

  let client: ParachuteClient | undefined;

  if (args.login) {
    // Programmatic login
    const email = args.email ?? process.env.PARACHUTE_EMAIL;
    const password = args.password ?? process.env.PARACHUTE_PASSWORD;

    if (!email || !password || !orgId) {
      console.error(
        "Error: --login requires --email, --password, and --org (or their env vars)."
      );
      process.exit(1);
    }

    console.log(`Logging in as ${email}...`);
    try {
      client = await ParachuteClient.login({ email, password, orgId });
    } catch (e) {
      console.error(`Login failed: ${(e as Error).message}`);
      process.exit(1);
    }
    console.log("Login successful. Session saved.\n");

    // If no search query provided, just log in and exit
    if (!args.npi && !args.name) {
      return;
    }
  } else {
    // Use existing cookie
    const cookie =
      process.env.PARACHUTE_COOKIE ??
      (existsSync(cookieFilePath)
        ? readFileSync(cookieFilePath, "utf-8").trim()
        : "");

    if (!cookie) {
      console.error(
        "Error: No session cookie found.\n\n" +
          "Either:\n" +
          "  1. Run with --login to authenticate\n" +
          "  2. Set PARACHUTE_COOKIE environment variable\n" +
          "  3. Create a .cookie file with your session cookie\n" +
          "     (Copy from browser DevTools → Application → Cookies)\n"
      );
      process.exit(1);
    }

    if (!orgId) {
      console.error(
        "Error: No org ID found. Set --org or PARACHUTE_ORG_ID.\n" +
          "  (Find it in your dashboard URL: /u/r/<ORG_ID>/dashboard)"
      );
      process.exit(1);
    }

    client = ParachuteClient.fromCookies({ cookie, orgId });
  }

  // ── Execute search ──

  if (!client) {
    console.error("Error: Could not establish a session.");
    process.exit(1);
  }

  if (!args.npi && !args.name) {
    console.error("Error: Provide --npi or --name to search.");
    printUsage();
    process.exit(1);
  }

  try {
    if (args.npi) {
      if (args.full) {
        // Full lookup: signature count + dashboard order count
        const result = await client.fullLookup(args.npi);
        if (!result) {
          console.error(`No doctor found with NPI: ${args.npi}`);
          process.exit(1);
        }

        if (args.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatDoctor(result.doctor));
          console.log(`    Orders:     ${result.dashboardOrderCount} in dashboard`);
        }
      } else {
        // Quick lookup: signature count only
        const result = await client.getSignatureCount(args.npi);
        if (!result) {
          console.error(`No doctor found with NPI: ${args.npi}`);
          process.exit(1);
        }

        if (args.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const methods = Object.entries(result.breakdown)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `    ${k}: ${v}`)
            .join("\n");

          const cred = result.credential ? `, ${result.credential}` : "";
          console.log(`${result.doctor}${cred}`);
          console.log(`NPI: ${result.npi}`);
          console.log(`Signed orders: ${result.total}`);
          if (methods) {
            console.log(`Breakdown:\n${methods}`);
          }
        }
      }
    } else if (args.name) {
      // Name search: returns multiple results, sorted by signature count
      const results = await client.searchDoctors(args.name);

      if (results.length === 0) {
        console.error(`No doctors found matching: "${args.name}"`);
        process.exit(1);
      }

      // Sort by signature count descending — most active doctors first
      results.sort((a, b) => b.signature_count - a.signature_count);

      if (args.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        const active = results.filter((d) => d.signature_count > 0);
        const inactive = results.filter((d) => d.signature_count === 0);

        console.log(
          `Found ${results.length} result(s) for "${args.name}" (${active.length} with signed orders):\n`
        );
        active.forEach((doc, i) => {
          console.log(formatDoctor(doc, i));
          console.log();
        });
        if (inactive.length > 0) {
          console.log(
            `  ... plus ${inactive.length} doctor(s) with 0 signed orders (omitted)`
          );
        }
      }
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("Session expired")) {
      console.error(
        "Session expired. Please re-authenticate:\n" +
          "  npx tsx src/cli.ts --login --email <email> --password <pass> --org <org>"
      );
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }
}

main();
