# pipedream-connect-import-checker

Paste this into Claude Code, Cursor or Codex:

```text
Check which of my Pipedream Connect accounts can move to Truto, using github.com/trutohq/pipedream-connect-import-checker. Read its AGENTS.md before you open any of my files.
```

The agent clones this repo, reads [`AGENTS.md`](AGENTS.md), runs a read-only dry run, and explains the result. It moves a customer only after you say yes for that customer.

Pipedream Workflows shuts down on March 31, 2027. Workflows data, including connected-account tokens, is deleted by April 30, 2027. Pipedream Connect is not affected.

This CLI answers one question before you move: **which of your Pipedream Connect accounts can move to another platform without the customer connecting again?**

- The default mode is a **read-only dry run**. It lists every Connect account in a project and sorts each one into `movable`, `reconnect` or `manual_check`. It prints counts per app and writes a CSV and a JSON report.
- The `--import` mode is **opt-in**. It moves one customer's accounts for one app into [Truto](https://truto.one) with `POST /integrated-account`. It checks each account in Truto, and only then deletes the Connect account. A ledger makes reruns safe.

The rules and the import logic come from Truto's guide, [How to migrate Pipedream Workflows to Truto](https://truto.one/blog/how-to-migrate-pipedream-workflows-to-truto/). The dry run is useful for any destination that accepts imported OAuth tokens.

## What it checks

An account is `movable` when all of these are true:

| Check | Why |
|---|---|
| The app's `auth_type` is `oauth` | Key-based and no-auth apps are not confirmed to export. See [Limits](#limits). |
| Connect returned credentials for it | Pipedream returns credentials "only applicable for BYOA apps", that is, apps on **your own** OAuth client. No credentials means Pipedream's own client, so the customer must reconnect. |
| `credentials.oauth_client_id` equals the `clientId` in your config | A token issued to another client fails its first refresh on the new platform. |
| `authorized_scopes` holds every scope in `requiredScopes` | A missing scope imports fine, then fails with `403`. |
| The account is `healthy` and not `dead` | A broken token cannot move. |

Anything else is `reconnect` (OAuth) or `manual_check` (key-based, no-auth or unknown auth type). The report also adds notes, for example "Pipedream refreshes it within 15 minutes" or "no refresh token".

Without `--config`, the dry run cannot check client IDs or scopes. It still sorts accounts by "credentials returned or not", and it says so in each row's notes.

## Sample output

Try it with no credentials and no network, on the sample accounts in `examples/`:

```bash
bun src/cli.ts --accounts-file examples/accounts.sample.json --config examples/apps.sample.json
```

The test suite checks that this block matches the real output:

```text
file examples/accounts.sample.json: 8 Connect accounts

app      accounts  movable  reconnect  manual_check
slack           5        1          4             0
http            1        0          0             1
hubspot         1        1          0             0
openai          1        0          0             1
TOTAL           8        2          4             2

movable      = OAuth on your own client, credentials returned, scopes present
reconnect    = the customer must connect again in Truto
manual_check = key-based or no-auth app; test one account by hand

Report: connect-report.csv, connect-report.json (next_steps in the JSON says what to do per group)
```

Three rows of `connect-report.csv`:

```csv
account_id,external_user_id,app,auth_type,status,reasons,notes,credential_keys,oauth_client_id,has_refresh_token,authorized_scopes,healthy,dead,expires_at,next_refresh_at
"apn_good1","cus_1","slack","oauth","movable","","","oauth_access_token; oauth_client_id; oauth_refresh_token","1234.5678","true","chat:write; channels:read","true","false","2026-11-25T00:00:00.000Z","2026-11-24T23:00:00.000Z"
"apn_pdclient","cus_2","slack","oauth","reconnect","no credentials returned (likely Pipedream's own OAuth client)","","","","false","chat:write; channels:read","true","false","2026-11-25T00:00:00.000Z","2026-11-24T23:00:00.000Z"
"apn_keys1","cus_6","openai","keys","manual_check","key-based app: credential fields returned, import not confirmed; test one account by hand","","api_key","","false","","true","false","",""
```

