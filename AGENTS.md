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
- Plugin-defect reports go to `Wuxie233/dsh-plugin-agent-teams` through
  `agent_teams_report_issue` (captain or standalone only). Members are
  denied the tool; the shared usage section must stay silent about it.
  Collection label is `agent-teams-feedback`.

## Commands

```sh
pnpm build              # tsc host+client, tsdown bundle
node scripts/verify.mjs # offline verification (must pass before deploy)
./install.sh            # deploy to ~/.dsh/profiles/node_modules/@wuxie233/dsh-agent-teams
```
