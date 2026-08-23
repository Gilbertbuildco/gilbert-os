/**
 * Split Harlequin's invoices into the plot stonework contract and everything
 * billed on top, so the contract can be measured against its own quote.
 *
 * Owner, 2026-08-23: "the quote number should be for the stone works on plot 1,
 * 2 and 3 all together. Then we add whats been spent so far. We can move the
 * additional garage brickwork to a different line entirely."
 *
 * Each invoice was ingested as ONE summary line, which made it impossible to
 * tell a contract draw from a garage or an extra. Every figure below is
 * transcribed from the invoice documents themselves.
 *
 * Contract (less brick garages): Plot 1 £31,302.50 + Plot 2 £25,452.50
 * + Plot 3 £25,288.50 = £82,043.50.
 *
 * Garages are measured per m2 at £48 as they are built and sit OUTSIDE that
 * sum, as do the E/O works. They go to their own cost package so they can never
 * be read as consuming the stonework contract.
 *
 * Idempotent: re-running replaces the same lines with identical values.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
for (const l of readFileSync("/Users/tomgilbert/GilbertOS/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const EXECUTE = process.argv.includes("--execute")

// invoice -> lines, verbatim from the documents. kind: "contract" | "extra"
const INVOICES = {
  "01": [
    { kind: "contract", d: "Plot 1 superstructure draw", v: 8526.00 },
    { kind: "extra", d: "BDPC/stonework: Plot 1 stone 5.45m² @ £125", v: 681.25 },
    { kind: "extra", d: "BDPC/stonework: Plot 2 stone 3.93m² @ £125", v: 491.25 },
    { kind: "extra", d: "E/O: stone heads through scaffold £32; collection from Bradfords £32", v: 64.00 },
  ],
  "02": [
    { kind: "contract", d: "Plot 1 draw", v: 5000.00 },
    { kind: "contract", d: "Plot 3 draw", v: 6248.00 },
  ],
  "03": [
    { kind: "contract", d: "Plot 1 draw", v: 5000.00 },
    { kind: "contract", d: "Plot 3 draw", v: 6385.00 },
    { kind: "contract", d: "Plot 2 draw", v: 300.00 },
  ],
  "04": [
    { kind: "contract", d: "Plot 1 draw", v: 5000.00 },
    { kind: "contract", d: "Plot 2 draw", v: 5310.50 },
    { kind: "contract", d: "Plot 3 draw", v: 550.00 },
    { kind: "extra", d: "E/O: 140mm block course to garage perimeters, cut block, realter trays Plot 2", v: 1152.00 },
    // Harlequin's own arithmetic: the items sum to £12,012.50 but the claim is
    // £12,012.00. Recorded as a labelled adjustment so the OS matches the
    // document total without altering any value they stated. The same 50p is
    // why Plot 3's running balance reads £9,685.00 rather than £9,685.50.
    { kind: "contract", d: "Rounding: invoice claims £12,012.00 while its items total £12,012.50 (Harlequin's arithmetic)", v: -0.50 },
  ],
  "05": [{ kind: "contract", d: "Plot 2 draw", v: 4900.00 }],
  "06": [
    { kind: "contract", d: "Plot 1 draw", v: 3000.00 },
    { kind: "contract", d: "Plot 2 draw", v: 6107.00 },
    { kind: "extra", d: "Plot 3 garage draw (to be remeasured)", v: 600.00 },
    { kind: "extra", d: "E/O: scaffold porch, take down and alter garage door reveals", v: 256.00 },
  ],
  "07": [
    { kind: "contract", d: "Plot 1 draw (final — balance nil)", v: 1776.00 },
    { kind: "contract", d: "Plot 2 draw", v: 1175.00 },
    { kind: "contract", d: "Plot 3 draw", v: 2420.00 },
    { kind: "extra", d: "E/O: Plot 3 dormer gables", v: 544.00 },
    { kind: "extra", d: "E/O: blockwork Plot 1 utility", v: 316.80 },
    { kind: "extra", d: "Garage brickwork Plot 2: 11.5m² @ £48", v: 552.00 },
    { kind: "extra", d: "Garage brickwork Plot 3: 28.5m² @ £48 (£1,368) less £600 previously drawn", v: 768.00 },
  ],
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  const { rows: [extraPkg] } = await c.query(`
    INSERT INTO cost_packages (project_id, code, name, is_build_cost)
    SELECT 1, '29', 'Garages & Site Extras', true
     WHERE NOT EXISTS (SELECT 1 FROM cost_packages WHERE project_id=1 AND code='29')
    RETURNING id, name`)
  const { rows: [extras] } = extraPkg ? { rows: [extraPkg] } : await c.query(`SELECT id, name FROM cost_packages WHERE project_id=1 AND code='29'`)
  const { rows: [walls] } = await c.query(`SELECT id, name FROM cost_packages WHERE project_id=1 AND code='04'`)
  console.log(`  contract lines -> ${walls.name}\n  extras/garages -> ${extras.name}\n`)

  let contractTotal = 0, extraTotal = 0
  for (const [num, lines] of Object.entries(INVOICES)) {
    const { rows: [inv] } = await c.query(
      `SELECT i.id, i.net FROM invoices i JOIN suppliers s ON s.id=i.supplier_id
        WHERE s.name ILIKE '%harlequin%' AND i.invoice_number=$1 AND i.status='confirmed'`, [num])
    if (!inv) { console.log(`  ! invoice ${num} not found`); continue }
    const sum = lines.reduce((a, l) => a + l.v, 0)
    if (Math.round(sum * 100) !== Math.round(Number(inv.net) * 100)) {
      throw new Error(`invoice ${num}: lines total £${sum.toFixed(2)} but the invoice is £${Number(inv.net).toFixed(2)} — refusing to write`)
    }
    if (EXECUTE) {
      await c.query(`DELETE FROM invoice_line_items WHERE invoice_id=$1`, [inv.id])
      for (const l of lines)
        await c.query(
          `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price_ex_vat, line_net, cost_package_id, is_price_tracked)
           VALUES ($1,$2,1,$3,$3,$4,false)`,
          [inv.id, l.d, l.v, l.kind === "contract" ? walls.id : extras.id])
    }
    const cSum = lines.filter(l => l.kind === "contract").reduce((a, l) => a + l.v, 0)
    const eSum = sum - cSum
    contractTotal += cSum; extraTotal += eSum
    console.log(`  inv ${num}: £${Number(inv.net).toFixed(2).padStart(9)} = contract £${cSum.toFixed(2).padStart(9)} + extras £${eSum.toFixed(2).padStart(8)}  (${lines.length} lines)`)
  }
  console.log(`\n  CONTRACT DRAWN  £${contractTotal.toFixed(2)}   of £82,043.50 quoted`)
  console.log(`  GARAGES/EXTRAS  £${extraTotal.toFixed(2)}   billed outside the contract`)
  console.log(`  by arithmetic, contract remaining £${(82043.50 - contractTotal).toFixed(2)}`)
  console.log(`  Harlequin's own stated remaining: £17,345.00  (difference £${(82043.50 - contractTotal - 17345).toFixed(2)})`)

  // The contract quote itself, so the OS holds quote vs paid.
  if (!(await c.query(`SELECT 1 FROM quotes WHERE reference='HARLEQUIN-STONE-P123'`)).rowCount) {
    const { rows: [sup] } = await c.query(`SELECT id FROM suppliers WHERE name ILIKE '%harlequin%' LIMIT 1`)
    if (EXECUTE) await c.query(
      `INSERT INTO quotes (supplier_id, project_id, reference, quote_date, description, net, vat, gross, status, notes)
       VALUES ($1,1,'HARLEQUIN-STONE-P123',DATE '2026-05-18',$2,82043.50,0,82043.50,'accepted',$3)`,
      [sup.id,
       "Stone/brickwork superstructure, Plots 1-3, less brick garages — Plot 1 £31,302.50, Plot 2 £25,452.50, Plot 3 £25,288.50",
       "Contract sum taken from the per-plot prices stated on every Harlequin invoice. Garages are measured separately at £48/m² and E/O works are billed on top; both are excluded and carry their own cost package."])
    console.log(`  + quote HARLEQUIN-STONE-P123 £82,043.50 accepted`)
  } else console.log(`  = quote already recorded`)

  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("\n  DRY RUN.") }
  else { await c.query("COMMIT"); console.log("\n  COMMITTED.") }
} catch (e) { await c.query("ROLLBACK"); console.error("  rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
