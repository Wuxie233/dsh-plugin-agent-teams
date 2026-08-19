/**
 * Durable `tool/result.meta` for the in-conversation team card.
 *
 * The card folds first-party tool events. These records carry the team id and
 * roster so add/remove updates join the create Context after replay, without
 * waiting on the live snapshot route.
 * @module dsh-agent-teams/card-meta
 */

/** One roster row the conversation card can render. */
export interface AgentTeamsCardMember {
  readonly id: string
  readonly name: string
  readonly role: string
}

/** Create result: empty roster plus the captain session the panel follows. */
export interface AgentTeamsCreateMeta {
  readonly kind: 'create'
  readonly teamId: string
  readonly teamName: string
  readonly captainSessionId: string
  readonly members: readonly AgentTeamsCardMember[]
}

/** Successful add_member result. */
export interface AgentTeamsAddMemberMeta {
  readonly kind: 'add-member'
  readonly teamId: string
  readonly member: AgentTeamsCardMember
}

/** Successful remove_member result. */
export interface AgentTeamsRemoveMemberMeta {
  readonly kind: 'remove-member'
  readonly teamId: string
  readonly name: string
}

/** Presentation metadata persisted on AgentTeams tool results. */
export type AgentTeamsToolMeta =
  | AgentTeamsCreateMeta
  | AgentTeamsAddMemberMeta
  | AgentTeamsRemoveMemberMeta

/** Narrow a persisted tool/result meta payload to a card update. */
export function parseAgentTeamsToolMeta(value: unknown): AgentTeamsToolMeta | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('teamId' in value)) {
    return undefined
  }
  const teamId = value.teamId
  if (typeof teamId !== 'string' || teamId === '') return undefined
  if (value.kind === 'create') {
    if (!('teamName' in value) || typeof value.teamName !== 'string') return undefined
    if (!('captainSessionId' in value) || typeof value.captainSessionId !== 'string') return undefined
    const members = 'members' in value ? parseMembers(value.members) : []
    if (members === undefined) return undefined
    return {
      kind: 'create',
      teamId,
      teamName: value.teamName,
      captainSessionId: value.captainSessionId,
      members,
    }
  }
  if (value.kind === 'add-member') {
    if (!('member' in value)) return undefined
    const member = parseMember(value.member)
    if (member === undefined) return undefined
    return { kind: 'add-member', teamId, member }
  }
  if (value.kind === 'remove-member') {
    if (!('name' in value) || typeof value.name !== 'string' || value.name === '') return undefined
    return { kind: 'remove-member', teamId, name: value.name }
  }
  return undefined
}

function parseMembers(value: unknown): AgentTeamsCardMember[] | undefined {
  if (!Array.isArray(value)) return undefined
  const members: AgentTeamsCardMember[] = []
  for (const entry of value) {
    const member = parseMember(entry)
    if (member === undefined) return undefined
    members.push(member)
  }
  return members
}

function parseMember(value: unknown): AgentTeamsCardMember | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('id' in value) || typeof value.id !== 'string') return undefined
  if (!('name' in value) || typeof value.name !== 'string' || value.name === '') return undefined
  const role = 'role' in value && typeof value.role === 'string' ? value.role : ''
  return { id: value.id, name: value.name, role }
}
