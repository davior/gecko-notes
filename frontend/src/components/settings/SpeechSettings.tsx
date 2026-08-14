import { useState, useEffect } from 'react'
import { Volume2, Square, Plus, Trash2, X, Eye, EyeOff, Mic } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import { useTextToSpeech } from '@/hooks/useTextToSpeech'
import { configApi } from '@/api/config'
import type { SttProvider, TtsProvider } from '@/api/settings'

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
  const {
    falKeyConfigured, ttsModel, ttsModels, voice, availableVoices, customTtsModels,
    sttModel, sttModels, sttProvider, deepgramModel, deepgramModels, deepgramKeyConfigured,
    ttsProvider, deepgramTtsModel, deepgramTtsModels, voiceModeEnabled,
    updateAppSettings, updateSpeechConfig,
  } = useSettingsStore()
  const [error, setError] = useState<string | null>(null)
  // Whether the instance-wide voice-mode feature flag is on (admin-controlled).
  // The per-user toggle below is only meaningful — and only shown — when it is.
  const [voiceInstanceEnabled, setVoiceInstanceEnabled] = useState(false)
  useEffect(() => {
    configApi.get().then((c) => setVoiceInstanceEnabled(c.voice_mode_enabled)).catch(() => {})
  }, [])
  const [showAddModal, setShowAddModal] = useState(false)
  const [deepgramKeyInput, setDeepgramKeyInput] = useState('')
  const [showDeepgramKey, setShowDeepgramKey] = useState(false)
  const [savingDeepgramKey, setSavingDeepgramKey] = useState(false)
  const [deepgramKeySaved, setDeepgramKeySaved] = useState(false)
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

  async function updateSttProvider(provider: SttProvider) {
    setError(null)
    try {
      await updateSpeechConfig({ stt_provider: provider })
    } catch {
      setError('Failed to save STT provider selection')
    }
  }

  async function updateDeepgramModel(model: string) {
    setError(null)
    try {
      await updateSpeechConfig({ deepgram_model: model })
    } catch {
      setError('Failed to save Deepgram model selection')
    }
  }

  async function updateTtsProvider(provider: TtsProvider) {
    setError(null)
    try {
      await updateSpeechConfig({ tts_provider: provider })
    } catch {
      setError('Failed to save read-aloud provider selection')
    }
  }

  async function updateDeepgramTtsModel(model: string) {
    setError(null)
    try {
      await updateSpeechConfig({ deepgram_tts_model: model })
    } catch {
      setError('Failed to save Deepgram voice selection')
    }
  }

  async function updateVoiceMode(enabled: boolean) {
    setError(null)
    try {
      await updateSpeechConfig({ voice_mode_enabled: enabled })
    } catch {
      setError('Failed to save voice mode preference')
    }
  }

  async function saveDeepgramKey(value: string) {
    setSavingDeepgramKey(true)
    setError(null)
    try {
      await updateSpeechConfig({ deepgram_api_key: value })
      setDeepgramKeyInput('')
      setDeepgramKeySaved(true)
      setTimeout(() => setDeepgramKeySaved(false), 3000)
    } catch {
      setError('Failed to save Deepgram API key')
    } finally {
      setSavingDeepgramKey(false)
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
          Read-aloud can run on Deepgram Aura (streaming) or fal.ai. The fal.ai key is shared with
          image generation — set it on the <span className="font-medium">Providers</span> tab, under{' '}
          <span className="font-medium">Media Provider</span>. Deepgram (used for both realtime dictation
          and Aura read-aloud) uses its own separate API key, set directly below.
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
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Read-aloud (TTS)</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Choose the provider and voice used when reading assistant responses and notes aloud.
          Deepgram Aura streams the audio; fal.ai is kept as a fallback (and provides its own voices).
        </p>
        <div className="card p-4 space-y-4">
          <div>
            <label className="label">Provider</label>
            <select
              className="input"
              value={ttsProvider}
              onChange={(e) => void updateTtsProvider(e.target.value as TtsProvider)}
            >
              <option value="auto">Automatic (Deepgram if configured, else fal.ai)</option>
              <option value="deepgram">Deepgram (Aura streaming)</option>
              <option value="fal">fal.ai</option>
            </select>
          </div>

          {ttsProvider !== 'fal' && (
            <div>
              <label className="label">Deepgram voice</label>
              <select
                className="input"
                value={deepgramTtsModel}
                onChange={(e) => void updateDeepgramTtsModel(e.target.value)}
              >
                {deepgramTtsModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              {!deepgramKeyConfigured && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                  Add a Deepgram API key below to use Deepgram read-aloud; until then fal.ai is used.
                </p>
              )}
            </div>
          )}

          <div>
            <label className="label">fal.ai model</label>
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
            <label className="label">fal.ai voice</label>
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
              disabled={!falKeyConfigured && !deepgramKeyConfigured}
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
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Speech-to-Text</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Choose which engine transcribes dictation in the AI Assistant and Note Editor.
          "Automatic" uses the browser's built-in dictation where available and falls back to
          fal.ai otherwise; Deepgram and fal.ai can also be forced explicitly, even in browsers
          that support built-in dictation.
        </p>
        <div className="card p-4 space-y-4">
          <div>
            <label className="label">Provider</label>
            <select
              className="input"
              value={sttProvider}
              onChange={(e) => void updateSttProvider(e.target.value as SttProvider)}
            >
              <option value="auto">Automatic (browser dictation, fal.ai fallback)</option>
              <option value="deepgram">Deepgram (realtime streaming)</option>
              <option value="fal">fal.ai (batch)</option>
            </select>
          </div>

          {sttProvider === 'deepgram' && (
            <div>
              <label className="label">Deepgram model</label>
              <select
                className="input"
                value={deepgramModel}
                onChange={(e) => void updateDeepgramModel(e.target.value)}
              >
                {deepgramModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="label">fal.ai model</label>
            <select
              className="input"
              value={sttModel}
              onChange={(e) => void updateSttModel(e.target.value)}
            >
              {sttModels.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Used by the Automatic/fal.ai provider above, and by video transcription.
            </p>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Deepgram API Key</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Required to use Deepgram as the speech-to-text provider above. Stored encrypted; never
          returned to the browser.{' '}
          <a href="https://console.deepgram.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
            Get a Deepgram API key
          </a>
        </p>
        <div className="card p-4 space-y-3">
          {deepgramKeyConfigured && (
            <p className="text-xs text-green-600 dark:text-green-400 font-medium">✓ Deepgram key configured</p>
          )}
          <div className="relative">
            <input
              type={showDeepgramKey ? 'text' : 'password'}
              className="input pr-10"
              placeholder={deepgramKeyConfigured ? 'Enter new key to replace existing…' : 'Deepgram key…'}
              value={deepgramKeyInput}
              onChange={(e) => setDeepgramKeyInput(e.target.value)}
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 px-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              onClick={() => setShowDeepgramKey((v) => !v)}
            >
              {showDeepgramKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button
              className="btn-primary text-sm"
              disabled={savingDeepgramKey || !deepgramKeyInput}
              onClick={() => void saveDeepgramKey(deepgramKeyInput)}
            >
              {savingDeepgramKey ? 'Saving…' : 'Save Key'}
            </button>
            {deepgramKeyConfigured && (
              <button
                className="text-sm text-red-500 hover:text-red-700 dark:hover:text-red-400"
                disabled={savingDeepgramKey}
                onClick={() => void saveDeepgramKey('')}
              >
                Remove key
              </button>
            )}
            {deepgramKeySaved && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
          </div>
        </div>
      </div>

      {voiceInstanceEnabled && (
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1 flex items-center gap-2">
            <Mic className="w-4 h-4" /> Voice mode (Deepgram Flux)
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            A hands-free, conversational voice assistant. When on, a voice-mode toggle appears in the
            AI Assistant. Speech is transcribed by Deepgram Flux and spoken back with Deepgram Aura;
            note-changing actions are read back for a spoken confirmation before running. Requires a
            Deepgram API key (above).
          </p>
          <div className="card p-4">
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Enable voice mode</p>
                {!deepgramKeyConfigured && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Add a Deepgram API key above to use voice mode.</p>
                )}
              </div>
              <input
                type="checkbox"
                className="h-5 w-5 accent-indigo-600"
                checked={voiceModeEnabled}
                onChange={(e) => void updateVoiceMode(e.target.checked)}
              />
            </label>
          </div>
        </div>
      )}

      {showAddModal && (
        <AddCustomModelModal onAdd={addCustomModel} onClose={() => setShowAddModal(false)} />
      )}
    </div>
  )
}
