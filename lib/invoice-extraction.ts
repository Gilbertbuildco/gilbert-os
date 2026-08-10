import { createHash } from "node:crypto"
import { generateObject } from "ai"
import { z } from "zod"
import { put } from "@vercel/blob"
import { PDFDocument } from "pdf-lib"
import { extractionGovernor } from "@/lib/rate-governor"

// Vision-capable models available on the zero-config AI Gateway. We try them
// in order so a rate-limit or availability issue on one falls back to another.
const EXTRACTION_MODELS = ["google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"]

// --- Robustness tuning -------------------------------------------------------
// PDFs with at most this many pages are read in a single request (unchanged
// behaviour, preserves the extraction quality we already validated). Larger
// files are split into page windows and reconstructed.
const MAX_SINGLE_SHOT_PAGES = 8
// Page-window size and overlap for large PDFs. Overlap guarantees an invoice
// that straddles a window boundary still appears whole in one window; the
// merge step then de-duplicates it.
const CHUNK_PAGES = 4
const CHUNK_OVERLAP = 1
// Per model-call timeout so a single stuck request can't consume the whole
// serverless budget. The route's maxDuration must comfortably exceed this.
const PER_ATTEMPT_TIMEOUT_MS = 55_000
// How many backoff attempts we make per model for a TRANSIENT failure.
const MAX_TRANSIENT_ATTEMPTS = 4
// Wall-clock budget for processing one (possibly chunked) file. If a large PDF
// can't finish every page within this, we return what we read plus `incomplete`
// rather than failing the whole file.
const FILE_DEADLINE_MS = 280_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const lineItemSchema = z.object({
  description: z.string().describe("The line item description exactly as printed"),
  quantity: z.number().nullable().describe("Quantity, or null if not shown"),
  unit: z.string().nullable().describe("Unit of measure e.g. each, m, m2, box, pack"),
  unitPriceExVat: z.number().nullable().describe("Unit price excluding VAT"),
  lineNet: z.number().describe("Line total excluding VAT"),
  vatRate: z.number().nullable().describe("VAT rate as a percentage e.g. 20, 5, 0"),
})

