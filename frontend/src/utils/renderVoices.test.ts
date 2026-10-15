/**
 * The video dialog's voice list.
 *
 * It used to list the fal.ai voices whatever engine would read the video, so
 * on an account with a Deepgram key (where "auto" reads with Deepgram) every
 * choice in it was ignored. These pin which engine's voices are offered.
 */

import { describe, expect, it } from 'vitest'

import type { SpeechSettings } from '@/api/settings'
import { renderVoices } from './renderVoices'

function speech(overrides: Partial<SpeechSettings>): SpeechSettings {
  return {
    has_fal_key: true,
    tts_models: [],
    custom_tts_models: [],
    tts_model: 'fal-ai/elevenlabs/tts/eleven-v3',
    voices: ['Aria', 'Rex'],
    default_voice: 'Aria',
    stt_models: [],
    stt_model: '',
    has_deepgram_key: false,
    stt_provider: 'auto',
    deepgram_model: '',
    deepgram_models: [],
    tts_provider: 'auto',
    deepgram_tts_model: 'flux-haley-en',
    deepgram_tts_models: [
      { id: 'flux-haley-en', label: 'Haley — female, US (Flux)' },
      { id: 'flux-kit-en', label: 'Kit — male, British (Flux)' },
    ],
    deepgram_tts_expressivity: 0,
    deepgram_tts_speed: 1,
    voice_mode_enabled: false,
    ...overrides,
  } as SpeechSettings
}

describe('renderVoices', () => {
  it('offers the Deepgram voices when auto will read with Deepgram', () => {
    const { choices, accountVoice } = renderVoices(speech({ has_deepgram_key: true }), 'Rex')
    expect(choices.map((c) => c.id)).toEqual(['flux-haley-en', 'flux-kit-en'])
    expect(accountVoice).toBe('Haley — female, US (Flux)')
  })

  it('offers the Deepgram voices when Deepgram is chosen outright', () => {
    const { choices } = renderVoices(speech({ tts_provider: 'deepgram' }))
    expect(choices[1]).toEqual({ id: 'flux-kit-en', label: 'Kit — male, British (Flux)' })
  })

  it('offers the fal.ai voices without a Deepgram key, or when fal.ai is chosen', () => {
    for (const settings of [speech({}), speech({ tts_provider: 'fal', has_deepgram_key: true })]) {
      const { choices, accountVoice } = renderVoices(settings, 'Rex')
      expect(choices).toEqual([{ id: 'Aria', label: 'Aria' }, { id: 'Rex', label: 'Rex' }])
      expect(accountVoice).toBe('Rex')
    }
  })

  it('names no account voice it cannot vouch for', () => {
    expect(renderVoices(speech({}), 'Someone').accountVoice).toBeNull()
    expect(renderVoices(speech({ has_deepgram_key: true, deepgram_tts_model: 'gone' })).accountVoice).toBeNull()
  })
})
