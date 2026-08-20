/**
 * 1. Correct the Protek warranty premium to the figure on Protek's own
 *    document. Their quotation 31055 (03/11/2025) itemises:
 *      warranty premium £9,450.00 + IPT £1,134.00 + technical audit and
 *      administration £5,894.00 + consumer code £66.00 = TOTAL £16,544.00
 *    Goldentree's loan opening statement charged £16,554.00 — £10 more than
 *    Protek billed. Owner: use the invoice figure. The £10 is a lender-side
 *    difference, recorded in the notes rather than absorbed silently.
 *
 * 2. Owner decision 2026-08-20: the van is an expense but NOT a build cost.
 *    Package 26 "Vehicles & Equipment", is_build_cost = false, so it is
 *    excluded from build-cost totals the same way legal & broker fees are.
 *
 * Idempotent. Dry run by default; --execute to write.
 */
import pg from "pg"

const EXECUTE = process.argv.includes("--execute")
const PROTEK = 16544.00
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")

  // --- 1. Protek correction ---
  const { rows: [inv] } = await c.query(
    "SELECT i.id, i.net FROM invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE s.name ILIKE '%protek%'")
  if (!inv) console.log("no Protek invoice found")
  else if (Number(inv.net) === PROTEK) console.log(`Protek #${inv.id} already £${PROTEK.toFixed(2)}`)
  else {
    console.log(`Protek #${inv.id}: £${Number(inv.net).toFixed(2)} -> £${PROTEK.toFixed(2)} (per Protek quotation 31055)`)
    if (EXECUTE) {
      await c.query(`UPDATE invoices SET net=$2, gross=$2, review_question=NULL, review_question_at=NULL,
        notes = notes || $3 WHERE id=$1`,
        [inv.id, PROTEK,
         " Corrected 2026-08-20 to £16,544.00 per Protek quotation 31055 (premium £9,450 + IPT £1,134 + technical audit £5,894 + consumer code £66). Goldentree's opening statement charged £16,554.00, £10 more than Protek billed — difference sits with the lender."])
      await c.query(`UPDATE invoice_line_items SET line_net=$2, line_gross=$2, unit_price_ex_vat=$2 WHERE invoice_id=$1`, [inv.id, PROTEK])
    }
  }

  // --- 2. Vehicles & Equipment (non-build) ---
  let { rows: [veh] } = await c.query("SELECT id FROM cost_packages WHERE project_id=1 AND code='26'")
  if (veh) console.log("package 26 exists")
  else {
    console.log('would create package 26 "Vehicles & Equipment" (is_build_cost = FALSE — excluded from build cost)')
    if (EXECUTE) {
      veh = (await c.query("INSERT INTO cost_packages (project_id,code,name,is_build_cost) VALUES (1,'26','Vehicles & Equipment',false) RETURNING id")).rows[0]
      console.log(`  created #${veh.id}`)
    }
  }
  const { rows: van } = await c.query(`SELECT li.id, li.line_net, li.cost_package_id, s.name sup, li.description
    FROM invoice_line_items li JOIN invoices i ON i.id=li.invoice_id JOIN suppliers s ON s.id=i.supplier_id
    WHERE i.status='confirmed' AND (s.name ILIKE '%270 adventure%' OR li.description ILIKE '%ford ranger%')`)
  for (const l of van) {
    if (veh && l.cost_package_id === veh.id) { console.log(`  line ${l.id} already in 26`); continue }
    console.log(`  move line ${l.id} £${Number(l.line_net).toFixed(2)} ${l.sup} (${String(l.description).slice(0,30)}) -> 26`)
    if (EXECUTE && veh) await c.query("UPDATE invoice_line_items SET cost_package_id=$1 WHERE id=$2", [veh.id, l.id])
  }

  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("\nDRY RUN — nothing written.") }
  else { await c.query("COMMIT"); console.log("\nCOMMITTED.") }
} catch (e) { await c.query("ROLLBACK"); console.error("Rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
