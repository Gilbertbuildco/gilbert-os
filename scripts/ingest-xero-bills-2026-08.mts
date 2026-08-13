/**
 * Ingest the "complete" batch of Xero ACCPAY bills (PAID status, excluding
 * Bradfords/Travis Perkins which already have their own dedicated pipelines
 * and supplier records) into Gilbert OS as confirmed invoices.
 *
 * SOURCE DATA
 *   A read-only Xero pull already sitting on disk (see scripts/../xero-pull.mts
 *   for how it was produced): { pulledAt, bills, spend, contacts }, where
 *   `bills` is every ACCPAY invoice from `GET /api.xro/2.0/Invoices?where=Type=="ACCPAY"`.
 *   Default path is the scratchpad location it was pulled to; override with
 *   --source=<path> if it moves.
 *
 * FILTER (exactly as specified)
 *   Status === "PAID", and Contact.Name does NOT match /bradford|travis/i
 *   (those suppliers/pipelines are owned elsewhere and must not be touched
 *   or duplicated by this script).
 *
 * WHY NOT go through commitInvoice() DIRECTLY
 *   Same reasoning as scripts/ingest-text-layer.mjs (read that file's header
 *   before changing this one): commitInvoice calls revalidatePath, which
 *   throws outside a real Next.js request context — AFTER the real write has
 *   already committed. Per instructions this script does not invent a second,
 *   weaker commit path: commitOne() below reproduces commitInvoice's
 *   transaction body verbatim in shape (same app-level duplicate re-check,
 *   same column mapping, same classification_mappings/supplier_aliases
 *   upserts, same price_records gating) minus the two revalidatePath calls.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 *   - No cost-package classification. `cost_package_id` is NULL on every
 *     line, always — the owner classifies later. Never guessed.
 *   - No price-DB writes. `product_id` is NULL and `is_price_tracked` is
 *     false on EVERY line, regardless of description — these are Xero AP
 *     bills (many of them plant hire, professional fees, insurance,
 *     utilities, scaffolding, and what look like individual subcontractor/
 *     labour payments), not a parsed materials invoice. Routing any of them
 *     into price_records would violate non-negotiable #8 (price DB stays
 *     genuine comparable materials only) and risks non-negotiable #11 (own
 *     labour/subcontract must not enter the supplier-material pipeline).
 *   - No supplier fuzzy-matching. Resolution is EXACT-normalised-name only
 *     (own name or a learned alias) — see "SUPPLIER RESOLUTION" below for why
 *     this matters for the three distinct Crestmoor entities.
 *   - No Xero writes of any kind (`lib/xero/client.ts`'s xeroGet cannot even
 *     express a non-GET call; XERO_WRITE_ENABLED is irrelevant here).
 *
 * SUPPLIER RESOLUTION
 *   Gilbert OS already has "Crestmoor Group of Companies" (id 5, one
 *   invoice). This Xero batch separately contains "Crestmoor Plant Hire" and
 *   "Crestmoor Construction Services Ltd" — two more Crestmoor-branded
 *   entities. normaliseSupplierName gives three DIFFERENT normalised keys
 *   ("crestmoor of companies" / "crestmoor plant hire" / "crestmoor
 *   construction services"), so exact-match resolution naturally keeps them
 *   as three distinct supplier records. This is deliberate: the owner has not
 *   confirmed whether these are the same legal entity trading under multiple
 *   names, sister companies, or unrelated businesses that happen to share a
 *   word. Merging them would risk misattributing spend (non-negotiable #8) on
 *   a guess. Flagged explicitly in the run's summary — never resolved here.
 *
 * DUPLICATE PROTECTION (same layers as ingest-text-layer.mjs)
 *   (a) pre-flight check against every invoice already in the DB for the
 *       resolved supplier (existing suppliers only — a brand-new supplier
 *       cannot collide by construction),
 *   (b) an intra-batch guard so two bills in THIS run resolving to the same
 *       (normalised contact, normalised number) can't both insert,
 *   (c) an in-transaction re-check identical in shape to commitInvoice's,
 *   (d) the DB's partial unique index invoices_supplier_type_number_uidx as
 *       the final backstop. A duplicate write commits nothing — no invoice,
 *       no line items.
 *
 * LINE-ITEM RECONCILIATION
 *   Xero's `LineAmountTypes` varies per bill ("Exclusive" vs "Inclusive").
 *   For "Inclusive" bills, `LineItem.LineAmount` is the GROSS line total, not
 *   net — the true net is `LineAmount - TaxAmount` (both are real, given
 *   values; this is arithmetic, not inference). Getting this wrong makes
 *   otherwise-perfectly-reconciling bills look mismatched. Each bill's
 *   line-derived net/vat is summed and compared to SubTotal/TotalTax; a
 *   mismatch collapses to ONE line for the header net, `reconciled=false`,
 *   exactly like ingest-text-layer.mjs's fallback.
 *
 * SAFETY
 *   --dry-run is the default (no --execute needed to preview). In dry-run
 *   mode the ONLY network calls are Xero GETs (listing each candidate bill's
 *   attachments, to report filenames/sizes and to prove retention is
 *   possible) — no Xero writes (impossible via xeroGet), no Blob uploads, no
 *   DB writes. --execute is required to write anything, and additionally
 *   downloads attachment bytes and uploads them to Vercel Blob before
 *   committing each invoice (source documents are never discarded — a bill
 *   with zero retrievable attachments is refused, never committed without a
 *   retained source file).
 *
 * USAGE
 *   npx tsx --env-file=.env.local --env-file=.env.development.local \
 *     scripts/ingest-xero-bills-2026-08.mts [options]
 *
 *   --source=<path>   Path to the pulled Xero JSON (default: scratchpad copy)
 *   --limit=<n>        Only plan/process the first n qualifying bills (date order)
 *   --project-id=<n>   Defaults to 1 (Higher Farm) — verified to exist before use
 *   --execute          Actually write (omit for dry run)
 */

