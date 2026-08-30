/**
 * Detect a second owner of the same webServer (kind, path).
 * Host + Team-preset dual-mount must skip, not throw.
 */

/** True when `webServer.register` rejected a duplicate (kind, path). */
export function isDuplicateRouteError(error: unknown): boolean {
  return error instanceof Error && /duplicate (?:exact|prefix) route/i.test(error.message)
}
