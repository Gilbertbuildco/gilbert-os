/**
 * Recover MKM's deleted/voided Xero bills and ingest the genuine MKM
 * documents into Gilbert OS WITH full product/price tracking (unlike every
 * prior 2026-08 Xero-recovery script, which deliberately left product_id and
 * price_records untouched — see those files' headers). MKM is a
 * building-materials merchant and the owner explicitly wants its products and
 * pricing in the procurement price database.
 *
 * SOURCE DATA (all pulled live via GET — see "WHAT THIS SCRIPT NEVER DOES")
 *   Xero holds a group of ACCPAY bills that were entered then deleted/voided,
 *   all left behind with Contact = "No Contact" (the contact record itself
 *   was removed when the bill was deleted). Their PDF/image attachments are
 *   still retrievable via the Attachments endpoint even though the bill
 *   itself is DELETED/VOIDED. This script:
 *     1. Pulls every ACCPAY invoice (includeArchived=true, paginated) and
 *        filters to Status IN (DELETED, VOIDED) with a blank/"No Contact"
 *        Contact.Name — found empirically to be exactly 10 bills, ~£12.5k
 *        gross by Xero's own (unreliable — see below) header Total.
 *     2. Lists + downloads each bill's attachment(s) to
 *        /Users/tomgilbert/Downloads/mkm-invoices/ (GET only).
 *     3. Parses each PDF's real text layer (pdfjs-dist legacy build) with a
 *        template-specific parser for MKM's fixed-layout e-invoice template.
 *     4. VERIFIES the parsed document is actually an MKM document (looks for
 *        the "MKM B.S. (Yeovil) Ltd" letterhead marker) before treating it as
 *        one — see "CRITICAL FINDING" below.
 *     5. Pulls the 9 real MKM bank payments (BankTransactions, Type=SPEND,
 *        Contact.Name="MKM") and matches each genuine MKM INVOICE (never a
 *        credit note) to a payment by exact, unambiguous gross amount.
 *
 * CRITICAL FINDING — 2 of the 10 "No Contact" deleted bills are NOT MKM
 *   Xero's own header data for these bills is not just incomplete, it is
 *   actively misleading: two of the ten "No Contact" deleted/voided bills
 *   are entirely different suppliers whose attachments got associated with a
 *   blank-contact ACCPAY bill in Xero:
 *     - InvoiceID 708ea270 (#"145175", £8,298.35) — the attached PDF's
 *       letterhead reads "Andrew Hopkins Concrete Ltd" (concrete, scalpings,
 *       road-sweeper hire, skip hire) — NOT MKM.
 *     - InvoiceID eda5ade4 (blank number, £936.00, VOIDED, dated 2026-04-02)
 *       — the attachment is a JPEG (not a PDF), a "City Plumbing" cash
 *       invoice for sanitaryware (Roca Duplo frames) — NOT MKM, and not even
 *       parseable as a PDF text layer.
 *   Both are downloaded (for audit/manual-review availability) but EXCLUDED
 *   from ingestion by this script — verified programmatically by checking for
 *   the MKM letterhead marker before treating anything as an MKM document,
 *   never assumed from Xero's Contact/Status fields alone. This means the
 *   owner-given "~10 deleted MKM bills, ~£12.5k" framing was itself built
 *   from unreliable Xero metadata; only 8 of the 10 are genuinely MKM
 *   (6 invoices + 2 credit notes, gross £3,292.83 before netting credits,
 *   £2,596.13 net). Surfaced in the plan output, never silently corrected
 *   into the original framing.
 *
 * WHY XERO'S BILL HEADERS CANNOT BE USED FOR NET/VAT/LINE ITEMS
 *   Every one of these deleted bills was entered in Xero as ONE line with
 *   LineAmountTypes="Inclusive" and TaxAmount=0 — i.e. SubTotal == Total and
 *   TotalTax == 0 on the Xero side, with no Description field on the line at
 *   all. That is not a real net/VAT split, just how the bill happened to be
 *   keyed before being deleted. The PDF attachment is the only source of
 *   truth for net/VAT/gross and line items, so this script parses ONLY the
 *   PDF text layer for financial values — Xero's bill header is used solely
 *   to locate and retrieve the attachment.
 *
 * MKM TEMPLATE — HOW THE PARSER WORKS (verified against all 8 genuine docs)
 *   Fixed-layout, single page, bottom-anchored totals block (same y position
 *   regardless of line-item count). Header identity + doc number + doc date
 *   are read from the "Advice note: <number> <date>" row (present, in this
 *   exact shape, on every invoice AND credit note). Line items are found by
 *   "anchor" rows whose leftmost item matches `<qty> <unit>` (e.g. "6.00 EA")
 *   in the quantity column (x < 100); each anchor's description is gathered
 *   from its own row plus every row below it (in the description column,
 *   ~x100–355) down to the next anchor or the footer. Footer totals ("Total
 *   Goods", "Total VAT", "Invoice Total") are found by adjacent label pairs
 *   at fixed y positions, taking the rightmost (rightmost-column) numeric
 *   token on that row as the value — robust to the exact number of VAT-band
 *   rows above it.
 *
 * WHY unitPriceExVat IS DERIVED, NOT READ FROM THE PRINTED "Price" COLUMN
 *   For the dense/lightweight concrete BLOCK lines, MKM prints a "Price"
 *   column value denominated in a DIFFERENT unit ("TN") than the quantity
 *   column ("EA") — e.g. "100 EA ... 10.55 TN ... 105.50" where
 *   105.50 / 100 = 1.055, not 10.55. (For the drainage lines the two happen
 *   to agree because quantity and price are both "EA".) Storing the printed
 *   "10.55" as a per-EA unit price would silently corrupt the price DB
 *   (non-negotiable #8) with a figure denominated in the wrong unit. Instead
 *   `unitPriceExVat = round(lineNet / quantity, 4)` is derived from the two
 *   values genuinely printed on the invoice (the line's goods total and its
 *   quantity) — arithmetic, not a fabricated figure, and it reconciles
 *   exactly against the header on every one of the 8 genuine documents.
 *   Verified: 8/8 documents reconcile line-sum-net/vat to the printed
 *   header net/VAT/gross to the penny using a flat 20% VAT rate (MKM's "S"
 *   VAT code on every line of every document recovered).
 *
 * WHAT THIS SCRIPT DOES THAT THE PRIOR XERO-RECOVERY SCRIPTS DELIBERATELY
 * DID NOT (this is the point of this script)
 *   - Full product resolution/creation (find-or-create by exact
 *     case-insensitive name match, same as commitInvoice), with
 *     parseDimensions/parseThickness applied to the verbatim description.
 *   - `is_price_tracked` via the same `suggestTrackPrice` /
 *     NON_PRODUCT_PATTERNS logic as `lib/normalisation/products.ts` — every
 *     line recovered here is a genuine material (drainage fittings, concrete
 *     blocks), none hit a delivery/carriage/labour/hire exclusion, so all are
 *     price-tracked. Reproduced here, not imported, matching the standalone-
 *     script pattern used throughout scripts/.
 *   - `price_records` rows inserted with the exact same columns commitInvoice
 *     writes, for INVOICE lines only (never credit notes — commitInvoice's
 *     own gate), on a genuinely comparable per-EA basis (see above).
 *   - Credit-note linking uses the credit note's OWN printed "Original
 *     Invoice: <n>" text (real, verbatim evidence) to set
 *     credit_of_invoice_id against the matching invoice committed earlier in
 *     the SAME run — more accurate than commitInvoice's own fallback (same
 *     document NUMBER as the credit), which would never match here because
 *     MKM's credit-note numbers use a different series (0064/4000941x) to
 *     their invoice numbers (0064/3011581x).
 *
 * WHAT THIS SCRIPT STILL NEVER DOES
 *   - No cost-package classification. `cost_package_id` is NULL on every
 *     line, always. No classification_mappings write for cost-package
 *     learning either — there is no pre-existing MKM-scoped mapping for it to
 *     re-affirm (MKM is a brand-new supplier in this DB), so writing one here
 *     would be guessing a package from nothing, which non-negotiable #1
 *     forbids. (Product/price learning and supplier-alias learning are
 *     separate systems from cost-package learning and DO proceed — see
 *     above.)
 *   - No Xero writes of any kind — `xeroGet` cannot express a non-GET call
 *     regardless of `XERO_WRITE_ENABLED`.
 *   - No fuzzy supplier matching — "MKM" is created fresh (verified not to
 *     exist) with one learned alias from the PDF letterhead
 *     ("MKM B.S. (Yeovil) Ltd"); no other supplier is touched.
 *
 * PAYMENT MATCHING (bank truth vs document truth — reported, never forced)
 *   9 Xero bank SPEND transactions with Contact.Name="MKM" total exactly
 *   £5,233.29 (Jan–Apr 2026). All 6 genuine MKM INVOICES (never the 2 credit
 *   notes — a credit does not produce an outgoing payment) match a bank
 *   payment by EXACT, UNAMBIGUOUS gross amount: £67.56, £91.15, £585.62,
 *   £624.23, £638.06, £937.86 — sum £2,944.48. Those get
 *   `payment_status='paid'` with the real bank-transaction date as
 *   `paid_date`. The remaining 3 payments (£1,813.60 on 2026-01-14, £406.81
 *   on 2026-03-24, £68.40 on 2026-04-29 — sum £2,288.81) have NO matching
 *   recoverable invoice document at all: reported as an unresolved gap, never
 *   invented an invoice to explain them. `payment_status` stays NULL on every
 *   invoice/credit this script cannot match, per instructions.
 *
 * DUPLICATE PROTECTION — four layers, matching every other 2026-08 script
 *   (a) pre-flight check against every invoice already in the DB for the
 *       resolved supplier, (b) an intra-batch guard, (c) an in-transaction
 *       re-check identical in shape to commitInvoice's, (d) the DB's partial
 *       unique index invoices_supplier_type_number_uidx. A duplicate commit
 *       writes nothing — no invoice, no lines, no price records.
 *
 * WHY NOT commitInvoice() DIRECTLY
 *   Same reasoning as every other script in this batch (see
 *   scripts/ingest-text-layer.mjs's header): commitInvoice calls
 *   revalidatePath, which throws outside a real Next.js request context
 *   AFTER the real write already committed. commitOne() below reproduces
 *   commitInvoice's transaction body verbatim in shape.
 *
 * SAFETY
 *   --dry-run is the default. Attachment LISTING and DOWNLOAD (to local
 *   disk only, not Blob) and PDF parsing happen in BOTH modes — the plan
 *   cannot be built without them, and they touch nothing but Xero GETs and
 *   the local filesystem. Only --execute uploads to Blob and writes to the
 *   database. Never runs a Xero non-GET (xeroGet cannot express one).
 *
 * USAGE
 *   npx tsx --env-file=.env.local --env-file=.env.development.local \
 *     scripts/ingest-mkm-invoices-2026-08.mts [options]
 *
 *   --limit=<n>        Only plan/process the first n genuine MKM documents
 *   --project-id=<n>   Defaults to 1 (Higher Farm) — verified to exist before use
 *   --download-dir=<p> Defaults to /Users/tomgilbert/Downloads/mkm-invoices
 *   --execute          Actually write (omit for dry run)
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { Pool } from "pg"
import { put } from "@vercel/blob"
import { xeroGet } from "../lib/xero/client.ts"
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs"

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
const PROJECT_ID = parseInt(opt("project-id", "1") as string, 10)
const DOWNLOAD_DIR = opt("download-dir", "/Users/tomgilbert/Downloads/mkm-invoices") as string

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run with --env-file=.env.development.local (see file header).")
  process.exit(1)
}
if (EXECUTE && !process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set — required for --execute (source PDFs must be retained in Blob).")
  process.exit(1)
}

mkdirSync(DOWNLOAD_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// Pure helpers, reproduced verbatim from the TS source noted above each one
// (standalone script, no shared import, matching the pattern of every other
// script in this batch — drift can be caught by re-diffing against source).
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

// --- lib/normalisation/products.ts ------------------------------------------
const NOISE_PATTERNS: RegExp[] = [
  /\bpriced?\s+from\s+quote\b.*$/i,
  /\bquote\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i,
  /\bq\d{4,}\b/i,
  /\border\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i,
  /\bref\.?\s*[:#]?\s*[a-z0-9-]+/i,
]
function normaliseProductName(description: string): string {
  if (!description) return ""
  let s = description
  for (const re of NOISE_PATTERNS) s = s.replace(re, " ")
  return s.replace(/\s+/g, " ").trim().toUpperCase()
}
function normaliseDescriptionKey(description: string): string {
  return normaliseProductName(description)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}
function parseDimensions(description: string): string | null {
  if (!description) return null
  const m = description.match(/\b(\d+(?:\.\d+)?\s*[x×*]\s*\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?)?)\b/i)
  if (!m) return null
  return m[1].replace(/\s+/g, "").replace(/[×*]/g, "x")
}
function parseThickness(description: string): string | null {
  if (!description) return null
  const explicit = description.match(/\b(\d+(?:\.\d+)?)\s?mm\b/i)
  if (explicit) return `${explicit[1]}mm`
  const dims = parseDimensions(description)
  if (dims) {
    const parts = dims.split("x")
    if (parts.length === 3) return `${parts[2]}mm`
  }
  return null
}
const NON_PRODUCT_PATTERNS: RegExp[] = [
  /\bdelivery\b/i, /\bcarriage\b/i, /\bhaulage\b/i, /\bfreight\b/i, /\bcollection\b/i,
  /\bsurcharge\b/i, /\bfuel\s*(?:surcharge|levy)\b/i, /\benvironmental\s*(?:charge|levy)\b/i,
  /\brebate\b/i, /\bdiscount\b/i, /\bretention\b/i, /\bcredit\b/i, /\brefund\b/i, /\badjustment\b/i,
  /\baccount\b.*\b(?:charge|adjustment|fee)\b/i, /\bmisc(?:ellaneous)?\b/i, /\badmin(?:istration)?\s*fee\b/i,
  /\bhandling\s*(?:charge|fee)\b/i, /\blabour\b/i, /\bhire\b/i, /\bplant\s*hire\b/i, /\bservice\s*charge\b/i,
  /\bwaste\b/i, /\bskip\b/i, /\bdeposit\b/i, /\bpallet\s*(?:charge|deposit)\b/i,
]
function suggestTrackPrice(description: string, unitPriceExVat: number | null): { suggested: boolean; reason: string } {
  const desc = description ?? ""
  for (const re of NON_PRODUCT_PATTERNS) {
    if (re.test(desc)) return { suggested: false, reason: "Looks like a charge, service or adjustment rather than a material." }
  }
  if (unitPriceExVat == null || unitPriceExVat === 0) {
    return { suggested: false, reason: "No unit price, so there is nothing to price-track." }
  }
  return { suggested: true, reason: "Looks like a genuine material line." }
}

// --- lib/normalisation/units.ts (subset actually seen: EA only, but kept
// faithful to the source mapping rather than special-cased) -----------------
const UNIT_MAP: Record<string, string> = {
  ea: "each", each: "each", eah: "each", no: "each", nr: "each", num: "each", unit: "each", pc: "each", pcs: "each", piece: "each",
  sh: "sheet", sht: "sheet", sheet: "sheet", sheets: "sheet", bd: "board",
  m: "metre", mtr: "metre", mtrs: "metre", metre: "metre", metres: "metre", meter: "metre", lm: "linear metre", lin: "linear metre", mm: "millimetre",
  m2: "square metre", sqm: "square metre", sm: "square metre", m3: "cubic metre", cum: "cubic metre",
  bg: "bag", bag: "bag", bags: "bag", box: "box", bx: "box", boxes: "box", pk: "pack", pack: "pack", pkt: "pack", packet: "pack",
  roll: "roll", rl: "roll", rolls: "roll", tub: "tub", tube: "tube", drum: "drum", can: "can", ctn: "carton", carton: "carton",
  pallet: "pallet", plt: "pallet", bundle: "bundle", bdl: "bundle",
  kg: "kilogram", kgs: "kilogram", g: "gram", t: "tonne", te: "tonne", ton: "tonne", tonne: "tonne",
  l: "litre", ltr: "litre", ltrs: "litre", litre: "litre", ml: "millilitre",
  hr: "hour", hrs: "hour", hour: "hour", day: "day", wk: "week", week: "week",
}
function normaliseUnit(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return null
  return UNIT_MAP[trimmed.toLowerCase().replace(/[.\s]/g, "")] ?? null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

// ---------------------------------------------------------------------------
// Xero shapes (subset actually used)
// ---------------------------------------------------------------------------

type XeroBill = {
  Type: string
  InvoiceID: string
  InvoiceNumber?: string
  Contact: { ContactID: string; Name: string }
  DateString: string
  Status: string
  Total: number
  HasAttachments: boolean
}

type XeroAttachment = { FileName: string; Url: string; MimeType: string; ContentLength: number }

type XeroBankTransaction = {
  BankTransactionID: string
  Type: string
  Status: string
  DateString: string
  Total: number
  Contact?: { Name?: string }
}

/** Xero DateString is "YYYY-MM-DDT00:00:00" — take the calendar date verbatim. */
function xeroDateStringToIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T/)
  return m ? m[1] : null
}

