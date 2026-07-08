import { Loader2, FileText, FolderTree, Share2, Heart, Clock, CalendarDays, HardDrive } from 'lucide-react'
import type { UserMetrics, UserStorage } from '@/api/users'
import { formatBytes } from '@/utils/format'

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  // Timestamps are UTC; toLocaleString renders in the viewer's local timezone.
  return new Date(dateStr).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
        <span className="text-gray-400 dark:text-gray-500">{icon}</span>
        {label}
      </div>
      <div className="mt-0.5 text-sm font-medium text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  )
}

interface Props {
  metrics: UserMetrics | null
  loading: boolean
  storage: UserStorage | null
  storageLoading: boolean
  onCalculateStorage: () => void
}

// Presentational grid of a single account's metrics, shared by the admin
// UserManager (per-user) and the self-serve Stats settings tab.
export default function UserMetricsPanel({ metrics, loading, storage, storageLoading, onCalculateStorage }: Props) {
  if (loading && !metrics) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading metrics…
      </div>
    )
  }
  if (!metrics) {
    return <p className="text-sm text-gray-400">Could not load metrics.</p>
  }

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Metric icon={<FileText className="w-3.5 h-3.5" />} label="Notes" value={metrics.note_count.toLocaleString()} />
        <Metric icon={<FolderTree className="w-3.5 h-3.5" />} label="Folders" value={metrics.folder_count.toLocaleString()} />
        <Metric icon={<Share2 className="w-3.5 h-3.5" />} label="Shared" value={metrics.shared_note_count.toLocaleString()} />
        <Metric icon={<Heart className="w-3.5 h-3.5" />} label="Total likes" value={metrics.total_likes.toLocaleString()} />
        <Metric icon={<Clock className="w-3.5 h-3.5" />} label="Last login" value={formatDateTime(metrics.last_login)} />
        <Metric icon={<CalendarDays className="w-3.5 h-3.5" />} label="Member since" value={formatDateTime(metrics.created_at)} />
      </div>

      <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700 flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <HardDrive className="w-3.5 h-3.5 text-gray-400" /> Folder size
        </div>
        {storage ? (
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {formatBytes(storage.total_bytes)}
            <span className="ml-1 text-xs font-normal text-gray-400">
              · {storage.file_count.toLocaleString()} file{storage.file_count === 1 ? '' : 's'}
            </span>
          </span>
        ) : (
          <button className="btn-ghost text-xs px-2 py-1" disabled={storageLoading} onClick={onCalculateStorage}>
            {storageLoading ? 'Calculating…' : 'Calculate'}
          </button>
        )}
      </div>
    </>
  )
}
