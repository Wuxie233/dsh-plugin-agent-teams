/**
 * Member subagent lifecycle: spawn a continuable child per member, deliver
 * messages into its FIFO inbox, and observe its activity.
 *
 * Members are durable continuable subagents of the captain, so a member keeps
 * its conversation across turns and across harness restarts: the captain
 * barges in with {@link deliverToMember}, it works through its turn
 * (updating team state through the `agent_teams_*` tools), and becomes idle
 * again. Its final assistant message is not readable programmatically, so the
 * member persists its report into the captain's mailbox and the task records,
 * which the captain reads through `agent_teams_status`.
 * @module dsh-agent-teams/members
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
// Declaration merge only: makes ctx.subagents visible.
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { readTeamSync, resolveTeamWorkspace, writeCaptainPointer } from './state.ts'
import { isReadOnlyRole, READ_ONLY_DENY_TOOLS, readOnlyPersonaRule } from './roles.ts'
import type { TeamMember, TeamState, TeamTask } from './types.ts'

/** Captain-only AgentTeams tools hidden from newly spawned members. */
export const MEMBER_DENIED_TOOLS = [
  'agent_teams_create',
  'agent_teams_add_member',
  'agent_teams_remove_member',
  'agent_teams_create_task',
  'agent_teams_delete',
  'agent_teams_report_issue',
] as const

/**
 * Restore the SessionId brand on a value that round-tripped through the
 * durable team file. The brand is erased by JSON serialization; the value
 * originated from `startContinuable`/`agent.id`, so this cast is the boundary
 * restoration, not a new assertion.
 */
function brandedSessionId(value: string): SessionId {
  return value as SessionId
}

/** Runtime knobs for member spawning, resolved from plugin config. */
export interface MemberRuntimeConfig {
  /** Registered `ctx.subagents` provider name (must support continuable + persona). */
  provider: string
  /** Child delegation depth cap (0 forbids delegation entirely). */
  maxDepth?: number
  /** Role tokens whose members additionally deny write-capable tools. */
  readOnlyRoles?: readonly string[]
}

/**
 * The full tool deny list for one member: captain-only tools for everyone,
 * plus write-capable tools for read-only roles.
 * @param member - the member being spawned (only its role is read).
 * @param config - member runtime knobs carrying the read-only tokens.
 * @returns the deny list for the child's `toolFilter`.
 */
function memberDenyTools(member: TeamMember, config: MemberRuntimeConfig): string[] {
  const deny: string[] = [...MEMBER_DENIED_TOOLS]
  if (isReadOnlyRole(member.role, config.readOnlyRoles ?? [])) {
    deny.push(...READ_ONLY_DENY_TOOLS)
  }
  return deny
}

/** Durable provider/model/reasoning snapshot for one member. */
export interface MemberLlmSelection {
  /** Registered LLM provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, absent when the target has no explicit/default effort. */
  reasoningEffort?: string
}

/** Optional member-level route requested by the captain. */
export interface MemberLlmSelectionRequest {
  /** Explicit LLM provider route; requires an explicit model. */
  provider?: string
  /** Explicit model id; otherwise the plugin default or captain model is used. */
  model?: string
  /** Plugin-level member model default. */
  defaultModel?: string
}

/** Process-local bridge between spawn admission and synchronous child setup. */
export interface MemberSelectionRuntime {
  /** Make one selection visible while Harness materializes the fresh child. */
  withPending<T>(
    parentSessionId: string,
    label: string,
    selection: MemberLlmSelection,
    operation: () => Promise<T>,
  ): Promise<T>
}

const MEMBER_LABEL_PREFIX = 'agent-teams:'

function pendingSelectionKey(parentSessionId: string, label: string): string {
  return `${parentSessionId}\u0000${label}`
}

function selectionFromMember(member: TeamMember | undefined): MemberLlmSelection | undefined {
  if (member?.provider === undefined || member.model === undefined) return undefined
  const provider = member.provider.trim()
  const model = member.model.trim()
  if (provider === '' || model === '') return undefined
  const reasoningEffort = member.reasoningEffort?.trim()
  return {
    provider,
    model,
    ...reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort },
  }
}

