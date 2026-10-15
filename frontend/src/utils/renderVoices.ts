import type { SpeechSettings } from '@/api/settings'

export interface VoiceChoice {
  id: string
  label: string
}

export interface RenderVoices {
  /** The voices the render can be read in. */
  choices: VoiceChoice[]
  /** The voice "Account default" stands for, when it is known. */
  accountVoice: string | null
}

/**
 * The voices a video can be read in: those of the engine that will read it.
 *
 * Mirrors the render worker: "auto" means Deepgram whenever a Deepgram key is
 * set, and fal.ai otherwise. Listing the fal.ai voices regardless — as the
 * dialog used to — offered a choice Deepgram never reads. `falVoice` is the
 * account's fal.ai voice (the settings store's `voice`), which Deepgram ignores.
 */
export function renderVoices(settings: SpeechSettings, falVoice?: string | null): RenderVoices {
  const deepgram = settings.tts_provider === 'deepgram'
    || (settings.tts_provider === 'auto' && settings.has_deepgram_key)
  if (deepgram) {
    const choices = (settings.deepgram_tts_models || []).map((m) => ({ id: m.id, label: m.label }))
    const account = choices.find((c) => c.id === settings.deepgram_tts_model)
    return { choices, accountVoice: account ? account.label : null }
  }
  const choices = (settings.voices || []).map((v) => ({ id: v, label: v }))
  return { choices, accountVoice: falVoice && settings.voices?.includes(falVoice) ? falVoice : null }
}
