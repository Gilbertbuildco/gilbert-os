/**
 * Push Gilbert OS invoices into Xero as ACCPAY bills, with their document
 * attached, so a later bank payment can be matched to the bill instead of
 * being coded as unattributed "spend money".
 *
 * Owner instruction 2026-08-20: "find invoices in my emails, add them to the OS
 * and also Xero. When a payment shows in Xero, add the invoice and reconcile."
 *
 * SAFETY — why this only ever pushes UNPAID invoices:
 * This Xero holds 157 SPEND bank transactions (£621k) recorded straight against
 * expense accounts rather than against bills. Creating a bill for a cost whose
 * money has ALREADY gone out that way would post the expense twice. So a bill
 * is only created where the cost is still outstanding: OS says unpaid, Xero has
 * no matching bill, and no SPEND transaction matches that supplier+amount.
 * Everything else is reported for the owner, never written.
 *
 * Dry run by default; --execute to write. --limit N to cap.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
import { xeroFetch, xeroGet } from "../lib/xero/client.ts"

const EXECUTE = process.argv.includes("--execute")
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) ?? "").split("=")[1]) || Infinity

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const money = (v: unknown) => "£" + Number(v ?? 0).toFixed(2)
const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")

const pageAll = async (path: string, key: string) => {
  const all: any[] = []
  for (let page = 1; page < 30; page++) {
    const r = await xeroGet(`${path}${path.includes("?") ? "&" : "?"}page=${page}`, { headers: { Accept: "application/json" } })
    const d: any = await r.json()
    const items = d[key] ?? []
    all.push(...items)
    if (items.length < 100) break
  }
  return all
}

const bills = await pageAll(`/api.xro/2.0/Invoices?where=${encodeURIComponent('Type=="ACCPAY"')}`, "Invoices")
const spend = (await pageAll(`/api.xro/2.0/BankTransactions?where=${encodeURIComponent('Type=="SPEND"')}`, "BankTransactions")).filter((t) => t.Status !== "DELETED")
const contacts = await pageAll("/api.xro/2.0/Contacts", "Contacts")
const contactByName = new Map(contacts.map((c: any) => [norm(c.Name), c]))
// Account code per contact, learned from that supplier's own existing Xero
// coding (bills first, then spend transactions). Never guessed — a supplier with
// no coding history is skipped and reported.
const accountByContact = new Map<string, string>()
for (const b of bills) {
  const code = b.LineItems?.[0]?.AccountCode
  if (code && b.Contact?.Name) accountByContact.set(norm(b.Contact.Name), code)
}
const billKeys = new Set(bills.filter((b) => !["DELETED", "VOIDED"].includes(b.Status)).map((b: any) => `${norm(b.Contact?.Name)}|${norm(b.InvoiceNumber)}`))

// Resolve Xero contacts through the OS alias table — Xero says "Bradfords",
// the OS says "Bradfords Building Supplies Limited"; supplier_aliases already
// records that equivalence, so use it rather than guessing on name similarity.
for (const t of spend) {
  const code = t.LineItems?.[0]?.AccountCode
  const n = norm(t.Contact?.Name)
  if (code && n && !accountByContact.has(n)) accountByContact.set(n, code)
}

const { rows: aliasRows } = await pool.query(
  "SELECT a.supplier_id, a.normalised_name, a.raw_name, s.name AS supplier FROM supplier_aliases a JOIN suppliers s ON s.id = a.supplier_id")
const aliasesBySupplier = new Map<string, string[]>()
for (const a of aliasRows) {
  const list = aliasesBySupplier.get(a.supplier) ?? []
  list.push(a.normalised_name, a.raw_name)
  aliasesBySupplier.set(a.supplier, list)
}
const resolveContact = (supplierName: string) => {
  const direct = contactByName.get(norm(supplierName))
  if (direct) return direct
  for (const alias of aliasesBySupplier.get(supplierName) ?? []) {
    const hit = contactByName.get(norm(alias))
    if (hit) return hit
  }
  return null
}

const { rows: candidates } = await pool.query(`
  SELECT i.id, i.invoice_number, to_char(i.invoice_date,'YYYY-MM-DD') AS invoice_date,
         i.net, i.vat, i.gross, i.payment_status, i.source_file_pathname, i.source_file_name,
         s.name AS supplier, cp.code AS package_code
    FROM invoices i
    JOIN suppliers s ON s.id = i.supplier_id
    LEFT JOIN cost_packages cp ON cp.id = (
      SELECT li.cost_package_id FROM invoice_line_items li
       WHERE li.invoice_id = i.id AND li.cost_package_id IS NOT NULL LIMIT 1)
   WHERE i.status = 'confirmed'
     AND (i.payment_status IS NULL OR i.payment_status IN ('unpaid','part_paid'))
     AND i.transaction_type = 'invoice'
   ORDER BY i.invoice_date`)

console.log(`Mode: ${EXECUTE ? "EXECUTE" : "DRY RUN"}`)
console.log(`Unpaid OS invoices considered: ${candidates.length}`)

const plan: any[] = []
for (const c of candidates) {
  const k = `${norm(c.supplier)}|${norm(c.invoice_number)}`
  if (billKeys.has(k)) { console.log(`  SKIP-BILL-EXISTS  ${c.supplier} ${c.invoice_number}`); continue }
  const paidAlready = spend.find((t: any) => norm(t.Contact?.Name) === norm(c.supplier) && Math.abs(Number(t.Total) - Number(c.gross)) < 0.01)
  if (paidAlready) { console.log(`  SKIP-ALREADY-PAID-AS-SPEND  ${c.supplier} ${c.invoice_number} ${money(c.gross)} (bank tx ${paidAlready.BankTransactionID.slice(0,8)}) — creating a bill would double-count`); continue }
  const contact = resolveContact(c.supplier)
  if (!contact) { console.log(`  SKIP-NO-XERO-CONTACT  ${c.supplier} ${c.invoice_number} — owner must create the contact in Xero first`); continue }
  const account = accountByContact.get(norm(contact.Name)) ?? accountByContact.get(norm(c.supplier))
  if (!account) { console.log(`  SKIP-NO-ACCOUNT-CODE  ${c.supplier} ${c.invoice_number} — no prior Xero coding for this supplier to copy`); continue }
  plan.push({ ...c, contactId: contact.ContactID, accountCode: account })
}

console.log(`\n--- WOULD CREATE ${plan.length} BILLS ---`)
for (const p of plan.slice(0, LIMIT)) {
  console.log(`  ${p.invoice_date} ${p.supplier.slice(0,26).padEnd(27)} ${String(p.invoice_number).padEnd(14)} net ${money(p.net)} vat ${money(p.vat)} gross ${money(p.gross)}${p.source_file_pathname ? " +doc" : " (no document)"} [acct ${p.accountCode}]`)
}
console.log(`total: ${money(plan.slice(0, LIMIT).reduce((a, p) => a + Number(p.gross), 0))}`)

if (!EXECUTE) { console.log("\nDRY RUN — nothing written to Xero."); await pool.end(); process.exit(0) }

let created = 0, attached = 0
for (const p of plan.slice(0, LIMIT)) {
  const body = {
    Type: "ACCPAY",
    Contact: { ContactID: p.contactId },
    InvoiceNumber: p.invoice_number,
    Date: p.invoice_date,
    DueDate: p.invoice_date,
    Status: "AUTHORISED",
    LineAmountTypes: "Exclusive",
    Reference: "Higher Farm, Shepton Montague",
    LineItems: [{
      Description: `${p.supplier} invoice ${p.invoice_number}${p.package_code ? ` — cost package ${p.package_code}` : ""}`,
      Quantity: 1,
      UnitAmount: Number(p.net),
      AccountCode: p.accountCode,
      TaxType: Number(p.vat) > 0 ? "INPUT2" : "ZERORATEDINPUT",
    }],
  }
  const res = await xeroFetch("/api.xro/2.0/Invoices", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  })
  const txt = await res.text()
  const id = /"InvoiceID":\s*"([^"]+)"/.exec(txt)?.[1]
  if (!res.ok || !id) { console.log(`  FAILED ${p.invoice_number} -> ${res.status} ${txt.slice(0, 160)}`); continue }
  created++
  console.log(`  CREATED ${p.supplier} ${p.invoice_number} -> ${id}`)
  if (p.source_file_pathname) {
    try {
      const doc = await fetch(p.source_file_pathname)
      if (doc.ok) {
        const buf = Buffer.from(await doc.arrayBuffer())
        const name = (p.source_file_name || `${p.invoice_number}.pdf`).replace(/[^\w.\- ]/g, "_")
        const a = await xeroFetch(`/api.xro/2.0/Invoices/${id}/Attachments/${encodeURIComponent(name)}`, {
          method: "PUT", headers: { "Content-Type": "application/octet-stream", Accept: "application/json" }, body: buf,
        })
        if (a.ok) { attached++; console.log(`     +attached ${name}`) } else console.log(`     attach failed ${a.status}`)
      }
    } catch (e) { console.log(`     attach error: ${(e as Error).message}`) }
  }
}
console.log(`\nBills created: ${created} | documents attached: ${attached}`)
await pool.end()
