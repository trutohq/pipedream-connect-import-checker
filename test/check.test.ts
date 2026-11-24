import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, toCsv } from '../src/check'
import { main } from '../src/cli'
import { Pipedream } from '../src/pipedream'
import {
  ENV,
  NOW,
  PD_SECRET,
  SENTINELS,
  SLACK_CLIENT,
  empty,
  fakeClock,
  fakeFetch,
  fixtureAccounts,
  json,
  oauthAccount,
  pipedreamHandler,
} from './fake'

const slackRule = { clientId: SLACK_CLIENT, requiredScopes: ['chat:write'] }

describe('classify', () => {
  test('own client, credentials, scopes -> movable', () => {
    const r = classify(oauthAccount(), slackRule, NOW)
    expect(r.status).toBe('movable')
    expect(r.reasons).toEqual([])
    expect(r.has_refresh_token).toBe(true)
    expect(r.credential_keys).toEqual(['oauth_access_token', 'oauth_client_id', 'oauth_refresh_token'])
  })

  test("no credentials (Pipedream's client) -> reconnect", () => {
    const r = classify(oauthAccount({ credentials: null }), slackRule, NOW)
    expect(r.status).toBe('reconnect')
    expect(r.reasons[0]).toContain('no credentials returned')
  })

  test('other client id -> reconnect', () => {
    const r = classify(oauthAccount({}, { oauth_client_id: 'x' }), slackRule, NOW)
    expect(r.status).toBe('reconnect')
  })

  test('missing scope -> reconnect', () => {
    const r = classify(oauthAccount({ authorized_scopes: [] }), slackRule, NOW)
    expect(r.reasons).toEqual(['missing scopes: chat:write'])
  })

  test('unhealthy -> reconnect', () => {
    expect(classify(oauthAccount({ healthy: false }), slackRule, NOW).status).toBe('reconnect')
  })

  test('no config -> movable on credentials alone, with a note', () => {
    const r = classify(oauthAccount({}, { oauth_client_id: 'anything' }), undefined, NOW)
    expect(r.status).toBe('movable')
    expect(r.notes.join(' ')).toContain('client ID not checked')
  })

  test('near refresh and missing refresh token are notes, not status', () => {
    const near = new Date(NOW + 60_000).toISOString()
    const r = classify(oauthAccount({ next_refresh_at: near }, { oauth_refresh_token: undefined }), slackRule, NOW)
    expect(r.status).toBe('movable')
    expect(r.has_refresh_token).toBe(false)
    expect(r.notes.join(' ')).toContain('no refresh token')
    expect(r.notes.join(' ')).toContain('within 15 minutes')
  })

  test('key-based and no-auth apps -> manual_check', () => {
    expect(classify(fixtureAccounts[6]!, undefined, NOW).status).toBe('manual_check')
    expect(classify(fixtureAccounts[7]!, undefined, NOW).status).toBe('manual_check')
  })
})

test('CSV guards against formula injection and quotes cells', () => {
  const r = classify(oauthAccount({ external_id: '=1+1', name: 'a' }), slackRule, NOW)
  const csv = toCsv([r])
  expect(csv).toContain(`"'=1+1"`)
  expect(csv.split('\n')[0]).toStartWith('account_id,external_user_id')
})

describe('Pipedream client', () => {
  test('follows end_cursor across pages and sends the documented params', async () => {
    const pages = [[oauthAccount({ id: 'apn_a' })], [oauthAccount({ id: 'apn_b' })], [oauthAccount({ id: 'apn_c' })]]
    const { fn, calls } = fakeFetch((c) => pipedreamHandler(pages)(c) ?? empty(500))
    const pd = new Pipedream({ clientId: 'c', clientSecret: 's', projectId: 'proj_abc', environment: 'development', scope: 'connect:accounts:read', fetch: fn, clock: fakeClock() })
    const ids: string[] = []
    for await (const a of pd.listAccounts({ app: 'slack' })) ids.push(a.id)
    expect(ids).toEqual(['apn_a', 'apn_b', 'apn_c'])
    const lists = calls.filter((c) => c.url.pathname.endsWith('/accounts'))
    expect(lists.map((c) => c.url.searchParams.get('after'))).toEqual([null, 'cursor_1', 'cursor_2'])
    expect(lists[0]!.url.searchParams.get('include_credentials')).toBe('true')
    expect(lists[0]!.url.searchParams.get('app')).toBe('slack')
    expect(lists[0]!.url.searchParams.has('limit')).toBe(false)
    expect(lists[0]!.headers['x-pd-environment']).toBe('development')
    // One token for the whole run.
    expect(calls.filter((c) => c.url.pathname === '/v1/oauth/token')).toHaveLength(1)
    expect(calls[0]!.body.scope).toBe('connect:accounts:read')
  })

  test('gets a new API token before the old one expires', async () => {
    const { fn, calls } = fakeFetch((c) => pipedreamHandler([[oauthAccount()]])(c) ?? empty(500))
    const clock = fakeClock()
    const pd = new Pipedream({ clientId: 'c', clientSecret: 's', projectId: 'proj_abc', environment: 'production', scope: 's', fetch: fn, clock })
    for await (const _ of pd.listAccounts()) {}
    await clock.sleep(50 * 60 * 1000)
    for await (const _ of pd.listAccounts()) {}
    expect(calls.filter((c) => c.url.pathname.endsWith('/token'))).toHaveLength(1)
    await clock.sleep(6 * 60 * 1000)
    for await (const _ of pd.listAccounts()) {}
    expect(calls.filter((c) => c.url.pathname.endsWith('/token'))).toHaveLength(2)
  })

  test('stops on a repeated cursor', async () => {
    const { fn } = fakeFetch((c) =>
      c.url.pathname.endsWith('/token')
        ? json({ access_token: 't' })
        : json({ data: [oauthAccount()], page_info: { end_cursor: 'same' } }),
    )
    const pd = new Pipedream({ clientId: 'c', clientSecret: 's', projectId: 'proj_abc', environment: 'production', scope: 's', fetch: fn, clock: fakeClock() })
    let n = 0
    for await (const _ of pd.listAccounts()) n++
    expect(n).toBe(2)
  })

  test('waits out a 429 using Retry-After', async () => {
    let throttled = false
    const handler = pipedreamHandler([[oauthAccount()]])
    const { fn } = fakeFetch((c) => {
      if (c.url.pathname.endsWith('/accounts') && !throttled) {
        throttled = true
        return json({ error: 'Throttled' }, 429, { 'retry-after': '7' })
      }
      return handler(c) ?? empty(500)
    })
    const clock = fakeClock()
    const pd = new Pipedream({ clientId: 'c', clientSecret: 's', projectId: 'proj_abc', environment: 'production', scope: 's', fetch: fn, clock })
    const ids: string[] = []
    for await (const a of pd.listAccounts()) ids.push(a.id)
    expect(ids).toEqual(['apn_good1'])
    expect(clock.slept).toEqual([7000])
  })
})

