/**
 * Merge duplicate supplier record "Bradfords" (id 6) into the canonical
 * "Bradfords Building Supplies Limited" (id 2).
 *
 * WHY: the same real company existed as two supplier rows, so the partial
 * unique index invoices_supplier_type_number_uidx — which keys on supplier_id —
 * could not see that six invoices had been ingested twice. £3,468.28 of actual
 * spend was double-counted, breaking non-negotiable #8.
 *
 * WHAT IT DOES
 *   1. Writes a full JSON backup of every row it will touch, BEFORE any change.
 *   2. Deletes the six duplicate invoices on supplier 6 (and their line items
 *      and price records) — these are exact repeats of rows already on
 *      supplier 2: same invoice number, same net.
 *   3. Repoints everything else from supplier 6 to supplier 2.
 *   4. Points the "bradfords" alias at supplier 2 so matching can never split
 *      this company again.
 *   5. Removes the now-empty supplier 6.
 *
 * SAFETY
 *   - Dry run by default. Pass --execute to write.
 *   - Everything runs in ONE transaction; any error rolls the whole thing back.
 *   - Re-runnable: if supplier 6 is already gone it reports "nothing to do".
 *   - Never touches the lender funding baseline.
 *
 *   node scripts/merge-supplier-bradfords.mjs             # dry run
 *   node scripts/merge-supplier-bradfords.mjs --execute   # apply
 */

import { readFileSync, writeFileSync } from "node:fs"
import pg from "pg"

const FROM_SUPPLIER = 6
const INTO_SUPPLIER = 2
const EXECUTE = process.argv.includes("--execute")

