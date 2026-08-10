/**
 * Confidence-based project matching.
 *
 * Project assignment and cost-package classification are independent decisions.
 * This module resolves ONLY the project, from whatever identifying text a
 * document carries plus a light historical signal, and never invents projects.
 *
 * Rules (mirroring the product spec):
 *   - Exactly ONE active project      → HIGH (auto-assign; the single-project
 *                                        default is just this case).
 *   - Clear, unique textual match     → HIGH (auto-assign).
 *   - Partial / ambiguous / historical→ MEDIUM (preselect, but flag for review).
 *   - Nothing to go on                 → NONE (leave unassigned, flag review).
 */
export type MatchProject = { id: number; name: string; slug: string; location: string | null }

export type ProjectMatchConfidence = "high" | "medium" | "low" | "none"

export type ProjectMatch = {
  projectId: number | null
  confidence: ProjectMatchConfidence
  reason: string
}

// Generic words that appear in many development names and must not, on their
// own, constitute a match (otherwise "Phase 2" would match every "... Phase").
const STOPWORDS = new Set([
  "farm",
  "phase",
  "the",
  "project",
  "development",
  "park",
  "court",
  "house",
  "road",
  "street",
  "lane",
  "close",
  "gardens",
  "site",
  "homes",
  "land",
  "estate",
  "fields",
  "meadow",
  "meadows",
  "view",
  "hill",
  "green",
])

function tokens(value: string | null | undefined): string[] {
  if (!value) return []
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
}

/** Distinctive (non-stopword) tokens of a project name/location/slug. */
function distinctiveTokens(p: MatchProject): string[] {
  const all = [...tokens(p.name), ...tokens(p.location), ...tokens(p.slug)]
  return [...new Set(all.filter((t) => !STOPWORDS.has(t)))]
}

type Scored = { project: MatchProject; score: number; distinctiveHits: number }

function scoreProject(project: MatchProject, haystack: string): Scored {
  const hay = ` ${haystack.toLowerCase()} `
  let score = 0
  let distinctiveHits = 0

  // Full name / location present verbatim is the strongest textual signal.
  const nameLc = project.name.trim().toLowerCase()
  if (nameLc.length >= 3 && hay.includes(nameLc)) score += 5
  const locLc = (project.location ?? "").trim().toLowerCase()
  if (locLc.length >= 3 && hay.includes(locLc)) score += 3

  // Distinctive token overlap.
  for (const t of distinctiveTokens(project)) {
    if (hay.includes(` ${t} `) || hay.includes(`${t}`)) {
      score += 1
      distinctiveHits += 1
    }
  }
  return { project, score, distinctiveHits }
}

/**
 * @param haystack        All identifying text from the document (supplier,
 *                        references, addresses, line descriptions, notes).
 * @param activeProjects  The current active/live projects.
 * @param opts.supplierHistoryProjectId  An active project this document's
 *                        supplier has historically (and unambiguously) been
 *                        billed to — a soft MEDIUM signal only.
 */
export function matchProject(
  haystack: string,
  activeProjects: MatchProject[],
  opts: { supplierHistoryProjectId?: number | null } = {},
): ProjectMatch {
  if (activeProjects.length === 0) {
    return { projectId: null, confidence: "none", reason: "No active projects" }
  }

  // Single active project default rule — reusable, not hard-coded to a name.
  if (activeProjects.length === 1) {
    return {
      projectId: activeProjects[0].id,
      confidence: "high",
      reason: "Only one active project",
    }
  }

  const scored = activeProjects
    .map((p) => scoreProject(p, haystack))
    .sort((a, b) => b.score - a.score)

  const top = scored[0]
  const runnerUp = scored[1]

  // A clear, unambiguous textual winner → HIGH.
  if (
    top.score >= 5 &&
    top.distinctiveHits >= 1 &&
    (!runnerUp || top.score - runnerUp.score >= 3)
  ) {
    return {
      projectId: top.project.id,
      confidence: "high",
      reason: `Matched "${top.project.name}" from the document`,
    }
  }

  // A weaker but present textual signal → MEDIUM (preselect + flag).
  if (top.score >= 1) {
    return {
      projectId: top.project.id,
      confidence: "medium",
      reason: `Likely "${top.project.name}" — please confirm`,
    }
  }

  // No text signal: fall back to the supplier's historical project → MEDIUM.
  if (opts.supplierHistoryProjectId != null) {
    const p = activeProjects.find((a) => a.id === opts.supplierHistoryProjectId)
    if (p) {
      return {
        projectId: p.id,
        confidence: "medium",
        reason: `This supplier's invoices usually go to "${p.name}" — please confirm`,
      }
    }
  }

  return { projectId: null, confidence: "none", reason: "Project needs review" }
}
