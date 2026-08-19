/**
 * Bounded waits for snapshot assembly. A hung listChildren or mailbox read
 * must not stall the activity HTTP route.
 * @module dsh-agent-teams/timeout
 */

/** Bound for one captain's live activity listing. */
export const ACTIVITY_LIST_TIMEOUT_MS = 1500
/** Bound for the whole snapshot HTTP handler. */
export const SNAPSHOT_ROUTE_TIMEOUT_MS = 4000

/**
 * Reject when `work` does not settle before `ms`.
 * @param work - the awaited operation.
 * @param ms - timeout in milliseconds.
 * @param message - rejection message.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(message)) }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
