import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const STREET_LIGHTING_NOTE =
  "User-directed: maps to package 21 Roads & Infrastructure for roll-up, but is a SEPARATE Goldentree line from Adoptable Highway (never merge; both keep original position & allowance). " +
  "Only street/estate LIGHTING infrastructure actuals roll up here — columns, ducting, feeder pillars, connections and related infrastructure. " +
  "Adoptable-highway road-construction actuals roll up against the Adoptable Highway line instead. " +
  "Domestic electrical/lighting for individual houses stays in package 10 Electrical and must NOT roll up here. " +
  "NO-DOUBLE-COUNT: because packages 21 relates to two funding lines (Adoptable Highway + Street Lighting), each package-21 actual cost must be attributed to exactly ONE of those lines by evidence; where ambiguous, DEFER and flag for review rather than counting against both."

async function main() {
  const line = (
    await pool.query(
      "SELECT id, description, original_amount, position FROM funding_budget_lines WHERE funding_budget_id=1 AND description ILIKE $1",
      ["%Street Lighting%"],
    )
  ).rows[0]
  if (!line) throw new Error("Street Lighting line not found")

  const roads = (
    await pool.query("SELECT id, code, name FROM cost_packages WHERE project_id=1 AND code=$1", ["21"])
  ).rows[0]
  if (!roads) throw new Error("Package 21 not found")

  // Idempotent map -> package 21. Allowance & position untouched.
  await pool.query(
    `INSERT INTO funding_line_package_map (funding_budget_line_id, cost_package_id, weight)
     SELECT $1,$2,NULL WHERE NOT EXISTS (
       SELECT 1 FROM funding_line_package_map WHERE funding_budget_line_id=$1 AND cost_package_id=$2)`,
    [line.id, roads.id],
  )
  await pool.query("UPDATE funding_budget_lines SET notes=$2 WHERE id=$1", [line.id, STREET_LIGHTING_NOTE])

  const mapped = (
    await pool.query(
      "SELECT p.code,p.name FROM funding_line_package_map m JOIN cost_packages p ON p.id=m.cost_package_id WHERE m.funding_budget_line_id=$1",
      [line.id],
    )
  ).rows
  console.log("LINE7 saved:", line.description, "| allowance £" + line.original_amount, "| position", line.position, "| mapped:", JSON.stringify(mapped))

  // Show next undecided works line (line 8 of 12)
  const nxt = (
    await pool.query(
      `SELECT id, position, description, original_amount, cost_package_code FROM funding_budget_lines
       WHERE funding_budget_id=1 AND section='works' AND position > $1 ORDER BY position LIMIT 4`,
      [line.position],
    )
  ).rows
  console.log("NEXT WORKS LINES:", JSON.stringify(nxt, null, 1))
  await pool.end()
}
main()
