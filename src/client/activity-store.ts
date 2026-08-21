/**
 * Shared AgentTeams activity snapshot.
 *
 * The activity panel is the single poller of `/plugins/dsh-agent-teams/state`.
 * Conversation cards subscribe here instead of fetching the route themselves.
 * @module dsh-agent-teams/client/activity-store
 */

/** Member fields a conversation card may copy from the live snapshot. */
export interface SharedActivityMember {
  readonly id: string
  readonly name: string
  readonly role: string
}

/** Team fields cards use to enrich the folded roster. */
export interface SharedActivityTeam {
  readonly teamId: string
  readonly name: string
  readonly captainSessionId: string
  readonly members: readonly SharedActivityMember[]
}

/** Live and archived team lists published by the activity panel. */
export interface ActivitySnapshot {
  readonly teams: readonly SharedActivityTeam[]
  readonly archived: readonly SharedActivityTeam[]
}

const EMPTY: ActivitySnapshot = { teams: [], archived: [] }
const listeners = new Set<() => void>()
let snapshot: ActivitySnapshot = EMPTY

function publish(next: ActivitySnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

/** Current live+archived snapshot. Stable until the panel publishes a new list. */
export function getActivitySnapshot(): ActivitySnapshot {
  return snapshot
}

/**
 * Subscribe to snapshot publication.
 * @param listener - called after live or archived lists change.
 * @returns disposer.
 */
export function subscribeActivitySnapshot(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Replace the live team list. */
export function setActivityLiveTeams(teams: readonly SharedActivityTeam[]): void {
  if (snapshot.teams === teams) return
  publish({ teams, archived: snapshot.archived })
}

/** Replace the archived team list. */
export function setActivityArchivedTeams(teams: readonly SharedActivityTeam[]): void {
  if (snapshot.archived === teams) return
  publish({ teams: snapshot.teams, archived: teams })
}

/** Drop both lists (panel unmount / HMR). */
export function resetActivitySnapshot(): void {
  if (snapshot.teams.length === 0 && snapshot.archived.length === 0) return
  publish(EMPTY)
}

/**
 * Find one team in the live list, then the archived list.
 * @param teamId - durable team id.
 * @param owner - captain session id; empty matches any captain.
 */
export function findActivityTeam(teamId: string, owner: string): SharedActivityTeam | undefined {
  const match = (team: SharedActivityTeam): boolean =>
    team.teamId === teamId && (owner === '' || team.captainSessionId === owner)
  return snapshot.teams.find(match) ?? snapshot.archived.find(match)
}
