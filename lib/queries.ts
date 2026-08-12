import "server-only"
import { db } from "@/lib/db"
import { sql, type SQL } from "drizzle-orm"

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
  spendToDate: number
  invoiceCount: number
}

export async function getProjects(): Promise<ProjectRow[]> {
  const rows = await db.execute(sql`
    SELECT p.*,
      COALESCE(s.spend, 0) AS spend_to_date,
      COALESCE(s.cnt, 0)   AS invoice_count
    FROM projects p
    LEFT JOIN (
      SELECT project_id, SUM(net) AS spend, COUNT(*) AS cnt
      FROM invoices
      WHERE status = 'confirmed'
      GROUP BY project_id
    ) s ON s.project_id = p.id
    ORDER BY p.created_at ASC
  `)
  return (rows.rows as any[]).map(mapProject)
}

export async function getProjectBySlug(slug: string): Promise<ProjectRow | null> {
  const rows = await db.execute(sql`
    SELECT p.*,
      COALESCE(s.spend, 0) AS spend_to_date,
      COALESCE(s.cnt, 0)   AS invoice_count
    FROM projects p
    LEFT JOIN (
      SELECT project_id, SUM(net) AS spend, COUNT(*) AS cnt
      FROM invoices WHERE status = 'confirmed' GROUP BY project_id
    ) s ON s.project_id = p.id
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
}

export async function getCostPackagesForProject(projectId: number): Promise<CostPackageRow[]> {
  const rows = await db.execute(sql`
    SELECT cp.id, cp.code, cp.name, cp.original_budget,
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
  }))
}

export type InvoiceSummary = {
  count: number
  totalNet: number
  totalVat: number
  totalGross: number
  needsReviewCount: number
  unclassifiedNet: number
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
      COALESCE(SUM(inv.gross) FILTER (WHERE inv.payment_status = 'paid'), 0) AS paid_gross,
      COALESCE(SUM(inv.gross) FILTER (WHERE inv.payment_status IN ('unpaid', 'part_paid')), 0) AS outstanding_gross,
      COALESCE(SUM(inv.gross) FILTER (WHERE inv.payment_status IS NULL), 0) AS unrecorded_gross
    FROM invoices inv
    JOIN suppliers s ON s.id = inv.supplier_id
    LEFT JOIN projects p ON p.id = inv.project_id
    LEFT JOIN (
      SELECT invoice_id,
        COALESCE(SUM(line_net) FILTER (WHERE cost_package_id IS NULL), 0) AS unclassified_net
      FROM invoice_line_items GROUP BY invoice_id
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
    paidGross: n(r.paid_gross),
    outstandingGross: n(r.outstanding_gross),
    unrecordedGross: n(r.unrecorded_gross),
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
  totalSpend: number
  invoiceCount: number
  productCount: number
  supplierCount: number
}

export async function getPortfolioStats(): Promise<PortfolioStats> {
  const rows = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM projects) AS project_count,
      (SELECT COUNT(*) FROM projects WHERE status IN ('On Site','In Progress','Active')) AS active_projects,
      (SELECT COALESCE(SUM(net),0) FROM invoices WHERE status = 'confirmed') AS total_spend,
      (SELECT COUNT(*) FROM invoices WHERE status = 'confirmed') AS invoice_count,
      (SELECT COUNT(*) FROM products) AS product_count,
      (SELECT COUNT(*) FROM suppliers) AS supplier_count
  `)
  const r = (rows.rows as any[])[0]
  return {
    projectCount: n(r.project_count),
    activeProjects: n(r.active_projects),
    totalSpend: n(r.total_spend),
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
