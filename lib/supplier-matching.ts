// Pure supplier-matching logic. Given an extracted supplier heading and the set
// of existing suppliers (plus any learned aliases), decide whether it maps to
// an existing supplier and how confident we are. Deterministic and dependency
// free so it is cheap, predictable and unit-testable — no model call needed.

import { normaliseSupplierName } from "./invoice-identity"

export type SupplierCandidate = {
  id: number
  name: string
  /** Optional pre-computed normalised form (aliases carry their own). */
  normalised?: string
}

export type SupplierMatchConfidence = "high" | "medium" | "none"

export type SupplierMatch = {
  confidence: SupplierMatchConfidence
  supplierId: number | null
  supplierName: string | null
  score: number
  reason: string
}

function tokens(s: string): string[] {
  return s.split(/\s+/).filter(Boolean)
}

/** Jaccard similarity over token sets (0..1). */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let inter = 0
  for (const t of setA) if (setB.has(t)) inter++
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : inter / union
}

/**
 * Score how well an extracted supplier name matches a single candidate, 0..1.
 * Exact normalised equality is 1. Otherwise we combine token overlap with a
 * containment bonus (one name being a prefix/subset of the other — very common
 * with trading-name variants like "Travis Perkins" vs "Travis Perkins Trading
 * Company").
 */
export function scoreSupplierMatch(extractedNormalised: string, candidateNormalised: string): number {
  if (!extractedNormalised || !candidateNormalised) return 0
  if (extractedNormalised === candidateNormalised) return 1

  const a = tokens(extractedNormalised)
  const b = tokens(candidateNormalised)
  const j = jaccard(a, b)

  // Containment: every token of the shorter name appears in the longer name.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  const longSet = new Set(long)
  const allContained = short.length > 0 && short.every((t) => longSet.has(t))
  const containment = allContained ? short.length / long.length : 0

  // Weight containment heavily — it captures legal/trading suffix variants.
  return Math.max(j, 0.5 + 0.5 * containment * (allContained ? 1 : 0))
}

/**
 * Match an extracted supplier name against existing suppliers/aliases.
 * - score === 1 or >= 0.85 → high confidence (auto-select)
 * - 0.6 .. 0.85           → medium (suggest, ask to confirm)
 * - below 0.6             → none (offer to create new)
 */
export function matchSupplier(extractedName: string | null, candidates: SupplierCandidate[]): SupplierMatch {
  const target = normaliseSupplierName(extractedName)
  if (!target) {
    return { confidence: "none", supplierId: null, supplierName: null, score: 0, reason: "No supplier name was read." }
  }

  let best: { c: SupplierCandidate; score: number } | null = null
  for (const c of candidates) {
    const cn = c.normalised ?? normaliseSupplierName(c.name)
    const score = scoreSupplierMatch(target, cn)
    if (!best || score > best.score) best = { c, score }
  }

  if (!best || best.score < 0.6) {
    return {
      confidence: "none",
      supplierId: null,
      supplierName: null,
      score: best?.score ?? 0,
      reason: "No credible match — this looks like a new supplier.",
    }
  }

  if (best.score >= 0.85) {
    return {
      confidence: "high",
      supplierId: best.c.id,
      supplierName: best.c.name,
      score: best.score,
      reason:
        best.score === 1
          ? `Matches existing supplier ${best.c.name}.`
          : `Confidently matches existing supplier ${best.c.name} (name variant).`,
    }
  }

  return {
    confidence: "medium",
    supplierId: best.c.id,
    supplierName: best.c.name,
    score: best.score,
    reason: `Might be ${best.c.name} — please confirm this is the same supplier.`,
  }
}
