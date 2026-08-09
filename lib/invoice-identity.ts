// Pure helpers for normalising financial-document identity. Shared by the
// duplicate-detection logic and safe to import from client or server code.

/**
 * Normalise a supplier name so cosmetic differences (case, punctuation, legal
 * suffixes, spacing) don't defeat duplicate detection. e.g.
 * "Bradfords Building Supplies Limited" -> "bradfords building supplies".
 */
export function normaliseSupplierName(raw: string | null | undefined): string {
  if (!raw) return ""
  let s = raw.toLowerCase()
  // Replace ampersand with "and" so "A & B" == "A and B".
  s = s.replace(/&/g, " and ")
  // Strip anything that isn't a letter, digit or space.
  s = s.replace(/[^a-z0-9\s]/g, " ")
  // Remove common company-form suffixes/words.
  const stopWords = new Set([
    "ltd",
    "limited",
    "plc",
    "llp",
    "llc",
    "inc",
    "incorporated",
    "co",
    "company",
    "group",
    "holdings",
    "uk",
    "the",
  ])
  s = s
    .split(/\s+/)
    .filter((w) => w && !stopWords.has(w))
    .join(" ")
  return s.trim()
}

/**
 * Normalise an invoice / credit-note number for equality checks: trim, upper,
 * and drop spaces and separators so "INV-001 23" == "inv00123".
 */
export function normaliseDocNumber(raw: string | null | undefined): string {
  if (!raw) return ""
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim()
}

/** True when two money amounts match to the penny (tolerates float noise). */
export function amountsClose(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return false
  return Math.round(a * 100) === Math.round(b * 100)
}
