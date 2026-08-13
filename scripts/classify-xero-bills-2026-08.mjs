/**
 * Classify the 32 Xero-ingested bills, owner-reviewed 2026-08-13.
 *
 * Supplier-level classification (these are subcontract/service bills — one
 * trade each). Owner decisions incorporated: Harlequin lays stone/brick (04),
 * George Wilson is the site foreman (01 Preliminaries), Marshisaacs latest
 * work is plumbing (09), LICK is paint (15), Lazenby is the polished floor
 * (16), the 270 Adventure bill is a van (asset — excluded from packages).
 *
 * Deliberately left NULL (not build packages, or open owner decisions):
 *   270 Adventure (van/asset), Copper Swan (finance fee), Thrings / Spire /
 *   Structural Solutions (professional fees — funding schedule roll-up still
 *   open), Wessex Water + SSEN (the unresolved utilities funding decision).
 *
 * Same semantics as classify-bradfords-2026-08.mjs: only lines whose
 * cost_package_id IS NULL, learning upsert identical to commitInvoice,
 * dry-run default, --execute to write.
 */

import pg from "pg"

const EXECUTE = process.argv.includes("--execute")

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set. Run with: node --env-file=.env.development.local scripts/classify-xero-bills-2026-08.mjs")
  process.exit(1)
}

// supplier name -> package code (null = deliberately unclassified)
const SUPPLIER_PLAN = new Map([
  ["Target Timber Frames", "03"],
  ["Hopkins concrete", "02"],
  ["Sherborne Stone", "04"],
  ["Le Roc", "04"],
  ["Ck Scaffolding", "01"],
  ["George Wilson - pro", "01"],
  ["Marshisaacs Ltd", "09"],
  ["Rhys Harvey Electrical", "10"],
  ["Jordan Reeves", "08"],
  ["Hugo Saunders", "15"],
  ["Lee Richards", "11"],
  ["Lazenby", "16"],
  ["Metal Stair co", "12"],
  ["Crestmoor Plant Hire", "01"],
  ["Crestmoor Construction Services Ltd", "01"],
  ["Events crew limited", "01"],
  ["Civils Store Limited", "02"],
  ["Howden Insurance", "01"],
  ["LICK", "15"],
  ["Thrings Solicitors", null],
  ["Spire Building Control", null],
  ["Structural Solutions", null],
  ["Copper Swan", null],
  ["270 Adventure Limited", null],
  ["Wessex Water", null],
  ["Scotish and Sothern Electricity Networks", null],
])

const NOISE = [/\bpriced?\s+from\s+quote\b.*$/i, /\bquote\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i, /\bq\d{4,}\b/i, /\border\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i, /\bref\.?\s*[:#]?\s*[a-z0-9-]+/i]
const keyOf = (d) => {
  let s = d ?? ""
  for (const re of NOISE) s = s.replace(re, " ")
  return s.replace(/\s+/g, " ").trim().toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const money = (v) => "£" + Number(v ?? 0).toFixed(2)
const client = await pool.connect()

try {
  await client.query("BEGIN")
  const { rows: pkgs } = await client.query("SELECT id, code, name, project_id FROM cost_packages")
  const pkgByProjectCode = new Map(pkgs.map((p) => [p.project_id + ":" + p.code, p]))
  const { rows: lines } = await client.query(`
    SELECT li.id, li.description, li.line_net, i.project_id, i.supplier_id, s.name AS supplier
      FROM invoice_line_items li
      JOIN invoices i ON i.id = li.invoice_id
      JOIN suppliers s ON s.id = i.supplier_id
     WHERE li.cost_package_id IS NULL AND i.status = 'confirmed'
     ORDER BY li.id`)

  let updated = 0
  const byCode = new Map()
  const left = new Map()
  for (const l of lines) {
    const code = SUPPLIER_PLAN.get(l.supplier)
    if (code === undefined) { left.set(l.supplier, (left.get(l.supplier) ?? 0) + Number(l.line_net)); continue }
    if (code === null) { left.set(l.supplier + " (deliberate)", (left.get(l.supplier + " (deliberate)") ?? 0) + Number(l.line_net)); continue }
    const pkg = pkgByProjectCode.get(l.project_id + ":" + code)
    if (!pkg) throw new Error(`no package ${code} for project ${l.project_id}`)
    const c = byCode.get(code) ?? { n: 0, net: 0, name: pkg.name }
    c.n++; c.net += Number(l.line_net); byCode.set(code, c)
    if (EXECUTE) {
      const res = await client.query("UPDATE invoice_line_items SET cost_package_id = $1 WHERE id = $2 AND cost_package_id IS NULL", [pkg.id, l.id])
      updated += res.rowCount
      const key = keyOf(l.description)
      if (key) {
        await client.query(`
          INSERT INTO classification_mappings (key_kind, key_value, supplier_id, cost_package_code, cost_package_name, times_confirmed)
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

  console.log("== PLAN ==")
  for (const [code, c] of [...byCode].sort()) console.log(`  ${code} ${c.name}: ${c.n} lines ${money(c.net)}`)
  console.log("== LEFT UNCLASSIFIED ==")
  for (const [who, net] of [...left].sort((a, b) => b[1] - a[1])) console.log(`  ${money(net).padStart(11)}  ${who}`)

  if (!EXECUTE) {
    await client.query("ROLLBACK")
    console.log("\nDRY RUN — nothing written. Re-run with --execute to apply.")
    process.exit(0)
  }
  const { rows: [after] } = await client.query(`
    SELECT count(*) FILTER (WHERE cost_package_id IS NULL)::int n,
           COALESCE(SUM(line_net) FILTER (WHERE cost_package_id IS NULL), 0) net
      FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id WHERE i.status = 'confirmed'`)
  await client.query("COMMIT")
  console.log(`\nUpdated: ${updated}. Remaining unclassified: ${after.n} lines ${money(after.net)}`)
} catch (err) {
  await client.query("ROLLBACK")
  console.error("Rolled back:", err.message)
  process.exit(1)
} finally {
  client.release()
  await pool.end()
}
