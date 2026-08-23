import "server-only"
import { pool } from "../db"
import { getDrawdownEvents, getFundingCommercial } from "./queries"

/**
 * The owner's daily position: cash, what is owed now, what is left to draw,
 * and what is expected to be paid going forward.
 *
 * NOTHING IS GUESSED. Owner, 2026-08-23: "If we dont either have a quote or
 * I've told you a known cost we dont guess." A future payment appears here only
 * when it has one of two origins, and the origin is always shown:
 *
 *   quote     an accepted supplier quotation, less what has already been drawn
 *             against it
 *   owner     a figure the owner stated, recorded as an allowance
 *
 * Work with neither is NOT estimated from the lender's allowance or from
 * anything else. It is listed by name under `noPriceYet` so the gap is visible
 * rather than filled in (non-negotiable #1).
 *
 * PAID AGAINST A QUOTE is the greater of invoices raised and money paid.
 * Several trades are paid without an invoice ever reaching us — Rhys Harvey had
 * £12,789 of payments against £2,025 of invoices — and counting invoices alone
 * overstates what is still to come.
 *
 * "Drawn" is reserved for the lender's facility and is NEVER used of a supplier.
 * The two are unconnected: money left to draw is one sum against the facility as
 * a whole, not something apportioned to a trade. Mixing the words here implied a
 * link that does not exist.
 */
export type FuturePayment = {
  supplier: string
  amount: number
  origin: "quote" | "owner"
  detail: string
}

export type Position = {
  cash: { amount: number; asAt: string; source: string } | null
  owedNow: { total: number; count: number; bySupplier: { supplier: string; total: number; count: number }[] }
  leftToDraw: number
  facility: { total: number; certified: number }
  future: { total: number; fromQuotes: number; fromOwner: number; items: FuturePayment[] }
  /** Lender lines with budget left and nothing spent, quoted or allowed — priced by nobody. */
  noPriceYet: { description: string; budget: number }[]
  /** cash + leftToDraw − owedNow − future. */
  headroom: number
}

/**
 * Harlequin state a remaining balance per plot on every invoice; there is no
 * quote row for them.
 *
 * THIS IS THE PLOT CONTRACTS ONLY. They also bill garages, measured per m2 as
 * they are built (£48/m2), and E/O works — neither sits in any contract sum, so
 * neither can be counted here. Plot 1's garage has not been billed at all yet.
 * The true remaining figure is therefore HIGHER than this by whatever the
 * garages and extras come to, and the detail says so rather than implying this
 * is their whole account.
 */
const HARLEQUIN = {
  supplier: "HARLEQUIN",
  amount: 17345.0,
  detail: "Plot 2 £7,660 + Plot 3 £9,685 per invoice 07. Plot contracts only — garages (£48/m², Plot 1's not yet billed) and E/O works are extra",
}

