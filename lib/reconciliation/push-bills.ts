import "server-only"
import { pool } from "../db"
import { xeroFetch, xeroGet } from "../xero/client"

/**
 * Push Gilbert OS invoices into Xero as ACCPAY bills, with their document
 * attached, so a later bank payment can be matched to the bill instead of
 * being coded as unattributed "spend money".
 *
 * This is the ONE implementation — `scripts/push-invoices-to-xero.mts` (CLI)
 * and `app/api/cron/reconcile/route.ts` (daily cron) both call
 * `pushInvoicesToXero` below, so the anti-double-count guards below cannot
 * drift between the two call sites.
 *
 * Owner instruction 2026-08-20: "find invoices in my emails, add them to the OS
 * and also Xero. When a payment shows in Xero, add the invoice and reconcile."
 *
 * SAFETY — the three anti-double-count guards, all preserved verbatim from the
 * original script. Never weaken these:
 *   1. SKIP-BILL-EXISTS — a Xero ACCPAY bill (any non-DELETED/VOIDED status)
 *      already exists for this supplier+invoice-number key.
 *   2. SKIP-ALREADY-PAID-AS-SPEND — Xero holds a SPEND bank transaction for the
 *      same contact and the same gross amount (to the penny). This Xero holds
 *      SPEND bank transactions recorded straight against expense accounts
 *      rather than against bills; creating a bill for a cost whose money has
 *      ALREADY gone out that way would post the expense twice.
 *   3. SKIP-NO-XERO-CONTACT / SKIP-NO-ACCOUNT-CODE — never guessed: a contact
 *      that doesn't exist in Xero yet, or a supplier with no prior Xero
 *      account-code coding to copy, is reported and skipped, never invented.
 * So a bill is only created where the cost is still outstanding: OS says
 * unpaid/part_paid, Xero has no matching bill, and no SPEND transaction
 * matches that supplier+amount. Everything else is reported, never written.
 */

const money = (v: unknown) => Number(v ?? 0)
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")

