import "server-only"
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Symmetric-crypto primitives for the Xero OAuth layer. Nothing here talks to
 * Xero or the database — it only turns secrets into ciphertext (and back)
 * and signs/verifies the OAuth `state` nonce. Every key used below is
 * *derived* (HKDF-SHA256) from a single operator-provided master key, so
 * refresh-token encryption and state-signing never share raw key material
 * even though they come from the same secret.
 *
 * `XERO_TOKEN_ENCRYPTION_KEY` is never generated or stored by this codebase.
 * The owner generates it out of band (e.g. `openssl rand -base64 32`) and
 * sets it directly in the deploy environment. If it is absent, every
 * function below throws immediately and loudly — there is no fallback and
 * no way to silently proceed without it.
 */

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH_BYTES = 12 // standard GCM nonce size
const AUTH_TAG_LENGTH_BYTES = 16 // full-length GCM tag — short tags are refused outright
const KEY_LENGTH_BYTES = 32 // AES-256

/**
 * Purpose labels double as HKDF "info" — domain separation between what a
 * derived key may decrypt/sign. These four strings are distinct and none is a
 * prefix of another, so HKDF-SHA256 cannot produce the same key for two of
 * them (verified: four distinct 32-byte outputs from an identical master key).
 * A ciphertext produced under one purpose fails its GCM auth tag under any
 * other, which is what stops a stored PKCE verifier from being replayed into
 * the refresh-token slot, or an access token into the refresh-token slot.
 */
export const REFRESH_TOKEN_PURPOSE = "xero-refresh-token-encryption-v1"
export const OAUTH_VERIFIER_PURPOSE = "xero-oauth-verifier-encryption-v1"
export const ACCESS_TOKEN_PURPOSE = "xero-access-token-encryption-v1"
const STATE_SIGNING_PURPOSE = "xero-oauth-state-signing-v1"

/**
 * Node's base64 decoder silently ignores characters outside the alphabet, so
 * `Buffer.from(x, "base64")` will happily turn a 47-character string of junk
 * into 32 "valid" bytes. Validate the encoding strictly first, so a mangled
 * or truncated key is rejected instead of quietly becoming a different (and
 * possibly much weaker) key than the operator generated.
 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/
const HEX_RE = /^[0-9a-fA-F]+$/

function readMasterKey(): Buffer {
  const raw = process.env.XERO_TOKEN_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      "XERO_TOKEN_ENCRYPTION_KEY is not set. This key encrypts Xero refresh tokens at rest and signs the OAuth " +
        "state parameter — Gilbert OS refuses to run any Xero OAuth code without it. Generate one yourself " +
        "(e.g. `openssl rand -base64 32`) and set XERO_TOKEN_ENCRYPTION_KEY in the environment. This value is " +
        "never generated, stored, or logged by this codebase.",
    )
  }

  // Accept base64, base64url or hex, whichever decodes to exactly 32 bytes,
  // and only when the string is *entirely* valid in that encoding. Reject
  // anything else rather than silently truncating/padding a weak key.
  const trimmed = raw.trim()
  if (HEX_RE.test(trimmed)) {
    const asHex = Buffer.from(trimmed, "hex")
    if (asHex.length === KEY_LENGTH_BYTES) return asHex
  }
  if (BASE64_RE.test(trimmed)) {
    const asBase64 = Buffer.from(trimmed, "base64")
    if (asBase64.length === KEY_LENGTH_BYTES) return asBase64
  }
  if (BASE64URL_RE.test(trimmed)) {
    const asBase64Url = Buffer.from(trimmed, "base64url")
    if (asBase64Url.length === KEY_LENGTH_BYTES) return asBase64Url
  }
  throw new Error(
    `XERO_TOKEN_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH_BYTES} bytes, as base64 or hex, with no ` +
      "characters outside that alphabet. Generate a fresh one with `openssl rand -base64 32` and set it as " +
      "XERO_TOKEN_ENCRYPTION_KEY.",
  )
}

/** Derives a purpose-scoped 32-byte key from the master key via HKDF-SHA256. Never caches the master key across calls. */
function deriveKey(purpose: string): Buffer {
  const master = readMasterKey()
  const derived = hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from(purpose, "utf8"), KEY_LENGTH_BYTES)
  return Buffer.from(derived)
}

/**
 * Encrypts a secret string with AES-256-GCM under a purpose-derived key.
 * Format: `v1:<ivBase64>:<authTagBase64>:<ciphertextBase64>`. `purpose`
 * defaults to refresh-token encryption; pass `OAUTH_VERIFIER_PURPOSE` for
 * the short-lived PKCE verifier instead so the two never share a key.
 */
export function encryptSecret(plaintext: string, purpose: string = REFRESH_TOKEN_PURPOSE): string {
  const key = deriveKey(purpose)
  const iv = randomBytes(IV_LENGTH_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return ["v1", iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":")
}

/** True when `value` has the shape `encryptSecret` produces. Lets a reader distinguish ciphertext from a legacy plaintext column value without attempting a decrypt. */
export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("v1:") && value.split(":").length === 4
}

/**
 * Decrypts a value produced by `encryptSecret`. Throws if malformed or the
 * auth tag fails to verify (tamper, or wrong key/purpose).
 *
 * IV and auth-tag lengths are pinned. Node accepts a GCM tag as short as 4
 * bytes via `setAuthTag`, which would cut forgery resistance from 2^-128 to
 * 2^-32 — so anyone able to write to `xero_connections` could truncate the
 * stored tag and then brute-force a forged ciphertext. Requiring the full
 * 16-byte tag and the 12-byte nonce removes that downgrade.
 */
export function decryptSecret(payload: string, purpose: string = REFRESH_TOKEN_PURPOSE): string {
  const parts = payload.split(":")
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Cannot decrypt Xero secret: unrecognised ciphertext format.")
  }
  const [, ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, "base64")
  const authTag = Buffer.from(tagB64, "base64")
  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error(`Cannot decrypt Xero secret: nonce must be exactly ${IV_LENGTH_BYTES} bytes.`)
  }
  if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error(`Cannot decrypt Xero secret: auth tag must be exactly ${AUTH_TAG_LENGTH_BYTES} bytes.`)
  }
  const key = deriveKey(purpose)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()])
  return plaintext.toString("utf8")
}

/** HMAC-SHA256 signature for an OAuth `state` nonce, so a callback can reject a forged/tampered state before ever touching the database. */
export function signStateNonce(nonce: string): string {
  return createHmac("sha256", deriveKey(STATE_SIGNING_PURPOSE)).update(nonce).digest("base64url")
}

/**
 * Constant-time verification of `signStateNonce`'s output. `signature` comes
 * straight off an attacker-controllable query string, so it is type-guarded
 * before use and compared with `timingSafeEqual` — never `===`. The
 * length pre-check only reveals the length of a signature whose length is a
 * fixed, public property of HMAC-SHA256 (43 base64url characters).
 */
export function verifyStateNonce(nonce: string, signature: string): boolean {
  if (typeof nonce !== "string" || typeof signature !== "string") return false
  const expected = Buffer.from(signStateNonce(nonce), "utf8")
  const actual = Buffer.from(signature, "utf8")
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}
