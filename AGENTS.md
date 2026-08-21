# AGENTS.md — agent-teams fork

## Gotchas

- This is a fork: upstream is `NanmiCoder/dsh-agent-teams` (remote
  `upstream`). Keep fork changes minimal and centralized so rebases stay
  cheap; read-only isolation lives in `src/roles.ts` + three wiring hunks
  (`members.ts` deny/persona, `index.ts`/`tools.ts` config).
- Package name appears in three places that must stay in sync:
  `package.json` name, `cordis.patch.yml` mount row, client registration.
  It is `@wuxie233/dsh-agent-teams`.
- `scripts/verify.mjs` calls `spawnMember` with the upstream signature
  (positional args, no runtime config for roles) — that is why
  `MemberRuntimeConfig.readOnlyRoles` is optional with `?? []` fallbacks.
  Don't make it required.
- Deploy by copy (`install.sh`), never symlink (Node ESM resolution).
- Host-half changes need a dsh web restart; client-half only a page refresh.
- The conversation card folds create/add_member/remove_member
  `tool/result.meta` onto one team id. Do not hardcode `members: []`.
  The activity panel is the only `/plugins/dsh-agent-teams/state` poller;
  cards read the shared snapshot. A missing snapshot keeps the folded roster.
- The activity panel stays collapsed until the user opens it (corner
  badge or conversation card). Do not reintroduce auto-expand.
- Captain protocol: add_member first (required prompt, first claimed
  task). create_task is for later work after the assignee exists, using
  returned `t1`/`t2` ids only. Keep the skill, usage prompt, and tool
  descriptions on that order.
- Live team messages barge in by default. Pass `mode=queue` only when
  the current turn must finish. Do not route reports through `steer()`.
  Captains do not send blank continue reminders; they wait for a member
  report or a stall notice, then barge a new instruction.
- Optional `cwd` on add_member pins the child workspace. A cwd that is
  not the captain workspace writes `captain-pointer.json`. When both
  `cwd` and `worktree` are set they must be the same path.
- An interrupted member that goes idle with open claimed/in_progress
  tasks and an empty inbox queues a captain stall notice. Do not fail or
  unclaim the task. Do not auto-wake members on captain session resume.
- `agent_teams_delete` must retire members (`cancel` without keepInbox),
  not only interrupt the current turn. claimed → completed is legal.
- Do not restore a greeting turn. `spawnMember` takes the first claimed
  task plus captain brief; that is the only initial user message.
- Panel/status "working" is turn activity, not `listChildren().activity`.
  The store bit is `running` whenever the child session is still live in
  `ctx.sessions`; a stopped conversation stays loaded. `memberActivity`
  and the activity snapshot refine that through `ctx.agents.get(id).status`.
- Plugin-defect reports go to `Wuxie233/dsh-plugin-agent-teams` through
  `agent_teams_report_issue` (captain or standalone only). Members are
  denied the tool; the shared usage section must stay silent about it.
  Collection label is `agent-teams-feedback`.
- Members accept an opt-in per-member git worktree (`worktree` arg on
  add_member). cwd freezes at spawn, so the captain creates the tree first
  and plans tasks per member-tree. Read-only roles refuse worktrees.
  The plugin writes `<worktree>/<stateDir>/captain-pointer.json` and all
  member-side tools resolve team state through it; the pointer is trusted
  the same way the team files are (persona forbids direct edits).
  Merge order follows the task DAG; conflicts are captain-adjudicated.
  Worktree creation, merge, and removal stay captain-owned git operations.
- The worktree path needs the patched runtime: local DSH commits
  `a4b50ba` + `82b943e` (child-cwd seam) and the deployment-bundle patch
  marked `LOCAL-PATCH-child-cwd.txt`. spawnMember fails loud and
  interrupts the member when the runtime ignores the cwd override.
  On a sandboxed preset, a worktree member may lose read access to team
  state under the captain tree (danger-full-access on this host is fine).

## Commands

```sh
pnpm build              # tsc host+client, tsdown bundle
node scripts/verify.mjs # offline verification (must pass before deploy)
./install.sh            # deploy to ~/.dsh/profiles/node_modules/@wuxie233/dsh-agent-teams
```