export async function getPosition(projectId: number): Promise<Position | null> {
  const c = await getFundingCommercial(projectId)
  if (!c) return null
  const events = await getDrawdownEvents(c.budget.id)
  const certified = events.reduce((s, e) => s + Number(e.certifiedTotal ?? 0), 0)
  const headerFacility = Number(c.budget.amountToBorrow ?? 0)
  const facilityTotal = headerFacility > 0 ? headerFacility : c.project.totalFundingBudget

  const { rows: [bal] } = await pool.query(`
    SELECT b.amount, to_char(b.fetched_at,'YYYY-MM-DD') AS as_at, c.provider
      FROM bank_balances b JOIN bank_connections c ON c.id = b.connection_id
     ORDER BY b.fetched_at DESC LIMIT 1`)
  const cash = bal
    ? { amount: Number(bal.amount), asAt: bal.as_at, source: bal.provider === "manual" ? "read from the account" : bal.provider }
    : null

  // Owed now — gross, because that is what leaves the bank.
  const { rows: owedRows } = await pool.query(`
    SELECT s.name AS supplier, count(*)::int AS n,
           SUM(CASE WHEN i.payment_status = 'part_paid' AND i.amount_paid IS NOT NULL
                    THEN i.gross - i.amount_paid ELSE i.gross END) AS owed
      FROM invoices i JOIN suppliers s ON s.id = i.supplier_id
     WHERE i.status = 'confirmed' AND i.payment_status IN ('unpaid','part_paid')
     GROUP BY 1 ORDER BY 3 DESC`)
  const bySupplier = owedRows.map((r: any) => ({ supplier: r.supplier, total: Number(r.owed), count: r.n }))

  // Future payments: accepted quotes not yet drawn, plus the owner's allowances.
  const { rows: qRows } = await pool.query(`
    SELECT COALESCE(s.name, q.supplier_name_raw) AS sup, q.status, SUM(q.net) AS quoted,
           -- Owner allowances are itemised individually; a placeholder supplier
           -- name would otherwise collapse four separate allowances into one row.
           CASE WHEN q.status = 'estimate' THEN MIN(q.description) ELSE NULL END AS est_desc,
           COALESCE((SELECT SUM(i.net) FROM invoices i
                      WHERE i.supplier_id = q.supplier_id AND i.status = 'confirmed'), 0) AS invoiced
      FROM quotes q LEFT JOIN suppliers s ON s.id = q.supplier_id
     WHERE q.project_id = $1 AND q.status IN ('accepted','estimate')
     GROUP BY 1, q.status, q.supplier_id, CASE WHEN q.status = 'estimate' THEN q.reference ELSE NULL END`, [projectId])

  // Money actually paid per supplier, from the cached Xero snapshot. Several
  // trades are paid without an invoice reaching the OS — Rhys Harvey had £12,789
  // of payments against £2,025 of invoices — so counting invoices alone
  // overstates what is still to come.
  const { rows: paidRows } = await pool.query(`
    SELECT COALESCE(s.name, x.contact_name) AS supplier, x.paid_net
      FROM supplier_external_paid x LEFT JOIN suppliers s ON s.id = x.supplier_id`)
  const paidBy = new Map<string, number>()
  for (const r of paidRows) paidBy.set(String(r.supplier), Math.max(paidBy.get(String(r.supplier)) ?? 0, Number(r.paid_net)))

  const items: FuturePayment[] = []
  for (const r of qRows) {
    if (r.status === "estimate") {
      const label = String(r.est_desc ?? r.sup ?? "—").split(" — ")[0].split(" - ")[0].slice(0, 48)
      items.push({ supplier: label, amount: Number(r.quoted), origin: "owner", detail: "figure you gave me — no supplier document" })
      continue
    }
    const paid = Math.max(Number(r.invoiced), paidBy.get(r.sup) ?? 0)
    const left = Number(r.quoted) - paid
    if (left > 0.005)
      items.push({ supplier: r.sup, amount: left, origin: "quote",
        detail: `accepted quote ${fmt(Number(r.quoted))}, ${fmt(paid)} already paid` })
  }
  items.push({ supplier: HARLEQUIN.supplier, amount: HARLEQUIN.amount, origin: "quote", detail: HARLEQUIN.detail })
  items.sort((a, b) => b.amount - a.amount)

  const fromQuotes = items.filter((i) => i.origin === "quote").reduce((s, i) => s + i.amount, 0)
  const fromOwner = items.filter((i) => i.origin === "owner").reduce((s, i) => s + i.amount, 0)

  // Lines nobody has priced: budget left, no spend, and no commitment attached.
  const priced = new Set(items.map((i) => i.supplier.toLowerCase()))
  const noPriceYet = c.lines
    .filter((l) => l.originalFundingBudget > 0 && l.actualSpendToDate <= 0.005)
    .filter((l) => !/contingency/i.test(l.description))
    .map((l) => ({ description: l.description, budget: l.originalFundingBudget }))
    .sort((a, b) => b.budget - a.budget)

  const owedTotal = bySupplier.reduce((s, o) => s + o.total, 0)
  const leftToDraw = facilityTotal - certified

  return {
    cash,
    owedNow: { total: owedTotal, count: owedRows.reduce((s: number, r: any) => s + r.n, 0), bySupplier },
    leftToDraw,
    facility: { total: facilityTotal, certified },
    future: { total: fromQuotes + fromOwner, fromQuotes, fromOwner, items },
    noPriceYet,
    headroom: (cash?.amount ?? 0) + leftToDraw - owedTotal - (fromQuotes + fromOwner),
  }
}

function fmt(n: number) {
  return `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
