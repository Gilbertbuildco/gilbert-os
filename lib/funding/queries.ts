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

export type DrawdownAllocation = {
  id: number
  fundingBudgetLineId: number
  amount: number
}

export type DrawdownEvent = {
  id: number
  eventKey: string
  label: string
  eventDate: string | null
  certifiedTotal: number | null
  cashReceived: number | null
  receivedDate: string | null
  directPayment: boolean
  notes: string | null
  allocations: DrawdownAllocation[]
}

/**
 * Every Goldentree drawdown/payment EVENT for a funding budget (one per
 * matrix column — a valuation, a reimbursement, a direct payment), each with
 * its per-funding-line allocations attached. Read-only, mirrors getDrawdowns'
 * shape/idiom above. Returns [] until the drawdown-events ingest has run —
 * `funding_drawdown_events`/`funding_drawdown_allocations` start empty.
 */
export async function getDrawdownEvents(budgetId: number): Promise<DrawdownEvent[]> {
  const eventRows = await db.execute(sql`
    SELECT id, event_key, label, event_date, certified_total, cash_received, received_date, direct_payment, notes
    FROM funding_drawdown_events
    WHERE funding_budget_id = ${budgetId}
    ORDER BY id ASC
  `)
  const events = eventRows.rows as any[]
  if (events.length === 0) return []

  const allocRows = await db.execute(sql`
    SELECT a.id, a.event_id, a.funding_budget_line_id, a.amount
    FROM funding_drawdown_allocations a
    JOIN funding_drawdown_events e ON e.id = a.event_id
    WHERE e.funding_budget_id = ${budgetId}
  `)
  const allocsByEvent = new Map<number, DrawdownAllocation[]>()
  for (const r of allocRows.rows as any[]) {
    const list = allocsByEvent.get(r.event_id) ?? []
    list.push({ id: r.id, fundingBudgetLineId: r.funding_budget_line_id, amount: n(r.amount) })
    allocsByEvent.set(r.event_id, list)
  }

  return events.map((r) => ({
    id: r.id,
    eventKey: r.event_key,
    label: r.label,
    eventDate: r.event_date ?? null,
    certifiedTotal: r.certified_total == null ? null : n(r.certified_total),
    cashReceived: r.cash_received == null ? null : n(r.cash_received),
    receivedDate: r.received_date ?? null,
    directPayment: r.direct_payment,
    notes: r.notes ?? null,
    allocations: allocsByEvent.get(r.id) ?? [],
  }))
}

/**
 * Net actual spend per cost package for a project (credits already negative).
 * Only BUILD-cost packages (cost_packages.is_build_cost = true) are returned —
 * this feeds `apportionSpend`, which apportions package spend onto the
 * lender's Goldentree funding lines, so a package that is real project cost
 * but not construction cost (e.g. "Legal & broker fees") must never enter
 * that apportionment. Excluding it here is a data/query decision only; the
 * pure engine in lib/funding/calculations.ts is never touched.
 *
 * SPEND MEASURE: every CONFIRMED invoice's line, regardless of payment
 * status (`WHERE inv.status = 'confirmed'` — no `payment_status` filter).
 * This is deliberately the opposite measure from `breakdown.ts`, which
 * apportions PAID-only spend through this same `apportionSpend` function
 * with the same mappings. Confirmed-vs-paid is the whole difference between
 * the two call sites; do not use this function where paid-only cash cost is
 * required (the Breakdown page), and do not use `breakdown.ts`'s paid query
 * where accrual actual-spend-vs-budget is required (this one, via
 * `getFundingCommercial` -> `computeProject.totalActualSpendMapped`).
 */
