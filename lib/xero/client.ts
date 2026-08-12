import "server-only"
import { getMostRecentConnection, getValidAccessToken, refreshConnection } from "./oauth"

/**
 * Thin authenticated fetch wrapper around the Xero Accounting API
 * (`api.xero.com/api.xro/2.0/...`). Injects the bearer token and
 * `Xero-Tenant-Id`, transparently refreshes once on a 401, and backs off on
 * 429 honouring `Retry-After` (falling back to exponential backoff if the
 * header is absent).
 *
 * HARD WRITE GATE: every non-GET request is refused unless
 * `XERO_WRITE_ENABLED` is exactly the string "true" — see
 * `assertMethodAllowed` below, which runs before any network call is made
 * *and again* immediately before each individual `fetch`, so the 401-retry
 * and 429-backoff paths are covered too. The flag is read once at module load
 * into a frozen constant, so nothing at runtime (including a compromised
 * dependency mutating `process.env`) can flip it mid-process. Only a
 * deliberate environment change plus a restart can enable it. Nothing in this
 * codebase currently issues a non-GET call through this wrapper — `xeroGet`
 * (the only helper anything here uses) cannot express one.
 *
 * The gate is method-based, so anything that could turn a GET into a write
 * *after* the check is part of the gate's attack surface. Three such routes
 * are closed here: the request URL is pinned to `https://api.xero.com`
 * (no arbitrary host can be handed the bearer token), redirects are never
 * followed, and method-override headers/params are stripped before they can
 * reach a gateway that honours them.
 */

const XERO_API_BASE = "https://api.xero.com"

/** Hard ceiling on any single Xero call, so a hung connection cannot pin a DB row lock (see `refreshConnection`) or a pacing slot indefinitely. */
const REQUEST_TIMEOUT_MS = 30_000

/** Upper bound on an honoured `Retry-After`, so a hostile or malformed header cannot park the process for hours. */
const MAX_RETRY_AFTER_MS = 60_000

// --- write gate --------------------------------------------------------------

/**
 * Snapshotted at module load, not read per call. Reading `process.env` on
 * every request would let any in-process code (or a future server action that
 * sets env vars) open the gate at runtime; a frozen constant cannot be
 * reopened without a restart.
 */
const WRITE_ENABLED: boolean = process.env.XERO_WRITE_ENABLED === "true"

function assertMethodAllowed(method: string) {
  const m = method.toUpperCase()
  if (m === "GET" || m === "HEAD") return
  if (!WRITE_ENABLED) {
    throw new Error(
      `Xero write blocked: attempted ${m} but XERO_WRITE_ENABLED is not the string "true". Writes to Xero are ` +
        "off by default because Gilbert OS has no authentication layer yet and is deployed on a public URL. " +
        "Enabling this requires a deliberate environment change (XERO_WRITE_ENABLED=true), never a code path.",
    )
  }
}

/**
 * Resolves a caller-supplied path against the Xero API origin and refuses
 * anything that lands elsewhere. Without this, `path.startsWith("http")` meant
 * any absolute URL — an attacker-influenced value such as a pagination link
 * echoed back inside a Xero response, or a path built from user input — would
 * be sent a live `Authorization: Bearer` header and the tenant id. Absolute,
 * protocol-relative (`//evil.example`) and traversal forms all normalise
 * through `new URL` before the origin is checked.
 */
function resolveXeroUrl(path: string): URL {
  let url: URL
  try {
    url = new URL(path, XERO_API_BASE)
  } catch {
    throw new Error("Xero request blocked: path is not a valid URL.")
  }
  if (url.origin !== XERO_API_BASE) {
    throw new Error(
      `Xero request blocked: refusing to send Xero credentials to ${url.origin}. Only ${XERO_API_BASE} is permitted.`,
    )
  }
  // `_method=DELETE` style tunnelling: strip rather than trust that Xero's
  // gateway ignores it. Same reasoning as the header strip below.
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === "_method" || key.toLowerCase() === "x-http-method-override") {
      url.searchParams.delete(key)
    }
  }
  return url
}

/**
 * Headers that let a caller ask an intermediary to reinterpret a GET as a
 * write. Whether or not Xero's gateway honours them today, a request that
 * passed the write gate as a GET must not carry one.
 */
const METHOD_OVERRIDE_HEADERS = ["x-http-method-override", "x-method-override", "x-http-method"]

// --- rate pacing (60 calls/min, best-effort 5000/day) -------------------------
// Mirrors the shape of lib/rate-governor.ts (single-flight + min spacing) but
// is kept local to this module rather than sharing that singleton, since it
// governs a completely different outbound integration with its own limits.

/** Slightly over 1000ms so 60 calls/min is respected with margin, not raced against. */
const MIN_INTERVAL_MS = 1050
/** Xero's documented daily ceiling. This counter is in-process/in-memory only — it does not persist across cold starts or span multiple instances, so treat it as a safety margin, not a guarantee. */
const MAX_DAILY_CALLS = 5000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let chain: Promise<void> = Promise.resolve()
let nextAllowedAt = 0
let dayWindowStart = Date.now()
let dayCallCount = 0

async function paceCall<T>(fn: () => Promise<T>): Promise<T> {
  const gate = chain.then(() => waitForSlot())
  chain = gate.catch(() => {})
  await gate
  return fn()
}

