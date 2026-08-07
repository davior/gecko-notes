import { useState } from 'react'
import { Plus, Pencil, Trash2, Eye, EyeOff } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import { settingsApi, type AIProvider } from '@/api/settings'
import MediaProviderSettings from '@/components/settings/MediaProviderSettings'

type ProviderType = 'anthropic' | 'openai' | 'deepseek' | 'ollama' | 'custom'
interface ProviderForm { name: string; provider_type: ProviderType; api_key: string; base_url: string; model: string; max_tokens: number; supports_images: boolean; extra_params: string; enabled: boolean }

// Sensible per-type output-token defaults. Anthropic 4.x models support 64000
// (Opus up to 128000); most OpenAI-compatible models cap output near 16384.
const defaultMaxTokens: Record<ProviderType, number> = { anthropic: 64000, openai: 16384, deepseek: 8192, ollama: 16384, custom: 16384 }

// Whether a type's typical model accepts image attachments, used to pre-tick the
// checkbox when the user picks a type. Anthropic (all current models) and OpenAI
// (gpt-4o etc.) are vision-capable; DeepSeek chat is text-only, and Ollama/custom
// default off since most local/self-hosted models can't take images — the user
// ticks it on for a vision model (llava, a custom multimodal endpoint, …).
const defaultSupportsImages: Record<ProviderType, boolean> = { anthropic: true, openai: true, deepseek: false, ollama: false, custom: false }

const emptyForm = (): ProviderForm => ({ name: '', provider_type: 'anthropic', api_key: '', base_url: '', model: '', max_tokens: defaultMaxTokens.anthropic, supports_images: defaultSupportsImages.anthropic, extra_params: '', enabled: true })

const modelPlaceholders: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514', openai: 'gpt-4o', deepseek: 'deepseek-chat', ollama: 'llama3.2', custom: 'model-name',
}

const typeBadge: Record<string, string> = {
  anthropic: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400',
  openai: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  deepseek: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400',
  ollama: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400',
  custom: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
}

