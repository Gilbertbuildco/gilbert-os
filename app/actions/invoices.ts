"use server"

import { db } from "@/lib/db"
import {
  suppliers,
  products,
  invoices,
  invoiceLineItems,
  priceRecords,
} from "@/lib/db/schema"
import { and, eq, ilike } from "drizzle-orm"
import { generateObject } from "ai"
import { z } from "zod"
import { revalidatePath } from "next/cache"

const EXTRACTION_MODEL = "google/gemini-3.5-flash"

const lineItemSchema = z.object({
  description: z.string().describe("The line item description exactly as printed"),
  quantity: z.number().nullable().describe("Quantity, or null if not shown"),
  unit: z.string().nullable().describe("Unit of measure e.g. each, m, m2, box, pack"),
  unitPriceExVat: z.number().nullable().describe("Unit price excluding VAT"),
  lineNet: z.number().describe("Line total excluding VAT"),
  vatRate: z.number().nullable().describe("VAT rate as a percentage e.g. 20, 5, 0"),
})

const extractionSchema = z.object({
  supplierName: z.string().describe("The name of the merchant/supplier issuing the document"),
  invoiceNumber: z.string().nullable().describe("Invoice or credit note number"),
  invoiceDate: z
    .string()
    .nullable()
    .describe("Document date in YYYY-MM-DD format"),
  transactionType: z
    .enum(["invoice", "credit"])
    .describe("'credit' if this is a credit note / refund, otherwise 'invoice'"),
  lineItems: z.array(lineItemSchema),
  totals: z.object({
    net: z.number().describe("Total net (excluding VAT)"),
    vat: z.number().describe("Total VAT amount"),
    gross: z.number().describe("Total gross (including VAT)"),
  }),
})

export type ExtractedInvoice = z.infer<typeof extractionSchema>

export type ExtractionResult =
  | { ok: true; data: ExtractedInvoice; fileName: string }
  | { ok: false; error: string }

/**
 * Step 1 of ingestion: read the uploaded PDF/image and extract structured data
 * with a vision model. Nothing is written to the database here — the user
 * reviews and confirms before anything is committed.
 */
export async function extractInvoice(formData: FormData): Promise<ExtractionResult> {
  const file = formData.get("file")
  if (!(file instanceof File)) {
    return { ok: false, error: "No file was provided." }
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const mediaType = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg")

  try {
    const { object } = await generateObject({
      model: EXTRACTION_MODEL,
      schema: extractionSchema,
      messages: [
        {
          role: "system",
          content:
            "You are a construction accounts assistant. Extract supplier invoices and credit notes into structured data. " +
            "Read every line item. Prices are in GBP. If VAT is charged at the standard UK rate assume 20% unless stated otherwise. " +
            "Never invent line items that are not on the document. If a value is missing, use null.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract this supplier document into the required schema.",
            },
            { type: "file", data: bytes, mediaType, filename: file.name },
          ],
        },
      ],
    })

    return { ok: true, data: object, fileName: file.name }
  } catch (err) {
    console.log("[v0] invoice extraction failed:", (err as Error).message)
    return {
      ok: false,
      error:
        "Could not read that document automatically. You can still enter the details manually below.",
    }
  }
}

export type CommitLineItem = {
  description: string
  quantity: number | null
  unit: string | null
  unitPriceExVat: number | null
  lineNet: number
  vatRate: number | null
  costPackageId: number | null
  productId: number | null
  /** when true and productId is null, create a new tracked product from the description */
  trackAsProduct: boolean
  newProductName?: string | null
  newProductCategory?: string | null
}

export type CommitInvoiceInput = {
  supplierId: number | null
  newSupplierName: string | null
  projectId: number | null
  invoiceNumber: string | null
  invoiceDate: string | null
  transactionType: "invoice" | "credit"
  net: number
  vat: number
  gross: number
  sourceFileName: string | null
  notes: string | null
  lineItems: CommitLineItem[]
}

/**
 * Step 2 of ingestion: persist the reviewed invoice, its line items, and derive
 * price records so the procurement price history stays in sync automatically.
 */
