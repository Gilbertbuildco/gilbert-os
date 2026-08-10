/**
 * Load Higher Farm's Goldentree Funding Budget schedule VERBATIM, reconcile
 * against the supplied control totals, apply only confident cost-package
 * mappings (flagging the rest), then run the existing confirmed invoice actuals
 * through the mapping and print the full reconciliation + variance report.
 *
 * Guarantees, per the source-of-truth rules:
 *   - Descriptions and amounts are inserted exactly as supplied.
 *   - No line is merged; no amount is altered to force reconciliation.
 *   - No invoice record is created, modified, deleted or re-imported.
 *   - Ambiguous mappings are flagged for human decision, never invented.
 *
 * Idempotent: re-running replaces this budget's lines + mappings only.
 */
import { Pool } from "pg"
import {
  reconcileToControls,
  apportionSpend,
  computeLines,
  computeProject,
  round2,
  type FundingLineInput,
  type PackageSpendInput,
  type MappingInput,
} from "../lib/funding/calculations.ts"

type Row = {
  section: "works" | "professional_fees"
  description: string
  amount: number
  map: string | null // cost package code, only when confident
  flag?: string // reason a mapping needs a human decision
}

// ── VERBATIM Goldentree schedule ──────────────────────────────────────────
// Descriptions and amounts exactly as supplied. `map` is filled ONLY where the
// Gilbert OS package is unambiguous; otherwise `flag` records why it needs a
// decision. Professional fees intentionally carry no build-package mapping.
const SCHEDULE: Row[] = [
  // WORKS
  { section: "works", description: "Preliminaries", amount: 110108.0, map: "01" },
  { section: "works", description: "Plot Drainage (Below Ground)", amount: 24800.0, map: "18" },
  { section: "works", description: "Foundations", amount: 49602.97, map: "02" },
  { section: "works", description: "Ground Floor Block and Beam", amount: 22000.0, map: "02" },
  { section: "works", description: "Sub Structure Brickwork", amount: 25000.0, map: null, flag: "Below-DPC brickwork sits between Groundworks & Foundations (02) and External Walls & Cladding (04)." },
  { section: "works", description: "Superstructure Brickwork/Timber frame and roof structure", amount: 227000.0, map: null, flag: "Single £227k lender line spans Superstructure-Frame (03), External Walls & Cladding (04) and Roofing (05). Needs a split decision." },
  { section: "works", description: "Intermediate Floors (Included in super structure)", amount: 0.0, map: "03" },
  { section: "works", description: "Roof Structure", amount: 27000.0, map: null, flag: "Roof structure could map to Superstructure-Frame (03) or Roofing (05)." },
  { section: "works", description: "Roof Coverings, Valleys/Box Gutters & Flashings", amount: 32576.25, map: "05" },
  { section: "works", description: "Fascias, Soffits and RWGs", amount: 10258.48, map: "05" },
  { section: "works", description: "Windows", amount: 56427.65, map: "06" },
  { section: "works", description: "External Door", amount: 20323.23, map: "06" },
  { section: "works", description: "Insulation (to studwork/framing and loft)", amount: 25767.62, map: "19" },
  { section: "works", description: "Plastering", amount: 36799.75, map: "11" },
  { section: "works", description: "First Fix Electrical", amount: 33582.0, map: "10" },
  { section: "works", description: "Second Fix Electrical (Included in)", amount: 0.0, map: "10" },
  { section: "works", description: "First Fix Plumbing", amount: 40848.35, map: "09" },
  { section: "works", description: "Second Fix Plumbing", amount: 14329.92, map: "09" },
  { section: "works", description: "Gas Central Heating (Boiler and Radiators)", amount: 8206.78, map: "09" },
  { section: "works", description: "First Fix Joinery (studwork and Door Frames etc.)", amount: 15788.57, map: "08" },
  { section: "works", description: "Second Fix Joinery (Stairs, Skirtings, Architraves, Cills, Internal door etc.)", amount: 44106.89, map: "12" },
  { section: "works", description: "Internal Doors & Ironmongery", amount: 4787.29, map: "12" },
  { section: "works", description: "Kitchen Cabinets & Worktops", amount: 60788.81, map: "13" },
  { section: "works", description: "Appliances", amount: 11838.99, map: "13" },
  { section: "works", description: "Tiling & Splashbacks (kitchen, Bathroom, En-Suite WC etc)", amount: 19371.93, map: null, flag: "Wall tiling/splashbacks straddle Bathrooms & Sanitaryware (14) and Flooring (16)." },
  { section: "works", description: "Sanitaryware (including shower trays, vanity and taps etc)", amount: 10463.65, map: "14" },
  { section: "works", description: "Internal Decoration", amount: 27309.41, map: "15" },
  { section: "works", description: "Floorcoverings Tiling & Splashbacks (Kitchen, Bathroom, En-Suite, etc.)", amount: 17309.41, map: "16" },
  { section: "works", description: "Garages & Outbuildings (included in main build costs)", amount: 0.0, map: null, flag: "No dedicated Gilbert OS package; £0 line (absorbed in main build)." },
  { section: "works", description: "Hard Landscaping (Pavings, Driveways and Patios etc)", amount: 12325.65, map: "17" },
  { section: "works", description: "Soft Landscaping", amount: 6772.3, map: "17" },
  { section: "works", description: "Boundaries (Walls, Fencing and Gates)", amount: 18431.3, map: "17" },
  { section: "works", description: "Adoptable Highway - Construction Cost", amount: 26032.89, map: null, flag: "No highways/roads package; nearest is External Works & Landscaping (17)." },
  { section: "works", description: "Street Lighting - Construction Cost", amount: 6042.46, map: null, flag: "Street lighting could map to Electrical (10) or External Works & Landscaping (17)." },
  { section: "works", description: "Mains Electricity Supplies and Metering", amount: 19089.72, map: null, flag: "Utility supply/metering — Electrical (10) vs a utilities/external-works home." },
  { section: "works", description: "Air/Ground Source Heat Pump", amount: 15000.0, map: "09" },
  { section: "works", description: "Solar Panels", amount: 14799.09, map: null, flag: "Renewables — Electrical (10) vs Roofing (05, roof-mounted)." },
  { section: "works", description: "Mains Water Supplies & Metering", amount: 6065.0, map: null, flag: "Utility supply — Plumbing & Heating (09) vs Drainage (18)." },
  { section: "works", description: "BT and Broadband", amount: 2959.82, map: null, flag: "No telecoms/utilities package in the standard plan." },
  { section: "works", description: "Septic Tank", amount: 15866.06, map: "18" },
  { section: "works", description: "Contingency", amount: 58437.0, map: null, flag: "Contingency is not a build cost package — deliberately left unmapped." },
  // PROFESSIONAL FEES (no build-package mapping by design)
  { section: "professional_fees", description: "Planning Application Fees", amount: 5000.0, map: null },
  { section: "professional_fees", description: "Building Regulations Fees", amount: 3602.02, map: null },
  { section: "professional_fees", description: "SAP & EPC Fees", amount: 2000.0, map: null },
  { section: "professional_fees", description: "Architect", amount: 6894.71, map: null },
  { section: "professional_fees", description: "Insurances", amount: 5510.0, map: null },
  { section: "professional_fees", description: "Structural Engineer", amount: 6826.31, map: null },
  { section: "professional_fees", description: "Third Party Home Warranty or PCC", amount: 16544.67, map: null },
]

