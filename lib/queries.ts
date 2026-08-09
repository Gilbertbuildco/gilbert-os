import "server-only"
import { db } from "@/lib/db"
import { sql } from "drizzle-orm"

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
}

export async function getInvoices(): Promise<InvoiceRow[]> {
  const rows = await db.execute(sql`
    SELECT inv.id, s.name AS supplier_name, p.name AS project_name,
      inv.invoice_number, inv.invoice_date, inv.transaction_type,
      inv.net, inv.vat, inv.gross, inv.status,
      inv.source_file_name, inv.source_file_pathname,
      inv.source_page_start, inv.source_page_end,
      COALESCE(li.cnt, 0) AS line_item_count
    FROM invoices inv
    JOIN suppliers s ON s.id = inv.supplier_id
    LEFT JOIN projects p ON p.id = inv.project_id
    LEFT JOIN (
      SELECT invoice_id, COUNT(*) AS cnt FROM invoice_line_items GROUP BY invoice_id
    ) li ON li.invoice_id = inv.id
    ORDER BY inv.invoice_date DESC NULLS LAST, inv.created_at DESC
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

export async function getProjectOptions() {
  const rows = await db.execute(sql`SELECT id, name, slug FROM projects ORDER BY name ASC`)
  return (rows.rows as any[]).map((r) => ({ id: r.id as number, name: r.name as string, slug: r.slug as string }))
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
      COALESCE(li.cnt, 0) AS line_item_count
    FROM invoices inv
    JOIN suppliers s ON s.id = inv.supplier_id
    LEFT JOIN projects p ON p.id = inv.project_id
    LEFT JOIN (SELECT invoice_id, COUNT(*) AS cnt FROM invoice_line_items GROUP BY invoice_id) li ON li.invoice_id = inv.id
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
  }))
  }


