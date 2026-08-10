/**
 * Funding vs Actual — the Phase 2A commercial calculation engine.
 *
 * Pure and dependency-free (no DB, no "server-only") so it can be unit-tested
 * and later reused on the client. It never mutates its inputs and never alters
 * an original funding amount.
 *
 * Two concepts are kept strictly separate throughout:
 *   FUNDING BUDGET — the lender's agreed allowance (immutable baseline).
 *   ACTUAL COST    — what Gilbert Build Co actually spends (from invoices).
 *
 * A positive variance means actual/forecast cash cost is BELOW the allowance.
 * It is deliberately called a "favourable funding variance", NEVER "profit" —
 * on Higher Farm much of it is intentional headroom from self-performed labour.
 */

export type FundingSection = "works" | "professional_fees"

/** A funding schedule line as stored (original amounts are immutable). */
export type FundingLineInput = {
  id: number
  section: FundingSection
  description: string
  originalAmount: number
  /** Optional manual forecast cost-to-complete. null = not yet forecast. */
  forecastToComplete?: number | null
}

/** Actual committed spend for one Gilbert OS cost package (credits reduce it). */
export type PackageSpendInput = {
  costPackageId: number
  /** Net actual spend to date (already signed: credits negative). */
  actualSpend: number
  /** Committed-but-not-yet-invoiced cost. Structure only; defaults to 0. */
  committed?: number
}

/** One funding-line ↔ cost-package mapping edge. */
export type MappingInput = {
  fundingBudgetLineId: number
  costPackageId: number
  /** Optional apportionment weight; null → apportion by original-amount share. */
  weight?: number | null
}

/** Optional per-line drawdown inputs (completion-driven, not spend-driven). */
export type DrawdownInput = {
  fundingBudgetLineId: number
  workCompletePct?: number | null
  fundingCertified?: number | null
  fundingDrawn?: number | null
}

export type LineResult = {
  lineId: number
  section: FundingSection
  description: string
  originalFundingBudget: number
  actualSpendToDate: number
  committedCost: number
  /** originalFundingBudget - actualSpendToDate. Positive = favourable. */
  varianceAmount: number
  /** varianceAmount / originalFundingBudget * 100 (null if budget is 0). */
  variancePct: number | null
  /** True when varianceAmount >= 0 (cash cost at/below allowance). */
  favourable: boolean
  forecastCostToComplete: number
  hasForecast: boolean
  forecastFinalCost: number
  /** originalFundingBudget - forecastFinalCost. */
  forecastFinalVariance: number
  // Drawdown structure (completion-driven entitlement).
  workCompletePct: number | null
  fundingEarned: number | null
  fundingCertified: number | null
  fundingDrawn: number | null
  fundingRemaining: number | null
  /** Cash spent that has not yet been drawn/reimbursed. */
  amountSpentNotYetFunded: number | null
  /** Funding drawn ahead of what has actually been spent (front-running cost). */
  amountFundedAheadOfCost: number | null
}

export type ProjectResult = {
  totalWorksBudget: number
  totalProfessionalFeesBudget: number
  totalFundingBudget: number
  /** Actual spend apportioned onto funding lines. */
  totalActualSpendMapped: number
  /** Every confirmed actual cost for the project, mapped or not. */
  totalActualSpendAll: number
  /** Spend on packages not mapped to any funding line (never silently lost). */
  totalUnmappedSpend: number
  totalCommitted: number
  favourableFundingVariance: number
  varianceLabel: "favourable" | "adverse" | "on_budget"
  forecastFinalCost: number
  forecastFinalVariance: number
}

export const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100

/**
 * Apportion each package's actual spend across the funding lines it maps to.
 * A package mapped to one line gives that line its full spend. A package mapped
 * to several lines is split by explicit weight when all edges carry one, else
 * by the mapped lines' original-amount proportion, else equally.
 *
 * Returns spend per funding line id plus the spend that could not be mapped.
 */
