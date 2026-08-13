/**
 * Owner decisions, 2026-08-13 (second batch):
 *
 * 1. Windows invoices were wrongly swept into the pre-July "paid" bulk mark.
 *    Owner: only Plot 2's windows are paid.
 *      - Invoice 77983461 (Plot 2 £16,321 + Plot 3 £26,238) -> part_paid
 *      - Invoice 77983446 (Plot 1 £16,167 only)             -> unpaid
 *    Amount-paid is not tracked, so part_paid counts fully into outstanding;
 *    the split is recorded in payment_notes.
 *
 * 2. Remaining classification decisions:
 *      - Chimney/abutment group -> 04 External Walls & Cladding ("chimney
 *        lives in external walls/masonry")
 *      - Roof window + its tile flashing -> 06 Windows & External Doors
 *      - Buried water pipe -> 02 Groundworks & Foundations; the buried
 *        electric duct is applied with it as the same trench logic — flagged
 *        to the owner as an inference, correctable via the invoices page.
 *
 * Same semantics as the earlier scripts: updates only, no deletes, lines only
 * where cost_package_id IS NULL, learning upsert identical to commitInvoice.
 * Dry run by default; --execute to write.
 */

import pg from "pg"

const EXECUTE = process.argv.includes("--execute")

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set. Run with: node --env-file=.env.development.local scripts/apply-owner-decisions-2026-08-13.mjs")
  process.exit(1)
}

const PAYMENTS = [
  {
    invoiceNumber: "77983461",
    status: "part_paid",
    note: "Owner 2026-08-13: Plot 2 windows (£16,321.00 net) paid; Plot 3 windows (£26,238.00 net) not yet paid. Amount-paid not tracked, so the full gross counts as outstanding.",
  },
  {
    invoiceNumber: "77983446",
    status: "unpaid",
    note: "Owner 2026-08-13: Plot 1 windows not yet paid (previously swept into the pre-July bulk paid mark in error).",
  },
]

// description-pattern -> package code, owner-decided.
const CLASSIFY = [
  [/flue liner|chimney pot|chimney shoulders|garage abutment/i, "04"],
  [/wcp 01|deep tile flashing/i, "06"],
  [/polyguard pipe coil|ridgicoil twinwall/i, "02"],
]

const NOISE_PATTERNS = [
  /\bpriced?\s+from\s+quote\b.*$/i,
  /\bquote\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i,
  /\bq\d{4,}\b/i,
  /\border\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i,
  /\bref\.?\s*[:#]?\s*[a-z0-9-]+/i,
]
function normaliseDescriptionKey(description) {
  let s = description ?? ""
  for (const re of NOISE_PATTERNS) s = s.replace(re, " ")
  return s.replace(/\s+/g, " ").trim().toUpperCase().toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const money = (v) => "£" + Number(v ?? 0).toFixed(2)
const client = await pool.connect()

try {
  await client.query("BEGIN")

  console.log("== PAYMENT CORRECTIONS ==")
  for (const pmt of PAYMENTS) {
    const { rows } = await client.query(
      "SELECT id, gross, payment_status FROM invoices WHERE invoice_number = $1", [pmt.invoiceNumber])
    if (rows.length !== 1) throw new Error(`expected exactly 1 invoice ${pmt.invoiceNumber}, found ${rows.length}`)
    console.log(`  ${pmt.invoiceNumber} (id ${rows[0].id}, gross ${money(rows[0].gross)}): ${rows[0].payment_status} -> ${pmt.status}`)
    if (EXECUTE) {
      await client.query(
        "UPDATE invoices SET payment_status = $2, paid_date = NULL, payment_notes = $3 WHERE id = $1",
        [rows[0].id, pmt.status, pmt.note])
    }
  }

  console.log("== CLASSIFICATION DECISIONS ==")
  const { rows: pkgs } = await client.query("SELECT id, code, name, project_id FROM cost_packages")
  const pkgByProjectCode = new Map(pkgs.map((p) => [p.project_id + ":" + p.code, p]))
  const { rows: lines } = await client.query(`
    SELECT li.id, li.description, li.line_net, i.project_id, i.supplier_id
      FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id
     WHERE li.cost_package_id IS NULL AND i.status = 'confirmed' ORDER BY li.id`)

  let updated = 0
  for (const l of lines) {
    const hit = CLASSIFY.find(([re]) => re.test(l.description))
    if (!hit) { console.log(`  LEFT UNCLASSIFIED: ${money(l.line_net)} ${l.description}`); continue }
    const pkg = pkgByProjectCode.get(l.project_id + ":" + hit[1])
    if (!pkg) throw new Error(`no package ${hit[1]} for project ${l.project_id}`)
    console.log(`  ${money(l.line_net).padStart(10)}  ${l.description.slice(0, 60)}  -> ${pkg.code} ${pkg.name}`)
    if (EXECUTE) {
      const res = await client.query(
        "UPDATE invoice_line_items SET cost_package_id = $1 WHERE id = $2 AND cost_package_id IS NULL",
        [pkg.id, l.id])
      updated += res.rowCount
      const key = normaliseDescriptionKey(l.description)
      if (key) {
        await client.query(`
          INSERT INTO classification_mappings
            (key_kind, key_value, supplier_id, cost_package_code, cost_package_name, times_confirmed)
          VALUES ('product', $1, $2, $3, $4, 1)
          ON CONFLICT (key_kind, key_value, (coalesce(supplier_id, 0)))
          DO UPDATE SET
            cost_package_code = COALESCE(EXCLUDED.cost_package_code, classification_mappings.cost_package_code),
            cost_package_name = COALESCE(EXCLUDED.cost_package_name, classification_mappings.cost_package_name),
            times_confirmed = classification_mappings.times_confirmed + 1,
            updated_at = now()`,
          [key, l.supplier_id, pkg.code, pkg.name])
      }
    }
  }

  if (!EXECUTE) {
    await client.query("ROLLBACK")
    console.log("\nDRY RUN — nothing written. Re-run with --execute to apply.")
    process.exit(0)
  }

  const { rows: [after] } = await client.query(`
    SELECT count(*) FILTER (WHERE cost_package_id IS NULL)::int unclassified,
           COALESCE(SUM(line_net) FILTER (WHERE cost_package_id IS NULL), 0) unclassified_net
      FROM invoice_line_items`)
  const { rows: pay } = await client.query(`
    SELECT payment_status, count(*)::int n, COALESCE(SUM(gross),0) g
      FROM invoices WHERE status = 'confirmed' GROUP BY 1 ORDER BY 1 NULLS LAST`)

  await client.query("COMMIT")
  console.log(`\nLines classified: ${updated}. Unclassified remaining: ${after.unclassified} (${money(after.unclassified_net)})`)
  for (const r of pay) console.log(`  ${r.payment_status ?? "not recorded"}: ${r.n} invoices ${money(r.g)}`)
} catch (err) {
  await client.query("ROLLBACK")
  console.error("Rolled back:", err.message)
  process.exit(1)
} finally {
  client.release()
  await pool.end()
}