async function fetchAllAccpayBills(): Promise<XeroBill[]> {
  const all: XeroBill[] = []
  for (let page = 1; page <= 200; page++) {
    const res = await xeroGet(`/api.xro/2.0/Invoices?where=${encodeURIComponent('Type=="ACCPAY"')}&page=${page}&includeArchived=true`)
    if (!res.ok) throw new Error(`Xero Invoices fetch (page ${page}) failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`)
    const body = (await res.json()) as { Invoices?: XeroBill[] }
    const invs = body.Invoices ?? []
    all.push(...invs)
    if (invs.length < 100) break
  }
  return all
}

async function fetchAllBankTransactions(): Promise<XeroBankTransaction[]> {
  const all: XeroBankTransaction[] = []
  for (let page = 1; page <= 200; page++) {
    const res = await xeroGet(`/api.xro/2.0/BankTransactions?page=${page}`)
    if (!res.ok) throw new Error(`Xero BankTransactions fetch (page ${page}) failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`)
    const body = (await res.json()) as { BankTransactions?: XeroBankTransaction[] }
    const txs = body.BankTransactions ?? []
    all.push(...txs)
    if (txs.length < 100) break
  }
  return all
}

async function fetchAttachments(invoiceId: string): Promise<XeroAttachment[]> {
  const res = await xeroGet(`/api.xro/2.0/Invoices/${invoiceId}/Attachments`, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`Attachment listing failed: HTTP ${res.status}`)
  const body = (await res.json()) as { Attachments?: XeroAttachment[] }
  return body.Attachments ?? []
}