const documentSchema = z.object({
  supplierName: z.string().describe("The name of the merchant/supplier issuing the document"),
  invoiceNumber: z.string().nullable().describe("Invoice or credit note number"),
  invoiceDate: z.string().nullable().describe("Document date in YYYY-MM-DD format"),
  transactionType: z
    .enum(["invoice", "credit"])
    .describe("'credit' if this is a credit note / refund, otherwise 'invoice'"),
  pageStart: z
    .number()
    .int()
    .nullable()
    .describe("1-based number of the FIRST page of the source file this document appears on"),
  pageEnd: z
    .number()
    .int()
    .nullable()
    .describe(
      "1-based number of the LAST page of the source file this document appears on. Equal to pageStart for a single-page document.",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .nullable()
    .describe("Your overall confidence that this document was read correctly and completely"),
  // Optional identifying references used to match the document to a project /
  // development. All nullable and best-effort — never invent them. These do not
  // affect extraction of the financial fields above.
  references: z
    .object({
      siteName: z.string().nullable().describe("Site / development / project name if shown, else null"),
      deliveryAddress: z.string().nullable().describe("Delivery / site address if shown, else null"),
      orderReference: z.string().nullable().describe("Order reference / order number if shown, else null"),
      purchaseOrder: z.string().nullable().describe("Purchase order (PO) number if shown, else null"),
      customerReference: z.string().nullable().describe("Customer reference / account reference if shown, else null"),
    })
    .nullable()
    .describe("Identifying references for project matching, or null if none are present"),
  lineItems: z.array(lineItemSchema),
  totals: z.object({
    net: z.number().describe("Total net (excluding VAT)"),
    vat: z.number().describe("Total VAT amount"),
    gross: z.number().describe("Total gross (including VAT)"),
  }),
})

// A single file may contain more than one distinct invoice or credit note
// (e.g. a scanned batch or a merchant statement). We ask the model to return
// every distinct document it finds.
const extractionSchema = z.object({
  documents: z
    .array(documentSchema)
    .describe(
      "Every distinct invoice or credit note found in the file. If the file contains only one document, return an array with one entry.",
    ),
})

export type ExtractedInvoice = z.infer<typeof documentSchema>

// Structured, machine-readable reason a file could not be read. The user-facing
// UI stays simple, but this is logged and attached so failures are diagnosable
// and so retry logic can treat transient vs permanent differently.
export type ExtractionErrorReason =
  | "rate_limit"
  | "quota_exceeded"
  | "timeout"
  | "too_large"
  | "no_document"
  | "invalid_response"
  | "gateway"
  | "empty_file"
  | "unreadable_pdf"
  | "unknown"

export type ExtractionResult =
  | {
      ok: true
      documents: ExtractedInvoice[]
      fileName: string
      sourceFilePathname: string | null
      sourceFileHash: string | null
      /** Total pages in the source PDF (null for images / unknown). */
      pageCount: number | null
      /** True when a large PDF could not be fully read within the time budget. */
      incomplete?: boolean
      /** 1-based page the read stopped at when incomplete. */
      truncatedAtPage?: number | null
    }
  | {
      ok: false
      error: string
      errorReason: ExtractionErrorReason
      fileName: string
      /** Whether a retry could plausibly succeed (rate limit, timeout, gateway). */
      retryable: boolean
      /**
       * Hint (ms) for how long the CLIENT queue should pause before retrying
       * this file, when the failure was quota/rate related. null when unknown.
       */
      retryAfterMs: number | null
      sourceFilePathname: string | null
      sourceFileHash: string | null
    }

// --- Error classification ----------------------------------------------------

export function classifyError(message: string): { reason: ExtractionErrorReason; retryable: boolean } {
  const m = message.toLowerCase()
  // Free-tier gate: a hard credit/allowance limit (Vercel AI Gateway zero-config
  // OIDC). Distinct from a transient RPM 429 — it does NOT reset within seconds
  // and returns no retry-after, so we surface it separately with an upgrade path
  // rather than retrying forever.
  if (/free tier|upgrade to paid|paid credits|insufficient.*(credit|quota|balance)|billing/.test(m))
    return { reason: "quota_exceeded", retryable: true }
  if (/rate.?limit|429|quota|too many requests|resource[_ ]exhausted/.test(m))
    return { reason: "rate_limit", retryable: true }
  if (/timeout|timed out|aborted|deadline|etimedout/.test(m)) return { reason: "timeout", retryable: true }
  if (/413|payload too large|request entity too large|context length|token|maximum.*size|too large/.test(m))
    return { reason: "too_large", retryable: false }
  if (/5\d\d|gateway|unavailable|overloaded|econnreset|network|fetch failed/.test(m))
    return { reason: "gateway", retryable: true }
  if (/schema|parse|invalid json|no object generated|could not parse|validation/.test(m))
    return { reason: "invalid_response", retryable: true }
  return { reason: "unknown", retryable: true }
}

/**
 * Extract retry-after seconds from an error message/headers if present.
 * Handles the HTTP header form ("Retry-After: 12"), and the JSON forms
 * providers use ("retry_after": 3 / "retryAfter": 3 / retryDelay: 3s).
 */
export function retryAfterMs(message: string): number | null {
  const m = message.match(/retry[-_ ]?after["':\s]+(\d+)/i) ?? message.match(/retry[-_ ]?delay["':\s]+(\d+)/i)
  if (m) return Math.min(parseInt(m[1], 10) * 1000, 65_000)
  return null
}

const INSTRUCTIONS =
  "You are a construction accounts assistant. A single uploaded file may contain one OR MORE separate " +
  "invoices or credit notes (for example a scanned batch or a supplier statement covering several documents). " +
  "Identify every distinct document and return each as its own entry in the 'documents' array. " +
  "Treat a new invoice/credit note number, a new document header, or a restarted totals block as a new document. " +
  "For each document, report the 1-based page range it occupies within the file via pageStart and pageEnd " +
  "(a single-page invoice has pageStart === pageEnd; a document spanning pages 3 to 4 has pageStart 3 and pageEnd 4). " +
  "Read every line item for each. Prices are in GBP. If VAT is charged at the standard UK rate assume 20% unless " +
  "stated otherwise. Where the document shows them, also capture identifying references (site/development name, " +
  "delivery/site address, order reference, purchase order number, customer/account reference) so the document can " +
  "be matched to the right project. Never invent line items, documents or references that are not present. If a " +
  "value is missing, use null."

/**
 * One structured extraction call against a set of PDF/image bytes, with our own
 * exponential-backoff retry loop across the model fallback list. Throws a final
 * Error (with a classifiable message) only if every attempt fails.
 */
/**
 * Error thrown when extraction ultimately fails, carrying the classified reason
 * and (for quota/rate failures) a hint for how long the caller should wait.
 */
class ExtractionError extends Error {
  constructor(
    message: string,
    readonly reason: ExtractionErrorReason,
    readonly retryable: boolean,
    readonly retryAfter: number | null,
  ) {
    super(message)
    this.name = "ExtractionError"
  }
}

async function extractBytes(bytes: Uint8Array, mediaType: string, fileName: string): Promise<ExtractedInvoice[]> {
  const messages = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Extract every invoice and credit note in this file into the required schema." },
        { type: "file" as const, data: bytes, mediaType, filename: fileName },
      ],
    },
  ]

  let lastError = "unknown error"
  let lastReason: ExtractionErrorReason = "unknown"
  let lastRetryAfter: number | null = null

  for (const model of EXTRACTION_MODELS) {
    for (let attempt = 0; attempt < MAX_TRANSIENT_ATTEMPTS; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS)
      try {
        // Governor-paced: single-flight + min spacing + honour any active pause,
        // so a chunked extraction can never burst past the quota on its own.
        const { object } = await extractionGovernor.run(() =>
          generateObject({
            model,
            schema: extractionSchema,
            instructions: INSTRUCTIONS,
            messages,
            // We own retries here so we control backoff timing precisely.
            maxRetries: 0,
            abortSignal: controller.signal,
          }),
        )
        clearTimeout(timer)
        return (object.documents ?? []).filter((d) => d && d.supplierName)
      } catch (err) {
        clearTimeout(timer)
        const message = (err as Error).message ?? String(err)
        const { reason, retryable } = classifyError(message)
        lastError = message
        lastReason = reason
        lastRetryAfter = retryAfterMs(message)
        console.log(`[v0] extraction attempt failed model=${model} attempt=${attempt} reason=${reason}: ${message}`)

        // Hard free-tier/credit gate: server-side retries won't help (it does not
        // reset within our window). Back off the governor and surface immediately
        // so the CLIENT queue can pause the whole batch and retry later.
        if (reason === "quota_exceeded") {
          extractionGovernor.penalise(lastRetryAfter ?? 30_000)
          throw new ExtractionError(message, reason, true, lastRetryAfter ?? 30_000)
        }

        if (!retryable) break // permanent for this model (e.g. too_large) — try next model or give up

        const isLast = attempt === MAX_TRANSIENT_ATTEMPTS - 1
        if (!isLast) {
          // Exponential backoff with full jitter; honour retry-after when given.
          const base = reason === "rate_limit" ? 8_000 : 1_000
          const backoff = lastRetryAfter ?? Math.min(base * 2 ** attempt, 60_000)
          const jittered = Math.round(backoff / 2 + Math.random() * (backoff / 2))
          if (reason === "rate_limit") extractionGovernor.penalise(jittered)
          console.log(`[v0] backing off ${jittered}ms before retry`)
          await sleep(jittered)
          continue
        }
      }
    }
  }

  throw new ExtractionError(lastError, lastReason, classifyError(lastError).retryable, lastRetryAfter)
}

