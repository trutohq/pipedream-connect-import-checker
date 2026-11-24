// What to do with each group of accounts. Written into the JSON report as `next_steps`,
// so a person or an AI agent can act on the report without reading the README.
import type { Status } from './check'

const GUIDE = 'https://truto.one/blog/how-to-migrate-pipedream-workflows-to-truto/'

export type NextSteps = {
  meaning: string
  steps: string[]
  docs: { title: string; url: string }[]
}

export const NEXT_STEPS: Record<Status, NextSteps> = {
  movable: {
    meaning: 'OAuth account on your own OAuth client. The tokens can move to Truto without the customer connecting again.',
    steps: [
      'In Truto, install the integration and set the same OAuth Client ID and Client Secret your Pipedream custom OAuth client uses. Do this before any import.',
      'Rebuild what the Pipedream workflow did: Unified API calls from your backend, a RapidBridge sync job for polling, or a Truto workflow.',
      'Fill in apps.json (clientId, pdOauthAppId, envIntegrationId, requiredScopes, cheapRead) for the app.',
      'Run --import for one test customer. Check the Truto account still works an hour later.',
      'Then move one customer at a time, each with an explicit yes. The import deletes the Connect account, and after that the only rollback is a reconnect.',
    ],
    docs: [
      { title: 'Override OAuth credentials (use your own OAuth app)', url: 'https://truto.one/docs/guides/integrations/overriding-oauth-credentials/' },
      { title: 'Create integrated account (token import)', url: 'https://truto.one/docs/api-reference/admin/integrated-accounts/create/' },
      { title: 'Connection flow and post-install steps', url: 'https://truto.one/docs/guides/integrated-accounts/connection-flow/' },
      { title: 'Unified APIs overview', url: 'https://truto.one/docs/guides/unified-apis/overview' },
      { title: 'RapidBridge sync jobs', url: 'https://truto.one/docs/guides/rapid-bridge/creating-rapid-bridge/' },
      { title: 'V4 sync job reference', url: 'https://truto.one/docs/guides/sync-jobs/v4-reference/' },
      { title: 'Workflows', url: 'https://truto.one/docs/guides/workflows/overview' },
      { title: 'Migration guide: move one customer at a time', url: `${GUIDE}#5-move-one-customer-at-a-time` },
    ],
  },
  reconnect: {
    meaning: "The tokens cannot move: Pipedream's own OAuth client, another client, missing scopes, or a broken account.",
    steps: [
      'Decide per app: keep these accounts on Pipedream Connect (Connect is not shutting down), or move the app and ask each customer to connect again.',
      'For a move, create a link token for the tenant and send the customer to the Truto Connect UI, or embed it with the Link SDK.',
      'For missing scopes, ask for the new scopes in the same reconnect.',
    ],
    docs: [
      { title: 'Connect an account (link token, Connect UI)', url: 'https://truto.one/docs/guides/integrated-accounts/connecting-an-account/' },
      { title: 'Embed the Connect UI with the Link SDK', url: 'https://truto.one/docs/guides/link-sdk/how-to-embed/' },
      { title: 'Migration guide: which accounts can move', url: `${GUIDE}#which-accounts-can-move-without-a-reconnect` },
    ],
  },
  manual_check: {
    meaning: 'Key-based, no-auth or unknown auth type. Truto can import API key, basic auth and client-credential accounts, but this tool\'s --import moves OAuth accounts only.',
    steps: [
      'Key-based app: check that credential_keys shows the key fields for one account. Pipedream\'s docs conflict on whether it returns them.',
      'If the key is there, create the Truto account with POST /integrated-account: authentication_method "api_key" (API key or basic auth) or "oauth2_client_credentials" (Truto fetches the token), and context keys that match the integration\'s credential field names.',
      'If the key is missing, the customer enters it again in Truto.',
      'No-auth app: nothing to import. Rebuild the logic only.',
    ],
    docs: [
      { title: 'Create integrated account', url: 'https://truto.one/docs/api-reference/admin/integrated-accounts/create/' },
      { title: 'Migration guide: key-based accounts', url: `${GUIDE}#which-accounts-can-move-without-a-reconnect` },
    ],
  },
}

// Only the groups that have accounts, with their counts.
export function nextStepsFor(counts: Record<Status, number>): Partial<Record<Status, NextSteps & { accounts: number }>> {
  const out: Partial<Record<Status, NextSteps & { accounts: number }>> = {}
  for (const status of ['movable', 'reconnect', 'manual_check'] as const) {
    if (counts[status] > 0) out[status] = { accounts: counts[status], ...NEXT_STEPS[status] }
  }
  return out
}
