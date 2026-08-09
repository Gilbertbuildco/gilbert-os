import "server-only"
import { generateObject } from "ai"
import { z } from "zod"

// Same zero-config vision/text models used by extraction, tried in order so a
// rate-limit or availability issue on one falls back to the next. Enrichment is
// text-only (it reasons over descriptions), so any capable model works.
const ENRICHMENT_MODELS = ["google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function generateWithFallback<T>(schema: z.ZodType<T>, instructions: string, prompt: string): Promise<T | null> {
  let lastError = ""
  for (const model of ENRICHMENT_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { object } = await generateObject({ model, schema, instructions, prompt })
        return object
      } catch (err) {
        const message = (err as Error).message ?? ""
        lastError = message
        console.log(`[v0] enrichment attempt failed (${model}):`, message)
        if (/rate.?limit|429/i.test(message) && attempt === 0) {
          await sleep(1200)
          continue
        }
        break
      }
    }
  }
  console.log("[v0] enrichment gave up:", lastError)
  return null
}

// ---------------------------------------------------------------------------
// 1. Product normalisation + categorisation + track-price suggestion
// ---------------------------------------------------------------------------

const lineEnrichmentSchema = z.object({
  index: z.number().int().describe("The 0-based index of the line this refers to"),
  manufacturer: z.string().nullable().describe("Brand/manufacturer if clearly identifiable, else null"),
  productFamily: z.string().nullable().describe("Product family/range if identifiable, else null"),
  productType: z.string().nullable().describe("Generic product type, e.g. 'Insulation board', 'Timber batten'"),
  category: z.string().nullable().describe("High-level material category, e.g. 'Insulation', 'Timber', 'Fixings'"),
  subcategory: z.string().nullable().describe("More specific subcategory if useful, else null"),
  isMaterial: z
    .boolean()
    .describe("true if this is a genuine comparable construction material; false for delivery/carriage/rebate/discount/labour/service/adjustment lines"),
})

const enrichmentResponseSchema = z.object({
  lines: z.array(lineEnrichmentSchema),
})

export type LineEnrichment = z.infer<typeof lineEnrichmentSchema>

export type EnrichmentLineInput = {
  description: string
  unit: string | null
  unitPriceExVat: number | null
}

/**
 * Enrich a document's line items with structured product identity, a material
 * category and whether the line represents a genuine trackable material. Best
 * effort: returns an empty array on failure so callers fall back to their own
 * deterministic heuristics. NEVER fabricates specs it cannot infer.
 */
export async function enrichLineItems(
  supplierName: string | null,
  lines: EnrichmentLineInput[],
): Promise<LineEnrichment[]> {
  if (lines.length === 0) return []

  const instructions =
    "You are a UK construction procurement assistant. For each invoice line you are given, infer structured " +
    "product information ONLY where you can do so confidently from the description. Do NOT invent manufacturers, " +
    "dimensions or specifications that are not evident. Decide whether each line is a genuine comparable " +
    "construction material (isMaterial = true) or something that should not become a procurement product such as " +
    "delivery, carriage, haulage, fuel surcharge, rebate, discount, retention, account adjustment, labour, plant " +
    "hire or a service charge (isMaterial = false). Return one entry per input line, preserving the given index."

  const prompt =
    `Supplier: ${supplierName ?? "Unknown"}\n\nLines:\n` +
    lines
      .map(
        (l, i) =>
          `${i}. "${l.description}"${l.unit ? ` (unit: ${l.unit})` : ""}${
            l.unitPriceExVat != null ? ` (unit price ex VAT: £${l.unitPriceExVat})` : ""
          }`,
      )
      .join("\n")

  const result = await generateWithFallback(enrichmentResponseSchema, instructions, prompt)
  if (!result) return []
  return result.lines ?? []
}

// ---------------------------------------------------------------------------
// 2. Cost-package suggestion against a specific project's cost plan
// ---------------------------------------------------------------------------

const packageSuggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      index: z.number().int().describe("0-based index of the line"),
      packageCode: z
        .string()
        .nullable()
        .describe("The CODE of the best-matching cost package from the provided list, or null if none is appropriate"),
      confidence: z.enum(["high", "medium", "low"]).describe("How confident this mapping is"),
    }),
  ),
})

export type PackageSuggestion = { index: number; packageCode: string | null; confidence: "high" | "medium" | "low" }

export type PackageOptionForAI = { code: string | null; name: string }
export type LineForPackaging = { description: string; category: string | null; productType: string | null }

/**
 * Ask the model to map each line to the most appropriate EXISTING cost package
 * from the project's cost plan. It may only choose from the provided list (by
 * code) or return null — it must never invent a package.
 */
export async function suggestCostPackages(
  lines: LineForPackaging[],
  packages: PackageOptionForAI[],
): Promise<PackageSuggestion[]> {
  if (lines.length === 0 || packages.length === 0) return []

  const instructions =
    "You are mapping construction invoice lines to a project's existing cost plan. You may ONLY choose a cost " +
    "package from the provided list, identified by its CODE. If no package is a sensible fit, return null for that " +
    "line — never invent a package. Prefer the most specific appropriate package. Use the material category and " +
    "product type as strong hints."

  const packageList = packages
    .map((p) => `- code: ${p.code ?? "(none)"} | name: ${p.name}`)
    .join("\n")
  const lineList = lines
    .map(
      (l, i) =>
        `${i}. "${l.description}"${l.category ? ` [category: ${l.category}]` : ""}${
          l.productType ? ` [type: ${l.productType}]` : ""
        }`,
    )
    .join("\n")

  const prompt = `Available cost packages:\n${packageList}\n\nInvoice lines:\n${lineList}`

  const result = await generateWithFallback(packageSuggestionSchema, instructions, prompt)
  if (!result) return []
  return result.suggestions ?? []
}
