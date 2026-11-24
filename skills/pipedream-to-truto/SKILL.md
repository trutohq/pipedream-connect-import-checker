---
name: pipedream-to-truto
description: Move Pipedream Connect accounts and Pipedream Workflows to Truto. Use when someone asks which Pipedream Connect accounts can move to Truto, plans for the Pipedream Workflows shutdown, or wants to import Pipedream OAuth tokens into Truto.
license: MIT
metadata:
  repository: https://github.com/trutohq/pipedream-connect-import-checker
---

# Pipedream to Truto

Pipedream Workflows shuts down on March 31, 2027, and its data is deleted by April 30, 2027. Pipedream Connect stays. Connect accounts on the team's own OAuth client can move to Truto without a reconnect. The `pipedream-connect-import-checker` CLI finds them and moves them.

## Steps

1. **Run the check.** If the current folder is not a clone of the checker, clone it where the person agrees, then `cd` into it:
   ```bash
   git clone https://github.com/trutohq/pipedream-connect-import-checker
   ```
   Read its `AGENTS.md` and follow steps 1–7. Its hard rules bind you for the whole session: dry run first, tokens and saved account files stay sealed, `--import` only after the person's yes for that customer, one customer at a time. Read `AGENTS.md` before you open any file the person names. Done when the person has the counts per app and knows what each group means.

2. **Use Truto's docs, not memory.** Truto's docs MCP server is public, with no sign-in: `https://docs-mcp.truto.one/mcp` (streamable HTTP). Its tools are `search_docs`, `get_doc_page`, `list_api_endpoints` and `get_api_endpoint`.
   - The checker repo ships it in `.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor).
   - Elsewhere, add it as a remote MCP server, for example `claude mcp add --transport http truto-docs https://docs-mcp.truto.one/mcp`.
   - With no MCP, open the links in the report's `next_steps.<group>.docs`.

3. **Set up Truto for each app that moves.** Do this before any import.
   - Install the integration in a Truto environment. On its **Configuration** tab, turn on **Use your own OAuth settings**, and enter the same Client ID and Client Secret as the Pipedream custom OAuth client. Add Truto's redirect URL to that OAuth app at the provider. Docs: `guides/integrations/overriding-oauth-credentials`.
   - Install the Unified APIs the person's calls need, for example CRM or Instant Messaging.
   - For terminal admin work (integrations, accounts, sync jobs, logs), use Truto's own skills: `npx skills add trutohq/truto-skills`. The `truto-cli` skill covers the CLI, `truto` covers application code, and `truto-jsonata` covers mappings and sync job expressions.
   - Record `envIntegrationId` and a `cheapRead` path for the app in the checker's `apps.json`.

4. **Map each Pipedream workflow to Truto.** Ask the person for the list of workflows (Pipedream export: Project → Settings → Export Workflows). Give each one a target:

   | Pipedream | Truto |
   |---|---|
   | Code step or action calling an app's API | Unified API call from their backend, or the Proxy API |
   | Timer + code step that polls for new records | RapidBridge V4 sync job, scheduled per account (`guides/sync-jobs/v4-reference`) |
   | App event source (webhook from the app) | Inbound vendor webhooks and `record:*` events (`guides/webhooks/inbound-vendor-webhooks`) |
   | Transforms, filters, branches | JSONata in Unified API mappings or V4 nodes |
   | Data store checkpoints | V4 `get_state` / `update_state`, or their own database |
   | Delays, approvals, internal automations | Their backend or a workflow tool, not Truto |

   The full table, with sources, is in the guide: https://truto.one/blog/how-to-migrate-pipedream-workflows-to-truto/#map-pipedream-components-to-truto. Done when every workflow on the person's list has a target, or a decision to stay on Connect.

5. **Move customers.** Follow `AGENTS.md` step 8, one customer at a time. For `reconnect` accounts of apps that move, use `next_steps.reconnect` (link token and the Truto Connect UI).
