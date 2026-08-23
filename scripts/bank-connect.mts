/**
 * Connect the business bank account (read-only) via GoCardless Bank Account Data.
 *
 *   1. list banks:   npx tsx --env-file=.env.local --env-file=.env.development.local scripts/bank-connect.mts --find "monzo"
 *   2. start consent: ... scripts/bank-connect.mts --institution=<ID>
 *      -> prints a link. The OWNER opens it and authenticates at their own bank.
 *         Credentials never pass through this process.
 *   3. finish:        ... scripts/bank-connect.mts --finish=<REQUISITION_ID>
 *      -> stores the account(s) against the requisition, ready for bank-sync.
 */
import { pool } from "../lib/db"
import { createRequisition, getRequisition, getToken, listInstitutions, getAccountDetails } from "../lib/banking/gocardless"

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}`))?.split("=")[1]
const find = process.argv.find((a) => a === "--find") ? process.argv[process.argv.indexOf("--find") + 1] : arg("find")
const institution = arg("institution")
const finish = arg("finish")

const token = (await getToken()).access

if (find) {
  const all = await listInstitutions(token, "gb")
  const hits = all.filter((i) => i.name.toLowerCase().includes(find.toLowerCase()))
  console.log(`\n${hits.length} UK bank(s) matching "${find}":`)
  for (const i of hits) console.log(`  ${i.id.padEnd(42)} ${i.name}  (history: ${i.transaction_total_days ?? "?"} days)`)
  if (!hits.length) console.log(`  none — ${all.length} UK institutions available; try a shorter search term.`)
  await pool.end()
} else if (institution) {
  const reference = `gilbertos-${Date.now()}`
  const req = await createRequisition(token, institution, "http://localhost:3000/", reference)
  await pool.query(
    `INSERT INTO bank_connections (provider, institution_id, requisition_id, status)
     VALUES ('gocardless', $1, $2, 'pending')`, [institution, req.id])
  console.log(`\nRequisition ${req.id} created.\n`)
  console.log(`OPEN THIS AND AUTHENTICATE WITH YOUR BANK:\n\n  ${req.link}\n`)
  console.log(`Then run:  scripts/bank-connect.mts --finish=${req.id}`)
  await pool.end()
} else if (finish) {
  const req = await getRequisition(token, finish)
  console.log(`requisition ${req.id} status=${req.status} accounts=${req.accounts.length}`)
  if (!req.accounts.length) {
    console.log("No accounts yet — the consent has not been completed in the browser.")
    await pool.end(); process.exit(0)
  }
  for (const accountId of req.accounts) {
    let name: string | null = null, last4: string | null = null
    try {
      const d = await getAccountDetails(token, accountId)
      name = d.account?.name ?? d.account?.ownerName ?? null
      const iban = d.account?.iban ?? ""
      last4 = iban ? iban.slice(-4) : null
    } catch { /* details are optional — never block the connection on them */ }
    await pool.query(
      `INSERT INTO bank_connections (provider, institution_id, requisition_id, account_id, account_name, iban_last4, status, consent_expires_at, updated_at)
       VALUES ('gocardless', $1, $2, $3, $4, $5, 'active', now() + interval '90 days', now())
       ON CONFLICT (provider, account_id) WHERE account_id IS NOT NULL
       DO UPDATE SET requisition_id = EXCLUDED.requisition_id, status = 'active',
                     consent_expires_at = EXCLUDED.consent_expires_at, updated_at = now()`,
      [req.institution_id, req.id, accountId, name, last4])
    console.log(`  linked account ${accountId}${name ? ` (${name})` : ""}${last4 ? ` ****${last4}` : ""}`)
  }
  await pool.query(`DELETE FROM bank_connections WHERE requisition_id = $1 AND account_id IS NULL`, [finish])
  console.log("\nConnected. Run scripts/bank-sync.mts to pull balances and transactions.")
  await pool.end()
} else {
  console.log("Usage: --find <name> | --institution=<ID> | --finish=<REQUISITION_ID>")
  await pool.end()
}
