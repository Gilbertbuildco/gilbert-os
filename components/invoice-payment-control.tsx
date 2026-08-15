"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ChevronDown, Loader2 } from "lucide-react"
import { setInvoicePayment } from "@/app/actions/invoices"
import { PaymentStatusBadge, type PaymentStatusValue } from "@/components/payment-status-badge"

interface Props {
  invoiceId: number
  paymentStatus: PaymentStatusValue
  paidDate: string | null
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Cash-flow control for a single invoice row. Records payment state only —
 * never touches net/vat/gross. Follows the mutate-then-router.refresh()
 * pattern used by CommercialView's PackageRow / LineItemCard.
 */
export function InvoicePaymentControl({ invoiceId, paymentStatus, paidDate }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState(paidDate ?? todayIso())
  const [isPending, startTransition] = useTransition()

  function apply(status: PaymentStatusValue, paidDateValue: string | null) {
    setOpen(false)
    startTransition(async () => {
      await setInvoicePayment(invoiceId, {
        paymentStatus: status,
        paidDate: paidDateValue,
        paymentNotes: null,
      })
      router.refresh()
    })
  }

  return (
    <div
      className="relative inline-block text-left"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false)
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={isPending}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex min-h-9 items-center gap-1 rounded-md px-1 py-0.5 text-left transition-opacity hover:opacity-80 disabled:opacity-60 max-sm:min-h-10"
      >
        <PaymentStatusBadge status={paymentStatus} paidDate={paidDate} />
        {isPending ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" strokeWidth={2} />
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground" strokeWidth={1.75} />
        )}
      </button>

      {open ? (
        <div role="menu" className="absolute left-0 z-20 mt-1 w-56 rounded-md border border-border bg-card p-2 shadow-md">
          <div className="flex items-center gap-1.5 border-b border-border pb-2">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label="Paid date"
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 text-xs text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
            />
            <button
              type="button"
              role="menuitem"
              onClick={() => apply("paid", date || todayIso())}
              className="h-9 shrink-0 rounded-md border border-success/40 bg-success-bg px-2.5 text-xs font-semibold text-success hover:opacity-90"
            >
              Mark paid
            </button>
          </div>
          <div className="flex flex-col pt-2">
            <button
              type="button"
              role="menuitem"
              onClick={() => apply("part_paid", null)}
              className="min-h-9 rounded-md px-2 py-1.5 text-left text-xs font-medium text-foreground hover:bg-muted"
            >
              Mark part paid
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => apply("unpaid", null)}
              className="min-h-9 rounded-md px-2 py-1.5 text-left text-xs font-medium text-foreground hover:bg-muted"
            >
              Mark unpaid
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => apply(null, null)}
              className="min-h-9 rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted"
            >
              Clear (not recorded)
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