/** Copy a page range [start,end] (1-based, inclusive) of a PDF into new bytes. */
async function slicePdf(src: PDFDocument, startPage1: number, endPage1: number): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  const indices: number[] = []
  for (let p = startPage1; p <= endPage1; p++) indices.push(p - 1)
  const copied = await out.copyPages(src, indices)
  for (const pg of copied) out.addPage(pg)
  return out.save()
}

/** De-duplicate documents merged from overlapping page windows. */
export function mergeDocuments(docs: ExtractedInvoice[]): ExtractedInvoice[] {
  const byKey = new Map<string, ExtractedInvoice>()
  for (const d of docs) {
    const key = [
      (d.supplierName ?? "").trim().toLowerCase(),
      d.transactionType,
      (d.invoiceNumber ?? "").trim().toLowerCase(),
      d.totals?.gross ?? "",
    ].join("|")
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, d)
      continue
    }
    // Keep the richer copy (more line items), and widen the page range.
    const better = (d.lineItems?.length ?? 0) > (existing.lineItems?.length ?? 0) ? d : existing
    const other = better === d ? existing : d
    better.pageStart = Math.min(better.pageStart ?? Infinity, other.pageStart ?? Infinity)
    better.pageEnd = Math.max(better.pageEnd ?? 0, other.pageEnd ?? 0)
    if (!Number.isFinite(better.pageStart!)) better.pageStart = null
    if (!better.pageEnd) better.pageEnd = null
    byKey.set(key, better)
  }
  // Stable order by page then supplier.
  return [...byKey.values()].sort((a, b) => (a.pageStart ?? 0) - (b.pageStart ?? 0))
}

