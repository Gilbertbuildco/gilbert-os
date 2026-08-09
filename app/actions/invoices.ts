"use server"

import { db } from "@/lib/db"
import {
  suppliers,
  products,
  invoices,
  invoiceLineItems,
  priceRecords,
  supplierAliases,
  classificationMappings,
} from "@/lib/db/schema"
import { and, eq, ilike, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { normaliseSupplierName, normaliseDocNumber } from "@/lib/invoice-identity"
import { normaliseDescriptionKey } from "@/lib/normalisation/products"
import {
  classifyAgainst,
  type DocFingerprint,
  type DuplicateVerdict,
  type ExistingInvoiceRef,
} from "@/lib/duplicate-detection"

export type CommitLineItem = {
  description: string
  quantity: number | null
  unit: string | null
  /** canonical Gilbert OS unit; never alters quantity/price */
  normalisedUnit?: string | null
  unitPriceExVat: number | null
  lineNet: number
  vatRate: number | null
  costPackageId: number | null
  /** learned mapping context: package code/name so learning reapplies across projects */
  costPackageCode?: string | null
  costPackageName?: string | null
  productId: number | null
  /** when true and productId is null, create a new tracked product from the description */
  trackAsProduct: boolean
  /** whether to add this line to the procurement price database */
  isPriceTracked?: boolean
  newProductName?: string | null
  newProductCategory?: string | null
  /** structured normalisation captured for a newly-created product */
  normalisedProduct?: {
    normalisedName?: string | null
    productFamily?: string | null
    productType?: string | null
    dimensions?: string | null
    thickness?: string | null
    subcategory?: string | null
  } | null
}

export type CommitInvoiceInput = {
  supplierId: number | null
  newSupplierName: string | null
  /** the raw supplier heading as printed on the document, for alias learning */
  rawSupplierHeading?: string | null
  projectId: number | null
  invoiceNumber: string | null
  invoiceDate: string | null
  transactionType: "invoice" | "credit"
  net: number
  vat: number
  gross: number
  sourceFileName: string | null
  sourceFilePathname: string | null
  sourceFileHash: string | null
  sourcePageStart: number | null
  sourcePageEnd: number | null
  notes: string | null
  /** original AI extraction retained for audit (what the model first read) */
  extractionRaw?: unknown
  /** model self-reported extraction confidence */
  confidence?: "high" | "medium" | "low" | null
  /** whether totals/line arithmetic reconciled at review time */
  reconciled?: boolean
  /** whether this document was committed while still needing attention */
  needsReview?: boolean
  lineItems: CommitLineItem[]
}

export type CommitResult =
  | { status: "committed"; invoiceId: number }
  | { status: "duplicate"; existing: ExistingInvoiceRef | null }

// Column list + joins shared by every "existing invoice" lookup so the shape
// always matches ExistingInvoiceRef.
const EXISTING_REF_SELECT = sql`
  SELECT inv.id, s.name AS supplier_name, p.name AS project_name,
    inv.invoice_number, inv.invoice_date, inv.transaction_type,
    inv.net, inv.vat, inv.gross, inv.source_file_pathname,
    inv.source_page_start, inv.source_page_end, inv.source_file_hash,
    inv.created_at
  FROM invoices inv
  JOIN suppliers s ON s.id = inv.supplier_id
  LEFT JOIN projects p ON p.id = inv.project_id
`

function rowToExistingRef(r: any): ExistingInvoiceRef {
  return {
    id: Number(r.id),
    supplierName: r.supplier_name,
    invoiceNumber: r.invoice_number ?? null,
    invoiceDate: r.invoice_date ? String(r.invoice_date) : null,
    transactionType: r.transaction_type,
    net: Number(r.net),
    vat: Number(r.vat),
    gross: Number(r.gross),
    projectName: r.project_name ?? null,
    importedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    sourceFilePathname: r.source_file_pathname ?? null,
    sourcePageStart: r.source_page_start == null ? null : Number(r.source_page_start),
    sourcePageEnd: r.source_page_end == null ? null : Number(r.source_page_end),
    sourceFileHash: r.source_file_hash ?? null,
  }
}

/**
 * Classify a batch of extracted documents against everything already committed
 * so the review UI can label each one NEW / POSSIBLE DUPLICATE / ALREADY
 * IMPORTED. Also flags exact repeats appearing twice within the same upload.
 */
export async function classifyDocuments(fingerprints: DocFingerprint[]): Promise<DuplicateVerdict[]> {
  const rows = await db.execute(EXISTING_REF_SELECT)
  const existing = (rows.rows as any[]).map(rowToExistingRef)

  const verdicts: DuplicateVerdict[] = []
  for (let i = 0; i < fingerprints.length; i++) {
    const fp = fingerprints[i]
    let verdict = classifyAgainst(fp, existing)

    // Intra-batch guard: an identical document earlier in THIS upload isn't in
    // the database yet, but committing both would be a duplicate — surface it.
    if (verdict.status === "new") {
      const nSupplier = normaliseSupplierName(fp.supplierName)
      const nNumber = normaliseDocNumber(fp.invoiceNumber)
      if (nNumber) {
        const earlier = fingerprints.slice(0, i).some(
          (prev) =>
            prev.transactionType === fp.transactionType &&
            normaliseDocNumber(prev.invoiceNumber) === nNumber &&
            normaliseSupplierName(prev.supplierName) === nSupplier,
        )
        if (earlier) {
          verdict = {
            status: "possible_duplicate",
            existing: null,
            reason: "The same document appears earlier in this upload.",
          }
        }
      }
    }
    verdicts.push(verdict)
  }
  return verdicts
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505"
}

/**
 * Step 2 of ingestion: persist the reviewed invoice, its line items, and derive
 * price records so procurement price history stays in sync automatically.
 *
 * Idempotent by design: the whole write runs in a single transaction and is
 * guarded both by an application-level duplicate re-check and by a database
 * unique index on (supplier, type, normalised number). If the document already
 * exists, NOTHING is written — no invoice, no line items, no price records —
 * so a re-import can never double-count spend or VAT.
 */
export async function commitInvoice(input: CommitInvoiceInput): Promise<CommitResult> {
  const sign = input.transactionType === "credit" ? -1 : 1
  const nNumber = normaliseDocNumber(input.invoiceNumber)

  try {
    const result = await db.transaction(async (tx): Promise<CommitResult> => {
      // Resolve supplier (find-or-create)
      let supplierId = input.supplierId
      if (!supplierId) {
        const name = (input.newSupplierName ?? "").trim()
        if (!name) throw new Error("A supplier is required.")
        const existing = await tx.select().from(suppliers).where(ilike(suppliers.name, name)).limit(1)
        if (existing[0]) {
          supplierId = existing[0].id
        } else {
          const [created] = await tx.insert(suppliers).values({ name }).returning()
          supplierId = created.id
        }
      }

      // Application-level exact-duplicate re-check (server side, authoritative).
      if (nNumber) {
        const candidates = await tx.execute(sql`
          ${EXISTING_REF_SELECT}
          WHERE inv.supplier_id = ${supplierId} AND inv.transaction_type = ${input.transactionType}
        `)
        const dupeRow = (candidates.rows as any[]).find(
          (r) => normaliseDocNumber(r.invoice_number) === nNumber,
        )
        if (dupeRow) {
          // Abort without writing anything — the transaction commits with no inserts.
          return { status: "duplicate", existing: rowToExistingRef(dupeRow) }
        }
      }

      // For a credit note, try to link the original invoice it relates to:
      // same supplier + same normalised number is the confident case.
      let creditOfInvoiceId: number | null = null
      if (input.transactionType === "credit" && nNumber) {
        const originals = await tx.execute(sql`
          SELECT inv.id, inv.invoice_number FROM invoices inv
          WHERE inv.supplier_id = ${supplierId} AND inv.transaction_type = 'invoice'
        `)
        const match = (originals.rows as any[]).find(
          (r) => normaliseDocNumber(r.invoice_number) === nNumber,
        )
        creditOfInvoiceId = match ? Number(match.id) : null
      }

      const [invoice] = await tx
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
          sourceFileHash: input.sourceFileHash,
          sourcePageStart: input.sourcePageStart,
          sourcePageEnd: input.sourcePageEnd,
          notes: input.notes,
          extractionRaw: (input.extractionRaw ?? null) as any,
          confidence: input.confidence ?? null,
          creditOfInvoiceId,
          needsReview: input.needsReview ?? false,
          reconciled: input.reconciled ?? true,
        })
        .returning()

      for (const li of input.lineItems) {
        // Resolve product for this line (optional)
        let productId = li.productId
        if (!productId && li.trackAsProduct) {
          const pname = (li.newProductName || li.description).trim()
          if (pname) {
            const existing = await tx.select().from(products).where(ilike(products.name, pname)).limit(1)
            if (existing[0]) {
              productId = existing[0].id
            } else {
              const np = li.normalisedProduct ?? {}
              const [created] = await tx
                .insert(products)
                .values({
                  name: pname,
                  description: li.description,
                  category: li.newProductCategory ?? np.subcategory ?? null,
                  unit: li.normalisedUnit ?? li.unit ?? null,
                  normalisedName: np.normalisedName ?? null,
                  productFamily: np.productFamily ?? null,
                  productType: np.productType ?? null,
                  dimensions: np.dimensions ?? null,
                  thickness: np.thickness ?? null,
                  subcategory: np.subcategory ?? null,
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
        // Only genuine materials with a product + price feed procurement pricing.
        const priceTracked = li.isPriceTracked !== false

        const [lineItem] = await tx
          .insert(invoiceLineItems)
          .values({
            invoiceId: invoice.id,
            productId: productId ?? null,
            costPackageId: li.costPackageId,
            description: li.description,
            rawDescription: li.description,
            quantity: li.quantity == null ? null : String(li.quantity),
            unit: li.unit,
            rawUnit: li.unit,
            normalisedUnit: li.normalisedUnit ?? null,
            unitPriceExVat: li.unitPriceExVat == null ? null : String(li.unitPriceExVat),
            lineNet: String(lineNet),
            lineVat: String(lineVat),
            lineGross: String(lineGross),
            vatRate: String(vatRate),
            isPriceTracked: priceTracked,
          })
          .returning()

        // Derive a price record when we have a tracked product, a unit price,
        // this is an invoice (not a credit), and the line is flagged for tracking.
        if (
          productId &&
          priceTracked &&
          li.unitPriceExVat != null &&
          input.transactionType === "invoice"
        ) {
          const priceEx = Math.abs(li.unitPriceExVat)
          const vatAmount = Math.round(priceEx * (vatRate / 100) * 100) / 100
          await tx.insert(priceRecords).values({
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
            normalisedUnit: li.normalisedUnit ?? null,
            invoiceDate: input.invoiceDate || null,
            invoiceNumber: input.invoiceNumber,
            transactionType: input.transactionType,
          })
        }

        // Record the learned classification so the same line is pre-filled next
        // time. Keyed by product id where known, else by normalised description.
        if (li.costPackageCode || li.costPackageName || li.newProductCategory || li.normalisedUnit) {
          const key = productId ? `p:${productId}` : normaliseDescriptionKey(li.description)
          const keyKind = productId ? "product" : "description"
          if (key) {
            await tx.execute(sql`
              INSERT INTO classification_mappings
                (key_kind, key_value, supplier_id, product_id, cost_package_code,
                 cost_package_name, category, normalised_unit, track_as_product, times_confirmed)
              VALUES
                (${keyKind}, ${key}, ${supplierId}, ${productId ?? null},
                 ${li.costPackageCode ?? null}, ${li.costPackageName ?? null},
                 ${li.newProductCategory ?? null}, ${li.normalisedUnit ?? null},
                 ${li.trackAsProduct}, 1)
              ON CONFLICT (key_kind, key_value, (coalesce(supplier_id, 0)))
              DO UPDATE SET
                cost_package_code = COALESCE(EXCLUDED.cost_package_code, classification_mappings.cost_package_code),
                cost_package_name = COALESCE(EXCLUDED.cost_package_name, classification_mappings.cost_package_name),
                category = COALESCE(EXCLUDED.category, classification_mappings.category),
                normalised_unit = COALESCE(EXCLUDED.normalised_unit, classification_mappings.normalised_unit),
                track_as_product = EXCLUDED.track_as_product,
                times_confirmed = classification_mappings.times_confirmed + 1,
                updated_at = now()
            `)
          }
        }
      }

      // Learn the supplier heading → supplier mapping so cosmetic name
      // variations resolve instantly (and don't spawn duplicate suppliers).
      const rawSupplierName = (input.rawSupplierHeading ?? input.newSupplierName ?? "").trim()
      const supNorm = normaliseSupplierName(rawSupplierName)
      if (supNorm) {
        await tx.execute(sql`
          INSERT INTO supplier_aliases (supplier_id, normalised_name, raw_name)
          VALUES (${supplierId}, ${supNorm}, ${rawSupplierName || null})
          ON CONFLICT (normalised_name) DO NOTHING
        `)
      }

      return { status: "committed", invoiceId: invoice.id }
    })

    if (result.status === "committed") {
      revalidatePath("/")
      revalidatePath("/invoices")
      revalidatePath("/procurement")
      revalidatePath("/suppliers")
      revalidatePath("/commercial")
      revalidatePath("/projects")
    }
    return result
  } catch (e) {
    // Database-level backstop: the unique index rejected a concurrent/duplicate
    // insert. The transaction rolled back, so no rollups were created. Report it
    // as a duplicate rather than a hard error.
    if (isUniqueViolation(e)) {
      const candidates = await db.execute(sql`
        ${EXISTING_REF_SELECT}
        WHERE inv.transaction_type = ${input.transactionType}
      `)
      const existing =
        (candidates.rows as any[])
          .map(rowToExistingRef)
          .find(
            (r) =>
              normaliseDocNumber(r.invoiceNumber) === nNumber &&
              normaliseSupplierName(r.supplierName) === normaliseSupplierName(input.newSupplierName),
          ) ?? null
      return { status: "duplicate", existing }
    }
    throw e
  }
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
