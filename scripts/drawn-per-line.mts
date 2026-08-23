import { getFundingCommercial } from "../lib/funding/queries"
import { pool } from "../lib/db"
const m=(n:any)=>n==null?"—":`£${Number(n).toLocaleString("en-GB",{maximumFractionDigits:0})}`
const c=(await getFundingCommercial(1))!
const withDraw = c.lines.filter(l=>l.fundingDrawn != null && l.fundingDrawn > 0)
console.log(`lines with drawdown data: ${withDraw.length} of ${c.lines.length}`)
for (const l of c.lines.slice(0,8))
  console.log(`  ${l.description.slice(0,40).padEnd(41)} budget ${m(l.originalFundingBudget).padStart(10)} spent ${m(l.actualSpendToDate).padStart(10)} drawn ${m(l.fundingDrawn).padStart(10)} remaining ${m(l.fundingRemaining).padStart(10)}`)
const { rows } = await pool.query(`SELECT count(*)::int n FROM funding_drawdown_allocations`).catch(()=>({rows:[{n:-1}]}))
console.log(`\nfunding_drawdown_allocations rows: ${rows[0].n}`)
await pool.end()
