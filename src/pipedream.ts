// Pipedream Connect API client: token, list accounts (paginated), delete account.
// Shapes follow https://pipedream.com/docs/connect/api-reference/list-accounts,
// https://pipedream.com/docs/connect/api-reference/delete-account and
// https://pipedream.com/docs/connect/api-reference/authentication
import { send, type Clock, type FetchFn } from './http'

export const PD_API = 'https://api.pipedream.com/v1'

export type AuthType = 'oauth' | 'keys' | 'none'

// Account object from the list accounts response. Only the fields this tool reads.
export type PdAccount = {
  id: string
  name?: string | null
  external_id?: string
  healthy?: boolean
  dead?: boolean | null
  app?: { name_slug?: string; auth_type?: AuthType | null } | null
  expires_at?: string | null
  authorized_scopes?: string[]
  // Present only with include_credentials=true, and only for apps on your own OAuth client.
  credentials?: Record<string, unknown> | null
  next_refresh_at?: string | null
}

type ListResponse = {
  data: PdAccount[]
  page_info?: { end_cursor?: string | null }
}

export type PdOptions = {
  clientId: string
  clientSecret: string
  projectId: string
  environment: 'production' | 'development'
  scope: string
  fetch: FetchFn
  clock: Clock
}

export type ListFilter = {
  app?: string
  externalUserId?: string
  oauthAppId?: string
}

export class Pipedream {
  private token?: { value: string; expiresAt: number }

  constructor(private readonly o: PdOptions) {}

  // Tokens live for one hour. Get a new one 5 minutes before that, so long import runs keep working.
  private async accessToken(): Promise<string> {
    const now = this.o.clock.now()
    if (this.token && this.token.expiresAt - now > 5 * 60 * 1000) return this.token.value
    const res = await send(this.o.fetch, this.o.clock, `${PD_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.o.clientId,
        client_secret: this.o.clientSecret,
        scope: this.o.scope,
      }),
    })
    if (!res.ok) throw new Error(`Pipedream token request failed: HTTP ${res.status}`)
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown }
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new Error('Pipedream token response had no access_token')
    }
    const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600
    this.token = { value: body.access_token, expiresAt: now + expiresIn * 1000 }
    return this.token.value
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.accessToken()}`,
      'x-pd-environment': this.o.environment,
    }
  }

  // Yields every account, page by page, with include_credentials=true.
  // No `limit` is sent: its maximum is not documented, so the API default is used.
  async *listAccounts(filter: ListFilter = {}): AsyncGenerator<PdAccount> {
    const seen = new Set<string>()
    let after: string | undefined
    while (true) {
      const url = new URL(`${PD_API}/connect/${encodeURIComponent(this.o.projectId)}/accounts`)
      if (filter.externalUserId) url.searchParams.set('external_user_id', filter.externalUserId)
      if (filter.app) url.searchParams.set('app', filter.app)
      if (filter.oauthAppId) url.searchParams.set('oauth_app_id', filter.oauthAppId)
      url.searchParams.set('include_credentials', 'true')
      if (after) url.searchParams.set('after', after)

      const res = await send(this.o.fetch, this.o.clock, url, { headers: await this.headers() })
      if (!res.ok) throw new Error(`Pipedream list accounts failed: HTTP ${res.status}`)
      const body = (await res.json()) as ListResponse
      if (!Array.isArray(body.data)) throw new Error('Pipedream list accounts: response has no data array')
      for (const account of body.data) yield account

      const next = body.page_info?.end_cursor
      if (!next || body.data.length === 0 || seen.has(next)) return
      seen.add(next)
      after = next
    }
  }

  // 204 means deleted. 404 means it is already gone, which is the state we want.
  async deleteAccount(accountId: string): Promise<void> {
    if (!/^apn_[A-Za-z0-9]+$/.test(accountId)) throw new Error(`Not a Pipedream account id: ${accountId}`)
    const url = `${PD_API}/connect/${encodeURIComponent(this.o.projectId)}/accounts/${accountId}`
    const res = await send(this.o.fetch, this.o.clock, url, { method: 'DELETE', headers: await this.headers() })
    if (!res.ok && res.status !== 404) throw new Error(`Pipedream delete ${accountId} failed: HTTP ${res.status}`)
  }
}
