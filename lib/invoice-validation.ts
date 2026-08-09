// Pure invoice arithmetic validation. Shared by the review UI (to flag
// documents for attention) and the commit action (to persist a reconciled
// flag). Tolerates legitimate rounding and small invoice-level adjustments.

export type ValidationLine = {
  quantity: number | null
  unitPriceExVat: number | null
  lineNet: number | null
}

export type ValidationInput = {
  lines: ValidationLine[]
  net: number | null
  vat: number | null
  gross: number | null
}

export type ValidationIssue = {
  code: "line_math" | "net_sum" | "gross_sum"
  message: string
}

export type ValidationResult = {
  reconciled: boolean
  issues: ValidationIssue[]
}

// Absolute tolerance in pounds plus a small relative tolerance, to absorb
// per-line rounding and invoice-level adjustments (e.g. settlement discounts).
const ABS_TOLERANCE = 0.02
function within(a: number, b: number, relative = 0.01): boolean {
  const diff = Math.abs(a - b)
  const allow = Math.max(ABS_TOLERANCE, Math.abs(b) * relative)
  return diff <= allow
}

export function validateInvoiceArithmetic(input: ValidationInput): ValidationResult {
  const issues: ValidationIssue[] = []

  // 1) quantity × unit price ≈ line net  (only where all three are present)
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i]
    if (l.quantity != null && l.unitPriceExVat != null && l.lineNet != null) {
      const expected = l.quantity * l.unitPriceExVat
      if (!within(expected, l.lineNet)) {
        issues.push({
          code: "line_math",
          message: `Line ${i + 1}: ${l.quantity} × ${l.unitPriceExVat} = ${expected.toFixed(2)} but line net is ${l.lineNet.toFixed(2)}.`,
        })
      }
    }
  }

  // 2) sum of line nets ≈ invoice net
  const lineNetSum = input.lines.reduce((s, l) => s + (l.lineNet ?? 0), 0)
  if (input.net != null && input.lines.some((l) => l.lineNet != null)) {
    // Allow a slightly wider tolerance here for invoice-level adjustments.
    if (!within(lineNetSum, input.net, 0.02)) {
      issues.push({
        code: "net_sum",
        message: `Line nets total ${lineNetSum.toFixed(2)} but invoice net is ${input.net.toFixed(2)}.`,
      })
    }
  }

  // 3) net + VAT ≈ gross
  if (input.net != null && input.vat != null && input.gross != null) {
    if (!within(input.net + input.vat, input.gross)) {
      issues.push({
        code: "gross_sum",
        message: `Net ${input.net.toFixed(2)} + VAT ${input.vat.toFixed(2)} = ${(input.net + input.vat).toFixed(2)} but gross is ${input.gross.toFixed(2)}.`,
      })
    }
  }

  return { reconciled: issues.length === 0, issues }
}
