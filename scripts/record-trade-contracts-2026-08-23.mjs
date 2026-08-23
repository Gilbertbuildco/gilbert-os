/**
 * Record the trade contract values the owner supplied on 2026-08-23, so
 * "what is left to spend" can be built from what work actually costs rather
 * than subtracted from the lender's allowance.
 *
 * Owner also asked that these be kept deliberately: "make sure you're
 * documenting them in the OS going forward so when i price a new site we can
 * look back and compare quotes." They are stored as quotes with their source
 * stated, which is what the quotes-vs-actual view already reads.
 *
 * BUYER-FUNDED WORK. Lazenby polished concrete and the metal staircase are
 * paid for by the buyer of Plot 2 and must not appear in our costs anywhere.
 * A cost package flagged is_build_cost = false keeps the invoices intact and
 * auditable while removing them from every build-cost total — the same
 * mechanism already used for legal fees and vehicles. Deleting them would
 * destroy real documents; hiding them in a build package would overstate cost.
 *
 * Every figure here came from the owner or from a supplier document. Nothing
 * is inferred. Prices are ex-VAT, as quoted.
 *
 * Idempotent. Dry-run by default; --execute to write.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
for (const l of readFileSync("/Users/tomgilbert/GilbertOS/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const EXECUTE = process.argv.includes("--execute")
const f = (n) => `£${Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Sherborne Stone — Martin Dodge to George Wilson, 2 Feb 2026. Ex-VAT and delivery.
// Owner: "We agreed to all of the water tabling."
const SHERBORNE = [
  { ref: "SS-2026-02-P1",       net: 13654, desc: "Plot 1: 43 bags walling stone, 20 lm coins, 15.04 lm stone heads, 17.4 lm windowsills" },
  { ref: "SS-2026-02-P1-WT",    net: 7404,  desc: "Plot 1 water tabling incl. corbels, kneelers and apex stone — AGREED" },
  { ref: "SS-2026-02-P2",       net: 12135, desc: "Plot 2: 41 bags walling stone, 18 lm coins, 13.2 lm stone heads, 10.8 lm windowsills" },
  { ref: "SS-2026-02-P3",       net: 16933, desc: "Plot 3: 41 bags building stone, 20 lm coins, 36.24 lm stone hat, 22.6 lm windowsills" },
]
const SHERBORNE_NOT_CONFIRMED = { ref: "SS-2026-02-P3-ASHLER", net: 8640, desc: "Plot 3 Ashlar stone to form feature window — quoted, acceptance NOT confirmed" }

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
const sup = async (like) => (await c.query(`SELECT id, name FROM suppliers WHERE name ILIKE $1 ORDER BY id LIMIT 1`, [like])).rows[0]
try {
  await c.query("BEGIN")

  // --- 1. Buyer-funded package, and move Lazenby + the staircase into it ---
  const { rows: [pkg] } = await c.query(`
    INSERT INTO cost_packages (project_id, code, name, is_build_cost)
    SELECT 1, '28', 'Buyer-funded (Plot 2)', false
     WHERE NOT EXISTS (SELECT 1 FROM cost_packages WHERE project_id=1 AND code='28')
    RETURNING id, name`)
  const { rows: [buyerPkg] } = pkg ? { rows: [pkg] } : await c.query(`SELECT id, name FROM cost_packages WHERE project_id=1 AND code='28'`)
  console.log(`  package: ${buyerPkg.name} (#${buyerPkg.id}, excluded from build cost)`)

  for (const [name, why] of [["%lazenby%", "polished concrete"], ["%metal stair%", "staircase"]]) {
    const s = await sup(name)
    if (!s) continue
    const r = await c.query(
      `UPDATE invoice_line_items li SET cost_package_id = $1
         FROM invoices i WHERE i.id = li.invoice_id AND i.supplier_id = $2 AND i.status='confirmed'`,
      [buyerPkg.id, s.id])
    console.log(`    ${s.name} (${why}): ${r.rowCount} line(s) moved to buyer-funded`)
  }

  // --- 2. Contract values supplied by the owner ---
  const marsh = await sup("%marshisaacs%")
  const add = async (supplierId, ref, net, desc, status, notes) => {
    const dup = await c.query(`SELECT id FROM quotes WHERE reference = $1`, [ref])
    if (dup.rowCount) { console.log(`    = ${ref} already recorded`); return }
    if (!EXECUTE) { console.log(`    + ${ref.padEnd(22)} ${f(net).padStart(12)}  ${status}`); return }
    await c.query(
      `INSERT INTO quotes (supplier_id, project_id, reference, quote_date, description, net, gross, status, notes)
       VALUES ($1, 1, $2, DATE '2026-08-23', $3, $4, $5, $6, $7)`,
      [supplierId, ref, desc, net, Number((net * 1.2).toFixed(2)), status, notes])
    console.log(`    + ${ref.padEnd(22)} ${f(net).padStart(12)}  ${status}`)
  }

  console.log("\n  Marshisaacs — owner: £17,400 per plot, three plots:")
  for (const plot of [1, 2, 3])
    await add(marsh.id, `MI-PLOT${plot}`, 17400, `Plot ${plot} plumbing & heating — £17,400 per plot`, "accepted",
      "Owner-supplied 2026-08-23: £17,400 per plot across three plots (£52,200 total).")

  const sherb = await sup("%sherborne%")
  console.log("\n  Sherborne Stone — quote 2 Feb 2026 (Martin Dodge), ex-VAT and delivery:")
  for (const q of SHERBORNE)
    await add(sherb.id, q.ref, q.net, q.desc, "accepted",
      "Sherborne Stone quotation emailed 2026-02-02 by Martin Dodge to George Wilson. Ex-VAT and delivery. Owner confirmed all water tabling agreed.")
  await add(sherb.id, SHERBORNE_NOT_CONFIRMED.ref, SHERBORNE_NOT_CONFIRMED.net, SHERBORNE_NOT_CONFIRMED.desc, "open",
    "Quoted 2026-02-02 but acceptance NOT confirmed by the owner — left open rather than assumed.")

  console.log("\n  Complete trades — contract value equals what was invoiced:")
  const leroc = await sup("%le roc%")
  await add(leroc.id, "LEROC-FINAL", 13371.00, "Block and beam — complete. Owner: fully paid, treat as the full price.", "accepted",
    "Owner 2026-08-23: Le Roc fully paid, invoiced total IS the contract value.")

  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("\n  DRY RUN — nothing written.") }
  else { await c.query("COMMIT"); console.log("\n  COMMITTED.") }
} catch (e) { await c.query("ROLLBACK"); console.error("rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
