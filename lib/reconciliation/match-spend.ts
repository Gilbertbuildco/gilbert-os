import "server-only"
import { pool } from "../db"
import { normaliseSupplierName } from "../invoice-identity"
import { xeroGet } from "../xero/client"

/**
 * Match Xero SPEND bank transactions (money that actually left the account)
 * against Gilbert OS invoices that are not yet marked paid.
 *
 * WHY THIS EXISTS
 *   `sync-payments.ts` only reads ACCPAY bills. Most costs in this Xero are
 *   recorded as SPEND bank transactions with no bill behind them, so an invoice
 *   settled straight from the bank stayed "unpaid" in the OS for ever and the
 *   daily job never noticed. Owner instruction 2026-08-21: "You also need to
 *   scan Xero daily, so you can see payments that have been made and alter the
 *   OS accordingly."
 *
 * MATCHING — exact only, never fuzzy, never guessed
 *   Supplier  Xero Contact.Name -> normaliseSupplierName -> exact hit on
 *             suppliers.name or a learned supplier_aliases.normalised_name.
 *             No supplier is ever created.
 *   Amount    SPEND Total === invoice gross, to the penny.
 *   Date      payment on/after (invoice_date - 3 days) and within 200 days.
 *
 * NO DOUBLE-COUNTING (non-negotiable 8)
 *   - A SPEND transaction settles at most ONE invoice; an invoice is settled by
 *     at most ONE SPEND. Both sides are consumed on use.
 *   - A SPEND whose amount fits two or more candidate invoices is AMBIGUOUS:
 *     reported, never applied.
 *   - A SPEND already accounted for by a Xero bill payment is skipped, so the
 *     same money is never recognised twice.
 *
 * BULK PAYMENTS are reported, never applied. Merchants like Bradfords are paid
 * in lump sums covering many invoices (owner rule: he names the numbers). Where
 * a SPEND total equals the exact sum of 2-5 unpaid invoices for that supplier
 * this reports it as a candidate for the owner to confirm.
 *
 * PROTECTED  A row whose payment_notes mentions "owner" is an owner assertion
 *            and is never downgraded here; it is reported as a protected skip.
 *
 * SAFETY     Xero access is GET-only via xeroGet. This module never inserts or
 *            deletes; it updates payment_status / paid_date / payment_notes on
 *            existing rows only, and only when `execute` is true.
 */

type XeroSpend = {
  BankTransactionID: string
  Type: string
  Status: string
  Contact?: { Name?: string }
  Date?: string
  Total: number
  IsReconciled?: boolean
  LineItems?: { Description?: string }[]
}

function xeroMsDateToIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//)
  if (!m) return null
  const ms = Number(m[1])
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 10)
}

const pence = (n: number) => Math.round(Number(n) * 100)
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000

export type SpendMatch = {
  invoiceId: number
  invoiceNumber: string
  supplier: string
  invoiceDate: string
  gross: number
  from: string | null
  paidDate: string
  spendId: string
  reference: string
  reconciled: boolean
}
export type SpendAmbiguous = { supplier: string; paidDate: string; amount: number; candidates: string[] }
export type SpendBulkCandidate = { supplier: string; paidDate: string; amount: number; invoices: { number: string; gross: number }[] }
export type SpendProtected = { invoiceNumber: string; supplier: string; note: string }
export type SpendNoInvoice = { supplier: string; paidDate: string; amount: number; reference: string }

export type MatchSpendResult = {
  spendFetched: number
  applied: number
  matches: SpendMatch[]
  ambiguous: SpendAmbiguous[]
  bulkCandidates: SpendBulkCandidate[]
  protectedSkips: SpendProtected[]
  noInvoice: SpendNoInvoice[]
  missingTotal: number
  errors: string[]
}

