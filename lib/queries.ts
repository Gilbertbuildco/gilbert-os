import "server-only"
import { db } from "@/lib/db"
import { sql, type SQL } from "drizzle-orm"
import { normaliseDescriptionKey } from "@/lib/normalisation/products"
import { resolveProjectPackage, type ProjectPackage } from "@/lib/cost-plan"

/**
 * Read-side data access for Gilbert OS.
 * Every figure here is derived from committed invoices / price records — there
 * is no fabricated sample data. Empty results are the truthful state until real
 * invoices are ingested.
 */

const n = (v: unknown): number => (v == null ? 0 : Number(v))

export type ProjectRow = {
  id: number
  slug: string
  name: string
  location: string | null
  status: string
  homes: number | null
  buildAreaSqft: number | null
  originalBuildBudget: number | null
  developmentFacility: number | null
  remainingDrawdown: number | null
  expectedGdv: number | null
  landPrice: number | null
  buildCostPerSqft: number | null
  /**
   * BUILD cost spend to date — confirmed-invoice net, MINUS any line items
   * classified into a non-build-cost package (cost_packages.is_build_cost =
   * false, e.g. "Legal & broker fees"). This is the figure compared against
   * `originalBuildBudget` everywhere in the UI, so it must never include the
   * cost of borrowing/transacting. That excluded spend is never dropped —
   * it is always available separately as `nonBuildCostSpend`.
   */
  spendToDate: number
  /** Confirmed-invoice spend on non-build-cost packages — real project cost, deliberately excluded from spendToDate/build-cost totals. */
  nonBuildCostSpend: number
  invoiceCount: number
}

/**
 * Shared non-build-cost subquery: confirmed-invoice line-item net summed per
 * project, restricted to lines classified into a package where
 * `is_build_cost = false`. Unclassified lines (cost_package_id IS NULL) and
 * lines on build-cost packages are never counted here — only an EXPLICIT
 * non-build classification excludes spend from the build-cost total.
 */
const NON_BUILD_SPEND_SUBQUERY = sql`
  SELECT inv2.project_id, SUM(li.line_net) AS non_build_spend
  FROM invoice_line_items li
  JOIN invoices inv2 ON inv2.id = li.invoice_id
  JOIN cost_packages cp ON cp.id = li.cost_package_id
  WHERE inv2.status = 'confirmed' AND cp.is_build_cost = false
  GROUP BY inv2.project_id
`

export async function getProjects(): Promise<ProjectRow[]> {
  const rows = await db.execute(sql`
    SELECT p.*,
      COALESCE(s.spend, 0) AS spend_raw,
      COALESCE(nb.non_build_spend, 0) AS non_build_cost_spend,
      COALESCE(s.spend, 0) - COALESCE(nb.non_build_spend, 0) AS spend_to_date,
      COALESCE(s.cnt, 0)   AS invoice_count
    FROM projects p
    LEFT JOIN (
      SELECT project_id, SUM(net) AS spend, COUNT(*) AS cnt
      FROM invoices
      WHERE status = 'confirmed'
      GROUP BY project_id
    ) s ON s.project_id = p.id
    LEFT JOIN (${NON_BUILD_SPEND_SUBQUERY}) nb ON nb.project_id = p.id
    ORDER BY p.created_at ASC
  `)
  return (rows.rows as any[]).map(mapProject)
}

export async function getProjectBySlug(slug: string): Promise<ProjectRow | null> {
  const rows = await db.execute(sql`
    SELECT p.*,
      COALESCE(s.spend, 0) AS spend_raw,
      COALESCE(nb.non_build_spend, 0) AS non_build_cost_spend,
      COALESCE(s.spend, 0) - COALESCE(nb.non_build_spend, 0) AS spend_to_date,
      COALESCE(s.cnt, 0)   AS invoice_count
    FROM projects p
    LEFT JOIN (
      SELECT project_id, SUM(net) AS spend, COUNT(*) AS cnt
      FROM invoices WHERE status = 'confirmed' GROUP BY project_id
    ) s ON s.project_id = p.id
    LEFT JOIN (${NON_BUILD_SPEND_SUBQUERY}) nb ON nb.project_id = p.id
    WHERE p.slug = ${slug}
    LIMIT 1
  `)
  const r = (rows.rows as any[])[0]
  return r ? mapProject(r) : null
}

function mapProject(r: any): ProjectRow {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    location: r.location,
    status: r.status,
    homes: r.homes,
    buildAreaSqft: r.build_area_sqft,
    originalBuildBudget: r.original_build_budget == null ? null : n(r.original_build_budget),
    developmentFacility: r.development_facility == null ? null : n(r.development_facility),
    remainingDrawdown: r.remaining_drawdown == null ? null : n(r.remaining_drawdown),
    expectedGdv: r.expected_gdv == null ? null : n(r.expected_gdv),
    landPrice: r.land_price == null ? null : n(r.land_price),
    buildCostPerSqft: r.build_cost_per_sqft == null ? null : n(r.build_cost_per_sqft),
    spendToDate: n(r.spend_to_date),
    nonBuildCostSpend: n(r.non_build_cost_spend),
    invoiceCount: n(r.invoice_count),
  }
}

export type CostPackageRow = {
  id: number
  code: string | null
  name: string
  originalBudget: number | null
  committed: number
  lineItemCount: number
  /**
   * False for packages that are real project costs but NOT construction cost
   * (e.g. "Legal & broker fees") — excluded from build-cost/committed-spend
   * roll-ups. The package and its `committed` figure are still returned in
   * full here; only aggregate BUILD-cost totals elsewhere skip it. Never
   * hide the underlying spend, just don't let it inflate build cost.
   */
  isBuildCost: boolean
}

export async function getCostPackagesForProject(projectId: number): Promise<CostPackageRow[]> {
  const rows = await db.execute(sql`
    SELECT cp.id, cp.code, cp.name, cp.original_budget, cp.is_build_cost,
      COALESCE(li.committed, 0) AS committed,
      COALESCE(li.cnt, 0) AS line_item_count
    FROM cost_packages cp
    LEFT JOIN (
      SELECT cost_package_id, SUM(line_net) AS committed, COUNT(*) AS cnt
      FROM invoice_line_items GROUP BY cost_package_id
    ) li ON li.cost_package_id = cp.id
    WHERE cp.project_id = ${projectId}
    ORDER BY cp.code ASC NULLS LAST, cp.id ASC
  `)
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    originalBudget: r.original_budget == null ? null : n(r.original_budget),
    committed: n(r.committed),
    lineItemCount: n(r.line_item_count),
    isBuildCost: Boolean(r.is_build_cost),
  }))
}

export type ProductPriceRow = {
  id: number
  name: string
  description: string | null
  category: string | null
  manufacturer: string | null
  unit: string | null
  supplierCount: number
  recordCount: number
  minPrice: number | null
  maxPrice: number | null
  avgPrice: number | null
  latestPrice: number | null
  latestDate: string | null
}

