/** Shows every component of "left to spend", so the figure can be audited rather than trusted. */
import { getCashPosition } from "../lib/funding/cash-position"
import { pool } from "../lib/db"
const m = (n: number) => `£${n.toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`
const p = (await getCashPosition(1))!
console.log("\n  Funding budget (lender's total, ex-VAT)   " + m(p.fundingBudget).padStart(14))
console.log("  less spent to date (confirmed invoices)  -" + m(p.spentToDate).padStart(14))
console.log("  less owed on unpaid invoices (ex-VAT)    -" + m(p.outstandingNet).padStart(14))
console.log("  " + "-".repeat(56))
console.log("  = LEFT TO SPEND                           " + m(p.leftToSpend).padStart(14))
console.log(`\n  check: ${m(p.spentToDate)} + ${m(p.outstandingNet)} = ${m(p.committed)} committed`)
console.log(`         ${m(p.fundingBudget)} - ${m(p.committed)} = ${m(p.leftToSpend)}`)
console.log("\n  OF THAT £" + p.leftToSpend.toFixed(2) + ", ALREADY SPOKEN FOR:")
console.log("    accepted quotes not yet invoiced       " + m(p.contracted).padStart(14))
for (const q of p.contractedBySupplier) console.log(`      ${q.supplier.slice(0,34).padEnd(35)} ${m(q.remaining).padStart(12)}`)
console.log("    genuinely unallocated                  " + m(p.unallocated).padStart(14))
console.log(`\n  NOT included (lender does not fund it):  ${m(p.nonBuildSpend)} of legal, broker and vehicle costs`)
await pool.end()