async function waitForSlot() {
  const now = Date.now()
  if (now - dayWindowStart > 24 * 60 * 60 * 1000) {
    dayWindowStart = now
    dayCallCount = 0
  }
  if (dayCallCount >= MAX_DAILY_CALLS) {
    throw new Error(
      `Xero daily call budget (${MAX_DAILY_CALLS}) exhausted for this process. This is an in-memory, best-effort ` +
        "counter — it resets on cold start and does not span multiple instances.",
    )
  }
  const wait = nextAllowedAt - now
  if (wait > 0) await sleep(wait)
  nextAllowedAt = Date.now() + MIN_INTERVAL_MS
  dayCallCount++
}

// --- fetch wrapper -------------------------------------------------------------

export type XeroFetchInit = RequestInit & { tenantId?: string }

async function requireTenantId(): Promise<string> {
  const conn = await getMostRecentConnection()
  if (!conn) {
    throw new Error("No Xero connection exists yet. Visit /api/xero/connect to authorise Gilbert Build Co LTD first.")
  }
  return conn.tenantId
}

type RetryState = { retried401: boolean; retry429: number }

async function doFetch(path: string, init: XeroFetchInit, method: string, tenantId: string, state: RetryState): Promise<Response> {
  // Re-asserted here rather than only at the entry point: this function
  // recurses on 401 and on 429, so the gate must hold on every network call,
  // not just the first one.
  assertMethodAllowed(method)

  const { accessToken } = await getValidAccessToken(tenantId)
  const url = resolveXeroUrl(path)

  const headers = new Headers(init.headers)
  for (const name of METHOD_OVERRIDE_HEADERS) headers.delete(name)
  // Set last so a caller-supplied `Authorization` or `Xero-Tenant-Id` in
  // `init.headers` is replaced, never merged.
  headers.set("Authorization", `Bearer ${accessToken}`)
  headers.set("Xero-Tenant-Id", tenantId)
  if (!headers.has("Accept")) headers.set("Accept", "application/json")

  const isBodyless = method === "GET" || method === "HEAD"
  const res = await fetch(url, {
    ...init,
    // Everything below overrides `init`, so none of it can be smuggled
    // through the caller-supplied object.
    method,
    headers,
    // A GET carrying a body is rejected by undici anyway; drop it explicitly
    // so the intent is not ambiguous at the call site.
    body: isBodyless ? undefined : init.body,
    // Never follow a redirect. A 3xx cannot upgrade a GET into a POST, but it
    // can move the request to another host; undici strips `Authorization`
    // cross-origin but not `Xero-Tenant-Id`, and a redirect chain is exactly
    // the kind of thing the origin pin above exists to prevent.
    redirect: "manual",
    // Combined rather than replaced, so the hard timeout always applies while
    // a caller-supplied signal can still cancel earlier.
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Xero returned an unexpected ${res.status} redirect for ${method} ${url.pathname}; not followed.`)
  }

  if (res.status === 401 && !state.retried401) {
    await refreshConnection(tenantId)
    return doFetch(path, init, method, tenantId, { ...state, retried401: true })
  }

  if (res.status === 429) {
    const maxRetries = 5
    if (state.retry429 >= maxRetries) {
      throw new Error(`Xero rate limit (429) persisted after ${maxRetries} retries for ${method} ${url.pathname}.`)
    }
    const retryAfterHeader = res.headers.get("Retry-After")
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : null
    const suggestedMs =
      retryAfterSeconds != null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? retryAfterSeconds * 1000
        : 2 ** state.retry429 * 1000
    // `Retry-After` is a response header — clamp it rather than sleeping for
    // whatever an upstream (or anything able to sit in front of it) supplies.
    const delayMs = Math.min(suggestedMs, MAX_RETRY_AFTER_MS)
    await sleep(delayMs)
    return doFetch(path, init, method, tenantId, { ...state, retry429: state.retry429 + 1 })
  }

  return res
}

/**
 * General-purpose authenticated Xero fetch. Kept generic (arbitrary
 * `init.method`) so future write support has somewhere to attach once the
 * write gate is deliberately opened — but `assertMethodAllowed` refuses every
 * non-GET call unless `XERO_WRITE_ENABLED === "true"`, checked before any
 * network request is made and again inside `doFetch` before each individual
 * `fetch`. Nothing in this codebase calls this with a non-GET method today.
 *
 * `init.method` is stringified and normalised to upper case exactly once,
 * here, and the resulting primitive is what both the gate and the `fetch`
 * receive — so a caller cannot pass an object whose `toString` returns "GET"
 * to the check and "POST" to the request.
 */
export async function xeroFetch(path: string, init: XeroFetchInit = {}): Promise<Response> {
  const method = String(init.method ?? "GET").toUpperCase()
  assertMethodAllowed(method)
  const tenantId = init.tenantId ?? (await requireTenantId())
  // Resolve (and origin-check) the URL before consuming a pacing slot, so a
  // blocked request fails immediately instead of after a rate-limit wait.
  resolveXeroUrl(path)
  return paceCall(() => doFetch(path, init, method, tenantId, { retried401: false, retry429: 0 }))
}

/** Convenience wrapper that can only ever issue a GET — there is no `method` to override. Use this for all read access. */
export async function xeroGet(path: string, init: Omit<XeroFetchInit, "method"> = {}): Promise<Response> {
  return xeroFetch(path, { ...init, method: "GET" })
}
