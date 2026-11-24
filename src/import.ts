// --import: move one customer's Connect accounts for one app into Truto.
// The logic is the reviewed script from "The migration in six steps", step 5, of
// https://truto.one/blog/how-to-migrate-pipedream-workflows-to-truto/
// Changes from the guide are marked "Change from the guide" and listed in the README.
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { ImportApp } from './config'
import { send, type Clock, type FetchFn } from './http'
import type { PdAccount, Pipedream } from './pipedream'

export const TRUTO_API = 'https://api.truto.one'

// Pipedream account id -> where it stands. A rerun finishes what is left.
// `importStartedAt` without `trutoId` means a run stopped while creating the Truto account.
export type Entry = { trutoId?: string; deleted: boolean; importStartedAt?: string }
export type Ledger = Record<string, Entry>

export type ImportOptions = {
  appName: string
  app: ImportApp
  externalUserId: string
  pd: Pipedream
  trutoToken: string
  ledgerPath: string
  fetch: FetchFn
  clock: Clock
  log: (msg: string) => void
  warn: (msg: string) => void
}

export type ImportResult = { moved: string[]; skipped: string[]; pending: string[] }

function readLedger(path: string): Ledger {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Ledger) : {}
}

// Change from the guide: write to a temp file, then rename, so a crash never leaves half a ledger.
function writeLedger(path: string, ledger: Ledger): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}

// Change from the guide: build the read URL with URL(), and refuse any origin but Truto's.
// String concatenation let a cheapRead such as "@evil.example/x" send the Truto token elsewhere.
export function cheapReadUrl(cheapRead: string, trutoId: string): URL {
  const url = new URL(cheapRead, TRUTO_API)
  if (url.origin !== TRUTO_API) throw new Error(`cheapRead must stay on ${TRUTO_API}`)
  url.searchParams.set('integrated_account_id', trutoId)
  return url
}

// Change from the guide: one run at a time per ledger. Each run rewrites the whole ledger,
// so two parallel runs would drop each other's entries and a rerun would import twice.
export async function migrateCustomer(o: ImportOptions): Promise<ImportResult> {
  const lockPath = `${o.ledgerPath}.lock`
  let fd: number
  try {
    fd = openSync(lockPath, 'wx', 0o600)
  } catch (e) {
    if ((e as { code?: string }).code !== 'EEXIST') throw e
    throw new Error(`Another run holds ${lockPath}. If no run is active, delete that file and run again.`)
  }
  try {
    try {
      writeFileSync(fd, String(process.pid))
    } finally {
      closeSync(fd)
    }
    return await migrateLocked(o)
  } finally {
    unlinkSync(lockPath)
  }
}

