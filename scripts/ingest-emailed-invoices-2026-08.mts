/**
 * Ingest supplier invoices recovered from the owner's email — landed as PDFs
 * at /Users/tomgilbert/Downloads/chased-invoices/ alongside a hand-built
 * `_manifest.json` (an array of entries; see the type below). The manifest is
 * the SOURCE OF TRUTH: every amount, date, description and code in it was
 * transcribed by a human from the original document. This script never
 * infers, corrects or adjusts a manifest value — it validates, resolves,
 * and writes exactly what the manifest says (non-negotiable #1).
 *
 * MANIFEST SHAPE (array of):
 *   {
 *     file: string,                 // PDF filename, relative to the manifest's own directory
 *     supplierName: string,         // Xero contact name; may be NEW to Gilbert OS
 *     invoiceNumber: string,
 *     invoiceDate: string,          // ISO "YYYY-MM-DD"
 *     net: number, vat: number, gross: number,
 *     description: string,          // single line-item description
 *     costPackageCode: string|null, // null = leave unclassified, never guessed
 *     xeroBankTxId: string|null,    // the SPEND transaction this invoice belongs to
 *     paymentStatus: "unpaid"|"paid"|"part_paid"|null,
 *   }
 *
 * VALIDATION (every entry, before anything else)
 *   Required fields present and correctly typed, invoiceDate is a real ISO
 *   calendar date, net/vat/gross are finite numbers, and gross === net + vat
 *   to the penny (integer-pence comparison, not float equality). A failing
 *   entry is REJECTED and reported with every reason it failed; the rest of
 *   the manifest is still processed. This script also refuses an entry whose
 *   PDF cannot be found on disk (it cannot upload/hash a file that doesn't
 *   exist) and an entry whose costPackageCode doesn't match a real cost
 *   package for the project — that second case does NOT reject the entry
 *   (the invoice is still real and still gets written); it leaves
 *   cost_package_id NULL and reports the mismatch, exactly like an
 *   unresolved costPackageCode of `null`.
 *
 * WHY NOT commitInvoice() DIRECTLY
 *   Same reasoning as scripts/ingest-xero-bills-2026-08.mts (read that file's
 *   header first): commitInvoice calls revalidatePath, which throws outside a
 *   real Next.js request context — AFTER the real write has already
 *   committed. commitOne() below reproduces commitInvoice's transaction body
 *   verbatim in shape (same app-level duplicate re-check, same column
 *   mapping, same classification_mappings/supplier_aliases upserts, same
 *   price_records gating) minus the revalidatePath calls.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 *   - No price-DB writes, ever. product_id is always NULL and is_price_tracked
 *     is always false on the single line item this script writes per invoice
 *     — a chased-from-email invoice's line here is a manifest-transcribed
 *     total, not a parsed materials breakdown (non-negotiable #8/#11).
 *   - No supplier fuzzy-matching. Resolution is EXACT-normalised-name only
 *     (own name or a learned alias), matching ingest-xero-bills-2026-08.mts.
 *   - No cost-package guessing. A costPackageCode that doesn't resolve stays
 *     NULL and is reported — never mapped to "the nearest package".
 *   - No Xero calls of any kind — this script only reads local PDFs and
 *     writes to Gilbert OS. Attaching to Xero is scripts/attach-invoices-to-xero-2026-08.mts.
 *
 * DUPLICATE PROTECTION (four layers, matching every other ingest script here)
 *   (a) pre-flight check against every invoice already in the DB for the
 *       resolved supplier (existing suppliers only),
 *   (b) an intra-batch guard so two entries in THIS run resolving to the same
 *       (normalised supplier, normalised invoice number) can't both insert,
 *   (c) an in-transaction re-check identical in shape to commitInvoice's,
 *   (d) the DB's partial unique index invoices_supplier_type_number_uidx as
 *       the final backstop. A duplicate write commits nothing — no invoice,
 *       no line item, no price record, no learning upsert.
 *
 * SAFETY
 *   --dry-run is the default (no --execute needed to preview). In dry-run
 *   mode this script makes NO network calls and NO writes anywhere — Blob
 *   upload, sha256 hashing and every DB write happen only inside commitOne(),
 *   which is only ever called under --execute. Dry run only checks that each
 *   entry's PDF exists on disk (existsSync) — it never reads the bytes.
 *   --execute is required to write anything to Postgres or Blob.
 *
 * USAGE
 *   npx tsx --env-file=.env.local --env-file=.env.development.local \
 *     scripts/ingest-emailed-invoices-2026-08.mts [options]
 *
 *   --manifest=<path>  Path to _manifest.json (default: the folder above)
 *   --limit=<n>         Only plan/process the first n VALID entries (manifest order)
 *   --project-id=<n>    Defaults to 1 (Higher Farm) — verified to exist before use
 *   --execute           Actually write (omit for dry run)
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Pool } from "pg"
import { put } from "@vercel/blob"

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
const DEFAULT_MANIFEST = "/Users/tomgilbert/Downloads/chased-invoices/_manifest.json"
const MANIFEST_PATH = opt("manifest", DEFAULT_MANIFEST) as string
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
// lib/normalisation/products.ts (standalone script, matching the pattern in
// scripts/ingest-xero-bills-2026-08.mts — reproduced, not imported, so drift
// can be caught by re-diffing against the source files noted).
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

// --- lib/normalisation/products.ts -------------------------------------------
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

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function toPence(n: number): number {
  return Math.round(n * 100)
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

const PAYMENT_STATUSES = new Set(["unpaid", "paid", "part_paid"])

type ValidatedEntry = {
  index: number
  file: string
  supplierName: string
  invoiceNumber: string
  invoiceDate: string
  net: number
  vat: number
  gross: number
  description: string
  costPackageCode: string | null
  xeroBankTxId: string | null
  paymentStatus: "unpaid" | "paid" | "part_paid" | null
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return false
  // Reject rolled-over dates like 2026-02-30 -> March, which Date silently accepts.
  return d.toISOString().slice(0, 10) === s
}

function validateEntry(raw: unknown, index: number): { ok: true; entry: ValidatedEntry } | { ok: false; reasons: string[] } {
  const reasons: string[] = []
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reasons: ["entry is not a JSON object"] }
  }
  const r = raw as Record<string, unknown>

  const file = r.file
  if (typeof file !== "string" || !file.trim()) reasons.push(`missing/invalid "file" (got ${JSON.stringify(file)})`)

  const supplierName = r.supplierName
  if (typeof supplierName !== "string" || !supplierName.trim()) {
    reasons.push(`missing/invalid "supplierName" (got ${JSON.stringify(supplierName)})`)
  }

  const invoiceNumber = r.invoiceNumber
  if (typeof invoiceNumber !== "string" || !invoiceNumber.trim()) {
    reasons.push(`missing/invalid "invoiceNumber" (got ${JSON.stringify(invoiceNumber)})`)
  }

  const invoiceDate = r.invoiceDate
  if (typeof invoiceDate !== "string" || !isValidIsoDate(invoiceDate)) {
    reasons.push(`missing/invalid ISO "invoiceDate" (got ${JSON.stringify(invoiceDate)})`)
  }

  const net = r.net
  const vat = r.vat
  const gross = r.gross
  const netOk = typeof net === "number" && Number.isFinite(net)
  const vatOk = typeof vat === "number" && Number.isFinite(vat)
  const grossOk = typeof gross === "number" && Number.isFinite(gross)
  if (!netOk) reasons.push(`"net" is not a finite number (got ${JSON.stringify(net)})`)
  if (!vatOk) reasons.push(`"vat" is not a finite number (got ${JSON.stringify(vat)})`)
  if (!grossOk) reasons.push(`"gross" is not a finite number (got ${JSON.stringify(gross)})`)
  if (netOk && vatOk && grossOk) {
    const expectedPence = toPence(net as number) + toPence(vat as number)
    const actualPence = toPence(gross as number)
    if (expectedPence !== actualPence) {
      reasons.push(
        `gross (£${(gross as number).toFixed(2)}) != net+vat (£${round2((net as number) + (vat as number)).toFixed(2)}) ` +
          `— off by £${((actualPence - expectedPence) / 100).toFixed(2)}`,
      )
    }
  }

  const description = r.description
  if (typeof description !== "string" || !description.trim()) {
    reasons.push(`missing/invalid "description" (got ${JSON.stringify(description)})`)
  }

  let costPackageCode: string | null = null
  if (r.costPackageCode !== null && r.costPackageCode !== undefined) {
    if (typeof r.costPackageCode !== "string" || !r.costPackageCode.trim()) {
      reasons.push(`"costPackageCode" must be a non-empty string or null (got ${JSON.stringify(r.costPackageCode)})`)
    } else {
      costPackageCode = r.costPackageCode.trim()
    }
  }

  let xeroBankTxId: string | null = null
  if (r.xeroBankTxId !== null && r.xeroBankTxId !== undefined) {
    if (typeof r.xeroBankTxId !== "string" || !r.xeroBankTxId.trim()) {
      reasons.push(`"xeroBankTxId" must be a non-empty string or null (got ${JSON.stringify(r.xeroBankTxId)})`)
    } else {
      xeroBankTxId = r.xeroBankTxId.trim()
    }
  }

  let paymentStatus: "unpaid" | "paid" | "part_paid" | null = null
  if (r.paymentStatus !== null && r.paymentStatus !== undefined) {
    if (typeof r.paymentStatus !== "string" || !PAYMENT_STATUSES.has(r.paymentStatus)) {
      reasons.push(`"paymentStatus" must be one of unpaid/paid/part_paid or null (got ${JSON.stringify(r.paymentStatus)})`)
    } else {
      paymentStatus = r.paymentStatus as "unpaid" | "paid" | "part_paid"
    }
  }

  if (reasons.length) return { ok: false, reasons }
  return {
    ok: true,
    entry: {
      index,
      file: (file as string).trim(),
      supplierName: (supplierName as string).trim(),
      invoiceNumber: (invoiceNumber as string).trim(),
      invoiceDate: invoiceDate as string,
      net: net as number,
      vat: vat as number,
      gross: gross as number,
      description: (description as string).trim(),
      costPackageCode,
      xeroBankTxId,
      paymentStatus,
    },
  }
}

function loadManifest(manifestPath: string): unknown[] {
  if (!existsSync(manifestPath)) {
    console.error(`Manifest not found at ${manifestPath}.`)
    console.error(
      "Nothing to do — this script needs a manifest built by the orchestrator at the invoices folder root " +
        "(or pass --manifest=<path> to point at one, e.g. a sample for validation-logic testing).",
    )
    process.exit(1)
  }
  let raw: string
  try {
    raw = readFileSync(manifestPath, "utf8")
  } catch (err) {
    console.error(`Could not read manifest at ${manifestPath}: ${(err as Error).message}`)
    process.exit(1)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error(`Manifest at ${manifestPath} is not valid JSON: ${(err as Error).message}`)
    process.exit(1)
  }
  if (!Array.isArray(parsed)) {
    console.error(`Manifest at ${manifestPath} must be a JSON array of entries; got ${typeof parsed}.`)
    process.exit(1)
  }
  return parsed
}

function buildNotes(entry: ValidatedEntry): string {
  return entry.xeroBankTxId
    ? `Recovered from email; matched to Xero bank transaction ${entry.xeroBankTxId}.`
    : "Recovered from email; no matching Xero bank transaction identified."
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

type SupplierResolution =
  | { kind: "existing"; id: number; name: string }
  | { kind: "new"; id: null; name: string }

type PlanRow = {
  action: "INSERT" | "SKIP-DUPLICATE-DB" | "SKIP-DUPLICATE-BATCH" | "ERROR"
  entry: ValidatedEntry
  reason?: string
  supplier?: SupplierResolution
  filePath?: string
  costPackageId?: number | null
  costPackageWarning?: string | null
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no DB writes, no Blob uploads, no network calls)" : "EXECUTE (will write)"}`)
  console.log(`Manifest: ${MANIFEST_PATH}`)
  console.log(`Project ID: ${PROJECT_ID}`)
  if (LIMIT != null) console.log(`Limit: first ${LIMIT} valid entries (manifest order)`)
  console.log("")

  const manifestEntries = loadManifest(MANIFEST_PATH)
  const manifestDir = path.dirname(MANIFEST_PATH)
  console.log(`Entries in manifest: ${manifestEntries.length}`)

  const validated: ValidatedEntry[] = []
  const invalid: { index: number; raw: unknown; reasons: string[] }[] = []
  manifestEntries.forEach((raw, i) => {
    const v = validateEntry(raw, i)
    if (v.ok) validated.push(v.entry)
    else invalid.push({ index: i, raw, reasons: v.reasons })
  })

  console.log(`Valid entries:    ${validated.length}`)
  console.log(`Rejected entries: ${invalid.length}\n`)

  if (invalid.length) {
    console.log("--- REJECTED ENTRIES (schema validation — these are NOT processed) ---")
    for (const r of invalid) {
      const rr = r.raw as Record<string, unknown> | null
      const label = rr && typeof rr.file === "string" ? rr.file : "(no file field)"
      console.log(`  [${r.index}] ${label}`)
      for (const reason of r.reasons) console.log(`      - ${reason}`)
    }
    console.log("")
  }

  const toProcess = LIMIT != null ? validated.slice(0, LIMIT) : validated

  // --- Verify the target project (never invented — must already exist) ---
  const projectRes = await pool.query("SELECT id, name FROM projects WHERE id = $1", [PROJECT_ID])
  if (!projectRes.rows.length) {
    console.error(`Project ${PROJECT_ID} does not exist. Refusing to proceed.`)
    await pool.end()
    process.exit(1)
  }
  console.log(`Project: #${projectRes.rows[0].id} "${projectRes.rows[0].name}"\n`)

  // --- Cost packages for this project (code -> row); never fabricated ---
  const cpRes = await pool.query("SELECT id, code, name FROM cost_packages WHERE project_id = $1", [PROJECT_ID])
  const packageByCode = new Map<string, { id: number; code: string; name: string }>()
  for (const p of cpRes.rows) if (p.code) packageByCode.set(p.code, p)
  console.log(`Cost packages for project ${PROJECT_ID}: ${cpRes.rows.length}\n`)

  // --- Existing suppliers + aliases -> exact-normalised-name resolution map ---
  const suppliersRes = await pool.query("SELECT id, name FROM suppliers ORDER BY id")
  const aliasRes = await pool.query("SELECT supplier_id, normalised_name FROM supplier_aliases")
  const aliasMap = new Map<string, { id: number; name: string }>()
  for (const s of suppliersRes.rows) {
    aliasMap.set(normaliseSupplierName(s.name), { id: s.id, name: s.name })
  }
  for (const a of aliasRes.rows) {
    const supplier = suppliersRes.rows.find((s: any) => s.id === a.supplier_id)
    if (supplier) aliasMap.set(a.normalised_name, { id: supplier.id, name: supplier.name })
  }
  console.log(`Existing suppliers: ${suppliersRes.rows.length}   Known alias keys: ${aliasRes.rows.length}\n`)

  const pendingNewSuppliers = new Map<string, SupplierResolution>()

  // --- Existing invoices, for the pre-flight duplicate set ---
  const existingInvRes = await pool.query(
    "SELECT supplier_id, transaction_type, invoice_number FROM invoices WHERE invoice_number IS NOT NULL",
  )
  const existingKeys = new Set(
    existingInvRes.rows.map((r: any) => `${r.supplier_id}|${r.transaction_type}|${normaliseDocNumber(r.invoice_number)}`),
  )
  console.log(`Existing invoices in DB (all suppliers): ${existingInvRes.rows.length}\n`)

  const seenThisBatch = new Set<string>()
  const plan: PlanRow[] = []

  for (const entry of toProcess) {
    const nContact = normaliseSupplierName(entry.supplierName)
    if (!nContact) {
      plan.push({ action: "ERROR", entry, reason: `supplierName "${entry.supplierName}" normalises to empty` })
      continue
    }
    const nNumber = normaliseDocNumber(entry.invoiceNumber)
    if (!nNumber) {
      plan.push({ action: "ERROR", entry, reason: `invoiceNumber "${entry.invoiceNumber}" normalises to empty` })
      continue
    }

    // --- Supplier resolution: EXACT normalised-name match only (own name or
    // a learned alias). No fuzzy scoring — matches ingest-xero-bills-2026-08.mts. ---
    let supplier: SupplierResolution
    const known = aliasMap.get(nContact)
    if (known) {
      supplier = { kind: "existing", id: known.id, name: known.name }
    } else if (pendingNewSuppliers.has(nContact)) {
      supplier = pendingNewSuppliers.get(nContact) as SupplierResolution
    } else {
      supplier = { kind: "new", id: null, name: entry.supplierName }
      pendingNewSuppliers.set(nContact, supplier)
    }

    // --- Duplicate checks ---
    const batchKey = `${nContact}|${nNumber}`
    if (supplier.kind === "existing" && existingKeys.has(`${supplier.id}|invoice|${nNumber}`)) {
      plan.push({
        action: "SKIP-DUPLICATE-DB",
        entry,
        reason: `already imported for supplier #${supplier.id} "${supplier.name}"`,
        supplier,
      })
      continue
    }
    if (seenThisBatch.has(batchKey)) {
      plan.push({ action: "SKIP-DUPLICATE-BATCH", entry, reason: "same supplier + invoice number appears earlier in this batch", supplier })
      continue
    }
    seenThisBatch.add(batchKey)

    // --- Source file must exist locally: never upload/hash a file that isn't there ---
    const filePath = path.isAbsolute(entry.file) ? entry.file : path.join(manifestDir, entry.file)
    if (!existsSync(filePath)) {
      plan.push({ action: "ERROR", entry, reason: `source PDF not found at ${filePath}`, supplier })
      continue
    }

    // --- Cost package resolution: never fabricated. A code that doesn't
    // match a real package for this project stays UNCLASSIFIED and is
    // reported, exactly like an explicit null. ---
    let costPackageId: number | null = null
    let costPackageWarning: string | null = null
    if (entry.costPackageCode != null) {
      const pkg = packageByCode.get(entry.costPackageCode)
      if (pkg) {
        costPackageId = pkg.id
      } else {
        costPackageWarning = `costPackageCode "${entry.costPackageCode}" does not match any cost package for project ${PROJECT_ID} — left UNCLASSIFIED, never guessed`
      }
    }

    plan.push({ action: "INSERT", entry, supplier, filePath, costPackageId, costPackageWarning })
  }

  // --- Print per-entry plan ---
  console.log("--- PLAN ---\n")
  for (const r of plan) {
    const e = r.entry
    const supplierStr = r.supplier
      ? r.supplier.kind === "existing"
        ? `existing supplier #${r.supplier.id}`
        : "NEW supplier"
      : ""
    const pkgStr =
      r.action === "INSERT"
        ? r.costPackageId != null
          ? `pkg=${e.costPackageCode}`
          : e.costPackageCode == null
            ? "pkg=(none)"
            : "pkg=UNRESOLVED"
        : ""
    console.log(
      `${r.action.padEnd(20)} [${e.index}] ${e.invoiceDate} ${e.supplierName.padEnd(30).slice(0, 30)} #${e.invoiceNumber.padEnd(16)} ` +
        `net=£${e.net.toFixed(2).padEnd(10)} gross=£${e.gross.toFixed(2).padEnd(10)} ${supplierStr} ${pkgStr}` +
        `${r.reason ? `  — ${r.reason}` : ""}${r.costPackageWarning ? `  [${r.costPackageWarning}]` : ""}`,
    )
  }

  const toInsert = plan.filter((r) => r.action === "INSERT")
  const newSuppliers = [...new Set(toInsert.filter((r) => r.supplier?.kind === "new").map((r) => r.supplier!.name))]
  console.log(`\n--- New suppliers to be created (${newSuppliers.length}) ---`)
  for (const n of newSuppliers) console.log(`  "${n}"`)

  const unresolvedPkg = toInsert.filter((r) => r.costPackageWarning)
  console.log(`\n--- costPackageCode values that did NOT resolve to a real package (${unresolvedPkg.length}) ---`)
  for (const r of unresolvedPkg) console.log(`  [${r.entry.index}] ${r.entry.invoiceNumber}: ${r.costPackageWarning}`)

  // --- Summary ---
  const counts: Record<string, number> = {}
  for (const r of plan) counts[r.action] = (counts[r.action] || 0) + 1
  const plannedNet = toInsert.reduce((s, r) => s + r.entry.net, 0)
  const plannedVat = toInsert.reduce((s, r) => s + r.entry.vat, 0)
  const plannedGross = toInsert.reduce((s, r) => s + r.entry.gross, 0)

  console.log("\n--- SUMMARY (plan) ---")
  console.log(`Manifest entries:       ${manifestEntries.length}`)
  console.log(`Rejected (schema):      ${invalid.length}`)
  console.log(`Valid entries processed:${toProcess.length}`)
  for (const [action, n] of Object.entries(counts)) console.log(`  ${action.padEnd(20)} ${n}`)
  console.log(`Planned inserts net:    £${plannedNet.toFixed(2)}`)
  console.log(`Planned inserts vat:    £${plannedVat.toFixed(2)}`)
  console.log(`Planned inserts gross:  £${plannedGross.toFixed(2)}`)
  console.log(`New suppliers:          ${newSuppliers.length}`)
  console.log(`Unresolved cost packages:${unresolvedPkg.length}`)

  if (DRY_RUN) {
    console.log("\nDry run only — nothing written anywhere (no DB writes, no Blob uploads, no network calls of any")
    console.log("kind). Source PDFs were only checked for existence on local disk (existsSync), never read.")
    console.log("Re-run with --execute to commit the INSERT rows above.")
    await pool.end()
    return
  }

  // --- Execute ---
  console.log("\n--- EXECUTING ---")
  let inserted = 0
  let dupCaught = 0
  let errored = 0
  for (const r of toInsert) {
    try {
      const result = await commitOne(r)
      if (result.status === "committed") {
        inserted++
        console.log(`INSERTED  [${r.entry.index}] ${r.entry.invoiceNumber} (${r.entry.supplierName})  -> invoice #${result.invoiceId}`)
      } else {
        dupCaught++
        console.log(`DUPLICATE (caught at commit) [${r.entry.index}] ${r.entry.invoiceNumber} (${r.entry.supplierName})`)
      }
    } catch (err) {
      errored++
      console.error(`ERROR committing [${r.entry.index}] ${r.entry.invoiceNumber} (${r.entry.supplierName}): ${(err as Error).message}`)
    }
  }
  console.log(`\nInserted: ${inserted}  Duplicates caught at commit: ${dupCaught}  Errors: ${errored}`)
  await pool.end()
}

/**
 * Upload the local PDF to Blob, then run the same sequence of writes as
 * commitInvoice's transaction (minus revalidatePath — see file header).
 * Supplier find-or-create happens INSIDE this transaction, exactly like
 * commitInvoice's own fallback, so two entries for the same new supplier
 * within one --execute run cannot race two separate supplier rows.
 */
