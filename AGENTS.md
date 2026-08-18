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
- The activity panel stays collapsed until the user opens it (corner
  badge or conversation card). Do not reintroduce auto-expand.
- Live team messages barge in. Do not route captain reports through
  `steer()` or member wakes through a queued followup without interrupt.
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
