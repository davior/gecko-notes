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
