/**
 * Classify the ten line items that reached no cost package.
 *
 * Each is matched on what the document actually says, and a credit is put on
 * the same package as the invoice it credits — otherwise a credit reduces a
 * package that never carried the original cost.
 *
 * Idempotent; dry-run by default.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
for (const l of readFileSync("/Users/tomgilbert/GilbertOS/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const EXECUTE = process.argv.includes("--execute")

const RULES = [
  { re: /surecav|cavity spacer/i,            code: "04", why: "cavity wall system -> External Walls & Cladding" },
  { re: /snowcrete|mastercrete|cement|lime/i,code: "04", why: "cement/lime for stonework -> External Walls & Cladding" },
  { re: /mastic sealant|silicone sealant/i,  code: "06", why: "sealant to window reveals -> Windows & External Doors" },
  { re: /plasterboard|wallboard/i,           code: "11", why: "plasterboard -> Plastering & Drylining" },
  { re: /gaffer tape/i,                      code: "01", why: "site consumable -> Preliminaries" },
  { re: /pallet charge/i,                    code: "04", why: "credit against a stonework invoice" },
  { re: /lintel/i,                           code: "04", why: "lintel credit -> External Walls & Cladding" },
  { re: /polyguard pipe coil/i,              code: "09", why: "pipe coil credit -> Plumbing & Heating" },
]

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  const { rows: pkgs } = await c.query(`SELECT id, code, name FROM cost_packages WHERE project_id=1`)
  const byCode = new Map(pkgs.map((p) => [p.code, p]))
  const { rows } = await c.query(`
    SELECT li.id, li.description, li.line_net FROM invoice_line_items li
      JOIN invoices i ON i.id = li.invoice_id
     WHERE i.status='confirmed' AND li.cost_package_id IS NULL ORDER BY li.line_net DESC`)
  let done = 0, missed = 0
  for (const r of rows) {
    const rule = RULES.find((x) => x.re.test(r.description))
    if (!rule) { missed++; console.log(`  ? UNMATCHED ${r.description.slice(0,60)}`); continue }
    const pkg = byCode.get(rule.code)
    if (EXECUTE) await c.query(`UPDATE invoice_line_items SET cost_package_id=$1 WHERE id=$2`, [pkg.id, r.id])
    console.log(`  £${Number(r.line_net).toFixed(2).padStart(9)} -> ${pkg.name.padEnd(30)} ${rule.why}`)
    done++
  }
  console.log(`\n  classified ${done}, unmatched ${missed}`)
  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("  DRY RUN.") }
  else { await c.query("COMMIT"); console.log("  COMMITTED.") }
} catch (e) { await c.query("ROLLBACK"); console.error("rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
