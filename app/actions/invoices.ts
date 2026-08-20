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
  costPackages,
} from "@/lib/db/schema"
import { and, eq, ilike, inArray, isNull, ne, sql } from "drizzle-orm"
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

        // Learn this line's classification so the same (or a similarly-worded)
        // product is pre-filled next time. Keyed by the NORMALISED DESCRIPTION
        // — not the raw product id — so learning generalises across invoices
        // that word the product differently, and matches the recall path in
        // prepareBatch exactly. Scoped to this supplier (their wording is
        // consistent); the category mapping below provides the cross-supplier
        // generalisation.
        const productKey = normaliseDescriptionKey(li.description)
        if (productKey && (li.costPackageCode || li.costPackageName || li.newProductCategory || li.normalisedUnit)) {
          await tx.execute(sql`
            INSERT INTO classification_mappings
              (key_kind, key_value, supplier_id, product_id, cost_package_code,
               cost_package_name, category, normalised_unit, track_as_product, times_confirmed)
            VALUES
              ('product', ${productKey}, ${supplierId}, ${productId ?? null},
               ${li.costPackageCode ?? null}, ${li.costPackageName ?? null},
               ${li.newProductCategory ?? null}, ${li.normalisedUnit ?? null},
               ${li.trackAsProduct}, 1)
            ON CONFLICT (key_kind, key_value, (coalesce(supplier_id, 0)))
            DO UPDATE SET
              product_id = COALESCE(EXCLUDED.product_id, classification_mappings.product_id),
              cost_package_code = COALESCE(EXCLUDED.cost_package_code, classification_mappings.cost_package_code),
              cost_package_name = COALESCE(EXCLUDED.cost_package_name, classification_mappings.cost_package_name),
              category = COALESCE(EXCLUDED.category, classification_mappings.category),
              normalised_unit = COALESCE(EXCLUDED.normalised_unit, classification_mappings.normalised_unit),
              track_as_product = EXCLUDED.track_as_product,
              times_confirmed = classification_mappings.times_confirmed + 1,
              updated_at = now()
          `)
        }

        // Learn CATEGORY → package as a broader, supplier-independent fallback
        // (stored globally, supplier_id NULL) so a never-seen product in a
        // known category still lands in the right package on a future invoice.
        const catKey = (li.newProductCategory ?? "").trim().toLowerCase()
        if (catKey && (li.costPackageCode || li.costPackageName)) {
          await tx.execute(sql`
            INSERT INTO classification_mappings
              (key_kind, key_value, supplier_id, cost_package_code, cost_package_name, category, times_confirmed)
            VALUES
              ('category', ${catKey}, NULL, ${li.costPackageCode ?? null},
               ${li.costPackageName ?? null}, ${li.newProductCategory ?? null}, 1)
            ON CONFLICT (key_kind, key_value, (coalesce(supplier_id, 0)))
            DO UPDATE SET
              cost_package_code = COALESCE(EXCLUDED.cost_package_code, classification_mappings.cost_package_code),
              cost_package_name = COALESCE(EXCLUDED.cost_package_name, classification_mappings.cost_package_name),
              times_confirmed = classification_mappings.times_confirmed + 1,
              updated_at = now()
          `)
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

// ---------------------------------------------------------------------------
// Inline line-item classification (post-commit, from the invoices page)
// ---------------------------------------------------------------------------

/** The transaction type db.transaction() hands its callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

type ClassifiableLine = {
  id: number
  description: string
  productId: number | null
  normalisedUnit: string | null
  projectId: number | null
  supplierId: number
  productCategory: string | null
}

async function loadClassifiableLine(tx: Tx, lineItemId: number): Promise<ClassifiableLine | null> {
  const rows = await tx
    .select({
      id: invoiceLineItems.id,
      description: invoiceLineItems.description,
      productId: invoiceLineItems.productId,
      normalisedUnit: invoiceLineItems.normalisedUnit,
      projectId: invoices.projectId,
      supplierId: invoices.supplierId,
      productCategory: products.category,
    })
    .from(invoiceLineItems)
    .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
    .leftJoin(products, eq(products.id, invoiceLineItems.productId))
    .where(eq(invoiceLineItems.id, lineItemId))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Set (or clear) a single line item's cost package and, on assignment only,
 * write the SAME learned mappings `commitInvoice` writes on confirm — a
 * supplier-scoped PRODUCT key plus a global CATEGORY fallback, both upserted
 * with `times_confirmed` incremented on conflict against the identical
 * partial-index target `(key_kind, key_value, coalesce(supplier_id, 0))`.
 * This is one learning system: a mapping learned here is indistinguishable
 * in shape from one learned at commit time.
 *
 * Guards (the application is the only protection — there are no DB foreign
 * keys): the line's invoice must exist, and a non-null cost package must
 * belong to the invoice's OWN project. Clearing (costPackageId = null) is
 * always allowed and never writes to classification_mappings — clearing a
 * line is not a human confirmation of anything.
 */
async function applyLineClassification(
  tx: Tx,
  lineItemId: number,
  costPackageId: number | null,
): Promise<ClassifiableLine> {
  const line = await loadClassifiableLine(tx, lineItemId)
  if (!line) {
    throw new Error(`Line item ${lineItemId} (or its invoice) was not found.`)
  }

  if (costPackageId == null) {
    await tx.update(invoiceLineItems).set({ costPackageId: null }).where(eq(invoiceLineItems.id, lineItemId))
    return line
  }

  const [pkg] = await tx
    .select({ id: costPackages.id, projectId: costPackages.projectId, code: costPackages.code, name: costPackages.name })
    .from(costPackages)
    .where(eq(costPackages.id, costPackageId))
    .limit(1)
  if (!pkg) {
    throw new Error(`Cost package ${costPackageId} was not found.`)
  }
  if (line.projectId == null) {
    throw new Error("This invoice has no project assigned; assign a project before classifying its lines.")
  }
  if (pkg.projectId !== line.projectId) {
    throw new Error(`Cost package "${pkg.code ?? pkg.name}" belongs to a different project than this invoice.`)
  }

  await tx.update(invoiceLineItems).set({ costPackageId }).where(eq(invoiceLineItems.id, lineItemId))

  // Learn this confirmation — identical shape to commitInvoice's upsert.
  const productKey = normaliseDescriptionKey(line.description)
  if (productKey) {
    await tx.execute(sql`
      INSERT INTO classification_mappings
        (key_kind, key_value, supplier_id, product_id, cost_package_code,
         cost_package_name, category, normalised_unit, times_confirmed)
      VALUES
        ('product', ${productKey}, ${line.supplierId}, ${line.productId ?? null},
         ${pkg.code ?? null}, ${pkg.name ?? null}, ${line.productCategory ?? null},
         ${line.normalisedUnit ?? null}, 1)
      ON CONFLICT (key_kind, key_value, (coalesce(supplier_id, 0)))
      DO UPDATE SET
        product_id = COALESCE(EXCLUDED.product_id, classification_mappings.product_id),
        cost_package_code = COALESCE(EXCLUDED.cost_package_code, classification_mappings.cost_package_code),
        cost_package_name = COALESCE(EXCLUDED.cost_package_name, classification_mappings.cost_package_name),
        category = COALESCE(EXCLUDED.category, classification_mappings.category),
        normalised_unit = COALESCE(EXCLUDED.normalised_unit, classification_mappings.normalised_unit),
        times_confirmed = classification_mappings.times_confirmed + 1,
        updated_at = now()
    `)

    const catKey = (line.productCategory ?? "").trim().toLowerCase()
    if (catKey) {
      await tx.execute(sql`
        INSERT INTO classification_mappings
          (key_kind, key_value, supplier_id, cost_package_code, cost_package_name, category, times_confirmed)
        VALUES
          ('category', ${catKey}, NULL, ${pkg.code ?? null}, ${pkg.name ?? null}, ${line.productCategory ?? null}, 1)
        ON CONFLICT (key_kind, key_value, (coalesce(supplier_id, 0)))
        DO UPDATE SET
          cost_package_code = COALESCE(EXCLUDED.cost_package_code, classification_mappings.cost_package_code),
          cost_package_name = COALESCE(EXCLUDED.cost_package_name, classification_mappings.cost_package_name),
          times_confirmed = classification_mappings.times_confirmed + 1,
          updated_at = now()
      `)
    }
  }

  return line
}

/**
 * Classify (or clear) one line item from the invoices page. `costPackageId
 * = null` clears the line back to unclassified; any other value is treated
 * as a human confirmation and taught to `classification_mappings` (Section
 * 11 of the handover / non-negotiable #7).
 */
export async function classifyInvoiceLine(lineItemId: number, costPackageId: number | null): Promise<{ success: true }> {
  await db.transaction(async (tx) => {
    await applyLineClassification(tx, lineItemId, costPackageId)
  })
  revalidatePath("/invoices")
  revalidatePath("/commercial")
  return { success: true }
}

/**
 * Same as `classifyInvoiceLine`, but a non-null assignment also propagates to
 * OTHER unclassified line items — any invoice, same supplier — whose
 * normalised description produces the identical mapping key. Scoped to the
 * SAME project as the chosen package: a cost package belongs to one project,
 * and re-attributing another project's spend onto it would double-count
 * against that project's cost-package (and downstream funding) totals
 * (non-negotiable #3/#8). Never overwrites a line that already carries a
 * classification. Clearing never cascades — it stays a single explicit
 * action on one line.
 *
 * Returns the total number of line items updated (the target line plus any
 * matches).
 */
export async function classifyMatchingLines(
  lineItemId: number,
  costPackageId: number | null,
): Promise<{ updatedCount: number }> {
  if (costPackageId == null) {
    await classifyInvoiceLine(lineItemId, null)
    return { updatedCount: 1 }
  }

  const updatedCount = await db.transaction(async (tx) => {
    const line = await applyLineClassification(tx, lineItemId, costPackageId)
    const key = normaliseDescriptionKey(line.description)
    if (!key) return 1

    // line.projectId is guaranteed non-null here: applyLineClassification
    // throws above for a non-null costPackageId when the invoice has no
    // project.
    const projectId = line.projectId as number

    const candidates = await tx
      .select({ id: invoiceLineItems.id, description: invoiceLineItems.description })
      .from(invoiceLineItems)
      .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
      .where(
        and(
          eq(invoices.supplierId, line.supplierId),
          eq(invoices.projectId, projectId),
          isNull(invoiceLineItems.costPackageId),
          ne(invoiceLineItems.id, lineItemId),
        ),
      )

    const matchIds = candidates
      .filter((c) => normaliseDescriptionKey(c.description) === key)
      .map((c) => c.id)

    if (matchIds.length > 0) {
      await tx.update(invoiceLineItems).set({ costPackageId }).where(inArray(invoiceLineItems.id, matchIds))
    }

    return 1 + matchIds.length
  })

  revalidatePath("/invoices")
  revalidatePath("/commercial")
  return { updatedCount }
}

export type PaymentStatus = "unpaid" | "paid" | "part_paid"
const PAYMENT_STATUSES: PaymentStatus[] = ["unpaid", "paid", "part_paid"]

export type SetInvoicePaymentInput = {
  paymentStatus: PaymentStatus | null
  paidDate: string | null
  paymentNotes: string | null
}

/**
 * Records the payment state of an invoice for cash-flow visibility. This is
 * entirely separate from extraction/reconciliation and never touches amounts
 * (net/vat/gross) or any other financial field — it only ever writes the
 * three payment columns. `paymentStatus: null` clears the invoice back to
 * "not recorded"; it is never inferred or defaulted.
 */
export async function setInvoicePayment(invoiceId: number, input: SetInvoicePaymentInput) {
  if (input.paymentStatus !== null && !PAYMENT_STATUSES.includes(input.paymentStatus)) {
    throw new Error(`Invalid payment status: ${input.paymentStatus}`)
  }

  await db
    .update(invoices)
    .set({
      paymentStatus: input.paymentStatus,
      paidDate: input.paidDate || null,
      paymentNotes: input.paymentNotes || null,
    })
    .where(eq(invoices.id, invoiceId))

  revalidatePath("/invoices")
}

// ---------------------------------------------------------------------------
// Review queue: two-way question channel
// ---------------------------------------------------------------------------

const REVIEW_QUESTION_MAX_LENGTH = 2000

/**
 * Attach a question the assistant wants the owner to answer about this
 * invoice. Clears any previous answer — a new question means the previous
 * question/answer pair is no longer the live one. Never fabricates content:
 * the caller supplies the question text; this only validates and persists it.
 */
export async function askInvoiceQuestion(invoiceId: number, question: string) {
  const trimmed = question.trim()
  if (!trimmed) {
    throw new Error("A question is required.")
  }
  if (trimmed.length > REVIEW_QUESTION_MAX_LENGTH) {
    throw new Error(`Question is too long (max ${REVIEW_QUESTION_MAX_LENGTH} characters).`)
  }

  await db
    .update(invoices)
    .set({
      reviewQuestion: trimmed,
      reviewQuestionAt: new Date(),
      reviewAnswer: null,
      reviewAnswerAt: null,
    })
    .where(eq(invoices.id, invoiceId))

  revalidatePath("/invoices")
}

/**
 * Records the owner's reply to an outstanding question. Does NOT clear
 * review_question — the question/answer pair together is the record, so the
 * assistant can see exactly what was asked alongside what was answered.
 */
export async function answerInvoiceQuestion(invoiceId: number, answer: string) {
  const trimmed = answer.trim()
  if (!trimmed) {
    throw new Error("An answer is required.")
  }
  if (trimmed.length > REVIEW_QUESTION_MAX_LENGTH) {
    throw new Error(`Answer is too long (max ${REVIEW_QUESTION_MAX_LENGTH} characters).`)
  }

  await db
    .update(invoices)
    .set({
      reviewAnswer: trimmed,
      reviewAnswerAt: new Date(),
    })
    .where(eq(invoices.id, invoiceId))

  revalidatePath("/invoices")
}

/**
 * The "approve" action for the review queue — sets `needs_review`. Setting it
 * to `false` takes the invoice out of the queue; setting it to `true` puts it
 * back. Independent of the question channel — an invoice can be marked
 * reviewed with an outstanding question still attached, or vice versa.
 */
export async function markInvoiceReviewed(invoiceId: number, reviewed: boolean) {
  await db
    .update(invoices)
    .set({ needsReview: !reviewed })
    .where(eq(invoices.id, invoiceId))

  revalidatePath("/invoices")
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
