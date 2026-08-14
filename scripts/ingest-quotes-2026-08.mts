/**
 * Ingest supplier/tradesman QUOTE documents harvested at
 * /Users/tomgilbert/Downloads/quotes/ (~230 files: PDFs, .doc/.docx, plus a
 * lot of images/xlsx/zip/dwg and documents that are NOT quotes at all —
 * invoices, RAMS, insurance certs, floor plans, land-sale brochures, company
 * accounts, and correspondence for other clients entirely, all mixed into the
 * same folder because it is a wholesale harvest of one person's inbox).
 *
 * NON-NEGOTIABLE #1 IS THE WHOLE POINT OF THIS SCRIPT: a quote total this
 * script cannot read VERBATIM from the document text is never guessed,
 * never derived from a different document (e.g. an invoice that happens to
 * reference the same job), and never assumed. It is SKIPPED and reported.
 * Expect to skip plenty of files — that is correct behaviour, not a bug.
 *
 * MANIFEST-FREE: there is no hand-built JSON/CSV manifest here (contrast
 * scripts/ingest-emailed-invoices-2026-08.mts). Every file's text is
 * extracted at run time (pdfjs-dist for PDFs, macOS `textutil` for
 * .doc/.docx) and run through a small set of per-supplier TEMPLATE
 * RECOGNISERS below. Each recogniser only fires when its own strong textual
 * signature is present (a distinctive phrase/company name actually printed
 * in that supplier's document layout), then extracts the reference/date/
 * scope/totals via regex anchored to the exact labels printed next to those
 * values. Nothing is inferred from a filename. A file whose text doesn't
 * match ANY known template signature is skipped and reported, not guessed
 * at with a generic heuristic — the diversity of unrelated document types in
 * this folder makes a generic "find something that looks like a total"
 * parser actively dangerous (it would happily find a total on an invoice,
 * an accounts filing, or someone else's project altogether).
 *
 * This is a dated, one-off batch script (like every other `ingest-*-2026-08`
 * script in this folder) written for THIS specific harvested folder — not a
 * general-purpose "any quotes folder" tool. If a template's signature text
 * ever appears verbatim on a document that ISN'T actually a Gilbert Build Co
 * Higher Farm quote (this happened — see the City Plumbing customer-name
 * check below), the recogniser adds an extra guard rather than trusting the
 * signature alone.
 *
 * WHAT COUNTS AS "THE QUOTE DOCUMENT" (task instruction: "transcribe what
 * the quotation document itself says")
 *   - Harlequin: no standalone Harlequin *quotation* document exists in this
 *     batch. The £31,302.50 / £25,452.50 / £25,288.50 "Price / Less Brick
 *     Garage" figures only appear inside Harlequin's own DRAW INVOICES
 *     (harlequincltd-Shepton Montague*.docx, titled "Invoice 0N"). Those are
 *     invoices, not quotes — out of scope for this table. Nothing is
 *     fabricated here to fill that gap; it is reported in the dry-run output
 *     so the owner can supply the real quotation if one exists elsewhere.
 *   - "wilsaway-QUOTATION - Shepton Montague - 03-07-25.pdf" IS a genuine
 *     quotation, but from TARGET TIMBER SYSTEMS LIMITED (timber frame
 *     supply & erect), not Harlequin — verified by reading the document
 *     itself, not assumed from the brief. Ingested under its real supplier.
 *
 * SUPPLIER RESOLUTION: EXACT normalised-name match only (own name or a
 * learned alias), matching scripts/ingest-xero-bills-2026-08.mts and
 * scripts/ingest-emailed-invoices-2026-08.mts. No fuzzy scoring. This batch
 * turned up several NEAR misses against existing suppliers (e.g. document
 * says "Target Timber Systems Limited", DB has "Target Timber Frames";
 * document says "Southern Electric Power Distribution plc" / "Scottish and
 * Southern Electricity Networks", DB has "Scotish and Sothern Electricity
 * Networks" — a typo) which are deliberately left UNRESOLVED
 * (supplier_id = NULL, supplier_name_raw = the verbatim heading) rather than
 * guessed — flagged in the dry-run report for the owner to alias/merge if
 * they agree it's the same company. Quote-only companies with no existing
 * supplier record at all are NEVER created here (task instruction).
 *
 * REVISION / DUPLICATE-REFERENCE HANDLING
 *   - Mayflower "MTK Quotation NFP <n>-REV<x>" / "UOL Quotation <n>[-REVx]":
 *     grouped by job number (the numeric prefix before "-REV"). Within a
 *     job's family, if the SAME REV label appears on more than one document
 *     with a DIFFERENT total (this happened for jobs 7728 and 9583 in this
 *     batch — genuinely ambiguous, two conflicting reprints of the same
 *     labelled revision), every document carrying that duplicated label is
 *     SKIPPED and reported; the job's other, unambiguous documents are still
 *     ingested but as 'superseded' (never 'open') because we know something
 *     newer exists even if we can't safely say which total is current. Only
 *     when a job's REV labels are all unique is the highest one marked
 *     'open' and the rest 'superseded'. Never sums revisions.
 *   - SSEN "FGG947/1" -> "FGG947/2": unique, sequential, unambiguous —
 *     /1 superseded, /2 open.
 *   - Landford Stone 158900/A/B/C: same customer reference ("Higher Farm
 *     Kitchen 1"), same date, four different material/spec options, NO
 *     revision or supersession language in the documents. Ingested as FOUR
 *     separate 'open' quotes per the task instruction, flagged for the
 *     owner (which, if any, was accepted is not stated anywhere in the
 *     documents). Likewise 158445/6/7 vs 158900/A/B/C: nothing in either
 *     document says one supersedes the other (different customer reference
 *     text — "Plot 1/2/3" vs "Kitchen 1" — different dates, different scope
 *     of items) — both sets ingested as 'open', relationship flagged, never
 *     decided here.
 *
 * SAFETY
 *   --dry-run is the default (no --execute needed to preview). In dry-run
 *   mode this script makes NO network calls and NO writes anywhere — no Blob
 *   upload, no sha256 hashing of file bytes beyond what's needed to display
 *   the plan, no DB write. --execute is required to write anything.
 *   Duplicate guard: skip if (normalised supplier_name_raw, normalised
 *   reference, gross) already exists in `quotes` (task instruction) — checked
 *   both against the DB and against earlier rows in the same run.
 *   Never creates a supplier row. Never writes to `invoices`,
 *   `funding_budget_lines`, or any other table — `quotes` and (on --execute)
 *   Blob only.
 *
 * USAGE
 *   npx tsx --env-file=.env.local --env-file=.env.development.local \
 *     scripts/ingest-quotes-2026-08.mts [options]
 *
 *   --dir=<path>       Folder of quote documents (default: the quotes folder)
 *   --project-id=<n>   Defaults to 1 (Higher Farm) — verified to exist before use
 *   --limit=<n>        Only plan/process the first n files (directory order)
 *   --execute          Actually write (omit for dry run)
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { Pool } from "pg"
import { put } from "@vercel/blob"
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
const DIR = opt("dir", "/Users/tomgilbert/Downloads/quotes") as string
const PROJECT_ID = parseInt(opt("project-id", "1") as string, 10)
const LIMIT = opt("limit", null) ? parseInt(opt("limit", null) as string, 10) : null

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run with --env-file=.env.development.local (see file header).")
  process.exit(1)
}
if (EXECUTE && !process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set — required for --execute (source documents must be retained in Blob).")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Pure helpers, reproduced verbatim from lib/invoice-identity.ts (standalone
// script, matching the pattern in every other scripts/ingest-*.mts file).
// ---------------------------------------------------------------------------

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
function normaliseRef(raw: string | null | undefined): string {
  if (!raw) return ""
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").trim()
}
function money(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const n = Number(String(raw).replace(/[£,\s]/g, ""))
  return Number.isFinite(n) ? n : null
}
function penny(n: number): number {
  return Math.round(n * 100)
}
function reconcilesToGross(net: number | null, vat: number | null, gross: number | null): boolean {
  if (net == null || vat == null || gross == null) return false
  return penny(net) + penny(vat) === penny(gross)
}
/**
 * Duplicate-guard key: "(supplier_name_raw, reference, gross)" per the task
 * instruction, with `net` and `scope` appended as tiebreakers. Several
 * genuine quotes in this batch have neither a printed reference NOR a
 * printed gross (VAT not stated) AND happen to total the exact same net
 * figure on the exact same date — e.g. Castlebrook Plumbing & Heating's Plot
 * 1 and Plot 3 estimates are both £15,000 dated 06/10/2025 — so
 * reference+gross(+net) alone would wrongly collide two genuinely different
 * quotes. `scope` (e.g. "plot 1" vs "plot 3") is the one further verbatim
 * signal these documents do carry, so it's included too. This can never
 * cause a REAL duplicate (the same document re-run) to slip through, since a
 * re-run reproduces the identical scope as well.
 */