async function commitOne(row: PlanRow): Promise<{ status: "committed"; invoiceId: number } | { status: "duplicate" }> {
  const { entry, supplier, filePath, costPackageId } = row
  if (!supplier || !filePath) {
    throw new Error("internal: incomplete plan row reached commitOne")
  }

  const bytes = readFileSync(filePath)
  const sourceFileHash = createHash("sha256").update(bytes).digest("hex")
  const safeName = path.basename(entry.file).replace(/[^a-zA-Z0-9._-]/g, "_")
  const blob = await put(`invoices/${Date.now()}-${safeName}`, bytes, {
    access: "public",
    contentType: "application/pdf",
    addRandomSuffix: true,
  })

  const notes = buildNotes(entry)

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
      ;(supplier as { kind: "new"; id: number | null; name: string }).id = supplierId
      ;(supplier as any).kind = "existing"
    }

    // App-level exact-duplicate re-check, inside the transaction.
    const nNumber = normaliseDocNumber(entry.invoiceNumber)
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
          notes, needs_review, reconciled, payment_status)
       VALUES ($1,$2,$3,$4,'invoice',$5,$6,$7,'confirmed',$8,$9,$10,$11,true,true,$12)
       RETURNING id`,
      [
        supplierId,
        PROJECT_ID,
        entry.invoiceNumber,
        entry.invoiceDate,
        String(entry.net),
        String(entry.vat),
        String(entry.gross),
        path.basename(entry.file),
        blob.url,
        sourceFileHash,
        notes,
        entry.paymentStatus,
      ],
    )
    const invoiceId = invRes.rows[0].id

    const vatRate = entry.net !== 0 ? round2((entry.vat / entry.net) * 100) : null

    await client.query(
      `INSERT INTO invoice_line_items
         (invoice_id, product_id, cost_package_id, description, raw_description,
          quantity, unit, raw_unit, normalised_unit, unit_price_ex_vat,
          line_net, line_vat, line_gross, vat_rate, is_price_tracked)
       VALUES ($1,NULL,$2,$3,$3,NULL,NULL,NULL,NULL,NULL,$4,$5,$6,$7,false)`,
      [
        invoiceId,
        costPackageId,
        entry.description,
        String(entry.net),
        String(entry.vat),
        String(entry.gross),
        vatRate == null ? null : String(vatRate),
      ],
    )

    // Classification learning — ONLY when a package was actually assigned
    // (never write a mapping for an unresolved/unclassified line).
    if (costPackageId != null) {
      const pkgRow = await client.query("SELECT code, name FROM cost_packages WHERE id = $1", [costPackageId])
      const pkg = pkgRow.rows[0]
      const productKey = normaliseDescriptionKey(entry.description)
      if (productKey && pkg) {
        await client.query(
          `INSERT INTO classification_mappings
             (key_kind, key_value, supplier_id, cost_package_code, cost_package_name, times_confirmed)
           VALUES ('product', $1, $2, $3, $4, 1)
           ON CONFLICT (key_kind, key_value, (coalesce(supplier_id, 0)))
           DO UPDATE SET
             cost_package_code = COALESCE(EXCLUDED.cost_package_code, classification_mappings.cost_package_code),
             cost_package_name = COALESCE(EXCLUDED.cost_package_name, classification_mappings.cost_package_name),
             times_confirmed = classification_mappings.times_confirmed + 1,
             updated_at = now()`,
          [productKey, supplierId, pkg.code, pkg.name],
        )
      }
    }

    // Supplier alias learning — idempotent, matches commitInvoice exactly.
    const rawSupplierName = entry.supplierName.trim()
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
