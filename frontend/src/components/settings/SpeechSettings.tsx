import { Volume2, Square } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import { TTS_VOICES } from '@/api/settings'
import { useTextToSpeech } from '@/hooks/useTextToSpeech'

export default function SpeechSettings() {
  const { falKeyConfigured, ttsModel, updateAppSettings } = useSettingsStore()
  const tts = useTextToSpeech({ model: ttsModel })

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

      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Voice (Text-to-Speech)</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Choose the voice used when reading notes aloud.
        </p>
        <div className="card p-4 space-y-4">
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
