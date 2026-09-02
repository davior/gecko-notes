import { create } from 'zustand'
import { activityApi, isActive, type ActivityJob, type ActivityKind } from '@/api/activity'
import { videoGenApi, type RenderOptions } from '@/api/videoGen'
import { useAuthStore } from '@/stores/auth'

/**
 * Every long-running job the app is working on.
 *
 * A store rather than component state, deliberately — the same reason the render
 * indicator was one: polling has to survive switching views, so work the user
 * walked away from is still visible when they come back.
 *
 * Polled rather than streamed. A dropped SSE stream cannot rebuild this after a
 * page reload; `listActive()` can, which is the case that actually matters here.
 */
const POLL_MS = 2000

interface ActivityState {
  /** Active and recently finished jobs, keyed by `kind:id`. */
  jobs: Record<string, ActivityJob>
  cancel: (job: ActivityJob) => Promise<void>
  dismiss: (key: string) => void
  /** Called on mount: recover anything still running after a reload. */
  resume: () => Promise<void>
  /** Start a video render and begin tracking it. */
  startVideo: (
    noteId: string,
    options: RenderOptions,
    quality?: 'preview' | 'full',
  ) => Promise<void>
  reset: () => void
}

/** Jobs are keyed by kind and id together: ids are only unique within a table. */
export function jobKey(job: Pick<ActivityJob, 'kind' | 'id'>): string {
  return `${job.kind}:${job.id}`
}

let pollTimer: ReturnType<typeof setTimeout> | null = null
let baseTitle = ''

/** Show progress in the browser tab.
 *
 * EditorView owns document.title for the note name, so this takes the whole string
 * over while something is running and restores it when there is nothing left to
 * report — one writer at a time, either way. Anything that wants to report progress
 * in the title belongs here rather than as a third writer. */
function syncDocumentTitle(jobs: Record<string, ActivityJob>): void {
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

export const useActivityStore = create<ActivityState>((set, get) => {
  function apply(incoming: ActivityJob[], addUnknown: boolean) {
    set((state) => {
      const jobs = { ...state.jobs }
      for (const job of incoming) {
        const key = jobKey(job)
        // Only track something new when it is still running: an unfiltered poll
        // also returns yesterday's finished renders, and those should not
        // reappear in the header.
        if (!(key in jobs) && !(addUnknown && isActive(job))) continue
        jobs[key] = job
      }
      syncDocumentTitle(jobs)
      return { jobs }
    })
  }

  function schedulePoll() {
    if (pollTimer) return
    pollTimer = setTimeout(async function tick() {
      pollTimer = null
      if (Object.values(get().jobs).filter(isActive).length === 0) return
      // A 401 from a poll bounces the whole app to /login through the axios
      // interceptor, so never poll while signed out.
      if (!useAuthStore.getState().isAuthenticated) return

      try {
        // Unfiltered rather than active-only: a job that finishes has to be seen
        // reaching "done", not just drop out of the list. `addUnknown` picks up
        // work started in another tab.
        const { data } = await activityApi.listRecent()
        apply(data, true)
      } catch {
        // A transient failure keeps the last known state; try again next tick.
      }
      schedulePoll()
    }, POLL_MS)
  }

  return {
    jobs: {},

    async cancel(job) {
      const key = jobKey(job)
      try {
        const { data } = await activityApi.cancel(job.kind, job.id)
        apply([data], true)
      } catch {
        // Already finished or gone — drop it either way.
        get().dismiss(key)
      }
    },

    dismiss(key) {
      set((state) => {
        const jobs = { ...state.jobs }
        delete jobs[key]
        syncDocumentTitle(jobs)
        return { jobs }
      })
    },

    async resume() {
      if (!useAuthStore.getState().isAuthenticated) return
      try {
        const { data } = await activityApi.listActive()
        if (data.length === 0) return
        apply(data, true)
        schedulePoll()
      } catch {
        // Offline, or the token expired — the next start() picks things up.
      }
    },

    async startVideo(noteId, options, quality = 'full') {
      await videoGenApi.createJob(noteId, options, quality)
      // Read it straight back through the activity view rather than mapping the
      // richer render shape by hand, so there is one place that knows the wire form.
      await get().resume()
      schedulePoll()
    },

    reset() {
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      set({ jobs: {} })
      syncDocumentTitle({})
    },
  }
})

/** Active jobs holding a given note read-only. */
export function jobsLockingNote(
  jobs: Record<string, ActivityJob>,
  noteId: string | null | undefined,
): ActivityJob[] {
  if (!noteId) return []
  return Object.values(jobs).filter(
    (job) => job.locks_note && isActive(job) && job.note_id === noteId,
  )
}

export type { ActivityJob, ActivityKind }
