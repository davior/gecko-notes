import client from './client'

export interface TranscriptionJob {
  id: string
  status: 'queued' | 'processing' | 'done' | 'error'
  filename: string | null
  result_url: string | null
  error_message: string | null
}

export const transcriptionApi = {
  // `filename` is the filename returned by mediaApi.upload for the source video
  // (already saved under /media). The backend extracts its audio track and
  // transcribes it via fal.ai (Wizper) in the background.
  createJob(filename: string): Promise<{ data: TranscriptionJob }> {
    return client.post('/transcription/jobs', { filename }).then((r) => r.data)
  },

  getJob(jobId: string): Promise<{ data: TranscriptionJob }> {
    return client.get(`/transcription/jobs/${jobId}`).then((r) => r.data)
  },
}
