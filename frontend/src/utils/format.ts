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
