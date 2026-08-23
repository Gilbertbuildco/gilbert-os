import "server-only"
import { pool } from "../db"
import { EXTRA_CATEGORIES } from "./line-groups"

/**
 * Spend for the owner's extra Funding-vs-Actual categories, taken from the cost
 * packages that reach no lender line. Counts every confirmed invoice, matching
 * `actualSpendToDate` on the real funding lines beside it, so the column means
 * the same thing all the way down.
 */
export async function getExtraCategorySpend(projectId: number): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const e of EXTRA_CATEGORIES) {
    const { rows: [r] } = await pool.query(
      `SELECT COALESCE(SUM(li.line_net), 0) AS spend
         FROM invoice_line_items li
         JOIN invoices i ON i.id = li.invoice_id
         JOIN cost_packages cp ON cp.id = li.cost_package_id
        WHERE i.status = 'confirmed' AND i.project_id = $1 AND cp.code = ANY($2)`,
      [projectId, e.packageCodes])
    out.set(e.key, Number(r.spend))
  }
  return out
}
