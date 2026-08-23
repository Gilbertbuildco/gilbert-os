/**
 * Record the remaining cost-to-complete the owner supplied on 2026-08-23.
 *
 * TWO KINDS OF NUMBER, kept apart on purpose:
 *
 *   status 'accepted' — a supplier document exists. Rhys Harvey's quote 1001100
 *                       is a real quotation with per-plot pricing and payment
 *                       terms. Work has already started against it (£2,025
 *                       invoiced), so it is accepted despite the printed expiry.
 *
 *   status 'estimate' — the owner's own allowance, with NO supplier document.
 *                       Carpenter, stairs, appliances, solar. These must never
 *                       be presented as quoted or contracted (non-negotiable
 *                       #1) and are excluded from `contracted` totals, which
 *                       filter on 'accepted'.
 *
 * The Woodpecker flooring sits between the two: the RATE is real (£96.95 per
 * 2.888m² pack, Bradfords invoice 22 Jul 2026), the QUANTITY is the owner's
 * forecast of 200m². Recorded as an estimate with the arithmetic stated, since
 * nothing has been ordered.
 *
 * Idempotent. Dry-run by default.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
for (const l of readFileSync("/Users/tomgilbert/GilbertOS/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const EXECUTE = process.argv.includes("--execute")
const f = (n) => `£${Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Woodpecker: 200m2 / 2.888m2 per pack = 69.25 -> 70 whole packs at £96.95.
const PACKS = Math.ceil(200 / 2.888)
const WOOD = Number((PACKS * 96.95).toFixed(2))

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
const sup = async (like) => (await c.query(`SELECT id, name FROM suppliers WHERE name ILIKE $1 ORDER BY id LIMIT 1`, [like])).rows[0]
try {
  await c.query("BEGIN")
  const add = async (supplierId, raw, ref, net, desc, status, notes) => {
    if ((await c.query(`SELECT id FROM quotes WHERE reference = $1`, [ref])).rowCount) { console.log(`    = ${ref} already recorded`); return }
    if (EXECUTE) await c.query(
      `INSERT INTO quotes (supplier_id, supplier_name_raw, project_id, reference, quote_date, description, net, vat, gross, status, notes)
       VALUES ($1,$2,1,$3,DATE '2026-08-23',$4,$5,$6,$7,$8,$9)`,
      [supplierId, raw, ref, desc, net, Number((net * 0.2).toFixed(2)), Number((net * 1.2).toFixed(2)), status, notes])
    console.log(`    + ${ref.padEnd(24)} ${f(net).padStart(12)}  ${status}`)
  }

  console.log("  QUOTED — supplier document exists:")
  const rhys = await sup("%rhys harvey%")
  const RH = "Rhys Harvey Electrical quote 1001100, issued 2025-08-25, ref 'Shepton montague electrical installation quote as per drawings'. Terms: 30% on first site visit, 30% at completion of first fix, 40% on completion of second fix. Printed expiry 2025-09-24 but work is under way and invoiced, so treated as accepted."
  for (const [plot, amt] of [[1, 9495], [2, 8995], [3, 9495]])
    await add(rhys.id, null, `RH-1001100-P${plot}`, amt, `Plot ${plot} electrical installation as per drawings`, "accepted", RH)

  console.log("\n  OWNER ESTIMATES — no supplier document, excluded from contracted totals:")
  await add(null, "Woodpecker flooring (supplier TBC)", "EST-FLOORING-WOODPECKER", WOOD,
    `Woodpecker Trade Classic Candied Oak — 200m2 required. ${PACKS} packs at £96.95 (2.888m2 per pack).`,
    "estimate",
    "Owner 2026-08-23: 200m2 needed, not yet ordered. RATE is real — £96.95 per 2.888m2 pack from Bradfords invoice 78430923, 22 Jul 2026. QUANTITY is the owner's forecast.")
  for (const [ref, net, what] of [
    ["EST-CARPENTER", 10000, "Carpenter — owner allowance"],
    ["EST-STAIRS", 6000, "Stairs — owner allowance (separate from the buyer-funded metal staircase)"],
    ["EST-APPLIANCES", 6000, "Appliances — owner allowance"],
    ["EST-SOLAR", 10000, "Solar — owner allowance"],
  ]) await add(null, "Not yet appointed", ref, net, what, "estimate", "Owner allowance stated 2026-08-23. No supplier document — an allowance, not a quote.")

  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("\n  DRY RUN.") }
  else { await c.query("COMMIT"); console.log("\n  COMMITTED.") }
} catch (e) { await c.query("ROLLBACK"); console.error("rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
