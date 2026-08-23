import "server-only"
import { pool } from "../db"
import { getDrawdownEvents, getFundingCommercial } from "./queries"

/**
 * The owner's cash question: "what have we got outstanding next to what we have
 * left to drawdown, and what have we left to spend — am I ahead of it all?"
 *
 * TWO FIGURES THAT ARE EASY TO GET WRONG, both deliberate here:
 *
 * 1. DRAWN is `certifiedTotal`, not `cashReceived`. £173,160.68 of this
 *    facility was paid by the lender DIRECT to suppliers (Target Timber,
 *    Protek, utilities) and never reached the borrower's account, and two
 *    valuations (Val 1, Val 6) carry no cash figure at all. Summing cash
 *    understates drawings by £303,303.65 and would overstate what is left to
 *    draw by the same amount. What the facility has been reduced by is what
 *    has been CERTIFIED.
 *
 * 2. OUTSTANDING nets off part-payments. An invoice marked `part_paid` with an
 *    `amount_paid` owes only the balance; without that the Bradfords windows
 *    invoice alone would overstate the liability by the £16,321.00 already paid.
 *
 * Nothing here forecasts. `forecastCostToComplete` is zero on every line of
 * this budget (no line carries a forecast), so "left to spend" is the lender's
 * own allowance less what has been spent and what is owed — an arithmetic
 * remainder, never an estimate (non-negotiable #1).
 */
export type CashPosition = {
  facility: number
  certifiedToDate: number
  directPayments: number
  leftToDraw: number
  fundingBudget: number
  spentToDate: number
  outstanding: number
  outstandingCount: number
  committed: number
  leftToSpend: number
  /** leftToDraw - leftToSpend. Positive = funding covers the remaining budget. */
  headroom: number
  drawnPct: number
  committedPct: number
  /** Valuations certified with no cash figure recorded — a data gap worth surfacing, not a zero receipt. */
  eventsMissingCash: { label: string; certified: number }[]
  topOutstanding: { supplier: string; invoiceNumber: string; date: string; owing: number }[]
}

export async function getCashPosition(projectId: number): Promise<CashPosition | null> {
  const c = await getFundingCommercial(projectId)
  if (!c) return null
  const events = await getDrawdownEvents(c.budget.id)

  const certifiedToDate = events.reduce((s, e) => s + Number(e.certifiedTotal ?? 0), 0)
  const directPayments = events.filter((e) => e.directPayment).reduce((s, e) => s + Number(e.certifiedTotal ?? 0), 0)
  const eventsMissingCash = events
    .filter((e) => !e.directPayment && Number(e.certifiedTotal ?? 0) > 0 && Number(e.cashReceived ?? 0) === 0)
    .map((e) => ({ label: e.label, certified: Number(e.certifiedTotal ?? 0) }))

  // The lender's own facility ("Amount to Borrow" on the Goldentree schedule).
  // Falls back to the funding budget total only when the header does not carry
  // it — never an invented figure.
  const headerFacility = Number(c.budget.amountToBorrow ?? 0)
  const fundingBudget = c.project.totalFundingBudget
  const facility = headerFacility > 0 ? headerFacility : fundingBudget

  const { rows } = await pool.query(`
    SELECT s.name AS supplier, i.invoice_number, to_char(i.invoice_date,'YYYY-MM-DD') AS d,
           (CASE WHEN i.payment_status = 'part_paid' AND i.amount_paid IS NOT NULL
                 THEN i.gross - i.amount_paid ELSE i.gross END) AS owing
      FROM invoices i JOIN suppliers s ON s.id = i.supplier_id
     WHERE i.status = 'confirmed' AND i.payment_status IN ('unpaid','part_paid')
     ORDER BY owing DESC`)

  const outstanding = rows.reduce((s: number, r: any) => s + Number(r.owing), 0)
  const spentToDate = c.project.totalActualSpendAll
  const committed = spentToDate + outstanding
  const leftToDraw = facility - certifiedToDate
  const leftToSpend = fundingBudget - committed

  return {
    facility,
    certifiedToDate,
    directPayments,
    leftToDraw,
    fundingBudget,
    spentToDate,
    outstanding,
    outstandingCount: rows.length,
    committed,
    leftToSpend,
    headroom: leftToDraw - leftToSpend,
    drawnPct: facility > 0 ? (certifiedToDate / facility) * 100 : 0,
    committedPct: fundingBudget > 0 ? (committed / fundingBudget) * 100 : 0,
    eventsMissingCash,
    topOutstanding: rows.slice(0, 12).map((r: any) => ({
      supplier: r.supplier, invoiceNumber: r.invoice_number, date: r.d, owing: Number(r.owing),
    })),
  }
}
