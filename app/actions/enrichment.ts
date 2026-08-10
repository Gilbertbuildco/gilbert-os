"use server"

import { db } from "@/lib/db"
import { suppliers, supplierAliases, classificationMappings, invoices } from "@/lib/db/schema"
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { normaliseSupplierName, normaliseDocNumber } from "@/lib/invoice-identity"
import { matchSupplier, type SupplierCandidate, type SupplierMatch } from "@/lib/supplier-matching"
import { classifyDocuments } from "@/app/actions/invoices"
import type { DuplicateVerdict } from "@/lib/duplicate-detection"
import { enrichLineItems, suggestCostPackages } from "@/lib/invoice-enrichment"
import {
  normaliseProductName,
  normaliseDescriptionKey,
  parseDimensions,
  parseThickness,
  suggestTrackPrice,
} from "@/lib/normalisation/products"
import { normaliseUnit } from "@/lib/normalisation/units"
import { validateInvoiceArithmetic } from "@/lib/invoice-validation"
import { getActiveProjects, getCostPackagesForProject } from "@/lib/queries"
import {
  STANDARD_COST_PLAN,
  INSULATION_PACKAGE_NAME,
  looksLikeInsulation,
  TILING_PACKAGE_NAME,
  looksLikeTiling,
  ROADS_PACKAGE_NAME,
  looksLikeRoadsInfrastructure,
} from "@/lib/cost-plan"
import { matchProject, type ProjectMatch } from "@/lib/project-matching"

// ---------------------------------------------------------------------------
// Types shared with the client review UI
// ---------------------------------------------------------------------------

export type PrepareLineInput = {
  description: string
  quantity: number | null
  unit: string | null
  unitPriceExVat: number | null
  lineNet: number | null
  vatRate: number | null
}

export type DocReferences = {
  siteName: string | null
  deliveryAddress: string | null
  orderReference: string | null
  purchaseOrder: string | null
  customerReference: string | null
}

export type PrepareDocInput = {
  supplierName: string | null
  invoiceNumber: string | null
  transactionType: "invoice" | "credit"
  invoiceDate: string | null
  net: number | null
  vat: number | null
  gross: number | null
  sourceFileHash: string | null
  /** Identifying references used only for project matching (never financial). */
  references?: DocReferences | null
  lines: PrepareLineInput[]
}

export type LineIntelligence = {
  /** Identity key derived from the raw description (uppercased, noise stripped). */
  normalisedName: string
  dimensions: string | null
  thickness: string | null
  rawUnit: string | null
  normalisedUnit: string | null
  unitConfident: boolean
  category: string | null
  subcategory: string | null
  manufacturer: string | null
  productFamily: string | null
  productType: string | null
  trackAsProduct: boolean
  trackReason: string
  trackConfidence: "high" | "medium" | "low"
  /** Cost-package CODE remembered from a previous confirmation, if any. */
  learnedPackageCode: string | null
  learnedPackageName: string | null
  /** true when a learned mapping (not just heuristics) drove these values. */
  fromMemory: boolean
  // --- project-INDEPENDENT canonical cost-package classification ---
  // The best-matching package from the STANDARD cost plan (by code + name),
  // decided WITHOUT knowing the project. Retained so it can be applied the
  // instant a project is resolved; an unknown project never blanks it out.
  canonicalPackageCode: string | null
  canonicalPackageName: string | null
  canonicalConfidence: "high" | "medium" | "low" | "none"
}

export type DocIntelligence = {
  supplierMatch: SupplierMatch
  verdict: DuplicateVerdict
  reconciled: boolean
  reconIssues: string[]
  /** Suggested project + confidence (project assignment is independent of
   *  cost-package classification). */
  projectMatch: ProjectMatch
  lines: LineIntelligence[]
}

// ---------------------------------------------------------------------------
// Supplier candidate list (existing suppliers + learned aliases)
// ---------------------------------------------------------------------------