export function apportionSpend(
  lines: FundingLineInput[],
  packages: PackageSpendInput[],
  mappings: MappingInput[],
): { byLine: Map<number, number>; committedByLine: Map<number, number>; unmapped: number } {
  const lineById = new Map(lines.map((l) => [l.id, l]))
  const byLine = new Map<number, number>()
  const committedByLine = new Map<number, number>()
  const edgesByPackage = new Map<number, MappingInput[]>()
  for (const m of mappings) {
    const arr = edgesByPackage.get(m.costPackageId) ?? []
    arr.push(m)
    edgesByPackage.set(m.costPackageId, arr)
  }

  let unmapped = 0
  for (const pkg of packages) {
    const edges = (edgesByPackage.get(pkg.costPackageId) ?? []).filter((e) => lineById.has(e.fundingBudgetLineId))
    const committed = pkg.committed ?? 0
    if (edges.length === 0) {
      unmapped += pkg.actualSpend
      continue
    }
    const shares = computeShares(edges, lineById)
    for (const { fundingBudgetLineId, share } of shares) {
      byLine.set(fundingBudgetLineId, (byLine.get(fundingBudgetLineId) ?? 0) + pkg.actualSpend * share)
      committedByLine.set(fundingBudgetLineId, (committedByLine.get(fundingBudgetLineId) ?? 0) + committed * share)
    }
  }
  // Round accumulated values once at the end to avoid compounding drift.
  for (const [k, v] of byLine) byLine.set(k, round2(v))
  for (const [k, v] of committedByLine) committedByLine.set(k, round2(v))
  return { byLine, committedByLine, unmapped: round2(unmapped) }
}

function computeShares(
  edges: MappingInput[],
  lineById: Map<number, FundingLineInput>,
): { fundingBudgetLineId: number; share: number }[] {
  if (edges.length === 1) return [{ fundingBudgetLineId: edges[0].fundingBudgetLineId, share: 1 }]

  const allWeighted = edges.every((e) => e.weight != null && e.weight > 0)
  if (allWeighted) {
    const sum = edges.reduce((a, e) => a + (e.weight as number), 0)
    return edges.map((e) => ({ fundingBudgetLineId: e.fundingBudgetLineId, share: (e.weight as number) / sum }))
  }

  const amounts = edges.map((e) => Math.abs(lineById.get(e.fundingBudgetLineId)?.originalAmount ?? 0))
  const sum = amounts.reduce((a, b) => a + b, 0)
  if (sum > 0) {
    return edges.map((e, i) => ({ fundingBudgetLineId: e.fundingBudgetLineId, share: amounts[i] / sum }))
  }
  // No basis to weight by — split equally.
  return edges.map((e) => ({ fundingBudgetLineId: e.fundingBudgetLineId, share: 1 / edges.length }))
}

/** Compute the full commercial picture for one funding line. */
export function computeLine(
  line: FundingLineInput,
  actualSpend: number,
  committed: number,
  drawdown?: DrawdownInput,
): LineResult {
  const originalFundingBudget = round2(line.originalAmount)
  const actual = round2(actualSpend)
  const varianceAmount = round2(originalFundingBudget - actual)
  const variancePct = originalFundingBudget !== 0 ? round2((varianceAmount / originalFundingBudget) * 100) : null

  const hasForecast = line.forecastToComplete != null
  const forecastCostToComplete = round2(line.forecastToComplete ?? 0)
  // With no CTC entered yet, forecast final = spent so far (nothing further forecast).
  const forecastFinalCost = round2(actual + forecastCostToComplete)
  const forecastFinalVariance = round2(originalFundingBudget - forecastFinalCost)

  const pct = drawdown?.workCompletePct ?? null
  const fundingEarned = pct != null ? round2(originalFundingBudget * (pct / 100)) : null
  const fundingCertified = drawdown?.fundingCertified ?? null
  const fundingDrawn = drawdown?.fundingDrawn ?? null
  const fundingRemaining = fundingDrawn != null ? round2(originalFundingBudget - fundingDrawn) : null
  const amountSpentNotYetFunded = fundingDrawn != null ? round2(Math.max(0, actual - fundingDrawn)) : null
  const amountFundedAheadOfCost = fundingDrawn != null ? round2(Math.max(0, fundingDrawn - actual)) : null

  return {
    lineId: line.id,
    section: line.section,
    description: line.description,
    originalFundingBudget,
    actualSpendToDate: actual,
    committedCost: round2(committed),
    varianceAmount,
    variancePct,
    favourable: varianceAmount >= 0,
    forecastCostToComplete,
    hasForecast,
    forecastFinalCost,
    forecastFinalVariance,
    workCompletePct: pct,
    fundingEarned,
    fundingCertified,
    fundingDrawn,
    fundingRemaining,
    amountSpentNotYetFunded,
    amountFundedAheadOfCost,
  }
}

