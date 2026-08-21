/**
 * Read-only role routing: map member role names to a hard write-tool deny
 * list applied on spawn, mirroring the opencode-ensemble scout/reviewer
 * isolation habit. A read-only member can read and search the workspace and
 * message the team, but file mutation and shell execution are denied at the
 * tool-filter level (not by prompt convention alone).
 * @module dsh-agent-teams/roles
 */

/** Write-capable tools denied for read-only members, on top of the captain-only tools. */
export const READ_ONLY_DENY_TOOLS: readonly string[] = ['write', 'edit', 'bash']

/** Default role tokens treated as read-only. Matched case-insensitively by substring. */
export const DEFAULT_READ_ONLY_ROLES: readonly string[] = [
  'scout',
  'reviewer',
  'planner',
  'diagnostician',
]

/**
 * Whether one member role matches a configured read-only role token.
 * @param role - the member's free-form role string.
 * @param readOnlyRoles - configured read-only tokens.
 * @returns true when the role names a read-only token.
 */
export function isReadOnlyRole(role: string | undefined, readOnlyRoles: readonly string[]): boolean {
  if (role === undefined) return false
  const candidate = role.trim().toLowerCase()
  if (candidate === '') return false
  return readOnlyRoles.some((token) => {
    const t = token.trim().toLowerCase()
    return t !== '' && (candidate === t || candidate.includes(t))
  })
}

/**
 * The persona suffix a read-only member receives, so the model knows the
 * denial is intentional before it attempts a denied tool call.
 * @returns the read-only working-rule sentence.
 */
export function readOnlyPersonaRule(): string {
  return 'You are a READ-ONLY member: file writes, edits, and shell commands are denied by policy. Report findings, evidence, and recommendations through task output and messages instead of modifying anything.'
}