function modelSelection(selection: MemberLlmSelection): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
  }
}

/**
 * Resolve one member's complete model selection. Ordinary members snapshot the
 * captain's current request route and reasoning effort. An explicit member
 * provider/model or plugin-level model replaces only that route; the current
 * captain effort remains the inherited policy and is validated against the
 * target model before a child is created.
 */
export async function resolveMemberLlmSelection(
  ctx: Context,
  captain: Agent,
  request: MemberLlmSelectionRequest,
  signal?: AbortSignal,
): Promise<MemberLlmSelection> {
  const explicitProvider = request.provider?.trim()
  const explicitModel = request.model?.trim()
  const defaultModel = request.defaultModel?.trim()
  if (request.provider !== undefined && explicitProvider === '') {
    throw new Error('member LLM provider must not be empty')
  }
  if (request.model !== undefined && explicitModel === '') {
    throw new Error('member model must not be empty')
  }
  if (request.defaultModel !== undefined && defaultModel === '') {
    throw new Error('configured memberModel must not be empty')
  }
  if (explicitProvider !== undefined && explicitModel === undefined) {
    throw new Error('an explicit member LLM provider requires an explicit member model')
  }

  const current = captain.session.requestHeader()?.config
  const provider = explicitProvider ?? current?.provider ?? captain.options.provider
  const model = explicitModel ?? defaultModel ?? current?.model ?? captain.options.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot resolve the member LLM route from the current captain session')
  }

  const resolved = await ctx.llm.resolveCallConfig({
    provider,
    model,
    ...current?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: current.reasoningEffort },
  }, signal)
  return {
    provider: resolved.provider,
    model: resolved.model,
    ...resolved.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(resolved.reasoningEffort) },
  }
}

/**
 * Install the member selection bridge for every fresh or cold-resumed
 * continuable child. Fresh creation reads the pending in-memory selection;
 * cold resume restores the same selection from the owning team's durable
 * record. Legacy members without a complete saved route retain Harness's
 * descriptor provider/model behavior.
 */
export function installMemberSelectionRuntime(ctx: Context, stateDir: string): MemberSelectionRuntime {
  const pending = new Map<string, MemberLlmSelection>()
  ctx.subagents.registerContinuableSetup((childCtx) => {
    const child = childCtx.agent
    if (child === undefined) return () => undefined
    const suffix = child.session.events.slice(child.session.header.seedLength ?? 0)
    const descriptor = foldSubagentDescriptor(suffix)
    if (descriptor?.mode !== 'continuable' || !descriptor.label.startsWith(MEMBER_LABEL_PREFIX)) {
      return () => undefined
    }

    const parentSessionId = child.session.header.parentSession
    if (parentSessionId === undefined) return () => undefined
    const key = pendingSelectionKey(parentSessionId, descriptor.label)
    let selection = pending.get(key)
    if (selection === undefined) {
      const identity = descriptor.label.slice(MEMBER_LABEL_PREFIX.length)
      const separator = identity.indexOf(':')
      if (separator < 1 || separator === identity.length - 1) return () => undefined
      const teamId = identity.slice(0, separator)
      const memberName = identity.slice(separator + 1)
      const workspace = resolveTeamWorkspace(child.session.header.cwd ?? process.cwd(), stateDir)
      const team = readTeamSync(join(workspace, stateDir), teamId)
      if (team?.captainSessionId !== parentSessionId) return () => undefined
      selection = selectionFromMember(team.members.find(member => member.name === memberName))
      // An old team record has no provider/reasoning snapshot. Its durable
      // Harness descriptor still restores provider/model, so leave it alone.
      if (selection === undefined) return () => undefined
      if (descriptor.agentProvider !== selection.provider || descriptor.agentModel !== selection.model) {
        throw new Error(
          `agent-teams: saved model route for member "${memberName}" does not match its subagent descriptor`,
        )
      }
    }

    return installModelSelection(childCtx, {
      current: modelSelection(selection),
      assembled: undefined,
    })
  })

  return {
    async withPending<T>(
      parentSessionId: string,
      label: string,
      selection: MemberLlmSelection,
      operation: () => Promise<T>,
    ): Promise<T> {
      const key = pendingSelectionKey(parentSessionId, label)
      if (pending.has(key)) {
        throw new Error(`member model selection is already pending for "${label}"`)
      }
      pending.set(key, selection)
      try {
        return await operation()
      } finally {
        pending.delete(key)
      }
    },
  }
}