import { createHash } from "node:crypto"
import { Pool } from "pg"
import { put } from "@vercel/blob"
import { xeroGet } from "../lib/xero/client.ts"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
function flag(name: string): boolean {
  return args.includes(`--${name}`)
}
function opt(name: string, def: string | null): string | null {
  const pref = `--${name}=`
  const hit = args.find((a) => a.startsWith(pref))
  return hit ? hit.slice(pref.length) : def
}

const EXECUTE = flag("execute")
const DRY_RUN = !EXECUTE
const LIMIT = opt("limit", null) ? parseInt(opt("limit", null) as string, 10) : null
const SOURCE = opt(
  "source",
  "/private/tmp/claude-501/-Users-tomgilbert-GilbertOS/e8dd9cc9-acd8-4425-b9b3-13e379ac71de/scratchpad/xero-purchases.json",
) as string
const PROJECT_ID = parseInt(opt("project-id", "1") as string, 10)

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run with --env-file=.env.development.local (see file header).")
  process.exit(1)
}
if (EXECUTE && !process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set — required for --execute (source PDFs must be retained in Blob).")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Pure helpers, reproduced verbatim from lib/invoice-identity.ts and
// lib/normalisation/products.ts (this is a standalone script, matching the
// pattern in scripts/ingest-text-layer.mjs — reproduced, not imported, so
// drift can be caught by re-diffing against the source files noted).
// ---------------------------------------------------------------------------

// --- lib/invoice-identity.ts -------------------------------------------------
function normaliseSupplierName(raw: string | null | undefined): string {
  if (!raw) return ""
  let s = raw.toLowerCase()
  s = s.replace(/&/g, " and ")
  s = s.replace(/[^a-z0-9\s]/g, " ")
  const stopWords = new Set([
    "ltd", "limited", "plc", "llp", "llc", "inc", "incorporated", "co", "company", "group", "holdings", "uk", "the",
  ])
  s = s.split(/\s+/).filter((w) => w && !stopWords.has(w)).join(" ")
  return s.trim()
}

function normaliseDocNumber(raw: string | null | undefined): string {
  if (!raw) return ""
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").trim()
}

// ---------------------------------------------------------------------------
// Xero bill shapes (subset actually used)
// ---------------------------------------------------------------------------

type XeroLineItem = {
  Description: string
  Quantity: number | null
  UnitAmount: number | null
  TaxType?: string
  TaxAmount: number
  LineAmount: number
  AccountCode?: string
}

type XeroBill = {
  Type: string
  InvoiceID: string
  InvoiceNumber: string
  Reference?: string
  Contact: { ContactID: string; Name: string }
  DateString: string
  Status: string
  LineAmountTypes: "Exclusive" | "Inclusive" | "NoTax"
  LineItems: XeroLineItem[]
  SubTotal: number
  TotalTax: number
  Total: number
  HasAttachments: boolean
  FullyPaidOnDate?: string
  Payments?: { Reference?: string; Amount?: number; Date?: string }[]
}

/** Xero DateString is "YYYY-MM-DDT00:00:00" — take the calendar date verbatim. */
function xeroDateStringToIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T/)
  return m ? m[1] : null
}