/**
 * Read an uploaded PDF/image, retain the original in Blob storage, and extract
 * one or more structured documents with a vision model. Nothing is written to
 * the database here — the caller reviews and confirms before committing.
 *
 * Robustness: transient failures (rate limits, gateway errors, timeouts) are
 * retried with exponential backoff; large PDFs are split into page windows and
 * reconstructed so a single oversized request can't fail or time out.
 */
export async function extractDocumentsFromFile(file: File): Promise<ExtractionResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const isPdf = (file.type || "").includes("pdf") || file.name.toLowerCase().endsWith(".pdf")
  const mediaType = file.type || (isPdf ? "application/pdf" : "image/jpeg")

  // Checksum of the exact bytes uploaded — a secondary duplicate signal.
  const sourceFileHash = createHash("sha256").update(Buffer.from(bytes)).digest("hex")

  // Retain the original document in Blob storage before extraction so the
  // source is always kept, even if the review is abandoned or extraction fails.
  let sourceFilePathname: string | null = null
  try {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
    const blob = await put(`invoices/${Date.now()}-${safeName}`, Buffer.from(bytes), {
      access: "public",
      contentType: mediaType,
      addRandomSuffix: true,
    })
    sourceFilePathname = blob.url
  } catch (err) {
    console.log("[v0] failed to retain original invoice file:", (err as Error).message)
  }

  if (bytes.byteLength === 0) {
    return {
      ok: false,
      error: "That file was empty. You can enter the details manually below.",
      errorReason: "empty_file",
      retryable: false,
      retryAfterMs: null,
      fileName: file.name,
      sourceFilePathname,
      sourceFileHash,
    }
  }

  // Determine whether we can/should chunk a large PDF.
  let pageCount: number | null = null
  let pdfDoc: PDFDocument | null = null
  if (isPdf) {
    try {
      pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true })
      pageCount = pdfDoc.getPageCount()
    } catch (err) {
      // Corrupt/encrypted PDF we can't split — fall back to a single-shot read
      // of the raw bytes (never worse than before).
      console.log("[v0] pdf-lib could not parse PDF, falling back to single-shot:", (err as Error).message)
      pdfDoc = null
    }
  }

  const finalize = (docs: ExtractedInvoice[], extra?: { incomplete?: boolean; truncatedAtPage?: number | null }) => {
    if (docs.length === 0) {
      return {
        ok: false as const,
        error: "No invoice could be read from that file. You can still enter the details manually below.",
        errorReason: "no_document" as const,
        retryable: false,
        retryAfterMs: null,
        fileName: file.name,
        sourceFilePathname,
        sourceFileHash,
      }
    }
    return {
      ok: true as const,
      documents: docs,
      fileName: file.name,
      sourceFilePathname,
      sourceFileHash,
      pageCount,
      ...extra,
    }
  }

  try {
    // Small files (or non-PDF, or unparseable PDF): single-shot, unchanged path.
    if (!pdfDoc || pageCount == null || pageCount <= MAX_SINGLE_SHOT_PAGES) {
      const docs = await extractBytes(bytes, mediaType, file.name)
      return finalize(docs)
    }

    // Large PDF: process overlapping page windows within a wall-clock budget,
    // offsetting page numbers into the ORIGINAL file's coordinate space.
    console.log(`[v0] large PDF (${pageCount} pages) — chunking into windows of ${CHUNK_PAGES}`)
    const started = Date.now()
    const step = Math.max(1, CHUNK_PAGES - CHUNK_OVERLAP)
    const all: ExtractedInvoice[] = []
    let truncatedAtPage: number | null = null

    for (let start = 1; start <= pageCount; start += step) {
      if (Date.now() - started > FILE_DEADLINE_MS) {
        truncatedAtPage = start
        console.log(`[v0] file deadline reached; stopping at page ${start} of ${pageCount}`)
        break
      }
      const end = Math.min(start + CHUNK_PAGES - 1, pageCount)
      let chunkBytes: Uint8Array
      try {
        chunkBytes = await slicePdf(pdfDoc, start, end)
      } catch (err) {
        console.log(`[v0] failed to slice pages ${start}-${end}:`, (err as Error).message)
        continue
      }
      try {
        const chunkDocs = await extractBytes(chunkBytes, "application/pdf", `${file.name}#p${start}-${end}`)
        // Offset page numbers from chunk-local (1..CHUNK_PAGES) to absolute.
        for (const d of chunkDocs) {
          if (d.pageStart != null) d.pageStart = d.pageStart + (start - 1)
          if (d.pageEnd != null) d.pageEnd = d.pageEnd + (start - 1)
          // Clamp defensively into the real range.
          if (d.pageStart != null) d.pageStart = Math.min(Math.max(d.pageStart, start), pageCount)
          if (d.pageEnd != null) d.pageEnd = Math.min(Math.max(d.pageEnd, start), pageCount)
        }
        all.push(...chunkDocs)
      } catch (err) {
        const reason = err instanceof ExtractionError ? err.reason : classifyError((err as Error).message).reason
        // A quota/rate failure will affect EVERY remaining window too — burning
        // through them just wastes the allowance. Abort the whole file and let
        // the client queue pause and re-read it later (it is retryable).
        if (reason === "quota_exceeded" || reason === "rate_limit") {
          console.log(`[v0] window ${start}-${end} hit ${reason}; aborting file for client re-queue`)
          throw err
        }
        // Any other per-window failure must not fail the file — skip that window.
        console.log(`[v0] window ${start}-${end} failed (reason=${reason}); continuing`)
      }
      if (end >= pageCount) break
    }

    const merged = mergeDocuments(all)
    return finalize(merged, truncatedAtPage ? { incomplete: true, truncatedAtPage } : undefined)
  } catch (err) {
    const message = (err as Error).message ?? String(err)
    const reason = err instanceof ExtractionError ? err.reason : classifyError(message).reason
    const retryable = err instanceof ExtractionError ? err.retryable : classifyError(message).retryable
    const retryAfter = err instanceof ExtractionError ? err.retryAfter : retryAfterMs(message)
    console.log(`[v0] invoice extraction gave up fileName="${file.name}" reason=${reason}: ${message}`)
    const userError =
      reason === "quota_exceeded"
        ? "Automatic reading has hit the AI free-tier limit. The queue will keep retrying automatically; add AI Gateway credits for reliable bulk reading, or enter the details manually below."
        : reason === "rate_limit"
          ? "Automatic reading is temporarily rate-limited. It will retry automatically, or you can enter the details manually below."
          : reason === "timeout"
            ? "Reading this document took too long. You can retry it, or enter the details manually below."
            : reason === "too_large"
              ? "This document was too large to read in one pass. You can retry it, or enter the details manually below."
              : "Could not read that document automatically. You can retry it, or enter the details manually below."
    return {
      ok: false,
      error: userError,
      errorReason: reason,
      retryable,
      retryAfterMs: retryAfter,
      fileName: file.name,
      sourceFilePathname,
      sourceFileHash,
    }
  }
}
