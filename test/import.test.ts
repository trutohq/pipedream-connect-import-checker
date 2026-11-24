import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli'
import { requireImportApp } from '../src/config'
import type { FetchFn } from '../src/http'
import { cheapReadUrl, migrateCustomer, type Ledger } from '../src/import'
import { Pipedream, type PdAccount } from '../src/pipedream'
import { ACCESS, ENV, PD_BEARER, REFRESH, SENTINELS, SLACK_CLIENT, TRUTO_TOKEN, empty, fakeClock, fakeFetch, json, oauthAccount, pipedreamHandler, type Call } from './fake'

const app = requireImportApp('slack', {
  clientId: SLACK_CLIENT,
  pdOauthAppId: 'oa_slack1',
  envIntegrationId: 'ei_slack',
  requiredScopes: ['chat:write'],
  cheapRead: '/unified/instant-messaging/channels?limit=1',
})

type TrutoBehaviour = {
  importStatus?: number
  statuses?: string[] // returned by successive GET /integrated-account/:id
  readStatus?: number
  trutoDeleteStatus?: number
  pdDeleteStatus?: number
  getStatus?: number
}

function setup(pages: PdAccount[][], b: TrutoBehaviour = {}, ledger?: Ledger) {
  const dir = mkdtempSync(join(tmpdir(), 'pdimport-'))
  const ledgerPath = join(dir, 'ledger.json')
  if (ledger) writeFileSync(ledgerPath, JSON.stringify(ledger))
  const statuses = [...(b.statuses ?? ['active'])]
  const pd = pipedreamHandler(pages)
  const handler = (c: Call): Response => {
    const p = pd(c)
    if (p) return p
    if (c.url.origin === 'https://api.pipedream.com' && c.method === 'DELETE') return empty(b.pdDeleteStatus ?? 204)
    if (c.url.origin !== 'https://api.truto.one') return empty(599)
    if (c.method === 'POST' && c.url.pathname === '/integrated-account') {
      return b.importStatus ? json({ error: 'x' }, b.importStatus) : json({ id: 'ia_new1', status: 'connecting' }, 201)
    }
    if (c.method === 'GET' && c.url.pathname.startsWith('/integrated-account/')) {
      if (b.getStatus) return empty(b.getStatus)
      return json({ id: 'ia_new1', status: statuses.length > 1 ? statuses.shift() : statuses[0] })
    }
    if (c.method === 'DELETE' && c.url.pathname.startsWith('/integrated-account/')) return empty(b.trutoDeleteStatus ?? 204)
    if (c.url.pathname.startsWith('/unified/')) return json({ result: [] }, b.readStatus ?? 200)
    return empty(598)
  }
  const { fn, calls } = fakeFetch(handler)
  const clock = fakeClock()
  const logs: string[] = []
  const run = (fetchFn: FetchFn = fn) =>
    migrateCustomer({
      appName: 'slack',
      app,
      externalUserId: 'cus_1',
      pd: new Pipedream({ clientId: 'c', clientSecret: 's', projectId: 'proj_abc', environment: 'production', scope: 'connect:accounts:read connect:accounts:write', fetch: fetchFn, clock }),
      trutoToken: TRUTO_TOKEN,
      ledgerPath,
      fetch: fetchFn,
      clock,
      log: (m) => logs.push(m),
      warn: (m) => logs.push(m),
    })
  const ledgerNow = (): Ledger => (existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {})
  const count = (method: string, origin: string, pathStart = '') =>
    calls.filter((c) => c.method === method && c.url.origin === origin && c.url.pathname.startsWith(pathStart)).length
  const pdDeletes = () => count('DELETE', 'https://api.pipedream.com')
  const trutoDeletes = () => count('DELETE', 'https://api.truto.one')
  const imports = () => count('POST', 'https://api.truto.one', '/integrated-account')
  // Nothing secret may reach logs, the ledger or an error message.
  const assertNoSecrets = (err?: unknown) => {
    const visible = logs.join('\n') + (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '') + String((err as Error)?.message ?? '')
    for (const t of SENTINELS) expect(visible).not.toContain(t)
  }
  const runExpectingError = async (): Promise<Error> => {
    const e = await run().then(() => undefined, (err: Error) => err)
    if (!e) throw new Error('expected the run to fail')
    assertNoSecrets(e)
    expect(existsSync(`${ledgerPath}.lock`)).toBe(false)
    return e
  }
  return { run, runExpectingError, assertNoSecrets, calls, logs, ledgerNow, ledgerPath, pdDeletes, trutoDeletes, imports, fn }
}

