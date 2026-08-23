/**
 * What it will cost to finish, in tiers of decreasing certainty.
 *
 * Owner estimates are NEVER blended into quoted figures. A number with a
 * supplier document behind it and a number the owner has allowed for are
 * different kinds of thing, and the difference has to survive to the screen.
 */
import { getCashPosition } from "../lib/funding/cash-position"
import { pool } from "../lib/db"
const m = (n: number) => `£${n.toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`
const p = (await getCashPosition(1))!

// Harlequin state their own remaining balance per plot on every invoice.
const HARLEQUIN_LEFT = 17345.00

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
  const left = Number(a.quoted) - Number(a.inv)
  if (left <= 0.005) continue
  contracted += left
  console.log(`  ${m(left).padStart(13)}  ${String(a.sup).slice(0,34).padEnd(35)} quoted ${m(Number(a.quoted))}, invoiced ${m(Number(a.inv))}`)
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
