/**
 * Three owner corrections to accepted-quote attribution, 2026-08-23.
 *
 * 1. SOUTHERN ELECTRIC — quotes FGG947/1 and /2 carried no supplier_id at all,
 *    so no invoice could ever match them and £23,134.86 read as future cost.
 *    It is not: FGG947/2 (£23,134.86) = FGG947/1 (£19,089.72, paid) + the
 *    £4,045.14 underground-line fee (paid). Goldentree settled the main bill
 *    directly — the "Utilities" £25,154.72 direct drawdown. Linking the quotes
 *    to the real supplier makes the existing invoices count against them.
 *
 * 2. METAL STAIRS — owner: "these stairs are also being paid for by the buyer
 *    so they wont impact our numbers at all." Marked 'buyer_funded' rather than
 *    deleted or flipped to not_accepted: the quote WAS accepted and the record
 *    must stay truthful. Only the contracted-cost calculation excludes it.
 *
 * 3. Reports what remains for Mayflower so the gap is visible rather than
 *    assumed — it is NOT adjusted here, because the owner's stated balances
 *    imply accepted quotes this system has not yet ingested.
 *
 * Idempotent. Dry-run by default.
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
  // 1. Link the SSE quotes to the supplier that actually holds the invoices.
  const { rows: [sse] } = await c.query(`SELECT id, name FROM suppliers WHERE name ILIKE '%sothern%' OR name ILIKE '%southern electric%' ORDER BY id LIMIT 1`)
  if (!sse) throw new Error("no Southern Electric supplier found")
  const r1 = await c.query(`UPDATE quotes SET supplier_id = $1 WHERE reference IN ('FGG947/1','FGG947/2') AND supplier_id IS NULL RETURNING reference`, [sse.id])
  console.log(`  linked ${r1.rowCount} SSE quote(s) to supplier #${sse.id} "${sse.name}"`)

  // Alias so future SSE documents resolve to the same supplier.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
  for (const alias of ["Southern Electric Power Distribution plc", "Southern Electric", "SSE"])
    await c.query(`INSERT INTO supplier_aliases (supplier_id, normalised_name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [sse.id, norm(alias)])
  console.log("  aliases added for SSE name variants")

  // 2. Metal stairs — buyer funded.
  const r2 = await c.query(`UPDATE quotes SET status = 'buyer_funded',
      notes = COALESCE(NULLIF(notes,'')||' | ','') || 'Owner 2026-08-23: paid for by the buyer — excluded from our cost.'
    WHERE reference = '26050-01' AND status = 'accepted' RETURNING reference, net`)
  for (const x of r2.rows) console.log(`  ${x.reference} -> buyer_funded (£${Number(x.net).toFixed(2)} removed from contracted cost)`)

  // 3. Mayflower position, reported only.
  const { rows: mf } = await c.query(`SELECT reference, net, status FROM quotes WHERE supplier_name_raw ILIKE '%mayflower%' OR supplier_id IN
    (SELECT id FROM suppliers WHERE name ILIKE '%mayflower%') ORDER BY status, reference`)
  const acc = mf.filter((q) => q.status === "accepted")
  console.log(`\n  Mayflower accepted quotes (${acc.length}): £${acc.reduce((s, q) => s + Number(q.net), 0).toFixed(2)}`)
  for (const q of acc) console.log(`    ${q.reference.padEnd(14)} £${Number(q.net).toFixed(2)}`)
  console.log(`  Owner's stated balances still to pay: £22,979.67`)

  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("\nDRY RUN — nothing written.") }
  else { await c.query("COMMIT"); console.log("\nCOMMITTED.") }
} catch (e) { await c.query("ROLLBACK"); console.error("rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
