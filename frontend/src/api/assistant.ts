import client from './client'
import type { ActivityJob } from './activity'
import type { PlanRequest } from '@/services/ai'
import type { Plan } from '@/services/aiPlan'

/**
 * One assistant turn, run on the server.
 *
 * Planning used to happen here in the browser, and only what came after Approve was a
 * job. That was the wrong half: for the requests people care about the model spends
 * longer producing the plan than the run spends executing it, and leaving the note
 * aborted the request. So the turn starts at the question now:
 *
 *     start()    ask for something         -> planning
 *     approve()  yes, do that              -> running
 *     preview()  what it is saying so far
 *     plan()     the plan waiting on a decision
 *
 * What stays here is prompt assembly: this browser builds the request body, cache
 * breakpoints and all, and ships it with the turn. See app/assistant/provider.py.
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

/** The rest of what only a browser knows, and a worker cannot derive. */
export interface TurnContextPayload {
  /** Resolves ids to names in the review modal and in each step's prompt. */
  label_map: Record<string, string>
  /** Folder names, for describing the scope of a `find_notes` the server runs. */
  folder_names: Record<string, string>
  /** Whether to stop and show the plan before running it. */
  plan_mode: boolean
  /** Voice always confirms, whatever plan mode says. */
  voice: boolean
  /** How this provider searches: natively inside the model call, as a plan action, or
   *  not at all. Only 'action' means the server runs the search itself. */
  web_search_mode: 'native' | 'action' | 'none'
  use_summaries: boolean
}

export interface StartTurnPayload {
  /** Provider routing plus the request body this browser assembled. */
  prompt_ctx: PlanRequest
  exec_ctx: PlanExecPayload
  turn_ctx: TurnContextPayload
  note_id: string | null
  session_id: string | null
}

/** The reply as it arrives, while the model is still writing it. */
export interface TurnPreview {
  phase: string
  stage: string
  status: string
  text: string
}

/** A plan waiting for a decision, with what the review modal needs to render it. */
export interface ParkedPlan {
  plan: Plan
  label_map: Record<string, string>
  found_note_ids: string[]
  search_label: string
  session_id: string | null
  note_id: string | null
}

export const assistantApi = {
  start(payload: StartTurnPayload) {
    return client.post<{ data: ActivityJob }>('/assistant/runs', payload).then((r) => r.data)
  },
  /** Run a parked plan. `actionIndices` is the review modal's checkboxes; omitted runs
   *  all of it. A `respond` action is kept either way — the model's reply is not a step
   *  the user is choosing between. */
  approve(runId: string, actionIndices?: number[]) {
    return client
      .post<{ data: ActivityJob }>(`/assistant/runs/${runId}/approve`, {
        action_indices: actionIndices ?? null,
      })
      .then((r) => r.data)
  },
  preview(runId: string) {
    return client
      .get<{ data: TurnPreview }>(`/assistant/runs/${runId}/preview`)
      .then((r) => r.data)
  },
  plan(runId: string) {
    return client.get<{ data: ParkedPlan }>(`/assistant/runs/${runId}/plan`).then((r) => r.data)
  },
  listActive() {
    return client
      .get<{ data: ActivityJob[] }>('/assistant/runs', { params: { active: 1 } })
      .then((r) => r.data)
  },
  /** Plans left waiting for a decision. A reload loses the activity store, and the
   *  activity API rightly does not list something that is holding nothing. */
  listAwaiting() {
    return client
      .get<{ data: ActivityJob[] }>('/assistant/runs', { params: { awaiting: 1 } })
      .then((r) => r.data)
  },
  get(runId: string) {
    return client.get<{ data: ActivityJob }>(`/assistant/runs/${runId}`).then((r) => r.data)
  },
  cancel(runId: string) {
    return client.delete<{ data: ActivityJob }>(`/assistant/runs/${runId}`).then((r) => r.data)
  },
}
