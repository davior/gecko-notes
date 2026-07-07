import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { X, Sparkles, Loader2 } from 'lucide-react'
import { settingsApi, type ImageSettings } from '@/api/settings'
import { imageGenApi } from '@/api/imageGen'

const IMAGE_SIZE_LABELS: Record<string, string> = {
  square_hd: 'Square (HD)',
  square: 'Square',
  portrait_4_3: 'Portrait 4:3',
  portrait_16_9: 'Portrait 16:9',
  landscape_4_3: 'Landscape 4:3',
  landscape_16_9: 'Landscape 16:9',
}

interface Props {
  onInsert: (url: string, caption: string) => void
  onClose: () => void
}

export default function ImageGenModal({ onInsert, onClose }: Props) {
  const [settings, setSettings] = useState<ImageSettings | null>(null)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [size, setSize] = useState('')
  const [generating, setGenerating] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const s = await settingsApi.getImageSettings()
        setSettings(s)
        setModel(s.default_model)
        setSize(s.image_size)
      } catch {
        setError('Failed to load image generation settings')
      }
    })()
  }, [])

  async function generate() {
    if (!prompt.trim()) return
    setGenerating(true)
    setError(null)
    setResultUrl(null)
    try {
      const res = await imageGenApi.generate({ prompt: prompt.trim(), model, image_size: size })
      setResultUrl(res.url)
    } catch (e) {
      const ax = e as { response?: { data?: { detail?: { message?: string } | string } } }
      const detail = ax.response?.data?.detail
      setError(
        detail && typeof detail === 'object' ? detail.message ?? 'Generation failed'
        : typeof detail === 'string' ? detail
        : 'Generation failed',
      )
    } finally {
      setGenerating(false)
    }
  }

  const allModels = settings
    ? [...settings.curated_models, ...settings.custom_models.map((id) => ({ id, label: id }))]
    : []
  const noKey = settings !== null && !settings.has_api_key

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <Sparkles className="w-4 h-4 text-pink-500 shrink-0" />
          <h3 className="flex-1 text-sm font-semibold text-gray-900 dark:text-gray-100">Generate image</h3>
          <button className="btn-ghost p-1" onClick={onClose}><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {noKey ? (
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Set a fal.ai API key in{' '}
              <Link to="/settings/image-gen" className="text-blue-600 hover:underline" onClick={onClose}>
                Settings → Image Generation
              </Link>{' '}
              to generate images.
            </p>
          ) : (
            <>
              <div>
                <label className="label">Prompt</label>
                <textarea
                  className="input min-h-[90px] resize-y"
                  placeholder="Describe the image to generate…"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Model</label>
                  <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
                    {allModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Size</label>
                  <select className="input" value={size} onChange={(e) => setSize(e.target.value)}>
                    {(settings?.image_sizes ?? []).map((s) => (
                      <option key={s} value={s}>{IMAGE_SIZE_LABELS[s] ?? s}</option>
                    ))}
                  </select>
                </div>
              </div>

              {error && <p className="text-sm text-red-500">{error}</p>}

              {resultUrl && (
                <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                  <img src={resultUrl} alt="Generated preview" className="w-full max-h-72 object-contain bg-gray-50 dark:bg-gray-900" />
                </div>
              )}

              <div className="flex items-center gap-2 justify-end">
                <button
                  className="btn-secondary text-sm flex items-center gap-1.5"
                  disabled={generating || !prompt.trim()}
                  onClick={() => void generate()}
                >
                  {generating ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</> : resultUrl ? 'Regenerate' : 'Generate'}
                </button>
                {resultUrl && (
                  <button
                    className="btn-primary text-sm"
                    onClick={() => { onInsert(resultUrl, ''); onClose() }}
                  >
                    Insert
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
