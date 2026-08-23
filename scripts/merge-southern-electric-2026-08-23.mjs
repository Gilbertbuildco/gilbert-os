/**
 * Merge the duplicate Southern Electric supplier record.
 *
 * "Southern Electric" (#36) and "Scotish and Sothern Electricity Networks"
 * (#10) are the same company. The £4,045.14 underground-line invoice sat under
 * #36 while the FGG947 quotes and the £19,089.72 invoice sat under #10, so the
 * quote could never see its own payment and £4,045.14 read as future cost.
 *
 * Repoints every child row onto the surviving supplier and removes the
 * duplicate. Amounts are never altered — only which supplier they hang off.
 * Transactional; refuses to leave orphans.
 *
 * Idempotent: once merged, re-running finds nothing to do.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
for (const l of readFileSync("/Users/tomgilbert/GilbertOS/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const EXECUTE = process.argv.includes("--execute")
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  const { rows: [keep] } = await c.query(`SELECT id, name FROM suppliers WHERE name ILIKE '%sothern%' LIMIT 1`)
  const { rows: [drop] } = await c.query(`SELECT id, name FROM suppliers WHERE name = 'Southern Electric' LIMIT 1`)
  if (!keep || !drop) { console.log("nothing to merge — already done"); await c.query("ROLLBACK"); process.exit(0) }
  console.log(`  KEEP  #${keep.id} "${keep.name}"`)
  console.log(`  MERGE #${drop.id} "${drop.name}"`)

  // Before: what moves.
  const { rows: moving } = await c.query(
    `SELECT invoice_number, gross, payment_status FROM invoices WHERE supplier_id = $1`, [drop.id])
  for (const m of moving) console.log(`    invoice ${m.invoice_number ?? "(no number)"} £${Number(m.gross).toFixed(2)} ${m.payment_status}`)

  const inv = await c.query(`UPDATE invoices SET supplier_id = $1 WHERE supplier_id = $2`, [keep.id, drop.id])
  const qts = await c.query(`UPDATE quotes SET supplier_id = $1 WHERE supplier_id = $2`, [keep.id, drop.id])
  const als = await c.query(`UPDATE supplier_aliases SET supplier_id = $1 WHERE supplier_id = $2
                             AND normalised_name NOT IN (SELECT normalised_name FROM supplier_aliases WHERE supplier_id = $1)`,
                            [keep.id, drop.id])
  await c.query(`DELETE FROM supplier_aliases WHERE supplier_id = $1`, [drop.id])
  const prc = await c.query(`UPDATE price_records SET supplier_id = $1 WHERE supplier_id = $2`, [keep.id, drop.id]).catch(() => ({ rowCount: 0 }))
  await c.query(`DELETE FROM suppliers WHERE id = $1`, [drop.id])
  console.log(`  moved: ${inv.rowCount} invoices, ${qts.rowCount} quotes, ${als.rowCount} aliases, ${prc.rowCount} price records`)

  const { rows: [left] } = await c.query(`SELECT count(*)::int n FROM invoices WHERE supplier_id = $1`, [drop.id])
  if (left.n > 0) throw new Error(`refusing to finish: ${left.n} rows still point at the deleted supplier`)

  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("\nDRY RUN — nothing written.") }
  else { await c.query("COMMIT"); console.log("\nCOMMITTED.") }
} catch (e) { await c.query("ROLLBACK"); console.error("rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
