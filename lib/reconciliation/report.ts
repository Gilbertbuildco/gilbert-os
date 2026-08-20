import "server-only"
import { pool } from "../db"
import { normaliseSupplierName } from "../invoice-identity"
import { xeroGet } from "../xero/client"

/**
 * READ-ONLY three-way reconciliation report: Gilbert OS `invoices` vs Xero
 * ACCPAY bills vs Xero SPEND bank transactions. Reports only — never writes
 * anything, anywhere (rule 5/CLAUDE.md: "Reconciliation flags, never edits").
 *
 * The headline output is `paymentsMissingInvoice`: Xero SPEND bank
 * transactions (money that has actually left the bank account, coded
 * straight to an expense account rather than against a bill) that have no
 * matching Gilbert OS invoice behind them at all. The owner explicitly asked
 * to be told about these — a payment with no invoice is exactly the gap
 * `scripts/push-invoices-to-xero.mts`'s anti-double-count guard exists to
 * respect (never invoice something already paid as SPEND) but which, taken
 * the other way round, means nobody has captured what that money actually
 * bought.
 *
 * Matching: Xero `Contact.Name` -> normaliseSupplierName -> exact lookup
 * against `suppliers.name` (own name, normalised) or a learned
 * `supplier_aliases.normalised_name`, then an OS invoice for that supplier
 * with a gross amount matching to the penny. Never fuzzy, never a guess —
 * a SPEND transaction whose contact has no OS supplier match at all is still
 * reported (using the raw Xero contact name), because "no OS supplier"
 * is itself evidence there is no invoice for it.
 */

type XeroBill = { InvoiceID: string; Type: string; Status: string; Contact: { Name?: string } }

type XeroSpendTransaction = {
  BankTransactionID: string
  Type: string
  Status: string
  Contact: { Name?: string }
  Total: number
  Date?: string
  Reference?: string
}

/** Xero's `/Date(1763683200000+0000)/` wire format -> "YYYY-MM-DD" (UTC). Returns null rather than guessing on a bad shape. */
function xeroMsDateToIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/\/Date\((-?\d+)([+-]\d+)?\)\//)
  if (!m) return null
  const ms = Number(m[1])
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 10)
}

async function pageAll<T>(path: string, key: string): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; page < 30; page++) {
    const r = await xeroGet(`${path}${path.includes("?") ? "&" : "?"}page=${page}`, { headers: { Accept: "application/json" } })
    if (!r.ok) {
      const text = await r.text().catch(() => "")
      throw new Error(`Xero fetch ${path} (page ${page}) failed: HTTP ${r.status} ${text.slice(0, 300)}`)
    }
    const d: any = await r.json()
    const items = (d[key] ?? []) as T[]
    all.push(...items)
    if (items.length < 100) break
  }
  return all
}

export type PaymentMissingInvoice = {
  supplier: string
  date: string | null
  amount: number
  reference: string | null
}

export type ReconciliationReport = {
  counts: {
    accpayBills: number
    accpayBillsByStatus: Record<string, number>
    spendTransactions: number
    osInvoices: number
  }
  paymentsMissingInvoice: PaymentMissingInvoice[]
  paymentsMissingInvoiceTotal: number
  matchedSpendCount: number
}

export async function buildReconciliationReport(): Promise<ReconciliationReport> {
  const [bills, spendAll] = await Promise.all([
    pageAll<XeroBill>(`/api.xro/2.0/Invoices?where=${encodeURIComponent('Type=="ACCPAY"')}`, "Invoices"),
    pageAll<XeroSpendTransaction>(`/api.xro/2.0/BankTransactions?where=${encodeURIComponent('Type=="SPEND"')}`, "BankTransactions"),
  ])
  const spend = spendAll.filter((t) => t.Status !== "DELETED")

  const accpayBillsByStatus: Record<string, number> = {}
  for (const b of bills) accpayBillsByStatus[b.Status] = (accpayBillsByStatus[b.Status] || 0) + 1

  const { rows: suppliers } = await pool.query("SELECT id, name FROM suppliers ORDER BY id")
  const { rows: aliases } = await pool.query("SELECT supplier_id, normalised_name FROM supplier_aliases")
  const aliasMap = new Map<string, { id: number; name: string }>()
  for (const s of suppliers) aliasMap.set(normaliseSupplierName(s.name), { id: s.id, name: s.name })
  for (const a of aliases) {
    const supplier = suppliers.find((s: any) => s.id === a.supplier_id)
    if (supplier) aliasMap.set(a.normalised_name, { id: supplier.id, name: supplier.name })
  }

  const { rows: osInvoices } = await pool.query(`
    SELECT i.id, i.supplier_id, s.name AS supplier_name, i.gross
      FROM invoices i
      JOIN suppliers s ON s.id = i.supplier_id
     WHERE i.transaction_type = 'invoice' AND i.gross IS NOT NULL
  `)
  const osInvoicesBySupplier = new Map<number, number[]>()
  for (const inv of osInvoices) {
    const arr = osInvoicesBySupplier.get(inv.supplier_id) ?? []
    arr.push(Number(inv.gross))
    osInvoicesBySupplier.set(inv.supplier_id, arr)
  }

  const paymentsMissingInvoice: PaymentMissingInvoice[] = []
  let matchedSpendCount = 0

  for (const t of spend) {
    const contactName = (t.Contact?.Name ?? "").trim()
    const supplier = contactName ? aliasMap.get(normaliseSupplierName(contactName)) : undefined
    const amount = Number(t.Total)

    const grossAmounts = supplier ? osInvoicesBySupplier.get(supplier.id) : undefined
    const hasMatchingInvoice = (grossAmounts ?? []).some((g) => Math.abs(g - amount) < 0.01)

    if (hasMatchingInvoice) {
      matchedSpendCount++
      continue
    }

    paymentsMissingInvoice.push({
      supplier: supplier?.name ?? (contactName || "(no contact name)"),
      date: xeroMsDateToIso(t.Date),
      amount,
      reference: t.Reference?.trim() || null,
    })
  }

  // Summed in whole pence, not float pounds, so a long list of amounts never
  // accumulates binary-float drift into a total that gets persisted.
  const paymentsMissingInvoiceTotal =
    paymentsMissingInvoice.reduce((pence, p) => pence + Math.round(p.amount * 100), 0) / 100

  return {
    counts: {
      accpayBills: bills.length,
      accpayBillsByStatus,
      spendTransactions: spend.length,
      osInvoices: osInvoices.length,
    },
    paymentsMissingInvoice,
    paymentsMissingInvoiceTotal,
    matchedSpendCount,
  }
}
