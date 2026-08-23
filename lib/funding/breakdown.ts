import "server-only"
import { pool } from "../db"
import { getFundingCommercial } from "./queries"

/**
 * Every line of the build: what it was allowed, what has been spent, what is
 * committed on top, and what is left.
 *
 * SPEND IS APPORTIONED, never summed per line. A cost package mapped to four
 * funding lines must have its spend split between them — summing the package
 * against each line counts one plumbing invoice four times and manufactures a
 * six-figure overspend. `getFundingCommercial` runs the pure engine's
 * `apportionSpend`, and this file only reads its result (non-negotiable #8).
 *
 * COMMITTED is what a supplier has a signed quote for but has not yet
 * invoiced, plus the owner's own allowances. The two are kept apart: a quote
 * has a document behind it, an allowance is a figure the owner stated. They
 * are attached to a line only where the supplier's trade maps unambiguously to
 * it — where it does not, the money is reported separately rather than being
 * spread across lines it might not belong to.
 */
export type BreakdownLine = {
  id: number
  description: string
  section: "works" | "professional_fees"
  budget: number
  spent: number
  /** Signed quotes not yet invoiced, attributed to this line. */
  contracted: number
  /** Owner allowances attributed to this line. */
  allowed: number
  /** budget - spent - contracted - allowed. Negative = heading over. */
  left: number
  spentPct: number
  committedPct: number
}

export type Breakdown = {
  lines: BreakdownLine[]
  totals: { budget: number; spent: number; contracted: number; allowed: number; left: number }
  /** Confirmed spend that maps to no funding line at all — real money, no home. */
  unmappedSpend: number
  /** Committed money that could not be attributed to a single line. */
  unattributedCommitted: { label: string; amount: number; kind: "contracted" | "allowance" }[]
}

/**
 * Which funding line each supplier's remaining commitment belongs to, matched
 * on the line description. Deliberately explicit: a wrong guess here moves real
 * money onto the wrong trade, so anything not listed stays unattributed and is
 * shown separately.
 */
const COMMITMENT_TO_LINE: { match: RegExp; line: RegExp; label: string }[] = [
  { match: /harlequin/i,        line: /superstructure brickwork/i,        label: "Harlequin stonework" },
  { match: /sherborne/i,        line: /superstructure brickwork/i,        label: "Sherborne Stone" },
  { match: /marshisaacs/i,      line: /first fix plumbing/i,              label: "Marshisaacs plumbing" },
  { match: /city plumbing/i,    line: /first fix plumbing/i,              label: "City Plumbing" },
  { match: /rhys harvey/i,      line: /first fix electrical/i,            label: "Rhys Harvey electrical" },
  { match: /mayflower/i,        line: /kitchen cabinets/i,                label: "Mayflower kitchens" },
  { match: /EST-CARPENTER/i,    line: /second fix joinery/i,              label: "Carpenter allowance" },
  { match: /EST-STAIRS/i,       line: /second fix joinery/i,              label: "Stairs allowance" },
  { match: /EST-FLOORING/i,     line: /floor (finishes|coverings)|flooring/i, label: "Woodpecker flooring" },
  { match: /EST-SOLAR/i,        line: /solar/i,                           label: "Solar allowance" },
  { match: /EST-APPLIANCES/i,   line: /kitchen cabinets/i,                label: "Appliances allowance" },
]

/** Harlequin state their own remaining balance on every invoice; there is no quote row for it. */
const HARLEQUIN_REMAINING = 17345.0

export async function getBreakdown(projectId: number): Promise<Breakdown | null> {
  const c = await getFundingCommercial(projectId)
  if (!c) return null

  // Remaining commitments: accepted quotes (drawn = greater of invoiced or paid)
  // and owner allowances, kept distinct.
  const { rows: quoteRows } = await pool.query(`
    SELECT COALESCE(s.name, q.supplier_name_raw) AS sup, q.reference, q.status, SUM(q.net) AS quoted,
           COALESCE((SELECT SUM(i.net) FROM invoices i
                      WHERE i.supplier_id = q.supplier_id AND i.status = 'confirmed'), 0) AS invoiced
      FROM quotes q LEFT JOIN suppliers s ON s.id = q.supplier_id
     WHERE q.project_id = $1 AND q.status IN ('accepted','estimate')
     GROUP BY 1, q.reference, q.status, q.supplier_id`, [projectId])

  const commitments: { key: string; label: string; amount: number; kind: "contracted" | "allowance" }[] = []
  const bySupplier = new Map<string, { quoted: number; invoiced: number }>()
  for (const r of quoteRows) {
    if (r.status === "estimate") {
      commitments.push({ key: r.reference, label: r.reference, amount: Number(r.quoted), kind: "allowance" })
    } else {
      const g = bySupplier.get(r.sup) ?? { quoted: 0, invoiced: 0 }
      g.quoted += Number(r.quoted)
      g.invoiced = Number(r.invoiced) // same for every row of that supplier
      bySupplier.set(r.sup, g)
    }
  }
  for (const [sup, g] of bySupplier) {
    const left = g.quoted - g.invoiced
    if (left > 0.005) commitments.push({ key: sup, label: sup, amount: left, kind: "contracted" })
  }
  commitments.push({ key: "harlequin", label: "HARLEQUIN", amount: HARLEQUIN_REMAINING, kind: "contracted" })

  const lines: BreakdownLine[] = c.lines.map((l) => ({
    id: l.lineId, description: l.description, section: l.section,
    budget: l.originalFundingBudget, spent: l.actualSpendToDate,
    contracted: 0, allowed: 0, left: 0, spentPct: 0, committedPct: 0,
  }))

  const unattributed: Breakdown["unattributedCommitted"] = []
  for (const cm of commitments) {
    const rule = COMMITMENT_TO_LINE.find((r) => r.match.test(cm.key))
    const target = rule ? lines.find((l) => rule.line.test(l.description)) : undefined
    if (!target) { unattributed.push({ label: cm.label, amount: cm.amount, kind: cm.kind }); continue }
    if (cm.kind === "contracted") target.contracted += cm.amount
    else target.allowed += cm.amount
  }

  for (const l of lines) {
    l.left = l.budget - l.spent - l.contracted - l.allowed
    l.spentPct = l.budget > 0 ? (l.spent / l.budget) * 100 : l.spent > 0 ? 100 : 0
    l.committedPct = l.budget > 0 ? ((l.spent + l.contracted + l.allowed) / l.budget) * 100 : 0
  }
  lines.sort((a, b) => b.budget - a.budget)

  const totals = lines.reduce(
    (t, l) => ({ budget: t.budget + l.budget, spent: t.spent + l.spent, contracted: t.contracted + l.contracted,
                 allowed: t.allowed + l.allowed, left: t.left + l.left }),
    { budget: 0, spent: 0, contracted: 0, allowed: 0, left: 0 })

  return { lines, totals, unmappedSpend: c.unmappedSpend, unattributedCommitted: unattributed }
}
