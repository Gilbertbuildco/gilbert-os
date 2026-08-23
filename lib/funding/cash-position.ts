import "server-only"
import { pool } from "../db"
import { getDrawdownEvents, getFundingCommercial } from "./queries"

/**
 * Cash position: what is left to draw, what is left to spend, and how much of
 * the remaining work is already committed or contracted.
 *
 * THREE THINGS THE OBVIOUS IMPLEMENTATION GETS WRONG — all deliberate here:
 *
 * 1. VAT BASIS. `totalActualSpendAll` is invoice NET; the lender's schedule is
 *    ex-VAT. Outstanding must therefore be measured net too. Comparing gross
 *    outstanding (£101,954.19) against net spend overstated the liability by
 *    £15,343.26 of recoverable VAT and corrupted the headline.
 *
 * 2. DRAWN is `certifiedTotal`, not `cashReceived`. £173,160.68 of this
 *    facility was paid by the lender DIRECT to suppliers and never reached the
 *    borrower's account; two valuations carry no cash figure at all. Cash sums
 *    understate drawings by £303,303.65. Certified is what reduces the facility.
 *
 * 3. THE HEADLINE IS NOT A FORECAST. Facility and funding budget are the same
 *    figure here, so `leftToDraw - leftToSpend` reduces algebraically to
 *    `committed - certified` — "drawn ahead of cost", nothing more. Presenting
 *    that as a predicted shortfall implies knowledge of the cost to complete
 *    that does not exist. It is labelled for what it is.
 *
 * THE ACTUAL FORECAST is built in tiers of decreasing certainty, never blended:
 *   committed  invoiced + owed .......................... hard fact
 *   contracted accepted quotes not yet invoiced ......... signed, unbilled
 *   allowance  lender allowance on scope with neither ... the lender's number,
 *              NOT an estimate of ours (non-negotiable #1)
 * Only `overCommitted` below is a judgement, and it is pure arithmetic: where a
 * supplier's accepted quote already exceeds what its budget lines allow.
 */
export type OwedSupplier = {
  supplier: string
  total: number
  totalNet: number
  count: number
  invoices: { invoiceNumber: string; date: string; owing: number; status: string; note: string | null }[]
}

export type DrawdownRow = {
  label: string
  date: string | null
  certified: number
  cash: number
  direct: boolean
  missingCash: boolean
}

export type CashPosition = {
  facility: number
  fundingBudget: number
  certifiedToDate: number
  directPayments: number
  cashReceived: number
  leftToDraw: number
  spentToDate: number
  /**
   * Confirmed spend on packages flagged is_build_cost = false (legal & broker
   * fees, vehicles). Excluded from spentToDate because the lender's budget does
   * not cover it — but it is real money out of the account, so it is reported
   * rather than hidden.
   */
  nonBuildSpend: number
  outstandingNet: number
  outstandingGross: number
  outstandingCount: number
  committed: number
  leftToSpend: number
  /** certified − committed. Positive = drawn ahead of cost. NOT a forecast. */
  drawnAheadOfCost: number
  drawnPct: number
  committedPct: number
  /** Accepted quotes with work still to be invoiced. */
  contracted: number
  contractedBySupplier: { supplier: string; quoted: number; invoiced: number; remaining: number }[]
  /** committed + contracted — everything with a document behind it. */
  knownCost: number
  /** facility − knownCost. Budget left for scope not yet invoiced or quoted. */
  unallocated: number
  owed: OwedSupplier[]
  drawdowns: DrawdownRow[]
  /**
   * Cash actually in the bank. Until a direct feed exists this is the owner's
   * own reading — Xero's figure is NOT used, because it counts only money it
   * has seen coded and therefore overstates by whatever sits unreconciled
   * (£45,193.03 in Xero vs £10,560.19 in the account on 2026-08-23).
   */
  cash: { amount: number; source: string; asAt: string } | null
  /** cash - what is owed. Negative = a drawdown is needed to settle the bills. */
  cashAfterBills: number | null
}

