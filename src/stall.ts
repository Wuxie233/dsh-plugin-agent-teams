/**
 * Stall detection for interrupted members that still own claimed work.
 *
 * An idle member with open tasks and an empty inbox is indistinguishable from
 * "still working" unless the captain polls. This module decides when that
 * idle transition should wake the captain.
 * @module dsh-agent-teams/stall
 */

/** One session event, reduced to the fields stall detection reads. */
export interface StallSessionEvent {
  readonly type: string
  readonly data?: unknown
}

/** Inputs for one stall verdict. */
export interface StallCheck {
  /** Durable member lifecycle (`removed` members are ignored). */
  readonly memberStatus: string
  /** Live driver status. */
  readonly activity: string
  /** Latest `turn/end` reason kind, when the session recorded one. */
  readonly lastTurnEndKind: string | undefined
  /** Claimed or in_progress task ids assigned to this member. */
  readonly openTaskIds: readonly string[]
  /** Whether the live inbox still has unclaimed follow-ups. */
  readonly pendingInbox: boolean
  /** Latest captain-inbox stall notice for this member, if any. */
  readonly lastStallNotice?: string
}

/** Kind of `turn/end` that left work unfinished rather than completing it. */
const UNCLEAN_TURN_ENDS = new Set(['interrupted', 'aborted'])

/**
 * Latest `turn/end` reason kind in a session log, walking newest-first.
 * @param events - session events in append order.
 * @returns the reason kind, or undefined when no turn has ended.
 */
export function lastTurnEndKind(events: readonly StallSessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/end') continue
    const data = event.data
    if (typeof data !== 'object' || data === null || !('reason' in data)) return undefined
    const reason = (data as { reason?: unknown }).reason
    if (typeof reason !== 'object' || reason === null || !('kind' in reason)) return undefined
    const kind = (reason as { kind?: unknown }).kind
    return typeof kind === 'string' ? kind : undefined
  }
  return undefined
}

/**
 * Whether an idle member should wake the captain as stalled.
 * @param check - live member, task, and inbox facts.
 * @returns notify plus a short reason token for tests and logs.
 */
export function shouldNotifyMemberStall(check: StallCheck): { notify: boolean; reason: string } {
  if (check.memberStatus === 'removed') return { notify: false, reason: 'removed' }
  if (check.activity === 'running') return { notify: false, reason: 'running' }
  if (check.pendingInbox) return { notify: false, reason: 'pending-inbox' }
  if (check.openTaskIds.length === 0) return { notify: false, reason: 'no-open-tasks' }
  if (check.lastTurnEndKind === undefined || !UNCLEAN_TURN_ENDS.has(check.lastTurnEndKind)) {
    return { notify: false, reason: 'clean-end' }
  }
  if (check.lastStallNotice !== undefined) return { notify: false, reason: 'already-notified' }
  return { notify: true, reason: 'interrupted-open-work' }
}

/**
 * Latest stall notice for one member in the captain inbox, walking newest-first.
 * @param messages - captain mailbox, oldest first.
 * @param memberName - the stalled member's team name.
 * @param openTaskIds - claimed or in_progress ids still assigned to it.
 * @returns that notice's content when the newest matching stall is still current.
 */
export function lastMatchingStallNotice(
  messages: readonly { from: string; content: string }[],
  memberName: string,
  openTaskIds: readonly string[],
): string | undefined {
  const expected = stallCaptainMessage(memberName, openTaskIds)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.from !== memberName) continue
    if (message.content === expected) return message.content
    if (message.content.includes(`Plugin stall notice (not a member report): ${memberName}`)) return undefined
  }
  return undefined
}

/**
 * Captain-facing stall report. Tasks stay claimed so the same work can resume.
 * @param memberName - the stalled member's team name.
 * @param openTaskIds - claimed or in_progress ids still assigned to it.
 * @returns mailbox / follow-up text.
 */
export function stallCaptainMessage(memberName: string, openTaskIds: readonly string[]): string {
  return `Plugin stall notice (not a member report): ${memberName} is idle after an interrupted turn and still owns ${openTaskIds.join(', ')}. No pending inbox. Do not send a blank continue reminder. After you know the progress, barge a new instruction, a plan change, or a reassignment.`
}
