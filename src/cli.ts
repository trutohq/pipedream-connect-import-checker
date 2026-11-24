#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { classify, formatSummary, summarize, toCsv, type Row } from './check'
import { loadConfig, requireImportApp, type AppConfig } from './config'
import { realClock, type Clock, type FetchFn } from './http'
import { migrateCustomer } from './import'
import { nextStepsFor } from './next-steps'
import { Pipedream, type PdAccount } from './pipedream'

const USAGE = `pipedream-connect-import-checker

Dry run (default, read-only): list every Pipedream Connect account and report which can
move to Truto without a reconnect.

  bun src/cli.ts [--config apps.json] [--app slack] [--external-user-id cus_123]
                 [--csv connect-report.csv] [--json connect-report.json]

Offline (no credentials, no network): read saved list-accounts responses from a file.

  bun src/cli.ts --accounts-file examples/accounts.sample.json --config examples/apps.sample.json

Import (opt-in, deletes Connect accounts after a verified move): one customer, one app.

  bun src/cli.ts --import --config apps.json --app slack --external-user-id cus_123
                 [--ledger migrated-accounts.json]

Environment:
  PD_CLIENT_ID, PD_CLIENT_SECRET   Pipedream OAuth client (API credentials)
  PD_PROJECT_ID                    proj_...
  PD_ENVIRONMENT                   production (default) or development
  TRUTO_API_TOKEN                  --import only
`

export type Deps = {
  fetch: FetchFn
  clock: Clock
  out: (msg: string) => void
  err: (msg: string) => void
  writeFile: (path: string, data: string) => void
}

const defaultDeps: Deps = {
  fetch: (url, init) => fetch(url, init),
  clock: realClock,
  out: (m) => console.log(m),
  err: (m) => console.error(m),
  writeFile: (path, data) => writeFileSync(path, data, { mode: 0o600 }),
}

class UsageError extends Error {}

function need(env: Record<string, string | undefined>, name: string): string {
  const v = env[name]
  if (!v) throw new UsageError(`Missing environment variable ${name}`)
  return v
}

export async function main(argv: string[], env: Record<string, string | undefined>, deps: Deps = defaultDeps): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        config: { type: 'string' },
        app: { type: 'string' },
        'external-user-id': { type: 'string' },
        'accounts-file': { type: 'string' },
        csv: { type: 'string', default: 'connect-report.csv' },
        json: { type: 'string', default: 'connect-report.json' },
        import: { type: 'boolean', default: false },
        ledger: { type: 'string', default: 'migrated-accounts.json' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    })
    if (values.help) {
      deps.out(USAGE)
      return 0
    }

    const config: Record<string, AppConfig> = values.config ? loadConfig(values.config) : {}
    const accountsFile = values['accounts-file']
    if (accountsFile && values.import) throw new UsageError('--import reads live accounts; it cannot use --accounts-file')
    if (accountsFile) {
      const accounts = readAccountsFile(accountsFile).filter(
        (a) =>
          (!values.app || a.app?.name_slug === values.app) &&
          (!values['external-user-id'] || a.external_id === values['external-user-id']),
      )
      return await report(accounts, config, `file ${accountsFile}`, {}, values, deps)
    }

    const projectId = need(env, 'PD_PROJECT_ID')
    if (!/^proj_[a-zA-Z0-9]+$/.test(projectId)) throw new UsageError('PD_PROJECT_ID must look like proj_...')
    const environment = env.PD_ENVIRONMENT ?? 'production'
    if (environment !== 'production' && environment !== 'development') {
      throw new UsageError('PD_ENVIRONMENT must be production or development')
    }

    if (values.import) {
      const appName = values.app
      const externalUserId = values['external-user-id']
      if (!appName || !externalUserId) throw new UsageError('--import needs --app and --external-user-id')
      if (!values.config) throw new UsageError('--import needs --config')
      const app = requireImportApp(appName, config[appName])
      const trutoToken = need(env, 'TRUTO_API_TOKEN')
      const pd = new Pipedream({
        clientId: need(env, 'PD_CLIENT_ID'),
        clientSecret: need(env, 'PD_CLIENT_SECRET'),
        projectId,
        environment,
        scope: 'connect:accounts:read connect:accounts:write',
        fetch: deps.fetch,
        clock: deps.clock,
      })
      deps.out(`Importing ${appName} accounts of ${externalUserId} from Pipedream ${projectId} (${environment})`)
      const r = await migrateCustomer({
        appName,
        app,
        externalUserId,
        pd,
        trutoToken,
        ledgerPath: values.ledger,
        fetch: deps.fetch,
        clock: deps.clock,
        log: deps.out,
        warn: deps.err,
      })
      deps.out(`Moved ${r.moved.length}, not moved ${r.skipped.length}, pending ${r.pending.length}. Ledger: ${values.ledger}`)
      return r.pending.length ? 3 : 0
    }

    // Dry run: read-only token scope. Each account is reduced to a report row at once,
    // so token values never leave this loop.
    const pd = new Pipedream({
      clientId: need(env, 'PD_CLIENT_ID'),
      clientSecret: need(env, 'PD_CLIENT_SECRET'),
      projectId,
      environment,
      scope: 'connect:accounts:read',
      fetch: deps.fetch,
      clock: deps.clock,
    })
    return await report(
      pd.listAccounts({ app: values.app, externalUserId: values['external-user-id'] }),
      config,
      `Pipedream project ${projectId} (${environment})`,
      { project_id: projectId, environment },
      values,
      deps,
    )
  } catch (e) {
    deps.err(`Error: ${(e as Error).message}`)
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      deps.err('Run with --help for usage.')
      return 2
    }
    return 1
  }
}

