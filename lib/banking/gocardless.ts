import "server-only"

/**
 * GoCardless Bank Account Data (formerly Nordigen) — read-only access to the
 * business bank account's balances and transactions.
 *
 * WHY DIRECT, NOT VIA XERO. Owner, 2026-08-23: "i dont know where Xero gets its
 * bank numbers from, because they're not right." Xero's balance depends on its
 * feed being current AND every statement line being reconciled; unreconciled
 * lines sit in a queue this app cannot read (Xero refuses the
 * `accounting.reports.bankstatement.read` scope). Reading the bank directly
 * removes that dependency entirely.
 *
 * WHAT THIS CAN AND CANNOT DO. The API is read-only: balances, account details
 * and transactions. It cannot initiate a payment, and no code here should ever
 * be extended to. Bank credentials never touch this system — the owner
 * authenticates at his own bank through the consent link, and what returns is a
 * requisition the provider honours for 90 days.
 *
 * CREDENTIALS come from the environment (GOCARDLESS_SECRET_ID /
 * GOCARDLESS_SECRET_KEY) and are never written to the repo or logged.
 */

const BASE = "https://bankaccountdata.gocardless.com/api/v2"

export type GcToken = { access: string; access_expires: number; refresh: string; refresh_expires: number }

function creds() {
  const secret_id = process.env.GOCARDLESS_SECRET_ID
  const secret_key = process.env.GOCARDLESS_SECRET_KEY
  if (!secret_id || !secret_key) {
    throw new Error(
      "GOCARDLESS_SECRET_ID / GOCARDLESS_SECRET_KEY are not set. Add them to .env.local — " +
      "they come from the GoCardless Bank Account Data developer portal.",
    )
  }
  return { secret_id, secret_key }
}

/** Exchange the portal secrets for a short-lived access token. */
export async function getToken(): Promise<GcToken> {
  const res = await fetch(`${BASE}/token/new/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(creds()),
  })
  if (!res.ok) throw new Error(`GoCardless token: ${res.status} ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as GcToken
}

async function gc<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", ...(init?.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`GoCardless ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  return (await res.json()) as T
}

export type Institution = { id: string; name: string; bic?: string; transaction_total_days?: string; logo?: string }

/** Banks available in a country (GB by default). Used to find the right institution id. */
export function listInstitutions(token: string, country = "gb") {
  return gc<Institution[]>(token, `/institutions/?country=${country}`)
}

export type Requisition = { id: string; link: string; status: string; accounts: string[]; institution_id: string }

/**
 * Start a consent. Returns a `link` the OWNER opens and authenticates at their
 * own bank — this process never sees or handles their credentials.
 */
export function createRequisition(token: string, institutionId: string, redirect: string, reference: string) {
  return gc<Requisition>(token, "/requisitions/", {
    method: "POST",
    body: JSON.stringify({ redirect, institution_id: institutionId, reference, user_language: "EN" }),
  })
}

export function getRequisition(token: string, id: string) {
  return gc<Requisition>(token, `/requisitions/${id}/`)
}

export type BalanceAmount = { amount: string; currency: string }
export type Balance = { balanceAmount: BalanceAmount; balanceType: string; referenceDate?: string }

export function getBalances(token: string, accountId: string) {
  return gc<{ balances: Balance[] }>(token, `/accounts/${accountId}/balances/`)
}

export type GcTransaction = {
  transactionId?: string
  internalTransactionId?: string
  bookingDate?: string
  valueDate?: string
  transactionAmount: BalanceAmount
  creditorName?: string
  debtorName?: string
  remittanceInformationUnstructured?: string
  remittanceInformationUnstructuredArray?: string[]
}

export function getTransactions(token: string, accountId: string) {
  return gc<{ transactions: { booked: GcTransaction[]; pending: GcTransaction[] } }>(token, `/accounts/${accountId}/transactions/`)
}

export function getAccountDetails(token: string, accountId: string) {
  return gc<{ account: Record<string, any> }>(token, `/accounts/${accountId}/details/`)
}

/** The counterparty as a human would name it, without inventing one. */
export function counterpartyOf(t: GcTransaction): string | null {
  return t.creditorName ?? t.debtorName ?? null
}

/** Free-text reference, joining the array form some banks use. */
export function referenceOf(t: GcTransaction): string | null {
  if (t.remittanceInformationUnstructured) return t.remittanceInformationUnstructured
  const arr = t.remittanceInformationUnstructuredArray
  return arr && arr.length ? arr.join(" ") : null
}