export async function commitInvoice(input: CommitInvoiceInput) {
  // Resolve supplier (find-or-create)
  let supplierId = input.supplierId
  if (!supplierId) {
    const name = (input.newSupplierName ?? "").trim()
    if (!name) throw new Error("A supplier is required.")
    const existing = await db
      .select()
      .from(suppliers)
      .where(ilike(suppliers.name, name))
      .limit(1)
    if (existing[0]) {
      supplierId = existing[0].id
    } else {
      const [created] = await db.insert(suppliers).values({ name }).returning()
      supplierId = created.id
    }
  }

  const sign = input.transactionType === "credit" ? -1 : 1

  const [invoice] = await db
    .insert(invoices)
    .values({
      supplierId,
      projectId: input.projectId,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate || null,
      transactionType: input.transactionType,
      net: String(sign * Math.abs(input.net)),
      vat: String(sign * Math.abs(input.vat)),
      gross: String(sign * Math.abs(input.gross)),
      status: "confirmed",
      sourceFileName: input.sourceFileName,
      notes: input.notes,
    })
    .returning()

  for (const li of input.lineItems) {
    // Resolve product for this line (optional)
    let productId = li.productId
    if (!productId && li.trackAsProduct) {
      const pname = (li.newProductName || li.description).trim()
      if (pname) {
        const existing = await db
          .select()
          .from(products)
          .where(ilike(products.name, pname))
          .limit(1)
        if (existing[0]) {
          productId = existing[0].id
        } else {
          const [created] = await db
            .insert(products)
            .values({
              name: pname,
              description: li.description,
              category: li.newProductCategory ?? null,
              unit: li.unit ?? null,
            })
            .returning()
          productId = created.id
        }
      }
    }

    const vatRate = li.vatRate ?? 20
    const lineNet = sign * Math.abs(li.lineNet)
    const lineVat = Math.round(lineNet * (vatRate / 100) * 100) / 100
    const lineGross = lineNet + lineVat

    const [lineItem] = await db
      .insert(invoiceLineItems)
      .values({
        invoiceId: invoice.id,
        productId: productId ?? null,
        costPackageId: li.costPackageId,
        description: li.description,
        quantity: li.quantity == null ? null : String(li.quantity),
        unit: li.unit,
        unitPriceExVat: li.unitPriceExVat == null ? null : String(li.unitPriceExVat),
        lineNet: String(lineNet),
        lineVat: String(lineVat),
        lineGross: String(lineGross),
        vatRate: String(vatRate),
      })
      .returning()

    // Derive a price record when we have a tracked product and a unit price
    if (productId && li.unitPriceExVat != null && input.transactionType === "invoice") {
      const priceEx = Math.abs(li.unitPriceExVat)
      const vatAmount = Math.round(priceEx * (vatRate / 100) * 100) / 100
      await db.insert(priceRecords).values({
        productId,
        supplierId,
        projectId: input.projectId,
        invoiceId: invoice.id,
        invoiceLineItemId: lineItem.id,
        priceExVat: String(priceEx),
        vatAmount: String(vatAmount),
        priceIncVat: String(priceEx + vatAmount),
        vatRate: String(vatRate),
        unit: li.unit,
        invoiceDate: input.invoiceDate || null,
        invoiceNumber: input.invoiceNumber,
        transactionType: input.transactionType,
      })
    }
  }

  revalidatePath("/")
  revalidatePath("/invoices")
  revalidatePath("/procurement")
  revalidatePath("/suppliers")
  revalidatePath("/commercial")
  revalidatePath("/projects")

  return { invoiceId: invoice.id }
}

export async function deleteInvoice(id: number) {
  await db.delete(priceRecords).where(eq(priceRecords.invoiceId, id))
  await db.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, id))
  await db.delete(invoices).where(eq(invoices.id, id))
  revalidatePath("/invoices")
  revalidatePath("/procurement")
  revalidatePath("/suppliers")
  revalidatePath("/")
}

/** Lightweight lookups used by the review form */
export async function searchSuppliers(query: string) {
  const q = query.trim()
  const rows = q
    ? await db.select().from(suppliers).where(ilike(suppliers.name, `%${q}%`)).limit(10)
    : await db.select().from(suppliers).limit(10)
  return rows.map((s) => ({ id: s.id, name: s.name }))
}

export async function searchProducts(query: string) {
  const q = query.trim()
  const rows = q
    ? await db.select().from(products).where(ilike(products.name, `%${q}%`)).limit(10)
    : await db.select().from(products).limit(10)
  return rows.map((p) => ({ id: p.id, name: p.name, unit: p.unit }))
}
