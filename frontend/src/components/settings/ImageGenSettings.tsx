import { useEffect, useState } from 'react'
import { Eye, EyeOff, Plus, Trash2, Loader2 } from 'lucide-react'
import { settingsApi, type ImageSettings, type ImageUsage } from '@/api/settings'

const IMAGE_SIZE_LABELS: Record<string, string> = {
  square_hd: 'Square (HD)',
  square: 'Square',
  portrait_4_3: 'Portrait 4:3',
  portrait_16_9: 'Portrait 16:9',
  landscape_4_3: 'Landscape 4:3',
  landscape_16_9: 'Landscape 16:9',
}

export default function ImageGenSettings() {
  const [settings, setSettings] = useState<ImageSettings | null>(null)
  const [usage, setUsage] = useState<ImageUsage | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [newModel, setNewModel] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const s = await settingsApi.getImageSettings()
      setSettings(s)
    } catch {
      setError('Failed to load image generation settings')
    }
  }

  async function loadUsage() {
    try {
      setUsage(await settingsApi.getImageUsage())
    } catch {
      setUsage({ available: false, note: 'Usage is unavailable.' })
    }
  }

  useEffect(() => {
    void load()
    void loadUsage()
  }, [])

  async function saveKey(value: string) {
    setSavingKey(true)
    setError(null)
    try {
      const s = await settingsApi.updateImageSettings({ api_key: value })
      setSettings(s)
      setApiKey('')
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      void loadUsage()
    } catch {
      setError('Failed to save API key')
    } finally {
      setSavingKey(false)
    }
  }

  // Persist a config change (model / size / custom list) and reflect the server's echo.
  async function patch(payload: Parameters<typeof settingsApi.updateImageSettings>[0]) {
    setError(null)
    try {
      setSettings(await settingsApi.updateImageSettings(payload))
    } catch {
      setError('Failed to save settings')
    }
  }

  function addCustomModel() {
    const id = newModel.trim()
    if (!id || !settings) return
    if (settings.custom_models.includes(id) || settings.curated_models.some((m) => m.id === id)) {
      setNewModel('')
      return
    }
    void patch({ custom_models: [...settings.custom_models, id] })
    setNewModel('')
  }

  function removeCustomModel(id: string) {
    if (!settings) return
    const custom = settings.custom_models.filter((m) => m !== id)
    // If the removed model was the default, fall back to the first curated model.
    const default_model = settings.default_model === id
      ? settings.curated_models[0]?.id ?? ''
      : settings.default_model
    void patch({ custom_models: custom, default_model })
  }

  const allModels = settings
    ? [...settings.curated_models, ...settings.custom_models.map((id) => ({ id, label: id }))]
    : []

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Image Generation</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Generate images with fal.ai. Set your API key and pick a default model, then ask the AI
          assistant to “create an image for this article” (or use the “Generate image” block in the
          editor). Generated images are saved to your notes’ media.
        </p>

        {error && <p className="text-sm text-red-500 mb-4">{error}</p>}

        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">fal.ai API key</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Stored encrypted on the server and never returned to the browser.{' '}
            <a
              href="https://fal.ai/dashboard/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Get a fal.ai API key
            </a>
          </p>
          <div className="card p-4 space-y-4">
            {settings?.has_api_key && (
              <p className="text-xs text-green-600 dark:text-green-400 font-medium">✓ fal.ai key is configured</p>
            )}
            <div>
              <label className="label">API Key</label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  className="input pr-10"
                  placeholder={settings?.has_api_key ? 'Enter new key to replace existing…' : 'fal key…'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 px-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  onClick={() => setShowKey((v) => !v)}
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                className="btn-primary text-sm"
                disabled={savingKey || !apiKey}
                onClick={() => void saveKey(apiKey)}
              >
                {savingKey ? 'Saving…' : 'Save Key'}
              </button>
              {settings?.has_api_key && (
                <button
                  className="text-sm text-red-500 hover:text-red-700 dark:hover:text-red-400"
                  disabled={savingKey}
                  onClick={() => void saveKey('')}
                >
                  Remove key
                </button>
              )}
              {saved && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
            </div>
          </div>
        </div>
      </div>

      {settings && (
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Models &amp; defaults</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Choose the model and image size used when a model isn’t specified.
          </p>
          <div className="card p-4 space-y-4">
            <div>
              <label className="label">Default model</label>
              <select
                className="input"
                value={settings.default_model}
                onChange={(e) => void patch({ default_model: e.target.value })}
              >
                {allModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Default image size</label>
              <select
                className="input"
                value={settings.image_size}
                onChange={(e) => void patch({ image_size: e.target.value })}
              >
                {settings.image_sizes.map((s) => (
                  <option key={s} value={s}>{IMAGE_SIZE_LABELS[s] ?? s}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Custom models</label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                Add any fal.ai text-to-image model id, e.g. <code>fal-ai/flux-pro/v1.1-ultra</code>.
              </p>
              {settings.custom_models.length > 0 && (
                <ul className="mb-2 space-y-1">
                  {settings.custom_models.map((id) => (
                    <li key={id} className="flex items-center justify-between text-sm bg-gray-50 dark:bg-gray-700/40 rounded px-2 py-1">
                      <code className="text-gray-700 dark:text-gray-200">{id}</code>
                      <button
                        className="text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                        onClick={() => removeCustomModel(id)}
                        title="Remove"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2">
                <input
                  className="input flex-1"
                  placeholder="fal-ai/…"
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomModel() } }}
                />
                <button className="btn-secondary text-sm flex items-center gap-1" onClick={addCustomModel}>
                  <Plus className="w-4 h-4" /> Add
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">fal.ai account usage</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Pulled from your fal.ai account. Per-image counts are also tracked locally under the Usage tab.
        </p>
        <div className="card p-4">
          {usage === null ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : usage.available ? (
            <div className="text-sm text-gray-800 dark:text-gray-200">
              {usage.balance !== undefined ? (
                <>Balance: <span className="font-semibold">{usage.balance.toLocaleString()}{usage.currency ? ` ${usage.currency}` : ''}</span></>
              ) : (
                'Connected to fal.ai account.'
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">{usage.note ?? 'Account usage is unavailable.'}</p>
          )}
        </div>
      </div>
    </div>
  )
}