describe('migrateCustomer', () => {
  test('happy path: import, wait out connecting, read, then delete the Connect account', async () => {
    const s = setup([[oauthAccount()]], { statuses: ['connecting', 'connecting', 'active'] })
    const r = await s.run()
    expect(r.moved).toEqual(['apn_good1'])
    expect(s.pdDeletes()).toBe(1)
    expect(s.trutoDeletes()).toBe(0)
    expect(s.ledgerNow()).toEqual({ apn_good1: { trutoId: 'ia_new1', deleted: true } })

    const list = s.calls.find((c) => c.url.pathname.endsWith('/accounts'))!
    expect(list.url.searchParams.get('oauth_app_id')).toBe('oa_slack1')
    expect(list.url.searchParams.get('external_user_id')).toBe('cus_1')
    const post = s.calls.find((c) => c.method === 'POST' && c.url.origin === 'https://api.truto.one')!
    expect(post.body).toEqual({
      tenant_id: 'cus_1',
      environment_integration_id: 'ei_slack',
      authentication_method: 'oauth2',
      context: { oauth: { token: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 12 * 3600 } } },
    })
    const read = s.calls.find((c) => c.url.pathname.startsWith('/unified/'))!
    expect(read.url.href).toBe('https://api.truto.one/unified/instant-messaging/channels?limit=1&integrated_account_id=ia_new1')
    // The Pipedream delete comes after the read.
    expect(s.calls.indexOf(read)).toBeLessThan(s.calls.findIndex((c) => c.method === 'DELETE'))
    // Tokens only ever go to Truto's import body, never to logs or the ledger.
    s.assertNoSecrets()
    // Each bearer goes only to its own API.
    for (const c of s.calls) {
      if (c.url.origin === 'https://api.truto.one') expect(c.headers.authorization).toBe(`Bearer ${TRUTO_TOKEN}`)
      else if (c.url.pathname === '/v1/oauth/token') expect(c.headers.authorization).toBeUndefined()
      else expect(c.headers.authorization).toBe(`Bearer ${PD_BEARER}`)
    }
  })

  test('a rerun skips finished accounts', async () => {
    const s = setup([[oauthAccount()]], {}, { apn_good1: { trutoId: 'ia_new1', deleted: true } })
    await s.run()
    expect(s.imports()).toBe(0)
    expect(s.pdDeletes()).toBe(0)
  })

  test('accounts that fail a check are not imported', async () => {
    const near = new Date(fakeClock().now() + 5 * 60_000).toISOString()
    const s = setup([[
      oauthAccount({ id: 'apn_other' }, { oauth_client_id: 'other' }),
      oauthAccount({ id: 'apn_scope', authorized_scopes: [] }),
      oauthAccount({ id: 'apn_soon', next_refresh_at: near }),
      oauthAccount({ id: 'apn_nocred', credentials: null }),
      oauthAccount({ id: 'apn_wronguser', external_id: 'cus_9' }),
      oauthAccount({ id: 'apn_sick', healthy: false }),
      oauthAccount({ id: 'apn_expiring', expires_at: near }),
      oauthAccount({ id: 'apn_baddate', next_refresh_at: 'soon' }),
      oauthAccount({ id: 'apn_badexp', expires_at: 'later' }),
      oauthAccount({ id: 'apn_keys', app: { name_slug: 'slack', auth_type: 'keys' } }),
    ]])
    const r = await s.run()
    expect(r.skipped).toHaveLength(10)
    expect(s.imports()).toBe(0)
    expect(s.pdDeletes()).toBe(0)
  })

  test('read fails: Truto account removed, Connect account kept', async () => {
    const s = setup([[oauthAccount()]], { readStatus: 403 })
    const r = await s.run()
    expect(r.skipped).toEqual(['apn_good1'])
    expect(s.trutoDeletes()).toBe(1)
    expect(s.pdDeletes()).toBe(0)
    expect(s.ledgerNow()).toEqual({})
    s.assertNoSecrets()
  })

  test('account ends in error status: no read, Truto account removed, Connect account kept', async () => {
    const s = setup([[oauthAccount()]], { statuses: ['needs_reauth'] })
    await s.run()
    expect(s.calls.some((c) => c.url.pathname.startsWith('/unified/'))).toBe(false)
    expect(s.trutoDeletes()).toBe(1)
    expect(s.pdDeletes()).toBe(0)
  })

  test('rollback delete fails: throws, keeps the ledger entry, never deletes in Pipedream', async () => {
    const s = setup([[oauthAccount()]], { readStatus: 500, trutoDeleteStatus: 500 })
    expect((await s.runExpectingError()).message).toContain('removing it failed')
    expect(s.pdDeletes()).toBe(0)
    expect(s.ledgerNow()).toEqual({ apn_good1: { trutoId: 'ia_new1', deleted: false } })
  })

  test('stuck in connecting: Connect account kept, entry stays for a rerun', async () => {
    const s = setup([[oauthAccount()]], { statuses: ['connecting'] })
    const r = await s.run()
    expect(r.pending).toEqual(['apn_good1'])
    expect(s.pdDeletes()).toBe(0)
    expect(s.trutoDeletes()).toBe(0)
    expect(s.ledgerNow().apn_good1).toEqual({ trutoId: 'ia_new1', deleted: false })
  })

  test('Pipedream delete fails, then a rerun finishes without a second import', async () => {
    const s = setup([[oauthAccount()]], { pdDeleteStatus: 500 })
    expect((await s.runExpectingError()).message).toContain('Run the script again to finish')
    expect(s.ledgerNow().apn_good1).toEqual({ trutoId: 'ia_new1', deleted: false })

    const s2 = setup([[oauthAccount()]], {}, s.ledgerNow())
    const r = await s2.run()
    expect(r.moved).toEqual(['apn_good1'])
    expect(s2.imports()).toBe(0)
    expect(s2.pdDeletes()).toBe(1)
  })

  test('Pipedream delete 404 counts as already deleted', async () => {
    const s = setup([[oauthAccount()]], { pdDeleteStatus: 404 })
    expect((await s.run()).moved).toEqual(['apn_good1'])
  })

  test('import refused with 4xx: marker cleared, nothing deleted', async () => {
    const s = setup([[oauthAccount()]], { importStatus: 422 })
    expect((await s.runExpectingError()).message).toContain('Truto import HTTP 422')
    expect(s.ledgerNow()).toEqual({})
    expect(s.pdDeletes()).toBe(0)
  })

  test('import 5xx or network error: marker kept, next run will not import again', async () => {
    const s = setup([[oauthAccount()]], { importStatus: 502 })
    expect((await s.runExpectingError()).message).toContain('HTTP 502')
    expect(s.ledgerNow().apn_good1?.trutoId).toBeUndefined()
    expect(s.ledgerNow().apn_good1?.importStartedAt).toBeString()

    const s2 = setup([[oauthAccount()]], {}, s.ledgerNow())
    const r = await s2.run()
    expect(r.pending).toEqual(['apn_good1'])
    expect(s2.imports()).toBe(0)
    expect(s2.pdDeletes()).toBe(0)
    expect(s2.logs.join('\n')).toContain('stopped during the Truto import')

    const s3 = setup([[oauthAccount()]])
    const throwing: FetchFn = async (url, init) => {
      if (String(url) === 'https://api.truto.one/integrated-account' && init?.method === 'POST') throw new Error('socket closed')
      return s3.fn(url, init)
    }
    await expect(s3.run(throwing)).rejects.toThrow('socket closed')
    expect(s3.ledgerNow().apn_good1?.importStartedAt).toBeString()
  })

  test('a Truto account gone from an earlier run: entry dropped, nothing else deleted', async () => {
    const s = setup([[oauthAccount()]], { getStatus: 404 }, { apn_good1: { trutoId: 'ia_old', deleted: false } })
    const r = await s.run()
    expect(r.skipped).toEqual(['apn_good1'])
    expect(s.ledgerNow()).toEqual({})
    expect(s.pdDeletes()).toBe(0)
    expect(s.trutoDeletes()).toBe(0)
  })

  test('a Truto account missing right after the import: stop, keep the record', async () => {
    const s = setup([[oauthAccount()]], { getStatus: 404 })
    expect((await s.runExpectingError()).message).toContain('not found right after the import')
    expect(s.ledgerNow().apn_good1?.trutoId).toBe('ia_new1')
    expect(s.pdDeletes()).toBe(0)
  })

  test('a second run on the same ledger is refused while one holds the lock', async () => {
    const s = setup([[oauthAccount()]])
    writeFileSync(`${s.ledgerPath}.lock`, '1')
    await expect(s.run()).rejects.toThrow('Another run holds')
    expect(s.calls).toHaveLength(0)
  })

  test('the whole list is read before any delete', async () => {
    const s = setup([[oauthAccount({ id: 'apn_p1' })], [oauthAccount({ id: 'apn_p2' })]])
    await s.run()
    const lastList = s.calls.findLastIndex((c) => c.url.pathname.endsWith('/accounts'))
    const firstDelete = s.calls.findIndex((c) => c.method === 'DELETE')
    expect(lastList).toBeLessThan(firstDelete)
  })

  test('follows pagination in import mode', async () => {
    const s = setup([[oauthAccount({ id: 'apn_p1' })], [oauthAccount({ id: 'apn_p2' })]])
    const r = await s.run()
    expect(r.moved).toEqual(['apn_p1', 'apn_p2'])
  })
})