/**
 * The member's system prompt (persona), shadowing the deployment persona for
 * that child. Self-contained: it replaces the whole persona section.
 * @param team - the team the member joined.
 * @param member - the member record (name/role are read before spawning).
 * @param stateDir - configured state directory, so the member can locate the
 *   team files with its own file tools.
 */
export function memberPersona(team: TeamState, member: TeamMember, stateDir: string, readOnlyRoles: readonly string[] = []): string {
  return `You are ${member.name}, a member of the multi-agent team "${team.name}" running inside DeepSeek Harness AgentTeams. The captain leads the team; you are a worker member${member.role ? ` with the role: ${member.role}` : ''}.

Team context:
- Team id: ${team.id}
- Your name inside the team (use it as \`from\`/identity): ${member.name}
- The team state lives under ${stateDir}/${team.id}/ (team.json and inbox/*.jsonl). You may inspect these files read-only for diagnostics, but never edit them directly; use the agent_teams_* tools so JSON escaping and concurrent updates stay safe.
- The captain and your teammates reach you through messages. Each message you receive is a new turn: act on it and end your turn with a concise reply.

Working rules:
1. Call agent_teams_status at the start of every turn. That snapshot is the only source of truth for your tasks. Do not trust this persona or an earlier turn if they disagree with the live status.
2. Your first user message is already the first assigned task. Work that task. Later turns come from agent_teams_send_message. You may complete a claimed task directly (status=completed + output); in_progress is optional.
3. Work thoroughly with your available tools; do not cut corners.
4. When finished, call agent_teams_update_task with status=completed and a concise \`output\` summarizing what you did and the key results.
5. Send a short report to the captain with agent_teams_send_message (to=captain) when you complete a task or hit a blocker.
6. To ask a teammate something, use agent_teams_send_message with to=<teammate name>; the message barges into their current turn. The same applies to the captain (to=captain).
7. You are a worker: do not create or delete teams, and do not add or remove members — that is the captain's job.
8. If agent_teams_status says you do not belong to an active team, stop. Do not keep reporting old blockers.${isReadOnlyRole(member.role, readOnlyRoles) ? `\n${readOnlyPersonaRule()}` : ''}`
}

/**
 * The initial user message delivered when the member is created.
 * This is the first work turn, not a greeting: the runtime requires a
 * prompt at spawn, so the captain supplies the first assigned task here.
 * @param team - the team the member joined.
 * @param task - the claimed first task.
 * @param brief - captain instructions for that task.
 */
export function memberDispatchPrompt(team: TeamState, task: TeamTask, brief: string): string {
  const description = task.description === undefined || task.description === ''
    ? ''
    : `\nDescription: ${task.description}`
  return `You have joined the team "${team.name}" as ${task.assignee ?? 'a member'}.
Your first turn is task ${task.id}: ${task.subject}.${description}

Captain brief:
${brief}

Call agent_teams_status, then do this task. Do not send a ready check-in.`
}

/**
 * Spawn one member as a durable continuable subagent of the captain and fill
 * `member.id` with its child session id. On failure nothing is persisted.
 * @param ctx - the plugin context (injects `subagents`).
 * @param config - member runtime knobs.
 * @param selections - fresh/cold child model-selection bridge.
 * @param llmSelection - resolved provider/model/reasoning snapshot.
 * @param captain - the exact live captain agent (the calling agent).
 * @param team - the team record (read-only here).
 * @param member - the member draft whose `id` is filled on success.
 * @param stateDir - configured state directory (for the persona).
 * @param signal - caller cancellation, forwarded to the start.
 * @param firstTask - the claimed first task that becomes the spawn prompt.
 * @param brief - captain instructions delivered as the first user message.
 * @param worktree - optional absolute git worktree the member is spawned
 *   inside for write isolation; read-only roles refuse it.
 */