// Each account becomes a report row at once, so token values never leave this loop.
async function report(
  accounts: AsyncIterable<PdAccount> | Iterable<PdAccount>,
  config: Record<string, AppConfig>,
  source: string,
  meta: Record<string, string>,
  values: { csv: string; json: string; config?: string },
  deps: Deps,
): Promise<number> {
  const rows: Row[] = []
  const now = deps.clock.now()
  for await (const account of accounts) rows.push(classify(account, config[account.app?.name_slug ?? ''], now))
  const summary = summarize(rows)
  const counts = { movable: 0, reconnect: 0, manual_check: 0 }
  for (const r of rows) counts[r.status]++
  deps.writeFile(values.csv, toCsv(rows))
  deps.writeFile(
    values.json,
    JSON.stringify(
      {
        generated_at: new Date(now).toISOString(),
        source,
        ...meta,
        config_checked: Boolean(values.config),
        summary,
        next_steps: nextStepsFor(counts),
        accounts: rows,
      },
      null,
      2,
    ) + '\n',
  )
  deps.out(`${source}: ${rows.length} Connect accounts\n`)
  deps.out(formatSummary(summary))
  deps.out(`\nmovable      = OAuth on your own client, credentials returned, scopes present`)
  deps.out(`reconnect    = the customer must connect again in Truto`)
  deps.out(`manual_check = key-based or no-auth app; test one account by hand`)
  if (!values.config) deps.out(`\nNo --config given: client IDs and scopes were not checked.`)
  deps.out(`\nReport: ${values.csv}, ${values.json} (next_steps in the JSON says what to do per group)`)
  return 0
}

// Saved list-accounts responses: one response ({ data: [...] }), an array of responses (pages),
// or a plain array of accounts.
function readAccountsFile(path: string): PdAccount[] {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const pages = Array.isArray(raw) ? raw : [raw]
  const accounts: PdAccount[] = []
  for (const page of pages) {
    if (page && typeof page === 'object' && Array.isArray((page as { data?: unknown }).data)) {
      accounts.push(...((page as { data: PdAccount[] }).data))
    } else if (page && typeof page === 'object' && typeof (page as { id?: unknown }).id === 'string') {
      accounts.push(page as PdAccount)
    } else {
      throw new UsageError(`${path}: expected list-accounts responses ({ data: [...] }) or an array of accounts`)
    }
  }
  return accounts
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.env))
}
