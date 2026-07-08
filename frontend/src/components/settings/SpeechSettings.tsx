import { useState } from 'react'
import { Volume2, Square, Plus, Trash2 } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import { useTextToSpeech } from '@/hooks/useTextToSpeech'

export default function SpeechSettings() {
  const { falKeyConfigured, ttsModel, ttsModels, availableVoices, customTtsModels, updateAppSettings, updateSpeechConfig } = useSettingsStore()
  const [newModelId, setNewModelId] = useState('')
  const [newModelVoices, setNewModelVoices] = useState('')
  const [error, setError] = useState<string | null>(null)
  const tts = useTextToSpeech({ model: ttsModel })

  const allModels = [...ttsModels, ...customTtsModels.map((m) => ({ ...m, label: m.id }))]

  async function updateTtsModel(model: string) {
    setError(null)
    try {
      await updateSpeechConfig({ tts_model: model })
    } catch {
      setError('Failed to save model selection')
    }
  }

  function addCustomModel() {
    const id = newModelId.trim()
    const voicesList = newModelVoices
      .split(/[,\n]+/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)

    if (!id || voicesList.length === 0) {
      setError('Please provide both a model ID and at least one voice')
      return
    }

    if (customTtsModels.some((m) => m.id === id) || ttsModels.some((m) => m.id === id)) {
      setError('This model is already in your list')
      return
    }

    setError(null)
    void updateSpeechConfig({
      custom_tts_models: [...customTtsModels, { id, voices: voicesList }],
    })
    setNewModelId('')
    setNewModelVoices('')
  }

  function removeCustomModel(id: string) {
    const custom = customTtsModels.filter((m) => m.id !== id)
    const newModel = ttsModel === id ? (ttsModels[0]?.id ?? '') : ttsModel
    void updateSpeechConfig({
      custom_tts_models: custom,
      ...(newModel !== ttsModel && { tts_model: newModel }),
    })
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Speech</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Voice dictation and read-aloud run on fal.ai and share the same API key as image
          generation. Set that key on the <span className="font-medium">Providers</span> tab, under{' '}
          <span className="font-medium">Media Provider</span>; once it's configured, dictation works
          in all browsers and notes can be read aloud.
        </p>
      </div>

      {!falKeyConfigured && (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          No fal.ai key is configured yet. Add one on the <span className="font-medium">Providers</span>{' '}
          tab (Media Provider) to enable read-aloud, voice preview, and dictation.
        </p>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">TTS Model</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Choose the TTS model used when reading notes aloud.
        </p>
        <div className="card p-4 space-y-4">
          <div>
            <label className="label">Model</label>
            <select
              className="input"
              value={ttsModel}
              onChange={(e) => void updateTtsModel(e.target.value)}
            >
              {allModels.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Custom models</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              Add fal.ai TTS model IDs with their supported voices. Specify voices as a comma-separated list or one per line.
            </p>
            {customTtsModels.length > 0 && (
              <ul className="mb-3 space-y-1">
                {customTtsModels.map((model) => (
                  <li key={model.id} className="text-sm bg-gray-50 dark:bg-gray-700/40 rounded p-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <code className="text-gray-700 dark:text-gray-200">{model.id}</code>
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          Voices: {model.voices.join(', ')}
                        </div>
                      </div>
                      <button
                        className="text-gray-400 hover:text-red-600 dark:hover:text-red-400 flex-shrink-0"
                        onClick={() => removeCustomModel(model.id)}
                        title="Remove"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="space-y-2">
              <input
                className="input w-full"
                placeholder="e.g., fal-ai/openai/tts-1"
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
              />
              <textarea
                className="input w-full"
                placeholder="Voices: Voice1, Voice2, Voice3&#10;(comma-separated or one per line)"
                rows={2}
                value={newModelVoices}
                onChange={(e) => setNewModelVoices(e.target.value)}
              />
              <button className="btn-secondary text-sm flex items-center gap-1" onClick={addCustomModel}>
                <Plus className="w-4 h-4" /> Add Custom Model
              </button>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Voice</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Choose the voice for the selected TTS model.
        </p>
        <div className="card p-4 space-y-4">
          <div>
            <label className="label">Voice</label>
            <select
              className="input"
              value={ttsModel}
              onChange={(e) => void updateAppSettings({ tts_model: e.target.value })}
            >
              {availableVoices.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3">
            <button
              className="btn-primary text-sm flex items-center gap-1.5"
              disabled={!falKeyConfigured}
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
