import "server-only"
import { createHash, randomBytes } from "node:crypto"
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { xeroConnections, xeroOauthState } from "@/lib/db/schema"
import {
  ACCESS_TOKEN_PURPOSE,
  OAUTH_VERIFIER_PURPOSE,
  REFRESH_TOKEN_PURPOSE,
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  signStateNonce,
  verifyStateNonce,
} from "./crypto"

/**
 * Xero OAuth 2.0 connection layer (Phase 2). Builds the authorisation URL
 * (PKCE + signed single-use state), exchanges the callback code for tokens,
 * resolves the connected tenant(s), and persists/refreshes the connection.
 *
 * This module never sends an accounting write to Xero — it only talks to
 * Xero's identity/connections endpoints (`identity.xero.com`,
 * `api.xero.com/connections`), which are part of authorising the
 * integration itself, not the Accounting API `lib/xero/client.ts` gates.
 */

const AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize"
const TOKEN_URL = "https://identity.xero.com/connect/token"
const CONNECTIONS_URL = "https://api.xero.com/connections"

// Granular scopes. Apps registered after 2 March 2026 (this one) only have
// access to the granular set — the older broad scopes (`accounting.transactions`,
// `accounting.reports.read`) are rejected outright with `invalid_scope`.
//
// Do NOT add `app.connections`. It appears in the portal's scope list but this
// app is not granted it, and including it makes Xero refuse the whole
// authorisation with `access_denied: Requested wrong apps scopes` — an error
// that names neither the offending scope nor the real cause. Verified by
// bisection: these seven reach the consent screen, adding `app.connections`
// bounces immediately. Tenant resolution via /connections works without it.
const SCOPES = [
  "offline_access",
  "accounting.settings",
  "accounting.contacts",
  "accounting.invoices",
  "accounting.payments",
  "accounting.reports.aged.read",
  "accounting.reports.profitandloss.read",
  // Read-only additions (2026-08-13): direct bank payments ("spend money")
  // and bill attachments — needed to see owner/subcontractor payments made
  // without a bill, and to retrieve invoice documents for Gilbert OS.
  "accounting.banktransactions.read",
  "accounting.attachments.read",
].join(" ")

/** How long a pending authorisation attempt (PKCE verifier) stays redeemable. Xero's own consent screen is normally completed in well under this. */
const STATE_TTL_MS = 10 * 60 * 1000

/** Proactively refresh if the access token is within this many ms of expiring, so a request never races a live expiry. */
const REFRESH_EXPIRY_BUFFER_MS = 60_000

/**
 * Ceiling on simultaneously-pending authorisation attempts. `/api/xero/connect`
 * is unauthenticated, so without this an anonymous caller could insert
 * `xero_oauth_state` rows in a loop and run up the Neon bill / fill the
 * database. Expired rows are swept on every attempt, so this bounds the table
 * to roughly this many rows per `STATE_TTL_MS` window.
 */
const MAX_PENDING_STATES = 100

/** Hard ceiling on any single identity/connections HTTP call, so a hung request cannot hold a DB row lock open (see `refreshConnection`). */
const XERO_HTTP_TIMEOUT_MS = 20_000

/** Advisory-lock key serialising connection bootstrap, so two concurrent first-time callbacks cannot both win the trust-on-first-use race. */
const CONNECTION_LOCK_KEY = 7233190119

