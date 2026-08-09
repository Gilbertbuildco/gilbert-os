"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Upload, Loader2, Trash2, Plus, FileText, Check, ChevronRight } from "lucide-react"
import { cn, formatGBP } from "@/lib/utils"
import { StatusBadge } from "@/components/status-badge"
import { commitInvoice, classifyDocuments, type CommitLineItem } from "@/app/actions/invoices"
import type { ExtractedInvoice, ExtractionResult } from "@/lib/invoice-extraction"
import type { DuplicateVerdict } from "@/lib/duplicate-detection"
import { fetchCostPackages } from "@/app/actions/lookups"
import { BatchProgress, type FileProgress } from "@/components/upload/batch-progress"
import { DuplicateNotice } from "@/components/upload/duplicate-notice"
import { BatchSummary } from "@/components/upload/batch-summary"
import type { ExistingInvoiceRef } from "@/lib/duplicate-detection"

// One document's final disposition in a batch, kept raw so the summary screen
// can aggregate totals however it likes.
type BatchOutcome = {
  label: string
  supplierName: string
  invoiceNumber: string | null
  transactionType: "invoice" | "credit"
  net: number
  gross: number | null
  priceLines: number
  result: "imported" | "duplicate" | "skipped" | "failed"
  reason: string | null
  existing: ExistingInvoiceRef | null
}

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
  pageStart: number | null
  pageEnd: number | null
  // Per-document source metadata — batch uploads mix documents from several
  // files, so this cannot be a single top-level value.
  sourceFileName: string | null
  sourceFilePathname: string | null
  sourceFileHash: string | null
  // Duplicate classification for this document (null while unknown).
  verdict: DuplicateVerdict | null
  // For a possible-duplicate, the user must tick "import anyway" before commit.
  confirmedNew: boolean
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
  const [step, setStep] = useState<"upload" | "reading" | "review" | "summary">("upload")
  const [extracting, setExtracting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [packages, setPackages] = useState<PackageOption[]>([])
  // Per-file progress shown while a batch is being read.
  const [fileProgress, setFileProgress] = useState<FileProgress[]>([])
  const [processedCount, setProcessedCount] = useState(0)
  // Final per-document outcomes shown on the summary screen.
  const [outcomes, setOutcomes] = useState<BatchOutcome[]>([])
  // When a file contains several documents we hold them all here and step
  // through one at a time. `drafts` is the working copy for each document and
  // `saved` marks which have already been committed to the database.
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [saved, setSaved] = useState<boolean[]>([])
  const [current, setCurrent] = useState(0)
  const [saving, startSaving] = useTransition()

  const draft = drafts[current] ?? null
  const total = drafts.length
  const savedCount = saved.filter(Boolean).length

  function setDraft(next: Draft) {
    setDrafts((prev) => prev.map((d, i) => (i === current ? next : d)))
  }

  function draftFromDocument(
    d: ExtractedInvoice,
    source: { fileName: string | null; pathname: string | null; hash: string | null },
  ): Draft {
    return {
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
      pageStart: d.pageStart ?? null,
      pageEnd: d.pageEnd ?? d.pageStart ?? null,
      sourceFileName: source.fileName,
      sourceFilePathname: source.pathname,
      sourceFileHash: source.hash,
      verdict: null,
      confirmedNew: false,
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
    }
  }

  // Read one file → its extracted documents (or a single manual-fallback draft).
  async function readFile(file: File): Promise<Draft[]> {
    let result: ExtractionResult
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch("/api/extract-invoice", { method: "POST", body: fd })
      result = (await res.json()) as ExtractionResult
    } catch (err) {
      console.log("[v0] upload/extraction request failed:", (err as Error).message)
      // Manual-entry fallback seeded with the file so its source is still kept.
      return [
        {
          ...blankDraft(),
          sourceFileName: file.name,
        },
      ]
    }

    if (!result.ok) {
      return [{ ...blankDraft(), sourceFileName: result.fileName }]
    }

    const source = {
      fileName: result.fileName,
      pathname: result.sourceFilePathname,
      hash: result.sourceFileHash,
    }
    return result.documents.map((d) => draftFromDocument(d, source))
  }

  // Batch entry point: read every selected file (sequentially, so we don't
  // hammer the model), then classify all detected documents for duplicates
  // before showing the review screen.
  async function handleFiles(files: File[]) {
    if (files.length === 0) return
    setError(null)
    setExtracting(true)
    setStep("reading")
    setProcessedCount(0)
    setFileProgress(files.map((f) => ({ fileName: f.name, status: "pending", documentCount: 0 })))

    const collected: Draft[] = []
    for (let i = 0; i < files.length; i++) {
      setFileProgress((prev) => prev.map((p, idx) => (idx === i ? { ...p, status: "reading" } : p)))
      const draftsForFile = await readFile(files[i])
      collected.push(...draftsForFile)
      const failed = draftsForFile.every((d) => d.sourceFilePathname === null && d.verdict === null)
      setFileProgress((prev) =>
        prev.map((p, idx) =>
          idx === i
            ? { ...p, status: failed ? "failed" : "done", documentCount: draftsForFile.length }
            : p,
        ),
      )
      setProcessedCount(i + 1)
    }

    // Classify against the database (and within this batch) for duplicates.
    try {
      const verdicts = await classifyDocuments(
        collected.map((d) => ({
          supplierName: d.newSupplierName,
          invoiceNumber: d.invoiceNumber.trim() || null,
          transactionType: d.transactionType,
          net: d.net ? parseFloat(d.net) : null,
          vat: d.vat ? parseFloat(d.vat) : null,
          gross: d.gross ? parseFloat(d.gross) : null,
          invoiceDate: d.invoiceDate || null,
          sourceFileHash: d.sourceFileHash,
        })),
      )
      for (let i = 0; i < collected.length; i++) collected[i].verdict = verdicts[i] ?? null
    } catch (err) {
      console.log("[v0] duplicate classification failed:", (err as Error).message)
      // Non-fatal: proceed without verdicts rather than block ingestion.
    }

    setExtracting(false)
    setDrafts(collected)
    setSaved(collected.map(() => false))
    // Start on the first document that isn't already imported, if any.
    const firstActionable = collected.findIndex((d) => d.verdict?.status !== "already_imported")
    setCurrent(firstActionable === -1 ? 0 : firstActionable)
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
      pageStart: null,
      pageEnd: null,
      sourceFileName: null,
      sourceFilePathname: null,
      sourceFileHash: null,
      verdict: null,
      confirmedNew: false,
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
    const lines = draft.lines.map((l, i) => {
      if (i !== index) return l
      const next = { ...l, ...patch }
      // Auto-derive line net from qty × unit price when either changes and the
      // user hasn't explicitly typed a line net in the same edit.
      if (("quantity" in patch || "unitPriceExVat" in patch) && !("lineNet" in patch)) {
        const qty = parseFloat(next.quantity)
        const unit = parseFloat(next.unitPriceExVat)
        if (!Number.isNaN(qty) && !Number.isNaN(unit)) {
          next.lineNet = (qty * unit).toFixed(2)
        }
      }
      return next
    })
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

  // Advance to the next un-actioned document, or show the batch summary once
  // every document has been imported, skipped, or flagged as already imported.
  function advanceOrFinish(doneIndex: number, thisOutcome: BatchOutcome) {
    setOutcomes((prev) => [...prev, thisOutcome])
    const nextSaved = saved.map((s, i) => (i === doneIndex ? true : s))
    setSaved(nextSaved)
    const nextIndex = nextSaved.findIndex(
      (s, i) => !s && drafts[i]?.verdict?.status !== "already_imported",
    )
    if (nextIndex === -1) {
      setStep("summary")
    } else {
      setError(null)
      setPackages([])
      setCurrent(nextIndex)
    }
  }

  function outcomeBase(d: Draft, index: number) {
    return {
      label: documentLabel(d, index),
      supplierName: d.newSupplierName.trim() || "Unknown supplier",
      invoiceNumber: d.invoiceNumber.trim() || null,
      transactionType: d.transactionType,
      net: d.net ? parseFloat(d.net) : 0,
      gross: d.gross ? parseFloat(d.gross) : null,
      priceLines: d.lines.filter((l) => l.description.trim() && l.trackAsProduct && l.unitPriceExVat).length,
    }
  }

  // Skip a document without importing it (used for possible/confirmed duplicates
  // the user decides not to import).
  function skipCurrent() {
    if (!draft) return
    const isDupe = draft.verdict?.status === "already_imported"
    advanceOrFinish(current, {
      ...outcomeBase(draft, current),
      result: isDupe ? "duplicate" : "skipped",
      reason: draft.verdict?.reason ?? null,
      existing: draft.verdict?.existing ?? null,
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

    const capturedIndex = current
    const capturedDraft = draft

    startSaving(async () => {
      try {
        const result = await commitInvoice({
          supplierId: capturedDraft.supplierId ? Number(capturedDraft.supplierId) : null,
          newSupplierName: capturedDraft.supplierId ? null : capturedDraft.newSupplierName.trim(),
          projectId: capturedDraft.projectId ? Number(capturedDraft.projectId) : null,
          invoiceNumber: capturedDraft.invoiceNumber.trim() || null,
          invoiceDate: capturedDraft.invoiceDate || null,
          transactionType: capturedDraft.transactionType,
          net: parseFloat(capturedDraft.net) || 0,
          vat: parseFloat(capturedDraft.vat) || 0,
          gross: parseFloat(capturedDraft.gross) || 0,
          sourceFileName: capturedDraft.sourceFileName,
          sourceFilePathname: capturedDraft.sourceFilePathname,
          sourceFileHash: capturedDraft.sourceFileHash,
          sourcePageStart: capturedDraft.pageStart,
          sourcePageEnd: capturedDraft.pageEnd,
          notes: capturedDraft.notes.trim() || null,
          lineItems: payloadLines,
        })

        const base = outcomeBase(capturedDraft, capturedIndex)

        if (result.status === "duplicate") {
          // The server refused to double-import. Nothing was written; record it
          // as a duplicate and mark the draft so the review UI reflects reality.
          const reason = "Confirmed on save — this document is already in the system."
          setDrafts((prev) =>
            prev.map((d, i) =>
              i === capturedIndex
                ? { ...d, verdict: { status: "already_imported", existing: result.existing, reason } }
                : d,
            ),
          )
          advanceOrFinish(capturedIndex, {
            ...base,
            priceLines: 0,
            result: "duplicate",
            reason,
            existing: result.existing,
          })
        } else {
          advanceOrFinish(capturedIndex, { ...base, result: "imported", reason: null, existing: null })
        }
      } catch (e) {
        setError((e as Error).message || "Something went wrong while saving.")
      }
    })
  }

  function goToDocument(index: number) {
    setError(null)
    setPackages([])
    setCurrent(index)
  }

  function resetToUpload() {
    setStep("upload")
    setError(null)
    setPackages([])
    setDrafts([])
    setSaved([])
    setOutcomes([])
    setFileProgress([])
    setCurrent(0)
  }

  if (step === "upload") {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-10">
        <UploadDropzone onFiles={handleFiles} />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">How this works</h2>
          <ol className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            <li>1. Upload one or more files (PDF or image). Each file can contain several invoices or credit notes.</li>
            <li>2. We keep every original document and read the supplier, totals and line items automatically.</li>
            <li>3. We flag anything that looks like it&apos;s already in the system so nothing is double-counted.</li>
            <li>4. Review each detected document, assign a project and cost packages, then confirm.</li>
          </ol>
        </div>
        <button
          type="button"
          onClick={() => {
            setDrafts([blankDraft()])
            setSaved([false])
            setOutcomes([])
            setCurrent(0)
            setStep("review")
          }}
          className="text-sm font-medium text-primary hover:underline"
        >
          Or enter an invoice manually
        </button>
      </div>
    )
  }

  if (step === "reading") {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-10">
        <BatchProgress files={fileProgress} processed={processedCount} />
      </div>
    )
  }

  if (step === "summary") {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
        <BatchSummary
          data={buildSummaryData(outcomes, fileProgress)}
          onDone={() => {
            router.push("/invoices")
            router.refresh()
          }}
          onUploadMore={resetToUpload}
        />
      </div>
    )
  }

  if (!draft) return null

  const verdict = draft.verdict
  const isAlreadyImported = verdict?.status === "already_imported"

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-8">
      {error ? (
        <div className="rounded-lg border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {draft.sourceFileName ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText className="h-4 w-4" strokeWidth={1.75} />
          {draft.sourceFileName}
          {draft.pageStart ? (
            <span className="text-xs">
              · {draft.pageStart === draft.pageEnd ? `page ${draft.pageStart}` : `pages ${draft.pageStart}–${draft.pageEnd}`}
            </span>
          ) : null}
        </div>
      ) : null}

      {total > 1 ? (
        <div className="flex flex-col gap-3 rounded-lg border border-info/30 bg-info-bg px-4 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-foreground">
              {total} documents detected — {savedCount} of {total} actioned
            </p>
            <span className="text-xs font-medium text-muted-foreground">
              Reviewing {current + 1} of {total}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {drafts.map((d, i) => {
              const isCurrent = i === current
              const isSaved = saved[i]
              const v = d.verdict?.status
              const dupePending = !isSaved && (v === "already_imported" || v === "possible_duplicate")
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => goToDocument(i)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                    isCurrent
                      ? "border-primary bg-primary text-primary-foreground"
                      : isSaved
                        ? "border-success/40 bg-success-bg text-success"
                        : dupePending
                          ? "border-warning/40 bg-warning-bg text-warning"
                          : "border-border bg-card text-foreground hover:bg-muted",
                  )}
                >
                  {isSaved ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : null}
                  {documentLabel(d, i)}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {verdict && verdict.status !== "new" && !saved[current] ? (
        <DuplicateNotice
          verdict={verdict}
          confirmedNew={draft.confirmedNew}
          onConfirmChange={(v) => setDraft({ ...draft, confirmedNew: v })}
        />
      ) : null}

      {saved[current] ? (
        <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-bg px-4 py-3 text-sm text-success">
          <Check className="h-4 w-4" strokeWidth={2.5} />
          This document has been actioned.
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {draft.gross ? `Total ${formatGBP(parseFloat(draft.gross) || 0, { decimals: true })}` : ""}
        </span>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => (total > 1 ? setStep("summary") : router.push("/invoices"))}
            className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            Cancel
          </button>
          {total > 1 && !saved[current] ? (
            <button
              type="button"
              onClick={skipCurrent}
              disabled={saving}
              className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60"
            >
              {isAlreadyImported ? "Skip (already imported)" : "Skip this document"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={commit}
            disabled={saving}
            className={cn(
              "flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-60",
              verdict && verdict.status !== "new"
                ? "bg-warning text-warning-foreground hover:opacity-90"
                : "bg-primary text-primary-foreground hover:opacity-90",
            )}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : null}
            {saved[current]
              ? "Save again"
              : verdict && verdict.status !== "new"
                ? "Import anyway"
                : savedCount + 1 < total
                  ? "Save & next document"
                  : total > 1
                    ? "Save last document"
                    : "Confirm & save"}
            {!saving && !saved[current] && !(verdict && verdict.status !== "new") && savedCount + 1 < total ? (
              <ChevronRight className="h-4 w-4" strokeWidth={2} />
            ) : null}
          </button>
        </div>
      </div>
    </div>
  )
}

function UploadDropzone({ onFiles }: { onFiles: (files: File[]) => void }) {
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
        const files = Array.from(e.dataTransfer.files ?? [])
        if (files.length) onFiles(files)
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors",
        dragging ? "border-primary bg-primary/5" : "border-border-strong bg-card hover:bg-muted/40",
      )}
    >
      <input
        type="file"
        accept="application/pdf,image/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) onFiles(files)
          e.target.value = ""
        }}
      />
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Upload className="h-6 w-6" strokeWidth={1.75} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-foreground">
          Drop invoices here or tap to browse
        </span>
        <span className="text-xs text-muted-foreground">
          One or more PDFs or images · each file may contain several documents
        </span>
      </div>
    </label>
  )
}

