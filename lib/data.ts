import type { AttentionItemData } from "@/components/attention-item"

/**
 * Known, real project data for Gilbert Build Co.
 * Only figures we can actually stand behind are stored here.
 * Anything we do not yet have a reliable source for is intentionally
 * left out and rendered as an "unconnected" state in the UI.
 */

export interface Project {
  slug: string
  name: string
  location: string
  status: "Construction" | "Appraisal" | "Planning" | "Complete"
  homes?: number
  buildAreaSqFt?: number
  // Higher Farm known financials
  originalBuildBudget?: number
  developmentFacility?: number
  remainingDrawdown?: number
  // Phase 2 appraisal assumptions
  expectedGDV?: number
  landPrice?: number
  buildCostPerSqFt?: number
}

export const projects: Project[] = [
  {
    slug: "higher-farm",
    name: "Higher Farm",
    location: "Shepton Montague",
    status: "Construction",
    homes: 3,
    buildAreaSqFt: 5888,
    originalBuildBudget: 1124595,
    developmentFacility: 1635121,
    remainingDrawdown: 502040.69,
  },
  {
    slug: "phase-2",
    name: "Phase 2",
    location: "Shepton Montague",
    status: "Appraisal",
    homes: 3,
    buildAreaSqFt: 3850,
    expectedGDV: 1650000,
    landPrice: 250000,
    buildCostPerSqFt: 205,
  },
]

export function getProject(slug: string) {
  return projects.find((p) => p.slug === slug)
}

export const projectScopes = ["Portfolio", "Higher Farm", "Phase 2"]

export const attentionItems: AttentionItemData[] = [
  {
    id: "merchant-pricing",
    severity: "high",
    category: "Commercial",
    project: "Portfolio",
    title: "Merchant pricing review",
    detail: "43 historic Bradfords price differences identified across previously placed orders.",
    impact: "£673.78 net difference under review",
    action: "Review",
  },
  {
    id: "plot-2-extras",
    severity: "medium",
    category: "Variations",
    project: "Higher Farm",
    title: "Plot 2 Extras",
    detail:
      "Several client upgrades need tracking against payments and remaining balances before final account.",
    action: "Track extras",
  },
  {
    id: "procurement-db",
    severity: "low",
    category: "Procurement",
    project: "Portfolio",
    title: "Procurement",
    detail: "Merchant comparison database ready for additional CRS and MKM pricing to be imported.",
    action: "Open procurement",
  },
  {
    id: "drawdown",
    severity: "medium",
    category: "Drawdown",
    project: "Higher Farm",
    title: "Drawdown",
    detail:
      "Next QS valuation should be driven by current site progress and cash requirement before the next facility drawdown.",
    action: "Prepare valuation",
  },
]

// Commercial cost plan package structure. Budget/committed/paid are
// intentionally unconnected until invoice ingestion is live.
export interface CostLine {
  code: string
  package: string
}

export const costPlan: CostLine[] = [
  { code: "01", package: "Preliminaries" },
  { code: "02", package: "Groundworks" },
  { code: "03", package: "Drainage & Services" },
  { code: "04", package: "Timber Frame" },
  { code: "05", package: "Roofing" },
  { code: "06", package: "Masonry & Stonework" },
  { code: "07", package: "Windows & External Doors" },
  { code: "08", package: "Plumbing & Heating" },
  { code: "09", package: "Electrical" },
  { code: "10", package: "Plastering" },
  { code: "11", package: "Carpentry" },
  { code: "12", package: "Kitchens" },
  { code: "13", package: "Bathrooms" },
  { code: "14", package: "Flooring" },
  { code: "15", package: "External Works" },
  { code: "16", package: "Professional Fees" },
]

// Suppliers — pricing coverage is descriptive; financial figures are unconnected.
export interface Supplier {
  name: string
  pricingCoverage: string
  lastPricingUpdate: string
  contact: string
  status: "Active" | "Pending" | "Review"
  coverageVariant: "success" | "warning" | "neutral"
}

export const suppliers: Supplier[] = [
  {
    name: "Bradfords",
    pricingCoverage: "Primary merchant · broad coverage",
    lastPricingUpdate: "Historic pricing loaded",
    contact: "Trade account · Wincanton",
    status: "Active",
    coverageVariant: "success",
  },
  {
    name: "Travis Perkins",
    pricingCoverage: "Comparison merchant · partial coverage",
    lastPricingUpdate: "Historic pricing loaded",
    contact: "Trade account · Yeovil",
    status: "Active",
    coverageVariant: "success",
  },
  {
    name: "CRS",
    pricingCoverage: "Comparison merchant · import pending",
    lastPricingUpdate: "Awaiting price file",
    contact: "Trade account",
    status: "Pending",
    coverageVariant: "warning",
  },
  {
    name: "MKM",
    pricingCoverage: "Comparison merchant · import pending",
    lastPricingUpdate: "Awaiting price file",
    contact: "Trade account",
    status: "Pending",
    coverageVariant: "warning",
  },
]

// Small, clearly-labelled sample procurement rows. The real 211-product
// database will be imported separately.
export interface ProcurementRow {
  id: string
  buildStage: string
  product: string
  unit: string
  bradfordsCurrent?: number
  bradfordsRevised?: number
  travisCurrent?: number
  travisRevised?: number
  crs?: number
  mkm?: number
}

export const procurementSample: ProcurementRow[] = [
  {
    id: "cement-25kg",
    buildStage: "Groundworks",
    product: "OPC Cement 25kg",
    unit: "bag",
    bradfordsCurrent: 6.49,
    bradfordsRevised: 5.99,
    travisCurrent: 6.75,
    travisRevised: 6.2,
  },
  {
    id: "conc-block-100",
    buildStage: "Masonry & Stonework",
    product: "Concrete Block 100mm 7N",
    unit: "each",
    bradfordsCurrent: 1.84,
    travisCurrent: 1.79,
    crs: 1.72,
  },
  {
    id: "osb3-18mm",
    buildStage: "Timber Frame",
    product: "OSB3 Board 2440x1220x18mm",
    unit: "sheet",
    bradfordsCurrent: 24.5,
    bradfordsRevised: 22.9,
    travisCurrent: 25.1,
  },
  {
    id: "plaster-board-12",
    buildStage: "Plastering",
    product: "Plasterboard 2400x1200x12.5mm",
    unit: "sheet",
    bradfordsCurrent: 9.2,
    travisCurrent: 8.95,
    mkm: 8.7,
  },
  {
    id: "insulation-100",
    buildStage: "Timber Frame",
    product: "PIR Insulation Board 100mm",
    unit: "sheet",
    bradfordsCurrent: 41.0,
    travisCurrent: 39.5,
    crs: 38.9,
  },
]