describe('cheapRead safety', () => {
  test('a hostile cheapRead cannot send the Truto token to another host', () => {
    expect(() => cheapReadUrl('//evil.example/x', 'ia')).toThrow()
    expect(() => cheapReadUrl('https://evil.example/x', 'ia')).toThrow()
    expect(cheapReadUrl('@evil.example/x', 'ia').origin).toBe('https://api.truto.one')
  })

  test('config validation rejects bad import entries', () => {
    expect(() => requireImportApp('slack', { ...app, clientId: undefined })).toThrow('clientId')
    expect(() => requireImportApp('slack', { ...app, pdOauthAppId: 'bad' })).toThrow('oa_')
    expect(() => requireImportApp('slack', { ...app, cheapRead: '//evil.example' })).toThrow('cheapRead')
    expect(() => requireImportApp('slack', { ...app, cheapRead: 'https://evil.example' })).toThrow('cheapRead')
    expect(() => requireImportApp('slack', { ...app, cheapRead: '/\\evil.example/x' })).toThrow('cheapRead')
    expect(() => requireImportApp('slack', { ...app, cheapRead: '/\t/evil.example/x' })).toThrow('cheapRead')
    expect(() => requireImportApp('slack', { ...app, cheapRead: '/\n/evil.example/x' })).toThrow('cheapRead')
    expect(() => requireImportApp('nope', undefined)).toThrow('No entry')
  })
})

test('main --import: pending account gives exit 3 and a warning on stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdmain-'))
  const cfg = join(dir, 'apps.json')
  writeFileSync(cfg, JSON.stringify({ slack: app }))
  const ledger = join(dir, 'ledger.json')
  const pd = pipedreamHandler([[oauthAccount()]])
  const { fn } = fakeFetch((c) => {
    const p = pd(c)
    if (p) return p
    if (c.method === 'POST') return json({ id: 'ia_new1' }, 201)
    return json({ id: 'ia_new1', status: 'connecting' })
  })
  const out: string[] = []
  const err: string[] = []
  const code = await main(['--import', '--config', cfg, '--app', 'slack', '--external-user-id', 'cus_1', '--ledger', ledger], ENV, {
    fetch: fn,
    clock: fakeClock(),
    out: (m) => out.push(m),
    err: (m) => err.push(m),
    writeFile: () => {},
  })
  expect(code).toBe(3)
  expect(err.join('\n')).toContain('still connecting')
  expect(out.join('\n')).toContain('pending 1')
  for (const t of SENTINELS) expect(out.join('\n') + err.join('\n') + readFileSync(ledger, 'utf8')).not.toContain(t)
})