async function migrateLocked(o: ImportOptions): Promise<ImportResult> {
  const { app, externalUserId, clock } = o
  const result: ImportResult = { moved: [], skipped: [], pending: [] }
  const ledger = readLedger(o.ledgerPath)
  const save = () => writeLedger(o.ledgerPath, ledger)
  const trutoHeaders = { Authorization: `Bearer ${o.trutoToken}`, 'Content-Type': 'application/json' }
  const truto = (url: string | URL, init: RequestInit = {}) =>
    send(o.fetch, clock, url, { ...init, headers: trutoHeaders })
  const accountUrl = (id: string) => `${TRUTO_API}/integrated-account/${encodeURIComponent(id)}`

  // Post-install steps run after the import. Wait until the account leaves `connecting`.
  // Returns 'gone' on a 404, so the caller can decide what that means.
  async function settledStatus(trutoId: string): Promise<string> {
    const deadline = clock.now() + 5 * 60 * 1000
    while (clock.now() < deadline) {
      const res = await truto(accountUrl(trutoId))
      if (res.status === 404) return 'gone'
      if (!res.ok) throw new Error(`Truto account ${trutoId}: HTTP ${res.status}`)
      const { status } = (await res.json()) as { status: string }
      if (status !== 'connecting') return status
      await clock.sleep(5000)
    }
    return 'connecting'
  }

  // Change from the guide: follow every page of results, not only the first. Read the whole
  // list before deleting anything, so deletes cannot shift the pages still to come.
  const accounts: PdAccount[] = []
  for await (const a of o.pd.listAccounts({ externalUserId, app: o.appName, oauthAppId: app.pdOauthAppId })) {
    accounts.push(a)
  }

  for (const account of accounts) {
    let importedNow = false
    let entry = ledger[account.id]
    if (entry?.deleted) continue

    // Change from the guide: a run that stopped mid-import may have created a Truto account
    // we never recorded. Importing again would make a second one. A person must look first.
    if (entry && !entry.trutoId) {
      o.warn(
        `${account.id}: a previous run stopped during the Truto import (${entry.importStartedAt ?? 'time unknown'}). ` +
          `Check tenant ${externalUserId} in Truto. If an account was created, delete it or put its id in the ledger as trutoId. ` +
          `If none was, remove this entry from ${o.ledgerPath}. Then run again.`,
      )
      result.pending.push(account.id)
      continue
    }

    if (!entry) {
      const creds = account.credentials ?? undefined
      const problems: string[] = []
      // Change from the guide: also check the API returned what we asked for.
      if (account.external_id !== externalUserId) problems.push('external_user_id does not match')
      if (account.app?.auth_type !== 'oauth') problems.push('not an OAuth account')
      if (account.dead || !account.healthy) problems.push('unhealthy in Pipedream')
      if (typeof creds?.oauth_access_token !== 'string' || !creds.oauth_access_token) problems.push('no credentials returned')
      if (creds?.oauth_client_id !== app.clientId) problems.push('not on your OAuth client')
      const missing = app.requiredScopes.filter((s) => !(account.authorized_scopes ?? []).includes(s))
      if (missing.length) problems.push(`missing scopes: ${missing.join(', ')}`)
      const nextRefresh = account.next_refresh_at ? Date.parse(account.next_refresh_at) : Infinity
      if (nextRefresh - clock.now() < 15 * 60 * 1000) problems.push('Pipedream refreshes it within 15 minutes')
      if (Number.isNaN(nextRefresh)) problems.push('next_refresh_at is not a date')
      // Change from the guide: a token near expiry makes Truto refresh it at once. With a rotating
      // refresh token, a rollback after that refresh would leave Pipedream with a dead token.
      const expiresAt = account.expires_at ? Date.parse(account.expires_at) : Infinity
      if (Number.isNaN(expiresAt)) problems.push('expires_at is not a date')
      else if (expiresAt - clock.now() < 15 * 60 * 1000) problems.push('access token expires within 15 minutes')
      if (problems.length) {
        o.warn(`${account.id}: not moved (${problems.join('; ')})`)
        result.skipped.push(account.id)
        continue
      }

      const expiresIn = account.expires_at
        ? Math.max(0, Math.floor((Date.parse(account.expires_at) - clock.now()) / 1000))
        : undefined

      // Change from the guide: record the attempt before the POST (see the check above).
      ledger[account.id] = { deleted: false, importStartedAt: new Date(clock.now()).toISOString() }
      save()

      const importRes = await truto(`${TRUTO_API}/integrated-account`, {
        method: 'POST',
        body: JSON.stringify({
          tenant_id: externalUserId,
          environment_integration_id: app.envIntegrationId,
          authentication_method: 'oauth2',
          context: {
            oauth: {
              token: {
                access_token: creds!.oauth_access_token,
                refresh_token: creds!.oauth_refresh_token,
                expires_in: expiresIn,
              },
            },
          },
        }),
      })
      if (!importRes.ok) {
        // A 4xx (other than 408/429) means Truto refused it, so nothing was created: clear the marker.
        // Anything else is unclear, so the marker stays and the next run asks a person to check.
        const refused = importRes.status >= 400 && importRes.status < 500 && ![408, 429].includes(importRes.status)
        if (refused) {
          delete ledger[account.id]
          save()
        }
        throw new Error(`${account.id}: Truto import HTTP ${importRes.status}`)
      }
      const created = (await importRes.json()) as { id?: unknown }
      if (typeof created.id !== 'string' || !created.id) {
        throw new Error(`${account.id}: Truto import returned no account id. Check tenant ${externalUserId} in Truto.`)
      }
      entry = ledger[account.id] = { trutoId: created.id, deleted: false }
      save()
      importedNow = true
    }
    const trutoId = entry.trutoId!

    // Check the Truto account works before Pipedream lets go of the token.
    const status = await settledStatus(trutoId)
    if (status === 'gone') {
      // Just created and already missing: something is wrong. Stop and keep the record.
      if (importedNow) throw new Error(`${account.id}: Truto account ${trutoId} not found right after the import`)
      // From an earlier run: the rollback deleted it but the run stopped before the ledger write.
      // Change from the guide: drop the entry so the next run can start this account again.
      delete ledger[account.id]
      save()
      o.warn(`${account.id}: Truto account ${trutoId} no longer exists. Ledger entry removed. Connect account kept.`)
      result.skipped.push(account.id)
      continue
    }
    if (status === 'connecting') {
      o.warn(`${account.id}: Truto account still connecting. Run the script again later.`)
      result.pending.push(account.id)
      continue
    }
    const read = status === 'active' ? await truto(cheapReadUrl(app.cheapRead, trutoId)) : undefined
    if (!read?.ok) {
      // Give the token back to Pipedream alone: remove the Truto account.
      // Change from the guide: check that the delete worked. If it did not, keep the ledger
      // entry and stop, so the Truto account (and its copy of the token) is not forgotten.
      const del = await truto(accountUrl(trutoId), { method: 'DELETE' })
      if (!del.ok && del.status !== 404) {
        throw new Error(
          `${account.id}: Truto account ${trutoId} failed its check, and removing it failed (HTTP ${del.status}). ` +
            `Connect account kept. Delete ${trutoId} in Truto, then remove ${account.id} from ${o.ledgerPath}.`,
        )
      }
      delete ledger[account.id]
      save()
      o.warn(`${account.id}: Truto account was ${status}, read ${read?.status ?? 'skipped'}. Removed it. Connect account kept.`)
      result.skipped.push(account.id)
      continue
    }

    // One system holds the refresh token from here on.
    try {
      await o.pd.deleteAccount(account.id)
    } catch (err) {
      throw new Error(`${(err as Error).message}. Run the script again to finish.`)
    }
    entry.deleted = true
    save()
    o.log(`${account.id} -> ${trutoId}: moved, Connect account deleted`)
    result.moved.push(account.id)
  }
  return result
}
