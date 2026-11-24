// Recorded-shape fakes. No test calls a live API.
import type { Clock, FetchFn } from '../src/http'
import type { PdAccount } from '../src/pipedream'

export const ACCESS = 'SENTINEL_ACCESS_TOKEN_x1'
export const REFRESH = 'SENTINEL_REFRESH_TOKEN_x1'
export const PD_SECRET = 'SENTINEL_PD_CLIENT_SECRET'
export const PD_BEARER = 'SENTINEL_PD_BEARER'
export const TRUTO_TOKEN = 'SENTINEL_TRUTO_TOKEN'
export const SENTINELS = [ACCESS, REFRESH, PD_SECRET, PD_BEARER, TRUTO_TOKEN, 'SENTINEL_API_KEY', 'SENTINEL_BASE_URL']

export const NOW = Date.parse('2026-11-24T12:00:00Z')
const inHours = (h: number) => new Date(NOW + h * 3600_000).toISOString()

export const SLACK_CLIENT = '1234.5678'

// Same fields and shapes as the Account object in
// https://pipedream.com/docs/connect/api-reference/list-accounts
export function oauthAccount(over: Partial<PdAccount> = {}, creds: Record<string, unknown> = {}): PdAccount {
  return {
    id: 'apn_good1',
    name: 'Acme Slack',
    external_id: 'cus_1',
    healthy: true,
    dead: false,
    app: { name_slug: 'slack', auth_type: 'oauth' },
    expires_at: inHours(12),
    authorized_scopes: ['chat:write', 'channels:read'],
    next_refresh_at: inHours(11),
    credentials: {
      oauth_client_id: SLACK_CLIENT,
      oauth_access_token: ACCESS,
      oauth_refresh_token: REFRESH,
      ...creds,
    },
    ...over,
  }
}

export const fixtureAccounts: PdAccount[] = [
  oauthAccount(),
  // Pipedream's own OAuth client: credentials come back null.
  oauthAccount({ id: 'apn_pdclient', external_id: 'cus_2', credentials: null }),
  oauthAccount({ id: 'apn_otherclient', external_id: 'cus_3' }, { oauth_client_id: 'someone-else' }),
  oauthAccount({ id: 'apn_noscope', external_id: 'cus_4', authorized_scopes: ['channels:read'] }),
  oauthAccount({ id: 'apn_dead', external_id: 'cus_5', healthy: false, dead: true }),
  oauthAccount({
    id: 'apn_hub1',
    external_id: '=HYPERLINK("http://x")',
    app: { name_slug: 'hubspot', auth_type: 'oauth' },
    authorized_scopes: ['crm.objects.contacts.read'],
    next_refresh_at: inHours(0.1),
  }, { oauth_client_id: 'hub-client', base_url: 'SENTINEL_BASE_URL' }),
  {
    id: 'apn_keys1',
    external_id: 'cus_6',
    healthy: true,
    dead: false,
    app: { name_slug: 'openai', auth_type: 'keys' },
    authorized_scopes: [],
    credentials: { api_key: 'SENTINEL_API_KEY' },
  },
  { id: 'apn_none1', external_id: 'cus_7', healthy: true, app: { name_slug: 'http', auth_type: 'none' }, credentials: null },
]

export type Call = { method: string; url: URL; body: any; headers: Record<string, string> }

// A fetch that records every call and answers from `handler`.
export function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn: FetchFn = async (input, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    const c: Call = { method: init.method ?? 'GET', url: new URL(String(input)), body, headers }
    calls.push(c)
    return handler(c)
  }
  return { fn, calls }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })

export const empty = (status: number) => new Response(null, { status })

// Pipedream token + paginated list. `pages` is a list of account arrays.
export function pipedreamHandler(pages: PdAccount[][]) {
  return (c: Call): Response | undefined => {
    if (c.url.origin !== 'https://api.pipedream.com') return undefined
    if (c.url.pathname === '/v1/oauth/token') return json({ access_token: PD_BEARER, token_type: 'Bearer', expires_in: 3600 })
    if (c.method === 'GET' && /^\/v1\/connect\/proj_[A-Za-z0-9]+\/accounts$/.test(c.url.pathname)) {
      const after = c.url.searchParams.get('after')
      const i = after ? Number(after.replace('cursor_', '')) : 0
      const page = pages[i] ?? []
      const next = i + 1 < pages.length ? `cursor_${i + 1}` : null
      return json({ data: page, page_info: { count: page.length, total_count: pages.flat().length, start_cursor: null, end_cursor: next } })
    }
    return undefined
  }
}

export function fakeClock(start = NOW): Clock & { slept: number[] } {
  let t = start
  const slept: number[] = []
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms)
      t += ms
    },
    slept,
  }
}

export const ENV = {
  PD_CLIENT_ID: 'pd-client',
  PD_CLIENT_SECRET: PD_SECRET,
  PD_PROJECT_ID: 'proj_abc123',
  TRUTO_API_TOKEN: TRUTO_TOKEN,
}
