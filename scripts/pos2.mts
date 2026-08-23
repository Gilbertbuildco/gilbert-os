import { getPosition } from "../lib/funding/position"
import { pool } from "../lib/db"
const m=(n:number)=>`£${n.toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`
const p=(await getPosition(1))!
const b=p.budgetAfterOwed
console.log(`  budget      ${m(b.budget).padStart(14)}`)
console.log(`  paid        ${m(b.paid).padStart(14)}`)
console.log(`  owed (net)  ${m(b.owedNet).padStart(14)}`)
console.log(`  then spent  ${m(b.thenSpent).padStart(14)}   (${b.thenPct.toFixed(1)}% of budget)`)
console.log(`  then left   ${m(b.thenLeft).padStart(14)}`)
await pool.end()
