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
import { revalidatePath } from "next/cache"

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
  sourceFilePathname: string | null
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
      sourceFilePathname: input.sourceFilePathname,
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
