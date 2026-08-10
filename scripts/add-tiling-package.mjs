import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  // 1) Snapshot existing Higher Farm packages BEFORE (to prove no renumber).
  const before = (
    await pool.query("SELECT code, name FROM cost_packages WHERE project_id=1 ORDER BY code")
  ).rows

  // 2) Idempotently add the new trade-first package as the next number (20).
  await pool.query(
    `INSERT INTO cost_packages (project_id, code, name)
     SELECT 1, '20', 'Tiling & Splashbacks'
     WHERE NOT EXISTS (SELECT 1 FROM cost_packages WHERE project_id=1 AND code='20')`,
  )
  const tile = (
    await pool.query("SELECT id, code, name FROM cost_packages WHERE project_id=1 AND code='20'")
  ).rows[0]

  // 3) Map the Goldentree "Tiling & Splashbacks" line to package 20 for roll-up.
  //    The lender allowance is NEVER touched.
  const l4 = (
    await pool.query(
      "SELECT id, description, original_amount FROM funding_budget_lines WHERE funding_budget_id=1 AND description ILIKE $1",
      ["%Tiling & Splashbacks%"],
    )
  ).rows[0]
  await pool.query(
    `INSERT INTO funding_line_package_map (funding_budget_line_id, cost_package_id, weight)
     SELECT $1,$2,NULL
     WHERE NOT EXISTS (SELECT 1 FROM funding_line_package_map WHERE funding_budget_line_id=$1 AND cost_package_id=$2)`,
    [l4.id, tile.id],
  )
  await pool.query("UPDATE funding_budget_lines SET notes=$2 WHERE id=$1", [
    l4.id,
    "User-directed: maps to new trade-first package 20 Tiling & Splashbacks (all wall/floor tiling + splashbacks, any room). Allowance kept whole; actuals roll up.",
  ])

  // 4) Verify AFTER.
  const after = (
    await pool.query("SELECT code, name FROM cost_packages WHERE project_id=1 ORDER BY code")
  ).rows
  const map = (
    await pool.query(
      "SELECT p.code, p.name FROM funding_line_package_map m JOIN cost_packages p ON p.id=m.cost_package_id WHERE m.funding_budget_line_id=$1",
      [l4.id],
    )
  ).rows
  const existingAfter = after.filter((p) => p.code !== "20")
  const altered = JSON.stringify(before) !== JSON.stringify(existingAfter)

  console.log("EXISTING PACKAGES 01-19 ALTERED/RENUMBERED?:", altered)
  console.log("NEW PACKAGE:", JSON.stringify(tile))
  console.log(
    "LINE4:",
    l4.description,
    "| allowance",
    l4.original_amount,
    "(unchanged) | mapped:",
    JSON.stringify(map),
  )
  console.log("TOTAL HF PACKAGES:", after.length)

  // 5) Next undecided works line (line 5 of 12).
  const nxt = (
    await pool.query(
      `SELECT id, position, description, original_amount FROM funding_budget_lines
       WHERE funding_budget_id=1 AND section='works'
       AND NOT EXISTS (SELECT 1 FROM funding_line_package_map m WHERE m.funding_budget_line_id=funding_budget_lines.id)
       AND notes IS NULL ORDER BY position LIMIT 3`,
    )
  ).rows
  console.log("NEXT UNMAPPED (no decision yet):", JSON.stringify(nxt))

  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
