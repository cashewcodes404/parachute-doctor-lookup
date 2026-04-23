/**
 * Parachute Health Doctor Lookup
 *
 * Importable module for integrating into your system.
 *
 * Usage:
 *   import { ParachuteClient } from 'parachute-doctor-lookup';
 *
 *   // From cookies
 *   const client = ParachuteClient.fromCookies({
 *     cookie: 'your_session_cookie_string',
 *     orgId: 'BGP3-YIEG1-Z8-SL',
 *   });
 *
 *   // Or login programmatically
 *   const client = await ParachuteClient.login({
 *     email: 'you@example.com',
 *     password: 'yourpass',
 *     orgId: 'BGP3-YIEG1-Z8-SL',
 *   });
 *
 *   // Look up signature count by NPI
 *   const result = await client.getSignatureCount('1649859471');
 *   console.log(result);
 *   // { doctor: "Smitha Martin", npi: "1649859471", credential: "NP",
 *   //   total: 9, breakdown: { fax: 0, sms: 0, onscreen: 9, ... } }
 *
 *   // Search by name
 *   const docs = await client.searchDoctors('smith');
 *
 *   // Full lookup with dashboard order count
 *   const full = await client.fullLookup('1649859471');
 */

export { ParachuteClient } from "./client.js";
export type {
  Doctor,
  DoctorSearchResponse,
  SignatureBreakdown,
  SessionConfig,
  LoginCredentials,
} from "./client.js";
