/**
 * Xero connection verification — READ-ONLY.
 *
 * Confirms an already-connected Xero organisation is reachable by fetching
 * the organisation record and its chart of accounts. Uses only `xeroGet`
 * from `lib/xero/client.ts`, which cannot express any method other than
 * GET — there is no code path in this script that can write to Xero.
 *
 * Requires a completed OAuth connection already stored in `xero_connections`
 * (run the `/api/xero/connect` -> `/api/xero/callback` flow first) plus
 * `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_TOKEN_ENCRYPTION_KEY` set —
 * this script does not perform the OAuth handshake itself.
 *
 * Run with:
 *   npx tsx --env-file=.env.development.local scripts/xero-verify-connection.mts
 * (tsx is not a local devDependency here, so invoke it via `npx tsx ...` —
 * resolving a cached binary path yourself, e.g. `$(npx which tsx)`, can be
 * unreliable across npx cache states and is not recommended.)
 */
import { xeroGet } from "../lib/xero/client.ts"
import { pool } from "../lib/db/index.ts"

type XeroAccount = {
  AccountID: string
  Code?: string
  Name: string
  Type: string
  Class?: string
  Status: string
}

console.log("=== Xero connection verification (read-only, GET requests only) ===\n")

try {
  console.log("--- Fetching organisation (GET /api.xro/2.0/Organisation) ---")
  const orgRes = await xeroGet("/api.xro/2.0/Organisation")
  if (!orgRes.ok) {
    const text = await orgRes.text().catch(() => "")
    throw new Error(`Organisation fetch failed: ${orgRes.status} ${text.slice(0, 500)}`)
  }
  const orgBody = (await orgRes.json()) as { Organisations?: Array<{ Name: string; LegalName?: string; CountryCode?: string; BaseCurrency?: string; OrganisationID: string }> }
  const org = orgBody.Organisations?.[0]
  if (!org) throw new Error("Organisation response had no Organisations[0].")
  console.log(`  Name: ${org.Name}`)
  console.log(`  Legal name: ${org.LegalName ?? "(none)"}`)
  console.log(`  Country: ${org.CountryCode ?? "(unknown)"}`)
  console.log(`  Base currency: ${org.BaseCurrency ?? "(unknown)"}`)
  console.log(`  OrganisationID: ${org.OrganisationID}\n`)

  console.log("--- Fetching chart of accounts (GET /api.xro/2.0/Accounts) ---")
  const acctRes = await xeroGet("/api.xro/2.0/Accounts")
  if (!acctRes.ok) {
    const text = await acctRes.text().catch(() => "")
    throw new Error(`Accounts fetch failed: ${acctRes.status} ${text.slice(0, 500)}`)
  }
  const acctBody = (await acctRes.json()) as { Accounts?: XeroAccount[] }
  const accounts = acctBody.Accounts ?? []
  console.log(`  ${accounts.length} account(s) returned.`)
  console.log("  Sample (first 10):")
  for (const a of accounts.slice(0, 10)) {
    console.log(`    ${(a.Code ?? "-").padEnd(8)} ${a.Type.padEnd(14)} ${a.Status.padEnd(9)} ${a.Name}`)
  }

  console.log("\n=== Connection verified. Nothing was written to Xero. ===")
} catch (err) {
  console.error("\nVerification FAILED:", (err as Error).message)
  process.exitCode = 1
} finally {
  await pool.end()
}
