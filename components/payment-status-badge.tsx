import { StatusBadge, type StatusVariant } from "@/components/status-badge"
import { cn } from "@/lib/utils"

/** Mirrors invoices.paymentStatus. Null means "not recorded" — never inferred as unpaid. */
export type PaymentStatusValue = "unpaid" | "paid" | "part_paid" | null

interface Props {
  status: PaymentStatusValue
  paidDate?: string | null
  className?: string
}

type Key = "paid" | "unpaid" | "part_paid" | "unrecorded"

const LABELS: Record<Key, string> = {
  paid: "Paid",
  unpaid: "Unpaid",
  part_paid: "Part paid",
  unrecorded: "Not recorded",
}

const VARIANTS: Record<Key, StatusVariant> = {
  paid: "success",
  unpaid: "danger",
  part_paid: "warning",
  unrecorded: "neutral",
}

function formatPaidDate(d: string) {
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

/** Badge for cash-flow payment status. Confidence-agnostic — this is a fact the operator recorded, not an extraction. */
export function PaymentStatusBadge({ status, paidDate, className }: Props) {
  const key: Key = status ?? "unrecorded"
  return (
    <span className={cn("inline-flex flex-col items-start gap-1", className)}>
      <StatusBadge variant={VARIANTS[key]} dot>
        {LABELS[key]}
      </StatusBadge>
      {status === "paid" && paidDate ? (
        <span className="text-[11px] text-muted-foreground">{formatPaidDate(paidDate)}</span>
      ) : null}
    </span>
  )
}