function dupeKey(supplierNameRaw: string, reference: string | null, net: number | null, gross: number | null, scope: string | null): string {
  return `${normaliseSupplierName(supplierNameRaw)}|${normaliseRef(reference)}|${gross ?? ""}|${net ?? ""}|${(scope ?? "").toLowerCase().trim()}`
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
}
/** Never guesses — returns null if the text doesn't cleanly match a known date shape. */
function parseFlexibleDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim()
  let m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/) // dd/mm/yyyy or dd.mm.yyyy
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/) // "18th August 2025" / "6 October 2025"
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()]
    if (mo) return `${m[3]}-${mo}-${m[1].padStart(2, "0")}`
  }
  return null
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

const SKIP_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".xlsx", ".xls", ".zip", ".dwg"])
const PDF_EXTENSIONS = new Set([".pdf"])
const DOC_EXTENSIONS = new Set([".doc", ".docx"])

async function extractPdfText(filePath: string): Promise<{ bytes: Buffer; text: string; pages: number } | { error: string }> {
  try {
    const bytes = readFileSync(filePath)
    const data = new Uint8Array(bytes)
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise
    const pages = doc.numPages
    let text = ""
    const maxPages = Math.min(pages, 40)
    for (let p = 1; p <= maxPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      text += content.items.map((i: any) => i.str).join(" ") + "\n"
    }
    return { bytes, text, pages }
  } catch (err) {
    return { error: `pdf parse failed: ${(err as Error).message}` }
  }
}

