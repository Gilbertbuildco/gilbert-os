/**
 * Pull live balances and transactions from the connected bank account.
 *
 * Read-only. Balances are appended (never overwritten) so drift is visible over
 * time; transactions dedupe on the provider's own id, so a re-run can never
 * double-count. Nothing here writes to invoices — matching bank activity to
 * invoices is a separate, deliberate step.
 *
 *   npx tsx --env-file=.env.local --env-file=.env.development.local scripts/bank-sync.mts
 */
import { pool } from "../lib/db"
import { counterpartyOf, getBalances, getToken, getTransactions, referenceOf } from "../lib/banking/gocardless"

const money = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const token = (await getToken()).access

const { rows: conns } = await pool.query(
  `SELECT id, account_id, account_name, iban_last4 FROM bank_connections
    WHERE status = 'active' AND account_id IS NOT NULL ORDER BY id`)
if (!conns.length) {
  console.log("No active bank connection. Run scripts/bank-connect.mts first.")
  await pool.end(); process.exit(0)
}

for (const c of conns) {
  console.log(`\n=== ${c.account_name ?? c.account_id}${c.iban_last4 ? ` ****${c.iban_last4}` : ""} ===`)
  const { balances } = await getBalances(token, c.account_id)
  for (const b of balances) {
    const amt = Number(b.balanceAmount.amount)
    await pool.query(
      `INSERT INTO bank_balances (connection_id, balance_type, amount, currency, reference_date)
       VALUES ($1,$2,$3,$4,$5::date)`,
      [c.id, b.balanceType, amt, b.balanceAmount.currency, b.referenceDate ?? null])
    console.log(`  ${String(b.balanceType).padEnd(22)} ${money(amt)} ${b.balanceAmount.currency}${b.referenceDate ? `  as at ${b.referenceDate}` : ""}`)
  }

  const { transactions } = await getTransactions(token, c.account_id)
  const booked = transactions.booked ?? []
  let inserted = 0
  for (const t of booked) {
    const ext = t.transactionId ?? t.internalTransactionId
    if (!ext) continue // never fabricate an id — an unidentifiable row is skipped and counted
    const r = await pool.query(
      `INSERT INTO bank_transactions (connection_id, external_id, booking_date, value_date, amount, currency, counterparty, reference, raw)
       VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9)
       ON CONFLICT (connection_id, external_id) DO NOTHING RETURNING id`,
      [c.id, ext, t.bookingDate ?? null, t.valueDate ?? null, Number(t.transactionAmount.amount),
       t.transactionAmount.currency, counterpartyOf(t), referenceOf(t), JSON.stringify(t)])
    if (r.rowCount) inserted++
  }
  const skipped = booked.filter((t) => !(t.transactionId ?? t.internalTransactionId)).length
  console.log(`  transactions: ${booked.length} booked, ${inserted} new${skipped ? `, ${skipped} skipped (no provider id)` : ""}`)

  const { rows: [recent] } = await pool.query(
    `SELECT count(*)::int n, COALESCE(SUM(amount) FILTER (WHERE amount < 0),0) out,
            COALESCE(SUM(amount) FILTER (WHERE amount > 0),0) in_
       FROM bank_transactions WHERE connection_id = $1 AND booking_date > now() - interval '30 days'`, [c.id])
  console.log(`  last 30 days: ${recent.n} transactions, in ${money(Number(recent.in_))}, out ${money(Math.abs(Number(recent.out)))}`)
}
await pool.end()