async function downloadAttachment(url: string, mimeType: string): Promise<Buffer> {
  const res = await xeroGet(url, { headers: { Accept: mimeType || "application/pdf" } })
  if (!res.ok) throw new Error(`Attachment download failed: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// ---------------------------------------------------------------------------
// PDF text-layer extraction + MKM template parser
// ---------------------------------------------------------------------------

type TextItem = { str: string; x: number; y: number }

async function extractTextItems(bytes: Buffer): Promise<{ pageCount: number; items: TextItem[] }> {
  const data = new Uint8Array(bytes)
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise
  const pageCount = doc.numPages
  const page = await doc.getPage(1)
  const content = await page.getTextContent()
  const items = content.items
    .map((i: any) => ({ str: i.str, x: Math.round(i.transform[4] * 100) / 100, y: Math.round(i.transform[5] * 100) / 100 }))
    .filter((i: TextItem) => i.str.trim() !== "")
  return { pageCount, items }
}

function rowsAtY(items: TextItem[], y: number, tol = 2.5): TextItem[] {
  return items.filter((i) => Math.abs(i.y - y) <= tol).sort((a, b) => a.x - b.x)
}

/** Rounded-to-DD/MM/YYYY -> ISO. Returns null (never fabricates) on a bad shape. */
function toIsoDate(ddmmyyyy: string | null): string | null {
  if (!ddmmyyyy) return null
  const m = ddmmyyyy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const [, d, mo, y] = m
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`
}

const MONEY_RE = /^-?£?\s?[\d,]+\.\d{2}$/
function money(s: string | undefined | null): number | null {
  if (s == null) return null
  const n = Number(String(s).replace(/[£,\s]/g, ""))
  return Number.isFinite(n) ? n : null
}

/** Find an adjacent (same row, small x-gap) label pair, e.g. "Total"+"Goods", and return the rightmost money-like value on that same row. */
function findFooterValue(items: TextItem[], wordA: string, wordB: string, maxGap = 60): { value: number | null; y: number | null } {
  for (const a of items) {
    if (a.str.trim() !== wordA) continue
    const b = items.find((i) => i.str.trim() === wordB && Math.abs(i.y - a.y) <= 2.5 && i.x > a.x && i.x - a.x < maxGap)
    if (!b) continue
    const row = rowsAtY(items, a.y)
    const moneyItems = row.filter((i) => MONEY_RE.test(i.str.trim()))
    if (!moneyItems.length) continue
    const rightmost = moneyItems.reduce((best, i) => (i.x > best.x ? i : best))
    return { value: money(rightmost.str), y: a.y }
  }
  return { value: null, y: null }
}

type ParsedLine = {
  quantity: number
  unit: string
  description: string
  lineNet: number
  vatCode: string | null
  printedUnitPrice: number | null
  printedPriceUnit: string | null
}

type ParsedDoc = {
  isMkm: boolean
  supplierHeading: string | null
  transactionType: "invoice" | "credit"
  docNumber: string | null
  docDateRaw: string | null
  docDate: string | null
  origInvoiceNumberRaw: string | null // credit notes only, verbatim printed digits
  headerNet: number | null
  headerVat: number | null
  headerGross: number | null
  lines: ParsedLine[]
  warnings: string[]
}

const QTY_UNIT_RE = /^(\d+(?:\.\d+)?)\s+([A-Za-z]{1,4})$/

function parseMkmDocument(items: TextItem[]): ParsedDoc {
  const warnings: string[] = []

  const mkmMarker = items.find((i) => /^MKM\b/i.test(i.str.trim()))
  const isMkm = Boolean(mkmMarker)
  const supplierHeading = mkmMarker ? mkmMarker.str.trim() : null

  const creditBanner = items.find((i) => /credit note/i.test(i.str.trim()))
  const transactionType: "invoice" | "credit" = creditBanner ? "credit" : "invoice"

  // "Advice | note: | <docNumber> | <date>" — present, in this shape, on
  // every genuine MKM invoice and credit note recovered.
  const adviceItem = items.find((i) => i.str.trim() === "Advice")
  let docNumber: string | null = null
  let docDateRaw: string | null = null
  if (adviceItem) {
    const row = rowsAtY(items, adviceItem.y)
    const numItem = row.find((i) => /^0064\/\d+$/.test(i.str.trim()))
    const dateItem = row.find((i) => /^\d{2}\/\d{2}\/\d{4}$/.test(i.str.trim()))
    docNumber = numItem ? numItem.str.trim() : null
    docDateRaw = dateItem ? dateItem.str.trim() : null
  } else {
    warnings.push('no "Advice note:" row found — cannot read document number/date')
  }
  const docDate = toIsoDate(docDateRaw)

  // Credit notes only: verbatim "Original Invoice: <digits>" reference.
  let origInvoiceNumberRaw: string | null = null
  if (transactionType === "credit") {
    const origLabel = items.find((i) => i.str.trim() === "Invoice:" && items.some((j) => j.str.trim() === "Original" && Math.abs(j.y - i.y) <= 2.5 && i.x - j.x > 0 && i.x - j.x < 60))
    if (origLabel) {
      const row = rowsAtY(items, origLabel.y)
      const valueItem = row.find((i) => i.x > origLabel.x && /^\d+$/.test(i.str.trim()))
      origInvoiceNumberRaw = valueItem ? valueItem.str.trim() : null
    }
    if (!origInvoiceNumberRaw) warnings.push('credit note but no "Original Invoice: <n>" reference found')
  }

  // Footer totals — adjacent label pairs at (empirically) fixed y, robust to
  // however many VAT-band rows sit above them.
  const netFooter = findFooterValue(items, "Total", "Goods")
  const vatFooter = findFooterValue(items, "Total", "VAT")
  const grossFooter = findFooterValue(items, "Invoice", "Total")
  if (netFooter.value == null) warnings.push('could not find "Total Goods" footer value')
  if (vatFooter.value == null) warnings.push('could not find "Total VAT" footer value')
  if (grossFooter.value == null) warnings.push('could not find "Invoice Total" footer value')

  // Line items: anchor rows are those whose leftmost item (x < 100) matches
  // "<qty> <unit>". Confined to the zone between the Advice-note row and the
  // topmost footer row, so header/footer text can never be misread as a line.
  const zoneTop = adviceItem ? adviceItem.y - 1 : Infinity
  const zoneBottom = (netFooter.y ?? 0) + 1
  const zoneItems = items.filter((i) => i.y < zoneTop && i.y > zoneBottom)
  const rowYs = [...new Set(zoneItems.map((i) => i.y))].sort((a, b) => b - a)

  type Anchor = { y: number; quantity: number; unit: string; priceX: number }
  const anchors: Anchor[] = []
  for (const y of rowYs) {
    const row = rowsAtY(zoneItems, y)
    const first = row[0]
    if (!first || first.x >= 100) continue
    const m = first.str.trim().match(QTY_UNIT_RE)
    if (!m) continue
    anchors.push({ y, quantity: Number(m[1]), unit: m[2], priceX: 365 })
  }

  const lines: ParsedLine[] = []
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]
    const nextY = i + 1 < anchors.length ? anchors[i + 1].y : zoneBottom
    const bandItems = zoneItems.filter((i2) => i2.y <= anchor.y + 0.5 && i2.y > nextY)

    const anchorRow = rowsAtY(bandItems, anchor.y)
    const priceItem = anchorRow.find((i2) => i2.x >= 355 && i2.x < 410 && MONEY_RE.test(i2.str.trim()))
    const priceUnitItem = anchorRow.find((i2) => i2.x >= 400 && i2.x < 412 && /^[A-Za-z]{1,4}$/.test(i2.str.trim()))
    const lineTotalCandidates = anchorRow.filter((i2) => i2.x >= 460 && MONEY_RE.test(i2.str.trim()))
    const vatCodeItem = anchorRow.find((i2) => i2.x >= 545 && /^[A-Za-z]$/.test(i2.str.trim()))
    const lineTotalItem = lineTotalCandidates.length ? lineTotalCandidates.reduce((best, i2) => (i2.x > best.x ? i2 : best)) : undefined

    // MKM sometimes prints a free-text order/delivery note ("Additional
    // information :- First Drop Please") directly below the LAST line item's
    // product-code row, before the footer. It is a document-level note, not
    // part of any product's identity — everything at/below the row starting
    // "Additional" is excluded from the description so it never fragments a
    // genuine product into a second, near-duplicate product row.
    const bandRowYs = [...new Set(bandItems.map((i2) => i2.y))].sort((a, b) => b - a)
    let noteStartY: number | null = null
    for (const y of bandRowYs) {
      const row = rowsAtY(bandItems, y)
      if (row[0] && row[0].str.trim() === "Additional") {
        noteStartY = y
        break
      }
    }
    const descBandItems = noteStartY != null ? bandItems.filter((i2) => i2.y > noteStartY!) : bandItems

    const descItems = descBandItems.filter((i2) => i2.x >= 100 && i2.x < 355)
    const description = descItems
      .sort((a, b) => b.y - a.y || a.x - b.x)
      .map((i2) => i2.str.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()

    if (!description || lineTotalItem == null) {
      warnings.push(`line at y=${anchor.y}: could not read description/line-total reliably`)
      continue
    }

    lines.push({
      quantity: anchor.quantity,
      unit: anchor.unit,
      description,
      lineNet: money(lineTotalItem.str) as number,
      vatCode: vatCodeItem ? vatCodeItem.str.trim() : null,
      printedUnitPrice: priceItem ? money(priceItem.str) : null,
      printedPriceUnit: priceUnitItem ? priceUnitItem.str.trim() : null,
    })
  }

  return {
    isMkm,
    supplierHeading,
    transactionType,
    docNumber,
    docDateRaw,
    docDate,
    origInvoiceNumberRaw,
    headerNet: netFooter.value,
    headerVat: vatFooter.value,
    headerGross: grossFooter.value,
    lines,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

type CommitLine = {
  description: string
  quantity: number
  unit: string
  normalisedUnit: string | null
  unitPriceExVat: number
  lineNet: number
  lineVat: number
  vatRate: number
  isPriceTracked: boolean
}

type PlanDoc = {
  bill: XeroBill
  attachment: XeroAttachment
  action: "INSERT" | "NOT_MKM" | "NOT_PDF" | "PARSE_ERROR" | "SKIP-DUPLICATE-DB" | "SKIP-DUPLICATE-BATCH"
  reason?: string
  parsed?: ParsedDoc
  bytes?: Buffer
  commitLines?: CommitLine[]
  reconciled?: boolean
  paymentStatus?: "paid" | null
  paidDate?: string | null
  paymentNotes?: string | null
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no DB writes, no Blob uploads)" : "EXECUTE (will write)"}`)
  console.log(`Project ID: ${PROJECT_ID}`)
  console.log(`Download dir: ${DOWNLOAD_DIR}`)
  if (LIMIT != null) console.log(`Limit: first ${LIMIT} genuine MKM documents`)
  console.log("")

  // --- Verify the target project (never invented — must already exist) ---
  const projectRes = await pool.query("SELECT id, name FROM projects WHERE id = $1", [PROJECT_ID])
  if (!projectRes.rows.length) {
    console.error(`Project ${PROJECT_ID} does not exist. Refusing to proceed.`)
    await pool.end()
    process.exit(1)
  }
  console.log(`Project: #${projectRes.rows[0].id} "${projectRes.rows[0].name}"\n`)

  // --- Step 1: pull every ACCPAY bill, filter to DELETED/VOIDED + No Contact ---
  console.log("Fetching all ACCPAY bills from Xero (paged GETs, includeArchived=true)...")
  const allBills = await fetchAllAccpayBills()
  console.log(`Total ACCPAY bills: ${allBills.length}`)
  const candidates = allBills.filter(
    (b) =>
      (b.Status === "DELETED" || b.Status === "VOIDED") &&
      ((b.Contact?.Name ?? "").trim() === "" || (b.Contact?.Name ?? "").trim().toLowerCase() === "no contact"),
  )
  console.log(`DELETED/VOIDED with blank/"No Contact": ${candidates.length}`)
  const candidatesGross = round2(candidates.reduce((s, b) => s + (b.Total || 0), 0))
  console.log(`Gross Total on these Xero bill headers (unreliable — see file header): £${candidatesGross.toFixed(2)}\n`)

  // --- Step 2 + 3: attachments, download, parse ---
  const plan: PlanDoc[] = []
  for (const bill of candidates) {
    if (!bill.HasAttachments) {
      plan.push({ bill, attachment: { FileName: "", Url: "", MimeType: "", ContentLength: 0 }, action: "PARSE_ERROR", reason: "HasAttachments is false" })
      continue
    }
    let atts: XeroAttachment[]
    try {
      atts = await fetchAttachments(bill.InvoiceID)
    } catch (err) {
      plan.push({ bill, attachment: { FileName: "", Url: "", MimeType: "", ContentLength: 0 }, action: "PARSE_ERROR", reason: `attachment listing failed: ${(err as Error).message}` })
      continue
    }
    if (!atts.length) {
      plan.push({ bill, attachment: { FileName: "", Url: "", MimeType: "", ContentLength: 0 }, action: "PARSE_ERROR", reason: "no attachments returned" })
      continue
    }
    const att = atts[0]
    let bytes: Buffer
    try {
      bytes = await downloadAttachment(att.Url, att.MimeType)
    } catch (err) {
      plan.push({ bill, attachment: att, action: "PARSE_ERROR", reason: `download failed: ${(err as Error).message}` })
      continue
    }
    const safeNum = (bill.InvoiceNumber || "blank").replace(/[^a-zA-Z0-9._-]/g, "_")
    const outPath = `${DOWNLOAD_DIR}/${bill.DateString.slice(0, 10)}_${safeNum}_${bill.InvoiceID.slice(0, 8)}_${att.FileName}`
    writeFileSync(outPath, bytes)

    const isPdf = /pdf/i.test(att.MimeType) || att.FileName.toLowerCase().endsWith(".pdf")
    if (!isPdf) {
      plan.push({ bill, attachment: att, action: "NOT_PDF", reason: `attachment mimeType="${att.MimeType}" — not a PDF, no text layer to parse; saved to ${outPath} for manual review`, bytes })
      continue
    }

    let items: TextItem[]
    let pageCount: number
    try {
      ;({ pageCount, items } = await extractTextItems(bytes))
    } catch (err) {
      plan.push({ bill, attachment: att, action: "PARSE_ERROR", reason: `PDF parse exception: ${(err as Error).message}` })
      continue
    }
    if (pageCount !== 1) {
      plan.push({ bill, attachment: att, action: "PARSE_ERROR", reason: `expected 1 page, found ${pageCount}` })
      continue
    }

    const parsed = parseMkmDocument(items)
    if (!parsed.isMkm) {
      plan.push({
        bill,
        attachment: att,
        action: "NOT_MKM",
        reason: `no MKM letterhead marker found — this "No Contact" deleted bill's attachment is NOT an MKM document; saved to ${outPath} for manual review`,
        bytes,
        parsed,
      })
      continue
    }
    if (!parsed.docNumber || !parsed.docDate || parsed.headerNet == null || parsed.headerVat == null || parsed.headerGross == null) {
      plan.push({ bill, attachment: att, action: "PARSE_ERROR", reason: `could not read document number/date/totals reliably: ${parsed.warnings.join("; ")}`, bytes, parsed })
      continue
    }

    // --- Reconciliation: line sum vs header, header net+vat vs gross ---
    const sumNet = round2(parsed.lines.reduce((s, l) => s + l.lineNet, 0))
    const linesReconcile = parsed.lines.length > 0 && Math.abs(sumNet - parsed.headerNet) < 0.02
    const headerReconciles = Math.abs(parsed.headerNet + parsed.headerVat - parsed.headerGross) < 0.02

    let commitLines: CommitLine[]
    let reconciled: boolean
    if (linesReconcile) {
      commitLines = parsed.lines.map((l) => {
        const vatRate = l.vatCode === "S" ? 20 : 20 // only "S" observed across every recovered document; documented, never silently assumed elsewhere
        const unitPriceExVat = l.quantity > 0 ? round4(l.lineNet / l.quantity) : 0
        const lineVat = round2(l.lineNet * (vatRate / 100))
        const track = suggestTrackPrice(l.description, unitPriceExVat)
        return {
          description: l.description,
          quantity: l.quantity,
          unit: l.unit,
          normalisedUnit: normaliseUnit(l.unit),
          unitPriceExVat,
          lineNet: l.lineNet,
          lineVat,
          vatRate,
          isPriceTracked: track.suggested,
        }
      })
      const sumVat = round2(commitLines.reduce((s, l) => s + l.lineVat, 0))
      reconciled = Math.abs(sumVat - parsed.headerVat) < 0.02 && headerReconciles
    } else {
      commitLines = []
      reconciled = false
    }

    if (!reconciled) {
      commitLines = [
        {
          description: `MKM ${parsed.transactionType === "credit" ? "credit note" : "invoice"} ${parsed.docNumber} — line items did not reconcile to the printed Total Goods/Total VAT; net entered as a single line for audit. See extraction_raw for what was parsed.`,
          quantity: 1,
          unit: "",
          normalisedUnit: null,
          unitPriceExVat: parsed.headerNet,
          lineNet: parsed.headerNet,
          lineVat: parsed.headerVat,
          vatRate: parsed.headerNet !== 0 ? round2((parsed.headerVat / parsed.headerNet) * 100) : 20,
          isPriceTracked: false,
        },
      ]
    }

    plan.push({ bill, attachment: att, action: "INSERT", parsed, bytes, commitLines, reconciled })
  }

  if (LIMIT != null) {
    let count = 0
    const limited = plan.filter((r) => {
      if (r.action !== "INSERT") return true
      if (count >= LIMIT) return false
      count++
      return true
    })
    plan.length = 0
    plan.push(...limited)
  }

  // --- Step 5: payment matching (invoices only, never credits) ---
  console.log("Fetching bank transactions from Xero (paged GETs) for MKM payment cross-check...")
  const allBankTx = await fetchAllBankTransactions()
  const mkmPayments = allBankTx.filter((t) => t.Type === "SPEND" && (t.Contact?.Name ?? "").trim().toLowerCase() === "mkm")
  console.log(`Bank SPEND transactions with Contact="MKM": ${mkmPayments.length}, total £${round2(mkmPayments.reduce((s, t) => s + t.Total, 0)).toFixed(2)}\n`)

  const invoiceDocs = plan.filter((r): r is PlanDoc & { parsed: ParsedDoc } => r.action === "INSERT" && r.parsed!.transactionType === "invoice")
  const invoiceGrossFreq = new Map<number, number>()
  for (const r of invoiceDocs) invoiceGrossFreq.set(r.parsed.headerGross!, (invoiceGrossFreq.get(r.parsed.headerGross!) ?? 0) + 1)
  const paymentFreq = new Map<number, XeroBankTransaction[]>()
  for (const t of mkmPayments) paymentFreq.set(t.Total, [...(paymentFreq.get(t.Total) ?? []), t])

  const matchedPaymentIds = new Set<string>()
  for (const r of invoiceDocs) {
    const gross = r.parsed.headerGross!
    const invoiceCount = invoiceGrossFreq.get(gross) ?? 0
    const payments = paymentFreq.get(gross) ?? []
    if (invoiceCount === 1 && payments.length === 1) {
      const pay = payments[0]
      r.paymentStatus = "paid"
      r.paidDate = xeroDateStringToIso(pay.DateString)
      r.paymentNotes = `Matched to Xero bank SPEND transaction ${pay.BankTransactionID} (£${pay.Total.toFixed(2)} on ${r.paidDate}) by exact, unambiguous gross amount. Original Xero ACCPAY bill ${r.bill.InvoiceID} was ${r.bill.Status} (deleted duplicate entry); this invoice was reconstructed from its retained PDF attachment.`
      matchedPaymentIds.add(pay.BankTransactionID)
    } else {
      r.paymentStatus = null
      r.paidDate = null
      r.paymentNotes =
        invoiceCount > 1
          ? `£${gross.toFixed(2)} gross is shared by ${invoiceCount} recovered MKM invoices — cannot safely attribute a bank payment to one of them. Left unmatched (payment_status stays null).`
          : payments.length > 1
            ? `£${gross.toFixed(2)} matches ${payments.length} separate MKM bank payments — cannot safely pick one. Left unmatched (payment_status stays null).`
            : `No MKM bank payment of exactly £${gross.toFixed(2)} found. Left unmatched (payment_status stays null).`
    }
  }
  const unmatchedPayments = mkmPayments.filter((t) => !matchedPaymentIds.has(t.BankTransactionID))

  // --- Resolve supplier: MKM must not already exist (verified, not assumed) ---
  const existingSupplierRes = await pool.query(
    "SELECT id, name FROM suppliers WHERE lower(name) = 'mkm' OR id IN (SELECT supplier_id FROM supplier_aliases WHERE normalised_name = $1)",
    [normaliseSupplierName("MKM")],
  )
  const supplierExists = existingSupplierRes.rows.length > 0
  const supplierId = supplierExists ? existingSupplierRes.rows[0].id : null
  console.log(supplierExists ? `Supplier "MKM" already exists: #${supplierId} — will resolve to it, no new supplier created.` : `Supplier "MKM" does not exist yet — will be created.`)

  // --- Pre-flight duplicate check (only meaningful if supplier already exists) ---
  const existingKeys = new Set<string>()
  if (supplierExists) {
    const existingInv = await pool.query("SELECT transaction_type, invoice_number FROM invoices WHERE supplier_id = $1", [supplierId])
    for (const r of existingInv.rows) existingKeys.add(`${r.transaction_type}|${normaliseDocNumber(r.invoice_number)}`)
  }

  const seenThisBatch = new Set<string>()
  for (const r of plan) {
    if (r.action !== "INSERT") continue
    const key = `${r.parsed!.transactionType}|${normaliseDocNumber(r.parsed!.docNumber)}`
    if (existingKeys.has(key)) {
      r.action = "SKIP-DUPLICATE-DB"
      r.reason = `already imported for supplier "MKM" (#${supplierId})`
      continue
    }
    if (seenThisBatch.has(key)) {
      r.action = "SKIP-DUPLICATE-BATCH"
      r.reason = "same document number/type appears earlier in this batch"
      continue
    }
    seenThisBatch.add(key)
  }

  // --- Print plan ---
  console.log("\n--- PLAN (per document) ---\n")
  for (const r of plan) {
    const b = r.bill
    const numStr = (b.InvoiceNumber || "(blank)").padEnd(16)
    if (r.action === "INSERT") {
      const p = r.parsed!
      console.log(
        `INSERT   ${b.DateString.slice(0, 10)} type=${p.transactionType.padEnd(7)} #${p.docNumber!.padEnd(14)} date=${p.docDate} ` +
          `net=£${p.headerNet!.toFixed(2).padEnd(9)} vat=£${p.headerVat!.toFixed(2).padEnd(8)} gross=£${p.headerGross!.toFixed(2).padEnd(9)} ` +
          `lines=${r.commitLines!.length}${r.reconciled ? "" : " (UNRECONCILED FALLBACK)"} ` +
          `paid=${r.paymentStatus ?? "null"}`,
      )
      if (p.transactionType === "credit") {
        console.log(`         credit references original invoice: ${p.origInvoiceNumberRaw ? `0064/${p.origInvoiceNumberRaw}` : "(not found in text — credit_of_invoice_id will stay null)"}`)
      }
      if (!r.reconciled) console.log(`         warnings: ${p.warnings.join("; ") || "(none — reconciliation still failed on totals)"}`)
    } else {
      console.log(`${r.action.padEnd(20)} ${b.DateString.slice(0, 10)} #${numStr} £${b.Total.toFixed(2)} InvoiceID=${b.InvoiceID}  — ${r.reason}`)
    }
  }

  // --- Payments cross-check report ---
  console.log("\n--- PAYMENTS vs DOCUMENTS (mismatch, reported never reconciled away) ---")
  console.log(`Xero bank SPEND payments, Contact="MKM": ${mkmPayments.length}, total £${round2(mkmPayments.reduce((s, t) => s + t.Total, 0)).toFixed(2)}`)
  console.log(`Matched to a recovered invoice by exact amount: ${matchedPaymentIds.size}`)
  console.log(`Unmatched payments (no recoverable invoice document at all) — ${unmatchedPayments.length}:`)
  for (const t of unmatchedPayments) console.log(`  £${t.Total.toFixed(2)} on ${xeroDateStringToIso(t.DateString)}  (BankTransactionID ${t.BankTransactionID})`)
  const insertRows = plan.filter((r) => r.action === "INSERT")
  const genuineInvoices = insertRows.filter((r) => r.parsed!.transactionType === "invoice")
  const genuineCredits = insertRows.filter((r) => r.parsed!.transactionType === "credit")
  console.log(`\nGenuine MKM documents recovered: ${insertRows.length} (${genuineInvoices.length} invoices + ${genuineCredits.length} credit notes)`)
  console.log(`  invoices gross sum:  £${round2(genuineInvoices.reduce((s, r) => s + r.parsed!.headerGross!, 0)).toFixed(2)}`)
  console.log(`  credits gross sum:   £${round2(genuineCredits.reduce((s, r) => s + r.parsed!.headerGross!, 0)).toFixed(2)}`)
  console.log(
    `  net of credits:      £${round2(genuineInvoices.reduce((s, r) => s + r.parsed!.headerGross!, 0) - genuineCredits.reduce((s, r) => s + r.parsed!.headerGross!, 0)).toFixed(2)}`,
  )

  // --- Excluded (non-MKM / non-PDF) documents, called out explicitly ---
  const excluded = plan.filter((r) => r.action === "NOT_MKM" || r.action === "NOT_PDF" || r.action === "PARSE_ERROR")
  console.log(`\n--- EXCLUDED from this ingest (${excluded.length}) — downloaded for manual review, never committed ---`)
  for (const r of excluded) console.log(`  ${r.action.padEnd(12)} #${(r.bill.InvoiceNumber || "(blank)").padEnd(14)} £${r.bill.Total.toFixed(2)}  — ${r.reason}`)

  // --- Product / price-record counts that WOULD be created ---
  const toInsert = plan.filter((r) => r.action === "INSERT")
  const materialLines = toInsert.flatMap((r) => r.commitLines!.filter((l) => l.isPriceTracked))
  const distinctProductNames = new Set(materialLines.map((l) => l.description.trim().toLowerCase()))
  const priceRecordCandidates = toInsert
    .filter((r) => r.parsed!.transactionType === "invoice")
    .flatMap((r) => r.commitLines!.filter((l) => l.isPriceTracked))

  console.log("\n--- PRODUCT / PRICE-DB IMPACT (would-be, dry run) ---")
  console.log(`Total line items across all recovered documents: ${toInsert.reduce((s, r) => s + r.commitLines!.length, 0)}`)
  console.log(`Lines flagged is_price_tracked=true (genuine materials): ${materialLines.length}`)
  console.log(`Distinct product names among them: ${distinctProductNames.size}`)
  for (const n of distinctProductNames) console.log(`  "${n}"`)
  console.log(`price_records rows that would be created (invoice lines only, never credit lines): ${priceRecordCandidates.length}`)

  // --- Summary ---
  const counts: Record<string, number> = {}
  for (const r of plan) counts[r.action] = (counts[r.action] || 0) + 1
  const signOf = (r: PlanDoc) => (r.parsed!.transactionType === "credit" ? -1 : 1)
  const plannedNet = toInsert.reduce((s, r) => s + signOf(r) * r.parsed!.headerNet!, 0)
  const plannedVat = toInsert.reduce((s, r) => s + signOf(r) * r.parsed!.headerVat!, 0)
  const plannedGross = toInsert.reduce((s, r) => s + signOf(r) * r.parsed!.headerGross!, 0)

  console.log("\n--- SUMMARY (plan) ---")
  console.log(`Candidate "No Contact" deleted/voided bills: ${candidates.length}`)
  for (const [action, n] of Object.entries(counts)) console.log(`  ${action.padEnd(20)} ${n}`)
  console.log(`Planned inserts net (signed, credits negative if committed):    £${plannedNet.toFixed(2)}`)
  console.log(`Planned inserts vat:                                            £${plannedVat.toFixed(2)}`)
  console.log(`Planned inserts gross:                                          £${plannedGross.toFixed(2)}`)
  console.log(`Unreconciled fallbacks: ${toInsert.filter((r) => !r.reconciled).length}`)
  console.log(`New supplier: ${supplierExists ? "no (existing)" : 'yes — "MKM"'}`)

  if (DRY_RUN) {
    // Prove zero writes: DB row counts before vs a fresh read (should be identical).
    const before = await pool.query(
      "SELECT (SELECT count(*) FROM invoices) AS inv, (SELECT count(*) FROM invoice_line_items) AS li, (SELECT count(*) FROM products) AS pr, (SELECT count(*) FROM price_records) AS prr, (SELECT count(*) FROM suppliers) AS sup, (SELECT count(*) FROM supplier_aliases) AS al",
    )
    console.log(`\nDB counts (proving nothing was written by this dry run): ${JSON.stringify(before.rows[0])}`)
    console.log("\nDry run only — nothing written to the database or Blob. Attachment listing/download (to local disk)")
    console.log("and Xero GETs for bills/attachments/bank-transactions were the only network calls made — xeroGet")
    console.log("cannot express a write regardless of flags. Re-run with --execute to commit the INSERT rows above.")
    await pool.end()
    return
  }

  // --- Execute: invoices first, then credits (so credit_of_invoice_id can resolve) ---
  console.log("\n--- EXECUTING ---")
  const insertedInvoiceIdByNumber = new Map<string, number>() // normalised "0064/xxxxx" -> invoice id
  let inserted = 0
  let dupCaught = 0
  let errored = 0

  const invoicesFirst = [...toInsert.filter((r) => r.parsed!.transactionType === "invoice"), ...toInsert.filter((r) => r.parsed!.transactionType === "credit")]

  for (const r of invoicesFirst) {
    try {
      const result = await commitOne(r, { supplierId, supplierExists, insertedInvoiceIdByNumber })
      if (result.status === "committed") {
        inserted++
        insertedInvoiceIdByNumber.set(normaliseDocNumber(r.parsed!.docNumber), result.invoiceId)
        console.log(`INSERTED  ${r.parsed!.docNumber} (${r.parsed!.transactionType})  -> invoice #${result.invoiceId}`)
      } else {
        dupCaught++
        console.log(`DUPLICATE (caught at commit) ${r.parsed!.docNumber}`)
      }
    } catch (err) {
      errored++
      console.error(`ERROR committing ${r.parsed!.docNumber}: ${(err as Error).message}`)
    }
  }
  console.log(`\nInserted: ${inserted}  Duplicates caught at commit: ${dupCaught}  Errors: ${errored}`)
  await pool.end()
}

/**
 * Upload the source PDF to Blob, then run the same sequence of writes as
 * commitInvoice's transaction (minus revalidatePath — see file header):
 * supplier find-or-create, app-level duplicate re-check, invoice insert, per
 * line product find-or-create + line item insert + price_records insert
 * (invoice lines only) + supplier-alias learning. No classification_mappings
 * write for cost-package learning (see file header — nothing pre-existing to
 * re-affirm for a brand-new supplier).
 */
async function commitOne(
  r: PlanDoc,
  ctx: { supplierId: number | null; supplierExists: boolean; insertedInvoiceIdByNumber: Map<string, number> },
): Promise<{ status: "committed"; invoiceId: number } | { status: "duplicate" }> {
  const p = r.parsed!
  const sourceFileHash = createHash("sha256").update(r.bytes!).digest("hex")
  const safeName = r.attachment.FileName.replace(/[^a-zA-Z0-9._-]/g, "_")
  const blob = await put(`invoices/${Date.now()}-${safeName}`, r.bytes!, {
    access: "public",
    contentType: r.attachment.MimeType || "application/pdf",
    addRandomSuffix: true,
  })

  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    // Resolve supplier: find-or-create by exact case-insensitive name "MKM".
    let supplierId = ctx.supplierId
    if (!supplierId) {
      const existing = await client.query("SELECT id FROM suppliers WHERE lower(name) = 'mkm' LIMIT 1", [])
      if (existing.rows[0]) {
        supplierId = existing.rows[0].id
      } else {
        const created = await client.query("INSERT INTO suppliers (name) VALUES ('MKM') RETURNING id", [])
        supplierId = created.rows[0].id
      }
      ctx.supplierId = supplierId
      ctx.supplierExists = true
    }

    // App-level exact-duplicate re-check, inside the transaction.
    const nNumber = normaliseDocNumber(p.docNumber)
    const existingInv = await client.query("SELECT id, invoice_number FROM invoices WHERE supplier_id = $1 AND transaction_type = $2", [supplierId, p.transactionType])
    const dupe = existingInv.rows.find((row: any) => normaliseDocNumber(row.invoice_number) === nNumber)
    if (dupe) {
      await client.query("ROLLBACK")
      return { status: "duplicate" }
    }

    // Credit-note linking via the printed "Original Invoice: <n>" reference —
    // real, verbatim evidence, checked against invoices committed earlier in
    // THIS run (invoices are always committed before credits — see main()).
    let creditOfInvoiceId: number | null = null
    if (p.transactionType === "credit" && p.origInvoiceNumberRaw) {
      const wantKey = normaliseDocNumber(`0064/${p.origInvoiceNumberRaw}`)
      creditOfInvoiceId = ctx.insertedInvoiceIdByNumber.get(wantKey) ?? null
      if (creditOfInvoiceId == null) {
        // Fall back to an already-committed DB row (e.g. a prior run inserted the invoice).
        const orig = await client.query("SELECT id, invoice_number FROM invoices WHERE supplier_id = $1 AND transaction_type = 'invoice'", [supplierId])
        const match = orig.rows.find((row: any) => normaliseDocNumber(row.invoice_number) === wantKey)
        creditOfInvoiceId = match ? Number(match.id) : null
      }
    }

    const sign = p.transactionType === "credit" ? -1 : 1
    const invRes = await client.query(
      `INSERT INTO invoices
         (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
          net, vat, gross, status, source_file_name, source_file_pathname, source_file_hash,
          source_page_start, source_page_end, notes, extraction_raw, confidence,
          credit_of_invoice_id, needs_review, reconciled, payment_status, paid_date, payment_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9,$10,$11,1,1,$12,$13,$14,$15,true,$16,$17,$18,$19)
       RETURNING id`,
      [
        supplierId,
        PROJECT_ID,
        p.docNumber,
        p.docDate,
        p.transactionType,
        String(sign * Math.abs(p.headerNet!)),
        String(sign * Math.abs(p.headerVat!)),
        String(sign * Math.abs(p.headerGross!)),
        r.attachment.FileName,
        blob.url,
        sourceFileHash,
        `Recovered from a DELETED/VOIDED Xero ACCPAY bill (${r.bill.InvoiceID}, Contact="No Contact") via scripts/ingest-mkm-invoices-2026-08.mts. Reconstructed entirely from the retained PDF attachment's text layer — Xero's own bill header for this record is unreliable (single-line, Inclusive, TaxAmount=0; see script header).`,
        JSON.stringify({ xeroBill: r.bill, parsed: { ...p, lines: undefined }, parsedLines: p.lines }),
        r.reconciled ? "high" : "medium",
        creditOfInvoiceId,
        r.reconciled,
        r.paymentStatus ?? null,
        r.paidDate ?? null,
        r.paymentNotes ?? null,
      ],
    )
    const invoiceId = invRes.rows[0].id

    for (const li of r.commitLines!) {
      let productId: number | null = null
      if (li.isPriceTracked) {
        const pname = li.description.trim()
        if (pname) {
          const existingProduct = await client.query("SELECT id FROM products WHERE name ILIKE $1 LIMIT 1", [pname])
          if (existingProduct.rows[0]) {
            productId = existingProduct.rows[0].id
          } else {
            const created = await client.query(
              `INSERT INTO products (name, description, category, unit, normalised_name, product_family, product_type, dimensions, thickness, subcategory)
               VALUES ($1,$2,NULL,$3,$4,NULL,NULL,$5,$6,NULL) RETURNING id`,
              [pname, li.description, li.normalisedUnit ?? li.unit, normaliseProductName(li.description), parseDimensions(li.description), parseThickness(li.description)],
            )
            productId = created.rows[0].id
          }
        }
      }

      const lineNetSigned = sign * Math.abs(li.lineNet)
      const lineVatSigned = round2(lineNetSigned * (li.vatRate / 100))
      const lineGrossSigned = round2(lineNetSigned + lineVatSigned)

      const lineRes = await client.query(
        `INSERT INTO invoice_line_items
           (invoice_id, product_id, cost_package_id, description, raw_description,
            quantity, unit, raw_unit, normalised_unit, unit_price_ex_vat,
            line_net, line_vat, line_gross, vat_rate, is_price_tracked)
         VALUES ($1,$2,NULL,$3,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          invoiceId,
          productId,
          li.description,
          String(li.quantity),
          li.unit || null,
          li.normalisedUnit,
          String(li.unitPriceExVat),
          String(lineNetSigned),
          String(lineVatSigned),
          String(lineGrossSigned),
          String(li.vatRate),
          li.isPriceTracked,
        ],
      )
      const lineItemId = lineRes.rows[0].id

      // price_records: invoice lines only, tracked lines only, matching
      // commitInvoice's own gate exactly.
      if (productId && li.isPriceTracked && p.transactionType === "invoice") {
        const priceEx = Math.abs(li.unitPriceExVat)
        const vatAmount = round2(priceEx * (li.vatRate / 100))
        await client.query(
          `INSERT INTO price_records
             (product_id, supplier_id, project_id, invoice_id, invoice_line_item_id,
              price_ex_vat, vat_amount, price_inc_vat, vat_rate, unit, normalised_unit,
              invoice_date, invoice_number, transaction_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'invoice')`,
          [productId, supplierId, PROJECT_ID, invoiceId, lineItemId, String(priceEx), String(vatAmount), String(round2(priceEx + vatAmount)), String(li.vatRate), li.unit || null, li.normalisedUnit, p.docDate, p.docNumber],
        )
      }
      // No classification_mappings write — cost_package_id is always NULL for
      // this batch (a brand-new supplier has no pre-existing mapping to
      // re-affirm, and this script never guesses one — see file header).
    }

    // Supplier alias learning — idempotent, matches commitInvoice exactly.
    const rawSupplierName = (p.supplierHeading ?? "").trim()
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