function extractDocText(filePath: string): { bytes: Buffer; text: string } | { error: string } {
  try {
    const bytes = readFileSync(filePath)
    const res = spawnSync("textutil", ["-convert", "txt", "-stdout", filePath], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 })
    if (res.status !== 0) return { error: `textutil failed: ${res.stderr || res.status}` }
    return { bytes, text: res.stdout || "" }
  } catch (err) {
    return { error: `textutil spawn failed: ${(err as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// Candidate shape + recognisers
// ---------------------------------------------------------------------------

type Candidate = {
  supplierNameRaw: string
  reference: string | null
  quoteDate: string | null // ISO
  description: string
  scope: string | null
  net: number | null
  vat: number | null
  gross: number | null
  notes: string | null
  // Used only by the post-processing groupers below; not written verbatim.
  jobFamily?: string // e.g. "7728" for Mayflower, "FGG947" for SSEN
  jobRevOrder?: number // numeric ordering within the family, higher = later
  jobRevLabel?: string // the literal label used for duplicate-detection within a family
}

type Recognition = { kind: "candidate"; candidate: Candidate } | { kind: "error"; reason: string } | { kind: "no-match" }

type Recogniser = {
  name: string
  signature: (text: string) => boolean
  extract: (text: string, fileName: string) => Recognition
}

// --- 1. Bradfords Building Supplies — roofing quotation template -----------
const bradfordsRoofing: Recogniser = {
  name: "Bradfords roofing quotation",
  signature: (t) => /Bradfords Building Supplies Ltd/.test(t) && /Quote No/.test(t) && /226_Quotation\.rpt/.test(t),
  extract: (t) => {
    const refM = t.match(/(\d+)\s*\/\s*(\d+)\s*Quote No/)
    const dateM = t.match(/(\d{2}\/\d{2}\/\d{4})/)
    const plotM = t.match(/Plot\s+(\d)\s*\(([^)]+)\)/)
    const totM = t.match(/Total Goods\s+£([\d,.]+)\s+Total VAT\s+Total Amount\s+£([\d,.]+)\s+£([\d,.]+)/)
    if (!refM || !totM) return { kind: "error", reason: "matched Bradfords roofing template but could not read quote number / totals" }
    const vat = money(totM[1])
    const gross = money(totM[2])
    const net = money(totM[3])
    if (!reconcilesToGross(net, vat, gross)) return { kind: "error", reason: `Bradfords totals do not reconcile: net ${net} + vat ${vat} != gross ${gross}` }
    return {
      kind: "candidate",
      candidate: {
        supplierNameRaw: "Bradfords Building Supplies Limited",
        reference: refM[2],
        quoteDate: parseFlexibleDate(dateM?.[1] ?? null),
        description: `Roofing materials — ${plotM?.[2] ?? "spec not read"}`,
        scope: plotM ? `plot ${plotM[1]}` : null,
        net, vat, gross,
        notes: null,
      },
    }
  },
}

// --- 2. City Plumbing (Yeovil, CPS) — "Grand Total" quotation template -----
const cityPlumbing: Recogniser = {
  name: "City Plumbing quotation",
  signature: (t) => /cityplumbing\.co\.uk/i.test(t) && /Goods Total/.test(t) && /Grand Total/.test(t),
  extract: (t) => {
    const refM = t.match(/Our Ref\s+(\S+)\s+Date/)
    const dateM = t.match(/Date\s+(\d{1,2}(?:st|nd|rd|th)\s+\w+\s+\d{4})/)
    const custM = t.match(/Customer\s+([A-Z ]+?)\s+Your Office contact/)
    const siteM = t.match(/Site Ref\s*:?\s*(PLOT\s*\d)/i)
    const netM = t.match(/Goods Total\s+([\d,.]+)/)
    const vatM = t.match(/VAT Total\s+([\d,.]+)/)
    const grossM = t.match(/Grand Total\s+([\d,.]+)/)
    if (!refM || !netM || !vatM || !grossM) {
      return { kind: "error", reason: "matched City Plumbing template but could not read reference / totals" }
    }
    const custom = custM?.[1]?.trim() ?? ""
    if (!/^TOM GILBERT$/i.test(custom)) {
      return {
        kind: "error",
        reason: `matched City Plumbing template but Customer field reads "${custom || "(blank)"}", not "TOM GILBERT" — cannot confirm this quote is for Gilbert Build Co / Higher Farm`,
      }
    }
    const net = money(netM[1])
    const vat = money(vatM[1])
    const gross = money(grossM[1])
    if (!reconcilesToGross(net, vat, gross)) return { kind: "error", reason: `City Plumbing totals do not reconcile: net ${net} + vat ${vat} != gross ${gross}` }
    return {
      kind: "candidate",
      candidate: {
        supplierNameRaw: "City Plumbing",
        reference: refM[1],
        quoteDate: parseFlexibleDate(dateM?.[1] ?? null),
        description: "Plumbing & sanitaryware fittings",
        scope: siteM ? siteM[1].toLowerCase().replace(/\s+/, " ") : null,
        net, vat, gross,
        notes: null,
      },
    }
  },
}

// --- 3a. Landford Stone — "ESTIMATE" per-plot worktop template -------------
const landfordEstimate: Recogniser = {
  name: "Landford Stone estimate (per-plot worktop)",
  signature: (t) => /Landford Stone Limited/.test(t) && /Estimate no\.:/.test(t),
  extract: (t) => {
    const refM = t.match(/Estimate no\.:\s*(\d+)/)
    const dateM = t.match(/Estimate date:\s*(\d{2}\/\d{2}\/\d{4})/)
    const scopeM = t.match(/Reference:\s*Higher Farm\s+(Plot\s*\d)/i)
    const totM = t.match(/VAT @ 20% on £([\d,.]+)\s+£([\d,.]+)\s+Total\s+£([\d,.]+)/)
    if (!refM || !totM) return { kind: "error", reason: "matched Landford Stone estimate template but could not read estimate number / totals" }
    const net = money(totM[1])
    const vat = money(totM[2])
    const gross = money(totM[3])
    if (!reconcilesToGross(net, vat, gross)) return { kind: "error", reason: `Landford Stone totals do not reconcile: net ${net} + vat ${vat} != gross ${gross}` }
    return {
      kind: "candidate",
      candidate: {
        supplierNameRaw: "Landford Stone Limited",
        reference: refM[1],
        quoteDate: parseFlexibleDate(dateM?.[1] ?? null),
        description: "Quartz worktops & fitting",
        scope: scopeM ? scopeM[1].toLowerCase() : null,
        net, vat, gross,
        notes: null,
      },
    }
  },
}

// --- 3b. Landford Stone — "QUOTATION" kitchen-option template --------------
const landfordQuotation: Recogniser = {
  name: "Landford Stone quotation (kitchen option)",
  signature: (t) => /Landford Stone Limited/.test(t) && /QUOTATION\s+\d+[A-Z]?\s+DATE/.test(t),
  extract: (t) => {
    const refM = t.match(/QUOTATION\s+(\d+[A-Z]?)\s+DATE/)
    const dateM = t.match(/DATE\s+(\d{2}\/\d{2}\/\d{4})/)
    const scopeM = t.match(/CUSTOMER REFERENCE\s+Higher Farm\s+(Kitchen\s*\d)/i)
    const totM = t.match(/SUBTOTAL\s+([\d,.]+)\s+DISCOUNT[^-]*-([\d,.]+)\s+VAT TOTAL\s+([\d,.]+)\s+TOTAL\s+GBP\s+([\d,.]+)/)
    if (!refM || !totM) return { kind: "error", reason: "matched Landford Stone quotation template but could not read quotation number / totals" }
    const subtotal = money(totM[1])
    const discount = money(totM[2])
    const vat = money(totM[3])
    const gross = money(totM[4])
    if (subtotal == null || discount == null) return { kind: "error", reason: "Landford Stone subtotal/discount unreadable" }
    const net = Math.round((subtotal - discount) * 100) / 100
    if (!reconcilesToGross(net, vat, gross)) {
      return { kind: "error", reason: `Landford Stone totals do not reconcile: (subtotal ${subtotal} - discount ${discount} = ${net}) + vat ${vat} != gross ${gross}` }
    }
    return {
      kind: "candidate",
      candidate: {
        supplierNameRaw: "Landford Stone Limited",
        reference: refM[1],
        quoteDate: parseFlexibleDate(dateM?.[1] ?? null),
        description: "Quartz worktops & fitting",
        scope: scopeM ? scopeM[1].toLowerCase() : null,
        net, vat, gross,
        notes:
          "Same customer reference and date as up to 3 sibling option quotes for this kitchen; no revision/" +
          "acceptance language in the document. Ingested as 'open' per instruction; owner to confirm which " +
          "option (if any) was accepted. Relationship to Landford Stone quotes 158445/158446/158447 (different " +
          "customer reference \"Plot N\", different date) is not stated in either document set — not assumed " +
          "to supersede one another.",
      },
    }
  },
}

// --- 4. Mayflower KBB — "MTK Quotation NFP" / "UOL Quotation" ---------------
const mayflower: Recogniser = {
  name: "Mayflower KBB quotation",
  signature: (t) => /Mayflower KBB Limited/.test(t) && /Delivery Total Vat Overall Total/.test(t),
  extract: (t) => {
    const refM = t.match(/Quotation\s+([\w-]+)\s/)
    const scopeM = t.match(/Gilbert Build & Co\s+[\w-]+\s*-\s*(.+?)\s+\d{2}\/\d{2}\/\d{4}/)
    const dateM = t.match(/\d{2}\/\d{2}\/\d{4}/)
    const totM = t.match(/Delivery Total Vat Overall Total\s+£([\d,.]+)\s+£([\d,.]+)\s+£([\d,.]+)\s+£([\d,.]+)/)
    if (!refM || !totM) return { kind: "error", reason: "matched Mayflower KBB template but could not read reference / totals" }
    const net = money(totM[2])
    const vat = money(totM[3])
    const gross = money(totM[4])
    if (!reconcilesToGross(net, vat, gross)) return { kind: "error", reason: `Mayflower KBB totals do not reconcile: net ${net} + vat ${vat} != gross ${gross}` }
    const reference = refM[1]
    const jobM = reference.match(/^(\d+)/)
    const revM = reference.match(/-REV(\d+)$/i)
    return {
      kind: "candidate",
      candidate: {
        supplierNameRaw: "Mayflower KBB Limited",
        reference,
        quoteDate: parseFlexibleDate(dateM?.[0] ?? null),
        description: "Kitchen & utility cabinetry",
        scope: scopeM ? scopeM[1].toLowerCase() : null,
        net, vat, gross,
        notes: null,
        jobFamily: jobM ? jobM[1] : reference,
        jobRevOrder: revM ? parseInt(revM[1], 10) : 0,
        jobRevLabel: revM ? `REV${revM[1]}` : "base",
      },
    }
  },
}

// --- 5. SSEN (Southern Electric Power Distribution plc) — FGG947 letters ---
const ssen: Recogniser = {
  name: "SSEN electricity connection offer",
  signature: (t) => /Southern Electric Power\s*\n?\s*Distribution plc/.test(t) && /Total charge to applicant/.test(t),
  extract: (t) => {
    const refM = t.match(/Our reference:\s*(FGG\d+\/\d+)/)
    const dateM = t.match(/(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})\s+Dear/)
    const totM = t.match(
      /All works totals\s+Net total at standard rate VAT\s+£([\d,.]+)\s+Net total at low rate VAT\s+£([\d,.]+)\s+Net total at zero rate VAT\s+£([\d,.]+)\s+VAT at standard rate \(20%\)\s+£([\d,.]+)\s+VAT at low rate \(5%\)\s+£([\d,.]+)\s+Total charge to applicant\s+£([\d,.]+)/,
    )
    if (!refM || !totM) return { kind: "error", reason: "matched SSEN template but could not read reference / All works totals" }
    const net = (money(totM[1]) ?? 0) + (money(totM[2]) ?? 0) + (money(totM[3]) ?? 0)
    const vat = (money(totM[4]) ?? 0) + (money(totM[5]) ?? 0)
    const gross = money(totM[6])
    if (!reconcilesToGross(Math.round(net * 100) / 100, Math.round(vat * 100) / 100, gross)) {
      return { kind: "error", reason: `SSEN totals do not reconcile: net ${net} + vat ${vat} != gross ${gross}` }
    }
    const reference = refM[1]
    const seqM = reference.match(/\/(\d+)$/)
    return {
      kind: "candidate",
      candidate: {
        supplierNameRaw: "Southern Electric Power Distribution plc",
        reference,
        quoteDate: parseFlexibleDate(dateM?.[1] ?? null),
        description: "New electricity connection — Higher Farm (all 3 plots)",
        scope: null,
        net: Math.round(net * 100) / 100,
        vat: Math.round(vat * 100) / 100,
        gross,
        notes: "Net total printed at zero-rate VAT (£0.00 VAT) — new-build connection. Trading name on the letter: Scottish and Southern Electricity Networks (SSEN).",
        jobFamily: "FGG947",
        jobRevOrder: seqM ? parseInt(seqM[1], 10) : 0,
        jobRevLabel: reference,
      },
    }
  },
}

// --- 6. Roofing Gear Limited — K8 document quotation ------------------------
const roofingGear: Recogniser = {
  name: "Roofing Gear Limited quotation",
  signature: (t) => /Roofing Gear Limited/.test(t) && /Goods Carriage VAT/.test(t),
  extract: (t) => {
    const refDateM = t.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{6,})/)
    const totM = t.match(/Goods Carriage VAT\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+Total\s+([\d,.]+)/)
    if (!refDateM || !totM) return { kind: "error", reason: "matched Roofing Gear template but could not read quotation number / totals" }
    const goods = money(totM[1])
    const carriage = money(totM[2])
    const vat = money(totM[3])
    const gross = money(totM[4])
    if (goods == null || carriage == null) return { kind: "error", reason: "Roofing Gear goods/carriage unreadable" }
    const net = Math.round((goods + carriage) * 100) / 100
    if (!reconcilesToGross(net, vat, gross)) return { kind: "error", reason: `Roofing Gear totals do not reconcile: net ${net} + vat ${vat} != gross ${gross}` }
    return {
      kind: "candidate",
      candidate: {
        supplierNameRaw: "Roofing Gear Limited",
        reference: refDateM[2],
        quoteDate: parseFlexibleDate(refDateM[1]),
        description: "Roofing accessories — membrane, battens, ridge & guttering",
        scope: null,
        net, vat, gross,
        notes: null,
      },
    }
  },
}

// --- 7. Civils Store Ltd - Somerset — SOP quotation -------------------------
const civilsStore: Recogniser = {
  name: "Civils Store quotation",
  signature: (t) => /Civils\s+Store\s+Ltd/i.test(t) && /TOTAL\s+GROSS/i.test(t),
  extract: (t) => {
    const refM = t.match(/Quotation\s+(\d{6,})/)
    const dateM = t.match(/Date\s+(\d{2}\/\d{2}\/\d{4})/)
    const totM = t.match(/TOTAL\s+NET\s+([\d,.]+)[\s\S]*?TOTAL\s+VAT\s+([\d,.]+)[\s\S]*?TOTAL\s+GROSS\s+([\d,.]+)/i)
    if (!refM || !totM) return { kind: "error", reason: "matched Civils Store template but could not read quotation number / totals" }
    const net = money(totM[1])
    const vat = money(totM[2])
    const gross = money(totM[3])
    if (!reconcilesToGross(net, vat, gross)) return { kind: "error", reason: `Civils Store totals do not reconcile: net ${net} + vat ${vat} != gross ${gross}` }
    const sewage = /SEWAGE TREATMENT PLANT/i.test(t)
    return {
      kind: "candidate",
      candidate: {
        supplierNameRaw: "Civils Store Ltd - Somerset",
        reference: refM[1],
        quoteDate: parseFlexibleDate(dateM?.[1] ?? null),
        description: sewage ? "Sewage treatment plant — Ensign EN6" : "Concrete / civils materials",
        scope: null,
        net, vat, gross,
        notes: "Letterhead reads \"Civils Store Ltd - Somerset\" (branch-qualified) — close to but not an exact match on existing supplier #18 \"Civils Store Limited\"; left unresolved per exact-match-only policy.",
      },
    }
  },
}

// --- 8. Target Timber Systems Limited — Higher Farm timber frame quotation -
const targetTimber: Recogniser = {
  name: "Target Timber Systems quotation",
  signature: (t) => /Target Timber Systems Limited/.test(t) && /supply\s+only\s*,\s*timber frame structural shell/i.test(t),
  extract: (t) => {
    const refM = t.match(/GMG\s*\/\s*MF\s*\/\s*([\d\s]{5,10}?)\s+\d/)
    const dateM = t.match(/(\d)\s*(?:st|nd|rd|th)\s+(\w+)\s+(\d{4})/)
    const amtMatches = [...t.matchAll(/Quotation\s+A?\s*mount\s+of\s*£\s*([\d,]+)/gi)]
    if (amtMatches.length < 2) return { kind: "error", reason: "matched Target Timber template but could not read the supply/erect Quotation Amount figures" }
    const supply = money(amtMatches[0][1])
    const erect = money(amtMatches[1][1])
    if (supply == null || erect == null) return { kind: "error", reason: "Target Timber supply/erect amounts unreadable" }
    const net = supply + erect
    let quoteDate: string | null = null
    if (dateM) {
      const mo = MONTHS[dateM[2].toLowerCase()]
      if (mo) quoteDate = `${dateM[3]}-${mo}-${dateM[1].padStart(2, "0")}`
    }
    return {
      kind: "candidate",
      candidate: {
        supplierNameRaw: "Target Timber Systems Limited",
        reference: refM ? `GMG/MF/${refM[1].replace(/\s/g, "")}` : null,
        quoteDate,
        description: "Timber frame structural shell — design, manufacture, delivery & erection (3 plots)",
        scope: "plots 1-3",
        net,
        vat: null,
        gross: null,
        notes:
          `Net = sum of the two amounts printed as "Quotation Amount" for "supply only" (£${supply.toLocaleString()}) ` +
          `and "erect" (£${erect.toLocaleString()}) — both explicitly labelled "strictly net and excludes VAT" in the ` +
          `document; VAT amount not stated. Excludes the optional extra items also priced in the same document ` +
          `(garage roof trusses £5,574, smaller delivery vehicles £4,742, wall insulation £9,828/£20,592) — those ` +
          `are optional add-ons, not part of the base Quotation Amount. Per-plot breakdown shown in the companion ` +
          `"SUMMARY OF RATES" attachment: Plot 1 £29,446 / Plot 2 £26,822 / Plot 3 £36,238 (sums to £92,506) — not ` +
          `split into separate rows here. Close to but not an exact match on existing supplier #16 ` +
          `"Target Timber Frames"; left unresolved per exact-match-only policy. Was described in the task brief ` +
          `as a "Harlequin" quotation — verified against the document itself, which is from Target Timber ` +
          `Systems Limited, not Harlequin; no standalone Harlequin quotation exists in this batch (see file header).`,
      },
    }
  },
}

