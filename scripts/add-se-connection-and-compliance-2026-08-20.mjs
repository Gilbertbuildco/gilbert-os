/**
 * Owner decisions 2026-08-20:
 *  1. The £4,045.14 paid to Southern Electric on 06/03/2026 is a real build
 *     cost — a charge to drop the electricity line underground, which they
 *     missed off their original quote. It was paid by bank transfer and has no
 *     invoice document, so the record is created from the verified Xero bank
 *     transaction (a152fcaa-e8bd-4684-bb6a-43fd13868184, total £4,045.14, zero
 *     VAT) and flagged needs_review with the missing document noted. No figure
 *     is invented — every value comes from that payment.
 *  2. Building control and structural warranty get their own category.
 *
 * Creates package 25 "Building Control & Warranty" (is_build_cost = true),
 * moves Spire Building Control into it, and adds the Southern Electric cost to
 * package 23 Utilities & Service Connections.
 *
 * Idempotent. Dry run by default; --execute to write.
 */
import pg from "pg"

const EXECUTE = process.argv.includes("--execute")
const BANK_TX = "a152fcaa-e8bd-4684-bb6a-43fd13868184"
const AMOUNT = 4045.14
const PAID_DATE = "2026-03-06"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")

  // --- 1. Building Control & Warranty package ---
  let { rows: [comp] } = await c.query("SELECT id FROM cost_packages WHERE project_id=1 AND code='25'")
  if (comp) console.log("package 25 exists")
  else {
    console.log('would create package 25 "Building Control & Warranty" (is_build_cost = true)')
    if (EXECUTE) {
      comp = (await c.query("INSERT INTO cost_packages (project_id,code,name,is_build_cost) VALUES (1,'25','Building Control & Warranty',true) RETURNING id")).rows[0]
      console.log(`  created #${comp.id}`)
    }
  }
  const { rows: spire } = await c.query(`
    SELECT li.id, li.line_net, li.cost_package_id, s.name sup FROM invoice_line_items li
     JOIN invoices i ON i.id=li.invoice_id JOIN suppliers s ON s.id=i.supplier_id
     WHERE s.name ILIKE '%spire%' AND i.status='confirmed'`)
  for (const l of spire) {
    if (comp && l.cost_package_id === comp.id) { console.log(`  line ${l.id} already in 25`); continue }
    console.log(`  move line ${l.id} £${Number(l.line_net).toFixed(2)} ${l.sup} -> 25`)
    if (EXECUTE && comp) await c.query("UPDATE invoice_line_items SET cost_package_id=$1 WHERE id=$2", [comp.id, l.id])
  }

  // --- 2. Southern Electric underground line charge ---
  const { rows: [dupe] } = await c.query(
    "SELECT id FROM invoices WHERE notes ILIKE $1 OR (net = $2 AND invoice_date = $3)", [`%${BANK_TX}%`, AMOUNT, PAID_DATE])
  if (dupe) console.log(`\nSouthern Electric cost already recorded as invoice #${dupe.id} — skip`)
  else {
    let { rows: [sup] } = await c.query("SELECT id FROM suppliers WHERE name = 'Southern Electric'")
    console.log(`\nwould add Southern Electric £${AMOUNT.toFixed(2)} (${PAID_DATE}) to package 23, paid, needs_review`)
    if (EXECUTE) {
      if (!sup) {
        sup = (await c.query("INSERT INTO suppliers (name) VALUES ('Southern Electric') RETURNING id")).rows[0]
        await c.query("INSERT INTO supplier_aliases (supplier_id, normalised_name, raw_name) VALUES ($1,'southern electric','Southern Electric')", [sup.id])
        console.log(`  created supplier #${sup.id}`)
      }
      const { rows: [util] } = await c.query("SELECT id FROM cost_packages WHERE project_id=1 AND code='23'")
      const { rows: [inv] } = await c.query(`
        INSERT INTO invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
                              net, vat, gross, status, notes, needs_review, reconciled, payment_status, payment_notes)
        VALUES ($1, 1, NULL, $2, 'invoice', $3, 0, $3, 'confirmed', $4, true, true, 'paid', $5)
        RETURNING id`,
        [sup.id, PAID_DATE, AMOUNT,
         `Charge to drop the electricity line underground — omitted from Southern Electric's original quote. No invoice document received; created from Xero bank transaction ${BANK_TX}.`,
         `Paid by bank transfer ${PAID_DATE} (Xero bank transaction ${BANK_TX}). Owner-confirmed 2026-08-20.`])
      await c.query(`
        INSERT INTO invoice_line_items (invoice_id, description, quantity, unit, unit_price_ex_vat,
                                        line_net, line_vat, line_gross, vat_rate, cost_package_id, is_price_tracked)
        VALUES ($1, 'Underground electricity line drop — charge omitted from original quote', 1, NULL, $2, $2, 0, $2, 0, $3, false)`,
        [inv.id, AMOUNT, util?.id ?? null])
      await c.query(`
        UPDATE invoices SET review_question = $2, review_question_at = now() WHERE id = $1`,
        [inv.id, "No invoice document was ever received for this £4,045.14 payment. Can Southern Electric send one? Until then the OS record rests on the bank payment alone."])
      console.log(`  created invoice #${inv.id} in package 23, with a question attached`)
    }
  }

  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("\nDRY RUN — nothing written.") }
  else {
    await c.query("COMMIT")
    const t = async (code) => Number((await pool.query(`SELECT COALESCE(SUM(li.line_net),0) s FROM invoice_line_items li
      JOIN invoices i ON i.id=li.invoice_id JOIN cost_packages cp ON cp.id=li.cost_package_id
      WHERE i.status='confirmed' AND cp.code=$1 AND cp.project_id=1`, [code])).rows[0].s)
    console.log(`\nCOMMITTED. Package 23 Utilities £${(await t("23")).toFixed(2)} | Package 25 Building Control & Warranty £${(await t("25")).toFixed(2)}`)
  }
} catch (e) { await c.query("ROLLBACK"); console.error("Rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