export async function getProductPrices(): Promise<ProductPriceRow[]> {
  const rows = await db.execute(sql`
    SELECT pr.id, pr.name, pr.description, pr.category, pr.manufacturer, pr.unit,
      COUNT(DISTINCT rec.supplier_id) AS supplier_count,
      COUNT(rec.id) AS record_count,
      MIN(rec.price_ex_vat) AS min_price,
      MAX(rec.price_ex_vat) AS max_price,
      AVG(rec.price_ex_vat) AS avg_price,
      (SELECT price_ex_vat FROM price_records r2
        WHERE r2.product_id = pr.id
        ORDER BY r2.invoice_date DESC NULLS LAST, r2.created_at DESC LIMIT 1) AS latest_price,
      (SELECT invoice_date FROM price_records r3
        WHERE r3.product_id = pr.id
        ORDER BY r3.invoice_date DESC NULLS LAST, r3.created_at DESC LIMIT 1) AS latest_date
    FROM products pr
    LEFT JOIN price_records rec ON rec.product_id = pr.id
    GROUP BY pr.id
    ORDER BY pr.name ASC
  `)
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    category: r.category,
    manufacturer: r.manufacturer,
    unit: r.unit,
    supplierCount: n(r.supplier_count),
    recordCount: n(r.record_count),
    minPrice: r.min_price == null ? null : n(r.min_price),
    maxPrice: r.max_price == null ? null : n(r.max_price),
    avgPrice: r.avg_price == null ? null : n(r.avg_price),
    latestPrice: r.latest_price == null ? null : n(r.latest_price),
    latestDate: r.latest_date ? String(r.latest_date) : null,
  }))
}

export type PriceHistoryRow = {
  id: number
  supplierName: string
  priceExVat: number
  unit: string | null
  invoiceDate: string | null
  invoiceNumber: string | null
  transactionType: string
  projectName: string | null
}

export async function getPriceHistoryForProduct(productId: number): Promise<PriceHistoryRow[]> {
  const rows = await db.execute(sql`
    SELECT rec.id, s.name AS supplier_name, rec.price_ex_vat, rec.unit,
      rec.invoice_date, rec.invoice_number, rec.transaction_type,
      p.name AS project_name
    FROM price_records rec
    JOIN suppliers s ON s.id = rec.supplier_id
    LEFT JOIN projects p ON p.id = rec.project_id
    WHERE rec.product_id = ${productId}
    ORDER BY rec.invoice_date DESC NULLS LAST, rec.created_at DESC
  `)
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    supplierName: r.supplier_name,
    priceExVat: n(r.price_ex_vat),
    unit: r.unit,
    invoiceDate: r.invoice_date ? String(r.invoice_date) : null,
    invoiceNumber: r.invoice_number,
    transactionType: r.transaction_type,
    projectName: r.project_name,
  }))
}

export type SupplierRow = {
  id: number
  name: string
  contact: string | null
  invoiceCount: number
  totalSpend: number
  productCount: number
  lastInvoiceDate: string | null
}

export async function getSuppliers(): Promise<SupplierRow[]> {
  const rows = await db.execute(sql`
    SELECT s.id, s.name, s.contact,
      COALESCE(i.cnt, 0) AS invoice_count,
      COALESCE(i.spend, 0) AS total_spend,
      i.last_date,
      COALESCE(sp.pcnt, 0) AS product_count
    FROM suppliers s
    LEFT JOIN (
      SELECT supplier_id, COUNT(*) AS cnt, SUM(net) AS spend, MAX(invoice_date) AS last_date
      FROM invoices WHERE status = 'confirmed' GROUP BY supplier_id
    ) i ON i.supplier_id = s.id
    LEFT JOIN (
      SELECT supplier_id, COUNT(DISTINCT product_id) AS pcnt
      FROM price_records GROUP BY supplier_id
    ) sp ON sp.supplier_id = s.id
    ORDER BY total_spend DESC, s.name ASC
  `)
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    contact: r.contact,
    invoiceCount: n(r.invoice_count),
    totalSpend: n(r.total_spend),
    productCount: n(r.product_count),
    lastInvoiceDate: r.last_date ? String(r.last_date) : null,
  }))
}

export type InvoiceRow = {
  id: number
  supplierName: string
  projectName: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  transactionType: string
  net: number
  vat: number
  gross: number
  status: string
  lineItemCount: number
  sourceFileName: string | null
  sourceFilePathname: string | null
  sourcePageStart: number | null
  sourcePageEnd: number | null
  needsReview: boolean
  reconciled: boolean
  confidence: string | null
  classifiedLineCount: number
  unclassifiedNet: number
  /** Cash-flow payment state. Null means "not recorded" — never inferred. */
  paymentStatus: "unpaid" | "paid" | "part_paid" | null
  paidDate: string | null
  /** Two-way review-question channel. Null means no question is outstanding. */
  reviewQuestion: string | null
  reviewQuestionAt: string | null
  /** The owner's reply. Null means unanswered. */
  reviewAnswer: string | null
  reviewAnswerAt: string | null
}

/**
 * Shared filter set for the invoice list and its summary. Every field is
 * optional; an empty object matches every invoice (subject to whatever
 * pagination/sort the caller adds on top in getInvoices).
 */
export type InvoiceListFilters = {
  search?: string
  supplierId?: number
  projectId?: number
  dateFrom?: string
  dateTo?: string
  transactionType?: "invoice" | "credit"
  needsReview?: boolean
  unclassifiedOnly?: boolean
  /** "unrecorded" means payment_status IS NULL — not the same fact as "unpaid". */
  paymentStatus?: "unpaid" | "paid" | "part_paid" | "unrecorded"
  /** review_question IS NOT NULL AND review_answer IS NULL — awaiting the owner. */
  hasQuestion?: boolean
  /** review_question IS NOT NULL AND review_answer IS NOT NULL — awaiting the assistant. */
  answered?: boolean
}

export type InvoiceSort = "date" | "supplier" | "number" | "net" | "gross"
export type SortDirection = "asc" | "desc"

export type InvoiceListOptions = InvoiceListFilters & {
  sort?: InvoiceSort
  direction?: SortDirection
  limit?: number
  offset?: number
}

// Explicit whitelist — never interpolate a caller-supplied sort column into SQL.
const INVOICE_SORT_COLUMNS: Record<InvoiceSort, SQL> = {
  date: sql`inv.invoice_date`,
  supplier: sql`s.name`,
  number: sql`inv.invoice_number`,
  net: sql`inv.net`,
  gross: sql`inv.gross`,
}

