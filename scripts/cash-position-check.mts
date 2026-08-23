/** Prints the same figures the Cash Position page shows, straight from the engine, for verification. */
import { getCashPosition } from "../lib/funding/cash-position"
import { pool } from "../lib/db"
const m = (n: any) => `£${Number(n ?? 0).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`
const p = (await getCashPosition(1))!
console.log("\n=== FUNDING ===")
console.log(`  Lender facility             ${m(p.facility)}`)
console.log(`  Certified / drawn           ${m(p.certifiedToDate)}  (${p.drawnPct.toFixed(1)}%)`)
console.log(`    paid direct to suppliers  ${m(p.directPayments)}`)
console.log(`  LEFT TO DRAW                ${m(p.leftToDraw)}`)
console.log("\n=== COST ===")
console.log(`  Spent to date (net)         ${m(p.spentToDate)}`)
console.log(`  Outstanding (${p.outstandingCount})  gross ${m(p.outstandingGross)}  net ${m(p.outstandingNet)}`)
console.log(`  Committed                   ${m(p.committed)}  (${p.committedPct.toFixed(1)}%)`)
console.log(`  LEFT TO SPEND               ${m(p.leftToSpend)}`)
console.log(`\n  Drawn ahead of cost         ${m(p.drawnAheadOfCost)}`)
console.log("\n=== FORECAST TIERS ===")
console.log(`  Contracted, unbilled        ${m(p.contracted)}`)
console.log(`  Known cost                  ${m(p.knownCost)}`)
console.log(`  Not spent or quoted         ${m(p.unallocated)}`)
console.log(`\n  owed suppliers: ${p.owed.length} | drawdown events: ${p.drawdowns.length}`)
await pool.end()