/** Compute every line result for a funding budget. */
export function computeLines(
  lines: FundingLineInput[],
  packages: PackageSpendInput[],
  mappings: MappingInput[],
  drawdowns: DrawdownInput[] = [],
): { lines: LineResult[]; unmappedSpend: number } {
  const { byLine, committedByLine, unmapped } = apportionSpend(lines, packages, mappings)
  const ddById = new Map(drawdowns.map((d) => [d.fundingBudgetLineId, d]))
  const results = lines.map((l) =>
    computeLine(l, byLine.get(l.id) ?? 0, committedByLine.get(l.id) ?? 0, ddById.get(l.id)),
  )
  return { lines: results, unmappedSpend: unmapped }
}

/**
 * Roll line results up to the project level.
 * `totalActualSpendAll` is passed in separately because it is the authoritative
 * project spend (every confirmed invoice net), independent of mapping coverage.
 */
export function computeProject(lineResults: LineResult[], unmappedSpend: number, totalActualSpendAll: number): ProjectResult {
  const sum = (f: (l: LineResult) => number) => round2(lineResults.reduce((a, l) => a + f(l), 0))
  const totalWorksBudget = sum((l) => (l.section === "works" ? l.originalFundingBudget : 0))
  const totalProfessionalFeesBudget = sum((l) => (l.section === "professional_fees" ? l.originalFundingBudget : 0))
  const totalFundingBudget = round2(totalWorksBudget + totalProfessionalFeesBudget)
  const totalActualSpendMapped = sum((l) => l.actualSpendToDate)
  const totalCommitted = sum((l) => l.committedCost)
  const favourableFundingVariance = round2(totalFundingBudget - round2(totalActualSpendAll))
  const forecastFinalCost = sum((l) => l.forecastFinalCost)
  const forecastFinalVariance = round2(totalFundingBudget - forecastFinalCost)

  const varianceLabel: ProjectResult["varianceLabel"] =
    favourableFundingVariance > 0 ? "favourable" : favourableFundingVariance < 0 ? "adverse" : "on_budget"

  return {
    totalWorksBudget,
    totalProfessionalFeesBudget,
    totalFundingBudget,
    totalActualSpendMapped,
    totalActualSpendAll: round2(totalActualSpendAll),
    totalUnmappedSpend: round2(unmappedSpend),
    totalCommitted,
    favourableFundingVariance,
    varianceLabel,
    forecastFinalCost,
    forecastFinalVariance,
  }
}

export type ControlTotals = {
  worksTotal: number | null
  professionalFeesTotal: number | null
  originalTotal: number | null
}

export type ReconResult = {
  ok: boolean
  tolerance: number
  checks: {
    label: string
    expected: number | null
    actual: number
    diff: number | null
    ok: boolean
  }[]
}

/**
 * Validate imported line data against the supplied control totals. NEVER alters
 * any value — a failure is surfaced for human review, per the source-of-truth
 * rule. Default tolerance allows for legitimate ≤1p rounding across a schedule.
 */
export function reconcileToControls(
  lines: FundingLineInput[],
  controls: ControlTotals,
  tolerance = 0.01,
): ReconResult {
  const works = round2(lines.filter((l) => l.section === "works").reduce((a, l) => a + l.originalAmount, 0))
  const prof = round2(lines.filter((l) => l.section === "professional_fees").reduce((a, l) => a + l.originalAmount, 0))
  const total = round2(works + prof)

  const mk = (label: string, expected: number | null, actual: number) => {
    const diff = expected == null ? null : round2(actual - expected)
    return { label, expected, actual, diff, ok: expected == null ? true : Math.abs(diff as number) <= tolerance }
  }

  const checks = [
    mk("Works total", controls.worksTotal, works),
    mk("Professional fees total", controls.professionalFeesTotal, prof),
    mk("Grand total", controls.originalTotal, total),
  ]
  return { ok: checks.every((c) => c.ok), tolerance, checks }
}
