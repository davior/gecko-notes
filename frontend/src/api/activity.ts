import client from './client'

/**
 * One view over every background job the app runs.
 *
 * Jobs are still *started* through their own endpoints — a render needs the video
 * dialog's options, an assistant run needs its plan — but once running they are all
 * the same thing to the UI: something with a progress bar that can be stopped and
 * that usually belongs to a note. This is the read-and-stop half, so the header can
 * poll once instead of once per kind.
 */

export type ActivityKind = 'video' | 'assistant' | 'transcription' | 'image' | 'import'
export type ActivityStatus =
  | 'queued'
  | 'processing'
  /** An assistant turn that has planned and is waiting for the user to decide.
   *  Deliberately not active: it holds no note and no worker while it waits. */
  | 'awaiting_approval'
  | 'done'
  | 'error'
  | 'cancelled'

export interface ActivityJob {
  id: string
  kind: ActivityKind
  status: ActivityStatus
  /** Coarse phase label, e.g. "Narrating" / "Writing". */
  stage: string
  /** 0–100. */
  progress: number
  /** Free text under the stage, e.g. "segment 7 of 19". */
  detail: string
  /** What the dropdown row reads. */
  title: string
  /** The note this job is working on — the click-through target, if it has one. */
  note_id: string | null
  note_title: string
  /** The note is held read-only while this runs. */
  locks_note: boolean
  result_url: string | null
  error_message: string | null
  created_at?: string
  /** Kind-specific extras. Only the consumer that cares reads these. */
  meta: Record<string, unknown>
}

export function isActive(job: ActivityJob): boolean {
  return job.status === 'queued' || job.status === 'processing'
}

/** Finished for good. `awaiting_approval` is neither this nor active: the turn has
 *  paused mid-way and will carry on if the user approves it. */
export function isSettled(job: ActivityJob): boolean {
  return job.status === 'done' || job.status === 'error' || job.status === 'cancelled'
}

/** A plan waiting for a decision. */
export function isAwaitingApproval(job: ActivityJob): boolean {
  return job.status === 'awaiting_approval'
}

export const activityApi = {
  /** Everything still running — what the header calls on mount to pick work back
   *  up after a reload. */
  listActive() {
    return client
      .get<{ data: ActivityJob[] }>('/activity', { params: { active: 1 } })
      .then((r) => r.data)
  },
  /** Recent jobs whatever their status, so a poll can watch one reach "done"
   *  rather than simply vanishing from the active list. */
  listRecent(limit = 25) {
    return client
      .get<{ data: ActivityJob[] }>('/activity', { params: { limit } })
      .then((r) => r.data)
  },
  get(kind: ActivityKind, id: string) {
    return client.get<{ data: ActivityJob }>(`/activity/${kind}/${id}`).then((r) => r.data)
  },
  cancel(kind: ActivityKind, id: string) {
    return client.delete<{ data: ActivityJob }>(`/activity/${kind}/${id}`).then((r) => r.data)
  },
}