for (const line of readFileSync(new URL("../.env.development.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const money = (v) => "£" + Number(v ?? 0).toFixed(2)

const client = await pool.connect()
try {
  await client.query("BEGIN")

  const { rows: supplier } = await client.query("SELECT * FROM suppliers WHERE id = $1", [FROM_SUPPLIER])
  if (!supplier.length) {
    console.log(`Supplier ${FROM_SUPPLIER} does not exist — nothing to do.`)
    await client.query("ROLLBACK")
    process.exit(0)
  }

  // Invoices on the duplicate supplier whose number already exists on the
  // canonical one. These are the true duplicates.
  const { rows: dupInvoices } = await client.query(
    `SELECT i.id, i.invoice_number, i.net, i.status
       FROM invoices i
      WHERE i.supplier_id = $1
        AND lower(btrim(i.invoice_number)) IN (
              SELECT lower(btrim(invoice_number)) FROM invoices WHERE supplier_id = $2
            )
      ORDER BY i.id`,
    [FROM_SUPPLIER, INTO_SUPPLIER],
  )
  const dupIds = dupInvoices.map((r) => r.id)

  // Verify each duplicate really is identical before deleting anything.
  const mismatches = []
  for (const d of dupInvoices) {
    const { rows: keep } = await client.query(
      `SELECT id, net FROM invoices
        WHERE supplier_id = $1 AND lower(btrim(invoice_number)) = lower(btrim($2))`,
      [INTO_SUPPLIER, d.invoice_number],
    )
    if (keep.length !== 1 || Number(keep[0].net) !== Number(d.net)) {
      mismatches.push({ invoice_number: d.invoice_number, duplicate_net: d.net, kept: keep })
    }
  }
  if (mismatches.length) {
    console.error("ABORT — these are not exact duplicates. Nothing changed:")
    console.error(JSON.stringify(mismatches, null, 2))
    await client.query("ROLLBACK")
    process.exit(1)
  }

  const q = async (sql, params) => (await client.query(sql, params)).rows
  const backup = {
    generatedAt: new Date().toISOString(),
    fromSupplier: supplier[0],
    duplicateInvoices: dupInvoices,
    lineItems: dupIds.length ? await q("SELECT * FROM invoice_line_items WHERE invoice_id = ANY($1::int[])", [dupIds]) : [],
    priceRecordsOfDuplicates: dupIds.length ? await q("SELECT * FROM price_records WHERE invoice_id = ANY($1::int[])", [dupIds]) : [],
    invoicesToRepoint: await q("SELECT * FROM invoices WHERE supplier_id = $1 AND NOT (id = ANY($2::int[]))", [FROM_SUPPLIER, dupIds]),
    priceRecordsToRepoint: await q("SELECT * FROM price_records WHERE supplier_id = $1", [FROM_SUPPLIER]),
    classificationMappings: await q("SELECT * FROM classification_mappings WHERE supplier_id = $1", [FROM_SUPPLIER]),
    supplierProducts: await q("SELECT * FROM supplier_products WHERE supplier_id = $1", [FROM_SUPPLIER]),
    aliases: await q("SELECT * FROM supplier_aliases WHERE supplier_id = $1", [FROM_SUPPLIER]),
  }
  const backupPath = new URL(`../.backup-supplier-${FROM_SUPPLIER}-merge.json`, import.meta.url)
  writeFileSync(backupPath, JSON.stringify(backup, null, 2))

  const netRemoved = backup.lineItems.reduce((a, r) => a + Number(r.line_net ?? 0), 0)
  const invoiceNetRemoved = dupInvoices.reduce((a, r) => a + Number(r.net ?? 0), 0)

  console.log(`Merging supplier ${FROM_SUPPLIER} "${supplier[0].name}" into ${INTO_SUPPLIER}`)
  console.log(`  duplicate invoices to DELETE ....... ${dupInvoices.length}  (${dupInvoices.map((d) => d.invoice_number).join(", ")})`)
  console.log(`    their line items ................. ${backup.lineItems.length}  worth ${money(netRemoved)}`)
  console.log(`    their price records .............. ${backup.priceRecordsOfDuplicates.length}`)
  console.log(`    invoice net removed .............. ${money(invoiceNetRemoved)}`)
  console.log(`  invoices to REPOINT ............... ${backup.invoicesToRepoint.length}`)
  console.log(`  price records to REPOINT .......... ${backup.priceRecordsToRepoint.length}`)
  console.log(`  classification mappings ........... ${backup.classificationMappings.length}`)
  console.log(`  supplier products ................. ${backup.supplierProducts.length}`)
  console.log(`  aliases to REPOINT ................ ${backup.aliases.length}  (${backup.aliases.map((a) => a.normalised_name).join(", ")})`)
  console.log(`  backup written to ................. ${backupPath.pathname}`)

  const before = Number((await q("SELECT COALESCE(SUM(net),0) s FROM invoices WHERE status = 'confirmed'"))[0].s)

  if (dupIds.length) {
    await client.query("DELETE FROM price_records WHERE invoice_id = ANY($1::int[])", [dupIds])
    await client.query("DELETE FROM invoice_line_items WHERE invoice_id = ANY($1::int[])", [dupIds])
    await client.query("DELETE FROM invoices WHERE id = ANY($1::int[])", [dupIds])
  }

  await client.query("UPDATE invoices SET supplier_id = $1 WHERE supplier_id = $2", [INTO_SUPPLIER, FROM_SUPPLIER])
  await client.query("UPDATE price_records SET supplier_id = $1 WHERE supplier_id = $2", [INTO_SUPPLIER, FROM_SUPPLIER])
  await client.query("UPDATE supplier_products SET supplier_id = $1 WHERE supplier_id = $2", [INTO_SUPPLIER, FROM_SUPPLIER])

  // classification_mappings is unique on (key_kind, key_value, COALESCE(supplier_id,0)).
  // Where the canonical supplier already holds the same key, keep it and fold in
  // the confirmation count rather than losing the learning.
  await client.query(
    `UPDATE classification_mappings c
        SET times_confirmed = c.times_confirmed + d.times_confirmed
       FROM classification_mappings d
      WHERE d.supplier_id = $1 AND c.supplier_id = $2
        AND c.key_kind = d.key_kind AND c.key_value = d.key_value`,
    [FROM_SUPPLIER, INTO_SUPPLIER],
  )
  await client.query(
    `DELETE FROM classification_mappings d
      WHERE d.supplier_id = $1
        AND EXISTS (SELECT 1 FROM classification_mappings c
                     WHERE c.supplier_id = $2 AND c.key_kind = d.key_kind AND c.key_value = d.key_value)`,
    [FROM_SUPPLIER, INTO_SUPPLIER],
  )
  await client.query("UPDATE classification_mappings SET supplier_id = $1 WHERE supplier_id = $2", [INTO_SUPPLIER, FROM_SUPPLIER])

  // Keep the alias so "Bradfords" still resolves — now to the canonical row.
  await client.query(
    `UPDATE supplier_aliases a SET supplier_id = $1
      WHERE a.supplier_id = $2
        AND NOT EXISTS (SELECT 1 FROM supplier_aliases b
                         WHERE b.supplier_id = $1 AND b.normalised_name = a.normalised_name)`,
    [INTO_SUPPLIER, FROM_SUPPLIER],
  )
  await client.query("DELETE FROM supplier_aliases WHERE supplier_id = $1", [FROM_SUPPLIER])
  await client.query("DELETE FROM suppliers WHERE id = $1", [FROM_SUPPLIER])

  const after = Number((await q("SELECT COALESCE(SUM(net),0) s FROM invoices WHERE status = 'confirmed'"))[0].s)
  const { rows: remaining } = await client.query(
    `SELECT invoice_number FROM invoices GROUP BY invoice_number HAVING count(*) > 1`,
  )

  console.log(`\n  confirmed net BEFORE .............. ${money(before)}`)
  console.log(`  confirmed net AFTER ............... ${money(after)}`)
  console.log(`  difference ........................ ${money(before - after)}`)
  console.log(`  invoice numbers still duplicated .. ${remaining.length}`)

  if (remaining.length) {
    console.error("ABORT — duplicates remain after merge. Rolling back.")
    await client.query("ROLLBACK")
    process.exit(1)
  }

  if (EXECUTE) {
    await client.query("COMMIT")
    console.log("\nCOMMITTED.")
  } else {
    await client.query("ROLLBACK")
    console.log("\nDRY RUN — rolled back. Nothing was changed. Re-run with --execute to apply.")
  }
} catch (err) {
  await client.query("ROLLBACK")
  console.error("Rolled back:", err.message)
  process.exit(1)
} finally {
  client.release()
  await pool.end()
}