function requireEnv(name: "XERO_CLIENT_ID" | "XERO_REDIRECT_URI"): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set. Cannot continue the Xero OAuth flow without it.`)
  }
  return value
}

function requireClientSecret(): string {
  const value = process.env.XERO_CLIENT_SECRET
  if (!value) {
    throw new Error(
      "XERO_CLIENT_SECRET is not set. This is the Xero app's client secret, which the owner pastes into the " +
        "environment directly — it is never hardcoded, generated, or read from any other file by this codebase. " +
        "Refusing to call Xero's token endpoint without it.",
    )
  }
  return value
}

/**
 * The redirect URI is read from the environment and never from the request,
 * so it cannot be influenced by a caller — there is no open redirect here.
 * It is still validated: it must be an absolute `https:` URL (or plain
 * localhost for development), so a misconfigured environment cannot send a
 * live authorisation code to a cleartext or non-absolute endpoint. The same
 * value is sent at authorise time and at token exchange, which is what Xero
 * requires.
 */
function requireRedirectUri(): string {
  const raw = requireEnv("XERO_REDIRECT_URI")
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error("XERO_REDIRECT_URI must be an absolute URL, e.g. https://example.com/api/xero/callback.")
  }
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    throw new Error("XERO_REDIRECT_URI must use https (http is only accepted for localhost during development).")
  }
  return raw
}

function base64url(input: Buffer): string {
  return input.toString("base64url")
}

/** PKCE code_verifier / code_challenge pair per RFC 7636, S256 method. */
function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(32)) // 43 chars — within the required 43-128 range
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest())
  return { codeVerifier, codeChallenge }
}

/**
 * Builds the Xero consent-screen URL for a fresh authorisation attempt.
 * Generates a new PKCE pair and a signed, single-use `state` nonce every
 * call — never a static string — and persists the pending attempt
 * (encrypted verifier) so the callback can redeem it exactly once.
 */
export async function buildAuthorisationUrl(): Promise<string> {
  const clientId = requireEnv("XERO_CLIENT_ID")
  const redirectUri = requireRedirectUri()

  // Sweep first: expired rows (consumed or not) have no remaining purpose —
  // the nonce is 24 random bytes and is never reissued, so removing the row
  // cannot make a spent state redeemable again.
  await db.delete(xeroOauthState).where(lt(xeroOauthState.expiresAt, new Date()))

  const [{ pending }] = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(xeroOauthState)
    .where(and(isNull(xeroOauthState.consumedAt), gt(xeroOauthState.expiresAt, new Date())))
  if (pending >= MAX_PENDING_STATES) {
    throw new Error(
      `Too many Xero authorisation attempts are already pending (${pending}). Wait for them to expire and retry.`,
    )
  }

  const { codeVerifier, codeChallenge } = generatePkcePair()
  const nonce = base64url(randomBytes(24))
  const state = `${nonce}.${signStateNonce(nonce)}`
  const expiresAt = new Date(Date.now() + STATE_TTL_MS)

  await db.insert(xeroOauthState).values({
    nonce,
    codeVerifierEncrypted: encryptSecret(codeVerifier, OAUTH_VERIFIER_PURPOSE),
    expiresAt,
  })

  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", SCOPES)
  url.searchParams.set("state", state)
  url.searchParams.set("code_challenge", codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")

  // URLSearchParams serialises spaces as "+", which Xero's authorise endpoint
  // reads as part of the scope token rather than a separator — it rejects the
  // whole request with `access_denied: Requested wrong apps scopes`. Spaces
  // must be percent-encoded. Nothing else we send here (hex client id,
  // base64url state/challenge, encoded redirect URI) can contain a literal
  // "+", so a blanket replacement is safe.
  return url.toString().replace(/\+/g, "%20")
}

/**
 * Validates and atomically consumes a `state` value from the callback.
 * Checks the HMAC signature first (rejects a forged/tampered state without
 * a DB round trip), then redeems the single-use row with one
 * `UPDATE ... WHERE consumed_at IS NULL`, so a replayed or concurrently
 * re-submitted callback can never succeed twice.
 */
export async function redeemState(state: string): Promise<{ codeVerifier: string }> {
  // Strict shape check before anything else. `split(".")` previously accepted
  // trailing junk (`nonce.sig.anything`) because only the first two elements
  // were destructured; both halves are base64url and can never contain a dot,
  // so exactly two parts is the only valid form. The length cap stops an
  // unbounded query-string value reaching the HMAC.
  if (typeof state !== "string" || state.length > 512) {
    throw new Error("Xero OAuth state is malformed.")
  }
  const parts = state.split(".")
  if (parts.length !== 2) {
    throw new Error("Xero OAuth state is malformed.")
  }
  const [nonce, signature] = parts
  if (!nonce || !signature || !verifyStateNonce(nonce, signature)) {
    throw new Error("Xero OAuth state failed signature verification — possible CSRF or forged callback.")
  }

  const rows = await db
    .update(xeroOauthState)
    .set({ consumedAt: new Date() })
    .where(and(eq(xeroOauthState.nonce, nonce), isNull(xeroOauthState.consumedAt), gt(xeroOauthState.expiresAt, new Date())))
    .returning({ codeVerifierEncrypted: xeroOauthState.codeVerifierEncrypted })

  if (rows.length === 0) {
    throw new Error("Xero OAuth state was already used, has expired, or is unknown — restart the connect flow.")
  }
  const codeVerifier = decryptSecret(rows[0].codeVerifierEncrypted, OAUTH_VERIFIER_PURPOSE)
  return { codeVerifier }
}

type XeroTokenResponse = {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  scope: string
}

function basicAuthHeader(): string {
  const clientId = requireEnv("XERO_CLIENT_ID")
  const clientSecret = requireClientSecret()
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
}

/**
 * Extracts only the OAuth `error` code from an error body, never the body
 * itself. These errors propagate out to `/api/xero/callback`, which is a
 * public unauthenticated URL — echoing an upstream response body there is how
 * configuration detail leaks. An `invalid_grant`-style code is safe and
 * useful; anything unrecognised collapses to null.
 */
function safeOauthErrorCode(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    const code = typeof parsed.error === "string" ? parsed.error : null
    return code && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : null
  } catch {
    return null
  }
}

async function postToken(body: URLSearchParams): Promise<XeroTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(XERO_HTTP_TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    const code = safeOauthErrorCode(text)
    // Deliberately does not include `text`, and never includes the request
    // body — that body holds the authorisation code, the PKCE verifier or the
    // refresh token depending on the grant.
    throw new Error(`Xero token endpoint returned ${res.status}${code ? ` (${code})` : ""}.`)
  }
  return (await res.json()) as XeroTokenResponse
}

/** Exchanges an authorisation code (from the callback) for an access/refresh token pair. */
export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<XeroTokenResponse> {
  const redirectUri = requireRedirectUri()
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  })
  return postToken(body)
}

async function refreshWithXero(refreshToken: string): Promise<XeroTokenResponse> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken })
  return postToken(body)
}

export type XeroTenant = { tenantId: string; tenantName: string }

/** Resolves which Xero organisation(s) this access token is authorised for. */
export async function resolveTenants(accessToken: string): Promise<XeroTenant[]> {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(XERO_HTTP_TIMEOUT_MS),
  })
  if (!res.ok) {
    // Status only — the body is not echoed into an error that reaches a public route.
    throw new Error(`Xero /connections returned ${res.status}.`)
  }
  const rows = (await res.json()) as Array<{ tenantId: string; tenantName: string; tenantType: string }>
  return rows.filter((r) => r.tenantType === "ORGANISATION").map((r) => ({ tenantId: r.tenantId, tenantName: r.tenantName }))
}

/**
 * Access tokens are stored encrypted from Phase 2 onward, under their own
 * HKDF-derived key. The 30-minute lifetime is short, but the token is a live
 * bearer credential carrying write-capable scopes, so a read-only compromise
 * of the database (leaked Neon URL, a SQL-injection sink elsewhere in the
 * app) should not hand over a usable one. Rows written before this change
 * hold plaintext; those are read as-is and re-encrypted on the next refresh,
 * so no migration or DDL is required.
 */
function readStoredAccessToken(stored: string | null): string | null {
  if (!stored) return null
  return isEncryptedSecret(stored) ? decryptSecret(stored, ACCESS_TOKEN_PURPOSE) : stored
}

/**
 * Which Xero organisation this deployment is allowed to hold a connection to.
 *
 * `/api/xero/callback` is unauthenticated, so without a pin an anonymous
 * attacker can run the whole flow against *their own* Xero organisation and
 * have Gilbert OS persist it. `getMostRecentConnection` would then hand every
 * subsequent read to the attacker's tenant — the app silently starts reporting
 * a stranger's accounting data as Gilbert Build Co's.
 *
 * Set `XERO_ALLOWED_TENANT_ID` to pin explicitly. If it is unset, the first
 * tenant ever connected wins and every later callback must match one already
 * stored — trust-on-first-use. That closes the hole on any deployment that is
 * already connected (production is), but leaves the very first callback on a
 * fresh database open to whoever reaches it first. Only real authentication in
 * front of these routes closes that window properly.
 */
function pinnedTenantId(): string | null {
  const value = process.env.XERO_ALLOWED_TENANT_ID?.trim()
  return value ? value : null
}

/** Persists (or updates) a connected tenant's tokens after a successful code exchange. Upserts on `tenant_id`, and refuses any tenant this deployment is not pinned to. */
export async function persistConnection(tenant: XeroTenant, tokens: XeroTokenResponse): Promise<void> {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
  const encryptedRefresh = encryptSecret(tokens.refresh_token, REFRESH_TOKEN_PURPOSE)
  const encryptedAccess = encryptSecret(tokens.access_token, ACCESS_TOKEN_PURPOSE)
  const now = new Date()

  await db.transaction(async (tx) => {
    // Serialise the check-then-insert against concurrent callbacks, so two
    // simultaneous first-time authorisations cannot both pass the
    // trust-on-first-use test and race a different tenant in.
    await tx.execute(sql`select pg_advisory_xact_lock(${CONNECTION_LOCK_KEY})`)

    const pinned = pinnedTenantId()
    if (pinned) {
      if (tenant.tenantId !== pinned) {
        throw new Error(
          `Refusing to persist Xero tenant ${tenant.tenantId}: this deployment is pinned to ${pinned} via XERO_ALLOWED_TENANT_ID.`,
        )
      }
    } else {
      const existing = await tx.select({ tenantId: xeroConnections.tenantId }).from(xeroConnections)
      if (existing.length > 0 && !existing.some((row) => row.tenantId === tenant.tenantId)) {
        throw new Error(
          `Refusing to persist Xero tenant ${tenant.tenantId}: this deployment is already connected to a different ` +
            "organisation. Delete the existing xero_connections row deliberately, or set XERO_ALLOWED_TENANT_ID, " +
            "to change which organisation Gilbert OS reads.",
        )
      }
    }

    await tx
      .insert(xeroConnections)
      .values({
        tenantId: tenant.tenantId,
        tenantName: tenant.tenantName,
        accessToken: encryptedAccess,
        refreshTokenEncrypted: encryptedRefresh,
        expiresAt,
        scopes: tokens.scope,
        connectedAt: now,
        lastRefreshedAt: now,
        lastError: null,
      })
      .onConflictDoUpdate({
        target: xeroConnections.tenantId,
        set: {
          tenantName: tenant.tenantName,
          accessToken: encryptedAccess,
          refreshTokenEncrypted: encryptedRefresh,
          expiresAt,
          scopes: tokens.scope,
          lastRefreshedAt: now,
          lastError: null,
          updatedAt: now,
        },
      })
  })
}

async function getConnectionRow(tenantId: string) {
  const rows = await db
    .select({
      tenantId: xeroConnections.tenantId,
      tenantName: xeroConnections.tenantName,
      accessToken: xeroConnections.accessToken,
      refreshTokenEncrypted: xeroConnections.refreshTokenEncrypted,
      expiresAt: xeroConnections.expiresAt,
    })
    .from(xeroConnections)
    .where(eq(xeroConnections.tenantId, tenantId))
    .limit(1)
  return rows[0] ?? null
}

/**
 * The tenant this deployment reads from. When `XERO_ALLOWED_TENANT_ID` is set
 * it wins outright; otherwise the *earliest* connected tenant is used rather
 * than the most recent, so that even if a row for another organisation were
 * somehow inserted, it could not silently take over the default tenant.
 * Ordering is fully deterministic (id breaks a createdAt tie).
 */
export async function getMostRecentConnection(): Promise<{ tenantId: string; tenantName: string | null } | null> {
  const pinned = pinnedTenantId()
  if (pinned) {
    const row = await getConnectionRow(pinned)
    return row ? { tenantId: row.tenantId, tenantName: row.tenantName } : null
  }
  const rows = await db
    .select({ tenantId: xeroConnections.tenantId, tenantName: xeroConnections.tenantName })
    .from(xeroConnections)
    .orderBy(asc(xeroConnections.createdAt), asc(xeroConnections.id))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Refreshes an expired/expiring access token.
 *
 * Xero rotates the refresh token on every use and the spent one dies
 * immediately, so the dangerous failure mode is not a slow refresh — it is
 * *two* refreshes. This is guarded on both axes: an in-process single-flight
 * map collapses concurrent callers on one instance, and a `SELECT … FOR
 * UPDATE` row lock serialises separate instances. Whoever waits on the lock
 * re-reads the row afterwards and returns the winner's freshly-stored token
 * instead of burning another rotation.
 *
 * The rotated pair is written inside the same transaction that holds the
 * lock, so it lands whole or not at all. A Xero HTTP call and a Postgres
 * commit still cannot be one transaction — a crash in between burns the old
 * token and orphans the connection — so any failure is recorded to
 * `last_error` and rethrown rather than leaving a row that looks healthy.
 */
export async function refreshConnection(tenantId: string): Promise<{ accessToken: string; expiresAt: Date }> {
  // In-process single flight. Two requests arriving together on the same
  // instance previously both decrypted the same refresh token and both called
  // Xero; the loser's rotation would either fail outright or clobber the
  // winner's newer token with a spent one, permanently orphaning the
  // connection. This collapses same-instance concurrency to one call; the
  // advisory row lock below covers separate instances.
  const existing = inFlightRefreshes.get(tenantId)
  if (existing) return existing

  const attempt = refreshConnectionExclusive(tenantId).finally(() => {
    inFlightRefreshes.delete(tenantId)
  })
  inFlightRefreshes.set(tenantId, attempt)
  return attempt
}

const inFlightRefreshes = new Map<string, Promise<{ accessToken: string; expiresAt: Date }>>()

async function refreshConnectionExclusive(tenantId: string): Promise<{ accessToken: string; expiresAt: Date }> {
  try {
    return await db.transaction(async (tx) => {
      // Bound the wait so a stuck holder cannot block this request forever;
      // the Xero call itself is capped by XERO_HTTP_TIMEOUT_MS.
      await tx.execute(sql`set local lock_timeout = '30s'`)

      const rows = await tx
        .select({
          accessToken: xeroConnections.accessToken,
          refreshTokenEncrypted: xeroConnections.refreshTokenEncrypted,
          expiresAt: xeroConnections.expiresAt,
        })
        .from(xeroConnections)
        .where(eq(xeroConnections.tenantId, tenantId))
        .limit(1)
        .for("update")

      const row = rows[0]
      if (!row) {
        throw new Error(`No Xero connection found for tenant ${tenantId}. Connect via /api/xero/connect first.`)
      }

      // Re-check after acquiring the lock: another instance may have refreshed
      // while this one waited, in which case its token is already valid and
      // burning another rotation would be pointless and risky.
      const storedAccessToken = readStoredAccessToken(row.accessToken)
      if (storedAccessToken && row.expiresAt && row.expiresAt.getTime() - Date.now() > REFRESH_EXPIRY_BUFFER_MS) {
        return { accessToken: storedAccessToken, expiresAt: row.expiresAt }
      }

      if (!row.refreshTokenEncrypted) {
        throw new Error(`Xero connection for tenant ${tenantId} has no stored refresh token — reconnect via /api/xero/connect.`)
      }

      const currentRefreshToken = decryptSecret(row.refreshTokenEncrypted, REFRESH_TOKEN_PURPOSE)
      const tokens = await refreshWithXero(currentRefreshToken)
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
      const now = new Date()

      // The UPDATE is the last statement before COMMIT and runs while this
      // transaction still holds the row lock, so the rotated pair either lands
      // whole or not at all — no window in which a concurrent writer can
      // interleave. This is as close to atomic-with-the-token-response as is
      // achievable: Xero's rotation and a Postgres commit cannot be one
      // transaction, so a crash between the two still burns the old token.
      const updated = await tx
        .update(xeroConnections)
        .set({
          accessToken: encryptSecret(tokens.access_token, ACCESS_TOKEN_PURPOSE),
          refreshTokenEncrypted: encryptSecret(tokens.refresh_token, REFRESH_TOKEN_PURPOSE),
          expiresAt,
          lastRefreshedAt: now,
          updatedAt: now,
          lastError: null,
        })
        .where(eq(xeroConnections.tenantId, tenantId))
        .returning({ id: xeroConnections.id })

      if (updated.length === 0) {
        throw new Error(`Xero connection row for tenant ${tenantId} disappeared mid-refresh.`)
      }
      return { accessToken: tokens.access_token, expiresAt }
    })
  } catch (err) {
    // Best effort, outside the (now rolled back) transaction. If the failure
    // happened after Xero rotated, the old refresh token is already dead and
    // the connection needs reauthorising — record that rather than leaving a
    // row that looks healthy.
    await db
      .update(xeroConnections)
      .set({ lastError: `refresh failed: ${(err as Error)?.message ?? String(err)}`, updatedAt: new Date() })
      .where(eq(xeroConnections.tenantId, tenantId))
      .catch(() => {})
    throw err
  }
}

/** Returns a currently-valid access token for `tenantId`, refreshing first if it is missing or within `REFRESH_EXPIRY_BUFFER_MS` of expiry. */
export async function getValidAccessToken(tenantId: string): Promise<{ accessToken: string; tenantId: string }> {
  const row = await getConnectionRow(tenantId)
  if (!row) {
    throw new Error(`No Xero connection found for tenant ${tenantId}. Connect via /api/xero/connect first.`)
  }
  const expiresAtMs = row.expiresAt ? row.expiresAt.getTime() : 0
  const storedAccessToken = readStoredAccessToken(row.accessToken)
  if (!storedAccessToken || expiresAtMs - Date.now() < REFRESH_EXPIRY_BUFFER_MS) {
    const refreshed = await refreshConnection(tenantId)
    return { accessToken: refreshed.accessToken, tenantId }
  }
  return { accessToken: storedAccessToken, tenantId }
}
