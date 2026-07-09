import { useState } from 'react'
import { Volume2, Square, Plus, Trash2, X } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import { useTextToSpeech } from '@/hooks/useTextToSpeech'

function AddCustomModelModal({ onAdd, onClose }: { onAdd: (id: string, voices: string[]) => string | void; onClose: () => void }) {
  const [modelId, setModelId] = useState('')
  const [modelVoices, setModelVoices] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit() {
    const id = modelId.trim()
    const voicesList = modelVoices
      .split(/[,\n]+/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)

    if (!id || voicesList.length === 0) {
      setError('Please provide both a model ID and at least one voice')
      return
    }

    const result = onAdd(id, voicesList)
    if (result) {
      setError(result)
      return
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Add Custom Model</h3>
          <button className="btn-ghost p-1" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Add a fal.ai TTS model ID with its supported voices. Specify voices as a comma-separated list or one per line.
          </p>
          <div>
            <label className="label">Model ID</label>
            <input
              className="input w-full"
              placeholder="e.g., fal-ai/openai/tts-1"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="label">Voices</label>
            <textarea
              className="input w-full"
              placeholder="Voice1, Voice2, Voice3&#10;(comma-separated or one per line)"
              rows={3}
              value={modelVoices}
              onChange={(e) => setModelVoices(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button className="btn-secondary text-sm" onClick={onClose}>Cancel</button>
            <button className="btn-primary text-sm flex items-center gap-1" onClick={submit}>
              <Plus className="w-4 h-4" /> Add Model
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SpeechSettings() {
  const { falKeyConfigured, ttsModel, ttsModels, voice, availableVoices, customTtsModels, sttModel, sttModels, updateAppSettings, updateSpeechConfig } = useSettingsStore()
  const [error, setError] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const tts = useTextToSpeech({ model: voice })

  const allModels = [...ttsModels, ...customTtsModels.map((m) => ({ ...m, label: m.id }))]

  async function updateTtsModel(model: string) {
    setError(null)
    try {
      await updateSpeechConfig({ tts_model: model })
    } catch {
      setError('Failed to save model selection')
    }
  }

  async function updateSttModel(model: string) {
    setError(null)
    try {
      await updateSpeechConfig({ stt_model: model })
    } catch {
      setError('Failed to save STT model selection')
    }
  }

  function addCustomModel(id: string, voicesList: string[]): string | void {
    if (customTtsModels.some((m) => m.id === id) || ttsModels.some((m) => m.id === id)) {
      return 'This model is already in your list'
    }
    setError(null)
    void updateSpeechConfig({
      custom_tts_models: [...customTtsModels, { id, voices: voicesList }],
    })
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
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">TTS Model &amp; Voice</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Choose the TTS model and voice used when reading notes aloud.
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
            <label className="label">Voice</label>
            <select
              className="input"
              value={voice}
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

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label mb-0">Custom models</label>
              <button className="btn-secondary text-sm flex items-center gap-1" onClick={() => setShowAddModal(true)}>
                <Plus className="w-4 h-4" /> Add Custom Model
              </button>
            </div>
            {customTtsModels.length > 0 ? (
              <ul className="space-y-1">
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
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Add fal.ai TTS model IDs with their supported voices.
              </p>
            )}
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Speech-to-Text Model</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Choose the model used for dictation and video transcription.
        </p>
        <div className="card p-4">
          <label className="label">Model</label>
          <select
            className="input"
            value={sttModel}
            onChange={(e) => void updateSttModel(e.target.value)}
          >
            {sttModels.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>
      </div>

      {showAddModal && (
        <AddCustomModelModal onAdd={addCustomModel} onClose={() => setShowAddModal(false)} />
      )}
    </div>
  )
}