const inputCls =
  "h-11 w-full rounded-lg border border-border bg-background px-3 text-base text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30 sm:h-9 sm:text-sm"
const selectCls = inputCls

function documentLabel(d: Draft, index: number): string {
  const num = d.invoiceNumber?.trim()
  const sup = d.newSupplierName?.trim()
  if (num && sup) return `${sup} · ${num}`
  return num || sup || `Document ${index + 1}`
}

function buildSummaryData(outcomes: BatchOutcome[], files: FileProgress[]): BatchSummaryData {
  const suppliers = new Set<string>()
  let invoicesAdded = 0
  let creditsAdded = 0
  let duplicatesSkipped = 0
  let otherSkipped = 0
  let totalNetAdded = 0
  let priceRecordsCreated = 0
  const needingAttention: { label: string; reason: string }[] = []

  for (const o of outcomes) {
    if (o.result === "imported") {
      if (o.transactionType === "credit") creditsAdded++
      else invoicesAdded++
      totalNetAdded += o.net
      priceRecordsCreated += o.priceLines
      suppliers.add(o.supplierName)
    } else if (o.result === "duplicate") {
      duplicatesSkipped++
      needingAttention.push({
        label: o.label,
        reason: o.reason ?? "Already imported — not counted again.",
      })
    } else if (o.result === "skipped") {
      otherSkipped++
    }
  }

  return {
    sourceFileCount: files.length,
    documentsDetected: outcomes.length,
    invoicesAdded,
    creditsAdded,
    duplicatesSkipped,
    otherSkipped,
    failed: files.filter((f) => f.status === "failed").length,
    totalNetAdded,
    suppliersAffected: [...suppliers],
    priceRecordsCreated,
    needingAttention,
  }
}

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
