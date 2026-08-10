import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const note =
  "UNRESOLVED (user decision). Utility/service connection cost, NOT domestic electrical installation. " +
  "Do NOT bury under 10 Electrical. Preserve line/value/position exactly. " +
  "Decision deferred: consider a permanent project-agnostic 'Utilities / Service Connections' package (with actual " +
  "spend tagged by utility type: Electricity / Water / Telecoms) once Mains Water and BT/Broadband lines are reviewed. " +
  "No package created yet; no existing classifications changed."

const l8 = (
  await pool.query(
    "SELECT id, description, original_amount, position FROM funding_budget_lines WHERE funding_budget_id=1 AND description ILIKE $1",
    ["%Mains Electricity%"],
  )
).rows[0]

const mapCount = (
  await pool.query("SELECT count(*)::int n FROM funding_line_package_map WHERE funding_budget_line_id=$1", [l8.id])
).rows[0].n

await pool.query("UPDATE funding_budget_lines SET notes=$2 WHERE id=$1", [l8.id, note])

console.log("LINE 8 held UNRESOLVED:", l8.description, "| £" + l8.original_amount, "| pos", l8.position, "| map rows:", mapCount, "(none)")

// Next lines by position for line 9
const nxt = (
  await pool.query(
    `SELECT l.position, l.description, l.original_amount,
       (SELECT string_agg(p.code, ',' ORDER BY p.code) FROM funding_line_package_map m JOIN cost_packages p ON p.id=m.cost_package_id WHERE m.funding_budget_line_id=l.id) AS mapped,
       (l.notes IS NOT NULL) AS has_note
     FROM funding_budget_lines l
     WHERE l.funding_budget_id=1 AND l.section='works' AND l.position > $1
     ORDER BY l.position LIMIT 6`,
    [l8.position],
  )
).rows
console.log("NEXT WORKS LINES:")
for (const r of nxt) console.log(" pos", r.position, "|", r.mapped ? "[" + r.mapped + "]" : r.has_note ? "[NOTE]" : "[NONE]", "| £" + Number(r.original_amount).toLocaleString(), "|", r.description)

const pk = (await pool.query("SELECT code,name FROM cost_packages WHERE project_id=1 ORDER BY code")).rows
console.log("PACKAGES:", JSON.stringify(pk))

await pool.end()
