"use server"

import { db } from "@/lib/db"
import { sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { reconcileToControls, round2, type FundingLineInput, type ReconResult } from "@/lib/funding/calculations"
import { isCostType } from "@/lib/funding/cost-types"

export type ScheduleLineInput = {
  description: string
  amount: number
  /** optional hint to the standard cost-plan code for auto-mapping */
  costPackageCode?: string | null
  notes?: string | null
}

export type LoadScheduleInput = {
  projectId: number
  name: string
  lender: string | null
  status?: string
  works: ScheduleLineInput[]
  professionalFees: ScheduleLineInput[]
  controls: {
    worksTotal: number | null
    professionalFeesTotal: number | null
    originalTotal: number | null
    amountToBorrow: number | null
  }
  /** overwrite an existing original budget for this project (default false) */
  replaceExisting?: boolean
}

export type LoadScheduleResult = {
  budgetId: number
  linesInserted: number
  recon: ReconResult
  /** values are stored verbatim; reconciled reflects the control-total check */
  reconciled: boolean
  autoMapped: number
}

/**
 * Create (or replace) a project's ORIGINAL funding budget from a supplied
 * lender schedule. Amounts are stored EXACTLY as supplied — never adjusted to
 * fit the control totals. The reconciliation check is recorded so any
 * discrepancy is surfaced for review rather than silently corrected.
 */
export async function loadFundingSchedule(input: LoadScheduleInput): Promise<LoadScheduleResult> {
  if (!input.works.length && !input.professionalFees.length) {
    throw new Error("A funding schedule must contain at least one line.")
  }

  const lineInputsForRecon: FundingLineInput[] = [
    ...input.works.map((l, i) => ({ id: i, section: "works" as const, description: l.description, originalAmount: l.amount })),
    ...input.professionalFees.map((l, i) => ({
      id: 10000 + i,
      section: "professional_fees" as const,
      description: l.description,
      originalAmount: l.amount,
    })),
  ]
  const recon = reconcileToControls(lineInputsForRecon, input.controls)

  const result = await db.transaction(async (tx): Promise<LoadScheduleResult> => {
    if (input.replaceExisting) {
      const existing = await tx.execute(sql`
        SELECT id FROM funding_budgets WHERE project_id = ${input.projectId} AND is_original = true
      `)
      for (const r of existing.rows as any[]) {
        await tx.execute(sql`DELETE FROM funding_line_package_map WHERE funding_budget_line_id IN
          (SELECT id FROM funding_budget_lines WHERE funding_budget_id = ${r.id})`)
        await tx.execute(sql`DELETE FROM funding_drawdowns WHERE funding_budget_line_id IN
          (SELECT id FROM funding_budget_lines WHERE funding_budget_id = ${r.id})`)
        await tx.execute(sql`DELETE FROM funding_budget_lines WHERE funding_budget_id = ${r.id}`)
        await tx.execute(sql`DELETE FROM funding_budgets WHERE id = ${r.id}`)
      }
    }

    const budgetRows = await tx.execute(sql`
      INSERT INTO funding_budgets
        (project_id, name, lender, status, is_original, works_total,
         professional_fees_total, original_total, amount_to_borrow, reconciled)
      VALUES
        (${input.projectId}, ${input.name}, ${input.lender},
         ${input.status ?? "original_locked"}, true,
         ${input.controls.worksTotal}, ${input.controls.professionalFeesTotal},
         ${input.controls.originalTotal}, ${input.controls.amountToBorrow}, ${recon.ok})
      RETURNING id
    `)
    const budgetId = Number((budgetRows.rows as any[])[0].id)

    let position = 0
    let inserted = 0
    const insertLine = async (l: ScheduleLineInput, section: "works" | "professional_fees") => {
      await tx.execute(sql`
        INSERT INTO funding_budget_lines
          (funding_budget_id, section, description, original_amount, cost_package_code, notes, position)
        VALUES
          (${budgetId}, ${section}, ${l.description}, ${l.amount},
           ${l.costPackageCode ?? null}, ${l.notes ?? null}, ${position})
      `)
      position++
      inserted++
    }
    for (const l of input.works) await insertLine(l, "works")
    for (const l of input.professionalFees) await insertLine(l, "professional_fees")

    // Auto-map lines that carry a cost-package code hint onto this project's
    // packages sharing that code. Many-to-many is preserved; nothing is forced.
    const autoRows = await tx.execute(sql`
      INSERT INTO funding_line_package_map (funding_budget_line_id, cost_package_id)
      SELECT l.id, cp.id
      FROM funding_budget_lines l
      JOIN cost_packages cp
        ON cp.project_id = ${input.projectId}
       AND lower(cp.code) = lower(l.cost_package_code)
      WHERE l.funding_budget_id = ${budgetId} AND l.cost_package_code IS NOT NULL
      ON CONFLICT (funding_budget_line_id, cost_package_id) DO NOTHING
      RETURNING id
    `)

    return { budgetId, linesInserted: inserted, recon, reconciled: recon.ok, autoMapped: (autoRows.rows as any[]).length }
  })

  revalidatePath("/commercial")
  revalidatePath("/projects")
  return result
}

/** Map (or update the weight of) a funding line ↔ cost package edge. */
export async function mapFundingLineToPackage(fundingBudgetLineId: number, costPackageId: number, weight: number | null = null) {
  await db.execute(sql`
    INSERT INTO funding_line_package_map (funding_budget_line_id, cost_package_id, weight)
    VALUES (${fundingBudgetLineId}, ${costPackageId}, ${weight})
    ON CONFLICT (funding_budget_line_id, cost_package_id)
    DO UPDATE SET weight = ${weight}
  `)
  revalidatePath("/commercial")
}

export async function unmapFundingLineFromPackage(fundingBudgetLineId: number, costPackageId: number) {
  await db.execute(sql`
    DELETE FROM funding_line_package_map
    WHERE funding_budget_line_id = ${fundingBudgetLineId} AND cost_package_id = ${costPackageId}
  `)
  revalidatePath("/commercial")
}

/** Set the manual forecast cost-to-complete for a funding line. Never touches the original amount. */
export async function setFundingLineForecast(fundingBudgetLineId: number, forecastToComplete: number | null) {
  await db.execute(sql`
    UPDATE funding_budget_lines
    SET forecast_to_complete = ${forecastToComplete == null ? null : round2(forecastToComplete)}
    WHERE id = ${fundingBudgetLineId}
  `)
  revalidatePath("/commercial")
}

/** Upsert completion-driven drawdown figures for a funding line. */
export async function upsertFundingDrawdown(input: {
  fundingBudgetLineId: number
  workCompletePct?: number | null
  fundingCertified?: number | null
  fundingDrawn?: number | null
  notes?: string | null
}) {
  await db.execute(sql`
    INSERT INTO funding_drawdowns
      (funding_budget_line_id, work_complete_pct, funding_certified, funding_drawn, notes)
    VALUES
      (${input.fundingBudgetLineId}, ${input.workCompletePct ?? null},
       ${input.fundingCertified ?? null}, ${input.fundingDrawn ?? null}, ${input.notes ?? null})
    ON CONFLICT (funding_budget_line_id) DO UPDATE SET
      work_complete_pct = EXCLUDED.work_complete_pct,
      funding_certified = EXCLUDED.funding_certified,
      funding_drawn = EXCLUDED.funding_drawn,
      notes = EXCLUDED.notes,
      updated_at = now()
  `)
  revalidatePath("/commercial")
}

/** Classify the cost type of an actual-cost invoice line. Rejects unknown values. */
export async function setInvoiceLineCostType(invoiceLineItemId: number, costType: string | null) {
  if (costType != null && !isCostType(costType)) {
    throw new Error(`Unknown cost type: ${costType}`)
  }
  await db.execute(sql`
    UPDATE invoice_line_items SET cost_type = ${costType} WHERE id = ${invoiceLineItemId}
  `)
  revalidatePath("/commercial")
  revalidatePath("/invoices")
}
