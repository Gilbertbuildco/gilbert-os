# GILBERT OS — Project Handover / Migration Pack

> Single definitive handover for continuing Gilbert OS in Cursor (or any IDE/agent)
> from the exact current state, with no loss of functionality or business logic.
> A companion machine-readable file lives at `gilbert-os-handover.json`.
>
> **Golden rule for whoever continues this project:** read this whole document,
> then read **Section 22 (Business Rules / Non-Negotiables)** before writing any
> code that touches money, invoices, or the Goldentree funding budget.

---

## 1. PROJECT OVERVIEW

**Gilbert OS** is a construction cost-intelligence platform for **Gilbert Build Co**,
a UK residential developer/builder. Its commercial purpose is to turn the messy
reality of supplier invoices into **trustworthy, structured cost intelligence** so
the business can control build costs, compare against lender funding, and (over
time) benchmark prices and appraise new land.

The defining workflow is **AI-assisted invoice ingestion with review-by-exception**:
the operator uploads supplier invoice PDFs/images (individually or in bulk), an AI
vision model reads them, and Gilbert OS normalises, classifies, de-duplicates and
reconciles each document. The human only intervenes on the exceptions. Everything
learned from a confirmation makes the next upload easier.

**Major functional areas already built:**

- **Dashboard** (`app/page.tsx`) — portfolio-level metrics (projects, spend, etc.).
- **Projects** (`app/projects`, `app/projects/[slug]`, `app/projects/new`) — create
  projects, seed the standard cost plan, view project detail.
- **Commercial** (`app/commercial`, `components/commercial-view.tsx`) — cost packages
  vs actual spend; the home of funding-budget commercial reporting.
- **Procurement** (`app/procurement`, `components/procurement-view.tsx`) — the price
  database derived from invoice lines (products, suppliers, historical prices).
- **Invoices** (`app/invoices`, `app/invoices/new`, `components/invoice-uploader.tsx`)
  — the full upload → extract → review → commit pipeline, plus the invoice list and
  document viewer.
- **Suppliers** (`app/suppliers`) — supplier records and learned aliases.
- **Land Appraisal** (`app/land-appraisal`, `components/appraisal-calculator.tsx`) —
  a residual land-value / appraisal calculator (currently a standalone calculator).
- **Funding Budget / Goldentree cost control** (`lib/funding/*`, `funding_*` tables)
  — the immutable lender funding schedule and the engine that rolls actual costs up
  against it. See Sections 19 and 22.

---

## 2. TECH STACK

Exact versions from `package.json` (npm, `package-lock.json` committed).

| Concern | Choice | Version |
| --- | --- | --- |
| Framework | Next.js (App Router, Turbopack default) | `^16.0.0` |
| UI runtime | React / React DOM | `^19.2.0` |
| Language | TypeScript | `^5.6.0` |
| Node types | `@types/node` (⇒ target Node) | `^22` (use Node 22 LTS) |
| Styling | Tailwind CSS v4 (`@tailwindcss/postcss`, **no `tailwind.config`** — theme in `app/globals.css`) | `^4.0.0` |
| Icons | `lucide-react` | `^0.460.0` |
| Class utils | `clsx`, `tailwind-merge` | `^2.1.1`, `^2.5.4` |
| Database | Neon Postgres (serverless Postgres) | — |
| DB driver | `pg` (node-postgres) | `^8.23.0` |
| ORM / schema | `drizzle-orm` (schema + typed queries; **no drizzle-kit**, migrations are raw idempotent scripts) | `^0.45.2` |
| AI SDK | `ai` (Vercel AI SDK) via **Vercel AI Gateway** | `^7.0.58` |
| AI models | `google/gemini-2.5-flash`, `google/gemini-2.5-flash-lite` (fallback order) | — |
| File storage | `@vercel/blob` | `^2.7.0` |
| PDF split/slice | `pdf-lib` | `^1.17.1` |
| PDF render (viewer) | `pdfjs-dist`, `react-pdf` | `4.8.69`, `^9.2.1` |
| Validation | `zod` (AI structured output + input) | `^4.4.3` |
| Deployment | Vercel | — |

`scripts`: `dev` = `next dev`, `build` = `next build`, `start` = `next start`,
`lint` = `next lint`. There is **no test runner dependency**; verification scripts
run via `tsx`/`node` (see Section 25).

---

## 3. REPOSITORY STRUCTURE

```
app/
  layout.tsx                     Root layout, fonts, metadata
  page.tsx                       Dashboard
  globals.css                    Tailwind v4 theme tokens (no tailwind.config)
  actions/
    invoices.ts                  ★ Invoice COMMIT/save, duplicate re-check, price-record
                                   derivation, classification LEARNING writes, deleteInvoice
    enrichment.ts                ★ Tiered COST-PACKAGE CLASSIFICATION (canonical + learned +
                                   AI), batch preparation, project matching orchestration
    projects.ts                  Create project, SEED standard cost plan, set/add package,
                                   reassign line item to package
    funding.ts                   Funding budget server actions (create, load schedule, map
                                   packages, rollups) — see lib/funding
    lookups.ts                   Lightweight dropdown/search lookups
  api/
    extract-invoice/route.ts     ★ Upload endpoint → calls lib/invoice-extraction (maxDuration 300)
  commercial/page.tsx            Commercial area
  procurement/page.tsx           Procurement / price DB
  invoices/page.tsx              Invoice list
  invoices/new/page.tsx          Upload + review screen (renders invoice-uploader)
  suppliers/page.tsx             Suppliers
  land-appraisal/page.tsx        Land appraisal calculator
  projects/page.tsx              Projects list
  projects/[slug]/page.tsx       Project detail
  projects/new/page.tsx          Create project

components/
  invoice-uploader.tsx           ★ BATCH UPLOAD QUEUE UI, review-by-exception, per-line
                                   classification review, project/supplier controls
  invoice-document-viewer.tsx    PDF/image viewer (react-pdf) with page-range focus
  invoice-view-cell.tsx          Invoice list cell / source link
  commercial-view.tsx            Commercial dashboard view
  procurement-view.tsx           Procurement / price DB view
  project-detail.tsx             Project detail view
  create-project-form.tsx        New-project form
  appraisal-calculator.tsx       Land appraisal calculator
  data-table.tsx, metric-card.tsx, page-header.tsx, sidebar.tsx,
  status-badge.tsx, empty-state.tsx                Shared UI primitives
  upload/
    batch-progress.tsx           Bulk progress bar / phase display
    batch-summary.tsx            Post-run summary (ready / duplicate / failed)
    duplicate-notice.tsx         Duplicate verdict banner
    types.ts                     Uploader/draft types

lib/
  db/
    index.ts                     Drizzle client over a pooled pg Pool (reads DATABASE_URL)
    schema.ts                    ★ SINGLE SOURCE OF TRUTH for all tables + inferred types
  cost-plan.ts                   ★ STANDARD_COST_PLAN (21 packages) + material/trade
                                   detectors (insulation/tiling/roads) + resolveProjectPackage
  invoice-extraction.ts          ★ PDF/IMAGE EXTRACTION, multi-doc detection, page ranges,
                                   LARGE-PDF CHUNKING + merge, Blob retention, error classify
  invoice-enrichment.ts          ★ AI product normalisation + AI cost-package suggestion
  invoice-identity.ts            Supplier-name / doc-number normalisation, amountsClose
  invoice-validation.ts          Arithmetic reconciliation helpers
  duplicate-detection.ts         ★ DUPLICATE DETECTION verdicts (new/possible/already)
  project-matching.ts            ★ PROJECT MATCHING (confidence-based, single-active default)
  supplier-matching.ts           SUPPLIER MATCHING (fuzzy → alias learning)
  extraction-queue.ts            ★ CLIENT BULK QUEUE / RATE CONTROL (concurrency, spacing,
                                   global 429 pause, per-item backoff, sticky success)
  rate-governor.ts               ★ SERVER-SIDE RATE GOVERNOR (single-flight + min spacing +
                                   global pause-on-429) shared by all model calls
  normalisation/
    products.ts                  normaliseDescriptionKey + product normalisation
    units.ts                     Unit normalisation (canonical Gilbert OS units)
  funding/
    calculations.ts              ★ PURE COMMERCIAL ENGINE (variance/forecast/drawdown/
                                   reconciliation) — no DB imports, unit-testable
    queries.ts                   ★ FUNDING QUERIES — assemble engine inputs from live data
    cost-types.ts                Cost-type constants (materials/plant/subcontract/…)
  queries.ts                     General dashboard/portfolio queries
  utils.ts                       cn() etc.

scripts/                         Idempotent migrations + data loaders + tests (Section 5)
next.config.mjs                  serverActions bodySizeLimit 15mb + security headers
AGENTS.md / CLAUDE.md            Next.js 16 agent rules (auto-generated by `next dev`)
```

