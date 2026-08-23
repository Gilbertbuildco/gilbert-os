import { getFundingCommercial } from "../lib/funding/queries"
import { pool } from "../lib/db"
const m=(n:number)=>`£${n.toLocaleString("en-GB",{maximumFractionDigits:0})}`
const c=(await getFundingCommercial(1))!
const bySec = new Map<string,{n:number;b:number;s:number}>()
for (const l of c.lines) {
  const g = bySec.get(l.section) ?? {n:0,b:0,s:0}
  g.n++; g.b+=l.originalFundingBudget; g.s+=l.actualSpendToDate
  bySec.set(l.section,g)
}
console.log("sections:")
for (const [k,v] of bySec) console.log(`  ${k.padEnd(22)} ${v.n} lines  budget ${m(v.b).padStart(11)}  spent ${m(v.s).padStart(11)}`)
console.log(`\ntotal lines ${c.lines.length}, unmapped spend ${m(c.unmappedSpend)}`)
await pool.end()
