import { createHash } from "node:crypto"
import { generateObject } from "ai"
import { z } from "zod"
import { put } from "@vercel/blob"

// Vision-capable models available on the zero-config AI Gateway. We try them
// in order so a rate-limit or availability issue on one falls back to another.
const EXTRACTION_MODELS = ["google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"]

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

export type ExtractionResult =
  | {
      ok: true
      documents: ExtractedInvoice[]
      fileName: string
      sourceFilePathname: string | null
      sourceFileHash: string | null
    }
  | { ok: false; error: string; fileName: string }

/**
 * Read an uploaded PDF/image, retain the original in Blob storage, and extract
 * one or more structured documents with a vision model. Nothing is written to
 * the database here — the caller reviews and confirms before committing.
 */
export async function extractDocumentsFromFile(file: File): Promise<ExtractionResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mediaType = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg")

  // Checksum of the exact bytes uploaded — a secondary duplicate signal.
  const sourceFileHash = createHash("sha256").update(Buffer.from(bytes)).digest("hex")

  // Retain the original document in Blob storage before extraction so the
  // source is always kept, even if the review is abandoned partway.
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

  const instructions =
    "You are a construction accounts assistant. A single uploaded file may contain one OR MORE separate " +
    "invoices or credit notes (for example a scanned batch or a supplier statement covering several documents). " +
    "Identify every distinct document and return each as its own entry in the 'documents' array. " +
    "Treat a new invoice/credit note number, a new document header, or a restarted totals block as a new document. " +
    "For each document, report the 1-based page range it occupies within the file via pageStart and pageEnd " +
    "(a single-page invoice has pageStart === pageEnd; a document spanning pages 3 to 4 has pageStart 3 and pageEnd 4). " +
    "Read every line item for each. Prices are in GBP. If VAT is charged at the standard UK rate assume 20% unless " +
    "stated otherwise. Never invent line items or documents that are not present. If a value is missing, use null."

  const messages = [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: "Extract every invoice and credit note in this file into the required schema.",
        },
        { type: "file" as const, data: bytes, mediaType, filename: file.name },
      ],
    },
  ]

  let rateLimited = false
  let lastError = ""

  for (const model of EXTRACTION_MODELS) {
    // Up to two attempts per model to absorb transient free-tier rate limits.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { object } = await generateObject({ model, schema: extractionSchema, instructions, messages })
        const documents = (object.documents ?? []).filter((d) => d && d.supplierName)
        if (documents.length === 0) {
          return {
            ok: false,
            error: "No invoice could be read from that file. You can still enter the details manually below.",
            fileName: file.name,
          }
        }
        return { ok: true, documents, fileName: file.name, sourceFilePathname, sourceFileHash }
      } catch (err) {
        const message = (err as Error).message ?? ""
        lastError = message
        const isRateLimit = /rate.?limit|429/i.test(message)
        console.log(`[v0] extraction attempt failed (${model}):`, message)
        if (isRateLimit) {
          rateLimited = true
          if (attempt === 0) {
            await sleep(1500)
            continue
          }
        }
        break // non-rate-limit error, or already retried — move to next model
      }
    }
  }

  console.log("[v0] invoice extraction gave up:", lastError)
  return {
    ok: false,
    error: rateLimited
      ? "Automatic reading is temporarily rate-limited. Please wait a moment and try again, or enter the details manually below."
      : "Could not read that document automatically. You can still enter the details manually below.",
    fileName: file.name,
  }
}
