/**
 * What it will cost to finish, in tiers of decreasing certainty.
 *
 * Owner estimates are NEVER blended into quoted figures. A number with a
 * supplier document behind it and a number the owner has allowed for are
 * different kinds of thing, and the difference has to survive to the screen.
 */
import { getCashPosition } from "../lib/funding/cash-position"
import { pool } from "../lib/db"
import { xeroGet } from "../lib/xero/client"
const m = (n: number) => `£${n.toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`
const p = (await getCashPosition(1))!

// Harlequin state their own remaining balance per plot on every invoice.
const HARLEQUIN_LEFT = 17345.00

/**
 * How much of a contract has been drawn is NOT simply what the OS has invoices
 * for. Several trades are paid against payments coded straight to a cost
 * account with no bill behind them — Rhys Harvey has £12,789.00 of spend on
 * account 5010 against only £2,025 of invoices in the OS. Counting invoices
 * alone said £25,960 was still to come when the true figure is far lower.
 *
 * So drawn = the greater of (OS invoices) and (money actually paid to that
 * supplier). A payment is proof the value has been drawn even when the
 * document has not reached us.
 */
const d = (v: any) => { const mm=/\/Date\((-?\d+)/.exec(String(v??"")); return mm ? new Date(Number(mm[1])).toISOString().slice(0,10) : "?" }
const spendRes = await xeroGet(`/api.xro/2.0/BankTransactions?where=${encodeURIComponent('Type=="SPEND"')}`, { headers: { Accept: "application/json" } })
const spendTx = (((await spendRes.json()) as any).BankTransactions ?? []).filter((t: any) => t.Status !== "DELETED")
const paidBySupplier = new Map<string, number>()
for (const t of spendTx) {
  const name = (t.Contact?.Name ?? "").toLowerCase()
  // Payments are gross; contracts are quoted ex-VAT. Use the line net where Xero has it.
  const net = (t.LineItems ?? []).reduce((a: number, l: any) => a + Number(l.LineAmount ?? 0), 0) || Number(t.Total)
  paidBySupplier.set(name, (paidBySupplier.get(name) ?? 0) + net)
}
const paidFor = (supplier: string) => {
  const key = supplier.toLowerCase()
  let best = 0
  for (const [n, v] of paidBySupplier) if (n.includes(key.split(" ")[0]) || key.includes(n.split(" ")[0])) best = Math.max(best, v)
  return best
}

const { rows: acc } = await pool.query(`
  SELECT COALESCE(s.name, q.supplier_name_raw) sup, SUM(q.net) quoted,
    COALESCE((SELECT SUM(i.net) FROM invoices i WHERE i.supplier_id=q.supplier_id AND i.status='confirmed'),0) inv
  FROM quotes q LEFT JOIN suppliers s ON s.id=q.supplier_id
  WHERE q.status='accepted' AND q.project_id=1 GROUP BY 1, q.supplier_id ORDER BY 2 DESC`)
const { rows: est } = await pool.query(`
  SELECT reference, COALESCE(supplier_name_raw,'—') sup, net, description FROM quotes
   WHERE status='estimate' AND project_id=1 ORDER BY net DESC`)

console.log("\n═══ 1. DUE NOW — invoices outstanding ═══")
console.log(`  ${m(p.outstandingNet).padStart(13)}  ex-VAT  (${m(p.outstandingGross)} gross, ${p.outstandingCount} invoices)`)

console.log("\n═══ 2. CONTRACTED — quote signed, work still to invoice ═══")
let contracted = HARLEQUIN_LEFT
console.log(`  ${m(HARLEQUIN_LEFT).padStart(13)}  HARLEQUIN  (Plot 2 £7,660 + Plot 3 £9,685, per their draw schedules)`)
for (const a of acc) {
  const invoiced = Number(a.inv)
  const paid = paidFor(String(a.sup))
  const drawn = Math.max(invoiced, paid)
  const left = Number(a.quoted) - drawn
  if (left <= 0.005) continue
  contracted += left
  const note = paid > invoiced ? `  [paid ${m(paid)} exceeds invoices ${m(invoiced)} — using paid]` : ""
  console.log(`  ${m(left).padStart(13)}  ${String(a.sup).slice(0,30).padEnd(31)} quoted ${m(Number(a.quoted))}, drawn ${m(drawn)}${note}`)
}
console.log(`  ${m(contracted).padStart(13)}  TOTAL contracted`)

console.log("\n═══ 3. OWNER ALLOWANCES — no supplier document ═══")
let estimated = 0
for (const e of est) { estimated += Number(e.net)
  console.log(`  ${m(Number(e.net)).padStart(13)}  ${String(e.description).slice(0,60)}`) }
console.log(`  ${m(estimated).padStart(13)}  TOTAL allowed`)

const toComplete = p.outstandingNet + contracted + estimated
console.log("\n═══ COST TO COMPLETE ═══")
console.log(`  due now        ${m(p.outstandingNet).padStart(13)}`)
console.log(`  contracted     ${m(contracted).padStart(13)}`)
console.log(`  allowances     ${m(estimated).padStart(13)}`)
console.log(`  ${"".padStart(15)}${"-".repeat(13)}`)
console.log(`  TOTAL          ${m(toComplete).padStart(13)}   <- everything known, ex-VAT`)
console.log(`\n  Left to draw   ${m(p.leftToDraw).padStart(13)}`)
console.log(`  ${p.leftToDraw >= toComplete ? "COVERED by    " : "SHORTFALL     "} ${m(Math.abs(p.leftToDraw - toComplete)).padStart(13)}`)
console.log(`\n  Lender budget unspent beyond this: ${m(p.leftToSpend - contracted - estimated)}`)
console.log(`  (that is allowance for work nobody has quoted or allowed for yet)`)
await pool.end()