export async function getCashPosition(projectId: number): Promise<CashPosition | null> {
  const c = await getFundingCommercial(projectId)
  if (!c) return null
  const events = await getDrawdownEvents(c.budget.id)

  const certifiedToDate = events.reduce((s, e) => s + Number(e.certifiedTotal ?? 0), 0)
  const cashReceived = events.reduce((s, e) => s + Number(e.cashReceived ?? 0), 0)
  const directPayments = events.filter((e) => e.directPayment).reduce((s, e) => s + Number(e.certifiedTotal ?? 0), 0)

  const drawdowns: DrawdownRow[] = events.map((e) => ({
    label: e.label,
    date: e.eventDate,
    certified: Number(e.certifiedTotal ?? 0),
    cash: Number(e.cashReceived ?? 0),
    direct: e.directPayment,
    missingCash: !e.directPayment && Number(e.certifiedTotal ?? 0) > 0 && Number(e.cashReceived ?? 0) === 0,
  }))

  const headerFacility = Number(c.budget.amountToBorrow ?? 0)
  const fundingBudget = c.project.totalFundingBudget
  const facility = headerFacility > 0 ? headerFacility : fundingBudget

  // Outstanding, grouped by supplier. Net is derived from each invoice's own
  // net/gross ratio, so zero-rated invoices (new-build trades) are not divided
  // by an assumed 1.2.
  const { rows } = await pool.query(`
    SELECT s.name AS supplier, i.invoice_number, to_char(i.invoice_date,'YYYY-MM-DD') AS d,
           i.payment_status, i.payment_notes,
           (CASE WHEN i.payment_status = 'part_paid' AND i.amount_paid IS NOT NULL
                 THEN i.gross - i.amount_paid ELSE i.gross END) AS owing_gross,
           (CASE WHEN i.payment_status = 'part_paid' AND i.amount_paid IS NOT NULL AND i.gross > 0
                 THEN i.net * ((i.gross - i.amount_paid) / i.gross) ELSE i.net END) AS owing_net
      FROM invoices i JOIN suppliers s ON s.id = i.supplier_id
     WHERE i.status = 'confirmed' AND i.payment_status IN ('unpaid','part_paid')
     ORDER BY s.name, i.invoice_date`)

  const bySupplier = new Map<string, OwedSupplier>()
  for (const r of rows) {
    const g: OwedSupplier = bySupplier.get(r.supplier) ?? { supplier: r.supplier, total: 0, totalNet: 0, count: 0, invoices: [] }
    g.total += Number(r.owing_gross)
    g.totalNet += Number(r.owing_net)
    g.count++
    g.invoices.push({
      invoiceNumber: r.invoice_number, date: r.d, owing: Number(r.owing_gross),
      status: r.payment_status, note: r.payment_notes ?? null,
    })
    bySupplier.set(r.supplier, g)
  }
  const owed = [...bySupplier.values()].sort((a, b) => b.total - a.total)
  const outstandingGross = owed.reduce((s, o) => s + o.total, 0)
  const outstandingNet = owed.reduce((s, o) => s + o.totalNet, 0)

  // Accepted quotes only (owner rule 2026-08-14). A supplier already invoiced
  // beyond its quote has no remaining contracted work — never a negative.
  const { rows: qrows } = await pool.query(`
    SELECT COALESCE(s.name, q.supplier_name_raw) AS supplier,
           SUM(COALESCE(q.net, q.gross, 0)) AS quoted,
           COALESCE((SELECT SUM(i.net) FROM invoices i
                      WHERE i.supplier_id = q.supplier_id AND i.status = 'confirmed'), 0) AS invoiced
      FROM quotes q LEFT JOIN suppliers s ON s.id = q.supplier_id
     WHERE q.status = 'accepted' AND q.project_id = $1
     GROUP BY 1, q.supplier_id
     ORDER BY 2 DESC`, [projectId])
  const contractedBySupplier = qrows
    .map((r: any) => ({
      supplier: r.supplier, quoted: Number(r.quoted), invoiced: Number(r.invoiced),
      remaining: Math.max(0, Number(r.quoted) - Number(r.invoiced)),
    }))
    .filter((r) => r.remaining > 0)
  const contracted = contractedBySupplier.reduce((s, r) => s + r.remaining, 0)

  const { rows: [bal] } = await pool.query(`
    SELECT b.amount, b.balance_type, to_char(b.fetched_at,'YYYY-MM-DD') AS as_at, c.provider
      FROM bank_balances b JOIN bank_connections c ON c.id = b.connection_id
     ORDER BY b.fetched_at DESC LIMIT 1`)
  const cash = bal
    ? { amount: Number(bal.amount), source: bal.provider === "manual" ? "read from the account" : bal.provider, asAt: bal.as_at }
    : null

  const spentToDate = c.project.totalActualSpendAll
  const nonBuildSpend = c.nonBuildCostSpend
  const committed = spentToDate + outstandingNet
  const knownCost = committed + contracted

  return {
    facility, fundingBudget, certifiedToDate, directPayments, cashReceived,
    leftToDraw: facility - certifiedToDate,
    spentToDate, nonBuildSpend, outstandingNet, outstandingGross, outstandingCount: rows.length,
    committed,
    leftToSpend: fundingBudget - committed,
    drawnAheadOfCost: certifiedToDate - committed,
    drawnPct: facility > 0 ? (certifiedToDate / facility) * 100 : 0,
    committedPct: fundingBudget > 0 ? (committed / fundingBudget) * 100 : 0,
    contracted, contractedBySupplier,
    knownCost,
    unallocated: facility - knownCost,
    owed, drawdowns,
    cash,
    cashAfterBills: cash ? cash.amount - outstandingGross : null,
  }
}
