import "server-only"
import { pool } from "../db"
import { apportionSpend, type FundingLineInput, type PackageSpendInput } from "./calculations"
import { getDrawdownEvents, getFundingCommercial } from "./queries"

/**
 * The forecasting view: per funding line, what has been DRAWN from the lender,
 * what has been SPENT, and what remains of each.
 *
 * ONLY MONEY THAT HAS ACTUALLY LEFT THE ACCOUNT. Owner, 2026-08-23: "at no
 * stage should future costs come into the build costs. the only time something
 * enters the build cost list (as in, whats it costing us) is when its been
 * paid." So spend here counts PAID invoices only — not merely confirmed ones.
 * An unpaid invoice is a liability, not a cost incurred, and appears on the
 * Cash Position page as a bill to pay rather than here.
 *
 * A part-paid invoice contributes the paid PROPORTION of each of its lines
 * (amount_paid / gross), so the windows invoice adds what has actually been
 * handed over and no more.
 *
 * The engine's own `actualSpendToDate` counts every confirmed invoice, so it
 * cannot be used here. Paid-only spend is apportioned through the very same
 * pure `apportionSpend` function with the same mappings, so the split across
 * shared packages is identical — only the input differs.
 *
 * SPEND IS APPORTIONED, never summed per line — a package mapped to several
 * lines has its spend split between them by the pure engine's `apportionSpend`.
 * Summing the package against each line counts one invoice several times over
 * (non-negotiable #8).
 *
 * TWO DIFFERENT REMAINDERS, deliberately shown side by side:
 *   leftToSpend = budget - spent   (how much allowance is unused)
 *   leftToDraw  = budget - drawn   (how much the lender will still release)
 * They differ whenever drawings run ahead of or behind cost, which is the
 * thing worth watching.
 */
export type BreakdownLine = {
  id: number
  description: string
  section: "works" | "professional_fees"
  budget: number
  spent: number
  /**
   * Certified by the lender against this line, from `funding_drawdowns`
   * (the per-line rollup table) — a DIFFERENT source from `facility.certified`
   * below, which sums `funding_drawdown_events.certifiedTotal` (the
   * facility-wide matrix, including deliberately-unallocated adjustment
   * events such as the -£560 VAT correction — non-negotiable #2/#3). The two
   * totals are close but not required to reconcile exactly for that reason;
   * do not assume summing this column across all lines equals
   * `facility.certified`. null where the schedule carries no allocation.
   */
  drawn: number | null
  leftToSpend: number
  leftToDraw: number | null
  spentPct: number
  drawnPct: number | null
}

export type Breakdown = {
  lines: BreakdownLine[]
  totals: { budget: number; spent: number; drawn: number; leftToSpend: number; leftToDraw: number }
  /** Facility-level figures, which are the reliable ones — per-line drawdown is only allocated on some lines. */
  facility: { total: number; certified: number; leftToDraw: number }
  /**
   * Cash in against cash out, gross. The per-line figures above are build-cost,
   * mapped-to-a-line, ex-VAT and paid — a much narrower measure than money that
   * has moved. Comparing total drawings against them suggested a quarter of a
   * million pounds in hand when the account holds ten thousand. This is the
   * honest comparison: what the lender actually released to the account, and
   * what actually left it.
   */
  cash: {
    certified: number
    paidDirect: number
    /** certified - paidDirect: what reached the account. */
    received: number
    /** Every invoice payment, gross, whatever its classification. */
    paidOut: number
    /** received - paidOut. Negative = more has left the account than the lender has released. */
    net: number
  }
  /** PAID spend (the same paid-only measure as `spent` above) that still maps to no funding line. */
  unmappedSpend: number
  linesWithoutDrawdown: number
}

