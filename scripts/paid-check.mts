import { getBreakdown } from "../lib/funding/breakdown"
import { pool } from "../lib/db"
const m=(n:number)=>`£${n.toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`
const b=(await getBreakdown(1))!
console.log(`  Drawn         ${m(b.facility.certified).padStart(14)}`)
console.log(`  Spent (PAID)  ${m(b.totals.spent).padStart(14)}`)
console.log(`  Left to spend ${m(b.totals.budget-b.totals.spent).padStart(14)}`)
console.log(`  Left to draw  ${m(b.facility.leftToDraw).padStart(14)}`)
console.log(`  unmapped paid ${m(b.unmappedSpend).padStart(14)}`)
console.log(`  over budget: ${b.lines.filter(l=>l.leftToSpend<-0.005).length} lines`)
await pool.end()
