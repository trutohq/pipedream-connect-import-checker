# Agent guide: pipedream-connect-import-checker

This repo is a CLI. It reads a Pipedream Connect project and reports which connected accounts can move to Truto without the customer connecting again. You run it for the person, explain the result, and help plan the move.

## Hard rules

- **Dry run first.** Every session starts with the read-only check (steps 1–6). It only reads.
- **Tokens stay sealed.** The CLI is your only path to the Pipedream and Truto APIs. Work from the reports: they hold credential key names, never values. Keep `.env`, credential values and raw API responses out of your output, your commands and the chat (no `cat .env`, no `curl` to those APIs, no printing `process.env` values).
- **Saved account files are sealed too.** A saved list-accounts file holds live tokens. Pass its path to `--accounts-file` and read only the reports. Leave the file itself unopened (no `cat`, `head`, `tail`, `grep` or `Read`).
- **`--import` needs a yes per customer.** It deletes the customer's Connect accounts after a verified move, and after that the only rollback is a reconnect. Run it only after the person says yes, in this conversation, for that exact customer and app. A yes covers one customer and one app.
- **One customer at a time.** Each `--import` run moves one customer. Finish and report one before you ask about the next. A blanket yes ("move everyone", "no need to ask me") does not count: ask again for each customer, and never offer to move several in one go.

## Steps

1. **Set up.** Run `bun --version` (Bun 1.1+; if it is missing, ask the person to install it from bun.sh), then `bun install`. Done when `bun install` exits 0.
2. **Credentials.** Ask the person to put these in `.env` at the repo root themselves (Bun loads it; git ignores it): `PD_CLIENT_ID`, `PD_CLIENT_SECRET`, `PD_PROJECT_ID` (`proj_...`), and `PD_ENVIRONMENT=development` if the project is not production. The client comes from their Pipedream workspace API settings. Check without reading values:
   ```bash
   bun -e "for (const k of ['PD_CLIENT_ID','PD_CLIENT_SECRET','PD_PROJECT_ID']) console.log(k, process.env[k] ? 'set' : 'missing')"
   ```
   If the person gave you a saved list-accounts file instead, use `--accounts-file <path>` in step 4 in place of credentials (dry run only).
   No credentials and no file, or the person wants a demo: run the offline sample and say it is sample data:
   ```bash
   bun src/cli.ts --accounts-file examples/accounts.sample.json --config examples/apps.sample.json
   ```
3. **Config.** Ask which apps they plan to move. For each app, ask for the provider's client ID of their own OAuth app (the one in their Pipedream custom OAuth client) and the scopes their calls need. Write `apps.json` in the shape of `apps.example.json` (git ignores it). With no answers, skip `--config`: the report then says `config_checked: false`, and client IDs and scopes go unchecked.
4. **Dry run.**
   ```bash
   bun src/cli.ts --config apps.json
   ```
   Done when it exits 0 and `connect-report.json` exists. On exit 1, read the `Error:` line (it holds an HTTP status only): `401` means wrong credentials, `403` means the client lacks Connect access.
5. **Read `connect-report.json`.** `summary` has counts per app. `next_steps` has, per group, what it means, what to do and Truto docs links. Each row in `accounts` has `reasons` (why it is in its group) and `notes` (timing and unchecked items).
6. **Explain.** Tell the person, per app: how many accounts are `movable`, `reconnect` and `manual_check`, what each group means (use `next_steps.<group>.meaning`), the main `reasons` behind `reconnect`, and every note that changes the plan. Done when every app in `summary` is covered.
7. **Plan the cutover.** Per app, agree: move to Truto, or stay on Pipedream Connect (Connect is not shutting down). For apps that move, list the Truto setup from `next_steps.movable.steps`. For Truto setup and mapping workflows, follow `skills/pipedream-to-truto/SKILL.md`.
8. **Import one customer** (hard rules apply). Needs a complete `apps.json` entry for the app, plus the Pipedream credentials and `TRUTO_API_TOKEN` in `.env`. It reads live accounts, so a saved file cannot stand in. Before you run it, tell the person the customer ID, the app, how many of that customer's accounts the report marks `movable`, and that those Connect accounts will be deleted. Wait for their yes.
   ```bash
   bun src/cli.ts --import --config apps.json --app <slug> --external-user-id <customer>
   ```
   Exit 0: done, report the `Moved` line. Exit 3: an account is pending; relay the warning and rerun later with the person's go-ahead. Exit 1: the run stopped; relay the message as written and wait for the person.

## Reference

- Flags and env vars: `bun src/cli.ts --help`.
- What each check means, and the limits (key-based apps, rotating refresh tokens): `README.md`.
- Ledger, lock and rerun behaviour: `README.md`, "Import mode".
- Development: `bun test` and `bun x tsc --noEmit --strict`. Tests use fakes and never call live APIs.