const PROJECT_ID = 1
const gbp = (v: number) => "£" + v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  // Resolve the locked Goldentree budget + this project's cost packages.
  const budgetRes = await pool.query(
    `SELECT id, works_total, professional_fees_total, original_total, amount_to_borrow, status
     FROM funding_budgets WHERE project_id = $1 AND is_original = true ORDER BY created_at ASC LIMIT 1`,
    [PROJECT_ID],
  )
  if (budgetRes.rows.length === 0) throw new Error("No original funding budget for Higher Farm — run seed-higher-farm-funding first.")
  const budget = budgetRes.rows[0]
  const budgetId = budget.id

  const pkgRes = await pool.query(`SELECT id, code, name FROM cost_packages WHERE project_id = $1 ORDER BY code`, [PROJECT_ID])
  const pkgByCode = new Map<string, { id: number; name: string }>()
  for (const p of pkgRes.rows) pkgByCode.set(p.code, { id: p.id, name: p.name })

  // ── Load verbatim (idempotent) ──────────────────────────────────────────
  const client = await pool.connect()
  const lineIdByIndex: number[] = []
  try {
    await client.query("BEGIN")
    await client.query(
      `DELETE FROM funding_line_package_map WHERE funding_budget_line_id IN
        (SELECT id FROM funding_budget_lines WHERE funding_budget_id = $1)`,
      [budgetId],
    )
    await client.query(`DELETE FROM funding_budget_lines WHERE funding_budget_id = $1`, [budgetId])

    for (let i = 0; i < SCHEDULE.length; i++) {
      const row = SCHEDULE[i]
      const ins = await client.query(
        `INSERT INTO funding_budget_lines
          (funding_budget_id, section, description, original_amount, cost_package_code, notes, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [budgetId, row.section, row.description, row.amount.toFixed(2), row.map, row.flag ?? null, i],
      )
      lineIdByIndex[i] = ins.rows[0].id
    }

    // Confident mappings only.
    let mapped = 0
    for (let i = 0; i < SCHEDULE.length; i++) {
      const row = SCHEDULE[i]
      if (!row.map) continue
      const pkg = pkgByCode.get(row.map)
      if (!pkg) throw new Error(`Cost package code ${row.map} not found for project ${PROJECT_ID}`)
      await client.query(
        `INSERT INTO funding_line_package_map (funding_budget_line_id, cost_package_id, weight) VALUES ($1,$2,$3)`,
        [lineIdByIndex[i], pkg.id, null],
      )
      mapped++
    }
    await client.query("COMMIT")
    console.log(`Loaded ${SCHEDULE.length} lines verbatim; applied ${mapped} confident package mappings.`)
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }

  // ── Reconcile against control totals (never altering values) ────────────
  const lineInputs: FundingLineInput[] = SCHEDULE.map((r, i) => ({
    id: lineIdByIndex[i],
    section: r.section,
    description: r.description,
    originalAmount: r.amount,
  }))
  const recon = reconcileToControls(lineInputs, {
    worksTotal: Number(budget.works_total),
    professionalFeesTotal: Number(budget.professional_fees_total),
    originalTotal: Number(budget.original_total),
  })
  await pool.query(`UPDATE funding_budgets SET reconciled = $1 WHERE id = $2`, [recon.ok, budgetId])

  // ── Actual spend from confirmed invoices (unchanged, read-only) ─────────
  const spendRes = await pool.query(
    `SELECT li.cost_package_id, SUM(li.line_net) AS spend, COUNT(*)::int AS lines
     FROM invoice_line_items li JOIN invoices inv ON inv.id = li.invoice_id
     WHERE inv.project_id = $1 AND inv.status = 'confirmed' AND li.cost_package_id IS NOT NULL
     GROUP BY li.cost_package_id`,
    [PROJECT_ID],
  )
  const packages: PackageSpendInput[] = spendRes.rows.map((r: any) => ({ costPackageId: r.cost_package_id, actualSpend: Number(r.spend) }))
  const totalAllRes = await pool.query(
    `SELECT COALESCE(SUM(net),0) AS spend FROM invoices WHERE project_id = $1 AND status = 'confirmed'`,
    [PROJECT_ID],
  )
  const totalActualSpendAll = Number(totalAllRes.rows[0].spend)
  const unclassifiedRes = await pool.query(
    `SELECT COALESCE(SUM(li.line_net),0) AS spend, COUNT(*)::int AS lines
     FROM invoice_line_items li JOIN invoices inv ON inv.id = li.invoice_id
     WHERE inv.project_id = $1 AND inv.status = 'confirmed' AND li.cost_package_id IS NULL`,
    [PROJECT_ID],
  )

  // ── Run engine ──────────────────────────────────────────────────────────
  const mappings: MappingInput[] = []
  for (let i = 0; i < SCHEDULE.length; i++) {
    if (!SCHEDULE[i].map) continue
    mappings.push({ fundingBudgetLineId: lineIdByIndex[i], costPackageId: pkgByCode.get(SCHEDULE[i].map!)!.id })
  }
  const { lines: results, unmappedSpend } = computeLines(lineInputs, packages, mappings)
  const project = computeProject(results, unmappedSpend, totalActualSpendAll)
  const pkgName = new Map(pkgRes.rows.map((p: any) => [p.id, `${p.code} · ${p.name}`]))
  const pkgIsMapped = new Set(mappings.map((m) => m.costPackageId))

  // ── REPORT ────────────────────────────────────────────────────────────
  const L = "=".repeat(78)
  console.log(`\n${L}\nHIGHER FARM — GOLDENTREE FUNDING BUDGET: RECONCILIATION & MAPPING\n${L}`)

  console.log(`\n1) LINES LOADED`)
  console.log(`   Works lines:              ${SCHEDULE.filter((r) => r.section === "works").length}`)
  console.log(`   Professional fees lines:  ${SCHEDULE.filter((r) => r.section === "professional_fees").length}`)
  console.log(`   TOTAL lines loaded:       ${SCHEDULE.length}`)

  console.log(`\n2) RECONCILIATION vs CONTROL TOTALS (tolerance ${gbp(recon.tolerance)})`)
  for (const c of recon.checks) {
    console.log(
      `   ${c.ok ? "OK  " : "FAIL"}  ${c.label.padEnd(24)} calc ${gbp(c.actual).padStart(15)}  expected ${gbp(c.expected ?? 0).padStart(15)}  diff ${gbp(c.diff ?? 0)}`,
    )
  }
  console.log(`   => ${recon.ok ? "RECONCILES — values match control totals." : "DOES NOT RECONCILE (values left unchanged; see diffs above)."}`)

  console.log(`\n3) ACTUAL SPEND RECOGNISED (confirmed invoices, unchanged)`)
  console.log(`   Total actual spend (all confirmed net):  ${gbp(totalActualSpendAll)}`)
  console.log(`   Classified to a cost package:            ${gbp(round2(packages.reduce((a, p) => a + p.actualSpend, 0)))} (${spendRes.rows.reduce((a: number, r: any) => a + r.lines, 0)} lines)`)
  console.log(`   Unclassified invoice lines (no package): ${gbp(Number(unclassifiedRes.rows[0].spend))} (${unclassifiedRes.rows[0].lines} lines)`)

  console.log(`\n4) ACTUAL SPEND BY GILBERT OS COST PACKAGE`)
  const spendSorted = [...packages].sort((a, b) => b.actualSpend - a.actualSpend)
  for (const p of spendSorted) {
    console.log(`   ${(pkgName.get(p.costPackageId) ?? p.costPackageId).toString().padEnd(34)} ${gbp(p.actualSpend).padStart(13)}${pkgIsMapped.has(p.costPackageId) ? "" : "   <- spend on an UNMAPPED package"}`)
  }

  console.log(`\n5) ACTUAL SPEND vs FUNDING LINE (confidently mapped lines only)`)
  console.log(`   ${"Funding line".padEnd(52)} ${"Allowance".padStart(12)} ${"Actual".padStart(11)} ${"Variance".padStart(12)}`)
  for (const r of results) {
    const isMapped = mappings.some((m) => m.fundingBudgetLineId === r.lineId)
    if (r.section !== "works" || !isMapped) continue
    const tag = r.favourable ? "fav" : "ADV"
    console.log(
      `   ${r.description.slice(0, 51).padEnd(52)} ${gbp(r.originalFundingBudget).padStart(12)} ${gbp(r.actualSpendToDate).padStart(11)} ${gbp(r.varianceAmount).padStart(12)} ${tag}`,
    )
  }

  console.log(`\n6) GOLDENTREE LINES NEEDING YOUR MAPPING DECISION`)
  const flagged = SCHEDULE.filter((r) => r.flag)
  for (const r of flagged) console.log(`   • ${r.description} (${gbp(r.amount)})\n       ${r.flag}`)
  console.log(`   (${flagged.length} lines flagged; ${gbp(round2(flagged.reduce((a, r) => a + r.amount, 0)))} of works allowance awaiting a mapping decision)`)

  console.log(`\n7) UNMAPPED ACTUAL SPEND (spend on packages not yet tied to a funding line)`)
  const unmappedPkgs = spendSorted.filter((p) => !pkgIsMapped.has(p.costPackageId))
  if (unmappedPkgs.length === 0 && Number(unclassifiedRes.rows[0].spend) === 0) {
    console.log(`   None — all classified spend flows to a mapped funding line.`)
  } else {
    for (const p of unmappedPkgs) console.log(`   ${(pkgName.get(p.costPackageId) ?? "").toString().padEnd(34)} ${gbp(p.actualSpend)}`)
    if (Number(unclassifiedRes.rows[0].spend) > 0) console.log(`   Unclassified invoice lines: ${gbp(Number(unclassifiedRes.rows[0].spend))}`)
    console.log(`   Engine unmapped spend total: ${gbp(unmappedSpend)}`)
  }

  console.log(`\n8) PROJECT ROLLUP`)
  console.log(`   Works allowance:            ${gbp(project.totalWorksBudget)}`)
  console.log(`   Professional fees allowance:${gbp(project.totalProfessionalFeesBudget)}`)
  console.log(`   Total funding budget:       ${gbp(project.totalFundingBudget)}`)
  console.log(`   Total actual spend:         ${gbp(project.totalActualSpendAll)}`)
  console.log(`   Favourable funding variance:${gbp(project.favourableFundingVariance)} (${project.varianceLabel})`)
  console.log(`   NOTE: favourable variance is funding headroom (incl. self-performed labour), NOT profit.`)
  console.log(`\n${L}\n`)
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error("ERROR:", e.message)
    await pool.end()
    process.exit(1)
  })