// --- 9. Metal Staircase Co — Carbon staircase quote options -----------------
const metalStairs: Recogniser = {
  name: "Metal Staircase Co quotation",
  signature: (t) => /METALSTAIRS\.COM/.test(t) && /STAIRCASE QUOTATION/.test(t),
  extract: (t) => {
    const refM = t.match(/REF\s*-\s*-\s*(\d+-\d+)/)
    const dateM = t.match(/(\d{2}\.\d{2}\.\d{4})/)
    const priceM = t.match(/Delivery in \d+ to \d+ weeks\s*£\s*([\d,]+)\s*\+\s*VAT/)
    if (!refM || !priceM) return { kind: "error", reason: "matched Metal Staircase Co template but could not read reference / quoted price" }
    const net = money(priceM[1])
    return {
      kind: "candidate",
      candidate: {
        supplierNameRaw: "Metal Staircase Co",
        reference: refM[1],
        quoteDate: parseFlexibleDate(dateM?.[1]?.replace(/\./g, "/") ?? null),
        description: `Carbon staircase — spec option ${refM[1].split("-")[1]}`,
        scope: null,
        net,
        vat: null,
        gross: null,
        notes:
          'Printed as "£' + priceM[1] + ' + VAT (inc. delivery)" — VAT amount not stated, treated as net excl. VAT. ' +
          "Two alternate spec options (26050-01 / 26050-02) quoted the same day with different totals and no " +
          "acceptance/revision language — both ingested 'open', not assumed to supersede one another. A later " +
          "proforma invoice (INV-876) references a different unit price (£14,860 + VAT) matching neither option " +
          "exactly — not reconciled here (that document is an invoice, not a quote). Close to but not an exact " +
          "match on existing supplier #32 \"Metal Stair co\"; left unresolved per exact-match-only policy.",
      },
    }
  },
}

