# Spec: AgentTeams self-iteration feedback

## Goal

The captain (or a session with no team) can file a plugin-defect issue on `Wuxie233/dsh-plugin-agent-teams` during real work, then keep delivering. A later session triages those issues to iterate the fork.

## Scenario

While orchestrating a team, the captain hits a design flaw, inefficiency, bug, or missing capability in AgentTeams itself. It calls `agent_teams_report_issue`, keeps the returned URL if useful, and continues. Periodically, a fresh session lists open `agent-teams-feedback` issues and picks a coherent fix scope.

## In scope

- New captain-visible tool `agent_teams_report_issue`.
- Standalone sessions (no active team) may file; active members cannot.
- Members never receive the tool (`MEMBER_DENIED_TOOLS`) and are not told about it in the shared usage section or member persona.
- Each observation creates a new issue. Repeated reports are a frequency signal; the tool does not search or comment on existing issues.
- Categories: `design_flaw`, `inefficiency`, `bug`, `missing_capability`.
- Severities: `critical`, `high`, `medium` (default), `low`.
- Issue body sections: Problem, optional Where this surfaced / Reproduction / Suggested direction, reporter attribution.
- Labels: `agent-teams-feedback`, kind, `severity:<level>`. Label creation is best-effort; filing without labels still succeeds.
- Target repository is fixed: `Wuxie233/dsh-plugin-agent-teams`. Do not file on `NanmiCoder/dsh-agent-teams`.
- Captain skill documents when to file, what not to file, and how to collect reports.

## Non-goals

- Project-code defects, taste disagreements, speculative risks, or skill-only habit tweaks.
- Member-facing discovery or member-authored issues.
- Dedup, comment-on-existing, or a metrics dashboard.
- Session events or activity-panel UI for reports.

## Constraints

- Mirror the Ensemble `team_report_issue` contract, adapted to DSH captain/member identity and `gh` subprocess filing.
- Shared `agent-teams:usage` prompt stays silent about this tool so members are not invited to hunt plugin defects.
- `gh` must already be authenticated as a user who can create issues on the private fork.

## Acceptance

- Captain and standalone callers receive an issue URL; members are rejected even if they somehow invoke the tool.
- Offline verify covers body rendering, authorization, labels, and the unlabeled fallback.
- Captain skill tells a later session how to list and triage open reports.
