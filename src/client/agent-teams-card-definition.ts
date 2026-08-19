/**
 * AgentTeams conversation card: a lightweight in-conversation summary shown
 * when a team is created — the captain's name, the member roster with whale
 * avatars, and an entry point that re-activates the top-right activity
 * panel (useful after the floater was closed, or when re-opening an old
 * session for review).
 *
 * The fold anchors to first-party `tool/call` + `tool/result` records for
 * create, add_member, and remove_member. Create opens the Context; later
 * member tools update the same team id through `tool/result.meta`. Those
 * events survive restarts without writing an out-of-repo event type.
 * @module dsh-agent-teams/client/card
 */

import type {
  ChatConversationViewNode, ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
// Module-loading imports: the declaration merges below extend modules that
// must be present in the program — a type-only import both loads them and is
// erased from the bundle.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-session/types'
import {
  parseAgentTeamsToolMeta,
  type AgentTeamsCardMember,
} from '../card-meta.ts'

/** Final keyed Chat payload for the team summary card. */
export interface AgentTeamsCardData {
  readonly teamId: string
  /** The captain session that owns this team (panel follows it). */
  readonly captainSessionId: string
  readonly teamName: string
  readonly members: readonly AgentTeamsCardMember[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Lightweight team summary card anchoring the conversation. */
    'agent-teams': AgentTeamsCardData
  }
}

/** Folded team record (the node's business state). */
export interface AgentTeamsNodeState {
  readonly teamId: string
  readonly name: string
  readonly captainSessionId: string
  readonly members: readonly AgentTeamsCardMember[]
  readonly accepted: boolean
}

/** Fold a team display name the same way the host does for typical ids. */
export function foldTeamId(name: string): string {
  const cleaned = name.normalize('NFC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'team' : cleaned
}

/** Parse the only create-call fields the historic card owns. */
export function parseAgentTeamsCreateArgs(value: string): { teamId: string; name: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || !('name' in parsed) || typeof parsed.name !== 'string') {
      return undefined
    }
    const name = parsed.name.trim()
    if (name === '') return undefined
    return { teamId: foldTeamId(name), name }
  } catch {
    return undefined
  }
}

/** Read the durable team id from a create tool result (meta first, then render text). */
export function parseCreateResultTeamId(event: {
  readonly data: {
    readonly meta?: unknown
    readonly message: { readonly content: readonly unknown[] }
  }
}): string | undefined {
  const meta = parseAgentTeamsToolMeta(event.data.meta)
  if (meta?.kind === 'create') return meta.teamId
  const text = resultText(event.data.message.content)
  return /created \(id ([^)]+)\)/.exec(text)?.[1]
}

function resultText(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null || !('type' in block)) continue
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (block.type !== 'tool-result' || !('content' in block) || !Array.isArray(block.content)) continue
    for (const inner of block.content) {
      if (typeof inner === 'object' && inner !== null && 'type' in inner
        && inner.type === 'text' && 'text' in inner && typeof inner.text === 'string') {
        parts.push(inner.text)
      }
    }
  }
  return parts.join('\n')
}

function applyMemberMeta(
  state: AgentTeamsNodeState,
  meta: ReturnType<typeof parseAgentTeamsToolMeta>,
): AgentTeamsNodeState {
  if (meta === undefined || meta.teamId !== state.teamId) return state
  if (meta.kind === 'create') {
    return {
      ...state,
      name: meta.teamName,
      captainSessionId: meta.captainSessionId,
      members: meta.members,
      accepted: true,
    }
  }
  if (meta.kind === 'add-member') {
    const without = state.members.filter((member) => member.name !== meta.member.name)
    return { ...state, accepted: true, members: [...without, meta.member] }
  }
  return {
    ...state,
    accepted: true,
    members: state.members.filter((member) => member.name !== meta.name),
  }
}

function toolResultFailed(event: {
  readonly data: {
    readonly error?: unknown
    readonly message: { readonly content: readonly { readonly type: string; readonly isError?: boolean }[] }
  }
}): boolean {
  return event.data.error !== undefined
    || event.data.message.content.some((block) => block.type === 'tool-result' && block.isError === true)
}

/** Durable first-party tool events folded into one keyed Chat node. */
export const agentTeamsCardDefinition: ConversationNodeDefinition<AgentTeamsNodeState> = {
  kind: 'agent-teams',
  target: 'chat',
  match: (event) => {
    if (event.type === 'tool/call' && event.data.name === 'agent_teams_create') {
      const parsed = parseAgentTeamsCreateArgs(event.data.arguments)
      return parsed === undefined ? null : { id: parsed.teamId, role: 'start' }
    }
    if (event.type !== 'tool/result' || event.data.message.source.kind !== 'tool') return null
    const meta = parseAgentTeamsToolMeta(event.data.meta)
    if (meta !== undefined) return { id: meta.teamId, role: 'update' }
    const createdId = parseCreateResultTeamId(event)
    return createdId === undefined ? null : { id: createdId, role: 'update' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'tool/call') {
      throw new Error('agent-teams card start requires agent_teams_create tool/call')
    }
    const parsed = parseAgentTeamsCreateArgs(match.event.data.arguments)
    if (parsed === undefined) throw new Error('agent-teams card start requires valid create arguments')
    return { ...parsed, captainSessionId: '', members: [], accepted: false }
  },
  update: (context, match) => {
    if (match.event.type !== 'tool/result') return context.state
    if (toolResultFailed(match.event)) return context.state
    const meta = parseAgentTeamsToolMeta(match.event.data.meta)
    if (meta !== undefined) return applyMemberMeta(context.state, meta)
    return { ...context.state, accepted: true }
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    const state = context.state as AgentTeamsNodeState
    if (!state.accepted) return null
    return {
      key: context.key,
      kind: 'agent-teams',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: {
        teamId: state.teamId,
        captainSessionId: state.captainSessionId,
        teamName: state.name,
        members: state.members,
      },
    }
  },
}
