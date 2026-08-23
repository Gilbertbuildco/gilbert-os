/**
 * Map the £109,639.27 of confirmed spend that reached no funding line.
 *
 * Until now five build-cost packages had no `funding_line_package_map` edge at
 * all, so their spend vanished from every per-line figure — making each line's
 * "left" look more generous than it is.
 *
 * WEIGHTS, NOT PROPORTIONS. Where a package covers two lender lines the split
 * is set by weight to the actual invoice values, not left to the engine's
 * default amount-proportion share. Utilities holds £23,134.86 of electricity
 * and £6,065.00 of water; splitting that by budget proportion would put water
 * spend on the electricity line. The weights make the apportionment match the
 * documents (non-negotiable #8: no spend double-counted, none misattributed).
 *
 * GEORGE WILSON'S £56,000 IS DELIBERATELY NOT MAPPED. There is no site-
 * management line in the lender's schedule, and the candidates — Preliminaries
 * (already £13,177 over) or professional fees — are a judgement about the
 * lender baseline that belongs to the owner, not to this script.
 *
 * Idempotent. Dry-run by default.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
for (const l of readFileSync("/Users/tomgilbert/GilbertOS/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const EXECUTE = process.argv.includes("--execute")

// package code -> [{ line description regex, weight = the real invoice value }]
const MAP = [
  { pkg: "23", name: "Utilities & Service Connections", to: [
      { line: /mains electricity supplies/i, weight: 23134.86, why: "SSE £19,089.72 + £4,045.14 underground line" },
      { line: /mains water supplies/i,       weight: 6065.00,  why: "Wessex Water £6,065.00" } ] },
  { pkg: "25", name: "Building Control & Warranty", to: [
      { line: /third party home warranty/i,  weight: 16544.00, why: "Protek warranty £16,544.00" },
      { line: /building regulations fees/i,  weight: 2800.00,  why: "Spire Building Control £2,800.00" } ] },
  { pkg: "24", name: "Architectural & Design", to: [
      { line: /structural engineer/i,        weight: 3700.00,  why: "Structural Solutions £3,700.00" } ] },
  { pkg: "07", name: "Internal Walls & Partitions", to: [
      { line: /first fix joinery/i,          weight: 1395.41,  why: "studwork and partitions" } ] },
]

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  for (const m of MAP) {
    const { rows: [pkg] } = await c.query(`SELECT id, name FROM cost_packages WHERE project_id=1 AND code=$1`, [m.pkg])
    if (!pkg) { console.log(`  ! package ${m.pkg} not found`); continue }
    console.log(`\n  [${m.pkg}] ${pkg.name}`)
    for (const t of m.to) {
      const { rows: [line] } = await c.query(
        `SELECT id, description FROM funding_budget_lines WHERE description ~* $1 ORDER BY id LIMIT 1`,
        [t.line.source])
      if (!line) { console.log(`      ! no line matching ${t.line}`); continue }
      const dup = await c.query(
        `SELECT 1 FROM funding_line_package_map WHERE funding_budget_line_id=$1 AND cost_package_id=$2`, [line.id, pkg.id])
      if (dup.rowCount) { console.log(`      = already mapped -> ${line.description}`); continue }
      if (EXECUTE) await c.query(
        `INSERT INTO funding_line_package_map (funding_budget_line_id, cost_package_id, weight) VALUES ($1,$2,$3)`,
        [line.id, pkg.id, t.weight])
      console.log(`      -> ${String(line.description).slice(0,46).padEnd(47)} weight ${t.weight}  (${t.why})`)
    }
  }
  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("\n  DRY RUN.") }
  else { await c.query("COMMIT"); console.log("\n  COMMITTED.") }
} catch (e) { await c.query("ROLLBACK"); console.error("rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