export default function AIProviderManager() {
  const { aiProviders, createAIProvider, updateAIProvider, deleteAIProvider, activateAIProvider } = useSettingsStore()
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ProviderForm>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [toastMsg, setToastMsg] = useState('')
  const [toastError, setToastError] = useState(false)

  function showToast(msg: string, isError: boolean) {
    setToastMsg(msg); setToastError(isError)
    setTimeout(() => setToastMsg(''), 3000)
  }

  function startAddNew() {
    setEditingId(null); setForm(emptyForm()); setTestResult(null); setShowForm(true)
  }

  function startEdit(p: AIProvider) {
    setEditingId(p.id)
    setForm({ name: p.name, provider_type: p.provider_type, api_key: '', base_url: p.base_url ?? '', model: p.model, max_tokens: p.max_tokens ?? defaultMaxTokens[p.provider_type], supports_images: p.supports_images ?? defaultSupportsImages[p.provider_type], extra_params: p.extra_params ? JSON.stringify(p.extra_params, null, 2) : '', enabled: p.enabled })
    setTestResult(null); setShowForm(true)
  }

  function cancelForm() { setShowForm(false); setEditingId(null) }

  async function saveForm() {
    // extra_params is a free-text JSON object merged into each request server-side.
    // Empty → {} (clears any stored params). Reject anything that isn't a JSON object.
    let extra_params: Record<string, unknown> = {}
    const rawExtra = form.extra_params.trim()
    if (rawExtra) {
      try {
        const parsed = JSON.parse(rawExtra)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
        extra_params = parsed as Record<string, unknown>
      } catch {
        showToast('Extra Params must be a valid JSON object', true)
        return
      }
    }
    setSaving(true)
    try {
      const max_tokens = Math.min(200000, Math.max(1, Math.round(form.max_tokens) || defaultMaxTokens[form.provider_type]))
      const payload = { name: form.name, provider_type: form.provider_type, api_key: form.api_key, base_url: form.base_url || null, model: form.model, max_tokens, supports_images: form.supports_images, extra_params, enabled: form.enabled }
      if (editingId) { await updateAIProvider(editingId, payload) } else { await createAIProvider(payload) }
      setShowForm(false); setEditingId(null); showToast('Provider saved', false)
    } catch { showToast('Failed to save provider', true) }
    finally { setSaving(false) }
  }

  async function testConnection() {
    setTesting(true); setTestResult(null)
    try {
      const payload: Parameters<typeof settingsApi.testAIProvider>[0] = {
        provider_type: form.provider_type,
        api_key: form.api_key,
        base_url: form.base_url || null,
        model: form.model,
      }
      if (editingId) payload.provider_id = editingId
      const result = await settingsApi.testAIProvider(payload)
      setTestResult(result)
    } catch { setTestResult({ success: false, message: 'Connection failed' }) }
    finally { setTesting(false) }
  }

  async function activate(id: string) {
    try { await activateAIProvider(id); showToast('Provider activated', false) }
    catch { showToast('Failed to activate provider', true) }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this AI provider?')) return
    try { await deleteAIProvider(id); showToast('Provider deleted', false) }
    catch { showToast('Failed to delete provider', true) }
  }

  const f = form
  const setF = (patch: Partial<ProviderForm>) => setForm((prev) => ({ ...prev, ...patch }))

  return (
    <div className="space-y-10">
      <div>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">AI Providers</h2>
          <button className="btn-primary text-sm" onClick={startAddNew}><Plus className="w-4 h-4" /> Add Provider</button>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          These providers power text-based AI features — chat with the assistant, note summaries,
          tag suggestions, and other language-model tasks. Add one or more, then mark one{' '}
          <span className="font-medium">Active</span> to use it across the app. Anthropic, OpenAI, and
          DeepSeek need an API key; Ollama runs models locally and needs a reachable server URL instead.
        </p>
      </div>

      {showForm && (
        <div className="card p-5 mb-4 border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">{editingId ? 'Edit Provider' : 'New Provider'}</h3>
          <div className="space-y-3">
            <div>
              <label className="label">Display Name</label>
              <input value={f.name} onChange={(e) => setF({ name: e.target.value })} type="text" className="input" placeholder="My Anthropic" />
            </div>
            <div>
              <label className="label">Provider Type</label>
              <select value={f.provider_type} onChange={(e) => { const t = e.target.value as ProviderType; setF({ provider_type: t, max_tokens: defaultMaxTokens[t], supports_images: defaultSupportsImages[t] }) }} className="input">
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
                <option value="ollama">Ollama</option>
                <option value="custom">Custom (OpenAI-compatible)</option>
              </select>
            </div>
            {f.provider_type !== 'ollama' && (
              <div>
                <label className="label">API Key</label>
                <div className="relative">
                  <input value={f.api_key} onChange={(e) => setF({ api_key: e.target.value })} type={showKey ? 'text' : 'password'} className="input pr-10" placeholder={editingId ? 'Leave blank to keep existing key' : 'sk-...'} />
                  <button className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" onClick={() => setShowKey((v) => !v)}>
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-1">Stored encrypted on the server.</p>
              </div>
            )}
            {['ollama', 'custom'].includes(f.provider_type) && (
              <div>
                <label className="label">Base URL</label>
                <input value={f.base_url} onChange={(e) => setF({ base_url: e.target.value })} type="text" className="input" placeholder={f.provider_type === 'ollama' ? 'http://localhost:11434' : 'https://api.example.com'} />
              </div>
            )}
            <div>
              <label className="label">Model</label>
              <input value={f.model} onChange={(e) => setF({ model: e.target.value })} type="text" className="input" placeholder={modelPlaceholders[f.provider_type] ?? 'model-name'} />
            </div>
            <div>
              <label className="label">Max Output Tokens</label>
              <input
                value={f.max_tokens}
                onChange={(e) => setF({ max_tokens: e.target.value === '' ? 0 : parseInt(e.target.value, 10) || 0 })}
                type="number" min={1} max={200000} step={1024} className="input"
                placeholder={String(defaultMaxTokens[f.provider_type])}
              />
              <p className="text-xs text-gray-400 mt-1">Caps the response length, not your note. Keep within the model's ceiling (e.g. 64000 for Claude Sonnet/Haiku, 128000 for Opus) — too high is rejected.</p>
            </div>
            <div>
              <label className="label">Extra Params (JSON)</label>
              <textarea value={f.extra_params} onChange={(e) => setF({ extra_params: e.target.value })} rows={3} className="input font-mono text-xs" placeholder='{"temperature": 0}' />
              <p className="text-xs text-gray-400 mt-1">Optional per-model request parameters merged into each call — e.g. temperature, top_p, or provider-specific options. Leave blank to send none. A model that rejects a parameter (like temperature on the newest Claude models) will error, so omit those for that model.</p>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <input id="images-check" type="checkbox" checked={f.supports_images} onChange={(e) => setF({ supports_images: e.target.checked })} className="rounded" />
                <label htmlFor="images-check" className="text-sm text-gray-700 dark:text-gray-300">Supports image attachments</label>
              </div>
              <p className="text-xs text-gray-400 mt-1">Tick only if this model accepts images. Text-only models (e.g. DeepSeek chat) reject them — leaving this off hides the assistant's image attach option for this provider.</p>
            </div>
            <div className="flex items-center gap-2">
              <input id="enabled-check" type="checkbox" checked={f.enabled} onChange={(e) => setF({ enabled: e.target.checked })} className="rounded" />
              <label htmlFor="enabled-check" className="text-sm text-gray-700 dark:text-gray-300">Enabled</label>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <button className="btn-primary text-sm flex-1" disabled={saving} onClick={saveForm}>{saving ? 'Saving...' : 'Save'}</button>
            <button className="btn-secondary text-sm" disabled={testing} onClick={testConnection}>{testing ? 'Testing...' : 'Test'}</button>
            <button className="btn-secondary text-sm" onClick={cancelForm}>Cancel</button>
          </div>
          {testResult && (
            <div className={`mt-3 text-sm ${testResult.success ? 'text-green-700' : 'text-red-600'}`}>
              {testResult.success ? '✓' : '✗'} {testResult.message}
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        {aiProviders.map((p) => (
          <div key={p.id} className={`card p-4 ${p.is_active ? 'ring-2 ring-blue-500 dark:ring-offset-gray-800 ring-offset-1' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-sm text-gray-900 dark:text-gray-100">{p.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeBadge[p.provider_type] ?? 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}>{p.provider_type}</span>
                  {p.is_active && <span className="text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-2 py-0.5 rounded-full font-medium">✓ Active</span>}
                  {!p.enabled && <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-2 py-0.5 rounded-full">Disabled</span>}
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500">{p.model}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!p.is_active && <button className="text-xs text-blue-600 hover:underline px-2" onClick={() => activate(p.id)}>Set Active</button>}
                <button className="btn-ghost p-1.5" onClick={() => startEdit(p)}><Pencil className="w-4 h-4" /></button>
                <button className="btn-ghost p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50" onClick={() => handleDelete(p.id)}><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          </div>
        ))}
        {aiProviders.length === 0 && !showForm && (
          <div className="text-center text-gray-400 dark:text-gray-500 py-8 text-sm">No AI providers configured. Add one to enable AI features.</div>
        )}
      </div>

      <div className="pt-6 border-t border-gray-200 dark:border-gray-700">
        <MediaProviderSettings />
      </div>

      {toastMsg && (
        <div className={`fixed bottom-4 right-4 px-4 py-3 rounded-xl shadow-lg text-sm z-50 text-white ${toastError ? 'bg-red-600' : 'bg-green-600'}`}>{toastMsg}</div>
      )}
    </div>
  )
}
