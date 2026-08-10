import { Pool } from "pg"
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const q = async (label, text, params = []) => {
  const r = await pool.query(text, params)
  console.log("\n=== " + label + " (" + r.rows.length + " rows) ===")
  console.table(r.rows)
  return r.rows
}

const pkgs = await q(
  "cost_packages for Higher Farm (id=1)",
  `SELECT cp.id, cp.code, cp.name, cp.original_budget,
     COALESCE(li.committed,0) AS committed, COALESCE(li.cnt,0) AS lines
   FROM cost_packages cp
   LEFT JOIN (SELECT cost_package_id, SUM(line_net) committed, COUNT(*) cnt
              FROM invoice_line_items GROUP BY cost_package_id) li
     ON li.cost_package_id = cp.id
   WHERE cp.project_id = 1 ORDER BY cp.code ASC NULLS LAST, cp.id`,
)

const budgetSum = pkgs.reduce((a, r) => a + Number(r.original_budget || 0), 0)
console.log("SUM of cost_package original_budget for Higher Farm =", budgetSum.toFixed(2))

await q(
  "invoices summary (Higher Farm)",
  `SELECT transaction_type, status, COUNT(*) cnt, SUM(net) net, SUM(vat) vat, SUM(gross) gross
   FROM invoices WHERE project_id = 1 GROUP BY transaction_type, status ORDER BY transaction_type`,
)

await q(
  "invoice_line_items classification coverage (Higher Farm)",
  `SELECT (li.cost_package_id IS NOT NULL) AS classified, COUNT(*) lines, SUM(li.line_net) net
   FROM invoice_line_items li JOIN invoices inv ON inv.id = li.invoice_id
   WHERE inv.project_id = 1 GROUP BY 1`,
)

await q(
  "all projects cost_package counts",
  `SELECT project_id, COUNT(*) pkgs, SUM(CASE WHEN original_budget IS NOT NULL THEN 1 ELSE 0 END) with_budget
   FROM cost_packages GROUP BY project_id ORDER BY project_id`,
)

await q("existing tables", `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`)

await pool.end()
