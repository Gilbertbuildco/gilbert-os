/**
 * Seed the Higher Farm ORIGINAL Goldentree Funding Budget HEADER.
 *
 * Idempotent. Stores ONLY the supplied control totals — it does NOT fabricate
 * any line-level budget values. The individual Goldentree budget lines must be
 * loaded verbatim from the supplied schedule via loadFundingSchedule() once the
 * schedule is available; until then the baseline exists with lines pending.
 *
 * Supplied control totals (source of truth — never altered):
 *   Works total          £1,078,217.24
 *   Professional fees    £46,377.71
 *   Grand total          £1,124,594.95
 *   Amount to borrow     £1,124,595.00   (kept distinct from the grand total)
 */
import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const CONTROLS = {
  worksTotal: 1078217.24,
  professionalFeesTotal: 46377.71,
  originalTotal: 1124594.95,
  amountToBorrow: 1124595.0,
}

const proj = await pool.query(`SELECT id, name FROM projects WHERE slug = 'higher-farm' LIMIT 1`)
if (!proj.rows.length) {
  console.error("Higher Farm project not found — aborting (no data invented).")
  await pool.end()
  process.exit(1)
}
const projectId = proj.rows[0].id

const existing = await pool.query(
  `SELECT id FROM funding_budgets WHERE project_id = $1 AND is_original = true LIMIT 1`,
  [projectId],
)

let budgetId
if (existing.rows.length) {
  budgetId = existing.rows[0].id
  await pool.query(
    `UPDATE funding_budgets SET
       name = $2, lender = $3, status = 'original_locked',
       works_total = $4, professional_fees_total = $5,
       original_total = $6, amount_to_borrow = $7
     WHERE id = $1`,
    [
      budgetId,
      "Goldentree Funding Budget",
      "Goldentree Financial Services",
      CONTROLS.worksTotal,
      CONTROLS.professionalFeesTotal,
      CONTROLS.originalTotal,
      CONTROLS.amountToBorrow,
    ],
  )
  console.log(`Updated existing Higher Farm Goldentree budget header (id=${budgetId}).`)
} else {
  const ins = await pool.query(
    `INSERT INTO funding_budgets
       (project_id, name, lender, status, is_original, works_total,
        professional_fees_total, original_total, amount_to_borrow, reconciled, notes)
     VALUES ($1,$2,$3,'original_locked',true,$4,$5,$6,$7,false,$8)
     RETURNING id`,
    [
      projectId,
      "Goldentree Funding Budget",
      "Goldentree Financial Services",
      CONTROLS.worksTotal,
      CONTROLS.professionalFeesTotal,
      CONTROLS.originalTotal,
      CONTROLS.amountToBorrow,
      "Original funding baseline submitted to Goldentree Financial Services. Line-level schedule pending verbatim import.",
    ],
  )
  budgetId = ins.rows[0].id
  console.log(`Created Higher Farm Goldentree budget header (id=${budgetId}).`)
}

const lineCount = await pool.query(`SELECT COUNT(*)::int AS c FROM funding_budget_lines WHERE funding_budget_id = $1`, [
  budgetId,
])
console.log(`Funding lines currently stored: ${lineCount.rows[0].c} (0 = awaiting supplied schedule).`)

// Confirm existing actual-cost data is intact and still classified (no change).
const spend = await pool.query(
  `SELECT COUNT(*)::int AS lines,
          COALESCE(SUM(line_net),0)::numeric AS net,
          SUM(CASE WHEN cost_package_id IS NOT NULL THEN 1 ELSE 0 END)::int AS classified
   FROM invoice_line_items li JOIN invoices inv ON inv.id = li.invoice_id
   WHERE inv.project_id = $1 AND inv.status = 'confirmed'`,
  [projectId],
)
console.log("Existing actual-cost lines (unchanged):", spend.rows[0])

await pool.end()