export async function spawnMember(
  ctx: Context,
  config: MemberRuntimeConfig,
  selections: MemberSelectionRuntime,
  llmSelection: MemberLlmSelection,
  captain: Agent,
  team: TeamState,
  member: TeamMember,
  stateDir: string,
  signal: AbortSignal,
  firstTask: TeamTask,
  brief: string,
  worktree?: string,
): Promise<void> {
  // Fail loud at the first use: provider registration is a sibling plugin's
  // effect and may settle after this plugin mounts. Capability checks here
  // mirror what startContinuable would reject, with an actionable error.
  const provider = ctx.subagents.getProvider(config.provider)
  if (provider === undefined) {
    throw new Error(
      `agent-teams: no subagent provider "${config.provider}" is registered (available: ${ctx.subagents.list().join(', ') || 'none'}) — `
      + 'check that the subagent provider row (e.g. subagent-spawn) is mounted in the composition',
    )
  }
  if (provider.prepareContinuable === undefined) {
    throw new Error(`agent-teams: provider "${config.provider}" does not support continuable members`)
  }
  if (!provider.capabilities.persona) {
    throw new Error(`agent-teams: provider "${config.provider}" cannot apply a member persona`)
  }
  if (!provider.capabilities.toolFilter) {
    throw new Error(`agent-teams: provider "${config.provider}" cannot restrict captain-only tools for members`)
  }
  // Optional chain: offline verification drives a partial captain fake.
  const captainWorkspace = captain.session.header?.cwd ?? process.cwd()
  if (worktree !== undefined) {
    if (isReadOnlyRole(member.role, config.readOnlyRoles ?? [])) {
      throw new Error(`agent-teams: read-only role "${member.role}" cannot use a worktree; reviewers stay on the captain tree`)
    }
    if (!isAbsolute(worktree)) {
      throw new Error(`agent-teams: member worktree must be an absolute path, got "${worktree}"`)
    }
    if (!existsSync(join(worktree, '.git'))) {
      throw new Error(`agent-teams: member worktree has no .git entry (not a git worktree?): ${worktree}`)
    }
  }
  const label = `${MEMBER_LABEL_PREFIX}${team.id}:${member.name}`
  // Local seam: ContinuableStartSpec.cwd (patched dsh-subagent). rc.6 types
  // lack the field, so the intersection is assigned through the base shape.
  type ContinuableStartInput = Parameters<typeof ctx.subagents.startContinuable>[0]
  const startSpec: ContinuableStartInput & { cwd?: string } = {
    provider: config.provider,
    label,
    request: {
      prompt: [{ type: 'text', text: memberDispatchPrompt(team, firstTask, brief) }],
      parent: captain,
      persona: memberPersona(
        team,
        member,
        worktree !== undefined ? join(captainWorkspace, stateDir) : stateDir,
        config.readOnlyRoles ?? [],
      ),
      toolFilter: { deny: memberDenyTools(member, config) },
      agentOptions: {
        provider: llmSelection.provider,
        model: llmSelection.model,
      },
      ...config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {},
    },
    ...worktree !== undefined ? { cwd: worktree } : {},
    signal,
  }
  const start = await selections.withPending(captain.id, label, llmSelection, () => (
    ctx.subagents.startContinuable(startSpec as ContinuableStartInput)
  ))
  if (worktree !== undefined) {
    // Fail loud when the runtime ignored the cwd override: an unpatched
    // dsh-subagent silently spawns the member on the captain tree, which
    // defeats the requested write isolation.
    const liveChild = ctx.agents.get(start.childId)
    const headerCwd = liveChild?.session.header.cwd
    if (headerCwd !== undefined && headerCwd !== worktree) {
      interruptMember(ctx, captain, start.childId)
      throw new Error(
        `agent-teams: the harness runtime did not apply the member worktree cwd (header says "${headerCwd}") — `
        + 'the deployed dsh-subagent lacks the child-cwd seam; redeploy the patched deployment and restart dsh web',
      )
    }
    await writeCaptainPointer(worktree, stateDir, { captainWorkspace, teamId: team.id })
  }
  member.id = start.childId
  member.worktree = worktree
}

