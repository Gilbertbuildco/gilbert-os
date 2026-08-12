/**
 * Idempotent Xero integration migration — Phase 1 (schema) + Phase 2
 * (OAuth connection layer columns/table).
 * Safe to run repeatedly. Only adds new tables/columns; touches no existing
 * invoice/commercial data.
 *
 * ALREADY APPLIED TO PRODUCTION — `xero_connections`, `xero_sync_state`,
 * `xero_account_map` and `xero_oauth_state` (with all Phase 2 columns/index
 * additions below) exist live and have been verified to match this DDL
 * exactly. Do not re-run casually; every statement here is `IF NOT EXISTS`
 * so a re-run is safe, but any *further* schema change belongs in a NEW
 * additive statement appended to the `DDL` array below — never edit an
 * already-applied statement, never a destructive one. Get the owner's
 * explicit go-ahead before running this script again for a genuinely new
 * addition.
 *
 * As with every other table in this schema, there are no DB-level foreign
 * keys — `invoice_id` / `cost_package_id` references are validated in
 * application code, never enforced by Postgres here.
 */
import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const DDL = [
  `CREATE TABLE IF NOT EXISTS xero_connections (
     id serial PRIMARY KEY,
     tenant_id text NOT NULL,
     tenant_name text,
     access_token text,
     refresh_token text,
     expires_at timestamptz,
     scopes text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS xero_sync_state (
     id serial PRIMARY KEY,
     invoice_id integer NOT NULL,
     xero_invoice_id text,
     xero_contact_id text,
     status text NOT NULL DEFAULT 'pending',
     last_pushed_at timestamptz,
     error text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS xero_account_map (
     id serial PRIMARY KEY,
     cost_package_id integer NOT NULL,
     xero_account_code text NOT NULL,
     notes text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,

  // --- Phase 2: OAuth connection layer ------------------------------------
  // `refresh_token` (plaintext) is superseded by `refresh_token_encrypted`
  // (AES-256-GCM, see lib/xero/crypto.ts) — additive only, the old column is
  // left in place but unused rather than dropped/renamed.
  `ALTER TABLE xero_connections ADD COLUMN IF NOT EXISTS refresh_token_encrypted text`,
  `ALTER TABLE xero_connections ADD COLUMN IF NOT EXISTS connected_at timestamptz`,
  `ALTER TABLE xero_connections ADD COLUMN IF NOT EXISTS last_refreshed_at timestamptz`,
  `ALTER TABLE xero_connections ADD COLUMN IF NOT EXISTS last_error text`,

  // Pending PKCE/CSRF authorisation attempts — one row per /api/xero/connect
  // click, redeemed exactly once by the callback. See lib/xero/oauth.ts.
  `CREATE TABLE IF NOT EXISTS xero_oauth_state (
     nonce text PRIMARY KEY,
     code_verifier_encrypted text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz NOT NULL,
     consumed_at timestamptz
   )`,

  // Helpful indexes / integrity guards.
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_xero_connections_tenant ON xero_connections(tenant_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_xero_sync_state_invoice ON xero_sync_state(invoice_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_xero_account_map_package ON xero_account_map(cost_package_id)`,
  `CREATE INDEX IF NOT EXISTS idx_xero_oauth_state_expires ON xero_oauth_state(expires_at)`,
]

let applied = 0
for (const stmt of DDL) {
  await pool.query(stmt)
  applied++
}
console.log(`Xero migration applied: ${applied} statements OK.`)

const tables = await pool.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND table_name LIKE 'xero_%' ORDER BY table_name`)
console.log("xero tables:", tables.rows.map((r) => r.table_name).join(", "))

await pool.end()
