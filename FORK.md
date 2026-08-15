# Fork notes (Wuxie233)

Upstream: NanmiCoder/dsh-agent-teams (remote `upstream`). The upstream
README/README_ZH/docs still apply unless overridden here.

## Fork differences (v0.2.0)

- Package renamed to `@wuxie233/dsh-agent-teams`.
- **Read-only role isolation**: members whose `role` matches a configured
  `readOnlyRoles` token (substring, case-insensitive; default
  `scout / reviewer / planner / diagnostician`) are additionally denied
  `write` / `edit` / `bash` at spawn, and their persona carries an explicit
  read-only working rule. Writers keep full tools.
- New config key `readOnlyRoles: string[]` on the mount row.
- Implementation: `src/roles.ts` + wiring in `members.ts` / `index.ts` /
  `tools.ts`.
- **Self-iteration reports**: captain or standalone sessions can file
  plugin-defect issues on `Wuxie233/dsh-plugin-agent-teams` via
  `agent_teams_report_issue`. Members are denied the tool. Contract:
  [docs/self-iteration-spec.md](docs/self-iteration-spec.md).

## Workflow

Edit → `pnpm build` → `node scripts/verify.mjs` → `./install.sh` → restart
dsh web. Never edit the runtime copy under `~/.dsh/profiles/node_modules/`.

## Upstream sync

Rebase onto upstream releases, re-apply the fork hunks above, rebuild,
verify, redeploy.
