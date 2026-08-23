import "server-only"
import { pool } from "../db"
import { getOriginalFundingBudget } from "./queries"

/**
 * A mirror of the Goldentree drawdown schedule — the document they issue after
 * each draw — rebuilt from the certificates we hold.
 *
 * THE LENDER'S BASELINE IS IMMUTABLE (non-negotiable #2). Lines appear in the
 * lender's own order, taken from `position`, with their own descriptions and
 * their own values. Nothing here re-sorts, re-groups, splits or rebalances an
 * allowance, and no total is ever adjusted to make the sheet reconcile. Where
 * our records and the lender's differ, the difference is shown.
 *
 * Events are columns in the order they were certified, exactly as they appear
 * across the top of Goldentree's own sheet, including the negative adjustment
 * rows (VAT deducted from a later certificate, a sanitaryware item certified in
 * error) — those are part of the record and are not netted away.
 */
export type GoldentreeCell = { eventId: number; amount: number }

export type GoldentreeRow = {
  lineId: number
  position: number
  section: "works" | "professional_fees"
  description: string
  /** The lender's own allowance for this line. */
  original: number
  cells: GoldentreeCell[]
  /** Sum of every allocation to this line. */
  drawn: number
  /** original − drawn, as the lender's sheet shows it. */
  remaining: number
}

export type GoldentreeEvent = {
  id: number
  key: string
  label: string
  date: string | null
  certified: number
  cashReceived: number
  directPayment: boolean
  /** Certified total minus what the certificate allocated to lines. */
  unallocated: number
  hasDocument: boolean
  notes: string | null
}

export type GoldentreeSchedule = {
  budgetName: string
  lender: string | null
  amountToBorrow: number | null
  rows: GoldentreeRow[]
  events: GoldentreeEvent[]
  totals: {
    original: number
    drawn: number
    remaining: number
    certified: number
    cashReceived: number
    directPayments: number
  }
  /** Certified total less everything allocated to a line across all events. */
  unallocatedTotal: number
}

export async function getGoldentreeSchedule(projectId: number): Promise<GoldentreeSchedule | null> {
  const budget = await getOriginalFundingBudget(projectId)
  if (!budget) return null

  const { rows: lineRows } = await pool.query(`
    SELECT id, position, section, description, original_amount
      FROM funding_budget_lines
     WHERE funding_budget_id = $1
     ORDER BY position, id`, [budget.id])

  const { rows: eventRows } = await pool.query(`
    SELECT id, event_key, label, to_char(event_date,'YYYY-MM-DD') AS event_date,
           certified_total, cash_received, direct_payment, notes,
           (source_file_pathname IS NOT NULL) AS has_doc
      FROM funding_drawdown_events
     WHERE funding_budget_id = $1
     ORDER BY id`, [budget.id])

  const { rows: allocRows } = await pool.query(`
    SELECT a.event_id, a.funding_budget_line_id, a.amount
      FROM funding_drawdown_allocations a
      JOIN funding_drawdown_events e ON e.id = a.event_id
     WHERE e.funding_budget_id = $1`, [budget.id])

  const byLine = new Map<number, GoldentreeCell[]>()
  const allocByEvent = new Map<number, number>()
  for (const a of allocRows) {
    const arr = byLine.get(a.funding_budget_line_id) ?? []
    arr.push({ eventId: a.event_id, amount: Number(a.amount) })
    byLine.set(a.funding_budget_line_id, arr)
    allocByEvent.set(a.event_id, (allocByEvent.get(a.event_id) ?? 0) + Number(a.amount))
  }

  const rows: GoldentreeRow[] = lineRows.map((l: any) => {
    const cells = byLine.get(l.id) ?? []
    const drawn = cells.reduce((s, c) => s + c.amount, 0)
    const original = Number(l.original_amount)
    return {
      lineId: l.id, position: l.position, section: l.section, description: l.description,
      original, cells, drawn, remaining: original - drawn,
    }
  })

  const events: GoldentreeEvent[] = eventRows.map((e: any) => ({
    id: e.id, key: e.event_key, label: e.label, date: e.event_date,
    certified: Number(e.certified_total ?? 0),
    cashReceived: Number(e.cash_received ?? 0),
    directPayment: e.direct_payment,
    unallocated: Number(e.certified_total ?? 0) - (allocByEvent.get(e.id) ?? 0),
    hasDocument: e.has_doc,
    notes: e.notes ?? null,
  }))

  const totals = {
    original: rows.reduce((s, r) => s + r.original, 0),
    drawn: rows.reduce((s, r) => s + r.drawn, 0),
    remaining: rows.reduce((s, r) => s + r.remaining, 0),
    certified: events.reduce((s, e) => s + e.certified, 0),
    cashReceived: events.reduce((s, e) => s + e.cashReceived, 0),
    directPayments: events.filter((e) => e.directPayment).reduce((s, e) => s + e.certified, 0),
  }

  return {
    budgetName: budget.name,
    lender: budget.lender,
    amountToBorrow: budget.amountToBorrow,
    rows,
    events,
    totals,
    unallocatedTotal: totals.certified - totals.drawn,
  }
}