async function loadSupplierCandidates(): Promise<SupplierCandidate[]> {
  const [supplierRows, aliasRows] = await Promise.all([
    db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers),
    db
      .select({
        supplierId: supplierAliases.supplierId,
        normalisedName: supplierAliases.normalisedName,
        rawName: supplierAliases.rawName,
      })
      .from(supplierAliases),
  ])
  const candidates: SupplierCandidate[] = supplierRows.map((s) => ({
    id: s.id,
    name: s.name,
    normalised: normaliseSupplierName(s.name),
  }))
  for (const a of aliasRows) {
    candidates.push({ id: a.supplierId, name: a.rawName ?? a.normalisedName, normalised: a.normalisedName })
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Learned classification mappings
// ---------------------------------------------------------------------------

type LearnedMapping = {
  costPackageCode: string | null
  costPackageName: string | null
  category: string | null
  normalisedUnit: string | null
  trackAsProduct: boolean | null
  timesConfirmed: number
  supplierId: number | null
}

/**
 * Look up learned product→classification mappings for a set of normalised
 * product keys. Supplier-specific mappings win over global ones; within a scope
 * the most-confirmed mapping wins.
 */
async function loadLearnedMappings(
  keys: string[],
  supplierId: number | null,
): Promise<Map<string, LearnedMapping>> {
  const map = new Map<string, LearnedMapping>()
  const uniqueKeys = [...new Set(keys.filter(Boolean))]
  if (uniqueKeys.length === 0) return map

  const rows = await db
    .select()
    .from(classificationMappings)
    .where(
      and(
        eq(classificationMappings.keyKind, "product"),
        inArray(classificationMappings.keyValue, uniqueKeys),
        supplierId != null
          ? or(eq(classificationMappings.supplierId, supplierId), isNull(classificationMappings.supplierId))
          : isNull(classificationMappings.supplierId),
      ),
    )

  for (const r of rows) {
    const existing = map.get(r.keyValue)
    const candidate: LearnedMapping = {
      costPackageCode: r.costPackageCode,
      costPackageName: r.costPackageName,
      category: r.category,
      normalisedUnit: r.normalisedUnit,
      trackAsProduct: r.trackAsProduct,
      timesConfirmed: r.timesConfirmed,
      supplierId: r.supplierId,
    }
    if (!existing) {
      map.set(r.keyValue, candidate)
      continue
    }
    // Prefer supplier-specific over global, then higher confirmation count.
    const existingSupplierSpecific = existing.supplierId != null
    const candidateSupplierSpecific = candidate.supplierId != null
    if (candidateSupplierSpecific && !existingSupplierSpecific) {
      map.set(r.keyValue, candidate)
    } else if (candidateSupplierSpecific === existingSupplierSpecific && candidate.timesConfirmed > existing.timesConfirmed) {
      map.set(r.keyValue, candidate)
    }
  }
  return map
}

/**
 * For each supplier, the active project it has historically and unambiguously
 * been billed to (a clear majority of its confirmed invoices). Used only as a
 * soft MEDIUM fallback when a document carries no textual project signal.
 */
async function loadSupplierProjectHistory(activeProjectIds: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>()
  if (activeProjectIds.length === 0) return result
  try {
    const rows = await db
      .select({
        supplierId: invoices.supplierId,
        projectId: invoices.projectId,
        n: sql<number>`count(*)::int`,
      })
      .from(invoices)
      .where(and(inArray(invoices.projectId, activeProjectIds), eq(invoices.status, "confirmed")))
      .groupBy(invoices.supplierId, invoices.projectId)

    // Tally per supplier; assign only when one active project is a clear
    // majority (>= 75% of that supplier's confirmed invoices to active projects).
    const bySupplier = new Map<number, { total: number; top: { projectId: number; n: number } | null }>()
    for (const r of rows) {
      if (r.projectId == null) continue
      const cur = bySupplier.get(r.supplierId) ?? { total: 0, top: null }
      cur.total += r.n
      if (!cur.top || r.n > cur.top.n) cur.top = { projectId: r.projectId, n: r.n }
      bySupplier.set(r.supplierId, cur)
    }
    for (const [supplierId, agg] of bySupplier) {
      if (agg.top && agg.total > 0 && agg.top.n / agg.total >= 0.75) {
        result.set(supplierId, agg.top.projectId)
      }
    }
  } catch (err) {
    console.log("[v0] loadSupplierProjectHistory failed:", (err as Error).message)
  }
  return result
}

// ---------------------------------------------------------------------------
// prepareBatch — the project-independent intelligence pass
// ---------------------------------------------------------------------------

/**
 * Run all project-independent intelligence over a freshly-extracted batch:
 * supplier matching, duplicate classification, product/unit normalisation, the
 * AI enrichment pass, learned-mapping recall, canonical (project-independent)
 * cost-package classification, project matching and arithmetic validation.
 * Cost packages are additionally resolved onto a project's own plan once a
 * project is chosen (see suggestPackagesForProject).
 */
export async function prepareBatch(docs: PrepareDocInput[]): Promise<DocIntelligence[]> {
  const candidates = await loadSupplierCandidates()
  // Active/live projects drive independent project assignment (single-project
  // default or confidence-based matching). Loaded once for the whole batch.
  const activeProjects = await getActiveProjects()
  // Supplier → historically-billed active project. Only a soft fallback signal,
  // and only worth loading when there is more than one active project to
  // disambiguate between (the single-project case never needs it).
  const supplierProjectHistory =
    activeProjects.length > 1
      ? await loadSupplierProjectHistory(activeProjects.map((p) => p.id))
      : new Map<number, number>()

  // Duplicate verdicts for the whole batch in one pass (reuses existing logic).
  let verdicts: DuplicateVerdict[] = []
  try {
    verdicts = await classifyDocuments(
      docs.map((d) => ({
        supplierName: d.supplierName,
        invoiceNumber: d.invoiceNumber,
        transactionType: d.transactionType,
        net: d.net,
        vat: d.vat,
        gross: d.gross,
        invoiceDate: d.invoiceDate,
        sourceFileHash: d.sourceFileHash,
      })),
    )
  } catch (err) {
    console.log("[v0] prepareBatch: duplicate classification failed:", (err as Error).message)
  }

  const out: DocIntelligence[] = []

  for (let d = 0; d < docs.length; d++) {
    const doc = docs[d]
    const supplierMatch = matchSupplier(doc.supplierName, candidates)

    // Deterministic per-line normalisation first (never fails).
    const baseLines: LineIntelligence[] = doc.lines.map((l) => {
      const unit = normaliseUnit(l.unit)
      const track = suggestTrackPrice(l.description, l.unitPriceExVat)
      return {
        normalisedName: normaliseProductName(l.description),
        dimensions: parseDimensions(l.description),
        thickness: parseThickness(l.description),
        rawUnit: unit.raw,
        normalisedUnit: unit.normalised,
        unitConfident: unit.matched,
        category: null,
        subcategory: null,
        manufacturer: null,
        productFamily: null,
        productType: null,
        trackAsProduct: track.suggested,
        trackReason: track.reason,
        trackConfidence: track.confidence,
        learnedPackageCode: null,
        learnedPackageName: null,
        fromMemory: false,
        canonicalPackageCode: null,
        canonicalPackageName: null,
        canonicalConfidence: "none",
      }
    })

    // AI enrichment (best effort — layers category/manufacturer/type + a
    // materials judgement over the deterministic base).
    try {
      const enriched = await enrichLineItems(
        doc.supplierName,
        doc.lines.map((l) => ({ description: l.description, unit: l.unit, unitPriceExVat: l.unitPriceExVat })),
      )
      for (const e of enriched) {
        const target = baseLines[e.index]
        if (!target) continue
        target.category = e.category
        target.subcategory = e.subcategory
        target.manufacturer = e.manufacturer
        target.productFamily = e.productFamily
        target.productType = e.productType
        // The model's materials judgement refines the deterministic track flag,
        // but an explicit non-product keyword hit (high confidence) always wins.
        if (target.trackConfidence !== "high") {
          target.trackAsProduct = e.isMaterial
          target.trackReason = e.isMaterial
            ? "Assessed as a genuine material."
            : "Assessed as a charge/service, not a comparable material."
        }
      }
    } catch (err) {
      console.log("[v0] prepareBatch: enrichment failed:", (err as Error).message)
    }

    // Learned-mapping recall — makes review progressively easier over time.
    // Keyed by the SAME normalised description key the commit path writes, so a
    // previously-confirmed line recalls its classification even when a later
    // invoice words the description slightly differently.
    try {
      const descKeys = doc.lines.map((l) => normaliseDescriptionKey(l.description))
      const learned = await loadLearnedMappings(descKeys, supplierMatch.supplierId)
      for (let i = 0; i < baseLines.length; i++) {
        const line = baseLines[i]
        const m = learned.get(descKeys[i])
        if (!m) continue
        line.fromMemory = true
        line.learnedPackageCode = m.costPackageCode
        line.learnedPackageName = m.costPackageName
        if (m.category && !line.category) line.category = m.category
        if (m.normalisedUnit && !line.normalisedUnit) line.normalisedUnit = m.normalisedUnit
        if (m.trackAsProduct != null) {
          line.trackAsProduct = m.trackAsProduct
          line.trackReason = "Remembered from a previous confirmation."
          line.trackConfidence = "high"
        }
      }
    } catch (err) {
      console.log("[v0] prepareBatch: learned-mapping recall failed:", (err as Error).message)
    }

    // Project-INDEPENDENT canonical cost-package classification. Done here (no
    // project needed) so an obvious line is classified immediately; the result
    // is mapped onto the chosen project's plan at resolution time.
    try {
      const canonical = await classifyLinesCanonical(
        baseLines.map((l, i) => ({
          description: doc.lines[i]?.description ?? "",
          category: l.category,
          productType: l.productType,
          normalisedName: l.normalisedName,
          learnedPackageCode: l.learnedPackageCode,
          learnedPackageName: l.learnedPackageName,
        })),
      )
      for (let i = 0; i < baseLines.length; i++) {
        const c = canonical[i]
        if (!c) continue
        baseLines[i].canonicalPackageCode = c.packageCode
        baseLines[i].canonicalPackageName = c.packageName
        baseLines[i].canonicalConfidence = c.confidence
      }
    } catch (err) {
      console.log("[v0] prepareBatch: canonical classification failed:", (err as Error).message)
    }

    const validation = validateInvoiceArithmetic({
      lines: doc.lines.map((l) => ({
        quantity: l.quantity,
        unitPriceExVat: l.unitPriceExVat,
        lineNet: l.lineNet,
      })),
      net: doc.net,
      vat: doc.vat,
      gross: doc.gross,
    })

    // Independent project assignment. All identifying text the document carries
    // becomes the haystack; matchProject applies the single-project default or
    // confidence-based matching, with the supplier's history as a soft fallback.
    const refs = doc.references ?? null
    const haystack = [
      doc.supplierName,
      refs?.siteName,
      refs?.deliveryAddress,
      refs?.orderReference,
      refs?.purchaseOrder,
      refs?.customerReference,
      ...doc.lines.map((l) => l.description),
    ]
      .filter(Boolean)
      .join(" \n ")
    const projectMatch = matchProject(haystack, activeProjects, {
      supplierHistoryProjectId: supplierMatch.supplierId
        ? (supplierProjectHistory.get(supplierMatch.supplierId) ?? null)
        : null,
    })

    out.push({
      supplierMatch,
      verdict: verdicts[d] ?? { status: "new", existing: null, reason: null },
      reconciled: validation.reconciled,
      reconIssues: validation.issues.map((i) => i.message),
      projectMatch,
      lines: baseLines,
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// suggestPackagesForProject — resolves cost packages once a project is known
// ---------------------------------------------------------------------------

export type LineForSuggestion = {
  description: string
  category: string | null
  productType: string | null
  normalisedName: string
  /** Cost-package code recalled from a learned product mapping, if any. */
  learnedPackageCode: string | null
  /** Cost-package name recalled from a learned product mapping, if any. */
  learnedPackageName?: string | null
  // Canonical (project-independent) classification already decided in
  // prepareBatch. When present it is the FIRST thing the per-project resolver
  // maps onto the project's own plan, so project-specific availability is only
  // applied at this final stage and an obvious classification is never lost.
  canonicalPackageCode?: string | null
  canonicalPackageName?: string | null
  canonicalConfidence?: "high" | "medium" | "low" | "none"
}

export type ResolvedPackage = {
  packageId: number | null
  packageCode: string | null
  packageName: string | null
  confidence: "high" | "medium" | "low" | "none"
  fromMemory: boolean
}

/** A cost plan the classifier can target: the standard plan (no ids) or a
 *  project's own packages (with ids). */
export type PlanEntry = { id?: number | null; code: string | null; name: string }

/**
 * Shared classification core. Resolves each line to the best entry of the given
 * `plan` using the tiered strategy (canonical → learned product → insulation →
 * learned category → AI). This is deliberately plan-agnostic so the SAME logic
 * produces the project-independent canonical classification (plan = standard
 * cost plan) and the final project resolution (plan = the project's packages).
 */
async function classifyLinesToPlan(
  lines: LineForSuggestion[],
  plan: PlanEntry[],
  opts: { useCanonical: boolean; allowAI: boolean },
): Promise<ResolvedPackage[]> {
  const byCode = new Map<string, PlanEntry>()
  const byName = new Map<string, PlanEntry>()
  for (const p of plan) {
    if (p.code) byCode.set(p.code.trim().toLowerCase(), p)
    byName.set(p.name.trim().toLowerCase(), p)
  }

  // Resolve a remembered/suggested package (by code OR exact name) against this
  // plan. Codes may be null on some plans, so the name is a vital fallback and
  // keeps learning working across projects that share a plan structure.
  const resolvePkg = (code: string | null | undefined, name: string | null | undefined) => {
    if (code) {
      const p = byCode.get(code.trim().toLowerCase())
      if (p) return p
    }
    if (name) {
      const p = byName.get(name.trim().toLowerCase())
      if (p) return p
    }
    return undefined
  }

  const results: ResolvedPackage[] = lines.map(() => ({
    packageId: null,
    packageCode: null,
    packageName: null,
    confidence: "none",
    fromMemory: false,
  }))
  const setResult = (i: number, p: PlanEntry, confidence: ResolvedPackage["confidence"], fromMemory: boolean) => {
    results[i] = { packageId: p.id ?? null, packageCode: p.code, packageName: p.name, confidence, fromMemory }
  }

  if (plan.length === 0) return results

  let unresolved: number[] = []

  // Tier 0 — canonical classification already computed project-independently.
  // Mapping it onto the project's plan by code/name is the final resolution
  // stage; it carries the canonical confidence and avoids re-running the model.
  for (let i = 0; i < lines.length; i++) {
    if (opts.useCanonical && lines[i].canonicalPackageCode != null) {
      const p = resolvePkg(lines[i].canonicalPackageCode, lines[i].canonicalPackageName)
      if (p) {
        setResult(i, p, lines[i].canonicalConfidence ?? "medium", false)
        continue
      }
    }
    unresolved.push(i)
  }
  if (unresolved.length === 0) return results

  // Tier 1 — learned PRODUCT → package mapping (strongest: a human previously
  // confirmed this exact product's package). The only signal allowed to override
  // the material-first insulation rule below.
  {
    const stillUnresolved: number[] = []
    for (const i of unresolved) {
      const p = resolvePkg(lines[i].learnedPackageCode, lines[i].learnedPackageName)
      if (p) setResult(i, p, "high", true)
      else stillUnresolved.push(i)
    }
    unresolved = stillUnresolved
  }

  // Material-first rule — a product that is clearly insulation belongs in the
  // dedicated "Insulation" cost package regardless of where it is installed.
  // Runs BEFORE the broad category-learned and AI tiers so location-based
  // packages can't capture insulation; only a specific learned product mapping
  // (Tier 1 above) can.
  const insulationPkg = byName.get(INSULATION_PACKAGE_NAME.toLowerCase())
  if (insulationPkg) {
    const stillUnresolved: number[] = []
    for (const i of unresolved) {
      const hay = `${lines[i].category ?? ""} ${lines[i].productType ?? ""} ${
        lines[i].normalisedName ?? ""
      } ${lines[i].description ?? ""}`
      if (looksLikeInsulation(hay)) setResult(i, insulationPkg, "high", false)
      else stillUnresolved.push(i)
    }
    unresolved = stillUnresolved
  }

  // Trade-first rule — tiling works/materials belong in the dedicated
  // "Tiling & Splashbacks" package regardless of the room (kitchen, bathroom,
  // en-suite, WC). Mirrors the insulation rule and runs before the broad
  // category-learned and AI tiers so location-based packages (Flooring,
  // Decoration, Kitchens, Bathrooms) can't capture tiling.
  const tilingPkg = byName.get(TILING_PACKAGE_NAME.toLowerCase())
  if (tilingPkg) {
    const stillUnresolved: number[] = []
    for (const i of unresolved) {
      const hay = `${lines[i].category ?? ""} ${lines[i].productType ?? ""} ${
        lines[i].normalisedName ?? ""
      } ${lines[i].description ?? ""}`
      if (looksLikeTiling(hay)) setResult(i, tilingPkg, "high", false)
      else stillUnresolved.push(i)
    }
    unresolved = stillUnresolved
  }

  // Infrastructure rule — adoptable-highway / road-infrastructure works belong
  // in the dedicated "Roads & Infrastructure" package. Conservative matcher (see
  // looksLikeRoadsInfrastructure) so only genuine highway vocabulary is captured
  // and plot drainage / general landscaping stay in 18 / 17 respectively.
  const roadsPkg = byName.get(ROADS_PACKAGE_NAME.toLowerCase())
  if (roadsPkg) {
    const stillUnresolved: number[] = []
    for (const i of unresolved) {
      const hay = `${lines[i].category ?? ""} ${lines[i].productType ?? ""} ${
        lines[i].normalisedName ?? ""
      } ${lines[i].description ?? ""}`
      if (looksLikeRoadsInfrastructure(hay)) setResult(i, roadsPkg, "high", false)
      else stillUnresolved.push(i)
    }
    unresolved = stillUnresolved
  }

  if (unresolved.length === 0) return results

  // Tier 2 — learned CATEGORY → package mapping.
  try {
    const catKeys = [
      ...new Set(unresolved.map((i) => (lines[i].category ?? "").trim().toLowerCase()).filter(Boolean)),
    ]
    if (catKeys.length > 0) {
      const catRows = await db
        .select()
        .from(classificationMappings)
        .where(and(eq(classificationMappings.keyKind, "category"), inArray(classificationMappings.keyValue, catKeys)))
      const byCat = new Map<string, (typeof catRows)[number]>()
      for (const r of catRows) {
        const cur = byCat.get(r.keyValue)
        if (!cur || r.timesConfirmed > cur.timesConfirmed) byCat.set(r.keyValue, r)
      }
      const stillUnresolved: number[] = []
      for (const i of unresolved) {
        const cat = (lines[i].category ?? "").trim().toLowerCase()
        const row = cat ? byCat.get(cat) : undefined
        const p = row ? resolvePkg(row.costPackageCode, row.costPackageName) : undefined
        if (p) setResult(i, p, "medium", true) // broad key → preselect but review-worthy
        else stillUnresolved.push(i)
      }
      unresolved = stillUnresolved
    }
  } catch (err) {
    console.log("[v0] classifyLinesToPlan: category-mapping recall failed:", (err as Error).message)
  }

  if (unresolved.length === 0 || !opts.allowAI) return results

  // Tier 5 — AI reasoning over the plan for the remainder. (Tiers 3–4, supplier/
  // product history, are folded in as the category/type hints the model reasons
  // over.)
  try {
    const aiLines = unresolved.map((i) => ({
      description: lines[i].description,
      category: lines[i].category,
      productType: lines[i].productType,
    }))
    const suggestions = await suggestCostPackages(
      aiLines,
      plan.map((p) => ({ code: p.code, name: p.name })),
    )
    for (const s of suggestions) {
      const lineIndex = unresolved[s.index]
      if (lineIndex == null) continue
      const resolved = resolvePkg(s.packageCode, s.packageName)
      if (resolved) setResult(lineIndex, resolved, s.confidence, false)
    }
  } catch (err) {
    console.log("[v0] classifyLinesToPlan: AI suggestion failed:", (err as Error).message)
  }

  return results
}

/**
 * Project-INDEPENDENT canonical classification against the standard Gilbert OS
 * cost plan. Computed during prepareBatch so a line is classified even before
 * any project is known; the result is carried on each line and mapped onto the
 * project's own plan the instant a project is resolved.
 */
export async function classifyLinesCanonical(lines: LineForSuggestion[]): Promise<ResolvedPackage[]> {
  return classifyLinesToPlan(lines, STANDARD_COST_PLAN, { useCanonical: false, allowAI: true })
}

/**
 * Resolve the best cost package for each line within a specific project. Applies
 * the already-computed canonical classification first (mapping it onto this
 * project's plan), then falls back to learned mappings and AI for anything the
 * canonical stage could not classify.
 */
export async function suggestPackagesForProject(
  projectId: number,
  lines: LineForSuggestion[],
): Promise<ResolvedPackage[]> {
  const packages = await getCostPackagesForProject(projectId)
  return classifyLinesToPlan(lines, packages, { useCanonical: true, allowAI: true })
}
