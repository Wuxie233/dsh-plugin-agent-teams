# Fork notes (Wuxie233)

Upstream: NanmiCoder/dsh-agent-teams (remote `upstream`). The upstream
README/README_ZH/docs still apply unless overridden here.

## DSH 0.1.2-alpha.1 (v0.2.1)

- Drop `@deepseek-ai/dsh-client-runtime`. Browser apply types `Context`
  from cordis. Conversation card types come from
  `dsh-client-ui-conversation` / `dsh-client-ui-chat`. Activity panel
  reads `SessionListState` from session-controller and
  `ObservableSnapshot` from `dsh-client-store`.
- tsdown externals are the current PLATFORM_MODULES seed table only.

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
- **Barge-in delivery by default**: `agent_teams_send_message` interrupts
  a running recipient, then delivers immediately. Pass `mode=queue` when
  the current turn must finish. Captains do not send blank continue
  reminders. Steering is still unused.
- **Spawn brief fallbacks**: `prompt` is documented; `brief` /
  `instructions` / `task_description` / `task_subject` are accepted so a
  dropped XML `prompt` field does not fail the call.
- **Optional member `cwd`**: pin a child to one repo when the captain
  sits on an umbrella workspace. Differs from `worktree` (no `.git`
  requirement). A cwd that is not the captain workspace writes a
  captain-pointer. cwd/worktree still require the runtime child-cwd
  transport; a miss still fail-loud.
- **No default member cap**: omit `maxMembers` for unlimited live
  members. An explicit number still rejects overflow with `liveCount/cap`.
- **Stall notice**: an interrupted member that goes idle with open
  claimed/in_progress tasks and an empty inbox queues a captain notice.
  Tasks stay claimed. Captain session resume does not auto-wake members.
- **Teardown drops queued member work**: `agent_teams_delete` calls
  `retireMember` (`cancel` without `keepInbox`) so stale follow-ups
  cannot keep waking the captain after the team is archived.
- **claimed → completed** is a legal hop; members must read
  `agent_teams_status` every turn.
- **No greeting turn**: `agent_teams_add_member` requires the first
  task subject and prompt. That prompt is the spawn user message.

## Workflow

Edit → `pnpm build` → `node scripts/verify.mjs` → `./install.sh` → restart
dsh web. Never edit the runtime copy under `~/.dsh/profiles/node_modules/`.

## Upstream sync

Rebase onto upstream releases, re-apply the fork hunks above, rebuild,
verify, redeploy.
