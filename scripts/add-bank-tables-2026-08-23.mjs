/**
 * Bank connection tables — live balances and transactions straight from the
 * business bank account, independent of Xero's feed.
 *
 * Owner instruction 2026-08-23: Xero's bank figures are not trusted ("we have
 * about 15k in the bank i think"), so the OS reads the account directly rather
 * than inheriting Xero's drift.
 *
 * READ-ONLY BY CONSTRUCTION. GoCardless Bank Account Data can retrieve
 * balances and transactions and cannot initiate a payment. Nothing here stores
 * bank credentials: the owner authenticates with his own bank, and what is
 * stored is a short-lived access token plus a requisition reference. Tokens are
 * encrypted at rest with the same AES-256-GCM helper used for Xero.
 *
 * Idempotent: safe to re-run.
 */
import pg from "pg"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  await c.query(`
    CREATE TABLE IF NOT EXISTS bank_connections (
      id                serial PRIMARY KEY,
      provider          text NOT NULL DEFAULT 'gocardless',
      institution_id    text,
      institution_name  text,
      requisition_id    text,
      account_id        text,
      account_name      text,
      iban_last4        text,
      status            text NOT NULL DEFAULT 'pending',
      access_token_enc  text,
      refresh_token_enc text,
      access_expires_at timestamptz,
      consent_expires_at timestamptz,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    )`)
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS bank_connections_account_uidx
                   ON bank_connections (provider, account_id) WHERE account_id IS NOT NULL`)

  // One row per balance reading, so drift over time is visible rather than overwritten.
  await c.query(`
    CREATE TABLE IF NOT EXISTS bank_balances (
      id            serial PRIMARY KEY,
      connection_id integer NOT NULL,
      balance_type  text,
      amount        numeric(14,2) NOT NULL,
      currency      text NOT NULL DEFAULT 'GBP',
      reference_date date,
      fetched_at    timestamptz NOT NULL DEFAULT now()
    )`)
  await c.query(`CREATE INDEX IF NOT EXISTS bank_balances_conn_idx ON bank_balances (connection_id, fetched_at DESC)`)

  await c.query(`
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id               serial PRIMARY KEY,
      connection_id    integer NOT NULL,
      external_id      text NOT NULL,
      booking_date     date,
      value_date       date,
      amount           numeric(14,2) NOT NULL,
      currency         text NOT NULL DEFAULT 'GBP',
      counterparty     text,
      reference        text,
      raw              jsonb,
      matched_invoice_id integer,
      created_at       timestamptz NOT NULL DEFAULT now()
    )`)
  // The provider's own id is the dedupe key — a transaction can never land twice.
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_ext_uidx
                   ON bank_transactions (connection_id, external_id)`)
  await c.query(`CREATE INDEX IF NOT EXISTS bank_transactions_date_idx ON bank_transactions (booking_date DESC)`)

  const { rows } = await c.query(`SELECT
    (SELECT count(*)::int FROM bank_connections) conns,
    (SELECT count(*)::int FROM bank_balances) bals,
    (SELECT count(*)::int FROM bank_transactions) txs`)
  console.log(`bank tables ready — connections:${rows[0].conns} balances:${rows[0].bals} transactions:${rows[0].txs}`)
  await c.query("COMMIT")
  console.log("COMMITTED")
} catch (e) { await c.query("ROLLBACK"); console.error("rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
