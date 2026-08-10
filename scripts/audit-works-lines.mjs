import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const rows = (
  await pool.query(`
    SELECT l.position, l.description, l.original_amount,
      (SELECT string_agg(p.code, ',' ORDER BY p.code)
         FROM funding_line_package_map m
         JOIN cost_packages p ON p.id = m.cost_package_id
        WHERE m.funding_budget_line_id = l.id) AS mapped,
      (l.notes IS NOT NULL) AS has_note
    FROM funding_budget_lines l
    WHERE l.funding_budget_id = 1 AND l.section = 'works'
    ORDER BY l.position`)
).rows

for (const r of rows) {
  const status = r.mapped ? `[${r.mapped}]` : r.has_note ? "[NOTE]" : "[NONE]"
  console.log(
    String(r.position).padStart(2),
    status.padEnd(14),
    ("£" + Number(r.original_amount).toLocaleString()).padEnd(14),
    r.description,
  )
}

await pool.end()
