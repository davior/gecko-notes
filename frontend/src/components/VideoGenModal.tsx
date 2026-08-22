import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Clapperboard, Loader2, Upload } from 'lucide-react'
import { mediaApi } from '@/api/media'
import { settingsApi } from '@/api/settings'
import {
  DEFAULT_RENDER_OPTIONS, videoGenApi,
  type AspectRatio, type FitMode, type OverlayPosition, type RenderOptions,
  type SubtitleMode, type VideoEstimate, type VideoResolution, type WaveMode, type WavePosition,
} from '@/api/videoGen'
import { apiErrorMessage } from '@/utils/format'

const OPTIONS_KEY = 'gecko-video-gen-options'

interface Props {
  noteId: string
  noteTitle: string
  /** blockId -> /media URL for rasterised diagram blocks, gathered by the caller. */
  diagramImages: Record<string, string>
  onGenerate: (options: RenderOptions, quality: 'preview' | 'full') => Promise<void>
  onClose: () => void
}

/** Merge a stored blob over the defaults, field by field.
 *
 * Persisted options outlive the shape that wrote them, so anything missing or
 * of the wrong type falls back to its default rather than reaching the backend
 * and failing validation. */
function loadStoredOptions(): RenderOptions {
  const base: RenderOptions = structuredClone(DEFAULT_RENDER_OPTIONS)
  try {
    const raw = localStorage.getItem(OPTIONS_KEY)
    if (!raw) return base
    const stored = JSON.parse(raw) as Partial<RenderOptions>
    for (const key of Object.keys(base) as (keyof RenderOptions)[]) {
      const value = stored[key]
      if (value === undefined || value === null) continue
      const expected = base[key]
      if (typeof expected !== typeof value) continue
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        Object.assign(base[key] as object, value as object)
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (base as any)[key] = value
      }
    }
  } catch { /* unparseable or private mode — defaults are fine */ }
  // Never carry a previous note's rasterised diagrams over.
  base.diagram_images = {}
  return base
}

/** A size control. Every text size in a render is a percentage of the frame
 *  height, so one setting looks the same at 720p, 1080p and 4K. */
