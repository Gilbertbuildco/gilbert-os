import { NextResponse } from "next/server"
import { getLineItemsForInvoice } from "@/lib/queries"

/**
 * Line items for a single invoice, fetched on demand when a row in the
 * invoices table is expanded — not preloaded for every invoice on the page.
 * Read-only; no financial field is ever written here.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const invoiceId = Number(id)
  if (!Number.isFinite(invoiceId)) {
    return NextResponse.json({ error: "Invalid invoice id" }, { status: 400 })
  }
  const lineItems = await getLineItemsForInvoice(invoiceId)
  return NextResponse.json(lineItems)
}
