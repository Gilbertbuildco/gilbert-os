import { getFundingCommercial, getDrawdownEvents } from "../lib/funding/queries"
import { pool } from "../lib/db"
const m = (n: any) => `£${Number(n ?? 0).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`
const c = await getFundingCommercial(1)
const ev = await getDrawdownEvents(c!.budget.id)
console.log(`drawdown events: ${ev.length}\n`)
let cert=0, cash=0, direct=0
for (const e of ev) {
  cert += Number(e.certifiedTotal ?? 0); cash += Number(e.cashReceived ?? 0)
  if (e.directPayment) direct += Number(e.certifiedTotal ?? 0)
  console.log(`  ${(e.eventDate ?? "?").padEnd(11)} ${String(e.label).slice(0,34).padEnd(35)} cert ${m(e.certifiedTotal).padStart(13)}  cash ${m(e.cashReceived).padStart(13)}  ${e.directPayment ? "DIRECT" : ""}`)
}
console.log(`\n  certified total  ${m(cert)}`)
console.log(`  cash received    ${m(cash)}`)
console.log(`  of which direct payments (not cash to you): ${m(direct)}`)
console.log(`  cert - cash      ${m(cert - cash)}`)
await pool.end()
