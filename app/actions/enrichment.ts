"use server"

import { db } from "@/lib/db"
import { suppliers, supplierAliases, classificationMappings } from "@/lib/db/schema"
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { normaliseSupplierName, normaliseDocNumber } from "@/lib/invoice-identity"
import { matchSupplier, type SupplierCandidate, type SupplierMatch } from "@/lib/supplier-matching"
import { classifyDocuments } from "@/app/actions/invoices"
import type { DuplicateVerdict } from "@/lib/duplicate-detection"
import { enrichLineItems, suggestCostPackages } from "@/lib/invoice-enrichment"
import {
  normaliseProductName,
  parseDimensions,
  parseThickness,
  suggestTrackPrice,
} from "@/lib/normalisation/products"
import { normaliseUnit } from "@/lib/normalisation/units"
import { validateInvoiceArithmetic } from "@/lib/invoice-validation"
import { getCostPackagesForProject } from "@/lib/queries"

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

export type PrepareDocInput = {
  supplierName: string | null
  invoiceNumber: string | null
  transactionType: "invoice" | "credit"
  invoiceDate: string | null
  net: number | null
  vat: number | null
  gross: number | null
  sourceFileHash: string | null
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
}

export type DocIntelligence = {
  supplierMatch: SupplierMatch
  verdict: DuplicateVerdict
  reconciled: boolean
  reconIssues: string[]
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

// ---------------------------------------------------------------------------
// prepareBatch — the project-independent intelligence pass
// ---------------------------------------------------------------------------

/**
 * Run all project-independent intelligence over a freshly-extracted batch:
 * supplier matching, duplicate classification, product/unit normalisation, the
 * AI enrichment pass, learned-mapping recall and arithmetic validation. Cost
 * packages are resolved separately once a project is chosen (see
 * suggestPackagesForProject) because they depend on the project's cost plan.
 */
export async function prepareBatch(docs: PrepareDocInput[]): Promise<DocIntelligence[]> {
  const candidates = await loadSupplierCandidates()

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
    try {
      const learned = await loadLearnedMappings(
        baseLines.map((l) => l.normalisedName),
        supplierMatch.supplierId,
      )
      for (const line of baseLines) {
        const m = learned.get(line.normalisedName)
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

    out.push({
      supplierMatch,
      verdict: verdicts[d] ?? { status: "new", existing: null, reason: null },
      reconciled: validation.reconciled,
      reconIssues: validation.issues.map((i) => i.message),
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
  /** Cost-package code recalled from a learned mapping, if any. */
  learnedPackageCode: string | null
}

export type ResolvedPackage = {
  packageId: number | null
  packageCode: string | null
  packageName: string | null
  confidence: "high" | "medium" | "low" | "none"
  fromMemory: boolean
}

/**
 * Resolve the best cost package for each line within a specific project. Learned
 * mappings (by package code/name) are applied first and resolved against this
 * project's own cost plan; remaining lines are sent to the model, which may only
 * pick from the project's existing packages.
 */
export async function suggestPackagesForProject(
  projectId: number,
  lines: LineForSuggestion[],
): Promise<ResolvedPackage[]> {
  const packages = await getCostPackagesForProject(projectId)
  const byCode = new Map<string, (typeof packages)[number]>()
  const byName = new Map<string, (typeof packages)[number]>()
  for (const p of packages) {
    if (p.code) byCode.set(p.code.trim().toLowerCase(), p)
    byName.set(p.name.trim().toLowerCase(), p)
  }

  const results: ResolvedPackage[] = lines.map(() => ({
    packageId: null,
    packageCode: null,
    packageName: null,
    confidence: "none",
    fromMemory: false,
  }))

  // 1) Apply learned mappings by resolving the remembered code/name to THIS
  //    project's cost plan.
  const needsAi: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const learnedCode = lines[i].learnedPackageCode
    const resolved =
      (learnedCode ? byCode.get(learnedCode.trim().toLowerCase()) : undefined) ?? undefined
    if (resolved) {
      results[i] = {
        packageId: resolved.id,
        packageCode: resolved.code,
        packageName: resolved.name,
        confidence: "high",
        fromMemory: true,
      }
    } else {
      needsAi.push(i)
    }
  }

  if (packages.length === 0 || needsAi.length === 0) return results

  // 2) AI suggestion for the remainder.
  try {
    const aiLines = needsAi.map((i) => ({
      description: lines[i].description,
      category: lines[i].category,
      productType: lines[i].productType,
    }))
    const suggestions = await suggestCostPackages(
      aiLines,
      packages.map((p) => ({ code: p.code, name: p.name })),
    )
    for (const s of suggestions) {
      const lineIndex = needsAi[s.index]
      if (lineIndex == null || !s.packageCode) continue
      const resolved = byCode.get(s.packageCode.trim().toLowerCase())
      if (resolved) {
        results[lineIndex] = {
          packageId: resolved.id,
          packageCode: resolved.code,
          packageName: resolved.name,
          confidence: s.confidence,
          fromMemory: false,
        }
      }
    }
  } catch (err) {
    console.log("[v0] suggestPackagesForProject: AI suggestion failed:", (err as Error).message)
  }

  return results
}
