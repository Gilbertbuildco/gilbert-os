"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { createProject } from "@/app/actions/projects"

const inputCls =
  "h-11 w-full rounded-lg border border-border bg-background px-3 text-base text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30 sm:h-10 sm:text-sm"

export function CreateProjectForm() {
  const router = useRouter()
  const [saving, startSaving] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: "",
    location: "",
    status: "Planning",
    homes: "",
    buildAreaSqft: "",
    originalBuildBudget: "",
    developmentFacility: "",
    remainingDrawdown: "",
    expectedGdv: "",
    seedCostPackages: true,
  })

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function submit() {
    setError(null)
    if (!form.name.trim()) {
      setError("A project name is required.")
      return
    }
    const num = (v: string) => (v.trim() === "" ? null : parseFloat(v))
    const int = (v: string) => (v.trim() === "" ? null : parseInt(v, 10))

    startSaving(async () => {
      try {
        const { slug } = await createProject({
          name: form.name.trim(),
          location: form.location.trim() || null,
          status: form.status,
          homes: int(form.homes),
          buildAreaSqft: int(form.buildAreaSqft),
          originalBuildBudget: num(form.originalBuildBudget),
          developmentFacility: num(form.developmentFacility),
          remainingDrawdown: num(form.remainingDrawdown),
          expectedGdv: num(form.expectedGdv),
          seedCostPackages: form.seedCostPackages,
        })
        router.push(`/projects/${slug}`)
        router.refresh()
      } catch (e) {
        setError((e as Error).message || "Could not create project.")
      }
    })
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-8 py-8">
      {error ? (
        <div className="rounded-lg border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-2">
        <Field label="Project name" className="sm:col-span-2">
          <input value={form.name} onChange={(e) => update("name", e.target.value)} className={inputCls} placeholder="e.g. Phase 2, Higher Farm" />
        </Field>
        <Field label="Location">
          <input value={form.location} onChange={(e) => update("location", e.target.value)} className={inputCls} placeholder="e.g. Dorset" />
        </Field>
        <Field label="Status">
          <select value={form.status} onChange={(e) => update("status", e.target.value)} className={inputCls}>
            <option>Appraisal</option>
            <option>Planning</option>
            <option>On Site</option>
            <option>Complete</option>
          </select>
        </Field>
        <Field label="Homes">
          <input value={form.homes} onChange={(e) => update("homes", e.target.value)} inputMode="numeric" className={inputCls} />
        </Field>
        <Field label="Build area (sq ft)">
          <input value={form.buildAreaSqft} onChange={(e) => update("buildAreaSqft", e.target.value)} inputMode="numeric" className={inputCls} />
        </Field>
        <Field label="Original build budget (£)">
          <input value={form.originalBuildBudget} onChange={(e) => update("originalBuildBudget", e.target.value)} inputMode="decimal" className={inputCls} />
        </Field>
        <Field label="Development facility (£)">
          <input value={form.developmentFacility} onChange={(e) => update("developmentFacility", e.target.value)} inputMode="decimal" className={inputCls} />
        </Field>
        <Field label="Remaining drawdown (£)">
          <input value={form.remainingDrawdown} onChange={(e) => update("remainingDrawdown", e.target.value)} inputMode="decimal" className={inputCls} />
        </Field>
        <Field label="Expected GDV (£)">
          <input value={form.expectedGdv} onChange={(e) => update("expectedGdv", e.target.value)} inputMode="decimal" className={inputCls} />
        </Field>
      </div>

      <label className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-4 py-3">
        <input
          type="checkbox"
          checked={form.seedCostPackages}
          onChange={(e) => update("seedCostPackages", e.target.checked)}
          className="h-4 w-4 rounded border-border"
        />
        <span className="text-sm text-foreground">
          Create the standard 18 cost packages for this project
        </span>
      </label>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push("/projects")}
          className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : null}
          Create project
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={"flex flex-col gap-1.5 " + (className ?? "")}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}
