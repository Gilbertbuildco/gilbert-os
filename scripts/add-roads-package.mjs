import { Pool } from "pg"
import { looksLikeRoadsInfrastructure } from "../lib/cost-plan.ts"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  // 1) Add "21 · Roads & Infrastructure" to EVERY project that uses the standard
  //    plan (project-agnostic), idempotently. New projects get it via the cost
  //    plan seed; this backfills existing ones.
  const projects = (await pool.query("SELECT id, name FROM projects ORDER BY id")).rows
  for (const p of projects) {
    await pool.query(
      `INSERT INTO cost_packages (project_id, code, name)
       SELECT $1, '21', 'Roads & Infrastructure'
       WHERE NOT EXISTS (SELECT 1 FROM cost_packages WHERE project_id = $1 AND code = '21')`,
      [p.id],
    )
  }
  const added = (
    await pool.query(
      "SELECT project_id, id, code, name FROM cost_packages WHERE code = '21' ORDER BY project_id",
    )
  ).rows
  console.log("Package 21 present on projects:", JSON.stringify(added))

  // 2) Map the Higher Farm Goldentree "Adoptable Highway" line -> package 21.
  //    Allowance & position untouched.
  const pkg21hf = added.find((r) => r.project_id === 1)
  const line = (
    await pool.query(
      "SELECT id, description, original_amount FROM funding_budget_lines WHERE funding_budget_id = 1 AND description ILIKE $1",
      ["%Adoptable Highway%"],
    )
  ).rows[0]
  await pool.query(
    `INSERT INTO funding_line_package_map (funding_budget_line_id, cost_package_id, weight)
     SELECT $1, $2, NULL
     WHERE NOT EXISTS (SELECT 1 FROM funding_line_package_map WHERE funding_budget_line_id = $1 AND cost_package_id = $2)`,
    [line.id, pkg21hf.id],
  )
  await pool.query("UPDATE funding_budget_lines SET notes = $2 WHERE id = $1", [
    line.id,
    "User-directed: maps to new project-agnostic package 21 Roads & Infrastructure (adoptable highway construction, road formation/sub-base, kerbs, surfacing, and highway drainage forming part of the adoptable works). Allowance kept whole; actuals roll up. Plot drainage stays 18; landscaping/paving stays 17.",
  ])
  console.log(
    `Mapped line "${line.description}" (£${line.original_amount}, unchanged) -> project 1 package 21 (id ${pkg21hf.id})`,
  )

  // 3) Scan EXISTING confirmed invoice lines for highway evidence. Do NOT
  //    auto-reclassify unless the evidence is strong; otherwise FLAG for review.
  const lines = (
    await pool.query(
      `SELECT ili.id, ili.description, ili.cost_package_id, cp.code AS current_code, cp.name AS current_name,
              i.supplier_id, s.name AS supplier
       FROM invoice_line_items ili
       JOIN invoices i ON i.id = ili.invoice_id
       LEFT JOIN cost_packages cp ON cp.id = ili.cost_package_id
       LEFT JOIN suppliers s ON s.id = i.supplier_id
       WHERE i.project_id = 1 AND i.status = 'confirmed'`,
    )
  ).rows

  const strong = /\b(adoptable|highway|carriageway|s38|section\s*38|tarmac|tarmacadam|asphalt|kerb|kerbs|kerbing|road\s*(construction|formation|sub[-\s]?base|base\s*course|surfac))\b/i

  const hits = []
  for (const l of lines) {
    const text = l.description ?? ""
    if (looksLikeRoadsInfrastructure(text)) {
      hits.push({
        id: l.id,
        supplier: l.supplier,
        current: `${l.current_code ?? "-"} ${l.current_name ?? "(unclassified)"}`,
        strongEvidence: strong.test(text),
        description: text.slice(0, 90),
      })
    }
  }

  console.log(`\nExisting invoice lines matching roads/highway heuristic: ${hits.length}`)
  for (const h of hits) {
    console.log(
      `${h.strongEvidence ? "STRONG" : "AMBIG "} | line ${h.id} | now: ${h.current} | ${h.supplier} | ${h.description}`,
    )
  }
  if (hits.length === 0) {
    console.log("None. No existing Higher Farm invoice line looks like adoptable-highway work — nothing to reclassify or flag.")
  }

  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
