import { useEffect, useState } from 'react'
import { Eye, EyeOff, Globe } from 'lucide-react'
import { settingsApi, type WebSearchSettings as WebSearch } from '@/api/settings'
import { useSettingsStore } from '@/stores/settings'

// Which backend the AI assistant searches the web with.
//
// Anthropic models search inside the model call using Anthropic's own server-side
// tool and never touch this. No other provider has such a tool — DeepSeek, OpenAI,
// Ollama and custom endpoints would otherwise just tell the user they have no web
// access — so for those the app runs the search itself against the backend chosen
// here and hands the hits back to the model.
//
// One API key is stored, and it belongs to whichever backend is selected: switching
// backends means entering that backend's own key. A wrong key isn't silent — "Test
// search" (and the assistant's next search) reports the rejection.
export default function WebSearchSettings() {
  const setWebSearchConfigured = useSettingsStore((s) => s.setWebSearchConfigured)
  const [settings, setSettings] = useState<WebSearch | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState('')
  const [saved, setSaved] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  function apply(next: WebSearch) {
    setSettings(next)
    setBaseUrl(next.base_url)
    setWebSearchConfigured(next.configured)
  }

  useEffect(() => {
    void (async () => {
      try {
        apply(await settingsApi.getWebSearchSettings())
      } catch {
        setError('Failed to load web search settings')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = settings?.providers.find((p) => p.id === settings.provider) ?? null

  async function save(field: string, payload: Parameters<typeof settingsApi.updateWebSearchSettings>[0]) {
    setSaving(field)
    setError(null)
    setTestResult(null)
    try {
      apply(await settingsApi.updateWebSearchSettings(payload))
      setSaved(field)
      setTimeout(() => setSaved(''), 3000)
      return true
    } catch {
      setError(
        field === 'base_url'
          ? 'Failed to save the instance URL. It must be an https:// address on a public host.'
          : 'Failed to save the web search settings',
      )
      return false
    } finally {
      setSaving('')
    }
  }

  // Test what is currently typed, falling back server-side to what is stored — so this
  // works both before saving a new key and to re-check a saved one.
  async function testSearch() {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await settingsApi.testWebSearch({
        provider: settings?.provider,
        api_key: apiKey || undefined,
        base_url: baseUrl.trim() || undefined,
      }))
    } catch {
      setTestResult({ success: false, message: 'The search test failed' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Globe className="w-5 h-5 text-gray-700 dark:text-gray-300" />
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Web Search</h3>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Lets the assistant look things up online — current events, recent facts, research —
        and cite what it found. Claude models search using Anthropic&rsquo;s own built-in tool;
        every other model (DeepSeek, OpenAI, Ollama, custom endpoints) has no search tool of its
        own, so the app runs the search here and hands the results back to the model.
      </p>

      {error && <p className="text-sm text-red-500 mb-3">{error}</p>}

      <div className="card p-4 space-y-4">
        {settings?.configured && (
          <p className="text-sm text-green-600 dark:text-green-400 font-medium">
            ✓ Web search is available to every model
          </p>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Search backend</label>
          <select
            className="input"
            value={settings?.provider ?? ''}
            disabled={!settings || saving === 'provider'}
            onChange={(e) => void save('provider', { provider: e.target.value })}
          >
            {(settings?.providers ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.needs_api_key ? ' — needs an API key' : p.needs_base_url ? ' — needs an instance URL' : ' — no key needed'}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
            DuckDuckGo works with no account at all, but it throttles automated requests, so a
            busy server can see searches refused. Brave and Tavily are proper search APIs with
            free tiers (Tavily returns a longer extract per hit, which suits research); SearXNG
            queries your own instance.
          </p>
          {saved === 'provider' && <p className="text-xs text-green-600 dark:text-green-400 mt-2">Saved</p>}
        </div>

        {selected?.needs_base_url && (
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Instance URL</label>
            <input
              type="url"
              className="input"
              placeholder="https://searx.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
              Must be an https:// address on a public host, reachable from the server. The
              instance also has to allow the JSON API (<code>json</code> under <code>search.formats</code>).
            </p>
            <div className="flex items-center gap-3 mt-3">
              <button
                className="btn-primary text-sm"
                disabled={saving === 'base_url' || !baseUrl.trim()}
                onClick={() => void save('base_url', { base_url: baseUrl.trim() })}
              >
                {saving === 'base_url' ? 'Saving…' : 'Save URL'}
              </button>
              {saved === 'base_url' && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
            </div>
          </div>
        )}

        {selected?.needs_api_key && (
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              {selected.label} API key
            </label>
            {settings?.has_api_key && (
              <p className="text-xs text-green-600 dark:text-green-400 font-medium mb-2">✓ API key configured</p>
            )}
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                className="input pr-10"
                placeholder={settings?.has_api_key ? 'Enter a new key to replace…' : `Your ${selected.label} key`}
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
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
              Stored encrypted; never returned to the browser. One key is kept, and it belongs to
              the backend selected above — switching backends means entering that one&rsquo;s key.
            </p>
            <div className="flex items-center gap-3 mt-3">
              <button
                className="btn-primary text-sm"
                disabled={saving === 'api_key' || !apiKey}
                onClick={async () => { if (await save('api_key', { api_key: apiKey })) setApiKey('') }}
              >
                {saving === 'api_key' ? 'Saving…' : 'Save key'}
              </button>
              {settings?.has_api_key && (
                <button
                  className="text-sm text-red-500 hover:text-red-700 dark:hover:text-red-400"
                  disabled={saving === 'api_key'}
                  onClick={() => void save('api_key', { api_key: '' })}
                >
                  Remove key
                </button>
              )}
              {saved === 'api_key' && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button className="btn-secondary text-sm" disabled={testing || !settings} onClick={() => void testSearch()}>
            {testing ? 'Searching…' : 'Test search'}
          </button>
          {testResult && (
            <span className={`text-sm ${testResult.success ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {testResult.success ? '✓' : '✗'} {testResult.message}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