export async function getBreakdown(projectId: number): Promise<Breakdown | null> {
  const c = await getFundingCommercial(projectId)
  if (!c) return null

  // Paid-only spend per package. Credits carry through negative, as everywhere.
  const { rows: paidRows } = await pool.query(`
    SELECT li.cost_package_id,
           SUM(li.line_net * CASE
                 WHEN i.payment_status = 'paid' THEN 1
                 WHEN i.payment_status = 'part_paid' AND i.amount_paid IS NOT NULL AND i.gross > 0
                   THEN (i.amount_paid / i.gross)
                 WHEN i.transaction_type = 'credit' THEN 1
                 ELSE 0 END) AS spend
      FROM invoice_line_items li
      JOIN invoices i ON i.id = li.invoice_id
      JOIN cost_packages cp ON cp.id = li.cost_package_id
     WHERE i.project_id = $1 AND i.status = 'confirmed'
       AND li.cost_package_id IS NOT NULL AND cp.is_build_cost = true
     GROUP BY li.cost_package_id`, [projectId])
  const paidPackages: PackageSpendInput[] = paidRows.map((r: any) => ({
    costPackageId: r.cost_package_id, actualSpend: Number(r.spend),
  }))
  const lineInputs: FundingLineInput[] = c.lines.map((l) => ({
    id: l.lineId, section: l.section, description: l.description, originalAmount: l.originalFundingBudget,
  }))
  const paid = apportionSpend(lineInputs, paidPackages, c.mappings)
  const events = await getDrawdownEvents(c.budget.id)
  const certified = events.reduce((s, e) => s + Number(e.certifiedTotal ?? 0), 0)
  const headerFacility = Number(c.budget.amountToBorrow ?? 0)
  const facilityTotal = headerFacility > 0 ? headerFacility : c.project.totalFundingBudget

  const lines: BreakdownLine[] = c.lines.map((l) => {
    const drawn = l.fundingDrawn ?? null
    const spentPaid = paid.byLine.get(l.lineId) ?? 0
    return {
      id: l.lineId,
      description: l.description,
      section: l.section,
      budget: l.originalFundingBudget,
      spent: spentPaid,
      drawn,
      leftToSpend: l.originalFundingBudget - spentPaid,
      leftToDraw: drawn == null ? null : l.originalFundingBudget - drawn,
      spentPct: l.originalFundingBudget > 0 ? (spentPaid / l.originalFundingBudget) * 100 : spentPaid > 0 ? 100 : 0,
      drawnPct: drawn == null || l.originalFundingBudget <= 0 ? null : (drawn / l.originalFundingBudget) * 100,
    }
  })
  lines.sort((a, b) => b.budget - a.budget)

  const totals = lines.reduce(
    (t, l) => ({
      budget: t.budget + l.budget,
      spent: t.spent + l.spent,
      drawn: t.drawn + (l.drawn ?? 0),
      leftToSpend: t.leftToSpend + l.leftToSpend,
      leftToDraw: t.leftToDraw + (l.leftToDraw ?? 0),
    }),
    { budget: 0, spent: 0, drawn: 0, leftToSpend: 0, leftToDraw: 0 },
  )

  const paidDirect = events.filter((e) => e.directPayment).reduce((s2, e) => s2 + Number(e.certifiedTotal ?? 0), 0)
  const { rows: [out] } = await pool.query(`
    SELECT COALESCE(SUM(CASE WHEN i.payment_status = 'paid' THEN i.gross
                             WHEN i.payment_status = 'part_paid' AND i.amount_paid IS NOT NULL THEN i.amount_paid
                             ELSE 0 END), 0) AS t
      FROM invoices i WHERE i.status = 'confirmed'`)
  const paidOut = Number(out.t)
  const received = certified - paidDirect

  return {
    lines,
    totals,
    facility: { total: facilityTotal, certified, leftToDraw: facilityTotal - certified },
    cash: { certified, paidDirect, received, paidOut, net: received - paidOut },
    unmappedSpend: paid.unmapped,
    linesWithoutDrawdown: lines.filter((l) => l.drawn == null).length,
  }
}
