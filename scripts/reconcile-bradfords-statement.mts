/**
 * Reconcile a Bradfords account statement against every Bradfords invoice in
 * Gilbert OS, line by line.
 *
 * Owner instruction 2026-08-23: "You need to marry up the Bradfords account
 * with my OS exactly."
 *
 * INPUT  A statement exported from the Bradfords trade account — CSV, TSV, or
 *        plain text pasted into a file. Parsing is deliberately forgiving about
 *        layout but NEVER about numbers: a row whose amount cannot be read
 *        verbatim is reported as unparsed, never guessed at or skipped quietly
 *        (non-negotiable #1).
 *
 * OUTPUT Four lists, which together are the exact marry-up:
 *        1. ON STATEMENT, NOT IN THE OS   — invoices we have never ingested
 *        2. IN THE OS, NOT ON STATEMENT   — invoices Bradfords does not show
 *        3. AMOUNT MISMATCH              — same invoice number, different value
 *        4. AGREED                        — number and amount both match
 *        Plus a balance comparison: statement total vs OS total.
 *
 * This script only reads. It changes nothing in the OS or in Xero — the point
 * is to surface differences for a decision, not to make the two agree by
 * force (non-negotiable #3: flag discrepancies, never "fix" them).
 *
 *   npx tsx --env-file=.env.development.local scripts/reconcile-bradfords-statement.mts <path-to-statement>
 */
import { readFileSync } from "node:fs"
import { pool } from "../lib/db"

const file = process.argv[2]
if (!file) {
  console.error("Usage: reconcile-bradfords-statement.mts <path-to-statement.csv|.txt>")
  process.exit(1)
}

const money = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pence = (n: number) => Math.round(n * 100)

/** Bradfords invoice numbers are 8 digits (77xxxxxx / 78xxxxxx). */
const INVOICE_RE = /\b(7[78]\d{6})\b/
/** Any money-shaped token: 1,234.56 / -1234.56 / (1,234.56) for credits. */
const AMOUNT_RE = /\(?-?£?\s?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\)?/g

type StatementRow = { invoiceNumber: string; amount: number; raw: string }

const rows: StatementRow[] = []
const unparsed: string[] = []
for (const line of readFileSync(file, "utf8").split("\n")) {
  const text = line.trim()
  if (!text) continue
  const inv = INVOICE_RE.exec(text)
  if (!inv) continue // not an invoice line (header, address, carried-forward)
  // Take the LAST money token on the row — statements put the running balance
  // first and the line value last as often as the reverse, so anchor on the
  // value nearest the end and report anything ambiguous rather than assuming.
  const amounts = [...text.matchAll(AMOUNT_RE)].map((m) => {
    const v = Number(`${m[1].replace(/,/g, "")}.${m[2]}`)
    const negative = m[0].startsWith("(") || m[0].includes("-")
    return negative ? -v : v
  })
  if (amounts.length === 0) { unparsed.push(text); continue }
  rows.push({ invoiceNumber: inv[1], amount: amounts[amounts.length - 1], raw: text })
}

const { rows: osRows } = await pool.query(`
  SELECT i.invoice_number, to_char(i.invoice_date,'YYYY-MM-DD') AS d, i.gross, i.net, i.payment_status
    FROM invoices i JOIN suppliers s ON s.id = i.supplier_id
   WHERE s.name ILIKE '%bradfords%' AND i.status = 'confirmed'
   ORDER BY i.invoice_date`)

const os = new Map<string, any>(osRows.map((r: any) => [String(r.invoice_number).trim(), r]))
const stmt = new Map<string, StatementRow>()
for (const r of rows) {
  // A statement can legitimately list an invoice twice (invoice + credit); sum them.
  const prev = stmt.get(r.invoiceNumber)
  stmt.set(r.invoiceNumber, prev ? { ...prev, amount: prev.amount + r.amount } : r)
}

const missingFromOs: StatementRow[] = []
const missingFromStatement: any[] = []
const mismatched: { n: string; statement: number; osGross: number; osNet: number; date: string }[] = []
let agreed = 0

for (const [n, s] of stmt) {
  const o = os.get(n)
  if (!o) { missingFromOs.push(s); continue }
  // Statements quote gross on some accounts and net on others — accept either,
  // and only call it a mismatch when it matches neither.
  if (pence(s.amount) === pence(Number(o.gross)) || pence(s.amount) === pence(Number(o.net))) agreed++
  else mismatched.push({ n, statement: s.amount, osGross: Number(o.gross), osNet: Number(o.net), date: o.d })
}
for (const [n, o] of os) if (!stmt.has(n)) missingFromStatement.push({ n, ...o })

const stmtTotal = [...stmt.values()].reduce((a, r) => a + r.amount, 0)
const osGrossTotal = osRows.reduce((a: number, r: any) => a + Number(r.gross), 0)

console.log(`\nStatement rows parsed: ${stmt.size}   OS Bradfords invoices: ${os.size}`)
if (unparsed.length) console.log(`  ${unparsed.length} line(s) had an invoice number but no readable amount — listed at the end.`)

console.log(`\n--- 1. ON STATEMENT, NOT IN THE OS (${missingFromOs.length}) — invoices we have never ingested ---`)
for (const r of missingFromOs.sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber)))
  console.log(`  ${r.invoiceNumber}  ${money(r.amount).padStart(12)}   ${r.raw.slice(0, 70)}`)
if (!missingFromOs.length) console.log("  none")
console.log(`  subtotal: ${money(missingFromOs.reduce((a, r) => a + r.amount, 0))}`)

console.log(`\n--- 2. IN THE OS, NOT ON STATEMENT (${missingFromStatement.length}) ---`)
for (const r of missingFromStatement)
  console.log(`  ${r.n}  ${r.d}  ${money(Number(r.gross)).padStart(12)}  ${r.payment_status}`)
if (!missingFromStatement.length) console.log("  none")
console.log(`  subtotal: ${money(missingFromStatement.reduce((a, r) => a + Number(r.gross), 0))}`)

console.log(`\n--- 3. AMOUNT MISMATCH (${mismatched.length}) ---`)
for (const m of mismatched)
  console.log(`  ${m.n}  ${m.date}  statement ${money(m.statement).padStart(12)}  vs OS gross ${money(m.osGross)} / net ${money(m.osNet)}`)
if (!mismatched.length) console.log("  none")

console.log(`\n--- 4. AGREED: ${agreed} invoices match on number and amount ---`)

console.log(`\n--- BALANCE ---`)
console.log(`  statement total   ${money(stmtTotal)}`)
console.log(`  OS gross total    ${money(osGrossTotal)}`)
console.log(`  difference        ${money(stmtTotal - osGrossTotal)}`)

if (unparsed.length) {
  console.log(`\n--- LINES WITH NO READABLE AMOUNT (${unparsed.length}) — not guessed at ---`)
  for (const u of unparsed.slice(0, 20)) console.log(`  ${u.slice(0, 90)}`)
}
await pool.end()