★ = the files most central to business logic.

**Where specific concerns live (quick index):**

| Concern | File |
| --- | --- |
| Invoice extraction | `lib/invoice-extraction.ts` + `app/api/extract-invoice/route.ts` |
| AI enrichment | `lib/invoice-enrichment.ts` |
| Project matching | `lib/project-matching.ts` (used from `app/actions/enrichment.ts`) |
| Supplier matching | `lib/supplier-matching.ts` |
| Duplicate detection | `lib/duplicate-detection.ts` (used from `app/actions/invoices.ts`) |
| Cost-package classification | `app/actions/enrichment.ts` + `lib/cost-plan.ts` |
| Classification learning | `app/actions/invoices.ts` (writes `classification_mappings`) |
| Price tracking | `app/actions/invoices.ts` (derives `price_records`) |
| Batch upload queue | `lib/extraction-queue.ts` + `components/invoice-uploader.tsx` |
| Rate limiting / governor | `lib/rate-governor.ts` (server) + `lib/extraction-queue.ts` (client) |
| Large-PDF chunking | `lib/invoice-extraction.ts` |
| Invoice commit/save | `app/actions/invoices.ts` (`commitInvoice`) |
| Funding budget logic | `lib/funding/calculations.ts` + `lib/funding/queries.ts` + `app/actions/funding.ts` |
| Funding mappings | `funding_line_package_map` table + `lib/funding/*` |
| Commercial calculations | `lib/funding/calculations.ts` |
| Database schema | `lib/db/schema.ts` |
| Migrations | `scripts/migrate-base.mjs`, `scripts/migrate-funding.mjs` |
| API routes / server actions | `app/api/*`, `app/actions/*` |
| Major UI components | `components/*` |

---

## 4. DATABASE SCHEMA

Postgres (Neon). **Source of truth: `lib/db/schema.ts`** (Drizzle). Fresh-DB DDL:
`scripts/migrate-base.mjs` (core) + `scripts/migrate-funding.mjs` (funding). 15 tables.

All tables have `id serial PRIMARY KEY` and a `created_at timestamptz DEFAULT now()`
unless noted. Foreign keys are enforced at the application layer (there are no
DB-level FK constraints) — the "FK" column below documents the intended relationship.

### Core tables

- **projects** — a development/build project.
  - Key fields: `slug` (**UNIQUE**, `projects_slug_key`), `name`, `location`, `status`
    (e.g. "On Site"), `homes`, `build_area_sqft`, `original_build_budget`,
    `development_facility`, `remaining_drawdown`, `expected_gdv`, `land_price`,
    `build_cost_per_sqft`.
- **suppliers** — a merchant/supplier. `name`, `contact`, `notes`.
- **supplier_aliases** — learned supplier heading → supplier.
  - `supplier_id` (FK→suppliers), `normalised_name` (**UNIQUE**, `supplier_aliases_norm_idx`),
    `raw_name`. Prevents near-duplicate suppliers from cosmetic name differences.
- **products** — a normalised purchasable product.
  - `name`, `description`, `category`, `manufacturer`, `unit`, plus normalisation
    fields: `normalised_name`, `product_family`, `product_type`, `dimensions`,
    `thickness`, `subcategory`.
- **supplier_products** — a supplier's SKU for a product. `product_id` (FK→products),
  `supplier_id` (FK→suppliers), `supplier_product_code`. (Currently unused: 0 rows.)
- **invoices** — one invoice OR credit note (audit-grade).
  - `supplier_id` (FK→suppliers), `project_id` (FK→projects, nullable),
    `invoice_number`, `invoice_date`, `transaction_type` ('invoice' | 'credit'),
    `net` / `vat` / `gross` (credits stored **negative**), `status` (default
    'confirmed'), source retention: `source_file_name`, `source_file_pathname`
    (Blob URL), `source_file_hash` (SHA-256, secondary dup signal), `source_page_start`
    / `source_page_end` (page range within a multi-doc file), audit:
    `extraction_raw` (jsonb — original AI read), `confidence`, `credit_of_invoice_id`
    (links a credit to its invoice), `needs_review`, `reconciled`.
  - **UNIQUE (partial):** `invoices_supplier_type_number_uidx` on
    `(supplier_id, transaction_type, lower(btrim(invoice_number)))`
    `WHERE invoice_number IS NOT NULL AND btrim(invoice_number) <> ''`.
    **This is the database-level duplicate guard.**
- **cost_packages** — a project's cost-plan package (seeded from `STANDARD_COST_PLAN`).
  - `project_id` (FK→projects), `code` (e.g. "05"), `name`, `original_budget`.
- **invoice_line_items** — a line on an invoice.
  - `invoice_id` (FK→invoices), `product_id` (FK→products, nullable), `cost_package_id`
    (FK→cost_packages, nullable — **NULL = unclassified**), `description` (immutable
    merchant text), `raw_description`, `quantity`, `unit`/`raw_unit`/`normalised_unit`,
    `unit_price_ex_vat`, `line_net`/`line_vat`/`line_gross`, `vat_rate`,
    `is_price_tracked` (bool), `cost_type` (nullable: materials/plant_hire/
    subcontract/professional_fees/other — Phase 2A dimension).
- **price_records** — historical price of a product from an invoice line.
  - `product_id`, `supplier_id`, `project_id`, `invoice_id`, `invoice_line_item_id`,
    `price_ex_vat`, `vat_amount`, `price_inc_vat`, `vat_rate`, `unit`/`normalised_unit`,
    `invoice_date`, `invoice_number`, `transaction_type`.
- **classification_mappings** — learned classification memory.
  - `key_kind` ('product' | 'description' | 'sku' | 'category'), `key_value`
    (normalised key), `supplier_id` (nullable — NULL for global category rules),
    `product_id`, `cost_package_code`, `cost_package_name` (stored by CODE+NAME so a
    mapping reapplies across projects), `category`, `normalised_unit`,
    `track_as_product`, `times_confirmed`, `updated_at`.
  - **UNIQUE:** `classification_mappings_key_idx` on
    `(key_kind, key_value, COALESCE(supplier_id, 0))` — the upsert target for learning.
- **variations** — project variations/change events (structure only, 0 rows).
  - `project_id`, `title`, `description`, `amount`, `status`.

