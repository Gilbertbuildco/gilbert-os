/**
 * Attach the recovered-from-email invoice PDFs to their matching Xero SPEND
 * bank transaction, for every manifest entry that carries a `xeroBankTxId`.
 * This script is the Xero-side counterpart to
 * scripts/ingest-emailed-invoices-2026-08.mts — it does NOT touch Gilbert
 * OS's own database at all, only the local manifest/PDFs and the Xero API.
 *
 * MANIFEST SHAPE / VALIDATION — identical to
 * scripts/ingest-emailed-invoices-2026-08.mts (read that file's header
 * first). The two scripts reproduce the same validation logic independently
 * rather than sharing a module, matching every other pair of scripts in this
 * folder (e.g. ingest-xero-bills-2026-08.mts vs ingest-text-layer.mjs both
 * reproduce lib/invoice-identity.ts rather than import it).
 *
 * WHAT THIS SCRIPT DOES, per valid entry with a non-null xeroBankTxId:
 *   1. GET /api.xro/2.0/BankTransactions/{id} — confirms the transaction
 *      exists and reports its Contact + Total, so a wrong/stale
 *      xeroBankTxId is visible before anything is attempted. The manifest's
 *      gross is compared to the bank transaction's Total and a mismatch is
 *      REPORTED, never blocked — Gilbert Build Co has genuine partial
 *      payments, so gross != Total is not necessarily wrong.
 *   2. GET /api.xro/2.0/BankTransactions/{id}/Attachments — if an attachment
 *      with the SAME FILENAME (the manifest entry's own file, basename-
 *      compared case-insensitively) already exists, the entry is SKIPPED and
 *      reported rather than attaching a second copy.
 *   3. Only under --execute, and only if steps 1–2 found nothing blocking:
 *      PUT /api.xro/2.0/BankTransactions/{id}/Attachments/{urlencoded
 *      filename} with the raw PDF bytes and Content-Type application/pdf.
 *      This is the ONLY write this script ever issues, and the ONLY call in
 *      this whole codebase that asks `lib/xero/client.ts`'s `xeroFetch` (not
 *      `xeroGet`) for a non-GET method — which `assertMethodAllowed` refuses
 *      unless `XERO_WRITE_ENABLED === "true"` is set in the environment.
 *
 * Entries whose xeroBankTxId is null are reported and skipped — there is
 * nothing to attach them to (nothing invented).
 *
 * SAFETY
 *   --dry-run is the default (no --execute needed to preview). In dry-run
 *   mode the ONLY network calls are the two Xero GETs above, run for every
 *   candidate so mismatches/existing-attachments are visible before a real
 *   run — no PUT is ever issued outside --execute, and no PDF bytes are read
 *   from disk in dry-run (only existsSync, to report whether --execute would
 *   have a file to send). --execute performs the PUT (still no DB writes;
 *   this script has no Postgres dependency at all).
 *
 * USAGE
 *   npx tsx --env-file=.env.local --env-file=.env.development.local \
 *     scripts/attach-invoices-to-xero-2026-08.mts [options]
 *
 *   --manifest=<path>  Path to _manifest.json (default: the folder above)
 *   --limit=<n>         Only process the first n valid, bank-tx-linked entries
 *   --execute           Actually PUT the attachment (omit for dry run)
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { xeroGet, xeroFetch } from "../lib/xero/client.ts"

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

// ---------------------------------------------------------------------------
// Manifest validation — reproduced verbatim from
// scripts/ingest-emailed-invoices-2026-08.mts (see that file's header for
// why these are duplicated rather than shared).
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

function toPence(n: number): number {
  return Math.round(n * 100)
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return false
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

// ---------------------------------------------------------------------------
// Xero shapes (subset actually used)
// ---------------------------------------------------------------------------

type XeroBankTransaction = {
  BankTransactionID: string
  Type: string
  Status: string
  Contact?: { Name?: string }
  Total: number
  Date?: string
}

type XeroAttachment = {
  FileName: string
  Url: string
  MimeType: string
  ContentLength: number
}

type PlanRow = {
  action: "WOULD-ATTACH" | "ALREADY-ATTACHED" | "NO-BANK-TX-ID" | "BANK-TX-NOT-FOUND" | "LOCAL-FILE-MISSING" | "ERROR"
  entry: ValidatedEntry
  reason?: string
  bankTx?: XeroBankTransaction
  grossMismatch?: boolean
  filePath?: string
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (Xero GETs only — no attachment is uploaded)" : "EXECUTE (will PUT attachments)"}`)
  console.log(`Manifest: ${MANIFEST_PATH}`)
  if (LIMIT != null) console.log(`Limit: first ${LIMIT} valid, bank-tx-linked entries`)
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

  const withoutBankTx = validated.filter((e) => e.xeroBankTxId == null)
  if (withoutBankTx.length) {
    console.log(`--- Entries with no xeroBankTxId — nothing to attach (${withoutBankTx.length}) ---`)
    for (const e of withoutBankTx) console.log(`  [${e.index}] ${e.invoiceNumber} (${e.supplierName})`)
    console.log("")
  }

  const linked = validated.filter((e) => e.xeroBankTxId != null)
  const toProcess = LIMIT != null ? linked.slice(0, LIMIT) : linked
  console.log(`Entries with a xeroBankTxId to process: ${toProcess.length}${LIMIT != null ? ` (of ${linked.length}, limited)` : ""}\n`)

  const plan: PlanRow[] = []

  for (const entry of toProcess) {
    const bankTxId = entry.xeroBankTxId as string
    const filePath = path.isAbsolute(entry.file) ? entry.file : path.join(manifestDir, entry.file)
    const localFileExists = existsSync(filePath)

    // --- 1. Confirm the bank transaction exists; report Contact + Total ---
    let bankTx: XeroBankTransaction | undefined
    try {
      const res = await xeroGet(`/api.xro/2.0/BankTransactions/${bankTxId}`, { headers: { Accept: "application/json" } })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        plan.push({ action: "BANK-TX-NOT-FOUND", entry, reason: `GET failed: HTTP ${res.status} ${text.slice(0, 200)}` })
        continue
      }
      const body = (await res.json()) as { BankTransactions?: XeroBankTransaction[] }
      bankTx = body.BankTransactions?.[0]
      if (!bankTx) {
        plan.push({ action: "BANK-TX-NOT-FOUND", entry, reason: "response had no BankTransactions[0]" })
        continue
      }
    } catch (err) {
      plan.push({ action: "ERROR", entry, reason: `bank transaction fetch exception: ${(err as Error).message}` })
      continue
    }

    const grossMismatch = Math.abs(entry.gross - Number(bankTx.Total)) > 0.005

    // --- 2. Check existing attachments for the same filename ---
    const wantFileName = path.basename(entry.file)
    let attachments: XeroAttachment[] = []
    try {
      const res = await xeroGet(`/api.xro/2.0/BankTransactions/${bankTxId}/Attachments`, { headers: { Accept: "application/json" } })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        plan.push({ action: "ERROR", entry, reason: `attachment listing failed: HTTP ${res.status} ${text.slice(0, 200)}`, bankTx, grossMismatch })
        continue
      }
      const body = (await res.json()) as { Attachments?: XeroAttachment[] }
      attachments = body.Attachments ?? []
    } catch (err) {
      plan.push({ action: "ERROR", entry, reason: `attachment listing exception: ${(err as Error).message}`, bankTx, grossMismatch })
      continue
    }

    const already = attachments.find((a) => a.FileName.toLowerCase() === wantFileName.toLowerCase())
    if (already) {
      plan.push({ action: "ALREADY-ATTACHED", entry, reason: `"${already.FileName}" already on this bank transaction`, bankTx, grossMismatch })
      continue
    }

    if (!localFileExists) {
      plan.push({ action: "LOCAL-FILE-MISSING", entry, reason: `source PDF not found at ${filePath}`, bankTx, grossMismatch })
      continue
    }

    plan.push({ action: "WOULD-ATTACH", entry, bankTx, grossMismatch, filePath })
  }

  // --- Print per-entry plan ---
  console.log("--- PLAN ---\n")
  for (const r of plan) {
    const e = r.entry
    const contact = r.bankTx?.Contact?.Name ?? "(unknown)"
    const total = r.bankTx ? `£${Number(r.bankTx.Total).toFixed(2)}` : "(n/a)"
    const mismatchStr = r.grossMismatch ? `  MISMATCH manifest gross=£${e.gross.toFixed(2)} vs bank tx Total=${total}` : ""
    console.log(
      `${r.action.padEnd(18)} [${e.index}] ${e.invoiceNumber.padEnd(16)} bankTx=${(e.xeroBankTxId ?? "-").padEnd(38)} ` +
        `contact="${contact}" total=${total}${mismatchStr}${r.reason ? `  — ${r.reason}` : ""}`,
    )
  }

  const mismatches = plan.filter((r) => r.grossMismatch)
  console.log(`\n--- Manifest gross vs bank transaction Total mismatches (${mismatches.length}, reported not blocked — partial payments exist) ---`)
  for (const r of mismatches) {
    console.log(`  [${r.entry.index}] ${r.entry.invoiceNumber}: manifest £${r.entry.gross.toFixed(2)} vs Xero £${Number(r.bankTx!.Total).toFixed(2)}`)
  }

  const counts: Record<string, number> = {}
  for (const r of plan) counts[r.action] = (counts[r.action] || 0) + 1
  console.log("\n--- SUMMARY (plan) ---")
  console.log(`Manifest entries:            ${manifestEntries.length}`)
  console.log(`Rejected (schema):           ${invalid.length}`)
  console.log(`No xeroBankTxId (skipped):   ${withoutBankTx.length}`)
  console.log(`Processed (bank-tx-linked):  ${toProcess.length}`)
  for (const [action, n] of Object.entries(counts)) console.log(`  ${action.padEnd(20)} ${n}`)
  console.log(`Gross/Total mismatches:      ${mismatches.length}`)

  if (DRY_RUN) {
    console.log("\nDry run only — the only network calls made were Xero GETs (BankTransaction lookup + attachment")
    console.log("listing) for each candidate. No PUT was issued — xeroFetch's write gate additionally requires")
    console.log("XERO_WRITE_ENABLED=\"true\" for any non-GET call, but this script never reaches that call path")
    console.log("without --execute regardless of the gate's state.")
    console.log("Re-run with --execute to PUT the WOULD-ATTACH rows above.")
    return
  }

  // --- Execute: PUT each WOULD-ATTACH row ---
  console.log("\n--- EXECUTING ---")
  const toAttach = plan.filter((r) => r.action === "WOULD-ATTACH")
  let attached = 0
  let errored = 0
  for (const r of toAttach) {
    try {
      const bytes = readFileSync(r.filePath as string)
      const fileName = path.basename(r.entry.file)
      const res = await xeroFetch(`/api.xro/2.0/BankTransactions/${r.entry.xeroBankTxId}/Attachments/${encodeURIComponent(fileName)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf", Accept: "application/json" },
        body: bytes,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`PUT failed: HTTP ${res.status} ${text.slice(0, 300)}`)
      }
      attached++
      console.log(`ATTACHED  [${r.entry.index}] ${fileName} -> bank tx ${r.entry.xeroBankTxId}`)
    } catch (err) {
      errored++
      console.error(`ERROR attaching [${r.entry.index}] ${r.entry.invoiceNumber}: ${(err as Error).message}`)
    }
  }
  console.log(`\nAttached: ${attached}  Errors: ${errored}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
