import { NextResponse } from "next/server"
import { getLineItemsForInvoice, getCostPackageOptions, getClassificationSuggestions } from "@/lib/queries"

/**
 * Line items for a single invoice, fetched on demand when a row in the
 * invoices table is expanded — not preloaded for every invoice on the page.
 * Read-only; no financial field is ever written here.
 *
 * When called with `?projectId=NN`, also returns that project's cost-package
 * options and any learned classification suggestions for this invoice's
 * unclassified lines — everything the inline classifier picker needs in one
 * round trip. Without a projectId (invoice has no project yet) both come
 * back empty; classification is blocked until a project is assigned.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const invoiceId = Number(id)
  if (!Number.isFinite(invoiceId)) {
    return NextResponse.json({ error: "Invalid invoice id" }, { status: 400 })
  }

  const { searchParams } = new URL(request.url)
  const projectIdParam = searchParams.get("projectId")
  const projectId = projectIdParam != null && projectIdParam !== "" ? Number(projectIdParam) : null
  const hasProject = projectId != null && Number.isFinite(projectId)

  const [lineItems, costPackageOptions, suggestions] = await Promise.all([
    getLineItemsForInvoice(invoiceId),
    hasProject ? getCostPackageOptions(projectId as number) : Promise.resolve([]),
    hasProject ? getClassificationSuggestions([invoiceId]) : Promise.resolve([]),
  ])

  return NextResponse.json({ lineItems, costPackageOptions, suggestions })
}