/** Builds the shared WHERE conditions for the invoice list and its summary. */
function buildInvoiceFilterConditions(filters: InvoiceListFilters): SQL[] {
  const conditions: SQL[] = []

  if (filters.search && filters.search.trim() !== "") {
    const like = `%${filters.search.trim()}%`
    conditions.push(sql`(
      inv.invoice_number ILIKE ${like}
      OR s.name ILIKE ${like}
      OR EXISTS (
        SELECT 1 FROM invoice_line_items sli
        WHERE sli.invoice_id = inv.id AND sli.description ILIKE ${like}
      )
    )`)
  }
  if (filters.supplierId != null) {
    conditions.push(sql`inv.supplier_id = ${filters.supplierId}`)
  }
  if (filters.projectId != null) {
    conditions.push(sql`inv.project_id = ${filters.projectId}`)
  }
  if (filters.dateFrom) {
    conditions.push(sql`inv.invoice_date >= ${filters.dateFrom}`)
  }
  if (filters.dateTo) {
    conditions.push(sql`inv.invoice_date <= ${filters.dateTo}`)
  }
  if (filters.transactionType) {
    conditions.push(sql`inv.transaction_type = ${filters.transactionType}`)
  }
  if (filters.needsReview != null) {
    conditions.push(sql`inv.needs_review = ${filters.needsReview}`)
  }
  if (filters.unclassifiedOnly) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM invoice_line_items uli
      WHERE uli.invoice_id = inv.id AND uli.cost_package_id IS NULL
    )`)
  }
  if (filters.paymentStatus === "unrecorded") {
    conditions.push(sql`inv.payment_status IS NULL`)
  } else if (filters.paymentStatus != null) {
    conditions.push(sql`inv.payment_status = ${filters.paymentStatus}`)
  }
  if (filters.hasQuestion != null) {
    conditions.push(
      filters.hasQuestion
        ? sql`inv.review_question IS NOT NULL AND inv.review_answer IS NULL`
        : sql`NOT (inv.review_question IS NOT NULL AND inv.review_answer IS NULL)`,
    )
  }
  if (filters.answered != null) {
    conditions.push(
      filters.answered
        ? sql`inv.review_question IS NOT NULL AND inv.review_answer IS NOT NULL`
        : sql`NOT (inv.review_question IS NOT NULL AND inv.review_answer IS NOT NULL)`,
    )
  }

  return conditions
}

function whereClause(conditions: SQL[]): SQL {
  return conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``
}

export async function getInvoices(options: InvoiceListOptions = {}): Promise<InvoiceRow[]> {
  const conditions = buildInvoiceFilterConditions(options)
  const where = whereClause(conditions)

  const sortColumn = INVOICE_SORT_COLUMNS[options.sort ?? "date"] ?? INVOICE_SORT_COLUMNS.date
  const direction = options.direction === "asc" ? sql`ASC` : sql`DESC`

  const limit = options.limit != null ? sql`LIMIT ${options.limit}` : sql``
  const offset = options.offset != null ? sql`OFFSET ${options.offset}` : sql``

  const rows = await db.execute(sql`
    SELECT inv.id, s.name AS supplier_name, p.name AS project_name,
      inv.invoice_number, inv.invoice_date, inv.transaction_type,
      inv.net, inv.vat, inv.gross, inv.status,
      inv.source_file_name, inv.source_file_pathname,
      inv.source_page_start, inv.source_page_end,
      inv.needs_review, inv.reconciled, inv.confidence,
      inv.payment_status, inv.paid_date,
      inv.review_question, inv.review_question_at, inv.review_answer, inv.review_answer_at,
      COALESCE(li.cnt, 0) AS line_item_count,
      COALESCE(li.classified_cnt, 0) AS classified_line_count,
      COALESCE(li.unclassified_net, 0) AS unclassified_net
    FROM invoices inv
    JOIN suppliers s ON s.id = inv.supplier_id
    LEFT JOIN projects p ON p.id = inv.project_id
    LEFT JOIN (
      SELECT invoice_id,
        COUNT(*) AS cnt,
        COUNT(*) FILTER (WHERE cost_package_id IS NOT NULL) AS classified_cnt,
        COALESCE(SUM(line_net) FILTER (WHERE cost_package_id IS NULL), 0) AS unclassified_net
      FROM invoice_line_items GROUP BY invoice_id
    ) li ON li.invoice_id = inv.id
    ${where}
    ORDER BY ${sortColumn} ${direction} NULLS LAST, inv.created_at DESC
    ${limit}
    ${offset}
  `)
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    supplierName: r.supplier_name,
    projectName: r.project_name,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date ? String(r.invoice_date) : null,
    transactionType: r.transaction_type,
    net: n(r.net),
    vat: n(r.vat),
    gross: n(r.gross),
    status: r.status,
    lineItemCount: n(r.line_item_count),
    sourceFileName: r.source_file_name ?? null,
    sourceFilePathname: r.source_file_pathname ?? null,
    sourcePageStart: r.source_page_start == null ? null : Number(r.source_page_start),
    sourcePageEnd: r.source_page_end == null ? null : Number(r.source_page_end),
    needsReview: Boolean(r.needs_review),
    reconciled: Boolean(r.reconciled),
    confidence: r.confidence ?? null,
    classifiedLineCount: n(r.classified_line_count),
    unclassifiedNet: n(r.unclassified_net),
    paymentStatus: r.payment_status ?? null,
    paidDate: r.paid_date ? String(r.paid_date) : null,
    reviewQuestion: r.review_question ?? null,
    reviewQuestionAt: r.review_question_at ? new Date(r.review_question_at).toISOString() : null,
    reviewAnswer: r.review_answer ?? null,
    reviewAnswerAt: r.review_answer_at ? new Date(r.review_answer_at).toISOString() : null,
  }))
}

export type InvoiceSummary = {
  count: number
  totalNet: number
  totalVat: number
  totalGross: number
  needsReviewCount: number
  unclassifiedNet: number
  /**
   * Net total of line items classified into a non-build-cost package
   * (cost_packages.is_build_cost = false, e.g. "Legal & broker fees") —
   * real spend, but the cost of borrowing/transacting, not of building.
   * Included in `totalNet` (this is still a ledger of everything invoiced)
   * but broken out here so it is never silently folded into a "build cost"
   * reading of this summary.
   */
  nonBuildCostNet: number
  /** Gross total where payment_status = 'paid'. */
  paidGross: number
  /**
   * Gross total where payment_status IN ('unpaid', 'part_paid'). We do not
   * track the amount actually paid on a part-paid invoice, so a part-paid
   * invoice's FULL gross counts as outstanding here — this is a label
   * ("cash flow still owed on this invoice"), not a claim that none of it
   * has been paid.
   */
  outstandingGross: number
  /** Gross total where payment_status IS NULL — "not recorded", not "unpaid". */
  unrecordedGross: number
  /** Count with review_question IS NOT NULL AND review_answer IS NULL — awaiting the owner. */
  questionsForOwner: number
  /** Count with review_question IS NOT NULL AND review_answer IS NOT NULL — awaiting the assistant. */
  answersForAssistant: number
}

/**
 * Totals for the set of invoices matching `filters` — not just the current
 * page. Reuses the same WHERE-building logic as getInvoices so the summary
 * and the list it describes can never drift apart. `count` also serves as
 * the pagination total (call with the same filters, minus limit/offset).
 */
export async function getInvoiceSummary(filters: InvoiceListFilters = {}): Promise<InvoiceSummary> {
  const conditions = buildInvoiceFilterConditions(filters)
  const where = whereClause(conditions)

  const rows = await db.execute(sql`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(inv.net), 0) AS total_net,
      COALESCE(SUM(inv.vat), 0) AS total_vat,
      COALESCE(SUM(inv.gross), 0) AS total_gross,
      COUNT(*) FILTER (WHERE inv.needs_review) AS needs_review_count,
      COALESCE(SUM(li.unclassified_net), 0) AS unclassified_net,
      COALESCE(SUM(li.non_build_net), 0) AS non_build_cost_net,
      COALESCE(SUM(inv.gross) FILTER (WHERE inv.payment_status = 'paid'), 0) AS paid_gross,
      COALESCE(SUM(inv.gross) FILTER (WHERE inv.payment_status IN ('unpaid', 'part_paid')), 0) AS outstanding_gross,
      COALESCE(SUM(inv.gross) FILTER (WHERE inv.payment_status IS NULL), 0) AS unrecorded_gross,
      COUNT(*) FILTER (WHERE inv.review_question IS NOT NULL AND inv.review_answer IS NULL) AS questions_for_owner,
      COUNT(*) FILTER (WHERE inv.review_question IS NOT NULL AND inv.review_answer IS NOT NULL) AS answers_for_assistant
    FROM invoices inv
    JOIN suppliers s ON s.id = inv.supplier_id
    LEFT JOIN projects p ON p.id = inv.project_id
    LEFT JOIN (
      SELECT ili.invoice_id,
        COALESCE(SUM(ili.line_net) FILTER (WHERE ili.cost_package_id IS NULL), 0) AS unclassified_net,
        COALESCE(SUM(ili.line_net) FILTER (WHERE cp.is_build_cost = false), 0) AS non_build_net
      FROM invoice_line_items ili
      LEFT JOIN cost_packages cp ON cp.id = ili.cost_package_id
      GROUP BY ili.invoice_id
    ) li ON li.invoice_id = inv.id
    ${where}
  `)
  const r = (rows.rows as any[])[0] ?? {}
  return {
    count: n(r.count),
    totalNet: n(r.total_net),
    totalVat: n(r.total_vat),
    totalGross: n(r.total_gross),
    needsReviewCount: n(r.needs_review_count),
    unclassifiedNet: n(r.unclassified_net),
    nonBuildCostNet: n(r.non_build_cost_net),
    paidGross: n(r.paid_gross),
    outstandingGross: n(r.outstanding_gross),
    unrecordedGross: n(r.unrecorded_gross),
    questionsForOwner: n(r.questions_for_owner),
    answersForAssistant: n(r.answers_for_assistant),
  }
}

export type InvoiceSupplierOption = { id: number; name: string }

/** Distinct suppliers that actually appear on at least one invoice — for the filter dropdown. */
export async function getInvoiceSupplierOptions(): Promise<InvoiceSupplierOption[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT s.id, s.name
    FROM suppliers s
    JOIN invoices inv ON inv.supplier_id = s.id
    ORDER BY s.name ASC
  `)
  return (rows.rows as any[]).map((r) => ({
    id: r.id as number,
    name: r.name as string,
  }))
}