/** Xero's `/Date(1763683200000+0000)/` wire format -> "YYYY-MM-DD" (UTC). Returns null rather than guessing on a bad shape. */
function xeroMsDateToIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//)
  if (!m) return null
  const ms = Number(m[1])
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 10)
}

function money(n: number | null | undefined): number {
  return n == null || !Number.isFinite(n) ? 0 : n
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

type SupplierResolution =
  | { kind: "existing"; id: number; name: string }
  | { kind: "new"; id: null; name: string }

type PlanLine = {
  description: string
  quantity: number | null
  unitPriceExVat: number | null
  lineNet: number
  lineVat: number
  vatRate: number | null
}

type PlanRow = {
  action: "INSERT" | "SKIP-DUPLICATE-DB" | "SKIP-DUPLICATE-BATCH" | "ERROR"
  bill: XeroBill
  reason?: string
  supplier?: SupplierResolution
  invoiceNumber?: string
  invoiceDate?: string | null
  net?: number
  vat?: number
  gross?: number
  paidDate?: string | null
  paymentNotes?: string | null
  lines?: PlanLine[]
  reconciled?: boolean
  attachmentFileName?: string | null
  attachmentUrl?: string | null
  attachmentMimeType?: string | null
  extraAttachmentUrls?: string[]
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no DB writes, no Blob uploads)" : "EXECUTE (will write)"}`)
  console.log(`Source: ${SOURCE}`)
  console.log(`Project ID: ${PROJECT_ID}`)
  if (LIMIT != null) console.log(`Limit: first ${LIMIT} qualifying bills (date order)`)
  console.log("")

  // --- Load source JSON (fs, not a network call) ---
  const { readFileSync } = await import("node:fs")
  const raw = JSON.parse(readFileSync(SOURCE, "utf8")) as { pulledAt: string; bills: XeroBill[] }
  console.log(`Xero pull timestamp: ${raw.pulledAt}`)
  console.log(`Total ACCPAY bills in source: ${raw.bills.length}`)

  // --- Filter: PAID, excluding bradford/travis contacts, defensive ACCPAY check ---
  const EXCLUDE_RE = /bradford|travis/i
  const candidates = raw.bills.filter((b) => b.Status === "PAID" && b.Type === "ACCPAY" && !EXCLUDE_RE.test(b.Contact?.Name ?? ""))
  console.log(`PAID, non-Bradfords/Travis Perkins: ${candidates.length}\n`)

  const excludedByName = raw.bills.filter((b) => b.Status === "PAID" && EXCLUDE_RE.test(b.Contact?.Name ?? ""))
  if (excludedByName.length) {
    console.log(`Excluded (Bradfords/Travis Perkins — owned by their own pipeline): ${excludedByName.length}`)
    for (const b of excludedByName) console.log(`  ${b.Contact.Name.padEnd(20)} #${b.InvoiceNumber} £${b.Total}`)
    console.log("")
  }

  // Sort chronologically for a deterministic, readable plan.
  candidates.sort((a, b) => (a.DateString < b.DateString ? -1 : a.DateString > b.DateString ? 1 : 0))
  const bills = LIMIT != null ? candidates.slice(0, LIMIT) : candidates

  // --- Verify the target project (never invented — must already exist) ---
  const projectRes = await pool.query("SELECT id, name FROM projects WHERE id = $1", [PROJECT_ID])
  if (!projectRes.rows.length) {
    console.error(`Project ${PROJECT_ID} does not exist. Refusing to proceed.`)
    await pool.end()
    process.exit(1)
  }
  console.log(`Project: #${projectRes.rows[0].id} "${projectRes.rows[0].name}"\n`)

  // --- Existing suppliers + aliases -> exact-normalised-name resolution map ---
  const suppliersRes = await pool.query("SELECT id, name FROM suppliers ORDER BY id")
  const aliasRes = await pool.query("SELECT supplier_id, normalised_name FROM supplier_aliases")
  const aliasMap = new Map<string, { id: number; name: string }>()
  for (const s of suppliersRes.rows) {
    aliasMap.set(normaliseSupplierName(s.name), { id: s.id, name: s.name })
  }
  for (const a of aliasRes.rows) {
    const supplier = suppliersRes.rows.find((s) => s.id === a.supplier_id)
    if (supplier) aliasMap.set(a.normalised_name, { id: supplier.id, name: supplier.name })
  }
  console.log(`Existing suppliers: ${suppliersRes.rows.map((s: any) => `#${s.id} "${s.name}"`).join(", ")}`)
  console.log(`Known alias keys: ${aliasRes.rows.length}\n`)

  // Suppliers newly created/pending WITHIN this run, keyed by normalised name,
  // so repeated contacts across bills in the same batch resolve consistently
  // (and, on --execute, reuse the SAME created row rather than racing a second).
  const pendingNewSuppliers = new Map<string, SupplierResolution>()

  // --- Existing invoices, for the pre-flight duplicate set (small table; pulled whole) ---
  const existingInvRes = await pool.query(
    "SELECT supplier_id, transaction_type, invoice_number FROM invoices WHERE invoice_number IS NOT NULL",
  )
  const existingKeys = new Set(
    existingInvRes.rows.map((r: any) => `${r.supplier_id}|${r.transaction_type}|${normaliseDocNumber(r.invoice_number)}`),
  )
  console.log(`Existing invoices in DB (all suppliers): ${existingInvRes.rows.length}\n`)

  const seenThisBatch = new Set<string>() // intra-batch guard, keyed by normalised-contact|number
  const plan: PlanRow[] = []
  const crestmoorFlags: string[] = []

  for (const bill of bills) {
    // --- Required-field validation (never fabricate a missing value) ---
    if (!bill.InvoiceID || !bill.InvoiceNumber || !bill.DateString || bill.SubTotal == null || bill.TotalTax == null || bill.Total == null) {
      plan.push({ action: "ERROR", bill, reason: "missing InvoiceID/InvoiceNumber/DateString/SubTotal/TotalTax/Total" })
      continue
    }
    const invoiceDate = xeroDateStringToIso(bill.DateString)
    if (!invoiceDate) {
      plan.push({ action: "ERROR", bill, reason: `unparseable DateString "${bill.DateString}"` })
      continue
    }
    if (!bill.LineItems || bill.LineItems.length === 0) {
      plan.push({ action: "ERROR", bill, reason: "no line items on the Xero bill" })
      continue
    }
    if (!bill.HasAttachments) {
      plan.push({ action: "ERROR", bill, reason: "HasAttachments is false — no source document to retain" })
      continue
    }

    const contactName = (bill.Contact?.Name ?? "").trim()
    const nContact = normaliseSupplierName(contactName)
    if (!nContact) {
      plan.push({ action: "ERROR", bill, reason: "Contact.Name missing/blank" })
      continue
    }

    // --- Supplier resolution: EXACT normalised-name match only (own name or
    // a learned alias). No fuzzy scoring — see file header re: the three
    // distinct Crestmoor entities. ---
    let supplier: SupplierResolution
    const known = aliasMap.get(nContact)
    if (known) {
      supplier = { kind: "existing", id: known.id, name: known.name }
    } else if (pendingNewSuppliers.has(nContact)) {
      supplier = pendingNewSuppliers.get(nContact) as SupplierResolution
    } else {
      supplier = { kind: "new", id: null, name: contactName }
      pendingNewSuppliers.set(nContact, supplier)
    }

    if (/crestmoor/i.test(contactName)) {
      crestmoorFlags.push(
        `${bill.InvoiceNumber} — "${contactName}" -> ${
          supplier.kind === "existing" ? `resolved to EXISTING supplier #${supplier.id} "${supplier.name}"` : "will create a NEW, separate supplier row"
        }`,
      )
    }

    // --- Duplicate checks ---
    const nNumber = normaliseDocNumber(bill.InvoiceNumber)
    const batchKey = `${nContact}|${nNumber}`
    if (supplier.kind === "existing" && existingKeys.has(`${supplier.id}|invoice|${nNumber}`)) {
      plan.push({ action: "SKIP-DUPLICATE-DB", bill, reason: `already imported for supplier #${supplier.id} "${supplier.name}"`, supplier })
      continue
    }
    if (seenThisBatch.has(batchKey)) {
      plan.push({ action: "SKIP-DUPLICATE-BATCH", bill, reason: "same contact + invoice number appears earlier in this batch", supplier })
      continue
    }
    seenThisBatch.add(batchKey)

    // --- Line items: LineAmountTypes-aware net derivation, then reconcile to header ---
    const derivedLines: PlanLine[] = bill.LineItems.map((li) => {
      const lineAmount = money(li.LineAmount)
      const taxAmount = money(li.TaxAmount)
      const lineNet = bill.LineAmountTypes === "Inclusive" ? round2(lineAmount - taxAmount) : round2(lineAmount)
      const lineVat = round2(taxAmount)
      const qty = li.Quantity == null ? null : li.Quantity
      const unitPriceExVat = qty && qty > 0 ? round2(lineNet / qty) : null
      const vatRate = lineNet !== 0 ? Math.round((lineVat / lineNet) * 100) : lineVat === 0 ? null : null
      return { description: li.Description ?? "", quantity: qty, unitPriceExVat, lineNet, lineVat, vatRate }
    })
    const sumNet = round2(derivedLines.reduce((s, l) => s + l.lineNet, 0))
    const sumVat = round2(derivedLines.reduce((s, l) => s + l.lineVat, 0))
    const reconciled = Math.abs(sumNet - bill.SubTotal) < 0.02 && Math.abs(sumVat - bill.TotalTax) < 0.02
    const headerReconciles = Math.abs(bill.SubTotal + bill.TotalTax - bill.Total) < 0.02

    const lines: PlanLine[] = reconciled
      ? derivedLines
      : [
          {
            description: `Xero bill ${bill.InvoiceNumber} (${contactName}) — line items did not reconcile to SubTotal/TotalTax; net entered as a single line for audit. See extraction_raw for the original Xero line items.`,
            quantity: null,
            unitPriceExVat: null,
            lineNet: bill.SubTotal,
            lineVat: bill.TotalTax,
            vatRate: null,
          },
        ]

    const paidDate = xeroMsDateToIso(bill.FullyPaidOnDate)
    const firstPayment = bill.Payments?.[0]
    const paymentNotes =
      firstPayment && (firstPayment.Reference || firstPayment.Amount != null)
        ? `Xero payment${firstPayment.Reference ? ` ref ${firstPayment.Reference}` : ""}${
            firstPayment.Amount != null ? ` of £${firstPayment.Amount}` : ""
          }${paidDate ? ` on ${paidDate}` : ""}.`
        : null

    plan.push({
      action: "INSERT",
      bill,
      supplier,
      invoiceNumber: bill.InvoiceNumber,
      invoiceDate,
      net: bill.SubTotal,
      vat: bill.TotalTax,
      gross: bill.Total,
      paidDate,
      paymentNotes,
      lines,
      reconciled,
      reason: headerReconciles ? undefined : "WARNING: SubTotal + TotalTax != Total on the Xero bill itself",
    })
  }

  // --- Attachment listing (GET only) for every INSERT candidate — proves
  // retention is possible and surfaces filenames, without downloading bytes
  // or writing to Blob. This runs in BOTH dry-run and --execute. ---
  const toInsert = plan.filter((r) => r.action === "INSERT")
  console.log(`Listing attachments for ${toInsert.length} candidate bill(s) (Xero GET only, read-only)...\n`)
  for (const row of toInsert) {
    try {
      const res = await xeroGet(`/api.xro/2.0/Invoices/${row.bill.InvoiceID}/Attachments`, { headers: { Accept: "application/json" } })
      if (!res.ok) {
        row.action = "ERROR"
        row.reason = `attachment listing failed: HTTP ${res.status}`
        continue
      }
      const body = (await res.json()) as { Attachments: { FileName: string; Url: string; MimeType: string; ContentLength: number }[] }
      const atts = body.Attachments ?? []
      if (atts.length === 0) {
        row.action = "ERROR"
        row.reason = "HasAttachments=true but the Attachments list is empty — refusing to commit without a retained source document"
        continue
      }
      row.attachmentFileName = atts[0].FileName
      row.attachmentUrl = atts[0].Url
      row.attachmentMimeType = atts[0].MimeType
      row.extraAttachmentUrls = atts.slice(1).map((a) => a.Url)
    } catch (err) {
      row.action = "ERROR"
      row.reason = `attachment listing exception: ${(err as Error).message}`
    }
  }

  // --- Print per-bill plan ---
  console.log("--- PLAN ---\n")
  for (const r of plan) {
    const b = r.bill
    const netStr = r.net != null ? `£${r.net.toFixed(2)}` : `£${b.SubTotal.toFixed(2)}`
    const grossStr = r.gross != null ? `£${r.gross.toFixed(2)}` : `£${b.Total.toFixed(2)}`
    const supplierStr = r.supplier
      ? r.supplier.kind === "existing"
        ? `existing supplier #${r.supplier.id}`
        : "NEW supplier"
      : ""
    const attStr = r.attachmentFileName ? ` attachment="${r.attachmentFileName}"` : ""
    console.log(
      `${r.action.padEnd(20)} ${b.DateString.slice(0, 10)} ${b.Contact.Name.padEnd(36).slice(0, 36)} #${b.InvoiceNumber.padEnd(16)} ` +
        `net=${netStr.padEnd(12)} gross=${grossStr.padEnd(12)} ${supplierStr}${
          r.action === "INSERT" ? ` lines=${r.lines?.length}${r.reconciled ? "" : " (UNRECONCILED FALLBACK)"}` : ""
        }${attStr}${r.reason ? `  — ${r.reason}` : ""}`,
    )
  }

  // --- Crestmoor flag section (surfaced, never decided) ---
  console.log("\n--- CRESTMOOR QUESTION (surfaced, not decided) ---")
  console.log(
    'Gilbert OS already holds "Crestmoor Group of Companies" (supplier #5, one invoice, INV-1571). This batch\n' +
      'separately contains "Crestmoor Plant Hire" and "Crestmoor Construction Services Ltd". Exact-normalised-name\n' +
      "resolution (deliberately, no fuzzy matching) keeps all three as distinct supplier records:",
  )
  for (const line of [...new Set(crestmoorFlags)]) console.log(`  ${line}`)
  console.log("Whether any of these are the same real company trading under different names is an owner decision.\n")

  // --- Unreconciled bills, called out explicitly ---
  const unreconciled = toInsert.filter((r) => r.action === "INSERT" && r.reconciled === false)
  console.log(`--- Bills whose lines did NOT reconcile to the header (${unreconciled.length}) ---`)
  for (const r of unreconciled) console.log(`  ${r.bill.InvoiceNumber} (${r.bill.Contact.Name}) — fell back to a single audit line`)
  console.log("")

  // --- New suppliers to be created ---
  const newSuppliers = [...new Set(toInsert.filter((r) => r.supplier?.kind === "new").map((r) => r.supplier!.name))]
  console.log(`--- New suppliers to be created (${newSuppliers.length}) ---`)
  for (const n of newSuppliers) console.log(`  "${n}"`)
  console.log("")

  // --- Summary ---
  const finalToInsert = plan.filter((r) => r.action === "INSERT")
  const counts: Record<string, number> = {}
  for (const r of plan) counts[r.action] = (counts[r.action] || 0) + 1
  const plannedNet = finalToInsert.reduce((s, r) => s + (r.net || 0), 0)
  const plannedVat = finalToInsert.reduce((s, r) => s + (r.vat || 0), 0)
  const plannedGross = finalToInsert.reduce((s, r) => s + (r.gross || 0), 0)

  console.log("--- SUMMARY (plan) ---")
  console.log(`Total candidate bills:  ${plan.length}`)
  for (const [action, n] of Object.entries(counts)) console.log(`  ${action.padEnd(20)} ${n}`)
  console.log(`Planned inserts net:    £${plannedNet.toFixed(2)}`)
  console.log(`Planned inserts vat:    £${plannedVat.toFixed(2)}`)
  console.log(`Planned inserts gross:  £${plannedGross.toFixed(2)}`)
  console.log(`Unreconciled fallbacks: ${finalToInsert.filter((r) => !r.reconciled).length}`)
  console.log(`New suppliers:          ${newSuppliers.length}`)

  if (DRY_RUN) {
    console.log("\nDry run only — nothing written anywhere (no DB writes, no Blob uploads). The only network calls made")
    console.log("were Xero GETs (attachment listing) — xeroGet cannot express a write regardless of flags.")
    console.log("Re-run with --execute to commit the INSERT rows above.")
    await pool.end()
    return
  }

  // --- Execute ---
  console.log("\n--- EXECUTING ---")
  let inserted = 0
  let dupCaught = 0
  let errored = 0
  for (const r of finalToInsert) {
    try {
      const result = await commitOne(r)
      if (result.status === "committed") {
        inserted++
        console.log(`INSERTED  ${r.bill.InvoiceNumber} (${r.bill.Contact.Name})  -> invoice #${result.invoiceId}`)
      } else {
        dupCaught++
        console.log(`DUPLICATE (caught at commit) ${r.bill.InvoiceNumber} (${r.bill.Contact.Name})`)
      }
    } catch (err) {
      errored++
      console.error(`ERROR committing ${r.bill.InvoiceNumber} (${r.bill.Contact.Name}): ${(err as Error).message}`)
    }
  }
  console.log(`\nInserted: ${inserted}  Duplicates caught at commit: ${dupCaught}  Errors: ${errored}`)
  await pool.end()
}

/**
 * Download the bill's primary attachment, upload to Blob, then run the same
 * sequence of writes as commitInvoice's transaction (minus revalidatePath —
 * see file header). Supplier find-or-create happens INSIDE this transaction,
 * exactly like commitInvoice's own fallback, so two bills for the same new
 * supplier within one --execute run cannot race two separate supplier rows.
 */
async function commitOne(row: PlanRow): Promise<{ status: "committed"; invoiceId: number } | { status: "duplicate" }> {
  const { bill, supplier, lines, reconciled, invoiceDate, net, vat, gross, paidDate, paymentNotes } = row
  if (!supplier || !lines || net == null || vat == null || gross == null) {
    throw new Error("internal: incomplete plan row reached commitOne")
  }

  // --- Download the primary attachment (GET only) ---
  const attRes = await xeroGet(row.attachmentUrl!, { headers: { Accept: row.attachmentMimeType || "application/pdf" } })
  if (!attRes.ok) throw new Error(`attachment download failed: HTTP ${attRes.status}`)
  const bytes = Buffer.from(await attRes.arrayBuffer())
  const sourceFileHash = createHash("sha256").update(bytes).digest("hex")
  const safeName = (row.attachmentFileName || `xero-${bill.InvoiceID}.pdf`).replace(/[^a-zA-Z0-9._-]/g, "_")
  const blob = await put(`invoices/${Date.now()}-${safeName}`, bytes, {
    access: "public",
    contentType: row.attachmentMimeType || "application/pdf",
    addRandomSuffix: true,
  })

  let notes = `Imported from Xero bill ${bill.InvoiceID}.`
  if (row.extraAttachmentUrls?.length) {
    notes += ` Bill had ${row.extraAttachmentUrls.length + 1} attachments in Xero; only the first was retained as the primary source file here.`
  }

  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    // Resolve supplier: find-or-create by exact case-insensitive name match,
    // same shape as commitInvoice's own fallback.
    let supplierId: number
    if (supplier.kind === "existing") {
      supplierId = supplier.id
    } else {
      const existing = await client.query("SELECT id FROM suppliers WHERE name ILIKE $1 LIMIT 1", [supplier.name])
      if (existing.rows[0]) {
        supplierId = existing.rows[0].id
      } else {
        const created = await client.query("INSERT INTO suppliers (name) VALUES ($1) RETURNING id", [supplier.name])
        supplierId = created.rows[0].id
      }
      // Mutate the shared resolution object so subsequent bills for the same
      // contact within this --execute run resolve to the same row.
      ;(supplier as { kind: "new"; id: number | null; name: string }).id = supplierId
      ;(supplier as any).kind = "existing"
    }

    // App-level exact-duplicate re-check, inside the transaction.
    const nNumber = normaliseDocNumber(bill.InvoiceNumber)
    const existingInv = await client.query(
      "SELECT id, invoice_number FROM invoices WHERE supplier_id = $1 AND transaction_type = 'invoice'",
      [supplierId],
    )
    const dupe = existingInv.rows.find((r: any) => normaliseDocNumber(r.invoice_number) === nNumber)
    if (dupe) {
      await client.query("ROLLBACK")
      return { status: "duplicate" }
    }

    const invRes = await client.query(
      `INSERT INTO invoices
         (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
          net, vat, gross, status, source_file_name, source_file_pathname, source_file_hash,
          source_page_start, source_page_end, notes, extraction_raw, confidence,
          needs_review, reconciled, payment_status, paid_date, payment_notes)
       VALUES ($1,$2,$3,$4,'invoice',$5,$6,$7,'confirmed',$8,$9,$10,1,1,$11,$12,NULL,true,$13,'paid',$14,$15)
       RETURNING id`,
      [
        supplierId,
        PROJECT_ID,
        bill.InvoiceNumber,
        invoiceDate,
        String(net),
        String(vat),
        String(gross),
        row.attachmentFileName ?? null,
        blob.url,
        sourceFileHash,
        notes,
        JSON.stringify(bill),
        reconciled,
        paidDate,
        paymentNotes,
      ],
    )
    const invoiceId = invRes.rows[0].id

    for (const li of lines) {
      await client.query(
        `INSERT INTO invoice_line_items
           (invoice_id, product_id, cost_package_id, description, raw_description,
            quantity, unit, raw_unit, normalised_unit, unit_price_ex_vat,
            line_net, line_vat, line_gross, vat_rate, is_price_tracked)
         VALUES ($1,NULL,NULL,$2,$2,$3,NULL,NULL,NULL,$4,$5,$6,$7,$8,false)`,
        [
          invoiceId,
          li.description,
          li.quantity == null ? null : String(li.quantity),
          li.unitPriceExVat == null ? null : String(li.unitPriceExVat),
          String(li.lineNet),
          String(li.lineVat),
          String(round2(li.lineNet + li.lineVat)),
          li.vatRate == null ? null : String(li.vatRate),
        ],
      )
      // No price_records insert, ever, for this batch — product_id is always
      // NULL and is_price_tracked is always false (see file header).
      // No classification_mappings write — costPackageCode/Name are never
      // set for this batch, so commitInvoice's equivalent upsert would be a
      // no-op anyway; omitted rather than writing a dead branch.
    }

    // Supplier alias learning — idempotent, matches commitInvoice exactly.
    const rawSupplierName = bill.Contact.Name.trim()
    const supNorm = normaliseSupplierName(rawSupplierName)
    if (supNorm) {
      await client.query(
        `INSERT INTO supplier_aliases (supplier_id, normalised_name, raw_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (normalised_name) DO NOTHING`,
        [supplierId, supNorm, rawSupplierName || null],
      )
    }

    await client.query("COMMIT")
    return { status: "committed", invoiceId }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    if ((err as { code?: string }).code === "23505") {
      return { status: "duplicate" }
    }
    throw err
  } finally {
    client.release()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
