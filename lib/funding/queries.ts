import "server-only"
import { db } from "@/lib/db"
import { sql } from "drizzle-orm"
import {
  computeLines,
  computeProject,
  reconcileToControls,
  type FundingLineInput,
  type PackageSpendInput,
  type MappingInput,
  type DrawdownInput,
  type LineResult,
  type ProjectResult,
  type ReconResult,
} from "./calculations"

const n = (v: unknown): number => (v == null ? 0 : Number(v))

export type FundingBudgetHeader = {
  id: number
  projectId: number
  name: string
  lender: string | null
  status: string
  isOriginal: boolean
  worksTotal: number | null
  professionalFeesTotal: number | null
  originalTotal: number | null
  amountToBorrow: number | null
  reconciled: boolean
  notes: string | null
}

function mapHeader(r: any): FundingBudgetHeader {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    lender: r.lender ?? null,
    status: r.status,
    isOriginal: r.is_original,
    worksTotal: r.works_total == null ? null : n(r.works_total),
    professionalFeesTotal: r.professional_fees_total == null ? null : n(r.professional_fees_total),
    originalTotal: r.original_total == null ? null : n(r.original_total),
    amountToBorrow: r.amount_to_borrow == null ? null : n(r.amount_to_borrow),
    reconciled: r.reconciled,
    notes: r.notes ?? null,
  }
}

/** The original (locked baseline) funding budget for a project, if any. */
export async function getOriginalFundingBudget(projectId: number): Promise<FundingBudgetHeader | null> {
  const rows = await db.execute(sql`
    SELECT * FROM funding_budgets
    WHERE project_id = ${projectId} AND is_original = true
    ORDER BY created_at ASC LIMIT 1
  `)
  const r = (rows.rows as any[])[0]
  return r ? mapHeader(r) : null
}

export async function getFundingLines(budgetId: number): Promise<(FundingLineInput & {
  costPackageCode: string | null
  notes: string | null
  position: number
})[]> {
  const rows = await db.execute(sql`
    SELECT id, section, description, original_amount, forecast_to_complete, cost_package_code, notes, position
    FROM funding_budget_lines WHERE funding_budget_id = ${budgetId}
    ORDER BY position ASC, id ASC
  `)
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    section: r.section,
    description: r.description,
    originalAmount: n(r.original_amount),
    forecastToComplete: r.forecast_to_complete == null ? null : n(r.forecast_to_complete),
    costPackageCode: r.cost_package_code ?? null,
    notes: r.notes ?? null,
    position: n(r.position),
  }))
}

async function getMappings(budgetId: number): Promise<MappingInput[]> {
  const rows = await db.execute(sql`
    SELECT m.funding_budget_line_id, m.cost_package_id, m.weight
    FROM funding_line_package_map m
    JOIN funding_budget_lines l ON l.id = m.funding_budget_line_id
    WHERE l.funding_budget_id = ${budgetId}
  `)
  return (rows.rows as any[]).map((r) => ({
    fundingBudgetLineId: r.funding_budget_line_id,
    costPackageId: r.cost_package_id,
    weight: r.weight == null ? null : n(r.weight),
  }))
}

async function getDrawdowns(budgetId: number): Promise<DrawdownInput[]> {
  const rows = await db.execute(sql`
    SELECT d.funding_budget_line_id, d.work_complete_pct, d.funding_certified, d.funding_drawn
    FROM funding_drawdowns d
    JOIN funding_budget_lines l ON l.id = d.funding_budget_line_id
    WHERE l.funding_budget_id = ${budgetId}
  `)
  return (rows.rows as any[]).map((r) => ({
    fundingBudgetLineId: r.funding_budget_line_id,
    workCompletePct: r.work_complete_pct == null ? null : n(r.work_complete_pct),
    fundingCertified: r.funding_certified == null ? null : n(r.funding_certified),
    fundingDrawn: r.funding_drawn == null ? null : n(r.funding_drawn),
  }))
}

/** Net actual spend per cost package for a project (credits already negative). */
export async function getPackageSpend(projectId: number): Promise<PackageSpendInput[]> {
  const rows = await db.execute(sql`
    SELECT li.cost_package_id, SUM(li.line_net) AS spend
    FROM invoice_line_items li
    JOIN invoices inv ON inv.id = li.invoice_id
    WHERE inv.project_id = ${projectId} AND inv.status = 'confirmed'
      AND li.cost_package_id IS NOT NULL
    GROUP BY li.cost_package_id
  `)
  return (rows.rows as any[]).map((r) => ({
    costPackageId: r.cost_package_id,
    actualSpend: n(r.spend),
  }))
}

/** Authoritative project actual spend (every confirmed invoice net). */
export async function getProjectActualSpend(projectId: number): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COALESCE(SUM(net), 0) AS spend FROM invoices
    WHERE project_id = ${projectId} AND status = 'confirmed'
  `)
  return n((rows.rows as any[])[0]?.spend)
}

export type FundingCommercial = {
  budget: FundingBudgetHeader
  lines: LineResult[]
  project: ProjectResult
  unmappedSpend: number
  /** Live reconciliation of stored lines vs the header control totals. */
  recon: ReconResult
  /**
   * Raw funding-line ↔ cost-package edges for this budget. Exposed (not just
   * consumed internally) so the UI can explain — by re-running the same
   * `apportionSpend` engine function, never a separate calculation — exactly
   * how a shared package's spend was split across the lines mapped to it.
   */
  mappings: MappingInput[]
  /** Per-package actual spend (same figures apportioned above), for that explain view. */
  packages: PackageSpendInput[]
} | null

/**
 * Assemble the full Funding-vs-Actual commercial picture for a project's
 * original funding budget, running the pure engine over live data.
 */
export async function getFundingCommercial(projectId: number): Promise<FundingCommercial> {
  const budget = await getOriginalFundingBudget(projectId)
  if (!budget) return null

  const [lines, mappings, drawdowns, packages, totalActualSpendAll] = await Promise.all([
    getFundingLines(budget.id),
    getMappings(budget.id),
    getDrawdowns(budget.id),
    getPackageSpend(projectId),
    getProjectActualSpend(projectId),
  ])

  const lineInputs: FundingLineInput[] = lines.map((l) => ({
    id: l.id,
    section: l.section,
    description: l.description,
    originalAmount: l.originalAmount,
    forecastToComplete: l.forecastToComplete,
  }))

  const { lines: lineResults, unmappedSpend } = computeLines(lineInputs, packages, mappings, drawdowns)
  const project = computeProject(lineResults, unmappedSpend, totalActualSpendAll)
  const recon = reconcileToControls(lineInputs, {
    worksTotal: budget.worksTotal,
    professionalFeesTotal: budget.professionalFeesTotal,
    originalTotal: budget.originalTotal,
  })

  return { budget, lines: lineResults, project, unmappedSpend, recon, mappings, packages }
}
