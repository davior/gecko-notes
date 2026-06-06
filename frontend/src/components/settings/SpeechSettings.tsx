import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'

export default function SpeechSettings() {
  const { deepgramApiKey, updateSpeechSettings } = useSettingsStore()
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await updateSpeechSettings(apiKey)
      setApiKey('')
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Speech</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Configure speech-to-text for voice dictation. When a Deepgram key is set, dictation is available in all browsers using Deepgram's transcription API.
          Without a key, dictation falls back to the browser's built-in speech recognition where available.
        </p>

        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Deepgram</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Provides high-quality transcription in all browsers.{' '}
            <a
              href="https://console.deepgram.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Get a Deepgram API key
            </a>
          </p>
          <div className="card p-4 space-y-4">
            {deepgramApiKey && (
              <p className="text-xs text-green-600 dark:text-green-400 font-medium">
                ✓ Deepgram key is configured
              </p>
            )}
            <div>
              <label className="label">API Key</label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  className="input pr-10"
                  placeholder={deepgramApiKey ? 'Enter new key to replace existing…' : 'dg-…'}
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
                disabled={saving || !apiKey}
                onClick={() => void handleSave()}
              >
                {saving ? 'Saving…' : 'Save Key'}
              </button>
              {deepgramApiKey && (
                <button
                  className="text-sm text-red-500 hover:text-red-700 dark:hover:text-red-400"
                  disabled={saving}
                  onClick={() => void updateSpeechSettings('')}
                >
                  Remove key
                </button>
              )}
              {saved && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