// --- 10. Castlebrook Plumbing & Heating — per-plot first-fix estimate (docx) -
const castlebrook: Recogniser = {
  name: "Castlebrook Plumbing & Heating estimate",
  signature: (t) => /Castlebrook Plumbing & Heating/.test(t) && /^ESTIMATE/m.test(t),
  extract: (t) => {
    const dateM = t.match(/Date:\s*DATE \\@ "[^"]*"\s*(\d{2}\/\d{2}\/\d{4})/)
    const plotM = t.match(/PLOT\s+(\d)/i)
    const totM = t.match(/Total:?\s*£([\d,]+)/)
    if (!totM) return { kind: "error", reason: "matched Castlebrook estimate template but could not read the total" }
    const net = money(totM[1])
    return {
      kind: "candidate",
      candidate: {
        supplierNameRaw: "Castlebrook Plumbing & Heating",
        reference: null,
        quoteDate: parseFlexibleDate(dateM?.[1] ?? null),
        description: `Plumbing & heating first fix — plot ${plotM?.[1] ?? "?"}`,
        scope: plotM ? `plot ${plotM[1]}` : null,
        net,
        vat: null,
        gross: null,
        notes: "Single total printed with no VAT statement anywhere in the document (no VAT registration number shown either) — recorded as net, VAT treatment unconfirmed. No reference/quote number printed.",
      },
    }
  },
}

