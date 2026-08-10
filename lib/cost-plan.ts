/**
 * The standard Gilbert OS cost plan.
 *
 * This is the canonical set of cost packages every standard project is seeded
 * with. It is the single source of truth used in three places:
 *   1. Seeding a new project's cost packages (see app/actions/projects.ts).
 *   2. Project-INDEPENDENT cost-package classification — a line item is
 *      classified against this canonical plan (by code + name) BEFORE any
 *      project is known, so an unknown project can never leave an otherwise
 *      obvious classification blank.
 *   3. Resolving a canonical classification onto a specific project's own cost
 *      packages once a project is chosen.
 *
 * Because classification is stored by CODE + NAME (not a project-specific row
 * id), a confirmed mapping — e.g. "Soprema XR4000 → 19 · Insulation" — remains
 * useful on any other project that uses this same standard plan.
 */
export type StandardPackage = { code: string; name: string }

export const STANDARD_COST_PLAN: StandardPackage[] = [
  { code: "01", name: "Preliminaries" },
  { code: "02", name: "Groundworks & Foundations" },
  { code: "03", name: "Superstructure - Frame" },
  { code: "04", name: "External Walls & Cladding" },
  { code: "05", name: "Roofing" },
  { code: "06", name: "Windows & External Doors" },
  { code: "07", name: "Internal Walls & Partitions" },
  { code: "08", name: "First Fix Carpentry" },
  { code: "09", name: "Plumbing & Heating" },
  { code: "10", name: "Electrical" },
  { code: "11", name: "Plastering & Drylining" },
  { code: "12", name: "Second Fix Carpentry" },
  { code: "13", name: "Kitchens" },
  { code: "14", name: "Bathrooms & Sanitaryware" },
  { code: "15", name: "Decoration" },
  { code: "16", name: "Flooring" },
  { code: "17", name: "External Works & Landscaping" },
  { code: "18", name: "Drainage" },
  { code: "19", name: "Insulation" },
  // Trade-first package: ALL tiling works/materials regardless of room (wall &
  // floor tiling, splashbacks, tile adhesive/grout). Appended as code 20 so
  // existing package numbering is never disturbed.
  { code: "20", name: "Tiling & Splashbacks" },
  // Infrastructure package: costs specifically attributable to road/highway
  // infrastructure — adoptable highway construction, road formation/sub-base,
  // kerbs, surfacing, and highway drainage that forms part of the adoptable
  // highway works. NOT normal plot drainage (stays 18) and NOT landscaping/
  // paving/patios (stays 17). Appended as code 21 (no renumbering).
  { code: "21", name: "Roads & Infrastructure" },
]

/** The canonical name of the dedicated insulation package (material-first rule). */
export const INSULATION_PACKAGE_NAME = "Insulation"

/** The canonical name of the dedicated tiling package (trade-first rule). */
export const TILING_PACKAGE_NAME = "Tiling & Splashbacks"

/** The canonical name of the dedicated roads/highway infrastructure package. */
export const ROADS_PACKAGE_NAME = "Roads & Infrastructure"

/**
 * Project statuses that count as "active / live" for the single-project default
 * rule. Kept in sync with the portfolio stats query. Compared case-insensitively.
 */
export const ACTIVE_PROJECT_STATUSES = ["on site", "in progress", "active"]

export function isActiveStatus(status: string | null | undefined): boolean {
  if (!status) return false
  return ACTIVE_PROJECT_STATUSES.includes(status.trim().toLowerCase())
}

/** A cost package belonging to a specific project. */
export type ProjectPackage = { id: number; code: string | null; name: string }

/**
 * Resolve a canonical classification (a cost-package CODE and/or NAME from the
 * standard plan, or one recalled from a learned mapping) onto a specific
 * project's own cost packages. Matches by code first, then by exact name
 * (case-insensitive) — the name fallback is what keeps learning working across
 * projects whose plans share names but not necessarily identical codes.
 *
 * Pure and dependency-free so it can run on the client (instant, no round-trip)
 * as soon as a project's packages have been fetched.
 */
export function resolveProjectPackage(
  code: string | null | undefined,
  name: string | null | undefined,
  packages: ProjectPackage[],
): ProjectPackage | undefined {
  if (code) {
    const c = code.trim().toLowerCase()
    const byCode = packages.find((p) => p.code && p.code.trim().toLowerCase() === c)
    if (byCode) return byCode
  }
  if (name) {
    const n = name.trim().toLowerCase()
    const byName = packages.find((p) => p.name.trim().toLowerCase() === n)
    if (byName) return byName
  }
  return undefined
}

/** Detect an insulation product from any available descriptive text. */
export function looksLikeInsulation(text: string): boolean {
  return /insulation|insulated|insulating/.test(text.toLowerCase())
}

/**
 * Detect a tiling work/material from any available descriptive text. Trade-first
 * rule: tiling is classified by the activity/material, NOT by the room it is
 * installed in. Matches tiles and the tiling-specific consumables (adhesive,
 * grout, spacers, trims, backer boards) while avoiding obvious false positives
 * like "roof tile" / "floor tile" carpeting, and "tilt".
 */
export function looksLikeTiling(text: string): boolean {
  const t = text.toLowerCase()
  // Roof tiles are a Roofing item, not this trade — exclude them explicitly.
  if (/\broof\s*tile/.test(t)) return false
  return (
    /\bwall\s*&?\s*floor\s*til/.test(t) ||
    /\bsplashback/.test(t) ||
    /\btil(e|es|ing)\b/.test(t) ||
    /\btile\s*(adhesive|grout|spacer|trim|backer)/.test(t) ||
    /\b(tile\s*)?grout\b/.test(t) ||
    /\btanking\b/.test(t)
  )
}

/**
 * Detect road/highway infrastructure works from descriptive text. Deliberately
 * conservative: it targets adoptable-highway vocabulary (S38, road formation/
 * sub-base, kerbs, tarmac/asphalt surfacing, highway/road drainage) and avoids
 * generic external-works words. Highway drainage counts here ONLY when the text
 * also signals highway/road context — plain plot drainage stays package 18.
 */
export function looksLikeRoadsInfrastructure(text: string): boolean {
  const t = text.toLowerCase()
  const highwayContext =
    /\b(adoptable|highway|highways|carriageway|s38|section\s*38|road\s*(construction|formation|surfac|sub[-\s]?base|base\s*course))\b/.test(
      t,
    )
  const surfacing = /\b(tarmac|tarmacadam|asphalt|bitmac|macadam|blacktop|road\s*plan(e|ing))\b/.test(t)
  const kerbs = /\b(kerb|kerbs|kerbing|kerbstone)\b/.test(t)
  const highwayDrainage =
    /\b(gully|gullies|road\s*gully|highway\s*drain|carriageway\s*drain)\b/.test(t) && highwayContext
  return highwayContext || surfacing || kerbs || highwayDrainage
}
