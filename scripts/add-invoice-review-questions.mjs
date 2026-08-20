/**
 * Idempotent migration — adds the two-way review-question channel to
 * `invoices`. Safe to run repeatedly: every statement is `ADD COLUMN IF NOT
 * EXISTS`.
 *
 * Columns added:
 *   review_question    text        — a question the assistant has attached to
 *                                     this invoice, awaiting the owner. NULL
 *                                     means no question is outstanding.
 *   review_question_at timestamptz — when the question was asked.
 *   review_answer      text        — the owner's reply. NULL means
 *                                     unanswered (never inferred/defaulted).
 *   review_answer_at   timestamptz — when the answer was recorded.
 *
 * All four columns are nullable with no default — non-negotiable #1: unknown
 * stays null, never fabricated. The pair (review_question, review_answer) is
 * the record; answering never clears the question that prompted it.
 *
 * As with every other table in this schema, there is no DB-level CHECK
 * constraint here — validation (non-empty, length caps) lives in application
 * code (app/actions/invoices.ts), matching repo convention. There are no
 * DB-level foreign keys either.
 *
 * This script does not touch existing rows in any way beyond adding these
 * four new (nullable, no-default) columns, so no existing invoice's
 * net/vat/gross, payment fields, or any other financial field is affected.
 */
import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const DDL = [
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS review_question text`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS review_question_at timestamptz`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS review_answer text`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS review_answer_at timestamptz`,
]

async function columnList() {
  const res = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'invoices'
       AND column_name IN ('review_question', 'review_question_at', 'review_answer', 'review_answer_at')
     ORDER BY column_name`,
  )
  return res.rows
}

async function fullColumnList() {
  const res = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'invoices'
     ORDER BY ordinal_position`,
  )
  return res.rows.map((r) => r.column_name)
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

  console.log("\n--- FULL invoices COLUMN LIST ---")
  console.log(JSON.stringify(await fullColumnList(), null, 2))

  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
