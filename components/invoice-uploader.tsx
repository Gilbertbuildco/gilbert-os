"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Upload, Loader2, Trash2, Plus, FileText } from "lucide-react"
import { cn, formatGBP } from "@/lib/utils"
import { StatusBadge } from "@/components/status-badge"
import { extractInvoice, commitInvoice, type CommitLineItem } from "@/app/actions/invoices"
import { fetchCostPackages } from "@/app/actions/lookups"

type ProjectOption = { id: number; name: string; slug: string }
type SupplierOption = { id: number; name: string }
type PackageOption = { id: number; code: string | null; name: string }

interface DraftLine {
  description: string
  quantity: string
  unit: string
  unitPriceExVat: string
  lineNet: string
  vatRate: string
  costPackageId: string
  trackAsProduct: boolean
  productCategory: string
}

interface Draft {
  supplierId: string
  newSupplierName: string
  projectId: string
  invoiceNumber: string
  invoiceDate: string
  transactionType: "invoice" | "credit"
  net: string
  vat: string
  gross: string
  notes: string
  lines: DraftLine[]
}

const emptyLine: DraftLine = {
  description: "",
  quantity: "",
  unit: "",
  unitPriceExVat: "",
  lineNet: "",
  vatRate: "20",
  costPackageId: "",
  trackAsProduct: true,
  productCategory: "",
}

interface Props {
  projects: ProjectOption[]
  suppliers: SupplierOption[]
}

