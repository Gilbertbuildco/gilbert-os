import {
  serial,
  integer,
  text,
  numeric,
  date,
  timestamp,
  pgTable,
} from "drizzle-orm/pg-core"

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  location: text("location"),
  status: text("status").notNull().default("Planning"),
  homes: integer("homes"),
  buildAreaSqft: integer("build_area_sqft"),
  originalBuildBudget: numeric("original_build_budget"),
  developmentFacility: numeric("development_facility"),
  remainingDrawdown: numeric("remaining_drawdown"),
  expectedGdv: numeric("expected_gdv"),
  landPrice: numeric("land_price"),
  buildCostPerSqft: numeric("build_cost_per_sqft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const suppliers = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  contact: text("contact"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"),
  manufacturer: text("manufacturer"),
  unit: text("unit"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const supplierProducts = pgTable("supplier_products", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull(),
  supplierId: integer("supplier_id").notNull(),
  supplierProductCode: text("supplier_product_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  supplierId: integer("supplier_id").notNull(),
  projectId: integer("project_id"),
  invoiceNumber: text("invoice_number"),
  invoiceDate: date("invoice_date"),
  transactionType: text("transaction_type").notNull().default("invoice"),
  net: numeric("net").notNull().default("0"),
  vat: numeric("vat").notNull().default("0"),
  gross: numeric("gross").notNull().default("0"),
  status: text("status").notNull().default("confirmed"),
  sourceFileName: text("source_file_name"),
  sourceFilePathname: text("source_file_pathname"),
  // SHA-256 checksum of the original uploaded file. Used only as a secondary
  // duplicate signal — never as the sole identity (the same invoice may be
  // rescanned or re-combined into a different PDF, changing the hash).
  sourceFileHash: text("source_file_hash"),
  // 1-based inclusive page range this invoice occupies within its source file.
  // Null means "unknown" (fall back to showing the whole document).
  sourcePageStart: integer("source_page_start"),
  sourcePageEnd: integer("source_page_end"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const costPackages = pgTable("cost_packages", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  code: text("code"),
  name: text("name").notNull(),
  originalBudget: numeric("original_budget"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const invoiceLineItems = pgTable("invoice_line_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull(),
  productId: integer("product_id"),
  costPackageId: integer("cost_package_id"),
  description: text("description").notNull(),
  quantity: numeric("quantity"),
  unit: text("unit"),
  unitPriceExVat: numeric("unit_price_ex_vat"),
  lineNet: numeric("line_net").notNull().default("0"),
  lineVat: numeric("line_vat").notNull().default("0"),
  lineGross: numeric("line_gross").notNull().default("0"),
  vatRate: numeric("vat_rate"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const priceRecords = pgTable("price_records", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull(),
  supplierId: integer("supplier_id").notNull(),
  projectId: integer("project_id"),
  invoiceId: integer("invoice_id"),
  invoiceLineItemId: integer("invoice_line_item_id"),
  priceExVat: numeric("price_ex_vat").notNull(),
  vatAmount: numeric("vat_amount"),
  priceIncVat: numeric("price_inc_vat"),
  vatRate: numeric("vat_rate"),
  unit: text("unit"),
  invoiceDate: date("invoice_date"),
  invoiceNumber: text("invoice_number"),
  transactionType: text("transaction_type").notNull().default("invoice"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const variations = pgTable("variations", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  amount: numeric("amount"),
  status: text("status").notNull().default("proposed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type Project = typeof projects.$inferSelect
export type Supplier = typeof suppliers.$inferSelect
export type Product = typeof products.$inferSelect
export type Invoice = typeof invoices.$inferSelect
export type CostPackage = typeof costPackages.$inferSelect
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect
export type PriceRecord = typeof priceRecords.$inferSelect
export type Variation = typeof variations.$inferSelect