export type PortfolioStats = {
  projectCount: number
  activeProjects: number
  /** BUILD cost only — see ProjectRow.spendToDate. Excludes non-build-cost packages. */
  totalSpend: number
  /** Confirmed-invoice spend on non-build-cost packages, across the whole portfolio. */
  nonBuildCostSpend: number
  invoiceCount: number
  productCount: number
  supplierCount: number
}

export async function getPortfolioStats(): Promise<PortfolioStats> {
  const rows = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM projects) AS project_count,
      (SELECT COUNT(*) FROM projects WHERE status IN ('On Site','In Progress','Active')) AS active_projects,
      (SELECT COALESCE(SUM(net),0) FROM invoices WHERE status = 'confirmed') AS total_spend_raw,
      (SELECT COALESCE(SUM(li.line_net),0)
         FROM invoice_line_items li
         JOIN invoices inv ON inv.id = li.invoice_id
         JOIN cost_packages cp ON cp.id = li.cost_package_id
         WHERE inv.status = 'confirmed' AND cp.is_build_cost = false) AS non_build_cost_spend,
      (SELECT COUNT(*) FROM invoices WHERE status = 'confirmed') AS invoice_count,
      (SELECT COUNT(*) FROM products) AS product_count,
      (SELECT COUNT(*) FROM suppliers) AS supplier_count
  `)
  const r = (rows.rows as any[])[0]
  const nonBuildCostSpend = n(r.non_build_cost_spend)
  return {
    projectCount: n(r.project_count),
    activeProjects: n(r.active_projects),
    totalSpend: n(r.total_spend_raw) - nonBuildCostSpend,
    nonBuildCostSpend,
    invoiceCount: n(r.invoice_count),
    productCount: n(r.product_count),
    supplierCount: n(r.supplier_count),
  }
}

export type ProjectOption = { id: number; name: string; slug: string; status: string }

export async function getProjectOptions(): Promise<ProjectOption[]> {
  const rows = await db.execute(sql`SELECT id, name, slug, status FROM projects ORDER BY name ASC`)
  return (rows.rows as any[]).map((r) => ({
    id: r.id as number,
    name: r.name as string,
    slug: r.slug as string,
    status: (r.status as string) ?? "",
  }))
}

/** The active/live projects, richer shape used for project matching. */
export type ActiveProject = { id: number; name: string; slug: string; location: string | null }

export async function getActiveProjects(): Promise<ActiveProject[]> {
  // Status set kept in sync with lib/cost-plan ACTIVE_PROJECT_STATUSES and the
  // portfolio stats query. Compared case-insensitively.
  const rows = await db.execute(sql`
    SELECT id, name, slug, location FROM projects
    WHERE lower(status) IN ('on site','in progress','active')
    ORDER BY name ASC
  `)
  return (rows.rows as any[]).map((r) => ({
    id: r.id as number,
    name: r.name as string,
    slug: r.slug as string,
    location: (r.location as string) ?? null,
  }))
}

export type LineItemRow = {
  id: number
  description: string
  quantity: number | null
  unit: string | null
  lineNet: number
  costPackageId: number | null
  supplierName: string
  invoiceNumber: string | null
  invoiceDate: string | null
}

export async function getLineItemsForProject(projectId: number): Promise<LineItemRow[]> {
  const rows = await db.execute(sql`
    SELECT li.id, li.description, li.quantity, li.unit, li.line_net, li.cost_package_id,
      s.name AS supplier_name, inv.invoice_number, inv.invoice_date
    FROM invoice_line_items li
    JOIN invoices inv ON inv.id = li.invoice_id
    JOIN suppliers s ON s.id = inv.supplier_id
    WHERE inv.project_id = ${projectId}
    ORDER BY inv.invoice_date DESC NULLS LAST, li.id DESC
  `)
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    description: r.description,
    quantity: r.quantity == null ? null : n(r.quantity),
    unit: r.unit,
    lineNet: n(r.line_net),
    costPackageId: r.cost_package_id,
    supplierName: r.supplier_name,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date ? String(r.invoice_date) : null,
  }))
}

export async function getRecentInvoicesForProject(projectId: number, limit = 8): Promise<InvoiceRow[]> {
  const rows = await db.execute(sql`
    SELECT inv.id, s.name AS supplier_name, p.name AS project_name,
      inv.invoice_number, inv.invoice_date, inv.transaction_type,
      inv.net, inv.vat, inv.gross, inv.status,
      inv.needs_review, inv.reconciled, inv.confidence,
      inv.payment_status, inv.paid_date,
      inv.review_question, inv.review_question_at, inv.review_answer, inv.review_answer_at,
      COALESCE(li.cnt, 0) AS line_item_count,
      COALESCE(li.classified_cnt, 0) AS classified_line_count,
      COALESCE(li.unclassified_net, 0) AS unclassified_net
    FROM invoices inv
    JOIN suppliers s ON s.id = inv.supplier_id
    LEFT JOIN projects p ON p.id = inv.project_id
    LEFT JOIN (
      SELECT invoice_id,
        COUNT(*) AS cnt,
        COUNT(*) FILTER (WHERE cost_package_id IS NOT NULL) AS classified_cnt,
        COALESCE(SUM(line_net) FILTER (WHERE cost_package_id IS NULL), 0) AS unclassified_net
      FROM invoice_line_items GROUP BY invoice_id
    ) li ON li.invoice_id = inv.id
    WHERE inv.project_id = ${projectId}
    ORDER BY inv.invoice_date DESC NULLS LAST, inv.created_at DESC
    LIMIT ${limit}
  `)
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    supplierName: r.supplier_name,
    projectName: r.project_name,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date ? String(r.invoice_date) : null,
    transactionType: r.transaction_type,
    net: n(r.net),
    vat: n(r.vat),
    gross: n(r.gross),
    status: r.status,
    lineItemCount: n(r.line_item_count),
    sourceFileName: null,
    sourceFilePathname: null,
    sourcePageStart: null,
    sourcePageEnd: null,
    needsReview: Boolean(r.needs_review),
    reconciled: Boolean(r.reconciled),
    confidence: r.confidence ?? null,
    classifiedLineCount: n(r.classified_line_count),
    unclassifiedNet: n(r.unclassified_net),
    paymentStatus: r.payment_status ?? null,
    paidDate: r.paid_date ? String(r.paid_date) : null,
    reviewQuestion: r.review_question ?? null,
    reviewQuestionAt: r.review_question_at ? new Date(r.review_question_at).toISOString() : null,
    reviewAnswer: r.review_answer ?? null,
    reviewAnswerAt: r.review_answer_at ? new Date(r.review_answer_at).toISOString() : null,
  }))
}

export type InvoiceLineItemRow = {
  id: number
  description: string
  quantity: number | null
  unit: string | null
  unitPriceExVat: number | null
  lineNet: number
  lineVat: number
  lineGross: number
  costPackageId: number | null
  costPackageName: string | null
  costPackageCode: string | null
  costType: string | null
}

/** All line items for a single invoice, ordered by id (i.e. document order). */
export async function getLineItemsForInvoice(invoiceId: number): Promise<InvoiceLineItemRow[]> {
  const rows = await db.execute(sql`
    SELECT li.id, li.description, li.quantity, li.unit, li.unit_price_ex_vat,
      li.line_net, li.line_vat, li.line_gross, li.cost_package_id, li.cost_type,
      cp.name AS cost_package_name, cp.code AS cost_package_code
    FROM invoice_line_items li
    LEFT JOIN cost_packages cp ON cp.id = li.cost_package_id
    WHERE li.invoice_id = ${invoiceId}
    ORDER BY li.id ASC
  `)
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    description: r.description,
    quantity: r.quantity == null ? null : n(r.quantity),
    unit: r.unit,
    unitPriceExVat: r.unit_price_ex_vat == null ? null : n(r.unit_price_ex_vat),
    lineNet: n(r.line_net),
    lineVat: n(r.line_vat),
    lineGross: n(r.line_gross),
    costPackageId: r.cost_package_id ?? null,
    costPackageName: r.cost_package_name ?? null,
    costPackageCode: r.cost_package_code ?? null,
    costType: r.cost_type ?? null,
  }))
}

export type PackageLineItemRow = {
  id: number
  description: string
  quantity: number | null
  unit: string | null
  lineNet: number
  costPackageId: number
  costPackageName: string | null
  costPackageCode: string | null
  supplierName: string
  invoiceId: number
  invoiceNumber: string | null
  invoiceDate: string | null
}

/**
 * Every confirmed invoice line item classified into one of the given cost
 * packages, with the supplier/invoice context needed to explain that spend
 * at a glance — feeds the funding-vs-actual line drill-down. Confirmed
 * invoices only, matching the actual-spend definition used by the funding
 * engine (see `getPackageSpend` in lib/funding/queries.ts). Sorted biggest
 * net first so the largest contributors surface first.
 */
export async function getLineItemsForCostPackages(costPackageIds: number[]): Promise<PackageLineItemRow[]> {
  if (costPackageIds.length === 0) return []
  const rows = await db.execute(sql`
    SELECT li.id, li.description, li.quantity, li.unit, li.line_net,
      li.cost_package_id, cp.name AS cost_package_name, cp.code AS cost_package_code,
      s.name AS supplier_name,
      inv.id AS invoice_id, inv.invoice_number, inv.invoice_date
    FROM invoice_line_items li
    JOIN invoices inv ON inv.id = li.invoice_id
    JOIN suppliers s ON s.id = inv.supplier_id
    LEFT JOIN cost_packages cp ON cp.id = li.cost_package_id
    WHERE li.cost_package_id IN ${costPackageIds} AND inv.status = 'confirmed'
    ORDER BY li.line_net DESC, li.id DESC
  `)
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    description: r.description,
    quantity: r.quantity == null ? null : n(r.quantity),
    unit: r.unit,
    lineNet: n(r.line_net),
    costPackageId: r.cost_package_id,
    costPackageName: r.cost_package_name ?? null,
    costPackageCode: r.cost_package_code ?? null,
    supplierName: r.supplier_name,
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date ? String(r.invoice_date) : null,
  }))
}

export type CostPackageOption = {
  id: number
  code: string | null
  name: string
}

/**
 * Lightweight cost-package picker options for a project — just the identity
 * fields, ordered by code. Slimmer than `getCostPackagesForProject` (which
 * additionally aggregates committed spend per package) because the inline
 * classification picker only ever needs id/code/name.
 */
export async function getCostPackageOptions(projectId: number): Promise<CostPackageOption[]> {
  const rows = await db.execute(sql`
    SELECT id, code, name
    FROM cost_packages
    WHERE project_id = ${projectId}
    ORDER BY code ASC NULLS LAST, id ASC
  `)
  return (rows.rows as any[]).map((r) => ({
    id: Number(r.id),
    code: r.code ?? null,
    name: r.name,
  }))
}

export type ReviewQueueLineItem = {
  id: number
  description: string
  quantity: number | null
  unit: string | null
  lineNet: number
  costPackageId: number | null
  costPackageCode: string | null
  costPackageName: string | null
}

export type ReviewQueueEntry = InvoiceRow & {
  lineItems: ReviewQueueLineItem[]
  /** This invoice's own project's cost-package options, for inline classification. Empty if unassigned. */
  costPackageOptions: CostPackageOption[]
}

export type ReviewQueueOptions = {
  /** Row offset into the needs_review ASC-by-date ordering. Omit for the first page. */
  cursor?: number
  limit?: number
}

/**
 * The review queue: every invoice with needs_review = true, oldest invoice
 * first, each carrying everything the queue UI needs to render and classify
 * it on one screen without further round trips — its line items (with any
 * existing cost-package classification) and its OWN project's cost-package
 * options. `projectId = null` returns the queue across all projects.
 *
 * Cost-package options are resolved per invoice's own project (never a
 * shared/global list) — classification stays scoped to the project the spend
 * actually belongs to, same rule as `getClassificationSuggestions`.
 *
 * Three queries total regardless of page size: the invoice page itself, then
 * one batched fetch each for line items and cost packages across that page's
 * invoice/project ids.
 */
export async function getReviewQueue(
  projectId: number | null,
  options: ReviewQueueOptions = {},
): Promise<ReviewQueueEntry[]> {
  const limit = options.limit ?? 20
  const offset = options.cursor ?? 0

  const projectCondition = projectId != null ? sql`AND inv.project_id = ${projectId}` : sql``

  const invoiceRows = await db.execute(sql`
    SELECT inv.id, inv.project_id, s.name AS supplier_name, p.name AS project_name,
      inv.invoice_number, inv.invoice_date, inv.transaction_type,
      inv.net, inv.vat, inv.gross, inv.status,
      inv.source_file_name, inv.source_file_pathname,
      inv.source_page_start, inv.source_page_end,
      inv.needs_review, inv.reconciled, inv.confidence,
      inv.payment_status, inv.paid_date,
      inv.review_question, inv.review_question_at, inv.review_answer, inv.review_answer_at,
      COALESCE(li.cnt, 0) AS line_item_count,
      COALESCE(li.classified_cnt, 0) AS classified_line_count,
      COALESCE(li.unclassified_net, 0) AS unclassified_net
    FROM invoices inv
    JOIN suppliers s ON s.id = inv.supplier_id
    LEFT JOIN projects p ON p.id = inv.project_id
    LEFT JOIN (
      SELECT invoice_id,
        COUNT(*) AS cnt,
        COUNT(*) FILTER (WHERE cost_package_id IS NOT NULL) AS classified_cnt,
        COALESCE(SUM(line_net) FILTER (WHERE cost_package_id IS NULL), 0) AS unclassified_net
      FROM invoice_line_items GROUP BY invoice_id
    ) li ON li.invoice_id = inv.id
    WHERE inv.needs_review = true ${projectCondition}
    ORDER BY inv.invoice_date ASC NULLS LAST, inv.id ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `)

  const rows = invoiceRows.rows as any[]
  if (rows.length === 0) return []

  const invoiceIds = rows.map((r) => Number(r.id))
  const projectIdsInPage = [...new Set(rows.map((r) => r.project_id).filter((v) => v != null).map(Number))]

  const [lineRows, packageRows] = await Promise.all([
    db.execute(sql`
      SELECT li.id, li.invoice_id, li.description, li.quantity, li.unit, li.line_net, li.cost_package_id,
        cp.code AS cost_package_code, cp.name AS cost_package_name
      FROM invoice_line_items li
      LEFT JOIN cost_packages cp ON cp.id = li.cost_package_id
      WHERE li.invoice_id IN ${invoiceIds}
      ORDER BY li.id ASC
    `),
    projectIdsInPage.length
      ? db.execute(sql`
          SELECT id, project_id, code, name FROM cost_packages
          WHERE project_id IN ${projectIdsInPage}
          ORDER BY code ASC NULLS LAST, id ASC
        `)
      : Promise.resolve({ rows: [] as any[] }),
  ])

  const linesByInvoice = new Map<number, ReviewQueueLineItem[]>()
  for (const r of lineRows.rows as any[]) {
    const list = linesByInvoice.get(Number(r.invoice_id)) ?? []
    list.push({
      id: r.id,
      description: r.description,
      quantity: r.quantity == null ? null : n(r.quantity),
      unit: r.unit,
      lineNet: n(r.line_net),
      costPackageId: r.cost_package_id ?? null,
      costPackageCode: r.cost_package_code ?? null,
      costPackageName: r.cost_package_name ?? null,
    })
    linesByInvoice.set(Number(r.invoice_id), list)
  }

  const packagesByProject = new Map<number, CostPackageOption[]>()
  for (const r of packageRows.rows as any[]) {
    const pid = Number(r.project_id)
    const list = packagesByProject.get(pid) ?? []
    list.push({ id: Number(r.id), code: r.code ?? null, name: r.name })
    packagesByProject.set(pid, list)
  }

  return rows.map((r) => ({
    id: r.id,
    supplierName: r.supplier_name,
    projectName: r.project_name,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date ? String(r.invoice_date) : null,
    transactionType: r.transaction_type,
    net: n(r.net),
    vat: n(r.vat),
    gross: n(r.gross),
    status: r.status,
    lineItemCount: n(r.line_item_count),
    sourceFileName: r.source_file_name ?? null,
    sourceFilePathname: r.source_file_pathname ?? null,
    sourcePageStart: r.source_page_start == null ? null : Number(r.source_page_start),
    sourcePageEnd: r.source_page_end == null ? null : Number(r.source_page_end),
    needsReview: Boolean(r.needs_review),
    reconciled: Boolean(r.reconciled),
    confidence: r.confidence ?? null,
    classifiedLineCount: n(r.classified_line_count),
    unclassifiedNet: n(r.unclassified_net),
    paymentStatus: r.payment_status ?? null,
    paidDate: r.paid_date ? String(r.paid_date) : null,
    reviewQuestion: r.review_question ?? null,
    reviewQuestionAt: r.review_question_at ? new Date(r.review_question_at).toISOString() : null,
    reviewAnswer: r.review_answer ?? null,
    reviewAnswerAt: r.review_answer_at ? new Date(r.review_answer_at).toISOString() : null,
    lineItems: linesByInvoice.get(Number(r.id)) ?? [],
    costPackageOptions: r.project_id == null ? [] : (packagesByProject.get(Number(r.project_id)) ?? []),
  }))
}

export type ClassificationSuggestion = {
  lineItemId: number
  suggestedCostPackageId: number
  packageCode: string | null
  packageName: string
  timesConfirmed: number
  /** which tier of the learned-mapping recall produced this suggestion. */
  source: "product" | "category"
}

type LearnedCandidate = {
  code: string | null
  name: string | null
  timesConfirmed: number
  supplierId: number | null
}

/**
 * Learned-mapping suggestions for a set of invoices' UNCLASSIFIED line items.
 * This is a read-only recall against `classification_mappings` — the exact
 * same table `commitInvoice` (app/actions/invoices.ts) writes to and the same
 * precedence the review flow uses (`loadLearnedMappings` /
 * `classifyLinesToPlan` in app/actions/enrichment.ts):
 *   1. a supplier-scoped PRODUCT key (normalised description) — preferred,
 *      and among several matches for the same key the supplier-specific row
 *      wins over the global one, then the higher `times_confirmed` wins;
 *   2. a global CATEGORY key, only when no product-level match exists.
 * Never calls AI and never guesses — a line with no matching mapping (or
 * whose learned package code/name doesn't resolve onto ITS OWN project's
 * actual cost packages) simply has no suggestion.
 */
export async function getClassificationSuggestions(invoiceIds: number[]): Promise<ClassificationSuggestion[]> {
  if (invoiceIds.length === 0) return []

  const lineRows = await db.execute(sql`
    SELECT li.id AS line_item_id, li.description, inv.supplier_id, inv.project_id,
      p.category AS product_category
    FROM invoice_line_items li
    JOIN invoices inv ON inv.id = li.invoice_id
    LEFT JOIN products p ON p.id = li.product_id
    WHERE li.invoice_id IN ${invoiceIds} AND li.cost_package_id IS NULL
  `)

  const lines = (lineRows.rows as any[])
    .map((r) => ({
      lineItemId: Number(r.line_item_id),
      key: normaliseDescriptionKey(r.description ?? ""),
      supplierId: r.supplier_id == null ? null : Number(r.supplier_id),
      projectId: r.project_id == null ? null : Number(r.project_id),
      categoryKey: (r.product_category ?? "").trim().toLowerCase(),
    }))
    // No project means no cost packages to resolve a suggestion onto — never
    // invent one (project assignment stays independent, but a concrete
    // suggestion needs a concrete project's package to point at).
    .filter((l): l is typeof l & { projectId: number } => l.projectId != null)

  if (lines.length === 0) return []

  const productKeys = [...new Set(lines.map((l) => l.key).filter(Boolean))]
  const categoryKeys = [...new Set(lines.map((l) => l.categoryKey).filter(Boolean))]
  const projectIds = [...new Set(lines.map((l) => l.projectId))]

  const [productRows, categoryRows, packageRows] = await Promise.all([
    productKeys.length
      ? db.execute(sql`
          SELECT key_value, supplier_id, cost_package_code, cost_package_name, times_confirmed
          FROM classification_mappings
          WHERE key_kind = 'product' AND key_value IN ${productKeys}
        `)
      : Promise.resolve({ rows: [] as any[] }),
    categoryKeys.length
      ? db.execute(sql`
          SELECT key_value, cost_package_code, cost_package_name, times_confirmed
          FROM classification_mappings
          WHERE key_kind = 'category' AND key_value IN ${categoryKeys} AND supplier_id IS NULL
        `)
      : Promise.resolve({ rows: [] as any[] }),
    db.execute(sql`
      SELECT id, project_id, code, name FROM cost_packages WHERE project_id IN ${projectIds}
    `),
  ])

  // Group product-level rows by key; the actual "best" row depends on each
  // LINE's own supplier, so the pick happens per line, not here.
  const productRowsByKey = new Map<string, LearnedCandidate[]>()
  for (const r of productRows.rows as any[]) {
    const key = r.key_value as string
    const list = productRowsByKey.get(key) ?? []
    list.push({
      code: r.cost_package_code,
      name: r.cost_package_name,
      timesConfirmed: Number(r.times_confirmed),
      supplierId: r.supplier_id == null ? null : Number(r.supplier_id),
    })
    productRowsByKey.set(key, list)
  }

  function bestProductMatch(key: string, supplierId: number | null): LearnedCandidate | null {
    const candidates = productRowsByKey.get(key)
    if (!candidates || candidates.length === 0) return null
    const supplierSpecific = candidates.filter((c) => c.supplierId != null && c.supplierId === supplierId)
    const pool = supplierSpecific.length > 0 ? supplierSpecific : candidates.filter((c) => c.supplierId == null)
    if (pool.length === 0) return null
    return pool.reduce((best, c) => (c.timesConfirmed > best.timesConfirmed ? c : best))
  }

  // Category mappings are always global (supplier_id IS NULL) — highest
  // times_confirmed wins per key.
  const categoryByKey = new Map<string, LearnedCandidate>()
  for (const r of categoryRows.rows as any[]) {
    const key = r.key_value as string
    const candidate: LearnedCandidate = {
      code: r.cost_package_code,
      name: r.cost_package_name,
      timesConfirmed: Number(r.times_confirmed),
      supplierId: null,
    }
    const existing = categoryByKey.get(key)
    if (!existing || candidate.timesConfirmed > existing.timesConfirmed) categoryByKey.set(key, candidate)
  }

  const packagesByProject = new Map<number, ProjectPackage[]>()
  for (const r of packageRows.rows as any[]) {
    const pid = Number(r.project_id)
    const list = packagesByProject.get(pid) ?? []
    list.push({ id: Number(r.id), code: r.code, name: r.name })
    packagesByProject.set(pid, list)
  }

  const suggestions: ClassificationSuggestion[] = []
  for (const line of lines) {
    const packages = packagesByProject.get(line.projectId) ?? []
    if (packages.length === 0) continue

    let match: LearnedCandidate | null = line.key ? bestProductMatch(line.key, line.supplierId) : null
    let source: "product" | "category" = "product"
    if (!match && line.categoryKey) {
      const cat = categoryByKey.get(line.categoryKey)
      if (cat) {
        match = cat
        source = "category"
      }
    }
    if (!match) continue

    // Resolve the canonical code/name onto THIS invoice's own project's
    // actual cost packages (code first, then exact name) — same resolution
    // rule used everywhere else (lib/cost-plan.ts). If it doesn't resolve,
    // there is genuinely no usable suggestion; never invent a package.
    const pkg = resolveProjectPackage(match.code, match.name, packages)
    if (!pkg) continue

    suggestions.push({
      lineItemId: line.lineItemId,
      suggestedCostPackageId: pkg.id,
      packageCode: pkg.code,
      packageName: pkg.name,
      timesConfirmed: match.timesConfirmed,
      source,
    })
  }

  return suggestions
}

/**
 * QUOTED VS ACTUAL (quotes layer)
 * ---------------------------------------------------------------------------
 * Per supplier (that has a quote and/or confirmed spend on this project):
 *   quotedTotal        SUM of quotes.net (falling back to gross only when net
 *                       is null) for status IN ('open','accepted') — 'superseded'
 *                       quotes are excluded so a stale revision never inflates
 *                       what's "still quoted". Never sums across revisions
 *                       of the same job — that de-duplication already happened
 *                       at ingestion (scripts/ingest-quotes-2026-08.mts), this
 *                       query just respects the status it wrote.
 *   actualNet           SUM of net on this project's CONFIRMED invoices for
 *                       that supplier. Credits are stored negative on
 *                       `invoices`, so a plain SUM already nets them down —
 *                       matches every other actual-spend query in this file.
 *   remainingVsQuote     quotedTotal - actualNet. May be NEGATIVE — that means
 *                       actual spend has already exceeded what was quoted;
 *                       this function reports that, it never hides it.
 *   unpaidCommitted     SUM of net on this project's CONFIRMED invoices for
 *                       that supplier where payment_status IN ('unpaid',
 *                       'part_paid') — committed spend not yet paid out.
 *
 * SUPPLIER MATCHING IS SUPPLIER_ID ONLY — NEVER BY NAME. A quote whose
 * supplier_id didn't resolve at ingestion (quote-only company, no existing
 * Gilbert OS supplier record) is grouped and shown on its own row keyed by
 * its verbatim supplier_name_raw, with actualNet/unpaidCommitted staying 0 —
 * it is NEVER fuzzy-matched against an invoice supplier's name to find
 * "actual" spend. Guessing that match would risk attributing one company's
 * real spend to a different company's quote (non-negotiable #1 and #3).
 *
 * Pure read — no DB writes, no mutation of inputs.
 */
export type QuoteVsActualSupplierRow = {
  supplierId: number | null
  supplierName: string
  quoteCount: number
  quotedTotal: number
  actualNet: number
  remainingVsQuote: number
  unpaidCommitted: number
}

export type QuoteDrillDownRow = {
  id: number
  supplierId: number | null
  supplierName: string
  reference: string | null
  quoteDate: string | null
  description: string | null
  scope: string | null
  net: number | null
  vat: number | null
  gross: number | null
  status: string | null
  notes: string | null
  sourceFilePathname: string | null
}

export type QuotesVsActual = {
  suppliers: QuoteVsActualSupplierRow[]
  quotes: QuoteDrillDownRow[]
}

export async function getQuotesVsActual(projectId: number): Promise<QuotesVsActual> {
  const supplierRows = await db.execute(sql`
    WITH quote_agg AS (
      SELECT
        COALESCE(q.supplier_id::text, 'raw:' || lower(btrim(coalesce(q.supplier_name_raw, '')))) AS group_key,
        q.supplier_id,
        MAX(q.supplier_name_raw) AS supplier_name_raw,
        -- Owner rule (2026-08-14): only ACCEPTED quotes count toward totals.
        COUNT(*) FILTER (WHERE q.status = 'accepted') AS quote_count,
        COALESCE(SUM(COALESCE(q.net, q.gross, 0)) FILTER (WHERE q.status = 'accepted'), 0) AS quoted_total
      FROM quotes q
      WHERE q.project_id = ${projectId}
      GROUP BY 1, 2
    ),
    invoice_agg AS (
      SELECT
        inv.supplier_id::text AS group_key,
        inv.supplier_id,
        COALESCE(SUM(inv.net), 0) AS actual_net,
        COALESCE(SUM(inv.net) FILTER (WHERE inv.payment_status IN ('unpaid', 'part_paid')), 0) AS unpaid_committed
      FROM invoices inv
      WHERE inv.project_id = ${projectId} AND inv.status = 'confirmed'
      GROUP BY 1, 2
    )
    SELECT
      COALESCE(qa.supplier_id, ia.supplier_id) AS supplier_id,
      COALESCE(s.name, qa.supplier_name_raw) AS supplier_name,
      COALESCE(qa.quote_count, 0) AS quote_count,
      COALESCE(qa.quoted_total, 0) AS quoted_total,
      COALESCE(ia.actual_net, 0) AS actual_net,
      COALESCE(qa.quoted_total, 0) - COALESCE(ia.actual_net, 0) AS remaining_vs_quote,
      COALESCE(ia.unpaid_committed, 0) AS unpaid_committed
    FROM quote_agg qa
    FULL OUTER JOIN invoice_agg ia ON ia.group_key = qa.group_key
    LEFT JOIN suppliers s ON s.id = COALESCE(qa.supplier_id, ia.supplier_id)
    ORDER BY quoted_total DESC, actual_net DESC
  `)

  const quoteRows = await db.execute(sql`
    SELECT q.id, q.supplier_id, COALESCE(s.name, q.supplier_name_raw) AS supplier_name,
      q.reference, q.quote_date, q.description, q.scope, q.net, q.vat, q.gross, q.status, q.notes,
      q.source_file_pathname
    FROM quotes q
    LEFT JOIN suppliers s ON s.id = q.supplier_id
    WHERE q.project_id = ${projectId}
    ORDER BY supplier_name ASC, q.quote_date ASC NULLS LAST, q.id ASC
  `)

  return {
    suppliers: (supplierRows.rows as any[]).map((r) => ({
      supplierId: r.supplier_id == null ? null : Number(r.supplier_id),
      supplierName: r.supplier_name ?? "(unknown supplier)",
      quoteCount: n(r.quote_count),
      quotedTotal: n(r.quoted_total),
      actualNet: n(r.actual_net),
      remainingVsQuote: n(r.remaining_vs_quote),
      unpaidCommitted: n(r.unpaid_committed),
    })),
    quotes: (quoteRows.rows as any[]).map((r) => ({
      id: Number(r.id),
      supplierId: r.supplier_id == null ? null : Number(r.supplier_id),
      supplierName: r.supplier_name ?? "(unknown supplier)",
      reference: r.reference ?? null,
      quoteDate: r.quote_date ? String(r.quote_date) : null,
      description: r.description ?? null,
      scope: r.scope ?? null,
      net: r.net == null ? null : n(r.net),
      vat: r.vat == null ? null : n(r.vat),
      gross: r.gross == null ? null : n(r.gross),
      status: r.status ?? null,
      notes: r.notes ?? null,
      sourceFilePathname: r.source_file_pathname ?? null,
    })),
  }
}
