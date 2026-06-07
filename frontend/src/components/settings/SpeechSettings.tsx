import { useState } from 'react'
import { Eye, EyeOff, Volume2, Square } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import { TTS_VOICES } from '@/api/settings'
import { useTextToSpeech } from '@/hooks/useTextToSpeech'

export default function SpeechSettings() {
  const { deepgramApiKey, updateSpeechSettings, ttsModel, updateAppSettings } = useSettingsStore()
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const tts = useTextToSpeech({ model: ttsModel })

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

      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Voice (Text-to-Speech)</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Choose the Deepgram voice used when reading notes aloud. A Deepgram key is required.
        </p>
        <div className="card p-4 space-y-4">
          {!deepgramApiKey && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Set a Deepgram key above to enable read-aloud and voice preview.
            </p>
          )}
          <div>
            <label className="label">Voice</label>
            <select
              className="input"
              value={ttsModel}
              onChange={(e) => void updateAppSettings({ tts_model: e.target.value })}
            >
              {TTS_VOICES.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3">
            <button
              className="btn-primary text-sm flex items-center gap-1.5"
              disabled={!deepgramApiKey}
              onClick={() => {
                if (tts.isSpeaking) tts.stop()
                else tts.play('Hello, this is a preview of the selected voice.')
              }}
            >
              {tts.status === 'loading' ? (
                'Loading…'
              ) : tts.isSpeaking ? (
                <><Square className="w-4 h-4" /> Stop</>
              ) : (
                <><Volume2 className="w-4 h-4" /> Preview voice</>
              )}
            </button>
            {tts.status === 'error' && tts.errorMessage && (
              <span className="text-xs text-red-500">{tts.errorMessage}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
