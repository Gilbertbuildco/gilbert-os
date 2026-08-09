// Pure, deterministic helpers for making sense of raw merchant line
// descriptions WITHOUT calling a model. These are conservative: they only
// extract things that are unambiguously present in the text, and they never
// fabricate specifications. The AI enrichment pass layers richer structure
// (manufacturer, product family, category) on top of these.

/**
 * Pull a dimensions string like "1200x2400x150" out of a description.
 * Returns the matched dimension token, or null if none is present.
 */
export function parseDimensions(description: string): string | null {
  if (!description) return null
  // e.g. 1200x2400x150, 100 x 50, 2.4x1.2  (x, ×, or *)
  const m = description.match(/\b(\d+(?:\.\d+)?\s*[x×*]\s*\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?)?)\b/i)
  if (!m) return null
  return m[1].replace(/\s+/g, "").replace(/[×*]/g, "x")
}

/**
 * Best-effort thickness: an explicit "150mm"/"18 mm" token, otherwise the last
 * component of a 3-part dimension string (commonly the board thickness).
 */
export function parseThickness(description: string): string | null {
  if (!description) return null
  const explicit = description.match(/\b(\d+(?:\.\d+)?)\s?mm\b/i)
  if (explicit) return `${explicit[1]}mm`
  const dims = parseDimensions(description)
  if (dims) {
    const parts = dims.split("x")
    if (parts.length === 3) return `${parts[2]}mm`
  }
  return null
}

// Tokens that indicate an order/quote reference rather than product identity.
const NOISE_PATTERNS: RegExp[] = [
  /\bpriced?\s+from\s+quote\b.*$/i,
  /\bquote\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i,
  /\bq\d{4,}\b/i, // bare quote codes like Q433730
  /\border\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i,
  /\bref\.?\s*[:#]?\s*[a-z0-9-]+/i,
]

/**
 * Produce a normalised product name from a raw merchant description: uppercase,
 * strip quote/order-reference noise, collapse whitespace. This is only an
 * identity *key* — the original description is always preserved separately.
 */
export function normaliseProductName(description: string): string {
  if (!description) return ""
  let s = description
  for (const re of NOISE_PATTERNS) s = s.replace(re, " ")
  return s.replace(/\s+/g, " ").trim().toUpperCase()
}

/**
 * A stable, lowercased key for a raw description, used to look up and store
 * learned classification mappings. Strips punctuation and reference noise so
 * cosmetic differences ("18mm OSB3" vs "OSB3 18 mm.") collapse to one key.
 */
export function normaliseDescriptionKey(description: string): string {
  return normaliseProductName(description)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Keywords for lines that are charges/adjustments/services rather than genuine
// comparable construction materials. These should NOT pollute the procurement
// price database (they may still be legitimate project costs).
const NON_PRODUCT_PATTERNS: RegExp[] = [
  /\bdelivery\b/i,
  /\bcarriage\b/i,
  /\bhaulage\b/i,
  /\bfreight\b/i,
  /\bcollection\b/i,
  /\bsurcharge\b/i,
  /\bfuel\s*(?:surcharge|levy)\b/i,
  /\benvironmental\s*(?:charge|levy)\b/i,
  /\brebate\b/i,
  /\bdiscount\b/i,
  /\bretention\b/i,
  /\bcredit\b/i,
  /\brefund\b/i,
  /\badjustment\b/i,
  /\baccount\b.*\b(?:charge|adjustment|fee)\b/i,
  /\bmisc(?:ellaneous)?\b/i,
  /\badmin(?:istration)?\s*fee\b/i,
  /\bhandling\s*(?:charge|fee)\b/i,
  /\blabour\b/i,
  /\bhire\b/i,
  /\bplant\s*hire\b/i,
  /\bservice\s*charge\b/i,
  /\bwaste\b/i,
  /\bskip\b/i,
  /\bdeposit\b/i,
  /\bpallet\s*(?:charge|deposit)\b/i,
]

export type TrackPriceSuggestion = {
  /** true = looks like a genuine comparable material worth price-tracking. */
  suggested: boolean
  /** Short reason for the suggestion, shown in the review UI. */
  reason: string
  /** How sure we are about this deterministic call. */
  confidence: "high" | "medium" | "low"
}

/**
 * Decide whether a line should feed the procurement price database. Charges,
 * carriage, rebates, discounts, labour, hire etc. are excluded; genuine
 * materials are included. Ambiguous lines are included but flagged low so the
 * reviewer can confirm.
 */
export function suggestTrackPrice(description: string, unitPriceExVat: number | null): TrackPriceSuggestion {
  const desc = description ?? ""
  for (const re of NON_PRODUCT_PATTERNS) {
    if (re.test(desc)) {
      return {
        suggested: false,
        reason: "Looks like a charge, service or adjustment rather than a material.",
        confidence: "high",
      }
    }
  }
  if (unitPriceExVat == null || unitPriceExVat === 0) {
    return {
      suggested: false,
      reason: "No unit price, so there is nothing to price-track.",
      confidence: "medium",
    }
  }
  return { suggested: true, reason: "Looks like a genuine material line.", confidence: "medium" }
}