### Funding tables (Phase 2A — see Section 19)

- **funding_budgets** — a lender's funding schedule header for a project.
  - `project_id`, `name`, `lender`, `status` ('original_locked' | 'revised' | 'draft'),
    `is_original` (bool), control totals `works_total` / `professional_fees_total` /
    `original_total` / `amount_to_borrow`, `reconciled` (bool), `notes`.
  - **UNIQUE (partial):** `uniq_original_budget_per_project` on `(project_id)`
    `WHERE is_original = true` — at most one locked baseline per project.
- **funding_budget_lines** — one lender schedule line, stored **verbatim**.
  - `funding_budget_id` (FK), `section` ('works' | 'professional_fees'), `description`
    (immutable), `original_amount` (immutable), `cost_package_code` (hint only),
    `forecast_to_complete` (nullable manual forecast), `notes`, `position` (preserves
    original lender order).
- **funding_line_package_map** — many-to-many funding line ↔ cost package.
  - `funding_budget_line_id` (FK), `cost_package_id` (FK), `weight` (nullable — optional
    apportionment of a PACKAGE's spend across lines; NEVER changes an allowance).
  - **UNIQUE:** `uniq_funding_map_pair` on `(funding_budget_line_id, cost_package_id)`.
- **funding_drawdowns** — per-line completion/drawdown position (structure only, 0 rows).
  - `funding_budget_line_id` (FK), `work_complete_pct`, `funding_earned`,
    `funding_certified`, `funding_drawn`, `notes`, `updated_at`.
  - **UNIQUE:** `uniq_funding_drawdown_line` on `(funding_budget_line_id)`.

Non-unique indexes (created by `migrate-funding.mjs`): `idx_funding_budgets_project`,
`idx_funding_lines_budget`, `idx_funding_map_line`, `idx_funding_map_pkg`.

---

## 5. MIGRATIONS

There is **no drizzle-kit / ORM migration engine**. Schema is applied with
**idempotent raw scripts** (`CREATE ... IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
Every schema change the production app depends on now exists as a committed script.
Run scripts with the DB URL available, e.g.:

```bash
node --env-file=.env.development.local scripts/<name>.mjs
# .mts files: npx tsx scripts/<name>.mts   (see notes per script)
```

### Schema migrations (run these to rebuild a fresh DB, in order)

| # | File | Purpose | Applied to prod? | Idempotent? | Command |
| --- | --- | --- | --- | --- | --- |
| 1 | `scripts/migrate-base.mjs` | All 11 core tables + the 4 functional unique indexes (dup guard, alias, classification, slug) + `cost_type` column | Yes | Yes | `node --env-file=.env.development.local scripts/migrate-base.mjs` |
| 2 | `scripts/migrate-funding.mjs` | 4 funding tables + `invoice_line_items.cost_type` + funding indexes | Yes | Yes | `node --env-file=.env.development.local scripts/migrate-funding.mjs` |

> `migrate-base.mjs` was authored during handover to guarantee the base schema is
> reproducible from the repo (previously it lived only in the live DB). It is a
> faithful, idempotent transcription of `lib/db/schema.ts` and has been verified to
> run cleanly against the existing production database (all `IF NOT EXISTS`, no-ops).

### Data / one-off scripts (NOT schema; already applied to production)

| File | Purpose | Idempotent? | Notes |
| --- | --- | --- | --- |
| `scripts/seed-higher-farm-funding.mjs` | Create Higher Farm's Goldentree budget **header** + control totals | Yes | Safe re-run |
| `scripts/load-goldentree-schedule.mts` | Load the 48 Goldentree lines **verbatim**, reconcile to control totals, lock baseline, apply confident package mappings | Yes | `npx tsx`; re-run reconciles + re-locks only if totals match |
| `scripts/add-tiling-package.mjs` | Add package **20 Tiling & Splashbacks** to existing project(s) + map the Tiling funding line | Yes | Existing packages never renumbered |
| `scripts/add-roads-package.mjs` | Add package **21 Roads & Infrastructure** + map Adoptable Highway; scans (does NOT auto-reclassify) historic invoices | Yes | Flags ambiguous historic items only |
| `scripts/save-line7.mjs` | Persist Street Lighting → 21 mapping + no-double-count note | Yes | Data note |
| `scripts/save-line8.mjs` | Hold Mains Electricity funding line UNRESOLVED (utilities decision pending) | Yes | Data note |
| `scripts/audit-works-lines.mjs` | **Read-only** report of every Works line + mapping status | Yes (read-only) | Diagnostic |
| `scripts/handover-introspect.mjs` | **Read-only** full schema/data introspection for this handover | Yes (read-only) | Diagnostic |
| `scripts/test-funding.mts` | Verification suite for the funding engine (see Section 25) | Yes (uses throwaway project, self-cleans) | `npx tsx`; needs a `server-only` shim locally — see Section 25 |

**Fresh database rebuild = step 1 then step 2 above.** The data scripts are only
needed to reconstruct Higher Farm's funding budget in a brand-new database; they are
already applied in production and are safe to re-run.

---

## 6. ENVIRONMENT VARIABLES

Full template in **`.env.example`**. Summary:

| Variable | Required? | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | **Yes** | Pooled Neon Postgres connection string. The ONLY DB var read by app code (`lib/db/index.ts`) and every script. |
| `BLOB_READ_WRITE_TOKEN` | **Yes** (for uploads) | Vercel Blob token; used to retain original invoice files in `lib/invoice-extraction.ts`. |
| `AI_GATEWAY_API_KEY` | **Local dev only / optional** | Not needed on Vercel (OIDC auto-auth). For local dev outside `vercel dev`, set this to authenticate the AI Gateway. |
| `POSTGRES_*`, `PG*`, `DATABASE_URL_UNPOOLED`, `NEON_PROJECT_ID` | No | Provisioned by the Neon integration for compatibility; **not read** by this app. |
| `NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL` | No | Present in project env but **unused** (no Supabase in this codebase). |

**Explicitly NOT needed because of Vercel zero-config / OIDC:**

- **No AI provider key in production.** The AI SDK calls the **Vercel AI Gateway**
  with plain model strings; on Vercel it is authenticated by **OIDC** automatically.
  `google/*` models are zero-config on the Gateway.
- **No auth secrets** (`NEXTAUTH_*`, `BETTER_AUTH_*`, etc.) — Gilbert OS currently has
  **no application login layer** (see Section 23).
- **No Stripe / payments / email / third-party API keys.**

---

## 7. EXTERNAL SERVICES

| Service | Used for | Auth | Recreate/link when moving | Production data lives there? |
| --- | --- | --- | --- | --- |
| **Neon Postgres** | All application data | `DATABASE_URL` connection string | Link the same Neon project (or set `DATABASE_URL` to it). To rebuild elsewhere: run the two schema migrations. | **Yes — the entire production database.** |
| **Vercel Blob** | Retaining original invoice PDFs/images | `BLOB_READ_WRITE_TOKEN` | Link the Blob store; existing blob URLs are stored on `invoices.source_file_pathname`. | **Yes — original invoice files.** |
| **Vercel AI Gateway** | Invoice extraction + enrichment model calls | **OIDC (zero-config)** on Vercel; `AI_GATEWAY_API_KEY` locally | Nothing to recreate on Vercel; models are addressed by string. | No (stateless). |
| **Vercel (deployment/project)** | Hosting, env injection, OIDC | Vercel account/project | Project ID `prj_p8auPiaebaQCyljFBM3bCUh6zhtJ`. Connect the GitHub repo to a Vercel project and attach Neon + Blob. | Config/deploys only. |
| **GitHub** | Source control | GitHub account | Repo `Gilbertbuildco/gilbert-os`, working branch `gilbert-os`. | Source only. |

Do not expose secret credentials in this document or in commits. All secrets are
injected by the integrations at runtime.

---

## 8. LOCAL DEVELOPMENT SETUP

Clean-machine steps (macOS/Linux; Node 22 LTS, npm):

```bash
# 1. Clone
git clone https://github.com/Gilbertbuildco/gilbert-os.git
cd gilbert-os
git checkout gilbert-os          # current working branch

# 2. Install deps (package-lock.json committed → reproducible)
npm install

# 3. Configure env
cp .env.example .env.development.local
#   Fill DATABASE_URL (Neon) and BLOB_READ_WRITE_TOKEN.
#   Pull real values with `vercel env pull .env.development.local` if using Vercel CLI.

# 4. Connect to DB + run migrations (fresh DB only; existing DB already migrated)
node --env-file=.env.development.local scripts/migrate-base.mjs
node --env-file=.env.development.local scripts/migrate-funding.mjs

# 5. Start dev server
npm run dev                      # http://localhost:3000

# 6. Test an invoice upload
#    Open http://localhost:3000/invoices/new and drop a supplier invoice PDF.
#    Expect: extraction → review screen with supplier/project/lines classified →
#    Commit → appears in /invoices and /procurement.
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server (Turbopack, HMR) |
| `npm run build` | Production build |
| `npm run start` | Serve production build |
| `npm run lint` | `next lint` |
| `npx tsc --noEmit` | TypeScript typecheck (no emit) |

There is no separate test command; see Section 25 for the funding verification suite.

---

## 9. DEPLOYMENT

Deployed on **Vercel**, connected to GitHub `Gilbertbuildco/gilbert-os`
(Vercel project `prj_p8auPiaebaQCyljFBM3bCUh6zhtJ`).

- **Production branch:** the Vercel project's production branch. The current working
  branch is `gilbert-os`; confirm in Vercel → Settings → Git which branch maps to
  Production before promoting. (Do not force-push or change the production branch
  mapping without intent.)
- **Build settings:** Framework preset **Next.js**, build `next build`, install
  `npm install`, output handled by Vercel. `next.config.mjs` sets
  `serverActions.bodySizeLimit = "15mb"` (invoice scans) and baseline security
  headers (`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN`,
  `Permissions-Policy`).
- **Env vars required in Vercel:** `DATABASE_URL` + `BLOB_READ_WRITE_TOKEN` (both from
  the connected integrations). No AI key needed (OIDC).
- **Database connectivity:** via `DATABASE_URL` (pooled Neon). Server actions and the
  extract route open a shared `pg` Pool (`lib/db/index.ts`).
- **Blob connectivity:** via `BLOB_READ_WRITE_TOKEN`; `@vercel/blob` `put()` uploads.
- **AI Gateway:** zero-config via OIDC in the Vercel runtime; model strings only.
- **`api/extract-invoice` `maxDuration = 300`** — large chunked PDFs need a long
  function timeout; ensure the plan permits it (Vercel clamps to plan maximum).

**Redeploy from Cursor/GitHub without breaking production:**

```bash
git checkout -b <feature-branch>       # never commit straight to production branch
# ...make changes...
git add -A && git commit -m "..."
git push -u origin <feature-branch>    # Vercel builds a PREVIEW deployment
# Open a PR → review the preview → merge to the production branch to release.
```

If a change includes a schema migration, run the migration script against the
production Neon DB **before** the code that depends on it goes live (they are
idempotent and additive, so running them early is safe).

---

## 10. CURRENT STANDARD COST PLAN

Source: `lib/cost-plan.ts` → `STANDARD_COST_PLAN`. Seeded into every new project's
`cost_packages` by `app/actions/projects.ts`. **21 packages** (verified against the
live DB for project 1). Codes 20 and 21 were appended later — **existing codes are
never renumbered**.

| Code | Name |
| --- | --- |
| 01 | Preliminaries |
| 02 | Groundworks & Foundations |
| 03 | Superstructure - Frame |
| 04 | External Walls & Cladding |
| 05 | Roofing |
| 06 | Windows & External Doors |
| 07 | Internal Walls & Partitions |
| 08 | First Fix Carpentry |
| 09 | Plumbing & Heating |
| 10 | Electrical |
| 11 | Plastering & Drylining |
| 12 | Second Fix Carpentry |
| 13 | Kitchens |
| 14 | Bathrooms & Sanitaryware |
| 15 | Decoration |
| 16 | Flooring |
| 17 | External Works & Landscaping |
| 18 | Drainage |
| 19 | Insulation |
| **20** | **Tiling & Splashbacks** (trade-first; all tiling/splashbacks regardless of room) |
| **21** | **Roads & Infrastructure** (adoptable highway, road formation/sub-base, kerbs, surfacing, highway drainage that is part of the adoptable works) |

Trade/material-first detectors in `lib/cost-plan.ts`: `looksLikeInsulation`,
`looksLikeTiling`, `looksLikeRoadsInfrastructure`.

---

## 11. COST-PACKAGE CLASSIFICATION RULES

Classification is **project-independent first, then resolved onto a project**. It runs
in `app/actions/enrichment.ts` against the canonical `STANDARD_COST_PLAN`, and the
result is mapped onto a specific project's `cost_packages` via
`resolveProjectPackage` (`lib/cost-plan.ts`, matches by CODE then exact NAME).

**Precedence (highest → lowest):**

1. **Canonical / project-agnostic rules (Tier 0).** Deterministic material/trade-first
   detectors classify obvious lines against the standard plan with **high** confidence,
   regardless of project or room:
   - insulation → `19 Insulation` (`looksLikeInsulation`)
   - tiling/splashbacks → `20 Tiling & Splashbacks` (`looksLikeTiling`)
   - adoptable-highway/road infra → `21 Roads & Infrastructure` (`looksLikeRoadsInfrastructure`)
2. **Learned exact-product mapping.** `classification_mappings` where `key_kind='product'`,
   keyed by the **normalised description** and scoped to the supplier — recalls a
   previously confirmed package (high confidence).
3. **Learned category mapping.** `classification_mappings` where `key_kind='category'`,
   stored **globally** (supplier NULL) — a never-seen product in a known category still
   lands in the right package.
4. **AI fallback.** `suggestCostPackages` (`lib/invoice-enrichment.ts`) chooses **only**
   from the project's existing packages (by code+name) or returns null; it must never
   invent a package. Returns high/medium/low confidence.
5. **Project-specific resolution.** The canonical code/name is resolved to the chosen
   project's actual `cost_package_id`.

**Confidence → behaviour:**

- **high** → suggestion is **auto-selected** in review.
- **medium / low / none** → suggestion is **pre-filled but flagged**; the user must
  confirm.

**Learning from confirmations:** on `commitInvoice` (`app/actions/invoices.ts`), each
line's confirmed classification is upserted into `classification_mappings` (product key
scoped to supplier + a global category key), incrementing `times_confirmed`. This is
what makes review-by-exception get easier over time.

**Non-negotiable independence rule:** **project assignment must NOT block cost-package
classification.** Lines are classified against the canonical plan even when the project
is unknown/ambiguous; the project field is resolved independently (Section 12).

---

## 12. PROJECT ASSIGNMENT LOGIC

Source: `lib/project-matching.ts` (`matchProject`), orchestrated from
`app/actions/enrichment.ts`. Project and cost-package decisions are **independent**.

- **Single active project → HIGH** (auto-assign). The "single active project default"
  is simply this case; it is generic, not hard-coded to Higher Farm. Active statuses:
  `on site` / `in progress` / `active` (case-insensitive; `ACTIVE_PROJECT_STATUSES`).
- **Multi-project matching:** scores each active project on identifying text from the
  document (supplier, references block, delivery/site address, order/PO/customer refs,
  line descriptions, notes). Distinctive (non-stopword) token overlap + verbatim
  name/location hits.
  - Clear unique winner (`score ≥ 5`, ≥1 distinctive hit, ≥3 ahead of runner-up) → **HIGH** (auto).
  - Weaker but present signal → **MEDIUM** (preselect + flag for review).
  - No text signal but the supplier is historically billed to one active project →
    **MEDIUM** (soft fallback, flag).
  - Nothing to go on → **NONE** (leave unassigned, flag "Project needs review").
- **Manual override:** the reviewer can set/change the project in the uploader; changing
  the project re-resolves canonical classifications onto the new project's packages.
- Projects are **never invented** from a document.

---

## 13. INVOICE INGESTION PIPELINE

End-to-end flow (client `components/invoice-uploader.tsx` + `lib/extraction-queue.ts`
→ `app/api/extract-invoice/route.ts` → `lib/invoice-extraction.ts` → review →
`app/actions/enrichment.ts` → `app/actions/invoices.ts`):

1. **Upload** — one or many files dropped into the uploader; the client queue paces them.
2. **Source file retention** — before any parsing, the original bytes are stored in
   **Vercel Blob** (`put()`); the URL is kept even if extraction fails or review is
   abandoned. A SHA-256 hash of the bytes is computed (secondary dup signal).
3. **PDF/image extraction** — a vision model (`google/gemini-2.5-flash`, falling back to
   `-flash-lite`) reads the file into a strict Zod schema (`generateObject`).
4. **Multi-document detection** — one file may contain many invoices/credit notes
   (scanned batches, statements). The model returns every distinct document.
5. **Page-range attribution** — each document reports its 1-based `pageStart`/`pageEnd`
   within the source file (offset into absolute coordinates for chunked reads).
6. **Supplier matching** — `lib/supplier-matching.ts` fuzzy-matches the heading to an
   existing supplier; confirmed headings are learned as `supplier_aliases` so cosmetic
   variants resolve instantly and don't spawn duplicate suppliers.
7. **Project matching** — `matchProject` (Section 12), independent of classification.
8. **Product normalisation** — `lib/invoice-enrichment.ts` + `lib/normalisation/*`
   infer manufacturer/family/type/category/subcategory and whether a line is a genuine
   trackable material; units are normalised to canonical Gilbert OS units.
   Normalisation **never** changes quantity, price or totals.
9. **Cost-package classification** — the tiered engine (Section 11).
10. **Duplicate detection** — `lib/duplicate-detection.ts` labels each document
    NEW / POSSIBLE DUPLICATE / ALREADY IMPORTED, including an intra-batch guard.
11. **Arithmetic reconciliation** — `lib/invoice-validation.ts` checks line totals vs
    document totals; mismatches set `reconciled=false` / `needs_review=true`.
12. **Review-by-exception** — the uploader surfaces only what needs a human: unmatched
    project, low-confidence classification, duplicates, arithmetic mismatches. Clean
    documents can be bulk-committed ("Import all ready").
13. **Commit** — `commitInvoice` writes the invoice + line items in ONE transaction,
    guarded by an app-level re-check AND the DB unique index (Section 15).
14. **Price DB** — for tracked material lines with a unit price on an invoice (not a
    credit), a `price_records` row is derived automatically (Section 16).
15. **Commercial rollups** — committed line spend rolls up by cost package, and via
    `lib/funding/*` against the Goldentree funding lines (Sections 19).
16. **Learning** — confirmed classifications + supplier aliases are persisted so the
    next upload is easier.

**Large-PDF chunking (`lib/invoice-extraction.ts`):**
- PDFs with **≤ 8 pages** (`MAX_SINGLE_SHOT_PAGES`) are read in a single request.
- Larger PDFs are split with `pdf-lib` into **overlapping page windows** of
  `CHUNK_PAGES = 4` with `CHUNK_OVERLAP = 1`, so a document straddling a boundary still
  appears whole in one window.
- Each window is a separate model call (governor-paced). Page numbers are offset back
  into the original file's coordinate space.
- Windows are merged by `mergeDocuments()` — de-duplicating on
  `supplier|type|number|gross`, keeping the richer copy (more line items) and widening
  the page range.
- Guardrails: `PER_ATTEMPT_TIMEOUT_MS = 55s` per call, `FILE_DEADLINE_MS = 280s` wall
  budget (returns what was read + `incomplete` rather than failing the whole file); a
  quota/rate failure aborts remaining windows so it doesn't burn the allowance.

---

## 14. BULK UPLOAD / AI RATE CONTROL

Two coordinated layers. **Paid Vercel AI Gateway capacity is now active**, so pacing is
tuned for throughput while still being burst-safe. (No billing details are stored here.)

**Client queue — `lib/extraction-queue.ts` (`DEFAULT_QUEUE_CONFIG`):**
- **Concurrency:** `1` (at most one extraction request in flight; configurable).
- **Request spacing:** `minSpacingMs = 1500` between request starts.
- **Global 429 behaviour:** a rate/quota response **pauses the entire queue** (honours
  `retry-after`, else escalating backoff) then auto-resumes; one throttled document
  never fails the others.
- **Auto retry + exponential backoff + jitter:** transient failures re-queued up to
  `maxAttemptsPerItem = 6`, `baseBackoffMs = 2000`, `maxBackoffMs = 60000`.
- **Sticky successes:** a file that has been read is never read again.
- **Quota block:** after `maxConsecutiveQuotaPauses = 6` with no progress, it stops and
  surfaces guidance; remaining items become retryable "failed".
- **Retry-failed fallback:** `reopen()` re-queues failed items (the manual "Retry
  failed" path).

**Server governor — `lib/rate-governor.ts` (`extractionGovernor`):**
- Process-wide **single-flight + minimum spacing** (`minIntervalMs = 200`) so even one
  chunked large-PDF extraction can't self-inflict a burst.
- **Global pause-on-429:** `penalise()` pushes a shared resume time forward (clamped to
  `maxPauseMs = 60000`); the whole instance backs off together.

---

## 15. DUPLICATE DETECTION

Source: `lib/duplicate-detection.ts` (verdicts) + enforcement in
`app/actions/invoices.ts` + the DB unique index. Deliberately conservative: only an
exact identity is auto-blocked; weaker signals are surfaced for human decision.

**Identity & signals:**
- **Supplier identity** — normalised via `normaliseSupplierName` (so cosmetic name
  differences match); backed by learned `supplier_aliases`.
- **Invoice/credit number** — normalised via `normaliseDocNumber`.
- **ALREADY IMPORTED (auto-block):** exact match on
  `supplier + transaction_type + normalised number`.
- **POSSIBLE DUPLICATE (flag for human):**
  - same number+type under a **different supplier** (possible mis-read supplier);
  - same supplier+type + identical **gross** and (same date or identical net) even if
    the number is missing/mis-read;
  - same **source file hash** already imported for the supplier.
- **Credit notes** — treated as their own `transaction_type='credit'`; a credit is
  linked to its original invoice (`credit_of_invoice_id`) when supplier+number match;
  stored with **negative** net/vat/gross so rollups net down correctly.
- **Repeated upload attempts / consolidated PDFs / retries:**
  - **Intra-batch guard** flags an identical document appearing twice in the same upload
    before either is committed.
  - **Consolidated PDFs** are split into distinct documents first (Section 13), each
    dup-checked individually.
  - **Retries** are safe: `commitInvoice` runs in a transaction guarded by an app-level
    re-check AND the partial unique index `invoices_supplier_type_number_uidx`; a
    duplicate insert writes **nothing** (no invoice, no lines, no price records) and
    returns a `duplicate` result — so a retry can never double-count spend or VAT.

---

## 16. PRICE DATABASE

Source: `price_records` table, derived in `commitInvoice` (`app/actions/invoices.ts`);
surfaced in `app/procurement` / `components/procurement-view.tsx`.

- **Add to price DB:** a `price_records` row is created automatically when a committed
  line has a linked **product**, a **unit price**, `is_price_tracked = true`, and the
  document is an **invoice** (not a credit).
- **Which lines are tracked:** genuine comparable materials. Delivery, carriage,
  haulage, fuel surcharge, rebate, discount, retention, account adjustments, labour,
  plant hire and service charges are enrichment-flagged `isMaterial = false` and
  excluded so the pricing DB stays clean.
- **Product normalisation:** lines link to a normalised `products` row
  (`normalised_name`, `product_family`, `product_type`, `dimensions`, `thickness`,
  `subcategory`) so differently-worded descriptions for the same physical product can
  be recognised and compared across merchants.
- **Historical price records:** each tracked line adds a dated `price_records` row
  (`price_ex_vat`, VAT, `price_inc_vat`, unit + normalised unit, invoice date/number),
  building per-product price history.
- **Supplier association:** every price record carries `supplier_id` (+ optional
  `project_id`), enabling supplier/price comparison later.
- **Unit normalisation:** `normalised_unit` is captured alongside the raw unit;
  normalisation never alters quantity, unit price or totals.

**Principle to preserve:** genuine purchasable materials belong in the price DB;
labour, fees, delivery and adjustments must **not** pollute material pricing.

---

## 17. LABOUR / SUBCONTRACT RULE (explicit)

Supplier/material/plant invoice ingestion and labour/subcontractor workflows are
**conceptually separate**. The labour/subcontractor workflow has **NOT** yet been
fully implemented and must **not** be silently mixed into the existing supplier-invoice
pipeline or the material price database. The `invoice_line_items.cost_type` column can
hold `'subcontract'` and (in future) `'labour'` for full economic-cost reporting, but
own direct labour is deliberately **not** ingested through the current invoice
workflow. Build labour/subcontract as its own workflow when the time comes.

---

## 18. HIGHER FARM

Current `projects` row (id = 1), from the live DB:

| Field | Value |
| --- | --- |
| id | 1 |
| slug | `higher-farm` |
| name | Higher Farm |
| location | Shepton Montague, Somerset |
| status | On Site |
| homes | 3 |
| build_area_sqft | 5,888 |
| original_build_budget | £1,124,595.00 |
| development_facility | £1,635,121.00 |
| remaining_drawdown | £502,040.69 |
| expected_gdv | (null) |
| land_price | (null) |
| build_cost_per_sqft | (null) |

Higher Farm is currently the **only** project, and it is **active ("On Site")** — so
the single-active-project default auto-assigns invoices to it with HIGH confidence. It
has the full 21-package cost plan seeded, and the reconciled/locked Goldentree funding
budget (Section 19).

---

## 19. GOLDENTREE FUNDING BUDGET

### Architecture & permanent principles

- The **Goldentree schedule is IMMUTABLE**: same original descriptions, same values,
  same line order. It broadly reflects the **lender drawdown progression** — do not
  resort, rationalise, split, apportion or rebalance it retrospectively.
- **Actual costs roll up against it.** One original funding line may relate to
  **multiple** Gilbert OS cost packages **without splitting the allowance**.
- **No actual cost may EVER be counted against more than one funding line.** When
  attribution is ambiguous, the line is left **UNRESOLVED** and waits for more actual
  invoice data — never guessed.
- Reconciliation **flags** discrepancies; it never edits lines to force a total.
- A favourable variance is **not** automatically profit (often intentional headroom
  from self-performed labour).

Data model: `funding_budgets` (header + control totals) → `funding_budget_lines`
(verbatim lines) → `funding_line_package_map` (many-to-many to cost packages,
optional `weight`) → `funding_drawdowns` (completion-driven, structure only). Engine:
`lib/funding/calculations.ts` (pure) driven by `lib/funding/queries.ts`.

### Locked control totals (reconciled to the penny — `funding_budgets` id 1, `original_locked`)

| Control | Amount |
| --- | --- |
| Works | **£1,078,217.24** |
| Professional Fees | **£46,377.71** |
| Total Funding Budget | **£1,124,594.95** |
| Amount to Borrow | **£1,124,595.00** |

Lender: **Goldentree Financial Services**. `reconciled = true`, `is_original = true`,
`status = original_locked`. (Note the deliberate £0.05 difference between Total
Funding Budget and Amount to Borrow — both stored as given.)

### The 48 stored lines, verbatim, in original order, with current mapping status

**Legend:** `MAP[nn]` = mapped to cost package(s) for actual-cost roll-up (allowance
unchanged); **UNRESOLVED** = intentionally not yet attributed; **NO-ROLL-UP** = £0
lender line, costs tracked elsewhere; **PF (unmapped)** = professional-fee line, no
package roll-up configured.

**WORKS (positions 0–40):**

| Pos | Description | Allowance | Status |
| --- | --- | --- | --- |
| 0 | Preliminaries | £10,108.00 | MAP[01] |
| 1 | Plot Drainage (Below Ground) | £24,800.00 | MAP[18] |
| 2 | Foundations | £49,602.97 | MAP[02] |
| 3 | Ground Floor Block and Beam | £22,000.00 | MAP[02] |
| 4 | Sub Structure Brickwork | £25,000.00 | MAP[02] |
| 5 | Superstructure Brickwork/Timber frame and roof structure | £227,000.00 | MAP[03,04] — 05 (roof structure) DEFERRED to avoid double-count with Roof Coverings; allowance kept whole |
| 6 | Intermediate Floors (Included in super structure) | £0.00 | MAP[03] |
| 7 | Roof Structure | £27,000.00 | **UNRESOLVED** (do not reconcile vs the £227k line) |
| 8 | Roof Coverings, Valleys/Box Gutters & Flashings | £32,576.25 | MAP[05] |
| 9 | Fascias, Soffits and RWGs | £10,258.48 | MAP[05] |
| 10 | Windows | £56,427.65 | MAP[06] |
| 11 | External Door | £20,323.23 | MAP[06] |
| 12 | Insulation (to studwork/framing and loft) | £25,767.62 | MAP[19] |
| 13 | Plastering | £36,799.75 | MAP[11] |
| 14 | First Fix Electrical | £33,582.00 | MAP[10] |
| 15 | Second Fix Electrical (Included in) | £0.00 | MAP[10] |
| 16 | First Fix Plumbing | £40,848.35 | MAP[09] |
| 17 | Second Fix Plumbing | £14,329.92 | MAP[09] |
| 18 | Gas Central Heating (Boiler and Radiators) | £8,206.78 | MAP[09] |
| 19 | First Fix Joinery (studwork and Door Frames etc.) | £15,788.57 | MAP[08] |
| 20 | Second Fix Joinery (Stairs, Skirtings, Architraves, Cills, Internal door etc.) | £44,106.89 | MAP[12] |
| 21 | Internal Doors & Ironmongery | £4,787.29 | MAP[12] |
| 22 | Kitchen Cabinets & Worktops | £60,788.81 | MAP[13] |
| 23 | Appliances | £11,838.99 | MAP[13] |
| 24 | Tiling & Splashbacks (kitchen, Bathroom, En-Suite WC etc) | £19,371.93 | MAP[20] |
| 25 | Sanitaryware (including shower trays, vanity and taps etc) | £10,463.65 | MAP[14] |
| 26 | Internal Decoration | £27,309.41 | MAP[15] |
| 27 | Floorcoverings Tiling & Splashbacks (Kitchen, Bathroom, En-Suite, etc.) | £17,309.41 | MAP[16] — flagged for later review vs pkg 20 (see Section 23) |
| 28 | Garages & Outbuildings (included in main build costs) | £0.00 | **NO-ROLL-UP** (intentional £0; costs classified by trade against their own lines) |
| 29 | Hard Landscaping (Pavings, Driveways and Patios etc) | £12,325.65 | MAP[17] |
| 30 | Soft Landscaping | £6,772.30 | MAP[17] |
| 31 | Boundaries (Walls, Fencing and Gates) | £18,431.30 | MAP[17] |
| 32 | Adoptable Highway - Construction Cost | £26,032.89 | MAP[21] |
| 33 | Street Lighting - Construction Cost | £6,042.46 | MAP[21] — no-double-count vs Adoptable Highway; both share pkg 21, actuals sub-attributed by evidence |
| 34 | Mains Electricity Supplies and Metering | £19,089.72 | **UNRESOLVED** (pending Utilities/Service-Connections package decision) |
| 35 | Air/Ground Source Heat Pump | £15,000.00 | MAP[09] |
| 36 | Solar Panels | £14,799.09 | **UNRESOLVED** (PV vs thermal → pkg 10 vs 09; awaiting decision) |
| 37 | Mains Water Supplies & Metering | £6,065.00 | **UNRESOLVED** (Utilities decision) |
| 38 | BT and Broadband | £2,959.82 | **UNRESOLVED** (Utilities decision) |
| 39 | Septic Tank | £15,866.06 | MAP[18] |
| 40 | Contingency | £58,437.00 | **UNRESOLVED** (not a build package) |

**PROFESSIONAL FEES (positions 41–47) — no package roll-up configured (PF unmapped):**

| Pos | Description | Allowance |
| --- | --- | --- |
| 41 | Planning Application Fees | £5,000.00 |
| 42 | Building Regulations Fees | £3,602.02 |
| 43 | SAP & EPC Fees | £2,000.00 |
| 44 | Architect | £6,894.71 |
| 45 | Insurances | £5,510.00 |
| 46 | Structural Engineer | £6,826.31 |
| 47 | Third Party Home Warranty or PCC | £16,544.67 |

### Mapping decisions already made (do NOT silently complete the rest)

1. **£227,000 Superstructure Brickwork/Timber frame and roof structure** — remains ONE
   unchanged lender line; allowance whole; actuals roll up from pkgs 03 + 04; roof
   structure (05) deferred to avoid double-count with Roof Coverings.
2. **Sub Structure Brickwork** → `02 Groundworks & Foundations` (below-DPC masonry).
3. **Roof Structure** → **UNRESOLVED**.
4. **Tiling & Splashbacks** → new dedicated `20 Tiling & Splashbacks`.
5. **Garages & Outbuildings** → **£0 NO-ROLL-UP**; no dedicated package created.
6. **Adoptable Highway** → new dedicated `21 Roads & Infrastructure`.
7. **Street Lighting** → `21 Roads & Infrastructure` (no-double-count vs Adoptable
   Highway; both share pkg 21 and actuals are sub-attributed by evidence).

**Remaining OPEN funding-line mapping decisions (do NOT finish these unilaterally):**
Roof Structure (7); Mains Electricity (34); Solar Panels (36); Mains Water (37);
BT and Broadband (38); Contingency (40); plus a possible **Utilities / Service
Connections** package (with per-utility tagging) to be decided across lines 34/37/38;
and a review of line 27 (Floorcoverings "Tiling & Splashbacks") vs package 20.
Professional-fee roll-up (positions 41–47) is not yet configured.

---

## 20. CURRENT PRODUCTION DATA STATUS

Live counts (from `scripts/handover-introspect.mjs`) for sanity-checking a migrated env:

| Table | Rows |
| --- | --- |
| projects | 1 |
| suppliers | 4 |
| supplier_aliases | 4 |
| products | 61 |
| supplier_products | 0 |
| invoices (all confirmed) | 43 |
| invoice_line_items | 90 |
| price_records | 82 |
| cost_packages | 21 |
| classification_mappings | 75 |
| funding_budgets | 1 |
| funding_budget_lines | 48 |
| funding_line_package_map | 35 |
| funding_drawdowns | 0 |
| variations | 0 |

---

## 21. CURRENT ACTUAL SPEND (migration sanity check)

Recognised Higher Farm invoice spend, **current live values** (net, credits netted):

- **Total confirmed spend (net):** **£19,699.59** across **90** line items on **43**
  confirmed invoices.
- **Classified / attributable spend (net):** **£18,286.27** across **83** classified
  lines (these have a `cost_package_id` and roll up to funding lines).
- **Unclassified:** **7** lines totalling **£1,413.32** (no `cost_package_id` yet).

Spend by cost package (net): Roofing £5,258.38 (19 lines) · Groundworks & Foundations
£5,208.58 (9) · Insulation £3,373.56 (3) · Preliminaries £1,852.70 (16) · External
Walls & Cladding £830.91 (11) · First Fix Carpentry £798.65 (10) · Superstructure-Frame
£436.98 (4) · External Works & Landscaping £396.58 (6) · Drainage £92.43 (4) · Flooring
£37.50 (1).

> A migrated environment should reproduce these figures exactly. If they differ, the
> data did not migrate cleanly.

---

## 22. BUSINESS RULES / NON-NEGOTIABLES

Future agents/developers must NOT undo any of these:

1. **Never fabricate financial data** — no invented £/%, budgets, splits, line items,
   references, or product specs. If a value is unknown, leave it null/unresolved.
2. **Never alter the lender baseline to make totals reconcile.** Store the schedule
   exactly as supplied.
3. **Flag discrepancies instead of "fixing" them** — reconciliation stops and reports;
   it never edits values.
4. **Preserve original invoices/files** — the uploaded document is retained in Blob
   before parsing and never discarded; `description`/`raw_*` fields are immutable audit
   references; `extraction_raw` keeps the original AI read.
5. **Prevent duplicate financial records** — the app-level re-check + partial unique
   index must remain; a duplicate writes nothing.
6. **AI does the work; the user reviews exceptions** — do not auto-commit low-confidence
   or ambiguous documents without review.
7. **Classifications learn from confirmations** — keep writing `classification_mappings`
   (and `supplier_aliases`) on commit.
8. **No actual spend may double-count** against more than one funding line.
9. **The Goldentree schedule stays immutable** — same descriptions, values and order;
   never split/apportion/rebalance the allowance.
10. **Project selection must not block cost-package classification** — they are
    independent decisions.
11. **Existing production data must not be deleted during testing** — tests use throwaway
    projects and self-clean; never truncate/reset production tables. `deleteInvoice`
    exists for legitimate single-record removal only.
12. **Own labour/subcontract is a separate future workflow** — do not mix it into the
    supplier-material pipeline or the material price DB (Section 17).

---

## 23. KNOWN ISSUES / OPEN WORK

- **Goldentree mapping decisions still open** (Section 19): Roof Structure, Mains
  Electricity, Solar Panels, Mains Water, BT & Broadband, Contingency; the proposed
  **Utilities / Service Connections** package (per-utility tagging); line 27
  "Floorcoverings Tiling & Splashbacks" vs package 20; and professional-fee roll-up
  (positions 41–47) not configured. **Decide these with the owner, one at a time — do
  not auto-complete.**
- **Phase 2B — Project Cost Control dashboard / UI not yet built.** The funding engine
  and queries exist; the full commercial Funding-vs-Actual UI is still to be built.
- **Historical invoices not fully uploaded** — only 43 invoices ingested so far
  (£19.7k of a £1.12m budget); the bulk of Higher Farm's actual history is still to be
  entered.
- **Labour / subcontractor workflow** — conceptually separate and not implemented
  (Section 17).
- **Supplier / price intelligence features** — price comparison, supplier benchmarking,
  procurement alerts are not built yet (schema supports them).
- **AI query / conversational interface** — future work.
- **No authentication layer** — the app currently has no login; add auth before any
  public production exposure.
- **`funding_drawdowns` is structure-only** — completion-driven drawdown intelligence
  is not yet populated.
- **`variations` and `supplier_products`** are defined but unused (0 rows).

---

## 24. DEVELOPMENT ROADMAP

1. **Phase 2A — finish funding mapping / data foundation** (in progress: resolve the
   remaining Goldentree mapping decisions with the owner).
2. **Phase 2B — Project Cost Control dashboard** (Funding-vs-Actual UI on the engine).
3. **Price Intelligence** (per-product/supplier price history + comparison).
4. **Supplier Intelligence** (supplier benchmarking).
5. **Procurement alerts** (price movement / anomaly flags).
6. **Cross-project benchmarking / appraisal intelligence** (feed Land Appraisal with
   real cost data).
7. **Gilbert OS conversational AI** (natural-language querying of the cost data).

---

## 25. TESTING

Scenarios already verified during development (manually and/or via the funding suite):

| Scenario | How it's covered |
| --- | --- |
| Normal single invoice | Upload flow (extract → review → commit) |
| Multi-line invoice | Line extraction + per-line classification |
| Multi-invoice PDF | `mergeDocuments` + per-document page ranges |
| Large PDF | Chunked windows + deadline handling (`invoice-extraction.ts`) |
| Duplicate | `duplicate-detection.ts` + app/DB unique-index guard |
| Credit note | Negative totals + `credit_of_invoice_id` linking |
| Recurring supplier | `supplier_aliases` learning |
| Cost-package learning | `classification_mappings` upsert on commit |
| Project defaulting | `matchProject` single-active-project HIGH default |
| Bulk ingestion | `extraction-queue.ts` (concurrency, spacing, sticky success) |
| Rate-limit handling | Queue global 429 pause + `rate-governor.ts` |
| Funding reconciliation | `scripts/test-funding.mts` (44 checks) + live Goldentree reconcile |

**Commands:**

```bash
# Typecheck (fast, no DB)
npx tsc --noEmit

# Production build
npm run build

# Funding engine + DB integration suite (44 checks; uses a throwaway project, self-cleans)
#   NOTE: this imports server-only modules. Locally, either run it through a runtime
#   that provides a `server-only` stub, or create a tiny shim before running:
#     mkdir -p node_modules/server-only && \
#       printf '{"name":"server-only","version":"0.0.0","main":"index.js"}' > node_modules/server-only/package.json && \
#       printf 'module.exports = {};' > node_modules/server-only/index.js
npx tsx scripts/test-funding.mts

# Read-only funding line audit (mapping status per Works line)
node --env-file=.env.development.local scripts/audit-works-lines.mjs

# Read-only full introspection (schema + counts + spend + Goldentree)
node --env-file=.env.development.local scripts/handover-introspect.mjs
```

---

## 26. HANDOVER VALIDATION (performed during this handover)

- **Production build** — `npm run build` ✓ succeeds (all routes compile).
- **TypeScript** — `npx tsc --noEmit` ✓ clean (0 errors).
- **Schema sanity check** — live schema introspected; matches `lib/db/schema.ts`; the 4
  functional unique indexes confirmed present.
- **Migration inventory** — base + funding migrations authored/verified idempotent
  against the live DB; no schema change is left "chat-only".
- **Env-variable inventory** — required (`DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`) vs
  zero-config (AI Gateway OIDC) documented in `.env.example` and Section 6.
- **External integration inventory** — Neon, Vercel Blob, Vercel AI Gateway confirmed
  connected (Section 7).
- **Live DB count sanity check** — counts + current spend captured (Sections 20–21).
- No permanent test data was created (the funding suite self-cleans; introspection is
  read-only).

---

## 27. GIT / BACKUP SAFETY

- Working branch: **`gilbert-os`** (repo `Gilbertbuildco/gilbert-os`).
- **A `.gitignore` was added during handover** — previously there was none, which risked
  a future `git add -A` committing `.env.development.local` (secrets), `node_modules`,
  `.next`, `.vercel`. It now ignores env files, build output and deps.
- **No secrets are tracked** — verified `git ls-files` contains no `.env*` files.
- All migration/data scripts live in the committed `scripts/` directory (no migration
  exists only in a temporary path or in chat).
- `.env.example` is committed (no secret values); the real `.env.development.local` is
  ignored.
- **The definitive commit hash for the complete handover state is reported in the chat
  response accompanying this document, and can be re-checked any time with
  `git log -1 --format='%H %s'`** on the `gilbert-os` branch.

---

## 28. FIRST PROMPT FOR CURSOR

> Copy everything in the block below as your first message to Cursor.

```
You are picking up an existing, working project called Gilbert OS. Do NOT redesign,
rewrite, or delete existing functionality.

1. Read GILBERT_OS_HANDOVER.md in full, then read gilbert-os-handover.json. Pay special
   attention to Section 22 (Business Rules / Non-Negotiables) and Section 19 (Goldentree
   Funding Budget) — these encode financial rules you must never break.

2. Inspect the repository to confirm the handover matches reality: lib/db/schema.ts,
   lib/cost-plan.ts, app/actions/*, lib/funding/*, lib/invoice-extraction.ts,
   lib/extraction-queue.ts, and the scripts/ directory.

3. Verify the local environment without changing behaviour:
   - Node 22, `npm install`
   - copy .env.example to .env.development.local and fill DATABASE_URL + BLOB_READ_WRITE_TOKEN
   - `npx tsc --noEmit` and `npm run build` must both pass
   - For a FRESH database only: run scripts/migrate-base.mjs then scripts/migrate-funding.mjs
   - Sanity-check the DB against Sections 20–21 with scripts/handover-introspect.mjs

4. Do NOT auto-complete the open Goldentree funding-line mapping decisions listed in
   Section 19/23 — surface them and decide with me one at a time.

5. Never fabricate financial data, never alter the immutable Goldentree schedule, never
   allow duplicate financial records, never let actual spend double-count against funding
   lines, and keep classification learning intact.

When you have confirmed the build passes and the data matches, tell me the current state
and propose the next step (likely Phase 2B — the Project Cost Control dashboard) before
writing any code.
```

---

_End of handover. Companion machine-readable pack: `gilbert-os-handover.json`._
