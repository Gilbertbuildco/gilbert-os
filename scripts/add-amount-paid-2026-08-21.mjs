/**
 * Add `invoices.amount_paid` — the amount actually settled on an invoice.
 *
 * Why: `payment_status = 'part_paid'` carried no figure, so a part-paid invoice
 * was a flag with no number behind it. The Bradfords windows invoice 77983461
 * (£51,070.80, owner-confirmed part paid) exposed this: the OS could not say
 * how much was outstanding, and Xero's bill therefore still showed the full
 * amount due.
 *
 * Deliberately NOT backfilled from gross for 'paid' rows in the same breath as
 * creating the column — see the guarded backfill below, which only sets
 * amount_paid = gross where payment_status = 'paid'. That is the one case where
 * the amount is known with certainty and not inferred. 'part_paid' rows stay
 * NULL until the owner supplies the real figure (non-negotiable #1).
 *
 * Idempotent: safe to re-run.
 */
import pg from "pg"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  await c.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_paid numeric(12,2)`)
  const r = await c.query(`UPDATE invoices SET amount_paid = gross
                            WHERE payment_status = 'paid' AND amount_paid IS NULL`)
  console.log(`amount_paid column ensured; backfilled ${r.rowCount} fully-paid invoices from gross`)
  const { rows } = await c.query(`SELECT payment_status, count(*)::int n, count(amount_paid)::int with_amount
                                    FROM invoices WHERE status='confirmed' GROUP BY 1 ORDER BY 1 NULLS LAST`)
  for (const x of rows) console.log(`  ${String(x.payment_status ?? "not recorded").padEnd(13)} ${String(x.n).padStart(3)} rows, ${x.with_amount} with an amount`)
  await c.query("COMMIT")
  console.log("COMMITTED")
} catch (e) { await c.query("ROLLBACK"); console.error("rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
