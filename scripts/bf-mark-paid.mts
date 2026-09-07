/**
 * The 13 Bradfords invoices Tom settled in two Amex transactions on 7 Sep 2026.
 * Marks them paid in the OS. The Xero side is deliberately NOT touched: the
 * bills stay AUTHORISED so that when the two Amex lines reach the bank feed
 * Xero offers to MATCH them against these bills. Coding them to Building
 * Materials instead would reclaim the VAT a second time - the invoices already
 * carry it. See memory: vat-double-claim-trap.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const NUMS = ["78322984","78368056","78384088","78389147","78395807","78395354","78414666",
              "78430923","78425752","78425167","78446737","78456186","78469740"]
const NOTE = "Settled 7 Sep 2026 in two Amex transactions (Tom Gilbert). VAT is claimed on the invoices, never on the Amex payment."

const sup = await pool.query(`select id from suppliers where lower(name) like '%bradford%'`)
const ids = sup.rows.map((r: any) => r.id)
const before = await pool.query(
  `select invoice_number, payment_status, paid_date, gross from invoices
   where supplier_id = any($1) and invoice_number = any($2) order by invoice_date`, [ids, NUMS])
console.log(`${before.rows.length} matched in the OS`)
for (const r of before.rows) console.log(`  ${r.invoice_number}  ${String(r.payment_status).padEnd(10)}  paid_date ${r.paid_date ?? "-"}  ${Number(r.gross).toFixed(2)}`)

if (!EXECUTE) { console.log("\n(dry run - pass --execute)"); process.exit(0) }
const res = await pool.query(
  `update invoices set payment_status = 'paid', paid_date = '2026-09-07',
     amount_paid = gross,
     payment_notes = case when payment_notes is null or payment_notes = '' then $3
                          else payment_notes || ' | ' || $3 end
   where supplier_id = any($1) and invoice_number = any($2)
   returning invoice_number, payment_status, paid_date, amount_paid`, [ids, NUMS, NOTE])
console.log(`\nupdated ${res.rowCount} rows`)
const tot = res.rows.reduce((s: number, r: any) => s + Number(r.amount_paid), 0)
console.log(`total marked paid: ${tot.toFixed(2)}`)
process.exit(0)