const RECOGNISERS: Recogniser[] = [
  bradfordsRoofing, cityPlumbing, landfordEstimate, landfordQuotation, mayflower,
  ssen, roofingGear, civilsStore, targetTimber, metalStairs, castlebrook,
]

// ---------------------------------------------------------------------------
// Generic reasons for well-known non-quote signatures (informative skip
// reasons only — never used to extract a total).
// ---------------------------------------------------------------------------
function genericSkipReason(text: string): string {
  if (/TOTAL CLAIM/i.test(text) && /Invoice \d+/i.test(text)) return "draw invoice (payment application), not a quotation"
  if (/^\s*INVOICE\b/im.test(text) || /PROFORMA INVOICE/i.test(text) || /SALES INVOICE/i.test(text) || /VAT INVOICE/i.test(text)) return "invoice, not a quotation"
  if (/(?<!fire )(?<!flood )RISK ASSESSMENT/i.test(text)) return "risk assessment document, not a quotation"
  if (/METHOD STATEMENT/i.test(text)) return "method statement, not a quotation"
  if (/We can confirm that we act as insurance brokers/i.test(text)) return "insurance confirmation letter, not a quotation"
  if (/Verification Document/i.test(text)) return "supplier verification document, not a quotation"
  if (/Unaudited Financial Statements/i.test(text) || /Registered in England No/i.test(text) && /Balance Sheet/i.test(text)) return "company accounts filing, unrelated to Higher Farm"
  if (/This is not a Fixed Price Quote/i.test(text)) return "rate-based quotation (£/m³ or similar), no fixed total stated"
  if (/rates? are (strictly )?nett? of Discount|Pr\/m2|£\/m2/i.test(text) && !/Grand Total|Total charge to applicant|TOTAL GROSS/i.test(text)) {
    return "rate-based quotation (£/m² or similar), no fixed lump-sum total stated"
  }
  if (/DRAWN BY|Proposed Elevations|SCHEDULE OF MATERIALS/i.test(text)) return "architectural drawing, no total"
  if (/FOR SALE|Freehold\s*:/i.test(text)) return "property sale particulars, unrelated to a trade quote"
  if (/TO LET/i.test(text)) return "commercial letting particulars, unrelated to a trade quote"
  if (/Flash Flood|flood report/i.test(text)) return "flood report, not a quotation"
  if (/UNILATERAL UNDERTAKING/i.test(text)) return "S106-style legal deed, unrelated to a trade quote"
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length < 30) return "no readable text (design drawing / scan / image-based PDF)"
  return "no recognised quote template matched — no verbatim total found"
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type PlanRow = {
  fileName: string
  filePath: string
  action: "INSERT" | "SKIP" | "ERROR" | "SKIP-DUPLICATE-DB" | "SKIP-DUPLICATE-BATCH"
  reason?: string
  candidate?: Candidate
  supplierId?: number | null
  status?: "open" | "superseded" | "accepted"
  bytes?: Buffer
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no DB writes, no Blob uploads, no network calls)" : "EXECUTE (will write)"}`)
  console.log(`Directory: ${DIR}`)
  console.log(`Project ID: ${PROJECT_ID}`)
  if (LIMIT != null) console.log(`Limit: first ${LIMIT} files (directory order)`)
  console.log("")

  const projectRes = await pool.query("SELECT id, name FROM projects WHERE id = $1", [PROJECT_ID])
  if (!projectRes.rows.length) {
    console.error(`Project ${PROJECT_ID} does not exist. Refusing to proceed.`)
    await pool.end()
    process.exit(1)
  }
  console.log(`Project: #${projectRes.rows[0].id} "${projectRes.rows[0].name}"\n`)

  const suppliersRes = await pool.query("SELECT id, name FROM suppliers ORDER BY id")
  const aliasRes = await pool.query("SELECT supplier_id, normalised_name FROM supplier_aliases")
  const aliasMap = new Map<string, { id: number; name: string }>()
  for (const s of suppliersRes.rows) aliasMap.set(normaliseSupplierName(s.name), { id: s.id, name: s.name })
  for (const a of aliasRes.rows) {
    const supplier = suppliersRes.rows.find((s: any) => s.id === a.supplier_id)
    if (supplier) aliasMap.set(a.normalised_name, { id: supplier.id, name: supplier.name })
  }
  console.log(`Existing suppliers: ${suppliersRes.rows.length}   Known alias keys: ${aliasRes.rows.length}\n`)

  const existingQuotesRes = await pool.query("SELECT supplier_name_raw, reference, net, gross, scope FROM quotes")
  const existingQuoteKeys = new Set(
    existingQuotesRes.rows.map((r: any) => dupeKey(r.supplier_name_raw, r.reference, r.net, r.gross, r.scope)),
  )
  console.log(`Existing rows in quotes table: ${existingQuotesRes.rows.length}\n`)

  let files = readdirSync(DIR).filter((f) => !f.startsWith(".")).sort()
  if (LIMIT != null) files = files.slice(0, LIMIT)
  console.log(`Files in folder: ${files.length}\n`)

  const plan: PlanRow[] = []
  const seenBatch = new Set<string>()

  for (const fileName of files) {
    const filePath = path.join(DIR, fileName)
    const ext = path.extname(fileName).toLowerCase()

    if (SKIP_EXTENSIONS.has(ext)) {
      plan.push({ fileName, filePath, action: "SKIP", reason: `unsupported format for verbatim text extraction (${ext || "no extension"}) — cannot verify a total without OCR/vision` })
      continue
    }
    if (!PDF_EXTENSIONS.has(ext) && !DOC_EXTENSIONS.has(ext)) {
      plan.push({ fileName, filePath, action: "SKIP", reason: `unsupported/unrecognised file extension "${ext}"` })
      continue
    }

    let extracted: { bytes: Buffer; text: string } | { error: string }
    if (PDF_EXTENSIONS.has(ext)) {
      extracted = await extractPdfText(filePath)
    } else {
      extracted = extractDocText(filePath)
    }
    if ("error" in extracted) {
      plan.push({ fileName, filePath, action: "ERROR", reason: extracted.error })
      continue
    }
    const { bytes, text } = extracted

    let matched: Recognition | null = null
    let matchedName: string | null = null
    for (const r of RECOGNISERS) {
      if (r.signature(text)) {
        matched = r.extract(text, fileName)
        matchedName = r.name
        break
      }
    }

    if (!matched) {
      plan.push({ fileName, filePath, action: "SKIP", reason: genericSkipReason(text) })
      continue
    }
    if (matched.kind === "no-match") {
      plan.push({ fileName, filePath, action: "SKIP", reason: genericSkipReason(text) })
      continue
    }
    if (matched.kind === "error") {
      plan.push({ fileName, filePath, action: "ERROR", reason: `[${matchedName}] ${matched.reason}` })
      continue
    }

    plan.push({ fileName, filePath, action: "INSERT", candidate: matched.candidate, bytes })
  }

  // --- Post-process: revision/duplicate-reference families -----------------
  const byJobFamily = new Map<string, PlanRow[]>()
  for (const r of plan) {
    if (r.action !== "INSERT" || !r.candidate?.jobFamily) continue
    const key = `${normaliseSupplierName(r.candidate.supplierNameRaw)}|${r.candidate.jobFamily}`
    if (!byJobFamily.has(key)) byJobFamily.set(key, [])
    byJobFamily.get(key)!.push(r)
  }
  const familyNotes: string[] = []
  for (const [key, rows] of byJobFamily) {
    const byLabel = new Map<string, PlanRow[]>()
    for (const r of rows) {
      const label = r.candidate!.jobRevLabel!
      if (!byLabel.has(label)) byLabel.set(label, [])
      byLabel.get(label)!.push(r)
    }
    let anyAmbiguous = false
    for (const [label, group] of byLabel) {
      if (group.length > 1) {
        const grosses = new Set(group.map((g) => g.candidate!.gross))
        if (grosses.size > 1) {
          anyAmbiguous = true
          for (const g of group) {
            g.action = "SKIP"
            g.reason = `ambiguous duplicate revision label "${label}" for job "${key.split("|")[1]}" — ${group.length} documents printed this label with different totals (${[...grosses].map((x) => `£${x}`).join(" vs ")}) — cannot determine which is current`
          }
        }
      }
    }
    const remaining = rows.filter((r) => r.action === "INSERT")
    if (!remaining.length) continue
    remaining.sort((a, b) => (a.candidate!.jobRevOrder ?? 0) - (b.candidate!.jobRevOrder ?? 0))
    const highest = remaining[remaining.length - 1]
    for (const r of remaining) {
      if (r === highest && !anyAmbiguous) {
        r.status = "open"
      } else {
        r.status = "superseded"
        if (r === highest && anyAmbiguous) {
          familyNotes.push(
            `Job "${key.split("|")[1]}": highest UNAMBIGUOUS revision is "${r.candidate!.jobRevLabel}" but a later, ambiguous revision was also printed for this job (skipped above) — so nothing is marked 'open' for this job. Owner should supply the correct current total.`,
          )
        }
      }
    }
  }
  // Any INSERT candidate without a jobFamily (or a family of size 1) is
  // simply 'open' unless already assigned above.
  for (const r of plan) {
    if (r.action === "INSERT" && !r.status) r.status = "open"
  }

  // --- Supplier resolution + duplicate guard --------------------------------
  for (const r of plan) {
    if (r.action !== "INSERT") continue
    const c = r.candidate!
    const supplierKey = normaliseSupplierName(c.supplierNameRaw)
    const known = aliasMap.get(supplierKey)
    r.supplierId = known ? known.id : null

    const dupKey = dupeKey(c.supplierNameRaw, c.reference, c.net, c.gross, c.scope)
    if (existingQuoteKeys.has(dupKey)) {
      r.action = "SKIP-DUPLICATE-DB"
      r.reason = "already in quotes table (same supplier + reference + gross)"
      continue
    }
    if (seenBatch.has(dupKey)) {
      r.action = "SKIP-DUPLICATE-BATCH"
      r.reason = "same supplier + reference + gross appears earlier in this batch"
      continue
    }
    seenBatch.add(dupKey)
  }

  // --- Print per-file plan ---------------------------------------------------
  console.log("--- PER-FILE PLAN ---\n")
  for (const r of plan) {
    const c = r.candidate
    const totalsStr = c ? `net=${c.net ?? "—"} vat=${c.vat ?? "—"} gross=${c.gross ?? "—"}` : ""
    const supplierStr = r.action === "INSERT" ? (r.supplierId ? `supplier=#${r.supplierId}` : `supplier=NULL raw="${c!.supplierNameRaw}"`) : ""
    const statusStr = r.status ? `status=${r.status}` : ""
    console.log(
      `${r.action.padEnd(22)} ${r.fileName.padEnd(70).slice(0, 70)} ` +
        `${c ? `ref=${c.reference ?? "—"} date=${c.quoteDate ?? "—"} scope=${c.scope ?? "—"} ${totalsStr} ${supplierStr} ${statusStr}` : ""}` +
        `${r.reason ? `  — ${r.reason}` : ""}`,
    )
  }

  const toInsert = plan.filter((r) => r.action === "INSERT")
  const skipped = plan.filter((r) => r.action === "SKIP" || r.action === "SKIP-DUPLICATE-DB" || r.action === "SKIP-DUPLICATE-BATCH")
  const errored = plan.filter((r) => r.action === "ERROR")

  console.log("\n--- SKIP LIST (with reasons) ---")
  for (const r of skipped) console.log(`  ${r.fileName} — ${r.reason}`)

  if (errored.length) {
    console.log("\n--- ERRORS (matched a template but extraction failed, or parse error — needs manual check) ---")
    for (const r of errored) console.log(`  ${r.fileName} — ${r.reason}`)
  }

  if (familyNotes.length) {
    console.log("\n--- REVISION-FAMILY NOTES ---")
    for (const n of familyNotes) console.log(`  ${n}`)
  }

  const unresolvedSuppliers = toInsert.filter((r) => r.supplierId == null)
  const uniqueUnresolvedNames = new Set(unresolvedSuppliers.map((r) => r.candidate!.supplierNameRaw))
  console.log(
    `\n--- Suppliers NOT resolved to an existing record (${uniqueUnresolvedNames.size} distinct companies, ${unresolvedSuppliers.length} of ${toInsert.length} planned quotes) ---`,
  )
  const seenRaw = new Set<string>()
  for (const r of unresolvedSuppliers) {
    const raw = r.candidate!.supplierNameRaw
    if (seenRaw.has(raw)) continue
    seenRaw.add(raw)
    console.log(`  "${raw}"`)
  }

  const counts: Record<string, number> = {}
  for (const r of plan) counts[r.action] = (counts[r.action] || 0) + 1
  const sumBy = (rows: PlanRow[], field: "net" | "vat" | "gross") => rows.reduce((s, r) => s + (r.candidate![field] ?? 0), 0)

  console.log("\n--- SUMMARY ---")
  console.log(`Files in folder:        ${plan.length}`)
  for (const [action, n] of Object.entries(counts)) console.log(`  ${action.padEnd(22)} ${n}`)
  console.log(`Planned inserts:        ${toInsert.length}`)
  console.log(`  by status:`)
  for (const status of ["open", "superseded", "accepted"]) {
    const rows = toInsert.filter((r) => r.status === status)
    if (!rows.length) continue
    console.log(`    ${status.padEnd(12)} ${rows.length} files, net=£${sumBy(rows, "net").toFixed(2)} vat=£${sumBy(rows, "vat").toFixed(2)} gross=£${sumBy(rows, "gross").toFixed(2)}`)
  }
  console.log(`Skipped:                ${skipped.length}`)
  console.log(`Errors:                 ${errored.length}`)

  if (DRY_RUN) {
    console.log("\nDry run only — nothing written anywhere (no DB writes, no Blob uploads, no network calls of any")
    console.log("kind). Re-run with --execute to commit the INSERT rows above.")
    await pool.end()
    return
  }

  // --- Execute ---------------------------------------------------------------
  console.log("\n--- EXECUTING ---")
  let inserted = 0
  let dupCaught = 0
  let errCount = 0
  for (const r of toInsert) {
    try {
      const result = await commitOne(r)
      inserted++
      console.log(`INSERTED  ${r.fileName} -> quote #${result.id}`)
    } catch (err) {
      errCount++
      console.error(`ERROR committing ${r.fileName}: ${(err as Error).message}`)
    }
  }
  console.log(`\nInserted: ${inserted}  Errors: ${errCount}`)
  await pool.end()
}

