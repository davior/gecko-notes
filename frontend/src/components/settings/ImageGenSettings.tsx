import { useEffect, useState } from 'react'
import { Plus, Trash2, Loader2, ExternalLink } from 'lucide-react'
import { settingsApi, type ImageSettings, type ImageUsage, type FalPrice } from '@/api/settings'
import { estimateImageCost, formatCost } from '@/api/imageGen'
import {
  PARAM_EXAMPLES,
  falModelDocsUrl,
  formatModelParams,
  mergeExample,
  overridesSize,
  parseModelParamsText,
} from '@/utils/imageParams'

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
  // Model-parameters editor: which model it edits (null follows the default model), the
  // unsaved textarea draft, and its own error since free text saves on demand, not per change.
  const [paramsModel, setParamsModel] = useState<string | null>(null)
  const [paramsText, setParamsText] = useState('')
  const [paramsError, setParamsError] = useState<string | null>(null)
  const [paramsSaving, setParamsSaving] = useState(false)

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
    // Drop the model's parameters with it so they don't linger if the id is re-added.
    void patch({ custom_models: custom, default_model, model_params: { [id]: null } })
  }

  const allModels = settings
    ? [...settings.curated_models, ...settings.custom_models.map((id) => ({ id, label: id }))]
    : []

  // The model the parameters editor is on: the one picked there, else the default model.
  const editModel = settings
    ? (allModels.some((m) => m.id === paramsModel) ? (paramsModel as string) : settings.default_model)
    : ''
  const savedParamsText = formatModelParams(settings?.model_params[editModel])
  const paramsDirty = paramsText !== savedParamsText
  // An emptied box over saved params is a clear, so say so on the button.
  const clearingParams = !paramsText.trim() && !!savedParamsText

  // Reload the draft when the edited model, or what's saved for it, changes. Keyed on the
  // text rather than the settings object so saving an unrelated setting (e.g. the size)
  // doesn't wipe a half-typed draft.
  useEffect(() => {
    setParamsText(savedParamsText)
    setParamsError(null)
  }, [editModel, savedParamsText])

  async function saveParams() {
    if (!settings) return
    const parsed = parseModelParamsText(paramsText, settings.reserved_param_keys)
    if (!parsed.ok) {
      setParamsError(parsed.error)
      return
    }
    setParamsError(null)
    setParamsSaving(true)
    try {
      setSettings(await settingsApi.updateImageSettings({ model_params: { [editModel]: parsed.value } }))
      // The echo only moves the saved text if the value changed; normalise the draft either way.
      setParamsText(formatModelParams(parsed.value))
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: { message?: string } | string } } }).response?.data?.detail
      setParamsError(
        detail && typeof detail === 'object' && detail.message ? detail.message : 'Failed to save parameters',
      )
    } finally {
      setParamsSaving(false)
    }
  }

  // The default model's parameters can replace the size the dropdown would send.
  const sizeOverridden = settings ? overridesSize(settings.model_params[settings.default_model]) : false

  // Per-image estimate for the current default model + size. The estimate scales by the
  // preset's megapixels, so it means nothing once the parameters set the size themselves.
  const estPrice = settings ? prices[settings.default_model] : undefined
  const estCost = settings && !sizeOverridden ? estimateImageCost(estPrice, settings.image_size) : null

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
              {sizeOverridden && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                  The default model’s parameters set the size themselves, so this is ignored for it.
                </p>
              )}
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

            <div className="space-y-3 pt-4 border-t border-gray-100 dark:border-gray-700">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Advanced</p>
              <div>
                <label className="label">Model parameters (JSON)</label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  Extra settings sent to fal.ai every time this model is used, such as an exact pixel
                  size, a resolution tier or the number of steps. The keys must match what the model
                  itself accepts.
                </p>
                <select
                  className="input mb-2"
                  value={editModel}
                  onChange={(e) => setParamsModel(e.target.value)}
                  aria-label="Model to edit parameters for"
                >
                  {allModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                <div className="flex flex-wrap items-center gap-1.5 mb-2">
                  <span className="text-xs text-gray-500 dark:text-gray-400">Add:</span>
                  {PARAM_EXAMPLES.map((ex) => (
                    <button
                      key={ex.label}
                      type="button"
                      title={`${ex.hint}\n${JSON.stringify(ex.params)}`}
                      className="px-2 py-0.5 text-xs rounded-full border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      onClick={() => { setParamsText(mergeExample(paramsText, ex.params)); setParamsError(null) }}
                    >
                      {ex.label}
                    </button>
                  ))}
                </div>
                <textarea
                  className="input font-mono text-xs"
                  rows={Math.min(12, Math.max(5, paramsText.split('\n').length))}
                  spellCheck={false}
                  value={paramsText}
                  onChange={(e) => { setParamsText(e.target.value); setParamsError(null) }}
                  placeholder={'{\n  "image_size": { "width": 1600, "height": 900 }\n}'}
                />
                {paramsError && <p className="text-sm text-red-500 mt-1">{paramsError}</p>}
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <button
                    className="btn-primary text-sm flex items-center gap-1"
                    disabled={!paramsDirty || paramsSaving}
                    onClick={() => void saveParams()}
                  >
                    {paramsSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                    {paramsSaving ? 'Saving…' : clearingParams ? 'Clear parameters' : 'Save parameters'}
                  </button>
                  {paramsDirty && !paramsSaving && (
                    <button
                      className="btn-secondary text-sm"
                      onClick={() => { setParamsText(savedParamsText); setParamsError(null) }}
                    >
                      Revert
                    </button>
                  )}
                  <a
                    href={falModelDocsUrl(editModel)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
                  >
                    This model’s parameters on fal.ai <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>

              <details className="text-xs text-gray-500 dark:text-gray-400">
                <summary className="cursor-pointer select-none font-medium text-gray-600 dark:text-gray-300">
                  What can I put here?
                </summary>
                <ul className="mt-2 ml-4 list-disc space-y-1.5">
                  <li>
                    Every model has its own input schema. Open its page on fal.ai (the link above) and
                    copy the parameter names from the API tab. The chips are only starting points.
                  </li>
                  <li>
                    <strong>Exact pixels:</strong> models that accept an <code>image_size</code> object
                    take <code>{'{"image_size": {"width": 1600, "height": 900}}'}</code>. Others use
                    a named size, or an <code>aspect_ratio</code> such as <code>"16:9"</code>.
                  </li>
                  <li>
                    Setting <code>image_size</code> or <code>aspect_ratio</code> here <strong>replaces
                    the size dropdown</strong> for this model. Anything else (<code>resolution</code>,
                    <code> seed</code>, <code>output_format</code>…) is sent alongside it.
                  </li>
                  <li>
                    {settings.reserved_param_keys.map((k, i) => (
                      <span key={k}>{i > 0 && ', '}<code>{k}</code></span>
                    ))}{' '}
                    are managed by the app and can’t be set. Each generation makes one image.
                  </li>
                  <li>
                    If fal.ai rejects a key, its message appears when you generate. Clear the box and
                    save to go back to the defaults.
                  </li>
                </ul>
              </details>
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
