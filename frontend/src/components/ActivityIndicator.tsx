import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle, Captions, Check, Clapperboard, Download, Image as ImageIcon,
  Link2, Loader2, Sparkles, X,
} from 'lucide-react'
import { useActivityStore, jobKey } from '@/stores/activity'
import { isActive, type ActivityJob, type ActivityKind } from '@/api/activity'
import { useDropdown } from '@/hooks/useDropdown'
import { formatBytes } from '@/utils/format'

interface Props {
  /** Offered on a finished render so the open note can embed it. */
  onInsert?: (job: ActivityJob) => void
}

const KIND_ICON: Record<ActivityKind, typeof Clapperboard> = {
  video: Clapperboard,
  assistant: Sparkles,
  transcription: Captions,
  image: ImageIcon,
  import: Link2,
}

const KIND_NOUN: Record<ActivityKind, string> = {
  video: 'Video',
  assistant: 'Assistant',
  transcription: 'Transcript',
  image: 'Image',
  import: 'Import',
}

function label(job: ActivityJob): string {
  if (job.status === 'queued') return 'Queued'
  if (job.status === 'error') return `${KIND_NOUN[job.kind]} failed`
  if (job.status === 'cancelled') return 'Cancelled'
  if (job.status === 'done') return `${KIND_NOUN[job.kind]} ready`
  return job.stage || 'Working'
}

/**
 * Everything the app is currently working on, behind one spinner in the header.
 *
 * Mounted in both the editor and the list headers — there is no shared layout
 * component — so work the user walked away from stays visible wherever they go.
 * State lives in the store, not here, so switching views never interrupts a job.
 */
export default function ActivityIndicator({ onInsert }: Props) {
  const jobs = useActivityStore((s) => s.jobs)
  const cancel = useActivityStore((s) => s.cancel)
  const dismiss = useActivityStore((s) => s.dismiss)
  const resume = useActivityStore((s) => s.resume)
  const navigate = useNavigate()
  const { open, setOpen, triggerRef, dropdownRef, style } = useDropdown('right')

  useEffect(() => { void resume() }, [resume])

  const list = Object.values(jobs)
  if (list.length === 0) return null

  const running = list.filter(isActive)
  const failed = list.filter((job) => job.status === 'error')
  const summary =
    running.length > 0
      ? `${running.length} running`
      : failed.length > 0
        ? `${failed.length} failed`
        : `${list.length} finished`

  return (
    <div ref={triggerRef} className="relative no-print">
      <button
        className="btn-ghost flex items-center gap-1.5 px-2 py-1.5 text-xs"
        onClick={() => setOpen(!open)}
        title={`Background tasks — ${summary}`}
        aria-label={`Background tasks, ${summary}`}
      >
        {running.length > 0 ? (
          <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
        ) : failed.length > 0 ? (
          <AlertCircle className="w-4 h-4 text-red-500" />
        ) : (
          <Check className="w-4 h-4 text-green-600" />
        )}
        <span className="tabular-nums font-medium text-gray-600 dark:text-gray-300">
          {running.length > 0 ? `${running[0].progress}%` : list.length}
        </span>
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="z-50 w-80 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-lg overflow-hidden"
          style={style}
        >
          <div className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
            Background tasks
          </div>
          <div className="max-h-96 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
            {list.map((job) => {
              const key = jobKey(job)
              const active = isActive(job)
              const Icon = KIND_ICON[job.kind] ?? Sparkles
              const subtitleUrl = job.meta?.subtitle_url as string | undefined
              const sizeBytes = job.meta?.size_bytes as number | undefined
              const duration = job.meta?.duration_seconds as number | undefined

              return (
                <div key={key} className="px-3 py-2.5 flex items-start gap-2.5">
                  <Icon
                    className={`w-4 h-4 mt-0.5 shrink-0 ${
                      job.status === 'error'
                        ? 'text-red-500'
                        : job.status === 'done'
                          ? 'text-green-600'
                          : 'text-blue-500'
                    } ${active ? 'animate-pulse' : ''}`}
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-200 truncate">
                        {label(job)}
                      </span>
                      {active && (
                        <span className="text-xs text-gray-400 tabular-nums shrink-0">
                          {job.progress}%
                        </span>
                      )}
                    </div>

                    {/* The note is the thing the user is actually looking for. */}
                    {job.note_id ? (
                      <button
                        className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate max-w-full block text-left"
                        onClick={() => { setOpen(false); navigate(`/notes/${job.note_id}`) }}
                        title={`Open “${job.title}”`}
                      >
                        {job.title}
                      </button>
                    ) : (
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {job.title}
                      </div>
                    )}

                    {active && (
                      <div className="mt-1.5 h-1 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                        <div
                          className="h-full bg-blue-500 transition-[width] duration-500"
                          style={{ width: `${Math.max(2, job.progress)}%` }}
                        />
                      </div>
                    )}

                    {active && job.detail && (
                      <div className="mt-1 text-xs text-gray-400 truncate">{job.detail}</div>
                    )}

                    {job.status === 'done' && (duration || sizeBytes) && (
                      <div className="text-xs text-gray-400 tabular-nums">
                        {duration ? `${Math.round(duration)}s` : ''}
                        {sizeBytes ? ` · ${formatBytes(sizeBytes)}` : ''}
                      </div>
                    )}

                    {job.status === 'error' && job.error_message && (
                      <div className="text-xs text-red-500 break-words">{job.error_message}</div>
                    )}

                    {job.status === 'done' && job.result_url && (
                      <div className="mt-1 flex items-center gap-1">
                        <a
                          className="btn-ghost px-1.5 py-0.5 text-xs flex items-center gap-1"
                          href={job.result_url}
                          download
                          title="Download"
                        >
                          <Download className="w-3 h-3" /> Download
                        </a>
                        {subtitleUrl && (
                          <a
                            className="btn-ghost px-1.5 py-0.5 text-xs"
                            href={subtitleUrl}
                            download
                            title="Download the subtitles"
                          >
                            .srt
                          </a>
                        )}
                        {onInsert && job.kind === 'video' && (
                          <button
                            className="btn-ghost px-1.5 py-0.5 text-xs"
                            onClick={() => onInsert(job)}
                            title="Insert into this note"
                          >
                            Insert
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  <button
                    className="btn-ghost p-1 shrink-0"
                    onClick={() => (active ? void cancel(job) : dismiss(key))}
                    title={active ? 'Stop this task' : 'Dismiss'}
                    aria-label={active ? 'Stop this task' : 'Dismiss'}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
