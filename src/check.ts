// Read-only dry run: sort each Connect account into movable / reconnect / manual_check.
// Rules come from the "Which accounts can move without a reconnect?" section of
// https://truto.one/blog/how-to-migrate-pipedream-workflows-to-truto/
import type { AppConfig } from './config'
import type { PdAccount } from './pipedream'

export type Status = 'movable' | 'reconnect' | 'manual_check'

// A report row. It holds credential key NAMES only, never values.
export type Row = {
  account_id: string
  external_user_id: string
  app: string
  auth_type: string
  status: Status
  reasons: string[]
  notes: string[]
  credential_keys: string[]
  oauth_client_id: string
  has_refresh_token: boolean
  authorized_scopes: string[]
  healthy: boolean | null
  dead: boolean | null
  expires_at: string
  next_refresh_at: string
}

const REFRESH_WINDOW_MS = 15 * 60 * 1000

const present = (v: unknown) => typeof v === 'string' && v.length > 0

export function classify(a: PdAccount, rule: AppConfig | undefined, now: number): Row {
  const creds = a.credentials && typeof a.credentials === 'object' ? a.credentials : null
  const authType = a.app?.auth_type ?? 'unknown'
  const reasons: string[] = []
  const notes: string[] = []
  let status: Status

  if (authType === 'oauth') {
    if (a.dead) reasons.push('dead in Pipedream')
    else if (!a.healthy) reasons.push('unhealthy in Pipedream')
    if (!present(creds?.oauth_access_token)) {
      reasons.push("no credentials returned (likely Pipedream's own OAuth client)")
    } else if (rule?.clientId && creds?.oauth_client_id !== rule.clientId) {
      reasons.push('issued to a different OAuth client than the one in your config')
    }
    if (rule?.requiredScopes) {
      const granted = a.authorized_scopes ?? []
      const missing = rule.requiredScopes.filter((s) => !granted.includes(s))
      if (missing.length) reasons.push(`missing scopes: ${missing.join(' ')}`)
    }
    status = reasons.length ? 'reconnect' : 'movable'

    if (!rule?.clientId) notes.push('client ID not checked (no clientId in config)')
    if (!rule?.requiredScopes) notes.push('scopes not checked (no requiredScopes in config)')
    if (present(creds?.oauth_access_token) && !present(creds?.oauth_refresh_token) && a.expires_at) {
      notes.push(`no refresh token; access token expires ${a.expires_at}`)
    }
    // The same timing rules as --import. They are notes: they change with time, not with the account.
    const nextRefresh = a.next_refresh_at ? Date.parse(a.next_refresh_at) : Infinity
    const expiresAt = a.expires_at ? Date.parse(a.expires_at) : Infinity
    if (status === 'movable' && (Number.isNaN(nextRefresh) || nextRefresh - now < REFRESH_WINDOW_MS)) {
      notes.push('Pipedream refreshes it within 15 minutes; import will skip it until later')
    }
    if (status === 'movable' && (Number.isNaN(expiresAt) || expiresAt - now < REFRESH_WINDOW_MS)) {
      notes.push('access token expires within 15 minutes; import will skip it until Pipedream refreshes it')
    }
  } else if (authType === 'keys') {
    status = 'manual_check'
    reasons.push(
      creds && Object.keys(creds).length
        ? 'key-based app: credential fields returned, import not confirmed; test one account by hand'
        : 'key-based app: no credentials returned; customer likely reconnects',
    )
  } else if (authType === 'none') {
    status = 'manual_check'
    reasons.push('app uses no auth; nothing to import')
  } else {
    status = 'manual_check'
    reasons.push('unknown auth type')
  }

  return {
    account_id: a.id,
    external_user_id: a.external_id ?? '',
    app: a.app?.name_slug ?? '',
    auth_type: authType,
    status,
    reasons,
    notes,
    credential_keys: creds ? Object.keys(creds).sort() : [],
    oauth_client_id: typeof creds?.oauth_client_id === 'string' ? creds.oauth_client_id : '',
    has_refresh_token: present(creds?.oauth_refresh_token),
    authorized_scopes: a.authorized_scopes ?? [],
    healthy: a.healthy ?? null,
    dead: a.dead ?? null,
    expires_at: a.expires_at ?? '',
    next_refresh_at: a.next_refresh_at ?? '',
  }
}

export type AppSummary = { app: string; total: number; movable: number; reconnect: number; manual_check: number }

export function summarize(rows: Row[]): AppSummary[] {
  const byApp = new Map<string, AppSummary>()
  for (const r of rows) {
    const s = byApp.get(r.app) ?? { app: r.app, total: 0, movable: 0, reconnect: 0, manual_check: 0 }
    s.total++
    s[r.status]++
    byApp.set(r.app, s)
  }
  return [...byApp.values()].sort((a, b) => b.total - a.total || a.app.localeCompare(b.app))
}

export function formatSummary(summary: AppSummary[]): string {
  const total = summary.reduce(
    (t, s) => ({
      app: 'TOTAL',
      total: t.total + s.total,
      movable: t.movable + s.movable,
      reconnect: t.reconnect + s.reconnect,
      manual_check: t.manual_check + s.manual_check,
    }),
    { app: 'TOTAL', total: 0, movable: 0, reconnect: 0, manual_check: 0 },
  )
  const lines = [...summary, total].map((s) => [s.app, s.total, s.movable, s.reconnect, s.manual_check].map(String))
  const head = ['app', 'accounts', 'movable', 'reconnect', 'manual_check']
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)))
  const fmt = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ')
  return [fmt(head), ...lines.map(fmt)].join('\n')
}

const CSV_COLUMNS = [
  'account_id',
  'external_user_id',
  'app',
  'auth_type',
  'status',
  'reasons',
  'notes',
  'credential_keys',
  'oauth_client_id',
  'has_refresh_token',
  'authorized_scopes',
  'healthy',
  'dead',
  'expires_at',
  'next_refresh_at',
] as const satisfies readonly (keyof Row)[]

// Quotes every cell. A cell that starts with = + - @ (or tab/CR) gets a leading ' so a
// spreadsheet does not run it as a formula: external_user_id comes from your customers.
function csvCell(value: unknown): string {
  let s = Array.isArray(value) ? value.join('; ') : value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

export function toCsv(rows: Row[]): string {
  return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n'
}
