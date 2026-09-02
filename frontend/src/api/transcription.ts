import client from './client'

export interface TranscriptionJob {
  id: string
  status: 'queued' | 'processing' | 'done' | 'error' | 'cancelled'
  filename: string | null
  result_url: string | null
  error_message: string | null
}

export const transcriptionApi = {
  /** Queue a transcription of an already-uploaded recording.
   *
   * `noteId` and `afterBlockId` say where the transcript belongs: the server attaches
   * it when it finishes, so a transcription that takes minutes is no longer lost when
   * the tab is closed or the user navigates to another note. Progress shows in the
   * header indicator like every other background job. */
  createJob(filename: string, noteId?: string | null, afterBlockId?: string | null) {
    return client
      .post<{ data: TranscriptionJob }>('/transcription/jobs', {
        filename,
        note_id: noteId ?? null,
        after_block_id: afterBlockId ?? null,
      })
      .then((r) => r.data)
  },

  getJob(jobId: string) {
    return client.get<{ data: TranscriptionJob }>(`/transcription/jobs/${jobId}`).then((r) => r.data)
  },
}
