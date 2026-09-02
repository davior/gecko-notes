import client from './client'
import type { ActivityJob } from './activity'
import type { GenerationRequest } from '@/services/ai'
import type { Plan } from '@/services/aiPlan'

/**
 * Running an approved plan on the server.
 *
 * Planning stays here in the browser — it is fast, it streams into the chat, and the
 * review modal is a conversation with the user. Everything after Approve goes to a
 * job, so a plan that takes five minutes to write no longer needs the tab left open
 * on the note.
 */

/** The ids a plan is allowed to touch: `PlanExecContext` without the live editor. */
export interface PlanExecPayload {
  current_note_id: string | null
  default_category_id: string
  current_folder_id: string | null
  valid_note_ids: string[]
  valid_folder_ids: string[]
  valid_category_ids: string[]
  valid_annotation_ids: string[]
  valid_recipe_ids: string[]
}

export interface StartRunPayload {
  plan: Plan
  /** Provider routing plus the request bodies this browser already assembled. */
  prompt_ctx: GenerationRequest | Record<string, never>
  exec_ctx: PlanExecPayload
  note_id: string | null
  session_id: string | null
}

export const assistantApi = {
  start(payload: StartRunPayload) {
    return client.post<{ data: ActivityJob }>('/assistant/runs', payload).then((r) => r.data)
  },
  listActive() {
    return client
      .get<{ data: ActivityJob[] }>('/assistant/runs', { params: { active: 1 } })
      .then((r) => r.data)
  },
  get(runId: string) {
    return client.get<{ data: ActivityJob }>(`/assistant/runs/${runId}`).then((r) => r.data)
  },
  cancel(runId: string) {
    return client.delete<{ data: ActivityJob }>(`/assistant/runs/${runId}`).then((r) => r.data)
  },
}