async function pageAll(path: string, key: string) {
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

export type PushBillsSkip = { reason: string; supplier: string; invoiceNumber: string; amount: number }

export type PushBillsPlanned = {
  invoiceId: number
  supplier: string
  invoiceNumber: string
  invoiceDate: string
  net: number
  vat: number
  gross: number
  accountCode: string
  hasDocument: boolean
  packageCode: string | null
}

export type PushBillsCreatedBill = {
  invoiceId: number
  supplier: string
  invoiceNumber: string
  xeroInvoiceId: string
  attached: boolean
}

export type PushBillsFailed = { supplier: string; invoiceNumber: string; status: number; message: string }

export type PushBillsResult = {
  mode: "dry_run" | "execute"
  candidatesConsidered: number
  planned: PushBillsPlanned[]
  plannedTotal: number
  /** Count of bills actually created in Xero (0 in dry-run mode). */
  created: number
  /** Count of documents successfully attached (0 in dry-run mode). */
  attached: number
  createdBills: PushBillsCreatedBill[]
  skips: PushBillsSkip[]
  failed: PushBillsFailed[]
}

export async function pushInvoicesToXero({ execute, limit }: { execute: boolean; limit?: number }): Promise<PushBillsResult> {
  const LIMIT = limit && Number.isFinite(limit) && limit > 0 ? limit : Infinity

  const bills = await pageAll(`/api.xro/2.0/Invoices?where=${encodeURIComponent('Type=="ACCPAY"')}`, "Invoices")
  const spend = (await pageAll(`/api.xro/2.0/BankTransactions?where=${encodeURIComponent('Type=="SPEND"')}`, "BankTransactions")).filter(
    (t) => t.Status !== "DELETED",
  )
  const contacts = await pageAll("/api.xro/2.0/Contacts", "Contacts")
  const contactByName = new Map(contacts.map((c: any) => [norm(c.Name), c]))

  // Account code per contact, learned from that supplier's own existing Xero
  // coding (bills first, then spend transactions). Never guessed — a supplier
  // with no coding history is skipped and reported.
  const accountByContact = new Map<string, string>()
  for (const b of bills) {
    const code = b.LineItems?.[0]?.AccountCode
    if (code && b.Contact?.Name) accountByContact.set(norm(b.Contact.Name), code)
  }
  const billKeys = new Set(bills.filter((b: any) => !["DELETED", "VOIDED"].includes(b.Status)).map((b: any) => `${norm(b.Contact?.Name)}|${norm(b.InvoiceNumber)}`))

  for (const t of spend) {
    const code = t.LineItems?.[0]?.AccountCode
    const n = norm(t.Contact?.Name)
    if (code && n && !accountByContact.has(n)) accountByContact.set(n, code)
  }

  // Resolve Xero contacts through the OS alias table — Xero says "Bradfords",
  // the OS says "Bradfords Building Supplies Limited"; supplier_aliases already
  // records that equivalence, so use it rather than guessing on name similarity.
  const { rows: aliasRows } = await pool.query(
    "SELECT a.supplier_id, a.normalised_name, a.raw_name, s.name AS supplier FROM supplier_aliases a JOIN suppliers s ON s.id = a.supplier_id",
  )
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

  const skips: PushBillsSkip[] = []
  const plan: any[] = []
  for (const c of candidates) {
    const k = `${norm(c.supplier)}|${norm(c.invoice_number)}`
    if (billKeys.has(k)) {
      skips.push({ reason: "BILL_EXISTS", supplier: c.supplier, invoiceNumber: c.invoice_number, amount: money(c.gross) })
      continue
    }
    const paidAlready = spend.find((t: any) => norm(t.Contact?.Name) === norm(c.supplier) && Math.abs(Number(t.Total) - Number(c.gross)) < 0.01)
    if (paidAlready) {
      skips.push({ reason: "ALREADY_PAID_AS_SPEND", supplier: c.supplier, invoiceNumber: c.invoice_number, amount: money(c.gross) })
      continue
    }
    const contact = resolveContact(c.supplier)
    if (!contact) {
      skips.push({ reason: "NO_XERO_CONTACT", supplier: c.supplier, invoiceNumber: c.invoice_number, amount: money(c.gross) })
      continue
    }
    const account = accountByContact.get(norm((contact as any).Name)) ?? accountByContact.get(norm(c.supplier))
    if (!account) {
      skips.push({ reason: "NO_ACCOUNT_CODE", supplier: c.supplier, invoiceNumber: c.invoice_number, amount: money(c.gross) })
      continue
    }
    plan.push({ ...c, contactId: (contact as any).ContactID, accountCode: account })
  }

  const limited = plan.slice(0, LIMIT)
  const planned: PushBillsPlanned[] = limited.map((p) => ({
    invoiceId: p.id,
    supplier: p.supplier,
    invoiceNumber: p.invoice_number,
    invoiceDate: p.invoice_date,
    net: money(p.net),
    vat: money(p.vat),
    gross: money(p.gross),
    accountCode: p.accountCode,
    hasDocument: Boolean(p.source_file_pathname),
    packageCode: p.package_code ?? null,
  }))
  // Summed in whole pence, not float pounds, so the total never accumulates
  // binary-float drift regardless of how many bills are in the plan.
  const plannedTotal = planned.reduce((pence, p) => pence + Math.round(p.gross * 100), 0) / 100

  if (!execute) {
    return {
      mode: "dry_run",
      candidatesConsidered: candidates.length,
      planned,
      plannedTotal,
      created: 0,
      attached: 0,
      createdBills: [],
      skips,
      failed: [],
    }
  }

  let created = 0
  let attached = 0
  const createdBills: PushBillsCreatedBill[] = []
  const failed: PushBillsFailed[] = []

  for (const p of limited) {
    const body = {
      Type: "ACCPAY",
      Contact: { ContactID: p.contactId },
      InvoiceNumber: p.invoice_number,
      Date: p.invoice_date,
      DueDate: p.invoice_date,
      Status: "AUTHORISED",
      LineAmountTypes: "Exclusive",
      Reference: "Higher Farm, Shepton Montague",
      LineItems: [
        {
          Description: `${p.supplier} invoice ${p.invoice_number}${p.package_code ? ` — cost package ${p.package_code}` : ""}`,
          Quantity: 1,
          UnitAmount: Number(p.net),
          AccountCode: p.accountCode,
          TaxType: Number(p.vat) > 0 ? "INPUT2" : "ZERORATEDINPUT",
        },
      ],
    }
    const res = await xeroFetch("/api.xro/2.0/Invoices", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    })
    const txt = await res.text()
    const id = /"InvoiceID":\s*"([^"]+)"/.exec(txt)?.[1]
    if (!res.ok || !id) {
      failed.push({ supplier: p.supplier, invoiceNumber: p.invoice_number, status: res.status, message: txt.slice(0, 300) })
      continue
    }
    created++
    let wasAttached = false
    if (p.source_file_pathname) {
      try {
        const doc = await fetch(p.source_file_pathname)
        if (doc.ok) {
          const buf = Buffer.from(await doc.arrayBuffer())
          const name = (p.source_file_name || `${p.invoice_number}.pdf`).replace(/[^\w.\- ]/g, "_")
          const a = await xeroFetch(`/api.xro/2.0/Invoices/${id}/Attachments/${encodeURIComponent(name)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream", Accept: "application/json" },
            body: buf,
          })
          if (a.ok) {
            attached++
            wasAttached = true
          }
        }
      } catch {
        // Attachment failure is non-fatal — the bill itself is already created; report as not-attached.
      }
    }
    createdBills.push({ invoiceId: p.id, supplier: p.supplier, invoiceNumber: p.invoice_number, xeroInvoiceId: id, attached: wasAttached })
  }

  return {
    mode: "execute",
    candidatesConsidered: candidates.length,
    planned,
    plannedTotal,
    created,
    attached,
    createdBills,
    skips,
    failed,
  }
}
