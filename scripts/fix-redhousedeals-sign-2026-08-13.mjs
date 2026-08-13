/**
 * Correct two discount lines whose sign was dropped at ingest, 2026-08-13.
 *
 * scripts/ingest-text-layer.mjs mis-read the "*REDHOUSEDEALS" promotion lines
 * on invoices 78046389 and 78395807 as positive. The original documents (in
 * Blob and in ~/Downloads/GIL157_split) show them negative:
 *   78046389 line: Goods -5.60, VAT -1.12
 *   78395807 line: Goods -1.98, VAT -0.40
 * The invoice HEADERS were read correctly; only these two line items are
 * wrong, overstating line-derived spend by £15.16 net. Credits are stored
 * negative by convention.
 *
 * The fix asserts the current (wrong) values before touching anything and
 * updates exactly one line per invoice. Dry run by default; --execute to write.
 */

import pg from "pg"

const EXECUTE = process.argv.includes("--execute")

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set. Run with: node --env-file=.env.development.local scripts/fix-redhousedeals-sign-2026-08-13.mjs")
  process.exit(1)
}

const FIXES = [
  { invoiceNumber: "78046389", desc: "*REDHOUSEDEALS - Red House Deals", wrong: { net: 5.6, vat: 1.12 }, right: { net: -5.6, vat: -1.12 } },
  { invoiceNumber: "78395807", desc: "*REDHOUSEDEALS - Red House Deals", wrong: { net: 1.98, vat: 0.4 }, right: { net: -1.98, vat: -0.4 } },
]

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const client = await pool.connect()

try {
  await client.query("BEGIN")

  for (const f of FIXES) {
    const { rows } = await client.query(
      `SELECT li.id, li.line_net, li.line_vat, li.line_gross
         FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id
        WHERE i.invoice_number = $1 AND li.description = $2`,
      [f.invoiceNumber, f.desc],
    )
    if (rows.length !== 1) throw new Error(`${f.invoiceNumber}: expected 1 matching line, found ${rows.length}`)
    const l = rows[0]
    if (Number(l.line_net) !== f.wrong.net || Number(l.line_vat) !== f.wrong.vat) {
      throw new Error(`${f.invoiceNumber} line ${l.id}: values are not the expected wrong ones (net=${l.line_net}, vat=${l.line_vat}) — refusing to touch`)
    }
    const gross = Math.round((f.right.net + f.right.vat) * 100) / 100
    console.log(`line ${l.id} (${f.invoiceNumber}): net ${l.line_net} -> ${f.right.net}, vat ${l.line_vat} -> ${f.right.vat}, gross ${l.line_gross} -> ${gross}`)
    if (EXECUTE) {
      await client.query(
        "UPDATE invoice_line_items SET line_net = $2, line_vat = $3, line_gross = $4 WHERE id = $1",
        [l.id, f.right.net, f.right.vat, gross],
      )
    }
  }

  // Prove the two invoices now reconcile header-vs-lines.
  const { rows: check } = await client.query(`
    SELECT i.invoice_number, i.net, SUM(li.line_net) lnet
      FROM invoices i JOIN invoice_line_items li ON li.invoice_id = i.id
     WHERE i.invoice_number = ANY($1) GROUP BY i.id`,
    [FIXES.map((f) => f.invoiceNumber)],
  )
  for (const c of check) console.log(`${c.invoice_number}: header ${c.net} vs lines ${Number(c.lnet).toFixed(2)} ${EXECUTE ? "" : "(pre-fix)"}`)

  if (!EXECUTE) {
    await client.query("ROLLBACK")
    console.log("\nDRY RUN — nothing written. Re-run with --execute to apply.")
    process.exit(0)
  }
  await client.query("COMMIT")
  console.log("\nCOMMITTED.")
} catch (err) {
  await client.query("ROLLBACK")
  console.error("Rolled back:", err.message)
  process.exit(1)
} finally {
  client.release()
  await pool.end()
}
