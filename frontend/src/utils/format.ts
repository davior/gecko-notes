/**
 * Extract a human-readable message from an API error response, falling back to
 * a caller-supplied default when the shape doesn't match our backend's
 * `{"detail": {"code", "message"}}` (or plain string `detail`) convention.
 * Used so error toasts show the real upstream failure (e.g. a specific fal.ai
 * error) instead of a generic message that doesn't match the actual cause.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (detail && typeof detail === 'object' && 'message' in detail) {
    const msg = (detail as { message?: unknown }).message
    if (typeof msg === 'string' && msg.trim()) return msg
  }
  return fallback
}

/**
 * Human-readable byte size, e.g. 0 B, 1.4 KB, 23.9 MB, 2.1 GB.
 * Used by the note stats modal and the admin user-storage readout.
 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, exp)
  // Whole bytes read cleaner without a decimal; larger units keep one.
  const formatted = exp === 0 ? String(value) : value.toFixed(1)
  return `${formatted} ${units[exp]}`
}

/**
 * Compact relative age, e.g. "just now", "4m ago", "2h ago", "3d ago".
 *
 * Compact rather than Intl.RelativeTimeFormat's "4 minutes ago" because the caller is
 * the 320px-wide Background tasks dropdown, where this shares a line with a truncated
 * status label and a progress percentage. Past a week an age stops being informative
 * and a short date reads better.
 *
 * Elapsed time is floored, not rounded: 90 seconds is "1m ago", not "2m ago". Anything
 * under a minute — including a timestamp slightly in the future, which clock skew
 * between the server and the browser can produce — is "just now" rather than "0m ago".
 *
 * Returns '' for a missing or unparseable timestamp so callers can skip the element
 * instead of rendering "NaNm ago".
 */
export function formatTimeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''

  const seconds = Math.floor((now - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
