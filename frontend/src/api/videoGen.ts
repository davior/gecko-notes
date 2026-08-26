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
/** "title" shows the note's title; "title_chapter" adds the current chapter
 *  underneath it, in a smaller size, and follows it as the video moves
 *  between chapters; "fixed" is free text typed into `text`. */
export type OverlayTextMode = 'fixed' | 'title' | 'title_chapter'
/** A dip fades through a colour inside each shot, which leaves the stitch a
 *  cheap remux. Everything below `dissolve` blends between shots instead, which
 *  needs the finished video re-encoded once. */
export type TransitionStyle =
  | 'none' | 'fade' | 'fadewhite'
  | 'dissolve' | 'slideleft' | 'slideright' | 'wipeleft' | 'wiperight'
  | 'circleopen' | 'smoothleft'
export type KenBurnsEffect =
  | 'none' | 'zoom_in' | 'zoom_out'
  | 'pan_left' | 'pan_right' | 'pan_up' | 'pan_down' | 'alternate'
export type QuotePosition = 'top' | 'center' | 'bottom'

/** Styles that blend between shots, so the modal can say what they cost. */
export const CROSSFADE_STYLES: readonly TransitionStyle[] = [
  'dissolve', 'slideleft', 'slideright', 'wipeleft', 'wiperight',
  'circleopen', 'smoothleft',
]

export function isCrossfade(style: TransitionStyle): boolean {
  return CROSSFADE_STYLES.includes(style)
}

export interface CardTextSizes {
  title_pct: number
  subtitle_pct: number
}

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
    position: OverlayPosition; opacity: number
    /** Icon height, as a percentage of the frame height. */
    scale_pct: number
    /** Caption size, also as a percentage of the frame height. */
    caption_pct: number
    margin_pct: number
  }
  overlay_text: {
    enabled: boolean; mode: OverlayTextMode; text: string; position: OverlayPosition
    color: string
    /** Font size as a percentage of the frame height. */
    size_pct: number
    margin_pct: number; shadow: boolean
  }
  /** Card type sizes, as percentages of the frame height. Every text size in a
   *  render is frame-relative, so one setting holds at 720p, 1080p and 4K. */
  title_card_text: CardTextSizes
  chapter_card_text: CardTextSizes
  transition: { style: TransitionStyle; duration: number }
  ken_burns: {
    effect: KenBurnsEffect
    /** Fraction of the frame travelled — 0.12 is a 12% push. */
    amount: number
    /** Cards hold still by default; when included they only ever zoom. */
    include_cards: boolean
  }
  music: {
    enabled: boolean; url: string | null
    /** Bed level relative to the narration. */
    volume: number
    /** Duck the bed under speech with a sidechain compressor. */
    duck: boolean
    fade_in: number; fade_out: number
  }
  quotes: {
    enabled: boolean; position: QuotePosition
    /** Quotation size as a percentage of the frame height. */
    size_pct: number
    color: string; accent: string; scrim: number
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
  /** Silence held either side of a heading. 0 runs headings on as prose. */
  heading_pause_ms: number
  /** Silence held after the *last* word of every shot, before the cut to
   *  whatever comes next — without it a shot's audio stops the instant
   *  speech does, often mid-decay on the voice's own trailing intonation. */
  shot_end_pause_ms: number
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
  watermark: { enabled: false, url: null, text: '', position: 'bottom-right', opacity: 0.85, scale_pct: 6, caption_pct: 2.3, margin_pct: 4 },
  overlay_text: { enabled: false, mode: 'title', text: '', position: 'bottom-left', color: '#ffffff', size_pct: 3, margin_pct: 5, shadow: true },
  title_card_text: { title_pct: 6.8, subtitle_pct: 2.9 },
  chapter_card_text: { title_pct: 6.8, subtitle_pct: 2.9 },
  transition: { style: 'none', duration: 0.6 },
  ken_burns: { effect: 'none', amount: 0.12, include_cards: false },
  music: { enabled: false, url: null, volume: 0.18, duck: true, fade_in: 1.5, fade_out: 3.0 },
  quotes: { enabled: false, position: 'center', size_pct: 4.2, color: '#ffffff', accent: '#818cf8', scrim: 0.55 },
  insert_into_note: true,
  title_card: true,
  chapter_screens: false,
  embed_chapters: true,
  thumbnail: true,
  subtitles: 'sidecar',
  voice: null,
  speed: 1.0,
  paragraph_pause_ms: 350,
  heading_pause_ms: 800,
  shot_end_pause_ms: 600,
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
