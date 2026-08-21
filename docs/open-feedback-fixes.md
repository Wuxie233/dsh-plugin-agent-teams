# Spec: remaining AgentTeams self-iteration fixes

## Goal

Close open fork issues #14, #13, #12, #11, #7, #6, and #5 with one coherent
delivery contract. Captains can spawn, wake, and recover members without
aborting live turns, losing claimed work, or watching members wander the
umbrella workspace.

## Scenario

A captain on this host builds a team, spawns writers, sometimes nudges a slow
member, and later resumes after an interrupt. Members stay on the assigned
workspace, consume claimed work on the first turn, and the captain learns about
a stalled member without polling.

## In scope

- `agent_teams_send_message` defaults to barge. `mode=queue` waits out the
  current turn. Captains do not send blank continue reminders.
- An interrupted member that goes idle with open claimed/in_progress tasks and
  no pending inbox wakes the captain through the durable mailbox.
- `agent_teams_add_member` accepts a spawn brief from `prompt`, `brief`,
  `instructions`, `task_description`, or `task_subject` so a dropped `prompt`
  field does not fail the call as "missing required property".
- Optional absolute `cwd` on add_member pins the child workspace. A cwd that
  is not the captain workspace gets a captain-pointer. Persona and spawn brief
  name the workspace root and forbid sibling-repo search.
- Every spawn prompt and later wake lists that member's open claimed /
  in_progress tasks. Status for a member viewer leads with those tasks.
  `claimed` counts as current work in the activity snapshot.
- The first spawned task is marked `in_progress` once the child exists.
- Captain session resume does not auto-wake members. Stall notices tell the
  captain who is parked; the captain barges a new instruction after that.

## Non-goals

- Re-opening or regressing closed issues #1–#4 and #8–#10.
- Publishing to the upstream npm package.
- Changing DSH XML/tool-argument parsing itself.
- Auto-detecting a git repo when the captain sits on an umbrella directory.

## Constraints

- Default writers still share the captain tree. `cwd` is opt-in, like
  `worktree`. `worktree` still requires `.git` and still refuses read-only
  roles. When both are set they must be the same path.
- Do not restore a greeting turn.
- `agent_teams_delete` still retires members with `cancel` and no `keepInbox`.
- claimed → completed stays legal.
- Fork changes stay centralized so rebases onto upstream remain cheap.

## Acceptance

Offline `node scripts/verify.mjs` after `pnpm build` proves:

1. Default delivery interrupts; explicit `mode=queue` follows up without interrupt.
2. Default captain delivery cancels the current turn; explicit queue does not.
3. Spawn brief falls back when `prompt` is absent.
4. Non-worktree `cwd` is passed through, writes a captain pointer when it
   differs from the captain workspace, and rejects a relative path.
5. A member idle after `turn/end` interrupted, with open tasks and an empty
   inbox, appends a captain stall message. Pending inbox or a completed turn
   does not.
6. Spawn prompt / assigned-work helper lists claimed tasks; snapshot
   `currentTask` uses claimed when nothing is `in_progress`.
7. Captain resume does not select members to auto-wake.

GitHub issues #14, #13, #12, #11, #7, #6, and #5 are closed with the
implementing commit.

## Resolved decisions

- Barge is the default because a captain message is new information or a
  plan change. Blank continue reminders are forbidden; that is what made
  barge unsafe in #13.
- Stall handling notifies; it does not fail or unclaim the task, so the same
  task can be resumed.
- `prompt` stays the documented spawn-brief name. It is no longer schema-
  required so a dropped XML field can fall back.