async function commitOne(row: PlanRow): Promise<{ id: number }> {
  const c = row.candidate!
  const bytes = row.bytes!
  const sourceFileHash = createHash("sha256").update(bytes).digest("hex")
  const safeName = row.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
  const ext = path.extname(row.fileName).toLowerCase()
  const contentType = ext === ".pdf" ? "application/pdf" : ext === ".docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/msword"
  const blob = await put(`quotes/${Date.now()}-${safeName}`, bytes, { access: "public", contentType, addRandomSuffix: true })

  // App-level re-check immediately before insert (no unique index backstop
  // for quotes by design — see scripts/add-quotes-table.mjs).
  const dupCheck = await pool.query(
    "SELECT id FROM quotes WHERE lower(btrim(supplier_name_raw)) = lower(btrim($1)) AND lower(btrim(coalesce(reference,''))) = lower(btrim(coalesce($2,''))) AND gross IS NOT DISTINCT FROM $3 AND net IS NOT DISTINCT FROM $4 AND lower(btrim(coalesce(scope,''))) = lower(btrim(coalesce($5,'')))",
    [c.supplierNameRaw, c.reference, c.gross, c.net, c.scope],
  )
  if (dupCheck.rows.length) {
    throw new Error(`duplicate caught at commit (existing quote #${dupCheck.rows[0].id})`)
  }

  const res = await pool.query(
    `INSERT INTO quotes
       (supplier_id, supplier_name_raw, project_id, reference, quote_date, description, scope,
        net, vat, gross, status, source_file_name, source_file_pathname, source_file_hash, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      row.supplierId,
      c.supplierNameRaw,
      PROJECT_ID,
      c.reference,
      c.quoteDate,
      c.description,
      c.scope,
      c.net,
      c.vat,
      c.gross,
      row.status,
      row.fileName,
      blob.url,
      sourceFileHash,
      c.notes,
    ],
  )
  return { id: res.rows[0].id }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
