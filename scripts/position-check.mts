import { getPosition } from "../lib/funding/position"
import { pool } from "../lib/db"
const m=(n:number)=>`£${n.toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`
const p=(await getPosition(1))!
console.log(`  bank ${m(p.cash?.amount??0)} | owed ${m(p.owedNow.total)} | left to draw ${m(p.leftToDraw)} | expected ${m(p.future.total)}`)
console.log(`  headroom ${m(p.headroom)}\n  expected to pay:`)
for (const i of p.future.items) console.log(`    ${m(i.amount).padStart(12)}  [${i.origin}] ${i.supplier}`)
await pool.end()
