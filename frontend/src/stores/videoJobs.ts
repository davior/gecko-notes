import { create } from 'zustand'
import { videoGenApi, type RenderOptions, type VideoRenderJob } from '@/api/videoGen'

// Renders take minutes, so the job is polled rather than awaited. Polling (over
// SSE) is what lets a reload pick the render back up: listActive() rebuilds the
// state a dropped stream would have lost.
const POLL_MS = 2000

function isActive(job: VideoRenderJob): boolean {
  return job.status === 'queued' || job.status === 'processing'
}

interface VideoJobsState {
  /** Active and just-finished jobs, keyed by job id. */
  jobs: Record<string, VideoRenderJob>
  /** Job ids the user has dismissed from the indicator. */
  start: (noteId: string, options: RenderOptions, quality?: 'preview' | 'full') => Promise<VideoRenderJob>
  cancel: (jobId: string) => Promise<void>
  dismiss: (jobId: string) => void
  /** Called on mount: recover anything still rendering after a reload. */
  resume: () => Promise<void>
}

let pollTimer: ReturnType<typeof setTimeout> | null = null
let baseTitle = ''

/** Show render progress in the browser tab.
 *
 * EditorView owns document.title for the note name, so the store takes the whole
 * string over while a render is running and restores it when there's nothing
 * left to report — one writer at a time, either way. */
function syncDocumentTitle(jobs: Record<string, VideoRenderJob>): void {
  const active = Object.values(jobs).filter(isActive)
  if (active.length === 0) {
    if (baseTitle) {
      document.title = baseTitle
      baseTitle = ''
    }
    return
  }
  if (!baseTitle) baseTitle = document.title
  const worst = active.reduce((a, b) => (a.progress <= b.progress ? a : b))
  const suffix = active.length > 1 ? ` (${active.length})` : ''
  document.title = `▶ ${worst.progress}%${suffix} · ${baseTitle}`
}

export const useVideoJobsStore = create<VideoJobsState>((set, get) => {
  function schedulePoll() {
    if (pollTimer) return
    pollTimer = setTimeout(async function tick() {
      pollTimer = null
      const active = Object.values(get().jobs).filter(isActive)
      if (active.length === 0) return

      const results = await Promise.all(
        active.map((job) =>
          videoGenApi
            .getJob(job.id)
            .then((r) => r.data)
            // A transient failure shouldn't drop the job from the UI; keep the
            // last known state and try again on the next tick.
            .catch(() => job),
        ),
      )

      set((state) => {
        const jobs = { ...state.jobs }
        for (const job of results) jobs[job.id] = job
        syncDocumentTitle(jobs)
        return { jobs }
      })
      schedulePoll()
    }, POLL_MS)
  }

  return {
    jobs: {},

    async start(noteId, options, quality = 'full') {
      const { data } = await videoGenApi.createJob(noteId, options, quality)
      set((state) => {
        const jobs = { ...state.jobs, [data.id]: data }
        syncDocumentTitle(jobs)
        return { jobs }
      })
      schedulePoll()
      return data
    },

    async cancel(jobId) {
      try {
        const { data } = await videoGenApi.cancelJob(jobId)
        set((state) => {
          const jobs = { ...state.jobs, [data.id]: data }
          syncDocumentTitle(jobs)
          return { jobs }
        })
      } catch {
        // Already finished or gone — drop it either way.
        get().dismiss(jobId)
      }
    },

    dismiss(jobId) {
      set((state) => {
        const jobs = { ...state.jobs }
        delete jobs[jobId]
        syncDocumentTitle(jobs)
        return { jobs }
      })
    },

    async resume() {
      try {
        const { data } = await videoGenApi.listActive()
        if (data.length === 0) return
        set((state) => {
          const jobs = { ...state.jobs }
          for (const job of data) jobs[job.id] = job
          syncDocumentTitle(jobs)
          return { jobs }
        })
        schedulePoll()
      } catch {
        // Not signed in yet, or offline — the next start() will pick things up.
      }
    },
  }
})