export async function getPackageSpend(projectId: number): Promise<PackageSpendInput[]> {
  const rows = await db.execute(sql`
    SELECT li.cost_package_id, SUM(li.line_net) AS spend
    FROM invoice_line_items li
    JOIN invoices inv ON inv.id = li.invoice_id
    JOIN cost_packages cp ON cp.id = li.cost_package_id
    WHERE inv.project_id = ${projectId} AND inv.status = 'confirmed'
      AND li.cost_package_id IS NOT NULL AND cp.is_build_cost = true
    GROUP BY li.cost_package_id
  `)
  return (rows.rows as any[]).map((r) => ({
    costPackageId: r.cost_package_id,
    actualSpend: n(r.spend),
  }))
}

/**
 * Authoritative project actual spend — every confirmed invoice net, MINUS
 * line items classified into a non-build-cost package (is_build_cost =
 * false). This feeds `totalActualSpendAll` in `computeProject`, which drives
 * `favourableFundingVariance` (actual spend vs the lender's funding budget):
 * a legal/broker fee is not funded by the lender as build cost, so it must
 * never count against that budget. Excluded spend is never lost — it is
 * exposed separately by `getProjectNonBuildCostSpend`.
 *
 * SPEND MEASURE: CONFIRMED, not paid-only — same accrual basis as
 * `getPackageSpend` above (no `payment_status` filter), and for the same
 * reason: this feeds a budget-vs-actual-cost comparison, not a cash-moved
 * comparison. `lib/funding/breakdown.ts` and `lib/funding/cash-position.ts`
 * each document where they diverge from this measure — read those before
 * reusing this figure for anything cash-related.
 */
export async function getProjectActualSpend(projectId: number): Promise<number> {
  const rows = await db.execute(sql`
    SELECT
      COALESCE((SELECT SUM(net) FROM invoices WHERE project_id = ${projectId} AND status = 'confirmed'), 0)
      - COALESCE((
          SELECT SUM(li.line_net)
          FROM invoice_line_items li
          JOIN invoices inv ON inv.id = li.invoice_id
          JOIN cost_packages cp ON cp.id = li.cost_package_id
          WHERE inv.project_id = ${projectId} AND inv.status = 'confirmed' AND cp.is_build_cost = false
        ), 0) AS spend
  `)
  return n((rows.rows as any[])[0]?.spend)
}

/**
 * Confirmed-invoice spend on this project's non-build-cost packages — the
 * portion `getProjectActualSpend` deliberately excludes from the lender
 * actual-spend figure. Surfaced separately so the UI can show it as its own
 * line rather than silently dropping it (non-negotiable: flag, never hide).
 */
export async function getProjectNonBuildCostSpend(projectId: number): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COALESCE(SUM(li.line_net), 0) AS spend
    FROM invoice_line_items li
    JOIN invoices inv ON inv.id = li.invoice_id
    JOIN cost_packages cp ON cp.id = li.cost_package_id
    WHERE inv.project_id = ${projectId} AND inv.status = 'confirmed' AND cp.is_build_cost = false
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
  /**
   * Confirmed-invoice spend on non-build-cost packages (e.g. "Legal & broker
   * fees") — excluded from `project.totalActualSpendAll` and from every
   * `packages` entry above, but never hidden: shown here as its own figure.
   */
  nonBuildCostSpend: number
} | null

/**
 * Assemble the full Funding-vs-Actual commercial picture for a project's
 * original funding budget, running the pure engine over live data.
 */
export async function getFundingCommercial(projectId: number): Promise<FundingCommercial> {
  const budget = await getOriginalFundingBudget(projectId)
  if (!budget) return null

  const [lines, mappings, drawdowns, packages, totalActualSpendAll, nonBuildCostSpend] = await Promise.all([
    getFundingLines(budget.id),
    getMappings(budget.id),
    getDrawdowns(budget.id),
    getPackageSpend(projectId),
    getProjectActualSpend(projectId),
    getProjectNonBuildCostSpend(projectId),
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

  return { budget, lines: lineResults, project, unmappedSpend, recon, mappings, packages, nonBuildCostSpend }
}
