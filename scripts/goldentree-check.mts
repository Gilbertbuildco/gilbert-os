import { getGoldentreeSchedule } from "../lib/funding/goldentree"
import { pool } from "../lib/db"
const m=(n:number)=>`£${n.toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`
const g=(await getGoldentreeSchedule(1))!
console.log(`  ${g.budgetName} — ${g.lender ?? "?"}   amount to borrow ${m(g.amountToBorrow ?? 0)}`)
console.log(`  ${g.rows.length} lines × ${g.events.length} certificates`)
console.log(`\n  original   ${m(g.totals.original).padStart(14)}`)
console.log(`  drawn      ${m(g.totals.drawn).padStart(14)}   (allocated to lines)`)
console.log(`  certified  ${m(g.totals.certified).padStart(14)}   (certificate totals)`)
console.log(`  difference ${m(g.unallocatedTotal).padStart(14)}   <- certified but not allocated to any line`)
console.log(`  remaining  ${m(g.totals.remaining).padStart(14)}`)
console.log(`\n  certificates with unallocated amounts:`)
for (const e of g.events.filter(e=>Math.abs(e.unallocated)>0.005))
  console.log(`    ${String(e.label).slice(0,34).padEnd(35)} cert ${m(e.certified).padStart(12)}  unallocated ${m(e.unallocated)}`)
await pool.end()