`connect-report.json` holds `summary` (counts per app), `config_checked`, `accounts` (one row per account, as in the CSV) and `next_steps`. `next_steps` has one entry per group that has accounts, so a person or an agent can act on the report directly:

```json
"next_steps": {
  "reconnect": {
    "accounts": 4,
    "meaning": "The tokens cannot move: Pipedream's own OAuth client, another client, missing scopes, or a broken account.",
    "steps": ["Decide per app: keep these accounts on Pipedream Connect ...", "..."],
    "docs": [{ "title": "Connect an account (link token, Connect UI)", "url": "https://truto.one/docs/guides/integrated-accounts/connecting-an-account/" }]
  }
}
```

`--accounts-file` also reads your own saved list-accounts responses (one `{ data: [...] }` response, an array of pages, or an array of accounts). A response saved with `include_credentials=true` holds live tokens, so keep such a file out of git and delete it after use.

The report holds credential **key names** only (`credential_keys`), never token or key values. Cells that start with `=`, `+`, `-` or `@` get a leading `'`, so a spreadsheet does not run a customer-supplied ID as a formula.

## Use it with an AI coding agent

| Piece | What it is for |
|---|---|
| [`AGENTS.md`](AGENTS.md) | The steps and hard rules. Codex and Cursor read it. Claude Code reads it through [`CLAUDE.md`](CLAUDE.md). |
| [`skills/pipedream-to-truto`](skills/pipedream-to-truto/SKILL.md) | An [Agent Skill](https://agentskills.io/specification): check, set up Truto, map each workflow, move customers. Works from any folder. |
| [`.mcp.json`](.mcp.json), [`.cursor/mcp.json`](.cursor/mcp.json) | Truto's public docs MCP server, `https://docs-mcp.truto.one/mcp`, so the agent reads Truto's docs instead of guessing. |
| [`.claude-plugin/`](.claude-plugin/) | A Claude Code plugin with the skill and the docs MCP. |
| [`llms.txt`](llms.txt) | A short index of this repo for LLMs. |

Install the skill for any agent the [`skills`](https://github.com/vercel-labs/skills) CLI supports (Claude Code, Cursor, Codex and more):

```bash
npx skills add trutohq/pipedream-connect-import-checker
```

Or install the Claude Code plugin:

```text
/plugin install pipedream-to-truto --marketplace trutohq/pipedream-connect-import-checker
```

On older Claude Code versions:

```text
/plugin marketplace add trutohq/pipedream-connect-import-checker
/plugin install pipedream-to-truto@pipedream-connect-import-checker
```

**Why there is no MCP server for the check.** Claude Code, Cursor and Codex all run shell commands, so the agent runs the CLI and reads the JSON report. An MCP server would add a second way to do the same thing. It would also need your Pipedream client secret in the MCP client's config file, where the CLI reads it from a git-ignored `.env`. The import stays a CLI command that the agent runs only after your yes.

## Install and run

Needs [Bun](https://bun.sh) 1.1 or later. No runtime dependencies.

```bash
git clone https://github.com/trutohq/pipedream-connect-import-checker
cd pipedream-connect-import-checker
bun install
```

Set the Pipedream API credentials. Create an OAuth client under your Pipedream workspace's API settings. Put the values in a `.env` file in the repo root (Bun loads it, and git ignores it), or export them:

```bash
PD_CLIENT_ID=...
PD_CLIENT_SECRET=...
PD_PROJECT_ID=proj_...
PD_ENVIRONMENT=production   # or development
```

Dry run over the whole project:

```bash
bun src/cli.ts --config apps.json
```

Narrow it with `--app <slug>` and `--external-user-id <id>`. Change the report paths with `--csv` and `--json`.

The dry run asks Pipedream for the `connect:accounts:read` scope only, and sends only `GET` requests for accounts.

### apps.json

One entry per Pipedream app slug. Copy `apps.example.json`. The dry run reads `clientId` and `requiredScopes`. `--import` needs every field.

```json
{
  "slack": {
    "clientId": "1234567890.1234567890",
    "pdOauthAppId": "oa_abc123",
    "envIntegrationId": "<Truto environment integration id>",
    "requiredScopes": ["chat:write"],
    "cheapRead": "/unified/instant-messaging/channels?limit=1"
  }
}
```

| Field | Meaning |
|---|---|
| `clientId` | The provider's client ID of your OAuth app. Set the same client ID and secret in Truto **before** you import. |
| `pdOauthAppId` | Your custom OAuth client in Pipedream (`oa_...`). |
| `envIntegrationId` | The installed integration in Truto. |
| `requiredScopes` | The scopes your own calls need. |
| `cheapRead` | One small Unified API read, as a path on `api.truto.one`. |

## Import mode

```bash
export TRUTO_API_TOKEN=...
bun src/cli.ts --import --config apps.json --app slack --external-user-id cus_123
```

**This mode deletes Connect accounts.** After the delete, the only rollback is a customer reconnect. Run it on one test account per app first, and read the guide's section on rotating refresh tokens.

For each account of that customer and app, it:

1. Lists all the accounts with `oauth_app_id` set to your client and `include_credentials=true`, before it changes anything.
2. Skips any account that fails a check: wrong user, not OAuth, unhealthy, no credentials, another OAuth client, missing scopes, a Pipedream refresh due within 15 minutes, or an access token that expires within 15 minutes.
3. Writes an `importing` marker to the ledger, then creates the Truto account with `POST /integrated-account`.
4. Polls `GET /integrated-account/:id` for up to 5 minutes until the status leaves `connecting`.
5. If the account is `active`, makes the one `cheapRead` call.
6. If the check fails, deletes the Truto account. Pipedream keeps the only copy of the token.
7. If the check passes, deletes the Connect account, and marks it `deleted` in the ledger.

The ledger is `migrated-accounts.json` (change it with `--ledger`). Only one run at a time can use a ledger: a run holds `<ledger>.lock` until it ends. A rerun skips finished accounts and finishes accounts that stopped between the import and the delete. The exit code is `3` when an account is left pending.

### Changes from the guide's script

The logic is the guide's step 5 script. These changes close paths where a token could end up in two places with no record, or leak:

- **Pagination.** The guide reads one page of accounts. This tool follows `page_info.end_cursor`, and reads every page before it deletes anything.
- **One run per ledger.** Each run rewrites the whole ledger, so two parallel runs would drop each other's entries, and a rerun would import twice. A lock file now stops a second run.
- **Expiry check.** The guide imported a token that was about to expire, so Truto refreshed it at once. Now accounts whose access token expires within 15 minutes, or whose dates do not parse, are skipped.
- **Rollback finished by an earlier run.** If a run deleted the Truto account but stopped before the ledger write, the next run finds a `404`, drops the entry and keeps the Connect account.
- **Rollback is checked.** The guide ignored the result of the Truto `DELETE` and then dropped the ledger entry. Now a failed delete stops the run, keeps the entry and leaves the Connect account alone.
- **Import marker.** A crash between the Truto `POST` and the ledger write could import the same account twice on a rerun. Now a marker is saved before the `POST`. A rerun that finds a marker without a Truto ID stops for that account and asks you to check the tenant. A refused import (`4xx`) clears the marker. A timeout or `5xx` keeps it.
- **Safe read URL.** The guide joined `cheapRead` to the base URL as a string. A value such as `@evil.example/x` would send your Truto token to another host. Now the URL is built with `URL()`, and any origin but `https://api.truto.one` is refused when the config loads, before any import.
- **Config checks.** Every import field must be set, so an empty `clientId` cannot pass the client check.
- **Also checked:** the account's `external_id` and `auth_type` match the request.
- **A Pipedream delete `404`** counts as already deleted.
- **Rate limits.** A `429` waits for `Retry-After`, up to 5 times. Every request has a 30-second timeout.
- **Token refresh.** The Pipedream API token lasts one hour. The tool gets a new one before it expires.
- **Ledger writes** go to a temp file first, then a rename.
- **The cheap read URL** sets `integrated_account_id` with `searchParams`, so `cheapRead` may hold no query string.

## Limits

- **Key-based apps** (`auth_type: keys`) are reported as `manual_check`. Pipedream's OAuth clients page says it stores key-based credentials "and exposes them via API", but the API reference limits returned credentials to BYOA apps. The import handles OAuth only. Test one key-based account by hand.
- **Refresh tokens that rotate.** After an import, both systems hold the same refresh token. With a rotating token (Jira, Slack with token rotation, maybe HubSpot and Salesforce), the first refresh by either side disables the other side's copy. So import mode moves one customer at a time, deletes the Connect account in the same run, and skips accounts Pipedream will refresh within 15 minutes. A short window between the import and the delete stays. If a run stops in that window, run it again soon.
- **A rollback after a Truto refresh.** If Truto refreshes a rotating token during the check, and then the check fails, the rollback leaves Pipedream with a refresh token the provider has disabled. That customer must reconnect. The 15-minute expiry check makes this unlikely, not impossible.
- **Does the Pipedream delete revoke the token at the provider?** The [delete account](https://pipedream.com/docs/connect/api-reference/delete-account) reference does not say. If it does, the imported token dies too. Test one account per app, and check the Truto account still works an hour after the delete.
- **App-specific credential fields**, such as `base_url`, are listed in `credential_keys` but are not imported. Some Truto integrations need instance values such as a subdomain in `context`. Map them before you import those apps.
- **Workflows-only accounts.** Accounts connected only inside a Workflows workspace are not Connect accounts, so this tool cannot see them. Their tokens are not in the Workflows export.
- **Page size.** The tool sends no `limit`, because the maximum is not documented. It uses the API default and follows every page.
- The dry run is a point-in-time read. Run it again close to the move.

## Pipedream API reference used

- [List accounts](https://pipedream.com/docs/connect/api-reference/list-accounts): `GET /v1/connect/{project_id}/accounts` with `external_user_id`, `oauth_app_id`, `app`, `include_credentials`, `after`. Response `{ data, page_info: { count, total_count, start_cursor, end_cursor } }`. The Account fields read here: `id`, `external_id`, `healthy`, `dead`, `app.name_slug`, `app.auth_type`, `expires_at`, `authorized_scopes`, `credentials`, `next_refresh_at`.
- [Delete account](https://pipedream.com/docs/connect/api-reference/delete-account): `DELETE /v1/connect/{project_id}/accounts/{account_id}`, `204` on success.
- [Authentication](https://pipedream.com/docs/connect/api-reference/authentication): `POST /v1/oauth/token` with `grant_type=client_credentials` and the `connect:accounts:read` / `connect:accounts:write` scopes. Tokens expire after one hour.
- [Connect API introduction](https://pipedream.com/docs/connect/api-reference/introduction): the `x-pd-environment` header (`production` or `development`).

Truto API used by `--import`: [create](https://truto.one/docs/api-reference/admin/integrated-accounts/create/), [get](https://truto.one/docs/api-reference/admin/integrated-accounts/get/) and [delete](https://truto.one/docs/api-reference/admin/integrated-accounts/delete/) integrated account.

## Safety

- No token, key or secret is printed, logged or written to a report or the ledger. Error messages hold HTTP status codes, never response bodies. The test suite checks this with sentinel token values.
- Reports and the ledger are written with file mode `600`. They hold customer IDs.
- Never commit `apps.json`, reports or the ledger. `.gitignore` covers the default names.

## Development

```bash
bun test
bun x tsc --noEmit --strict
```

Tests use recorded-shape fake responses only. They never call a live API.

## License

[MIT](LICENSE)
