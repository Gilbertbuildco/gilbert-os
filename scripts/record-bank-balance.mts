/**
 * Record a bank balance the owner has read off the account himself.
 *
 * Until a direct bank feed exists (GoCardless closed new signups 2026-08-23),
 * the only trustworthy cash figure is the one the owner reads from the bank.
 * Xero's is not usable: it counts only money it has seen coded, so everything
 * sitting unreconciled overstates the balance — £45,193.03 in Xero against
 * £10,560.19 actually in the account on 2026-08-23, a £34,632.84 gap.
 *
 * Stored as a normal reading in `bank_balances` against a 'manual' connection,
 * so when a live feed arrives the history is continuous and the source of every
 * reading stays visible. Readings are appended, never overwritten.
 *
 *   npx tsx --env-file=.env.development.local scripts/record-bank-balance.mts 10560.19
 */
import { pool } from "../lib/db"

const raw = process.argv[2]
const amount = Number(raw)
if (!raw || !Number.isFinite(amount)) {
  console.error("Usage: record-bank-balance.mts <amount>   e.g. 10560.19")
  process.exit(1)
}

const { rows: [conn] } = await pool.query(`
  INSERT INTO bank_connections (provider, institution_name, account_name, status)
  SELECT 'manual', 'Owner-read balance', 'Business current account', 'active'
   WHERE NOT EXISTS (SELECT 1 FROM bank_connections WHERE provider = 'manual')
  RETURNING id`)
const { rows: [c] } = conn
  ? { rows: [conn] }
  : await pool.query(`SELECT id FROM bank_connections WHERE provider = 'manual' LIMIT 1`)

await pool.query(
  `INSERT INTO bank_balances (connection_id, balance_type, amount, currency, reference_date)
   VALUES ($1, 'ownerReported', $2, 'GBP', CURRENT_DATE)`, [c.id, amount])

const { rows: hist } = await pool.query(
  `SELECT to_char(fetched_at,'YYYY-MM-DD HH24:MI') t, amount, balance_type
     FROM bank_balances WHERE connection_id = $1 ORDER BY fetched_at DESC LIMIT 5`, [c.id])
console.log(`recorded £${amount.toFixed(2)}\n\nrecent readings:`)
for (const h of hist) console.log(`  ${h.t}  £${Number(h.amount).toFixed(2)}  (${h.balance_type})`)
await pool.end()
