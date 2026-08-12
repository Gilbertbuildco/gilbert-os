@AGENTS.md

# Gilbert OS — agent rules

Construction cost-intelligence platform for Gilbert Build Co (UK residential
developer). It turns supplier invoices into structured cost data and measures
actual spend against a lender's funding schedule.

**This is a working production system handling real money.** Do not redesign,
rewrite, or delete existing functionality. `GILBERT_OS_HANDOVER.md` is the full
reference — read the relevant section before changing anything it covers.

---

## Stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16, App Router, Turbopack |
| UI | React 19.2, TypeScript 5.6 |
| Styling | Tailwind v4 — **no `tailwind.config`**, theme tokens live in `app/globals.css` |
| Database | Neon Postgres via `pg` pool (`lib/db/index.ts`), `DATABASE_URL` only |
| ORM | Drizzle — `lib/db/schema.ts` is the single source of truth (19 tables) |
| Migrations | **No drizzle-kit.** Hand-written idempotent scripts in `scripts/` |
| AI | Vercel AI SDK v7 via AI Gateway; `google/gemini-2.5-flash` → `-flash-lite` |
| Files | Vercel Blob (`@vercel/blob`) |
| Validation | Zod v4 |
| Deploy | Vercel, project `prj_p8auPiaebaQCyljFBM3bCUh6zhtJ` |

Server actions in `app/actions/*` do the work. There are four API routes:
`app/api/extract-invoice` (`maxDuration = 300`), the Xero OAuth pair
`app/api/xero/connect` + `app/api/xero/callback`, and the read-only
`app/api/invoices/[id]/line-items` (feeds the invoices-page row expansion).

---

## Non-negotiables

These encode financial correctness. Never undo one. Full text: handover Section 22.

1. **Never fabricate financial data.** No invented £ amounts, percentages, budgets,
   splits, line items, references or product specs. Unknown stays null/unresolved.
2. **Never alter the lender baseline to make totals reconcile.** The Goldentree
   schedule is immutable — same descriptions, same values, same order. Never
   resort, split, apportion or rebalance an allowance.
3. **Flag discrepancies; never "fix" them.** Reconciliation reports, it never edits.
4. **Preserve original documents.** Uploads go to Blob before parsing and are never
   discarded. `description`, `raw_*` and `extraction_raw` are immutable audit fields.
5. **Prevent duplicate financial records.** The app-level re-check inside the
   transaction AND the partial unique index `invoices_supplier_type_number_uidx`
   must both remain. A duplicate commit writes nothing.
6. **AI does the work; the human reviews exceptions.** Never auto-commit
   low-confidence or ambiguous documents.
7. **Classification learns from confirmations.** Keep writing
   `classification_mappings` and `supplier_aliases` on commit.
8. **No actual spend may double-count** against more than one funding line. When
   attribution is ambiguous, leave it UNRESOLVED — never guess.
9. **Project selection must not block cost-package classification.** They are
   independent decisions.
10. **Never delete production data.** Tests use throwaway projects and self-clean.
    Never truncate or reset production tables.
11. **Own labour/subcontract is a separate future workflow.** Do not mix it into
    the supplier-material pipeline or the material price DB.
12. **A favourable variance is not profit.** It is usually intentional headroom
    from self-performed labour. Never label it profit.

**Open funding-mapping decisions are the owner's, not yours.** Roof Structure,
Mains Electricity, Solar Panels, Mains Water, BT & Broadband, Contingency,
line 27 vs package 20, and professional-fee roll-up are all deliberately
unresolved. Surface them one at a time. Never auto-complete them.

---

## Conventions

Derived from the existing code. Match it.

- **British spelling, always.** `normalise` / `normalised` / `normalisation`.
  Never the `-ize` forms. This is not cosmetic — `normalised_name` and
  `normalised_unit` are real database columns and object keys.
- **Double quotes. No semicolons.** Matches every file in the repo.
- **Types over interfaces**, declared next to what they describe.
- **Money is handled in explicit units** — credits are stored negative; never
  introduce floating-point rounding into a total.
- `lib/funding/calculations.ts` is **pure** — no DB imports, no `server-only`, no
  mutation of inputs. Keep it that way so it stays testable.
- Modules that touch the DB or AI import `server-only`.
- Class merging goes through `cn()` in `lib/utils.ts`.
- There are **no database-level foreign keys**. Relationships are enforced in
  application code — never assume the DB will catch a bad reference.

## Workflow

- Working branch is **`gilbert-os`**. `main` is a stale README stub — never build
  from it, never assume it is current.
- Never commit straight to the production branch. Feature branch → push → Vercel
  preview → PR.
- Schema changes are **idempotent raw SQL scripts** (`CREATE ... IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS`) committed to `scripts/`. Never leave a migration
  only in chat. Run it against production *before* dependent code ships.
- Verify with `npx tsc --noEmit` and `npm run build`. There is no test runner;
  `npx tsx scripts/test-funding.mts` is the funding suite (44 checks).

## Orchestration

The main session is the **orchestrator**. Before acting on a request, decide who
should do it and say so in one line.

**Delegate** when the task means writing or changing code in an agent's
territory, or needs focused multi-step work:

| Signal | Agent |
| --- | --- |
| Pages, components, styling, review/upload UI, dashboards | `frontend` |
| Schema, migrations, extraction, enrichment, matching, dedup, classification, funding logic, server actions | `data` |
| Builds, env vars, Vercel config, previews, promotion, release hygiene | `deploy` |

**Handle inline — do NOT spawn** when the request is a question answerable from
context, a quick read, a git operation, or work spanning all three agents. A
cold subagent re-derives context the orchestrator already holds; spawning one
for a lookup is slower and worse.

**Sequence dependent work.** A schema change plus its UI is `data` first, then
`frontend` against the real shape — never both at once guessing at each other.
Independent tasks may run in parallel in the background.

**The orchestrator stays accountable** for verifying agent output, integration,
and anything outward-facing (commits, pushes, deploys). Never relay an agent's
claim of a passing build without confirming it.

## Known traps

- `GILBERT_OS_HANDOVER.md` references `scripts/handover-introspect.mjs` in four
  places. **That file was deleted** (commit `79afb3f`) and does not exist.
- The app has **no authentication layer**, and the GitHub repo is public.
- `funding_drawdowns`, `variations` and `supplier_products` are structure-only
  (0 rows). Don't assume they contain data.
- **Xero writes are off by default, deliberately.** `lib/xero/client.ts` refuses
  any non-GET call unless `XERO_WRITE_ENABLED` is the exact string `"true"`.
  This is not a placeholder to tidy up — it stands in for the auth layer the
  app doesn't have, on a repo that's public. Never flip it as a side effect of
  unrelated work.
