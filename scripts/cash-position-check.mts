import { getCashPosition } from "../lib/funding/cash-position"
import { pool } from "../lib/db"
const m = (n: any) => `£${Number(n ?? 0).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`
const p = (await getCashPosition(1))!
console.log("\n=== FUNDING ===")
console.log(`  Lender facility (amount to borrow) ${m(p.facility)}`)
console.log(`  Funding budget total               ${m(p.fundingBudget)}`)
console.log(`  Certified / drawn                  ${m(p.certifiedToDate)}  (${p.drawnPct.toFixed(1)}%)`)
console.log(`    of which paid direct to suppliers ${m(p.directPayments)}`)
console.log(`  LEFT TO DRAW                       ${m(p.leftToDraw)}`)
console.log("\n=== COST ===")
console.log(`  Spent to date                      ${m(p.spentToDate)}`)
console.log(`  Outstanding (${p.outstandingCount})                    ${m(p.outstanding)}`)
console.log(`  Committed                          ${m(p.committed)}  (${p.committedPct.toFixed(1)}%)`)
console.log(`  LEFT TO SPEND                      ${m(p.leftToSpend)}`)
console.log(`\n  ${p.headroom >= 0 ? "AHEAD by" : "SHORT by"}  ${m(Math.abs(p.headroom))}`)
if (p.eventsMissingCash.length) {
  console.log(`\n  data gaps — certified with no cash figure recorded:`)
  for (const e of p.eventsMissingCash) console.log(`    ${e.label}  ${m(e.certified)}`)
}
await pool.end()
