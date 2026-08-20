/**
 * Owner instruction (2026-08-20): move exactly two invoices into the new
 * "Legal & broker fees" package (project 1, code '22', is_build_cost = false):
 *
 *   - invoice #209  Copper Swan          £5,000  "75% remaining approval fee"
 *     (brokerage for the development finance; a £2,500 first instalment was
 *     already paid earlier via bank — not touched by this script, not in
 *     scope, no record of it in the invoices table to reclassify)
 *   - invoice #217  Thrings Solicitors   £750    professional legal charges
 *
 * This is a targeted, owner-approved reclassification — NOT a sweep. Only
 * line items belonging to these two invoice ids are touched. Every other
 * unclassified line item in the system is left exactly as it is.
 *
 * Semantics mirror commitInvoice / classify-bradfords-2026-08.mjs exactly:
 *   - only lines whose cost_package_id IS NULL are touched (never overwrites
 *     an existing classification — if either invoice's line is already
 *     classified, it is skipped and reported, never silently reassigned)
 *   - each assignment upserts classification_mappings on the same conflict
 *     target with times_confirmed + 1, product-keyed, supplier-scoped — same
 *     table/shape the review flow writes on every confirm
 *   - amounts, descriptions and totals are read verbatim from the invoice;
 *     nothing is invented or rebalanced (non-negotiable #1)
 *
 * Dry run by default; --execute to write. Update + insert/upsert only, no
 * deletes. Wrapped in a single transaction — a failure rolls back cleanly.
 */

import pg from "pg"

const EXECUTE = process.argv.includes("--execute")
const TARGET_INVOICE_IDS = [209, 217]
const PROJECT_ID = 1
const PACKAGE_CODE = "22"

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL not set. Run with: npx tsx --env-file=.env.local --env-file=.env.development.local scripts/reclassify-legal-broker-2026-08-20.mjs",
  )
  process.exit(1)
}

// --- lib/normalisation/products.ts, reproduced (this is a plain .mjs script) --
const NOISE_PATTERNS = [
  /\bpriced?\s+from\s+quote\b.*$/i,
  /\bquote\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i,
  /\bq\d{4,}\b/i,
  /\border\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i,
  /\bref\.?\s*[:#]?\s*[a-z0-9-]+/i,
]
function normaliseProductName(description) {
  if (!description) return ""
  let s = description
  for (const re of NOISE_PATTERNS) s = s.replace(re, " ")
  return s.replace(/\s+/g, " ").trim().toUpperCase()
}
function normaliseDescriptionKey(description) {
  return normaliseProductName(description)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const money = (v) => "£" + Number(v ?? 0).toFixed(2)

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()

try {
  await client.query("BEGIN")

  const { rows: pkgRows } = await client.query(
    "SELECT id, code, name, is_build_cost FROM cost_packages WHERE project_id = $1 AND code = $2",
    [PROJECT_ID, PACKAGE_CODE],
  )
  const pkg = pkgRows[0]
  if (!pkg) {
    throw new Error(
      `Package '${PACKAGE_CODE}' not found for project ${PROJECT_ID} — run scripts/add-non-build-cost-packages.mjs first.`,
    )
  }
  if (pkg.is_build_cost !== false) {
    throw new Error(`Package '${PACKAGE_CODE}' (${pkg.name}) is not flagged is_build_cost = false — refusing to proceed.`)
  }
  console.log(`Target package: ${pkg.code} ${pkg.name} (id ${pkg.id}, is_build_cost=${pkg.is_build_cost})`)

  const { rows: invoices } = await client.query(
    `SELECT i.id, i.invoice_number, i.net, i.project_id, i.supplier_id, s.name AS supplier_name
       FROM invoices i JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.id = ANY($1::int[])
      ORDER BY i.id`,
    [TARGET_INVOICE_IDS],
  )
  for (const id of TARGET_INVOICE_IDS) {
    if (!invoices.find((r) => r.id === id)) throw new Error(`Invoice #${id} not found — aborting.`)
  }
  for (const inv of invoices) {
    if (inv.project_id !== PROJECT_ID) {
      throw new Error(`Invoice #${inv.id} (${inv.supplier_name}) belongs to project ${inv.project_id}, not ${PROJECT_ID} — aborting.`)
    }
  }

  const { rows: lines } = await client.query(
    `SELECT li.id, li.invoice_id, li.description, li.line_net, li.cost_package_id, i.supplier_id
       FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id
      WHERE li.invoice_id = ANY($1::int[])
      ORDER BY li.invoice_id, li.id`,
    [TARGET_INVOICE_IDS],
  )

  const toUpdate = lines.filter((l) => l.cost_package_id == null)
  const alreadyClassified = lines.filter((l) => l.cost_package_id != null)

  console.log(`\nInvoices in scope: ${invoices.map((i) => `#${i.id} ${i.supplier_name} ${money(i.net)}`).join(", ")}`)
  console.log(`Line items found: ${lines.length}`)
  console.log(`  to classify (currently NULL): ${toUpdate.length}, total ${money(toUpdate.reduce((s, l) => s + Number(l.line_net), 0))}`)
  if (alreadyClassified.length > 0) {
    console.log(`  SKIPPED — already classified, left untouched: ${alreadyClassified.length}`)
    for (const l of alreadyClassified) console.log(`    line ${l.id} (invoice ${l.invoice_id}): already cost_package_id=${l.cost_package_id}`)
  }
  for (const l of toUpdate) {
    console.log(`    line ${l.id} (invoice ${l.invoice_id}): ${money(l.line_net)}  "${l.description.replace(/\s+/g, " ").trim()}"`)
  }

  if (!EXECUTE) {
    await client.query("ROLLBACK")
    console.log("\nDRY RUN — nothing written. Re-run with --execute to apply.")
    process.exit(0)
  }

  let updated = 0
  for (const l of toUpdate) {
    const res = await client.query(
      "UPDATE invoice_line_items SET cost_package_id = $1 WHERE id = $2 AND cost_package_id IS NULL",
      [pkg.id, l.id],
    )
    updated += res.rowCount

    const productKey = normaliseDescriptionKey(l.description)
    if (productKey) {
      await client.query(
        `INSERT INTO classification_mappings
           (key_kind, key_value, supplier_id, cost_package_code, cost_package_name, times_confirmed)
         VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (key_kind, key_value, (coalesce(supplier_id, 0)))
         DO UPDATE SET
           cost_package_code = COALESCE(EXCLUDED.cost_package_code, classification_mappings.cost_package_code),
           cost_package_name = COALESCE(EXCLUDED.cost_package_name, classification_mappings.cost_package_name),
           times_confirmed = classification_mappings.times_confirmed + 1,
           updated_at = now()`,
        ["product", productKey, l.supplier_id, pkg.code, pkg.name],
      )
    }
  }

  const { rows: after } = await client.query(
    `SELECT li.id, li.invoice_id, li.cost_package_id, cp.code, cp.name
       FROM invoice_line_items li LEFT JOIN cost_packages cp ON cp.id = li.cost_package_id
      WHERE li.invoice_id = ANY($1::int[]) ORDER BY li.invoice_id, li.id`,
    [TARGET_INVOICE_IDS],
  )

  await client.query("COMMIT")
  console.log(`\nUpdated: ${updated} line item(s).`)
  console.log("After state:")
  for (const r of after) console.log(`  line ${r.id} (invoice ${r.invoice_id}): package ${r.code ?? "(none)"} ${r.name ?? ""}`)
} catch (err) {
  await client.query("ROLLBACK")
  console.error("Rolled back:", err.message)
  process.exit(1)
} finally {
  client.release()
  await pool.end()
}
