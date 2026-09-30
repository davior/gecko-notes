/**
 * The "Clear" button in the Background tasks dropdown.
 *
 * What it must keep matters as much as what it removes: a running job is still doing
 * work, and a plan awaiting approval is waiting on the user. Neither is "completed", so
 * neither may disappear from under them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store reaches settings.ts, which reads localStorage while the module loads, and
// running jobs write document.title (see syncDocumentTitle). Vitest runs in node here,
// so both globals must exist before the imports below evaluate — hence vi.hoisted.
vi.hoisted(() => {
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  Object.assign(globalThis, { localStorage: storage, document: { title: 'Gecko Notes' } })
})

import type { ActivityJob, ActivityStatus } from '@/api/activity'
import { jobKey, useActivityStore } from './activity'

function job(id: string, status: ActivityStatus): ActivityJob {
  return {
    id,
    kind: 'video',
    status,
    stage: '',
    progress: 0,
    detail: '',
    title: id,
    note_id: null,
    note_title: '',
    locks_note: false,
    result_url: null,
    error_message: null,
    meta: {},
  }
}

describe('clearSettled', () => {
  beforeEach(() => {
    useActivityStore.getState().reset()
  })

  it('removes done, failed and cancelled jobs but keeps running, queued and awaiting-approval ones', () => {
    const all = [
      job('done', 'done'),
      job('error', 'error'),
      job('cancelled', 'cancelled'),
      job('processing', 'processing'),
      job('queued', 'queued'),
      job('plan', 'awaiting_approval'),
    ]
    useActivityStore.setState({ jobs: Object.fromEntries(all.map((j) => [jobKey(j), j])) })

    useActivityStore.getState().clearSettled()

    const left = Object.values(useActivityStore.getState().jobs).map((j) => j.id).sort()
    expect(left).toEqual(['plan', 'processing', 'queued'])
  })

  it('leaves an empty list empty', () => {
    useActivityStore.getState().clearSettled()
    expect(useActivityStore.getState().jobs).toEqual({})
  })
})
