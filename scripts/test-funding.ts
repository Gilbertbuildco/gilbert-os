/**
 * Phase 2A verification suite.
 *  - Pure engine unit tests (no DB).
 *  - DB integration on a THROWAWAY project that is deleted afterwards.
 * Higher Farm and all real data are never modified.
 */
import { Pool } from "pg"
import {
  apportionSpend,
  computeLine,
  computeLines,
  computeProject,
  reconcileToControls,
  round2,
  type FundingLineInput,
  type PackageSpendInput,
  type MappingInput,
} from "../lib/funding/calculations.ts"

let pass = 0
let fail = 0
const approx = (a: number, b: number, t = 0.005) => Math.abs(a - b) <= t
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}`, extra ?? "")
  }
}

console.log("\n--- A. Apportionment ---")
{
  const lines: FundingLineInput[] = [
    { id: 1, section: "works", description: "Roof structure", originalAmount: 20000 },
    { id: 2, section: "works", description: "Roof coverings", originalAmount: 60000 },
    { id: 3, section: "works", description: "Groundworks", originalAmount: 50000 },
  ]
  // pkg 100 -> line 3 (single); pkg 200 -> lines 1 & 2 (multi, budget-weighted 20k:60k)
  const pkgs: PackageSpendInput[] = [
    { costPackageId: 100, actualSpend: 5000 },
    { costPackageId: 200, actualSpend: 8000 },
  ]
  const maps: MappingInput[] = [
    { fundingBudgetLineId: 3, costPackageId: 100 },
    { fundingBudgetLineId: 1, costPackageId: 200 },
    { fundingBudgetLineId: 2, costPackageId: 200 },
  ]
  const { byLine, unmapped } = apportionSpend(lines, pkgs, maps)
  check("single-map full spend to line 3", approx(byLine.get(3)!, 5000))
  check("multi-map budget-weighted line 1 = 2000", approx(byLine.get(1)!, 2000), byLine.get(1))
  check("multi-map budget-weighted line 2 = 6000", approx(byLine.get(2)!, 6000), byLine.get(2))
  check("no unmapped spend", approx(unmapped, 0))
}
{
  // explicit weights override budget proportion
  const lines: FundingLineInput[] = [
    { id: 1, section: "works", description: "A", originalAmount: 100 },
    { id: 2, section: "works", description: "B", originalAmount: 100 },
  ]
  const { byLine } = apportionSpend(
    lines,
    [{ costPackageId: 9, actualSpend: 1000 }],
    [
      { fundingBudgetLineId: 1, costPackageId: 9, weight: 3 },
      { fundingBudgetLineId: 2, costPackageId: 9, weight: 1 },
    ],
  )
  check("weighted split 75/25 -> 750", approx(byLine.get(1)!, 750), byLine.get(1))
  check("weighted split 75/25 -> 250", approx(byLine.get(2)!, 250), byLine.get(2))
}
{
  // unmapped package spend is reported, never lost
  const lines: FundingLineInput[] = [{ id: 1, section: "works", description: "A", originalAmount: 100 }]
  const { unmapped } = apportionSpend(lines, [{ costPackageId: 500, actualSpend: 1234.56 }], [])
  check("unmapped spend surfaced = 1234.56", approx(unmapped, 1234.56), unmapped)
}

console.log("\n--- B. Variance (favourable / adverse) ---")
{
  const fav = computeLine({ id: 1, section: "works", description: "x", originalAmount: 25767.62 }, 18000, 0)
  check("favourable variance = 7767.62", approx(fav.varianceAmount, 7767.62), fav.varianceAmount)
  check("favourable flag true", fav.favourable === true)
  check("variance % ~30.14", approx(fav.variancePct!, 30.14, 0.01), fav.variancePct)

  const adv = computeLine({ id: 2, section: "works", description: "y", originalAmount: 25767.62 }, 30000, 0)
  check("adverse variance = -4232.38", approx(adv.varianceAmount, -4232.38), adv.varianceAmount)
  check("adverse flag false", adv.favourable === false)
}
{
  const zero = computeLine({ id: 3, section: "works", description: "z", originalAmount: 0 }, 500, 0)
  check("zero-budget variance % is null", zero.variancePct === null)
}

console.log("\n--- C. Forecast ---")
{
  const noF = computeLine({ id: 1, section: "works", description: "x", originalAmount: 10000 }, 4000, 0)
  check("no forecast -> final = spend so far", approx(noF.forecastFinalCost, 4000))
  check("no forecast -> hasForecast false", noF.hasForecast === false)
  check("no forecast -> final variance 6000", approx(noF.forecastFinalVariance, 6000))

  const withF = computeLine({ id: 2, section: "works", description: "y", originalAmount: 10000, forecastToComplete: 7000 }, 4000, 0)
  check("forecast final = 4000+7000 = 11000", approx(withF.forecastFinalCost, 11000))
  check("forecast final variance = -1000 (adverse forecast)", approx(withF.forecastFinalVariance, -1000))
}

console.log("\n--- D. Drawdown (completion-driven, not spend-driven) ---")
{
  const l = computeLine(
    { id: 1, section: "works", description: "x", originalAmount: 20000 },
    8000, // actual spend
    0,
    { fundingBudgetLineId: 1, workCompletePct: 50, fundingDrawn: 12000, fundingCertified: 10000 },
  )
  check("funding earned = 50% of allowance = 10000 (NOT spend)", approx(l.fundingEarned!, 10000), l.fundingEarned)
  check("funding remaining = 20000-12000 = 8000", approx(l.fundingRemaining!, 8000))
  check("funded ahead of cost = 12000-8000 = 4000", approx(l.amountFundedAheadOfCost!, 4000))
  check("spent not yet funded = 0", approx(l.amountSpentNotYetFunded!, 0))
  check("earned != spend (10000 vs 8000)", l.fundingEarned !== l.actualSpendToDate)
}

console.log("\n--- E. Project rollup ---")
{
  const lines: FundingLineInput[] = [
    { id: 1, section: "works", description: "W1", originalAmount: 70000 },
    { id: 2, section: "works", description: "W2", originalAmount: 30000 },
    { id: 3, section: "professional_fees", description: "PF1", originalAmount: 10000 },
  ]
  const pkgs: PackageSpendInput[] = [
    { costPackageId: 1, actualSpend: 40000 },
    { costPackageId: 2, actualSpend: 5000 },
  ]
  const maps: MappingInput[] = [
    { fundingBudgetLineId: 1, costPackageId: 1 },
    { fundingBudgetLineId: 3, costPackageId: 2 },
  ]
  const { lines: lr, unmappedSpend } = computeLines(lines, pkgs, maps)
  const proj = computeProject(lr, unmappedSpend, 45000)
  check("works budget = 100000", approx(proj.totalWorksBudget, 100000))
  check("prof fees budget = 10000", approx(proj.totalProfessionalFeesBudget, 10000))
  check("total funding = 110000", approx(proj.totalFundingBudget, 110000))
  check("mapped spend = 45000", approx(proj.totalActualSpendMapped, 45000), proj.totalActualSpendMapped)
  check("favourable variance = 110000-45000 = 65000", approx(proj.favourableFundingVariance, 65000))
  check("variance label favourable", proj.varianceLabel === "favourable")
}

console.log("\n--- F. Reconciliation against control totals ---")
{
  const good: FundingLineInput[] = [
    { id: 1, section: "works", description: "a", originalAmount: 1078217.24 },
    { id: 2, section: "professional_fees", description: "b", originalAmount: 46377.71 },
  ]
  const r = reconcileToControls(good, {
    worksTotal: 1078217.24,
    professionalFeesTotal: 46377.71,
    originalTotal: 1124594.95,
  })
  check("exact schedule reconciles OK", r.ok === true, r.checks)

  const bad: FundingLineInput[] = [
    { id: 1, section: "works", description: "a", originalAmount: 1078000.0 },
    { id: 2, section: "professional_fees", description: "b", originalAmount: 46377.71 },
  ]
  const r2 = reconcileToControls(bad, {
    worksTotal: 1078217.24,
    professionalFeesTotal: 46377.71,
    originalTotal: 1124594.95,
  })
  check("discrepancy is flagged (not silently corrected)", r2.ok === false)
  check("works diff reported ~ -217.24", approx(r2.checks[0].diff!, -217.24, 0.01), r2.checks[0].diff)
}

// ------------------------------------------------------------------ DB test
console.log("\n--- G-J. DB integration (throwaway project) ---")
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const slug = `zz-test-funding-${Date.now()}`
let projectId: number | null = null
try {
  const hfBefore = await pool.query(
    `SELECT (SELECT COUNT(*) FROM funding_budgets WHERE project_id=1) fb,
            (SELECT COUNT(*) FROM invoice_line_items li JOIN invoices i ON i.id=li.invoice_id WHERE i.project_id=1) li`,
  )

  const p = await pool.query(
    `INSERT INTO projects (slug, name, status) VALUES ($1,'ZZ Test Funding','On Site') RETURNING id`,
    [slug],
  )
  projectId = p.rows[0].id

  const cp1 = (await pool.query(`INSERT INTO cost_packages (project_id, code, name) VALUES ($1,'05','Roofing') RETURNING id`, [projectId])).rows[0].id
  const cp2 = (await pool.query(`INSERT INTO cost_packages (project_id, code, name) VALUES ($1,'02','Groundworks') RETURNING id`, [projectId])).rows[0].id

  const fb = (await pool.query(
    `INSERT INTO funding_budgets (project_id, name, lender, works_total, professional_fees_total, original_total, amount_to_borrow)
     VALUES ($1,'Test Budget','Test Lender',90000,10000,100000,100000) RETURNING id`,
    [projectId],
  )).rows[0].id

  const lRoofStruct = (await pool.query(`INSERT INTO funding_budget_lines (funding_budget_id, section, description, original_amount, cost_package_code, position) VALUES ($1,'works','Roof Structure',40000,'05',0) RETURNING id`, [fb])).rows[0].id
  const lRoofCover = (await pool.query(`INSERT INTO funding_budget_lines (funding_budget_id, section, description, original_amount, cost_package_code, position) VALUES ($1,'works','Roof Coverings',20000,'05',1) RETURNING id`, [fb])).rows[0].id
  const lGround = (await pool.query(`INSERT INTO funding_budget_lines (funding_budget_id, section, description, original_amount, cost_package_code, position) VALUES ($1,'works','Groundworks',30000,'02',2) RETURNING id`, [fb])).rows[0].id
  const lPf = (await pool.query(`INSERT INTO funding_budget_lines (funding_budget_id, section, description, original_amount, position) VALUES ($1,'professional_fees','Architect',10000,3) RETURNING id`, [fb])).rows[0].id

  // Roofing package (cp1) funds BOTH roof lines -> apportion by 40k:20k. Groundworks single.
  await pool.query(`INSERT INTO funding_line_package_map (funding_budget_line_id, cost_package_id) VALUES ($1,$2),($3,$2),($4,$5)`, [lRoofStruct, cp1, lRoofCover, lGround, cp2])

  // One invoice with two lines against roofing (net 6000) + groundworks (net 5000), then a credit -1000 on roofing.
  const inv = (await pool.query(`INSERT INTO invoices (supplier_id, project_id, invoice_number, transaction_type, net, vat, gross, status) VALUES (0,$1,'T-1','invoice',11000,2200,13200,'confirmed') RETURNING id`, [projectId])).rows[0].id
  await pool.query(`INSERT INTO invoice_line_items (invoice_id, cost_package_id, description, line_net, line_vat, line_gross, cost_type) VALUES ($1,$2,'Tiles',6000,1200,7200,'materials'),($1,$3,'Muck away',5000,1000,6000,'subcontract')`, [inv, cp1, cp2])
  const cr = (await pool.query(`INSERT INTO invoices (supplier_id, project_id, invoice_number, transaction_type, net, vat, gross, status) VALUES (0,$1,'T-1','credit',-1000,-200,-1200,'confirmed') RETURNING id`, [projectId])).rows[0].id
  await pool.query(`INSERT INTO invoice_line_items (invoice_id, cost_package_id, description, line_net, line_vat, line_gross, cost_type) VALUES ($1,$2,'Returned tiles',-1000,-200,-1200,'materials')`, [cr, cp1])

  // Read raw rows and run the real engine (mirrors the query layer).
  const lineRows = (await pool.query(`SELECT id, section, description, original_amount, forecast_to_complete FROM funding_budget_lines WHERE funding_budget_id=$1 ORDER BY position`, [fb])).rows
  const mapRows = (await pool.query(`SELECT funding_budget_line_id, cost_package_id, weight FROM funding_line_package_map m JOIN funding_budget_lines l ON l.id=m.funding_budget_line_id WHERE l.funding_budget_id=$1`, [fb])).rows
  const spendRows = (await pool.query(`SELECT cost_package_id, SUM(line_net) spend FROM invoice_line_items li JOIN invoices i ON i.id=li.invoice_id WHERE i.project_id=$1 AND i.status='confirmed' AND cost_package_id IS NOT NULL GROUP BY cost_package_id`, [projectId])).rows
  const totalActual = Number((await pool.query(`SELECT COALESCE(SUM(net),0) s FROM invoices WHERE project_id=$1 AND status='confirmed'`, [projectId])).rows[0].s)

  const engineLines: FundingLineInput[] = lineRows.map((r: any) => ({ id: r.id, section: r.section, description: r.description, originalAmount: Number(r.original_amount), forecastToComplete: r.forecast_to_complete == null ? null : Number(r.forecast_to_complete) }))
  const engineMaps: MappingInput[] = mapRows.map((r: any) => ({ fundingBudgetLineId: r.funding_budget_line_id, costPackageId: r.cost_package_id, weight: r.weight == null ? null : Number(r.weight) }))
  const enginePkgs: PackageSpendInput[] = spendRows.map((r: any) => ({ costPackageId: r.cost_package_id, actualSpend: Number(r.spend) }))

  const { lines: lr, unmappedSpend } = computeLines(engineLines, enginePkgs, engineMaps)
  const proj = computeProject(lr, unmappedSpend, totalActual)
  const byId = new Map(lr.map((l) => [l.lineId, l]))

  // Roofing net after credit = 6000-1000 = 5000; split 40k:20k => 3333.33 / 1666.67
  check("G. credit reduced roofing spend to 5000 total", approx(byId.get(lRoofStruct)!.actualSpendToDate + byId.get(lRoofCover)!.actualSpendToDate, 5000), [byId.get(lRoofStruct)?.actualSpendToDate, byId.get(lRoofCover)?.actualSpendToDate])
  check("G. roof structure apportioned = 3333.33", approx(byId.get(lRoofStruct)!.actualSpendToDate, 3333.33, 0.01), byId.get(lRoofStruct)?.actualSpendToDate)
  check("G. roof coverings apportioned = 1666.67", approx(byId.get(lRoofCover)!.actualSpendToDate, 1666.67, 0.01), byId.get(lRoofCover)?.actualSpendToDate)
  check("H. groundworks single-map spend = 5000", approx(byId.get(lGround)!.actualSpendToDate, 5000))
  check("H. professional-fee line has no spend", approx(byId.get(lPf)!.actualSpendToDate, 0))
  check("I. total mapped spend = 10000 (11000 - 1000 credit)", approx(proj.totalActualSpendMapped, 10000), proj.totalActualSpendMapped)
  check("I. total actual (all) = 10000", approx(proj.totalActualSpendAll, 10000))
  check("I. favourable variance = 100000 - 10000 = 90000", approx(proj.favourableFundingVariance, 90000))
  check("I. works budget = 90000, prof = 10000", approx(proj.totalWorksBudget, 90000) && approx(proj.totalProfessionalFeesBudget, 10000))
  check("I. no unmapped spend", approx(proj.totalUnmappedSpend, 0))

  // J. Higher Farm untouched during the whole test.
  const hfAfter = await pool.query(
    `SELECT (SELECT COUNT(*) FROM funding_budgets WHERE project_id=1) fb,
            (SELECT COUNT(*) FROM invoice_line_items li JOIN invoices i ON i.id=li.invoice_id WHERE i.project_id=1) li`,
  )
  check("J. Higher Farm funding_budgets count unchanged", hfBefore.rows[0].fb === hfAfter.rows[0].fb, [hfBefore.rows[0].fb, hfAfter.rows[0].fb])
  check("J. Higher Farm invoice lines count unchanged", hfBefore.rows[0].li === hfAfter.rows[0].li)
} finally {
  // Tear down ALL throwaway data.
  if (projectId != null) {
    await pool.query(`DELETE FROM funding_line_package_map WHERE funding_budget_line_id IN (SELECT id FROM funding_budget_lines WHERE funding_budget_id IN (SELECT id FROM funding_budgets WHERE project_id=$1))`, [projectId])
    await pool.query(`DELETE FROM funding_drawdowns WHERE funding_budget_line_id IN (SELECT id FROM funding_budget_lines WHERE funding_budget_id IN (SELECT id FROM funding_budgets WHERE project_id=$1))`, [projectId])
    await pool.query(`DELETE FROM funding_budget_lines WHERE funding_budget_id IN (SELECT id FROM funding_budgets WHERE project_id=$1)`, [projectId])
    await pool.query(`DELETE FROM funding_budgets WHERE project_id=$1`, [projectId])
    await pool.query(`DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE project_id=$1)`, [projectId])
    await pool.query(`DELETE FROM invoices WHERE project_id=$1`, [projectId])
    await pool.query(`DELETE FROM cost_packages WHERE project_id=$1`, [projectId])
    await pool.query(`DELETE FROM projects WHERE id=$1`, [projectId])
    console.log("\nThrowaway test data removed.")
  }
  await pool.end()
}

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`)
process.exit(fail === 0 ? 0 : 1)