/**
 * Deliver one message by barging into the member's current turn.
 *
 * A running member is interrupted first (`keepInbox`) so the new message
 * starts immediately instead of waiting behind the current turn. Best
 * effort: a failure (member gone or not continuable) is logged and
 * reported as `false` so the caller can decide (mailbox delivery still
 * happened).
 *
 * Any team sender can route through this helper: the captain is the direct
 * parent of every member, and the caller passes the captain's live Agent
 * (its own when the captain calls, the registry-resolved one when a member
 * sends).
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's direct parent).
 * @param childId - the member's durable child session id.
 * @param text - the message content.
 * @param signal - caller cancellation, forwarded to the delivery.
 * @returns whether the member inbox accepted the message.
 */
export async function deliverToMember(
  ctx: Context,
  captain: Agent,
  childId: string,
  text: string,
  signal: AbortSignal,
): Promise<boolean> {
  interruptMember(ctx, captain, childId)
  try {
    await ctx.subagents.followup(captain, brandedSessionId(childId), [{ type: 'text', text }], {
      source: { kind: 'plugin', plugin: 'dsh-agent-teams' },
      signal,
    })
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`agent-teams: followup to member ${childId} failed: ${String(error)}`)
    return false
  }
}

/**
 * Request cancellation of one live member's current turn. Best effort, fire
 * and return; the target may keep running until it observes the signal.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's parent).
 * @param childId - the member's durable child session id.
 */
export function interruptMember(ctx: Context, captain: Agent, childId: string): void {
  try {
    ctx.subagents.interrupt(brandedSessionId(childId), { kind: 'ancestor', agent: captain })
  } catch (error: unknown) {
    ctx.logger.warn(`agent-teams: interrupt of member ${childId} failed: ${String(error)}`)
  }
}

/**
 * Stop a member and drop every queued follow-up so stale team messages
 * cannot keep waking it after teardown.
 * @param ctx - the plugin context (injects `agents`).
 * @param childId - the member's durable child session id.
 */
export function retireMember(ctx: Context, childId: string): void {
  const live = ctx.agents.get(brandedSessionId(childId))
  if (live === undefined) return
  try {
    live.cancel({ kind: 'parent' })
  } catch (error: unknown) {
    ctx.logger.warn(`agent-teams: retire of member ${childId} failed: ${String(error)}`)
  }
}

/**
 * Turn activity for one listed child.
 *
 * `listChildren().activity` is a store snapshot: `running` means the child
 * session is still live in `ctx.sessions`, and `inactive` means it exists
 * only in persistence. A stopped conversation stays loaded, so the panel
 * must not treat that store bit as "the member is working". Only a live
 * Agent whose driver is currently `running` is working; idle, ready, or
 * missing live Agents are inactive.
 * @param ctx - the plugin context (injects `agents`).
 * @param childId - the child's durable session id.
 * @returns `running` while the child is driving a turn, otherwise `inactive`.
 */
export function turnActivityOf(ctx: Context, childId: string): 'running' | 'inactive' {
  return ctx.agents.get(brandedSessionId(childId))?.status === 'running' ? 'running' : 'inactive'
}

/**
 * Snapshot each direct continuable child's turn activity under the captain's
 * session, keyed by child session id. A member that is currently running its
 * turn reports `running`; a loaded-but-stopped or cold member reports
 * `inactive`.
 * @param ctx - the plugin context (injects `subagents` and `agents`).
 * @param captainSessionId - the captain's session id.
 * @param signal - optional abort forwarded to `listChildren`.
 * @returns child id → activity, missing entries are unknown children.
 */
export async function memberActivity(
  ctx: Context,
  captainSessionId: string,
  signal?: AbortSignal,
): Promise<Map<string, 'running' | 'inactive'>> {
  const entries = await ctx.subagents.listChildren(brandedSessionId(captainSessionId), signal)
  const activity = new Map<string, 'running' | 'inactive'>()
  for (const entry of entries) {
    if (entry.kind === 'child') activity.set(entry.id, turnActivityOf(ctx, entry.id))
  }
  return activity
}
