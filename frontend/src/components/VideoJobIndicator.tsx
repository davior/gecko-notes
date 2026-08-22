import { useEffect } from 'react'
import { Clapperboard, Download, X, Check, AlertCircle, Captions } from 'lucide-react'
import { useVideoJobsStore } from '@/stores/videoJobs'
import type { VideoRenderJob } from '@/api/videoGen'
import { formatBytes } from '@/utils/format'

interface Props {
  /** Offered on a finished render so the note it came from can embed it. */
  onInsert?: (job: VideoRenderJob) => void
}

function label(job: VideoRenderJob): string {
  if (job.status === 'queued') return 'Queued'
  if (job.status === 'error') return 'Render failed'
  if (job.status === 'cancelled') return 'Cancelled'
  if (job.status === 'done') return 'Video ready'
  return job.stage || 'Rendering'
}

/**
 * Live render status, mounted in both the editor and the list headers so a
 * render the user walked away from is still visible. State lives in the store,
 * not here, so switching views never interrupts a render.
 */
export default function VideoJobIndicator({ onInsert }: Props) {
  const jobs = useVideoJobsStore((s) => s.jobs)
  const cancel = useVideoJobsStore((s) => s.cancel)
  const dismiss = useVideoJobsStore((s) => s.dismiss)
  const resume = useVideoJobsStore((s) => s.resume)

  useEffect(() => { void resume() }, [resume])

  const list = Object.values(jobs)
  if (list.length === 0) return null

  return (
    <div className="flex items-center gap-2">
      {list.map((job) => {
        const running = job.status === 'queued' || job.status === 'processing'
        const failed = job.status === 'error'
        return (
          <div
            key={job.id}
            className={`flex items-center gap-2 pl-2 pr-1 py-1 rounded-lg border text-xs ${
              failed
                ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950'
                : 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800'
            }`}
            title={job.detail || job.error_message || job.note_title}
          >
            {failed ? (
              <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
            ) : job.status === 'done' ? (
              <Check className="w-3.5 h-3.5 text-green-600 shrink-0" />
            ) : (
              <Clapperboard className="w-3.5 h-3.5 text-pink-500 shrink-0 animate-pulse" />
            )}

            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-gray-700 dark:text-gray-200 truncate max-w-[10rem]">
                  {label(job)}
                </span>
                {running && <span className="text-gray-400 tabular-nums">{job.progress}%</span>}
              </div>
              {running && (
                <div className="mt-1 h-1 w-32 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                  <div
                    className="h-full bg-pink-500 transition-[width] duration-500"
                    style={{ width: `${Math.max(2, job.progress)}%` }}
                  />
                </div>
              )}
              {job.status === 'done' && (
                <div className="text-gray-400 tabular-nums">
                  {job.duration_seconds ? `${Math.round(job.duration_seconds)}s` : ''}
                  {job.size_bytes ? ` · ${formatBytes(job.size_bytes)}` : ''}
                </div>
              )}
              {failed && (
                <div className="text-red-500 truncate max-w-[12rem]">{job.error_message}</div>
              )}
            </div>

            {job.status === 'done' && job.result_url && (
              <>
                <a
                  className="btn-ghost p-1"
                  href={job.result_url}
                  download={`${job.note_title || 'video'}.mp4`}
                  title="Download the MP4"
                >
                  <Download className="w-3.5 h-3.5" />
                </a>
                {job.subtitle_url && (
                  <a
                    className="btn-ghost p-1"
                    href={job.subtitle_url}
                    download={`${job.note_title || 'video'}.srt`}
                    title="Download the subtitles"
                  >
                    <Captions className="w-3.5 h-3.5" />
                  </a>
                )}
                {onInsert && (
                  <button className="btn-ghost px-1.5 py-1" onClick={() => onInsert(job)} title="Insert into this note">
                    Insert
                  </button>
                )}
              </>
            )}

            <button
              className="btn-ghost p-1"
              onClick={() => (running ? void cancel(job.id) : dismiss(job.id))}
              title={running ? 'Cancel this render' : 'Dismiss'}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
