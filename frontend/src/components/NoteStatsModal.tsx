import { useEffect, useState } from 'react'
import { X, Loader2, Type, AlignLeft, Clock, HardDrive, History, Heart, Eye, BarChart3 } from 'lucide-react'
import { notesApi, type NoteMetrics } from '@/api/notes'
import { formatBytes } from '@/utils/format'

interface Props {
  noteId: string
  onClose: () => void
}

interface StatRowProps {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  hint?: string
  muted?: boolean
}

function StatRow({ icon, label, value, hint, muted }: StatRowProps) {
  return (
    <div className={`flex items-center justify-between gap-3 py-2 ${muted ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
        <span className="text-gray-400 dark:text-gray-500">{icon}</span>
        {label}
      </div>
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 text-right">
        {value}
        {hint && <span className="ml-1 text-xs font-normal text-gray-400 dark:text-gray-500">{hint}</span>}
      </div>
    </div>
  )
}

// Fetches and displays on-demand stats for the current note. Opened from the
// editor status bar's info button; the caller saves any pending edits first so
// the numbers reflect the latest content.
export default function NoteStatsModal({ noteId, onClose }: Props) {
  const [metrics, setMetrics] = useState<NoteMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    notesApi.getMetrics(noteId)
      .then((res) => { if (!cancelled) setMetrics(res.data) })
      .catch(() => { if (!cancelled) setError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [noteId])

  return (
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="card p-6 w-full max-w-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <BarChart3 className="w-4 h-4" /> Note Statistics
          </h3>
          <button className="btn-ghost p-1.5" title="Close" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : error || !metrics ? (
          <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
            Could not load note statistics.
          </p>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            <StatRow icon={<Type className="w-4 h-4" />} label="Words" value={metrics.word_count.toLocaleString()} />
            <StatRow icon={<AlignLeft className="w-4 h-4" />} label="Characters" value={metrics.character_count.toLocaleString()} />
            <StatRow
              icon={<Clock className="w-4 h-4" />}
              label="Reading time"
              value={metrics.reading_time_minutes < 1 ? '<1' : metrics.reading_time_minutes}
              hint={metrics.reading_time_minutes === 1 ? 'min' : 'mins'}
            />
            <StatRow
              icon={<HardDrive className="w-4 h-4" />}
              label="Total size"
              value={formatBytes(metrics.total_bytes)}
              hint={metrics.resource_count > 0
                ? `text ${formatBytes(metrics.content_bytes)} + ${metrics.resource_count} file${metrics.resource_count === 1 ? '' : 's'} ${formatBytes(metrics.resource_bytes)}`
                : undefined}
            />
            <StatRow icon={<History className="w-4 h-4" />} label="Saved versions" value={metrics.version_count.toLocaleString()} />
            <StatRow icon={<Heart className="w-4 h-4" />} label="Likes" value={metrics.like_count.toLocaleString()} />
            {metrics.is_shared && (
              <StatRow
                icon={<Eye className="w-4 h-4" />}
                label="Views"
                value={metrics.views_available && metrics.views != null ? metrics.views.toLocaleString() : 'N/A'}
                hint={metrics.views_available ? undefined : 'analytics not configured'}
                muted={!metrics.views_available}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