export function InvoiceUploader({ projects, suppliers }: Props) {
  const router = useRouter()
  const [step, setStep] = useState<"upload" | "review">("upload")
  const [fileName, setFileName] = useState<string | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [packages, setPackages] = useState<PackageOption[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, startSaving] = useTransition()

  async function handleFile(file: File) {
    setError(null)
    setExtracting(true)
    setFileName(file.name)
    const fd = new FormData()
    fd.append("file", file)
    const result = await extractInvoice(fd)
    setExtracting(false)

    if (!result.ok) {
      setError(result.error)
      // Still allow manual entry
      setDraft(blankDraft())
      setStep("review")
      return
    }

    const d = result.data
    setDraft({
      supplierId: "",
      newSupplierName: d.supplierName ?? "",
      projectId: "",
      invoiceNumber: d.invoiceNumber ?? "",
      invoiceDate: d.invoiceDate ?? "",
      transactionType: d.transactionType ?? "invoice",
      net: d.totals?.net != null ? String(d.totals.net) : "",
      vat: d.totals?.vat != null ? String(d.totals.vat) : "",
      gross: d.totals?.gross != null ? String(d.totals.gross) : "",
      notes: "",
      lines: (d.lineItems ?? []).map((li) => ({
        description: li.description ?? "",
        quantity: li.quantity != null ? String(li.quantity) : "",
        unit: li.unit ?? "",
        unitPriceExVat: li.unitPriceExVat != null ? String(li.unitPriceExVat) : "",
        lineNet: li.lineNet != null ? String(li.lineNet) : "",
        vatRate: li.vatRate != null ? String(li.vatRate) : "20",
        costPackageId: "",
        trackAsProduct: true,
        productCategory: "",
      })),
    })
    setStep("review")
  }

  function blankDraft(): Draft {
    return {
      supplierId: "",
      newSupplierName: "",
      projectId: "",
      invoiceNumber: "",
      invoiceDate: "",
      transactionType: "invoice",
      net: "",
      vat: "",
      gross: "",
      notes: "",
      lines: [{ ...emptyLine }],
    }
  }

  async function onProjectChange(projectId: string) {
    if (!draft) return
    setDraft({ ...draft, projectId })
    if (projectId) {
      const pkgs = await fetchCostPackages(Number(projectId))
      setPackages(pkgs)
    } else {
      setPackages([])
    }
  }

  function updateLine(index: number, patch: Partial<DraftLine>) {
    if (!draft) return
    const lines = draft.lines.map((l, i) => (i === index ? { ...l, ...patch } : l))
    setDraft({ ...draft, lines })
  }

  function recalcTotals(lines: DraftLine[]) {
    let net = 0
    let vat = 0
    for (const l of lines) {
      const n = parseFloat(l.lineNet) || 0
      const rate = parseFloat(l.vatRate) || 0
      net += n
      vat += n * (rate / 100)
    }
    return { net, vat, gross: net + vat }
  }

  function autoFillTotals() {
    if (!draft) return
    const t = recalcTotals(draft.lines)
    setDraft({
      ...draft,
      net: t.net.toFixed(2),
      vat: t.vat.toFixed(2),
      gross: t.gross.toFixed(2),
    })
  }

  function commit() {
    if (!draft) return
    setError(null)
    if (!draft.supplierId && !draft.newSupplierName.trim()) {
      setError("Select or enter a supplier before saving.")
      return
    }
    const payloadLines: CommitLineItem[] = draft.lines
      .filter((l) => l.description.trim())
      .map((l) => ({
        description: l.description.trim(),
        quantity: l.quantity ? parseFloat(l.quantity) : null,
        unit: l.unit.trim() || null,
        unitPriceExVat: l.unitPriceExVat ? parseFloat(l.unitPriceExVat) : null,
        lineNet: parseFloat(l.lineNet) || 0,
        vatRate: l.vatRate ? parseFloat(l.vatRate) : null,
        costPackageId: l.costPackageId ? Number(l.costPackageId) : null,
        productId: null,
        trackAsProduct: l.trackAsProduct,
        newProductName: null,
        newProductCategory: l.productCategory.trim() || null,
      }))

    startSaving(async () => {
      try {
        await commitInvoice({
          supplierId: draft.supplierId ? Number(draft.supplierId) : null,
          newSupplierName: draft.supplierId ? null : draft.newSupplierName.trim(),
          projectId: draft.projectId ? Number(draft.projectId) : null,
          invoiceNumber: draft.invoiceNumber.trim() || null,
          invoiceDate: draft.invoiceDate || null,
          transactionType: draft.transactionType,
          net: parseFloat(draft.net) || 0,
          vat: parseFloat(draft.vat) || 0,
          gross: parseFloat(draft.gross) || 0,
          sourceFileName: fileName,
          notes: draft.notes.trim() || null,
          lineItems: payloadLines,
        })
        router.push("/invoices")
        router.refresh()
      } catch (e) {
        setError((e as Error).message || "Something went wrong while saving.")
      }
    })
  }

  if (step === "upload") {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-10">
        <UploadDropzone onFile={handleFile} extracting={extracting} fileName={fileName} />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">How this works</h2>
          <ol className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            <li>1. Upload a supplier invoice or credit note (PDF or image).</li>
            <li>2. We read the supplier, totals and line items automatically.</li>
            <li>3. Review and correct everything, assign a project and cost packages.</li>
            <li>4. Confirm — spend, price history and supplier records update instantly.</li>
          </ol>
        </div>
        <button
          type="button"
          onClick={() => {
            setDraft(blankDraft())
            setStep("review")
          }}
          className="text-sm font-medium text-primary hover:underline"
        >
          Or enter an invoice manually
        </button>
      </div>
    )
  }

  if (!draft) return null

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-8">
      {error ? (
        <div className="rounded-lg border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {fileName ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText className="h-4 w-4" strokeWidth={1.75} />
          {fileName}
          {extracting ? <StatusBadge variant="info">Reading…</StatusBadge> : null}
        </div>
      ) : null}

      {/* Header details */}
      <section className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-2">
        <Field label="Supplier">
          {suppliers.length > 0 ? (
            <select
              value={draft.supplierId}
              onChange={(e) => setDraft({ ...draft, supplierId: e.target.value })}
              className={selectCls}
            >
              <option value="">+ New supplier…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : null}
          {!draft.supplierId ? (
            <input
              value={draft.newSupplierName}
              onChange={(e) => setDraft({ ...draft, newSupplierName: e.target.value })}
              placeholder="Supplier name"
              className={cn(inputCls, suppliers.length > 0 && "mt-2")}
            />
          ) : null}
        </Field>

        <Field label="Project">
          <select value={draft.projectId} onChange={(e) => onProjectChange(e.target.value)} className={selectCls}>
            <option value="">Unassigned</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Document type">
          <select
            value={draft.transactionType}
            onChange={(e) =>
              setDraft({ ...draft, transactionType: e.target.value as "invoice" | "credit" })
            }
            className={selectCls}
          >
            <option value="invoice">Invoice</option>
            <option value="credit">Credit note</option>
          </select>
        </Field>

        <Field label="Invoice number">
          <input
            value={draft.invoiceNumber}
            onChange={(e) => setDraft({ ...draft, invoiceNumber: e.target.value })}
            className={inputCls}
          />
        </Field>

        <Field label="Invoice date">
          <input
            type="date"
            value={draft.invoiceDate}
            onChange={(e) => setDraft({ ...draft, invoiceDate: e.target.value })}
            className={inputCls}
          />
        </Field>
      </section>

      {/* Line items */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Line items</h2>
          <button
            type="button"
            onClick={autoFillTotals}
            className="text-xs font-medium text-primary hover:underline"
          >
            Recalculate totals from lines
          </button>
        </div>

        <div className="flex flex-col gap-3">
          {draft.lines.map((line, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start gap-3">
                <input
                  value={line.description}
                  onChange={(e) => updateLine(i, { description: e.target.value })}
                  placeholder="Description"
                  className={cn(inputCls, "flex-1")}
                />
                <button
                  type="button"
                  onClick={() =>
                    setDraft({ ...draft, lines: draft.lines.filter((_, idx) => idx !== i) })
                  }
                  aria-label="Remove line"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MiniField label="Qty">
                  <input
                    value={line.quantity}
                    onChange={(e) => updateLine(i, { quantity: e.target.value })}
                    inputMode="decimal"
                    className={inputCls}
                  />
                </MiniField>
                <MiniField label="Unit">
                  <input
                    value={line.unit}
                    onChange={(e) => updateLine(i, { unit: e.target.value })}
                    className={inputCls}
                  />
                </MiniField>
                <MiniField label="Unit price (ex VAT)">
                  <input
                    value={line.unitPriceExVat}
                    onChange={(e) => updateLine(i, { unitPriceExVat: e.target.value })}
                    inputMode="decimal"
                    className={inputCls}
                  />
                </MiniField>
                <MiniField label="Line net">
                  <input
                    value={line.lineNet}
                    onChange={(e) => updateLine(i, { lineNet: e.target.value })}
                    inputMode="decimal"
                    className={inputCls}
                  />
                </MiniField>
                <MiniField label="VAT %">
                  <input
                    value={line.vatRate}
                    onChange={(e) => updateLine(i, { vatRate: e.target.value })}
                    inputMode="decimal"
                    className={inputCls}
                  />
                </MiniField>
                <MiniField label="Cost package">
                  <select
                    value={line.costPackageId}
                    onChange={(e) => updateLine(i, { costPackageId: e.target.value })}
                    disabled={packages.length === 0}
                    className={selectCls}
                  >
                    <option value="">
                      {packages.length === 0 ? "Select a project first" : "Unassigned"}
                    </option>
                    {packages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code ? `${p.code} · ` : ""}
                        {p.name}
                      </option>
                    ))}
                  </select>
                </MiniField>
                <MiniField label="Category">
                  <input
                    value={line.productCategory}
                    onChange={(e) => updateLine(i, { productCategory: e.target.value })}
                    placeholder="e.g. Timber"
                    className={inputCls}
                  />
                </MiniField>
                <MiniField label="Track price">
                  <label className="flex h-11 items-center gap-2 sm:h-9">
                    <input
                      type="checkbox"
                      checked={line.trackAsProduct}
                      onChange={(e) => updateLine(i, { trackAsProduct: e.target.checked })}
                      className="h-4 w-4 rounded border-border"
                    />
                    <span className="text-sm text-muted-foreground">Add to price DB</span>
                  </label>
                </MiniField>
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setDraft({ ...draft, lines: [...draft.lines, { ...emptyLine }] })}
          className="flex w-fit items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          Add line
        </button>
      </section>

      {/* Totals */}
      <section className="grid grid-cols-3 gap-4 rounded-lg border border-border bg-card p-5">
        <MiniField label="Net">
          <input
            value={draft.net}
            onChange={(e) => setDraft({ ...draft, net: e.target.value })}
            inputMode="decimal"
            className={inputCls}
          />
        </MiniField>
        <MiniField label="VAT">
          <input
            value={draft.vat}
            onChange={(e) => setDraft({ ...draft, vat: e.target.value })}
            inputMode="decimal"
            className={inputCls}
          />
        </MiniField>
        <MiniField label="Gross">
          <input
            value={draft.gross}
            onChange={(e) => setDraft({ ...draft, gross: e.target.value })}
            inputMode="decimal"
            className={inputCls}
          />
        </MiniField>
      </section>

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {draft.gross ? `Total ${formatGBP(parseFloat(draft.gross) || 0, { decimals: true })}` : ""}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => router.push("/invoices")}
            className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commit}
            disabled={saving}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : null}
            Confirm &amp; save
          </button>
        </div>
      </div>
    </div>
  )
}

function UploadDropzone({
  onFile,
  extracting,
  fileName,
}: {
  onFile: (f: File) => void
  extracting: boolean
  fileName: string | null
}) {
  const [dragging, setDragging] = useState(false)
  return (
    <label
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files?.[0]
        if (f) onFile(f)
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors",
        dragging ? "border-primary bg-primary/5" : "border-border-strong bg-card hover:bg-muted/40",
      )}
    >
      <input
        type="file"
        accept="application/pdf,image/*"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
        }}
      />
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {extracting ? (
          <Loader2 className="h-6 w-6 animate-spin" strokeWidth={1.75} />
        ) : (
          <Upload className="h-6 w-6" strokeWidth={1.75} />
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-foreground">
          {extracting ? `Reading ${fileName}…` : "Drop an invoice here or tap to browse"}
        </span>
        <span className="text-xs text-muted-foreground">PDF or image · supplier invoices and credit notes</span>
      </div>
    </label>
  )
}

const inputCls =
  "h-11 w-full rounded-lg border border-border bg-background px-3 text-base text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30 sm:h-9 sm:text-sm"
const selectCls = inputCls

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function MiniField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  )
}
