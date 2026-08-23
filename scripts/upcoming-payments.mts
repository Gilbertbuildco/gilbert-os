/**
 * What is actually coming out of the remaining budget, by certainty.
 *
 * TIER 1  DUE NOW — confirmed invoices not yet paid. A document exists.
 * TIER 2  CONTRACTED — accepted quotes with work still to invoice. Signed,
 *         not yet billed. Excludes buyer-funded work.
 * TIER 3  ALLOWANCE — lender budget on packages with neither. This is the
 *         lender's own number and NOT a forecast of what the work will cost.
 *
 * Nothing is estimated anywhere in this file.
 */
import { getCashPosition } from "../lib/funding/cash-position"
import { getFundingCommercial } from "../lib/funding/queries"
import { pool } from "../lib/db"
const m = (n: number) => `£${n.toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`
const p = (await getCashPosition(1))!

console.log("\n════ TIER 1 — DUE NOW (invoices outstanding) ════")
for (const o of p.owed) console.log(`  ${m(o.total).padStart(13)}  ${o.supplier} (${o.count})`)
console.log(`  ${m(p.outstandingGross).padStart(13)}  TOTAL gross   (${m(p.outstandingNet)} ex-VAT)`)

console.log("\n════ TIER 2 — CONTRACTED, NOT YET INVOICED (accepted quotes) ════")
for (const q of p.contractedBySupplier)
  console.log(`  ${m(q.remaining).padStart(13)}  ${q.supplier}  (quoted ${m(q.quoted)}, invoiced ${m(q.invoiced)})`)
console.log(`  ${m(p.contracted).padStart(13)}  TOTAL ex-VAT`)

console.log("\n════ TIER 3 — LENDER ALLOWANCE, NOTHING COMMITTED ════")
// Budgets live on the lender's 48 funding lines, not on cost packages (none of
// the 27 carries one). Spend MUST come from the engine's apportioned
// LineResult, never from summing a package against every line mapped to it —
// doing that counts one plumbing package four times over and manufactures a
// £342k overspend out of nothing (non-negotiable #8).
const commercial = (await getFundingCommercial(1))!
const lines = commercial.lines
const over = lines.filter((l) => l.varianceAmount < -0.005)
const under = lines.filter((l) => l.varianceAmount > 0.005)
console.log(`  -- ALREADY OVER ALLOWANCE (${over.length}) --`)
for (const l of over.sort((a, b) => a.varianceAmount - b.varianceAmount))
  console.log(`  ${m(l.varianceAmount).padStart(13)}  ${l.description.slice(0,44).padEnd(45)} budget ${m(l.originalFundingBudget)}, spent ${m(l.actualSpendToDate)}`)
console.log(`  ${m(over.reduce((s2, l) => s2 + l.varianceAmount, 0)).padStart(13)}  total over`)
console.log(`\n  -- ALLOWANCE REMAINING, largest first --`)
for (const l of under.sort((a, b) => b.varianceAmount - a.varianceAmount).slice(0, 16))
  console.log(`  ${m(l.varianceAmount).padStart(13)}  ${l.description.slice(0,44).padEnd(45)} of ${m(l.originalFundingBudget)}`)
console.log(`  ${m(under.reduce((s2, l) => s2 + l.varianceAmount, 0)).padStart(13)}  TOTAL across ${under.length} lines with allowance left`)
console.log(`\n  engine check: apportioned spend ${m(lines.reduce((s2, l) => s2 + l.actualSpendToDate, 0))} vs project actual ${m(commercial.project.totalActualSpendMapped)}`)

console.log("\n════ SUMMARY ════")
console.log(`  Left to spend (budget less spent less owed) ${m(p.leftToSpend).padStart(14)}`)
console.log(`    of which contracted                      ${m(p.contracted).padStart(14)}`)
console.log(`    of which pure allowance                  ${m(p.unallocated).padStart(14)}`)
console.log(`  Cash in bank                               ${m(p.cash?.amount ?? 0).padStart(14)}`)
console.log(`  Left to draw                               ${m(p.leftToDraw).padStart(14)}`)
await pool.end()
