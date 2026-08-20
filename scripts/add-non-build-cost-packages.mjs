/**
 * Owner instruction (2026-08-20): add a cost category that is deliberately
 * EXCLUDED from build-cost totals — "Legal & broker fees" — and make sure a
 * rule exists that keeps it out of the build-cost final number.
 *
 * Rationale: brokerage and legal fees are the cost of borrowing and
 * transacting, not the cost of building. Including them inflates build cost
 * and cost-per-sqft, and the lender does not fund them as build cost either.
 *
 * This script:
 *   1. Adds `cost_packages.is_build_cost boolean NOT NULL DEFAULT true`
 *      (idempotent — existing 21 packages stay true, which is correct).
 *   2. Idempotently inserts package '22 · Legal & broker fees' for project 1
 *      with is_build_cost = false. Does NOT touch any other project, and
 *      does NOT add this package to the project-agnostic STANDARD_COST_PLAN
 *      (lib/cost-plan.ts) — this is a project-1-specific data change, not a
 *      change to how every future project is seeded.
 *   3. Never renumbers or alters any existing package — codes 01-21 are
 *      untouched (proven by before/after snapshot below).
 *
 * The exclusion itself is enforced entirely in the READ layer
 * (lib/queries.ts, lib/funding/queries.ts) — this migration only adds the
 * flag and the one data row. It never touches lib/funding/calculations.ts
 * (which stays pure) or the Goldentree funding schedule (immutable,
 * untouched by this script).
 *
 * Idempotent. Safe to re-run against production — both statements are
 * IF NOT EXISTS / conditional-insert guarded.
 */
import pg from "pg"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  const before = (
    await pool.query("SELECT id, code, name FROM cost_packages WHERE project_id = 1 ORDER BY code, id")
  ).rows

  // 1) Schema: add the column, idempotently. Existing rows default to true.
  await pool.query(`ALTER TABLE cost_packages ADD COLUMN IF NOT EXISTS is_build_cost boolean NOT NULL DEFAULT true`)

  // 2) Data: idempotently insert the new non-build-cost package for project 1.
  await pool.query(
    `INSERT INTO cost_packages (project_id, code, name, is_build_cost)
     SELECT 1, '22', 'Legal & broker fees', false
     WHERE NOT EXISTS (SELECT 1 FROM cost_packages WHERE project_id = 1 AND code = '22')`,
  )

  const after = (
    await pool.query("SELECT id, code, name, is_build_cost FROM cost_packages WHERE project_id = 1 ORDER BY code, id")
  ).rows

  // Compare only codes 01-21 (the pre-existing standard plan) between before
  // and after snapshots — never the whole-table length, which legitimately
  // grows by exactly one row (package 22) the first time this runs and then
  // stays flat on every re-run.
  const originalCodes = ["01","02","03","04","05","06","07","08","09","10","11","12","13","14","15","16","17","18","19","20","21"]
  const pick = (rows) => rows.filter((r) => originalCodes.includes(r.code)).map((r) => ({ code: r.code, name: r.name }))
  const existingAltered = JSON.stringify(pick(before)) !== JSON.stringify(pick(after))
  const pkg22Count = after.filter((r) => r.code === "22").length

  console.log("EXISTING PACKAGES 01-21 ALTERED/RENUMBERED?:", existingAltered)
  console.log("PACKAGE 22 ROW COUNT (must stay 1, proves idempotent insert):", pkg22Count)
  console.log(`PACKAGES BEFORE: ${before.length} | PACKAGES AFTER: ${after.length}`)
  console.log("\nFULL PACKAGE LIST (project 1), with is_build_cost flag:")
  for (const p of after) {
    console.log(`  ${p.code ?? "--"}  ${p.name.padEnd(35)} is_build_cost=${p.is_build_cost}`)
  }

  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
