/**
 * Cost Type dimension for actual costs (Phase 2A).
 *
 * These describe HOW money was spent, independent of which cost package or
 * funding line it belongs to. Own direct LABOUR is intentionally excluded from
 * the supplier-invoice ingestion workflow (it is handled separately), but the
 * value exists here so labour can later feed full economic-cost reporting
 * without migrating or corrupting historic invoice data.
 */
export const COST_TYPES = [
  { value: "materials", label: "Materials" },
  { value: "plant_hire", label: "Plant / Hire" },
  { value: "subcontract", label: "Subcontract" },
  { value: "other", label: "Other" },
  { value: "professional_fees", label: "Professional Fees" },
] as const

export type CostType = (typeof COST_TYPES)[number]["value"]

/** Cost type reserved for the separate labour workflow — never set via invoices. */
export const LABOUR_COST_TYPE = "labour"

const VALID = new Set<string>([...COST_TYPES.map((c) => c.value), LABOUR_COST_TYPE])

export function isCostType(v: unknown): v is CostType {
  return typeof v === "string" && VALID.has(v)
}

export function costTypeLabel(v: string | null | undefined): string {
  if (!v) return "Unclassified"
  const found = COST_TYPES.find((c) => c.value === v)
  if (found) return found.label
  if (v === LABOUR_COST_TYPE) return "Labour"
  return v
}