function SizeSlider({ label, value, min, max, onChange }: {
  label: string
  value: number
  min: number
  max: number
  onChange: (next: number) => void
}) {
  return (
    <div>
      <label className="label">{label} — {value.toFixed(1)}%</label>
      <input
        type="range" min={min} max={max} step={0.1} className="w-full"
        value={value} onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

const ASPECTS: { id: AspectRatio; label: string; hint: string }[] = [
  { id: '16:9', label: '16:9', hint: 'YouTube' },
  { id: '9:16', label: '9:16', hint: 'Shorts / TikTok' },
  { id: '1:1', label: '1:1', hint: 'Instagram' },
]

function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export default function VideoGenModal({ noteId, noteTitle, diagramImages, onGenerate, onClose }: Props) {
  const [options, setOptions] = useState<RenderOptions>(loadStoredOptions)
  const [estimate, setEstimate] = useState<VideoEstimate | null>(null)
  const [voices, setVoices] = useState<string[]>([])
  const [busy, setBusy] = useState<'preview' | 'full' | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const payload = useMemo<RenderOptions>(
    () => ({ ...options, diagram_images: diagramImages }),
    [options, diagramImages],
  )

  // Persist as the user goes, so the next video starts from the last one's setup.
  useEffect(() => {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify({ ...options, diagram_images: {} }))
    } catch { /* private mode */ }
  }, [options])

  useEffect(() => {
    let cancelled = false
    settingsApi.getSpeechSettings()
      .then((s) => { if (!cancelled) setVoices(s.voices || []) })
      .catch(() => { /* the account's default voice is used when this is unavailable */ })
    return () => { cancelled = true }
  }, [])

  // Re-estimate when anything that changes the segmentation changes. Speed and
  // aspect are cheap to re-run and the number the user is watching depends on them.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      videoGenApi.estimate(noteId, payload)
        .then((r) => { if (!cancelled) setEstimate(r.data) })
        .catch(() => { if (!cancelled) setEstimate(null) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [noteId, payload.speed, payload.title_card, payload.chapter_screens, payload.narrate_code, payload.min_shot_seconds])

  function patch(changes: Partial<RenderOptions>) {
    setOptions((prev) => ({ ...prev, ...changes }))
  }
  type GroupKey = 'waveform' | 'watermark' | 'overlay_text' | 'fallback'
    | 'title_card_text' | 'chapter_card_text'
  function patchGroup<K extends GroupKey>(group: K, changes: Partial<RenderOptions[K]>) {
    setOptions((prev) => ({ ...prev, [group]: { ...prev[group], ...changes } }))
  }

  async function uploadWatermark(file: File) {
    setUploading(true)
    setError(null)
    try {
      const res = await mediaApi.upload(file)
      patchGroup('watermark', { url: res.data.url, enabled: true })
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not upload that image'))
    } finally {
      setUploading(false)
    }
  }

  async function run(quality: 'preview' | 'full') {
    if (busy) return
    setBusy(quality)
    setError(null)
    try {
      await onGenerate(payload, quality)
      onClose()
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not start the render'))
      setBusy(null)
    }
  }

  return createPortal(
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-2xl mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <Clapperboard className="w-4 h-4 text-pink-500 shrink-0" />
          <h3 className="flex-1 text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
            Generate video from “{noteTitle}”
          </h3>
          <button className="btn-ghost p-1" onClick={onClose}><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-5 max-h-[68vh] overflow-y-auto">
          {/* ── Format ─────────────────────────────────────────────────── */}
          <section className="space-y-2">
            <label className="label">Aspect ratio</label>
            <div className="grid grid-cols-3 gap-2">
              {ASPECTS.map((a) => (
                <button
                  key={a.id}
                  onClick={() => patch({ aspect: a.id })}
                  className={`px-3 py-2 rounded-lg border text-sm transition-colors ${
                    options.aspect === a.id
                      ? 'border-pink-500 bg-pink-50 dark:bg-pink-950 text-pink-700 dark:text-pink-300'
                      : 'border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  <div className="font-medium">{a.label}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{a.hint}</div>
                </button>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-3 pt-1">
              <div>
                <label className="label">Resolution</label>
                <select className="input" value={options.resolution}
                        onChange={(e) => patch({ resolution: e.target.value as VideoResolution })}>
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                  <option value="4k">4K</option>
                </select>
              </div>
              <div>
                <label className="label">Encoding</label>
                <select className="input" value={options.quality}
                        onChange={(e) => patch({ quality: e.target.value as RenderOptions['quality'] })}>
                  <option value="preview">Fast</option>
                  <option value="standard">Standard</option>
                  <option value="high">High</option>
                </select>
              </div>
              <div>
                <label className="label">Fit media</label>
                <select className="input" value={options.fit}
                        onChange={(e) => patch({ fit: e.target.value as FitMode })}>
                  <option value="blur">Blurred fill</option>
                  <option value="pad">Letterbox</option>
                  <option value="crop">Crop to fill</option>
                </select>
              </div>
            </div>
          </section>

          {/* ── Narration ──────────────────────────────────────────────── */}
          <section className="space-y-2 pt-1 border-t border-gray-100 dark:border-gray-700">
            <label className="label pt-3">Narration</label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Voice</label>
                <select className="input" value={options.voice ?? ''}
                        onChange={(e) => patch({ voice: e.target.value || null })}>
                  <option value="">Account default</option>
                  {voices.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Speed — {options.speed.toFixed(2)}×</label>
                <input type="range" min={0.75} max={1.5} step={0.05} className="w-full"
                       value={options.speed}
                       onChange={(e) => patch({ speed: Number(e.target.value) })} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={options.narrate_code}
                     onChange={(e) => patch({ narrate_code: e.target.checked })} />
              Read code blocks aloud
            </label>
          </section>

          {/* ── Waveform ───────────────────────────────────────────────── */}
          <section className="space-y-2 pt-1 border-t border-gray-100 dark:border-gray-700">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300 pt-3">
              <input type="checkbox" checked={options.waveform.enabled}
                     onChange={(e) => patchGroup('waveform', { enabled: e.target.checked })} />
              Animated waveform
            </label>
            {options.waveform.enabled && (
              <div className="grid grid-cols-4 gap-3 pl-6">
                <div>
                  <label className="label">Style</label>
                  <select className="input" value={options.waveform.mode}
                          onChange={(e) => patchGroup('waveform', { mode: e.target.value as WaveMode })}>
                    <option value="line">Line</option>
                    <option value="cline">Centred line</option>
                    <option value="p2p">Peak to peak</option>
                    <option value="point">Points</option>
                  </select>
                </div>
                <div>
                  <label className="label">Position</label>
                  <select className="input" value={options.waveform.position}
                          onChange={(e) => patchGroup('waveform', { position: e.target.value as WavePosition })}>
                    <option value="top">Top</option>
                    <option value="center">Centre</option>
                    <option value="bottom">Bottom</option>
                  </select>
                </div>
                <div>
                  <label className="label">Colour</label>
                  <input type="color" className="input h-9 p-1" value={options.waveform.color}
                         onChange={(e) => patchGroup('waveform', { color: e.target.value })} />
                </div>
                <div>
                  <label className="label">Height {options.waveform.height_pct}%</label>
                  <input type="range" min={8} max={50} className="w-full" value={options.waveform.height_pct}
                         onChange={(e) => patchGroup('waveform', { height_pct: Number(e.target.value) })} />
                </div>
              </div>
            )}
          </section>

          {/* ── Watermark ──────────────────────────────────────────────── */}
          <section className="space-y-2 pt-1 border-t border-gray-100 dark:border-gray-700">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300 pt-3">
              <input type="checkbox" checked={options.watermark.enabled}
                     onChange={(e) => patchGroup('watermark', { enabled: e.target.checked })} />
              Watermark
            </label>
            {options.watermark.enabled && (
              <div className="space-y-2 pl-6">
                <div className="flex items-center gap-2">
                  <label className="btn-secondary text-xs cursor-pointer inline-flex items-center gap-1">
                    {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                    {options.watermark.url ? 'Replace icon' : 'Upload icon'}
                    <input type="file" accept="image/*" className="hidden" disabled={uploading}
                           onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadWatermark(f) }} />
                  </label>
                  {options.watermark.url && (
                    <>
                      <img src={options.watermark.url} alt="" className="h-8 w-auto rounded" />
                      <button className="btn-ghost text-xs"
                              onClick={() => patchGroup('watermark', { url: null })}>Remove</button>
                    </>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Caption</label>
                    <input className="input" placeholder={`by ${noteTitle}`} value={options.watermark.text}
                           onChange={(e) => patchGroup('watermark', { text: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">Position</label>
                    <select className="input" value={options.watermark.position}
                            onChange={(e) => patchGroup('watermark', { position: e.target.value as OverlayPosition })}>
                      <option value="top-left">Top left</option>
                      <option value="top-right">Top right</option>
                      <option value="center">Centre</option>
                      <option value="bottom-left">Bottom left</option>
                      <option value="bottom-right">Bottom right</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <SizeSlider label="Icon size" min={1} max={20} value={options.watermark.scale_pct}
                              onChange={(v) => patchGroup('watermark', { scale_pct: v })} />
                  <SizeSlider label="Caption size" min={0.5} max={10} value={options.watermark.caption_pct}
                              onChange={(v) => patchGroup('watermark', { caption_pct: v })} />
                </div>
              </div>
            )}
          </section>

          {/* ── Fixed text ─────────────────────────────────────────────── */}
          <section className="space-y-2 pt-1 border-t border-gray-100 dark:border-gray-700">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300 pt-3">
              <input type="checkbox" checked={options.overlay_text.enabled}
                     onChange={(e) => patchGroup('overlay_text', { enabled: e.target.checked })} />
              Fixed text overlay
            </label>
            {options.overlay_text.enabled && (
              <div className="grid grid-cols-4 gap-3 pl-6">
                <div className="col-span-2">
                  <label className="label">Text</label>
                  <input className="input" value={options.overlay_text.text}
                         onChange={(e) => patchGroup('overlay_text', { text: e.target.value })} />
                </div>
                <div>
                  <label className="label">Position</label>
                  <select className="input" value={options.overlay_text.position}
                          onChange={(e) => patchGroup('overlay_text', { position: e.target.value as OverlayPosition })}>
                    <option value="top-left">Top left</option>
                    <option value="top-right">Top right</option>
                    <option value="center">Centre</option>
                    <option value="bottom-left">Bottom left</option>
                    <option value="bottom-right">Bottom right</option>
                  </select>
                </div>
                <div>
                  <label className="label">Colour</label>
                  <input type="color" className="input h-9 p-1" value={options.overlay_text.color}
                         onChange={(e) => patchGroup('overlay_text', { color: e.target.value })} />
                </div>
                <div className="col-span-2">
                  <SizeSlider label="Text size" min={0.5} max={12} value={options.overlay_text.size_pct}
                              onChange={(v) => patchGroup('overlay_text', { size_pct: v })} />
                </div>
              </div>
            )}
          </section>

          {/* ── Structure & fallback ───────────────────────────────────── */}
          <section className="space-y-2 pt-1 border-t border-gray-100 dark:border-gray-700">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-3">
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={options.title_card}
                       onChange={(e) => patch({ title_card: e.target.checked })} />
                Title screen
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={options.chapter_screens}
                       onChange={(e) => patch({ chapter_screens: e.target.checked })} />
                Chapter screens
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={options.embed_chapters}
                       onChange={(e) => patch({ embed_chapters: e.target.checked })} />
                Chapter markers in the MP4
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={options.thumbnail}
                       onChange={(e) => patch({ thumbnail: e.target.checked })} />
                Thumbnail image
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
                     title="The server attaches it when the render finishes, so it arrives even if you close this tab.">
                <input type="checkbox" checked={options.insert_into_note}
                       onChange={(e) => patch({ insert_into_note: e.target.checked })} />
                Add the video to this note
              </label>
            </div>

            {options.title_card && (
              <div className="grid grid-cols-2 gap-3 pl-6">
                <SizeSlider label="Title screen — title" min={1} max={20}
                            value={options.title_card_text.title_pct}
                            onChange={(v) => patchGroup('title_card_text', { title_pct: v })} />
                <SizeSlider label="Title screen — subtitle" min={0.5} max={12}
                            value={options.title_card_text.subtitle_pct}
                            onChange={(v) => patchGroup('title_card_text', { subtitle_pct: v })} />
              </div>
            )}
            {options.chapter_screens && (
              <div className="grid grid-cols-2 gap-3 pl-6">
                <SizeSlider label="Chapter screen — heading" min={1} max={20}
                            value={options.chapter_card_text.title_pct}
                            onChange={(v) => patchGroup('chapter_card_text', { title_pct: v })} />
                <SizeSlider label="Chapter screen — subtitle" min={0.5} max={12}
                            value={options.chapter_card_text.subtitle_pct}
                            onChange={(v) => patchGroup('chapter_card_text', { subtitle_pct: v })} />
              </div>
            )}

            <div className="grid grid-cols-3 gap-3 pt-1">
              <div>
                <label className="label">Subtitles</label>
                <select className="input" value={options.subtitles}
                        onChange={(e) => patch({ subtitles: e.target.value as SubtitleMode })}>
                  <option value="off">Off</option>
                  <option value="sidecar">.srt file</option>
                  <option value="soft">Track in the MP4</option>
                  <option value="burn">Burned into the picture</option>
                </select>
              </div>
              <div>
                <label className="label">Fallback background</label>
                <select className="input" value={options.fallback.type}
                        onChange={(e) => patchGroup('fallback', { type: e.target.value as 'gradient' | 'solid' })}>
                  <option value="gradient">Gradient</option>
                  <option value="solid">Solid colour</option>
                </select>
              </div>
              <div>
                <label className="label">Colours</label>
                <div className="flex gap-1">
                  <input type="color" className="input h-9 p-1 flex-1" value={options.fallback.colors[0]}
                         onChange={(e) => patchGroup('fallback', { colors: [e.target.value, options.fallback.colors[1]] })} />
                  {options.fallback.type === 'gradient' && (
                    <input type="color" className="input h-9 p-1 flex-1" value={options.fallback.colors[1]}
                           onChange={(e) => patchGroup('fallback', { colors: [options.fallback.colors[0], e.target.value] })} />
                  )}
                </div>
              </div>
            </div>
          </section>

          {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-100 dark:border-gray-700">
          <div className="flex-1 text-xs text-gray-500 dark:text-gray-400">
            {estimate ? (
              <>
                {estimate.shots} segment{estimate.shots === 1 ? '' : 's'} ·{' '}
                {estimate.narration_chars.toLocaleString()} characters to narrate · about{' '}
                {formatDuration(estimate.estimated_seconds)}
                {estimate.warnings.length > 0 && (
                  <div className="text-amber-600 dark:text-amber-400">{estimate.warnings[0]}</div>
                )}
              </>
            ) : (
              'Estimating…'
            )}
          </div>
          <button className="btn-secondary text-sm" disabled={!!busy} onClick={() => void run('preview')}
                  title="480p draft. Narration is cached, so a full render afterwards costs no extra speech.">
            {busy === 'preview' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Preview
          </button>
          <button className="btn-primary text-sm" disabled={!!busy} onClick={() => void run('full')}>
            {busy === 'full' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Generate
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
