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
- **Per-member git worktrees** (requires the patched runtime, see
  AGENTS.md): `agent_teams_add_member` accepts an absolute `worktree`
  path the captain created. The member spawns inside it
  (`ContinuableStartSpec.cwd`), a captain-pointer file redirects its
  team-state resolution back to the captain workspace, read-only roles
  refuse worktrees, and merge/removal stay captain-owned git operations.
  Implementation: `state.ts` pointer helpers + `members.ts` spawn path +
  `tools.ts` wiring.
- **Turn activity, not store activity**: the panel and
  `agent_teams_status` treat a member as working only while
  `ctx.agents.get(id).status === 'running'`. `listChildren().activity`
  stays `running` for any child still live in `ctx.sessions`, including
  a stopped conversation. Implementation: `members.ts` `turnActivityOf`
  + snapshot reuse.
- **Activity panel stays collapsed**: no auto-expand after settle or new
  activity. The corner badge and conversation card remain the only open
  paths.
- **Barge-in delivery**: `agent_teams_send_message` interrupts a running
  recipient, then delivers immediately. Captain reports use
  `cancel({ kind: 'parent' }, { keepInbox: true })` + `followup`; member
  wakes use `interrupt` + `followup`. Steering / FIFO-next-turn is gone.

## Workflow

Edit → `pnpm build` → `node scripts/verify.mjs` → `./install.sh` → restart
dsh web. Never edit the runtime copy under `~/.dsh/profiles/node_modules/`.

## Upstream sync

Rebase onto upstream releases, re-apply the fork hunks above, rebuild,
verify, redeploy.