describe('dry run (main)', () => {
  async function run(args: string[], env: Record<string, string | undefined> = ENV) {
    const dir = mkdtempSync(join(tmpdir(), 'pdcheck-'))
    const cfg = join(dir, 'apps.json')
    await Bun.write(cfg, JSON.stringify({ slack: slackRule, hubspot: { clientId: 'hub-client', requiredScopes: ['crm.objects.contacts.read'] } }))
    const out: string[] = []
    const files: Record<string, string> = {}
    const { fn, calls } = fakeFetch((c) => pipedreamHandler([fixtureAccounts.slice(0, 4), fixtureAccounts.slice(4)])(c) ?? empty(500))
    const code = await main(
      ['--config', cfg, '--csv', join(dir, 'r.csv'), '--json', join(dir, 'r.json'), ...args],
      env,
      { fetch: fn, clock: fakeClock(), out: (m) => out.push(m), err: (m) => out.push(m), writeFile: (p, d) => (files[p] = d) },
    )
    return { code, out: out.join('\n'), files, calls, dir }
  }

  test('counts per app and writes CSV and JSON', async () => {
    const { code, out, files, dir } = await run([])
    expect(code).toBe(0)
    expect(out).toContain('8 Connect accounts')
    expect(out).toMatch(/slack\s+5\s+1\s+4\s+0/)
    expect(out).toMatch(/hubspot\s+1\s+1\s+0\s+0/)
    expect(out).toMatch(/TOTAL\s+8\s+2\s+4\s+2/)
    const report = JSON.parse(files[join(dir, 'r.json')]!)
    expect(report.accounts).toHaveLength(8)
    expect(files[join(dir, 'r.csv')]!.split('\n').filter(Boolean)).toHaveLength(9)
  })

  test('never writes or prints a token, key, secret or app-specific credential value', async () => {
    const { out, files, calls } = await run([])
    const everything = out + Object.values(files).join('')
    for (const s of SENTINELS) expect(everything).not.toContain(s)
    // The dry run never deletes anything and asks only for the read scope.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(calls.find((c) => c.url.pathname.endsWith('/token'))!.body.scope).toBe('connect:accounts:read')
    expect(calls.find((c) => c.url.pathname.endsWith('/token'))!.body.client_secret).toBe(PD_SECRET)
  })

  test('rejects a bad project id or environment', async () => {
    expect((await run([], { ...ENV, PD_PROJECT_ID: '../x' })).code).toBe(2)
    expect((await run([], { ...ENV, PD_ENVIRONMENT: 'prod' })).code).toBe(2)
  })

  test('error output has the status code, not the body', async () => {
    const { fn } = fakeFetch((c) => (c.url.pathname.endsWith('/token') ? new Response('SENTINEL_PD_BEARER leaked', { status: 401 }) : empty(500)))
    const out: string[] = []
    const code = await main([], ENV, { fetch: fn, clock: fakeClock(), out: (m) => out.push(m), err: (m) => out.push(m), writeFile: () => {} })
    expect(code).toBe(1)
    expect(out.join('\n')).toContain('HTTP 401')
    expect(out.join('\n')).not.toContain('SENTINEL')
  })
})

test('README sample output matches the fixture run', async () => {
  // Keeps the README honest: the sample block is the real output for these fixtures.
  const out: string[] = []
  const dir = mkdtempSync(join(tmpdir(), 'pdcheck-'))
  const cfg = join(dir, 'apps.json')
  await Bun.write(cfg, JSON.stringify({ slack: slackRule, hubspot: { clientId: 'hub-client', requiredScopes: ['crm.objects.contacts.read'] } }))
  const { fn } = fakeFetch((c) => pipedreamHandler([fixtureAccounts])(c) ?? empty(500))
  await main(['--config', cfg, '--csv', 'connect-report.csv', '--json', 'connect-report.json'], ENV, {
    fetch: fn,
    clock: fakeClock(),
    out: (m) => out.push(m),
    err: (m) => out.push(m),
    writeFile: () => {},
  })
  const readme = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8')
  expect(readme).toContain(out.join('\n'))
})
