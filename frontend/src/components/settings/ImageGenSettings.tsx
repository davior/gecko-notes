import { useEffect, useState } from 'react'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { settingsApi, type ImageSettings, type ImageUsage, type FalPrice } from '@/api/settings'
import { estimateImageCost, formatCost } from '@/api/imageGen'

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
  const [prices, setPrices] = useState<Record<string, FalPrice>>({})
  const [newModel, setNewModel] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      setSettings(await settingsApi.getImageSettings())
    } catch {
      setError('Failed to load image generation settings')
    }
  }

  async function loadBilling() {
    try {
      const [u, p] = await Promise.all([settingsApi.getImageUsage(30), settingsApi.getImagePricing()])
      setUsage(u)
      setPrices(u.prices && Object.keys(u.prices).length ? u.prices : p.prices)
    } catch {
      setUsage({ available: false, note: 'Usage is unavailable.' })
    }
  }

  useEffect(() => {
    void load()
    void loadBilling()
  }, [])

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
    const default_model = settings.default_model === id
      ? settings.curated_models[0]?.id ?? ''
      : settings.default_model
    void patch({ custom_models: custom, default_model })
  }

  const allModels = settings
    ? [...settings.curated_models, ...settings.custom_models.map((id) => ({ id, label: id }))]
    : []

  // Per-image estimate for the current default model + size.
  const estPrice = settings ? prices[settings.default_model] : undefined
  const estCost = settings ? estimateImageCost(estPrice, settings.image_size) : null

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Image Generation</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
          Generate images with fal.ai. Pick a default model below, then ask the AI assistant to
          “create an image for this article” (or use the “Generate image” block in the editor).
          Generated images are saved to your notes’ media.
        </p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Your fal.ai API key is managed on the{' '}
          <span className="font-medium">Providers</span> tab, under{' '}
          <span className="font-medium">Media Provider</span> — the same key also powers Speech.
          {settings && !settings.has_api_key && (
            <span className="text-amber-600 dark:text-amber-400"> No key is configured yet.</span>
          )}
        </p>

        {error && <p className="text-sm text-red-500 mb-4">{error}</p>}
      </div>

      {settings && (
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Models &amp; defaults</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Choose the model and image size used when a model isn’t specified.
            {estCost !== null && (
              <> Estimated cost for the default model at this size: <span className="font-medium text-gray-700 dark:text-gray-200">~{formatCost(estCost, estPrice?.currency)}</span> per image.</>
            )}
          </p>
          <div className="card p-4 space-y-4">
            <div>
              <label className="label">Default model</label>
              <select className="input" value={settings.default_model} onChange={(e) => void patch({ default_model: e.target.value })}>
                {allModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Default image size</label>
              <select className="input" value={settings.image_size} onChange={(e) => void patch({ image_size: e.target.value })}>
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
                      <button className="text-gray-400 hover:text-red-600 dark:hover:text-red-400" onClick={() => removeCustomModel(id)} title="Remove">
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
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">fal.ai account billing</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Pulled from your fal.ai account (needs the admin key). Per-image counts and cost are also
          tracked locally under the Usage tab.
        </p>
        <div className="card p-4">
          {usage === null ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : usage.available ? (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-6">
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">Total spend (30 days)</div>
                  <div className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                    {formatCost(usage.total_spend ?? 0, usage.currency)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">Remaining credit</div>
                  <div className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                    {usage.balance !== undefined ? formatCost(usage.balance, usage.balance_currency) : '—'}
                  </div>
                </div>
              </div>
              {usage.by_endpoint && usage.by_endpoint.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                        <th className="py-1 pr-4 font-medium">Model</th>
                        <th className="py-1 pr-4 font-medium text-right">Qty</th>
                        <th className="py-1 pr-4 font-medium text-right">Unit price</th>
                        <th className="py-1 font-medium text-right">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.by_endpoint.map((e) => (
                        <tr key={e.endpoint_id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                          <td className="py-1 pr-4 text-gray-700 dark:text-gray-300">{e.endpoint_id}</td>
                          <td className="py-1 pr-4 text-right text-gray-500 dark:text-gray-400">{e.quantity ?? '—'} {e.unit ?? ''}</td>
                          <td className="py-1 pr-4 text-right text-gray-500 dark:text-gray-400">{e.unit_price != null ? formatCost(e.unit_price, e.currency) : '—'}</td>
                          <td className="py-1 text-right text-gray-700 dark:text-gray-300">{e.cost != null ? formatCost(e.cost, e.currency) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {usage.balance === undefined && (
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  No prepaid balance reported (pay-as-you-go accounts are billed to a card).
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {usage.note ?? 'Account billing is unavailable.'}
              {!settings?.has_admin_key && ' Add an admin key on the Providers tab (Media Provider) to see account spend and credit.'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