async function fetchAllSpend(): Promise<XeroSpend[]> {
  const all: XeroSpend[] = []
  for (let page = 1; page <= 200; page++) {
    const res = await xeroGet(`/api.xro/2.0/BankTransactions?where=${encodeURIComponent('Type=="SPEND"')}&page=${page}`, {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) throw new Error(`Xero BankTransactions page ${page}: ${res.status} ${await res.text().catch(() => "")}`)
    const body = (await res.json()) as { BankTransactions?: XeroSpend[] }
    const rows = body.BankTransactions ?? []
    all.push(...rows)
    if (rows.length < 100) break
  }
  return all.filter((t) => t.Status !== "DELETED" && t.Status !== "VOIDED")
}

export async function matchSpendToInvoices({ execute }: { execute: boolean }): Promise<MatchSpendResult> {
  const errors: string[] = []
  const spend = await fetchAllSpend()

  const suppliersRes = await pool.query("SELECT id, name FROM suppliers ORDER BY id")
  const aliasRes = await pool.query("SELECT supplier_id, normalised_name FROM supplier_aliases")
  const aliasMap = new Map<string, { id: number; name: string }>()
  for (const s of suppliersRes.rows) aliasMap.set(normaliseSupplierName(s.name), { id: s.id, name: s.name })
  for (const a of aliasRes.rows) {
    const s = suppliersRes.rows.find((r: any) => r.id === a.supplier_id)
    if (s) aliasMap.set(a.normalised_name, { id: s.id, name: s.name })
  }

  // Every confirmed invoice, so we can tell "already paid" (SPEND accounted for)
  // from "awaiting payment" (SPEND is a candidate).
  const invRes = await pool.query(`
    SELECT i.id, i.supplier_id, s.name AS supplier_name, i.invoice_number,
           to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
           i.gross, i.payment_status, i.payment_notes
      FROM invoices i
      JOIN suppliers s ON s.id = i.supplier_id
     WHERE i.status = 'confirmed' AND i.transaction_type = 'invoice'
     ORDER BY i.invoice_date, i.id`)
  const invoices = invRes.rows.map((r: any) => ({
    id: r.id as number,
    supplierId: r.supplier_id as number,
    supplier: r.supplier_name as string,
    number: (r.invoice_number ?? "") as string,
    date: r.invoice_date as string,
    gross: Number(r.gross),
    status: (r.payment_status ?? null) as string | null,
    notes: (r.payment_notes ?? "") as string,
  }))

  const matches: SpendMatch[] = []
  const ambiguous: SpendAmbiguous[] = []
  const bulkCandidates: SpendBulkCandidate[] = []
  const protectedSkips: SpendProtected[] = []
  const noInvoice: SpendNoInvoice[] = []
  const usedInvoiceIds = new Set<number>()

  // Oldest payment first, so a run of identical monthly amounts pairs off in
  // date order rather than an arbitrary one.
  const spendByDate = [...spend].sort((a, b) => (xeroMsDateToIso(a.Date) ?? "").localeCompare(xeroMsDateToIso(b.Date) ?? ""))
  for (const tx of spendByDate) {
    const paidDate = xeroMsDateToIso(tx.Date)
    const contact = (tx.Contact?.Name ?? "").trim()
    const supplier = contact ? aliasMap.get(normaliseSupplierName(contact)) : undefined
    const reference = (tx.LineItems ?? [])[0]?.Description ?? ""
    const amount = pence(tx.Total)
    if (!paidDate || !supplier) {
      noInvoice.push({ supplier: contact || "(no contact)", paidDate: paidDate ?? "?", amount: tx.Total, reference })
      continue
    }

    const forSupplier = invoices.filter((i) => i.supplierId === supplier.id)
    const inWindow = (i: (typeof invoices)[number]) => {
      const d = daysBetween(i.date, paidDate)
      return d >= -3 && d <= 200
    }

    // Already accounted for? A paid invoice of exactly this amount means this
    // money is recognised — recognising it again would double-count.
    //
    // The paid invoice is CONSUMED when it absorbs a payment. Without that, a
    // supplier billing the same amount every month hides every later payment:
    // George Wilson invoices £6,000 monthly, so SM01-SM06 (all paid) absorbed
    // every £6,000 payment in the window and SM07 could never match, even
    // though its payment was sitting in Xero. One invoice settles one payment,
    // on both sides.
    const settled = forSupplier.find(
      (i) => i.status === "paid" && pence(i.gross) === amount && inWindow(i) && !usedInvoiceIds.has(i.id),
    )
    if (settled) {
      usedInvoiceIds.add(settled.id)
      continue
    }

    const candidates = forSupplier.filter((i) => i.status !== "paid" && !usedInvoiceIds.has(i.id) && pence(i.gross) === amount && inWindow(i))

    if (candidates.length === 1) {
      const inv = candidates[0]
      if (/owner/i.test(inv.notes)) {
        protectedSkips.push({ invoiceNumber: inv.number, supplier: inv.supplier, note: inv.notes.slice(0, 120) })
        continue
      }
      usedInvoiceIds.add(inv.id)
      matches.push({
        invoiceId: inv.id, invoiceNumber: inv.number, supplier: inv.supplier, invoiceDate: inv.date,
        gross: inv.gross, from: inv.status, paidDate, spendId: tx.BankTransactionID,
        reference, reconciled: Boolean(tx.IsReconciled),
      })
      continue
    }
    if (candidates.length > 1) {
      ambiguous.push({ supplier: supplier.name, paidDate, amount: tx.Total, candidates: candidates.map((c) => c.number) })
      continue
    }

    // No single invoice fits. Could this lump sum be several invoices at once?
    const open = forSupplier.filter((i) => i.status !== "paid" && !usedInvoiceIds.has(i.id) && inWindow(i))
    const combo = findSubset(open.map((i) => ({ number: i.number, gross: i.gross })), amount, 5)
    if (combo) {
      bulkCandidates.push({ supplier: supplier.name, paidDate, amount: tx.Total, invoices: combo })
      continue
    }
    noInvoice.push({ supplier: supplier.name, paidDate, amount: tx.Total, reference })
  }

  // --- Apply (single exact matches only; bulk and ambiguous are owner calls) ---
  let applied = 0
  if (execute) {
    for (const m of matches) {
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        // Re-check immediately before writing: never overwrite a row that moved.
        const cur = await client.query("SELECT payment_status, payment_notes FROM invoices WHERE id = $1 FOR UPDATE", [m.invoiceId])
        const row = cur.rows[0]
        if (!row || row.payment_status === "paid" || /owner/i.test(row.payment_notes ?? "")) {
          await client.query("ROLLBACK")
          continue
        }
        const note = `Matched to Xero bank payment ${m.paidDate} £${m.gross.toFixed(2)}${m.reference ? ` ("${m.reference}")` : ""} — SPEND ${m.spendId}.`
        await client.query(
          `UPDATE invoices SET payment_status = 'paid', paid_date = $2::date,
             payment_notes = CASE WHEN COALESCE(payment_notes,'') = '' THEN $3 ELSE payment_notes || ' | ' || $3 END
           WHERE id = $1`,
          [m.invoiceId, m.paidDate, note],
        )
        await client.query("COMMIT")
        applied++
      } catch (e: any) {
        await client.query("ROLLBACK").catch(() => {})
        errors.push(`invoice ${m.invoiceNumber}: ${e.message}`)
      } finally {
        client.release()
      }
    }
  }

  return {
    spendFetched: spend.length,
    applied,
    matches,
    ambiguous,
    bulkCandidates,
    protectedSkips,
    noInvoice,
    missingTotal: noInvoice.reduce((s, n) => s + n.amount, 0),
    errors,
  }
}

/** Exact subset of invoice amounts summing to `targetPence`, up to `maxSize` items. Returns the first found, or null. */
function findSubset(items: { number: string; gross: number }[], targetPence: number, maxSize: number): { number: string; gross: number }[] | null {
  if (items.length === 0 || items.length > 24) return null
  let found: { number: string; gross: number }[] | null = null
  const walk = (start: number, acc: { number: string; gross: number }[], sum: number) => {
    if (found) return
    if (sum === targetPence && acc.length >= 2) { found = [...acc]; return }
    if (sum >= targetPence || acc.length >= maxSize) return
    for (let i = start; i < items.length; i++) {
      acc.push(items[i])
      walk(i + 1, acc, sum + pence(items[i].gross))
      acc.pop()
      if (found) return
    }
  }
  walk(0, [], 0)
  return found
}
