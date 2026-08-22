import client from './client'

export type VideoJobStatus = 'queued' | 'processing' | 'done' | 'error' | 'cancelled'

export interface VideoRenderJob {
  id: string
  note_id: string
  status: VideoJobStatus
  /** Coarse phase label, e.g. "Narrating" / "Rendering" / "Stitching". */
  stage: string
  /** 0–100. */
  progress: number
  /** Free text under the stage, e.g. "segment 7 of 19". */
  detail: string
  quality: string
  note_title: string
  result_url: string | null
  subtitle_url: string | null
  thumbnail_url: string | null
  duration_seconds: number | null
  size_bytes: number | null
  error_message: string | null
  created_at?: string
  /** The render was asked to append itself to the note when it finished. */
  auto_insert: boolean
  /** The server already appended it, so don't insert a second copy. */
  inserted: boolean
}

export interface VideoEstimate {
  shots: number
  narration_chars: number
  estimated_seconds: number
  warnings: string[]
}

export type AspectRatio = '16:9' | '9:16' | '1:1'
export type VideoResolution = '720p' | '1080p' | '4k'
export type VideoQuality = 'preview' | 'standard' | 'high'
export type FitMode = 'blur' | 'pad' | 'crop'
export type OverlayPosition = 'top-left' | 'top-right' | 'center' | 'bottom-left' | 'bottom-right'
export type WavePosition = 'top' | 'center' | 'bottom'
export type WaveMode = 'line' | 'p2p' | 'cline' | 'point'
export type SubtitleMode = 'off' | 'sidecar' | 'soft' | 'burn'

export interface RenderOptions {
  aspect: AspectRatio
  resolution: VideoResolution
  quality: VideoQuality
  fps: number
  fit: FitMode
  fallback: { type: 'gradient' | 'solid' | 'image'; colors: string[]; angle: number; url: string | null }
  waveform: {
    enabled: boolean; mode: WaveMode; color: string; opacity: number
    position: WavePosition; height_pct: number; scrim: number
  }
  watermark: {
    enabled: boolean; url: string | null; text: string
    position: OverlayPosition; opacity: number; scale_pct: number; margin_pct: number
  }
  overlay_text: {
    enabled: boolean; text: string; position: OverlayPosition
    color: string; size_pct: number; margin_pct: number; shadow: boolean
  }
  insert_into_note: boolean
  title_card: boolean
  chapter_screens: boolean
  embed_chapters: boolean
  thumbnail: boolean
  subtitles: SubtitleMode
  voice: string | null
  speed: number
  paragraph_pause_ms: number
  narrate_code: boolean
  min_shot_seconds: number
  card_seconds: number
  /** blockId -> /media URL for `diagram` blocks the client rasterised. */
  diagram_images: Record<string, string>
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  aspect: '16:9',
  resolution: '1080p',
  quality: 'standard',
  fps: 30,
  fit: 'blur',
  fallback: { type: 'gradient', colors: ['#1e293b', '#0f172a'], angle: 135, url: null },
  waveform: { enabled: false, mode: 'line', color: '#00ff41', opacity: 0.7, position: 'bottom', height_pct: 22, scrim: 0.45 },
  watermark: { enabled: false, url: null, text: '', position: 'bottom-right', opacity: 0.85, scale_pct: 6, margin_pct: 4 },
  overlay_text: { enabled: false, text: '', position: 'bottom-left', color: '#ffffff', size_pct: 3, margin_pct: 5, shadow: true },
  insert_into_note: true,
  title_card: true,
  chapter_screens: false,
  embed_chapters: true,
  thumbnail: true,
  subtitles: 'sidecar',
  voice: null,
  speed: 1.0,
  paragraph_pause_ms: 350,
  narrate_code: false,
  min_shot_seconds: 2.5,
  card_seconds: 3.5,
  diagram_images: {},
}

export const videoGenApi = {
  /** Queue a render. `preview` renders small and fast; because narration is
   *  cached by voice+text, a full render afterwards reuses it at no extra cost. */
  createJob(noteId: string, options: RenderOptions, quality: 'preview' | 'full' = 'full'): Promise<{ data: VideoRenderJob }> {
    return client.post('/video/jobs', { note_id: noteId, options, quality }).then((r) => r.data)
  },

  getJob(jobId: string): Promise<{ data: VideoRenderJob }> {
    return client.get(`/video/jobs/${jobId}`).then((r) => r.data)
  },

  /** Jobs still queued or rendering — used on mount to pick a render back up
   *  after a page reload. */
  listActive(): Promise<{ data: VideoRenderJob[] }> {
    return client.get('/video/jobs', { params: { active: 1 } }).then((r) => r.data)
  },

  cancelJob(jobId: string): Promise<{ data: VideoRenderJob }> {
    return client.delete(`/video/jobs/${jobId}`).then((r) => r.data)
  },

  /** Segment the note without rendering, so the dialog can show how long the
   *  video will be and how much narration it needs before anything is paid for. */
  estimate(noteId: string, options: RenderOptions): Promise<{ data: VideoEstimate }> {
    return client.post('/video/estimate', { note_id: noteId, options }).then((r) => r.data)
  },
}
