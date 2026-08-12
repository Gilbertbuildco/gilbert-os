import {
  serial,
  integer,
  text,
  numeric,
  date,
  timestamp,
  boolean,
  jsonb,
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
  // Structured normalisation of the merchant description. Populated best-effort
  // by the enrichment pass so differently-worded descriptions for the same
  // physical product can later be recognised and price-compared across merchants.
  normalisedName: text("normalised_name"),
  productFamily: text("product_family"),
  productType: text("product_type"),
  dimensions: text("dimensions"),
  thickness: text("thickness"),
  subcategory: text("subcategory"),
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
  // Audit-grade fields. `extractionRaw` retains the original AI extraction for
  // this document so a manually-corrected value can always be compared against
  // what the model first read. `confidence` is the model's self-reported
  // extraction confidence (high/medium/low). `reconciled` records whether the
  // line/total arithmetic checked out; `needsReview` is set when it did not or
  // when required fields were missing at commit time.
  extractionRaw: jsonb("extraction_raw"),
  confidence: text("confidence"),
  // For a credit note, the invoice it relates to where that link is confident.
  creditOfInvoiceId: integer("credit_of_invoice_id"),
  needsReview: boolean("needs_review").notNull().default(false),
  reconciled: boolean("reconciled").notNull().default(true),
  // Payment tracking (cash flow), independent of extraction/reconciliation.
  // NULL means "not recorded" — the true state of every invoice ingested before
  // this field existed, and of any new one until someone records it. Never
  // backfilled to 'unpaid' as if that were known fact (non-negotiable #1).
  // Allowed values 'unpaid' | 'paid' | 'part_paid' are enforced in application
  // code (app/actions/invoices.ts), not a DB constraint, matching repo convention.
  paymentStatus: text("payment_status"),
  paidDate: date("paid_date"),
  paymentNotes: text("payment_notes"),
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
  // `description` is the exact merchant text (immutable audit reference).
  // `rawDescription` mirrors it explicitly for clarity; the normalised identity
  // lives on the linked product row.
  description: text("description").notNull(),
  rawDescription: text("raw_description"),
  quantity: numeric("quantity"),
  // `unit` keeps the exact raw merchant unit (e.g. "SH"); `normalisedUnit` is
  // the Gilbert OS canonical unit (e.g. "sheet"). Normalisation NEVER changes
  // quantity, unit price or any financial total.
  unit: text("unit"),
  rawUnit: text("raw_unit"),
  normalisedUnit: text("normalised_unit"),
  unitPriceExVat: numeric("unit_price_ex_vat"),
  lineNet: numeric("line_net").notNull().default("0"),
  lineVat: numeric("line_vat").notNull().default("0"),
  lineGross: numeric("line_gross").notNull().default("0"),
  vatRate: numeric("vat_rate"),
  // Whether this line was added to the procurement price database. Delivery,
  // carriage, discounts, labour etc. are excluded so the pricing DB stays clean.
  isPriceTracked: boolean("is_price_tracked").notNull().default(true),
  // Cost Type dimension for actual costs (Phase 2A):
  // 'materials' | 'plant_hire' | 'subcontract' | 'other' | 'professional_fees'.
  // Own direct labour is NOT ingested through this invoice workflow, but the
  // column can hold 'labour' in future for full economic-cost reporting without
  // migrating or corrupting historic invoice data. NULL = not yet classified.
  costType: text("cost_type"),
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
  normalisedUnit: text("normalised_unit"),
  invoiceDate: date("invoice_date"),
  invoiceNumber: text("invoice_number"),
  transactionType: text("transaction_type").notNull().default("invoice"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Learned supplier aliases. When a new invoice heading resolves (by fuzzy
 * match) to an existing supplier, the normalised heading is recorded here so
 * the same heading is matched instantly next time and Gilbert OS never creates
 * near-duplicate supplier records from cosmetic name differences.
 */
export const supplierAliases = pgTable("supplier_aliases", {
  id: serial("id").primaryKey(),
  supplierId: integer("supplier_id").notNull(),
  normalisedName: text("normalised_name").notNull(),
  rawName: text("raw_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Learned classification mappings — the memory that makes review-by-exception
 * get easier over time. When a user confirms that a product / normalised
 * description / supplier SKU belongs to a given cost package (stored by package
 * CODE + NAME so it reapplies across projects), category, unit and price-track
 * decision, it is recorded here and reused on the next matching line.
 */
export const classificationMappings = pgTable("classification_mappings", {
  id: serial("id").primaryKey(),
  keyKind: text("key_kind").notNull(), // 'product' | 'description' | 'sku'
  keyValue: text("key_value").notNull(), // normalised key
  supplierId: integer("supplier_id"),
  productId: integer("product_id"),
  costPackageCode: text("cost_package_code"),
  costPackageName: text("cost_package_name"),
  category: text("category"),
  normalisedUnit: text("normalised_unit"),
  trackAsProduct: boolean("track_as_product"),
  timesConfirmed: integer("times_confirmed").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * FUNDING BUDGET (Phase 2A)
 * ---------------------------------------------------------------------------
 * A lender's agreed funding schedule for a project (e.g. Higher Farm's
 * Goldentree Funding Budget). This is DELIBERATELY separate from Gilbert OS's
 * internal cost packages and from actual invoice spend:
 *
 *   Funding budget = what the lender agreed to release against completed work.
 *   Actual cost    = what Gilbert Build Co actually spends delivering it.
 *
 * The ORIGINAL amounts here are immutable for reporting/audit. Actual invoices
 * must NEVER overwrite or adjust them. A favourable variance (spending below
 * the allowance) is NOT automatically profit — for Higher Farm much of it is
 * intentional headroom created by self-performed labour.
 */
export const fundingBudgets = pgTable("funding_budgets", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  name: text("name").notNull(),
  lender: text("lender"),
  // 'original_locked' | 'revised' | 'draft'. The original baseline is locked
  // and its line amounts must never be silently changed.
  status: text("status").notNull().default("original_locked"),
  // Permanently marks the original funding baseline for a project so it stays
  // identifiable even after revised budgets are added later.
  isOriginal: boolean("is_original").notNull().default(true),
  // Control totals as supplied by the lender schedule. Kept distinct so line
  // data can be validated against them without ever being altered to fit.
  worksTotal: numeric("works_total"),
  professionalFeesTotal: numeric("professional_fees_total"),
  originalTotal: numeric("original_total"),
  // The rounded "amount to borrow" — kept distinct from originalTotal on
  // purpose (£1,124,595.00 vs £1,124,594.95 for Higher Farm).
  amountToBorrow: numeric("amount_to_borrow"),
  // Set true once the imported line data reconciles to the control totals.
  // Never force this true by altering values — flag the discrepancy instead.
  reconciled: boolean("reconciled").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * An individual line of the lender's funding schedule, stored EXACTLY as
 * supplied. Descriptions are preserved verbatim and lines are never merged just
 * because Gilbert OS uses broader operational packages — the underlying lender
 * allowances must remain individually available.
 */
export const fundingBudgetLines = pgTable("funding_budget_lines", {
  id: serial("id").primaryKey(),
  fundingBudgetId: integer("funding_budget_id").notNull(),
  // 'works' | 'professional_fees' — which control total this line rolls into.
  section: text("section").notNull().default("works"),
  // Original lender description, immutable audit reference.
  description: text("description").notNull(),
  // Original lender allowance for this line, immutable.
  originalAmount: numeric("original_amount").notNull().default("0"),
  // Optional convenience hint to the standard cost-plan code; the authoritative
  // mapping lives in funding_line_package_map (many-to-many).
  costPackageCode: text("cost_package_code"),
  // Manual forecast cost-to-complete for this line (structure ready; the engine
  // falls back to actual-spend-only when null). Never affects originalAmount.
  forecastToComplete: numeric("forecast_to_complete"),
  notes: text("notes"),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Many-to-many mapping between a lender funding line and Gilbert OS cost
 * packages.
 *
 * CORE ARCHITECTURE RULE (governs ALL funding-budget mappings):
 * One Goldentree funding line may relate to MULTIPLE Gilbert OS cost packages
 * WITHOUT ever splitting the lender allowance itself. Gilbert OS does NOT
 * rewrite the lender's historical cost plan to match our internal packages. The
 * funding line's `originalAmount` is preserved exactly as submitted; actual
 * Gilbert OS costs from the mapped packages simply ROLL UP against it. The
 * reported comparison is always:
 *   Original allowance  vs  Actual attributable spend to date  →  headroom,
 *   plus forecast final cost and forecast variance against the allowance.
 *
 * `weight` optionally apportions a PACKAGE's actual spend across the lines it
 * maps to; it NEVER touches an allowance. When a package is shared across lines
 * and there is no defensible basis to divide its actuals, DEFER that mapping
 * (leave it out, note it on the line) rather than invent a split — the detailed
 * breakdown arrives naturally through actual costs as work progresses, and
 * double counting is avoided.
 */
export const fundingLinePackageMap = pgTable("funding_line_package_map", {
  id: serial("id").primaryKey(),
  fundingBudgetLineId: integer("funding_budget_line_id").notNull(),
  costPackageId: integer("cost_package_id").notNull(),
  weight: numeric("weight"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Per-line, per-funding-line drawdown / funding position. Structure only in
 * Phase 2A — funding entitlement is driven by completion against the lender
 * allowance, NOT by actual spend, so these are captured independently and left
 * for the drawdown-intelligence phase to populate.
 */
export const fundingDrawdowns = pgTable("funding_drawdowns", {
  id: serial("id").primaryKey(),
  fundingBudgetLineId: integer("funding_budget_line_id").notNull(),
  // Work completion 0..100 (%). Drives funding earned against the allowance.
  workCompletePct: numeric("work_complete_pct"),
  fundingEarned: numeric("funding_earned"),
  fundingCertified: numeric("funding_certified"),
  fundingDrawn: numeric("funding_drawn"),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

/**
 * XERO INTEGRATION
 * ---------------------------------------------------------------------------
 * Phase 1 added these tables (structure only, dry-run mapping layer,
 * `lib/xero/mapping.ts` — pure, never touches the DB). Phase 2 (OAuth
 * connection layer, `lib/xero/oauth.ts` / `lib/xero/client.ts`) extends
 * `xeroConnections` with the columns a real token lifecycle needs, and adds
 * `xeroOauthState` for the PKCE/CSRF handshake. As with every other table
 * here, there is no DB-level foreign key — references are validated in
 * application code. This has been run against production — all four tables
 * below exist live and were verified to match this Drizzle definition
 * exactly. Any further column/table addition is a NEW additive statement
 * appended to `scripts/migrate-xero.mjs`, never an edit to one already run.
 */

/**
 * OAuth token storage for a connected Xero organisation.
 *
 * `refreshToken` (plaintext) is the original Phase 1 column and is
 * deprecated/unused as of Phase 2 — nothing writes to it anymore.
 * `refreshTokenEncrypted` holds the AES-256-GCM ciphertext
 * (`lib/xero/crypto.ts`) and is the only place a refresh token is ever
 * persisted from Phase 2 onward. `accessToken` is ALSO encrypted (under its own
 * HKDF-derived key) — a plaintext access token is a live write-capable bearer
 * credential, and the security pass found it could reach a public error page
 * via Drizzle embedding query params in error messages. Any legacy plaintext
 * value still reads correctly and is re-encrypted on the next refresh, so no
 * migration was needed.
 */
export const xeroConnections = pgTable("xero_connections", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  tenantName: text("tenant_name"),
  accessToken: text("access_token"),
  /** @deprecated Phase 1 plaintext column, unused from Phase 2 onward. Never write to this. */
  refreshToken: text("refresh_token"),
  /** AES-256-GCM ciphertext (`lib/xero/crypto.ts`), keyed from `XERO_TOKEN_ENCRYPTION_KEY`. The only refresh-token storage Phase 2 writes to. */
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  scopes: text("scopes"),
  /** When this tenant was first authorised. Set once, never overwritten by a later refresh. */
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  /** When the token pair was last successfully rotated/refreshed. */
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  /** Set when a refresh-token persist fails after retries (see `refreshConnection` in `lib/xero/oauth.ts`) — signals a possibly-orphaned connection. Cleared on the next successful refresh. */
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Pending Xero OAuth authorisation attempts. One row per `/api/xero/connect`
 * click, keyed by the random `nonce` embedded in the signed `state` query
 * param. The callback redeems a row exactly once (atomic
 * `UPDATE ... WHERE consumed_at IS NULL`), which is what makes `state`
 * single-use rather than just signed. Rows older than `expiresAt` are
 * useless but not automatically purged yet — a future cleanup job, not a
 * correctness requirement (the callback already rejects expired rows).
 */
export const xeroOauthState = pgTable("xero_oauth_state", {
  nonce: text("nonce").primaryKey(),
  /** AES-256-GCM ciphertext of the PKCE code_verifier (`lib/xero/crypto.ts`, `OAUTH_VERIFIER_PURPOSE`). */
  codeVerifierEncrypted: text("code_verifier_encrypted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
})

/** Per-invoice push state once Gilbert OS actually starts sending bills to Xero. Structure only — empty until Phase 2. */
export const xeroSyncState = pgTable("xero_sync_state", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull(),
  xeroInvoiceId: text("xero_invoice_id"),
  xeroContactId: text("xero_contact_id"),
  // 'pending' | 'pushed' | 'error'
  status: text("status").notNull().default("pending"),
  lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Cost package -> Xero chart-of-accounts code. Owner-populated only — starts
 * empty. `lib/xero/mapping.ts` treats a missing entry here as a
 * `missing_account_code` gap and never invents a code to fill it.
 */
export const xeroAccountMap = pgTable("xero_account_map", {
  id: serial("id").primaryKey(),
  costPackageId: integer("cost_package_id").notNull(),
  xeroAccountCode: text("xero_account_code").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type Project = typeof projects.$inferSelect
export type Supplier = typeof suppliers.$inferSelect
export type Product = typeof products.$inferSelect
export type Invoice = typeof invoices.$inferSelect
export type CostPackage = typeof costPackages.$inferSelect
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect
export type PriceRecord = typeof priceRecords.$inferSelect
export type Variation = typeof variations.$inferSelect
export type SupplierAlias = typeof supplierAliases.$inferSelect
export type ClassificationMapping = typeof classificationMappings.$inferSelect
export type FundingBudget = typeof fundingBudgets.$inferSelect
export type FundingBudgetLine = typeof fundingBudgetLines.$inferSelect
export type FundingLinePackageMap = typeof fundingLinePackageMap.$inferSelect
export type FundingDrawdown = typeof fundingDrawdowns.$inferSelect
export type XeroConnection = typeof xeroConnections.$inferSelect
export type XeroSyncState = typeof xeroSyncState.$inferSelect
export type XeroAccountMap = typeof xeroAccountMap.$inferSelect
export type XeroOauthState = typeof xeroOauthState.$inferSelect
