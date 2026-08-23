/**
 * Display groupings for the lender's funding lines.
 *
 * THE LENDER'S BASELINE IS NEVER REWRITTEN (non-negotiable #2). Goldentree's
 * schedule keeps its own lines, descriptions, values and order in the database
 * and on the Goldentree tab, which mirrors their document exactly. These groups
 * exist ONLY to present related lines as one row where the split is an artefact
 * of their paperwork rather than a real distinction in how the work is bought.
 *
 * Owner, 2026-08-23: first and second fix plumbing are one trade to him, as are
 * first and second fix electrical. Splitting them made both look misleading —
 * First Fix Plumbing carried the whole plumbing spend while Second Fix sat
 * untouched, so one read as over budget and the other as barely started.
 *
 * Grouping is by line id, not description, so a wording change cannot silently
 * re-group real money.
 */
export type LineGroup = { key: string; label: string; lineIds: number[] }

export const LINE_GROUPS: LineGroup[] = [
  {
    key: "electrical",
    label: "Electrical (first and second fix)",
    // #68 "Second Fix Electrical (Included in)" carries a £0 allowance — the
    // lender folded it into first fix — so the split was never meaningful.
    lineIds: [67, 68],
  },
  {
    key: "plumbing",
    label: "Plumbing (first and second fix)",
    lineIds: [69, 70],
  },
]

/** The group a line belongs to, or null when it stands alone. */
export function groupFor(lineId: number): LineGroup | null {
  return LINE_GROUPS.find((g) => g.lineIds.includes(lineId)) ?? null
}

/**
 * Collapse rows into their display groups, summing the numeric fields named in
 * `sum`. The first member's position is kept so grouped rows stay where the
 * lender put them.
 */
export function applyLineGroups<T extends { lineId?: number; id?: number; description: string }>(
  rows: T[],
  sum: (keyof T)[],
): T[] {
  const out: T[] = []
  const done = new Set<string>()
  for (const r of rows) {
    const id = (r.lineId ?? r.id) as number
    const g = groupFor(id)
    if (!g) { out.push(r); continue }
    if (done.has(g.key)) continue
    done.add(g.key)
    const members = rows.filter((x) => g.lineIds.includes((x.lineId ?? x.id) as number))
    const merged: any = { ...r, description: g.label }
    for (const k of sum) {
      const vals = members.map((m) => m[k]).filter((v) => typeof v === "number") as number[]
      merged[k] = vals.length ? vals.reduce((a, b) => a + b, 0) : (r[k] as any)
    }
    out.push(merged as T)
  }
  return out
}
