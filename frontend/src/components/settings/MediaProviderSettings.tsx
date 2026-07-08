import { useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { settingsApi, type ImageSettings } from '@/api/settings'

// The fal.ai key pair that powers every media-generation feature in the app:
// image generation, text-to-speech read-aloud, and speech-to-text dictation.
// Kept under "Media Provider" (as opposed to the text/chat AI Providers above)
// since one fal.ai account serves all three.
export default function MediaProviderSettings() {
  const [settings, setSettings] = useState<ImageSettings | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [adminKey, setAdminKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [showAdminKey, setShowAdminKey] = useState(false)
  const [savingKey, setSavingKey] = useState(false)
  const [savingAdmin, setSavingAdmin] = useState(false)
  const [saved, setSaved] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      setSettings(await settingsApi.getImageSettings())
    } catch {
      setError('Failed to load media provider settings')
    }
  }

  useEffect(() => { void load() }, [])

  async function saveKey(kind: 'api_key' | 'admin_api_key', value: string) {
    const setSaving = kind === 'api_key' ? setSavingKey : setSavingAdmin
    setSaving(true)
    setError(null)
    try {
      setSettings(await settingsApi.updateImageSettings({ [kind]: value }))
      if (kind === 'api_key') setApiKey('')
      else setAdminKey('')
      setSaved(kind)
      setTimeout(() => setSaved(''), 3000)
    } catch {
      setError('Failed to save API key')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Media Provider</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        fal.ai powers every media-generation feature in the app — image generation, read-aloud
        (text-to-speech), and voice dictation (speech-to-text) — all from a single account. Set
        your key here once to enable all three; manage model and voice defaults in the{' '}
        <span className="font-medium">Images</span> and <span className="font-medium">Speech</span> tabs.
      </p>

      {error && <p className="text-sm text-red-500 mb-4">{error}</p>}

      <div className="space-y-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">fal.ai API key</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Used to generate images and audio. Stored encrypted; never returned to the browser.{' '}
            <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              Get a fal.ai API key
            </a>
          </p>
          <div className="card p-4 space-y-3">
            {settings?.has_api_key && (
              <p className="text-xs text-green-600 dark:text-green-400 font-medium">✓ Generation key configured</p>
            )}
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                className="input pr-10"
                placeholder={settings?.has_api_key ? 'Enter new key to replace existing…' : 'fal key…'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button type="button" className="absolute inset-y-0 right-0 px-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" onClick={() => setShowKey((v) => !v)}>
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <div className="flex items-center gap-3">
              <button className="btn-primary text-sm" disabled={savingKey || !apiKey} onClick={() => void saveKey('api_key', apiKey)}>
                {savingKey ? 'Saving…' : 'Save Key'}
              </button>
              {settings?.has_api_key && (
                <button className="text-sm text-red-500 hover:text-red-700 dark:hover:text-red-400" disabled={savingKey} onClick={() => void saveKey('api_key', '')}>
                  Remove key
                </button>
              )}
              {saved === 'api_key' && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">fal.ai admin key <span className="font-normal text-gray-400">(optional)</span></h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            A billing-scoped admin/platform key enables account spend, remaining credit, and price
            estimates on the Images tab. Separate from the generation key above.
          </p>
          <div className="card p-4 space-y-3">
            {settings?.has_admin_key && (
              <p className="text-xs text-green-600 dark:text-green-400 font-medium">✓ Admin key configured</p>
            )}
            <div className="relative">
              <input
                type={showAdminKey ? 'text' : 'password'}
                className="input pr-10"
                placeholder={settings?.has_admin_key ? 'Enter new admin key to replace…' : 'fal admin key…'}
                value={adminKey}
                onChange={(e) => setAdminKey(e.target.value)}
              />
              <button type="button" className="absolute inset-y-0 right-0 px-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" onClick={() => setShowAdminKey((v) => !v)}>
                {showAdminKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <div className="flex items-center gap-3">
              <button className="btn-primary text-sm" disabled={savingAdmin || !adminKey} onClick={() => void saveKey('admin_api_key', adminKey)}>
                {savingAdmin ? 'Saving…' : 'Save Admin Key'}
              </button>
              {settings?.has_admin_key && (
                <button className="text-sm text-red-500 hover:text-red-700 dark:hover:text-red-400" disabled={savingAdmin} onClick={() => void saveKey('admin_api_key', '')}>
                  Remove key
                </button>
              )}
              {saved === 'admin_api_key' && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
