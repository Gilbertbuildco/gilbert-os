/**
 * Idempotent migration — adds payment tracking columns to `invoices`.
 * Safe to run repeatedly: every statement is `ADD COLUMN IF NOT EXISTS`.
 *
 * Columns added:
 *   payment_status text   — nullable, no default. Application-enforced values
 *                            'unpaid' | 'paid' | 'part_paid' (see
 *                            app/actions/invoices.ts::setInvoicePayment).
 *                            NULL = "not recorded" — the true, honest state of
 *                            every invoice ingested before this migration.
 *                            NEVER backfilled to 'unpaid' (non-negotiable #1:
 *                            never fabricate financial data — an unknown
 *                            payment state is not the same fact as "unpaid").
 *   paid_date date         — nullable.
 *   payment_notes text     — nullable.
 *
 * As with every other table in this schema, there is no DB-level CHECK
 * constraint on payment_status — relationships/enums are validated in
 * application code, never enforced by Postgres here (repo convention).
 *
 * This script does not touch existing rows in any way beyond adding the three
 * new (nullable, no-default) columns, so no existing invoice's net/vat/gross
 * or any other financial field is affected, and no row's new payment_status
 * is anything other than NULL.
 */
import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const DDL = [
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_status text`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_date date`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_notes text`,
]

async function columnList() {
  const res = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'invoices'
       AND column_name IN ('payment_status', 'paid_date', 'payment_notes')
     ORDER BY column_name`,
  )
  return res.rows
}

async function main() {
  console.log("--- BEFORE ---")
  console.log(JSON.stringify(await columnList(), null, 2))

  let applied = 0
  for (const stmt of DDL) {
    await pool.query(stmt)
    applied++
  }
  console.log(`\nMigration applied: ${applied} statements OK.`)

  console.log("\n--- AFTER ---")
  console.log(JSON.stringify(await columnList(), null, 2))

  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
